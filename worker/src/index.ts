/**
 * ArmorClaw billing Worker — Stripe webhook + license validation.
 *
 * Three endpoints:
 *
 *   POST /webhook         Stripe-signed webhook. On checkout.session.completed,
 *                         binds the local installId (carried as
 *                         client_reference_id) to the Stripe subscription in
 *                         KV. When no client_reference_id is present (public
 *                         payment-link checkouts), writes an email-keyed
 *                         fallback record so the user can self-activate later.
 *                         Subscription updates and deletions flip the cached
 *                         status.
 *
 *   POST /validate        Called by ArmorClaw on startup with { installId }.
 *                         Returns { active, subscriptionId, customerId } if KV
 *                         says the install has an active subscription AND
 *                         Stripe still agrees.
 *
 *   POST /validate-email  Called by ArmorClaw when the user supplies their
 *                         subscription email manually ("Already subscribed?").
 *                         Same response shape as /validate. Looks up the
 *                         email:<lowercase_email> KV record written by the
 *                         webhook fallback path, then confirms with Stripe.
 *
 * All endpoints fall back to { active: false } on any error — never 500.
 * No npm packages — Stripe signature verification uses Web Crypto natively.
 */

// ── Bindings ──────────────────────────────────────────────────────────────────

export interface Env {
  KV: KVNamespace;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
}

// ── KV record shapes ──────────────────────────────────────────────────────────

export type InstallStatus = "active" | "canceled";

export interface InstallRecord {
  customerId: string;
  subscriptionId: string;
  status: InstallStatus;
  /** ISO 8601 — when this install first activated. */
  activatedAt: string;
  /** ISO 8601 — last status mutation. */
  updatedAt: string;
}

// ── Stripe webhook payload (only the fields we read) ─────────────────────────

interface StripeEventEnvelope {
  id: string;
  type: string;
  data: { object: unknown };
}

interface StripeCheckoutSession {
  id: string;
  client_reference_id: string | null;
  customer: string | null;
  subscription: string | null;
  customer_email?: string | null;
}

interface StripeSubscription {
  id: string;
  customer: string;
  status: string;
}

// ── CORS ──────────────────────────────────────────────────────────────────────

const ALLOWED_ORIGINS = new Set<string>([
  "http://localhost:7390",
  "http://127.0.0.1:7390",
  "https://armorclaw.app",
]);

function corsHeaders(origin: string | null): Record<string, string> {
  const allow = origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://armorclaw.app";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Stripe-Signature",
    Vary: "Origin",
  };
}

function jsonResponse(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(origin),
    },
  });
}

// ── Stripe signature verification ────────────────────────────────────────────

/**
 * Parse the `Stripe-Signature` header into { timestamp, v1[] }. Returns null
 * if the header is malformed or missing required fields.
 */
function parseSignatureHeader(header: string): { timestamp: string; signatures: string[] } | null {
  const parts = header.split(",");
  let timestamp: string | null = null;
  const signatures: string[] = [];
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") {
      timestamp = value;
    } else if (key === "v1") {
      signatures.push(value);
    }
  }
  if (!timestamp || signatures.length === 0) {
    return null;
  }
  return { timestamp, signatures };
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0) {
    return null;
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.substr(i * 2, 2), 16);
    if (Number.isNaN(byte)) {
      return null;
    }
    out[i] = byte;
  }
  return out;
}

/**
 * Verify a Stripe webhook signature. Implements the same algorithm as
 * Stripe's official SDK: HMAC-SHA256 over `<timestamp>.<payload>` with the
 * webhook signing secret, compared in constant time against any v1 signature
 * in the header. Tolerance defaults to 5 minutes (Stripe's default).
 */
export async function verifyStripeSignature(
  payload: string,
  header: string,
  secret: string,
  options: { toleranceSeconds?: number; nowMs?: number } = {},
): Promise<boolean> {
  const parsed = parseSignatureHeader(header);
  if (!parsed) {
    return false;
  }

  const tolerance = options.toleranceSeconds ?? 300;
  const nowSec = Math.floor((options.nowMs ?? Date.now()) / 1000);
  const ts = Number.parseInt(parsed.timestamp, 10);
  if (!Number.isFinite(ts)) {
    return false;
  }
  if (Math.abs(nowSec - ts) > tolerance) {
    return false;
  }

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );

  const signedPayload = enc.encode(`${parsed.timestamp}.${payload}`);

  for (const sig of parsed.signatures) {
    const sigBytes = hexToBytes(sig);
    if (!sigBytes) {
      continue;
    }
    const valid = await crypto.subtle.verify("HMAC", key, sigBytes, signedPayload);
    if (valid) {
      return true;
    }
  }
  return false;
}

// ── Stripe API helper ─────────────────────────────────────────────────────────

interface StripeSubscriptionResponse {
  id?: string;
  status?: string;
  customer?: string;
}

interface StripeCustomerResponse {
  id?: string;
  email?: string | null;
}

/**
 * Hit the Stripe REST API directly (no SDK). Returns the parsed subscription
 * or null on any failure (network error, non-2xx, parse error). Never throws.
 */
export async function fetchStripeSubscription(
  subscriptionId: string,
  secretKey: string,
  fetchFn: typeof fetch = fetch,
): Promise<StripeSubscriptionResponse | null> {
  try {
    const res = await fetchFn(`https://api.stripe.com/v1/subscriptions/${subscriptionId}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${secretKey}`,
      },
    });
    if (!res.ok) {
      return null;
    }
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Fetch a Stripe Customer object. Used by the email-fallback path of
 * checkout.session.completed when the session has no customer_email field —
 * the customer object always carries the billing email. Never throws.
 */
export async function fetchStripeCustomer(
  customerId: string,
  secretKey: string,
  fetchFn: typeof fetch = fetch,
): Promise<StripeCustomerResponse | null> {
  try {
    const res = await fetchFn(`https://api.stripe.com/v1/customers/${customerId}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${secretKey}`,
      },
    });
    if (!res.ok) {
      return null;
    }
    return await res.json();
  } catch {
    return null;
  }
}

const STRIPE_ACTIVE_STATUSES = new Set<string>(["active", "trialing"]);

// ── KV helpers ────────────────────────────────────────────────────────────────

const installKey = (installId: string): string => `install:${installId}`;
const subKey = (subscriptionId: string): string => `sub:${subscriptionId}`;
const emailKey = (email: string): string => `email:${email.trim().toLowerCase()}`;

/**
 * Shape written by the email-fallback path of checkout.session.completed —
 * a checkout that arrived without a client_reference_id (i.e. the public
 * payment link). Distinct from InstallRecord on purpose: there's no installId
 * binding, no activatedAt/updatedAt lifecycle (cancellations don't auto-flip
 * an email-keyed record because we have no reverse `sub:<id>` → email map).
 * `/validate-email` confirms with the Stripe live API at lookup time.
 */
export interface EmailRecord {
  customerId: string;
  subscriptionId: string;
  tier: "active";
}

async function readInstall(kv: KVNamespace, installId: string): Promise<InstallRecord | null> {
  return kv.get<InstallRecord>(installKey(installId), { type: "json" });
}

async function writeInstall(
  kv: KVNamespace,
  installId: string,
  record: InstallRecord,
): Promise<void> {
  await kv.put(installKey(installId), JSON.stringify(record));
}

async function readInstallIdFromSub(
  kv: KVNamespace,
  subscriptionId: string,
): Promise<string | null> {
  return kv.get(subKey(subscriptionId));
}

async function writeSubMapping(
  kv: KVNamespace,
  subscriptionId: string,
  installId: string,
): Promise<void> {
  await kv.put(subKey(subscriptionId), installId);
}

async function readEmailRecord(kv: KVNamespace, email: string): Promise<EmailRecord | null> {
  return kv.get<EmailRecord>(emailKey(email), { type: "json" });
}

async function writeEmailRecord(
  kv: KVNamespace,
  email: string,
  record: EmailRecord,
): Promise<void> {
  await kv.put(emailKey(email), JSON.stringify(record));
}

// ── Webhook event handlers ────────────────────────────────────────────────────

async function handleCheckoutCompleted(
  event: StripeEventEnvelope,
  env: Env,
  nowIso: string,
): Promise<void> {
  const session = event.data.object as StripeCheckoutSession;
  const customerId = typeof session.customer === "string" ? session.customer : "";
  const subscriptionId = typeof session.subscription === "string" ? session.subscription : "";
  if (!customerId || !subscriptionId) {
    return;
  }

  const installId = session.client_reference_id;
  if (installId) {
    const record: InstallRecord = {
      customerId,
      subscriptionId,
      status: "active",
      activatedAt: nowIso,
      updatedAt: nowIso,
    };
    await writeInstall(env.KV, installId, record);
    await writeSubMapping(env.KV, subscriptionId, installId);
    return;
  }

  // Public payment-link checkout (no client_reference_id). The user paid but
  // we have no install binding, so write an email-keyed fallback record. The
  // user activates later from the dashboard's "Already subscribed?" input.
  const email = await resolveCheckoutEmail(session, customerId, env);
  if (!email) {
    return;
  }
  await writeEmailRecord(env.KV, email, {
    customerId,
    subscriptionId,
    tier: "active",
  });
}

/**
 * Pull the customer email from the session (preferred — present on most
 * Checkout sessions) or fall back to a Stripe Customer fetch. Returns null
 * if neither path produces an email.
 */
async function resolveCheckoutEmail(
  session: StripeCheckoutSession,
  customerId: string,
  env: Env,
  fetchFn: typeof fetch = fetch,
): Promise<string | null> {
  if (typeof session.customer_email === "string" && session.customer_email) {
    return session.customer_email;
  }
  const customer = await fetchStripeCustomer(customerId, env.STRIPE_SECRET_KEY, fetchFn);
  if (customer?.email) {
    return customer.email;
  }
  return null;
}

async function handleSubscriptionMutation(
  event: StripeEventEnvelope,
  env: Env,
  nowIso: string,
  forceCanceled: boolean,
): Promise<void> {
  const sub = event.data.object as StripeSubscription;
  if (!sub?.id) {
    return;
  }

  const installId = await readInstallIdFromSub(env.KV, sub.id);
  if (!installId) {
    return;
  }

  const existing = await readInstall(env.KV, installId);
  if (!existing) {
    return;
  }

  let nextStatus: InstallStatus;
  if (forceCanceled) {
    nextStatus = "canceled";
  } else {
    nextStatus = STRIPE_ACTIVE_STATUSES.has(sub.status) ? "active" : "canceled";
  }

  await writeInstall(env.KV, installId, {
    ...existing,
    status: nextStatus,
    updatedAt: nowIso,
  });
}

async function dispatchEvent(event: StripeEventEnvelope, env: Env, nowIso: string): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed":
      await handleCheckoutCompleted(event, env, nowIso);
      return;
    case "customer.subscription.updated":
      await handleSubscriptionMutation(event, env, nowIso, false);
      return;
    case "customer.subscription.deleted":
      await handleSubscriptionMutation(event, env, nowIso, true);
      return;
    default:
      // Unhandled event types are a no-op (still 200-acked by the caller).
      return;
  }
}

// ── /webhook handler ──────────────────────────────────────────────────────────

async function handleWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const origin = request.headers.get("Origin");
  const sigHeader = request.headers.get("Stripe-Signature");
  if (!sigHeader) {
    return jsonResponse({ error: "missing signature" }, 400, origin);
  }

  // Raw body is required for HMAC — text() preserves bytes 1:1.
  const payload = await request.text();

  const ok = await verifyStripeSignature(payload, sigHeader, env.STRIPE_WEBHOOK_SECRET);
  if (!ok) {
    return jsonResponse({ error: "invalid signature" }, 400, origin);
  }

  let event: StripeEventEnvelope;
  try {
    event = JSON.parse(payload) as StripeEventEnvelope;
  } catch {
    return jsonResponse({ error: "invalid payload" }, 400, origin);
  }

  const nowIso = new Date().toISOString();

  // Stripe needs a fast 2xx ack; do the KV writes after responding so a slow
  // KV call can't push us past Stripe's webhook timeout. Errors here are
  // surfaced via Worker logs, not retried (Stripe retries on non-2xx, but at
  // this point we've already acked — the next event will reconcile).
  ctx.waitUntil(dispatchEvent(event, env, nowIso));

  return jsonResponse({ received: true }, 200, origin);
}

// ── /validate handler ─────────────────────────────────────────────────────────

interface ValidateBody {
  installId?: string;
  subscriptionId?: string;
  customerId?: string;
}

interface ValidateResponse {
  active: boolean;
  subscriptionId?: string;
  customerId?: string;
  error?: string;
}

async function validateByInstall(
  installId: string,
  env: Env,
  fetchFn: typeof fetch,
): Promise<ValidateResponse> {
  const record = await readInstall(env.KV, installId);
  if (!record) {
    return { active: false };
  }
  if (record.status !== "active") {
    return {
      active: false,
      subscriptionId: record.subscriptionId,
      customerId: record.customerId,
    };
  }

  // Confirm with Stripe that the subscription is still active.
  const remote = await fetchStripeSubscription(
    record.subscriptionId,
    env.STRIPE_SECRET_KEY,
    fetchFn,
  );
  if (!remote || !remote.status) {
    // Fallback: trust KV cache when Stripe is unreachable would risk granting
    // access to a canceled sub — spec says return active:false on Stripe failure.
    return { active: false, error: "stripe_unreachable" };
  }
  const active = STRIPE_ACTIVE_STATUSES.has(remote.status);
  return {
    active,
    subscriptionId: record.subscriptionId,
    customerId: record.customerId,
  };
}

async function validateBySubscription(
  subscriptionId: string,
  env: Env,
  fetchFn: typeof fetch,
): Promise<ValidateResponse> {
  const remote = await fetchStripeSubscription(subscriptionId, env.STRIPE_SECRET_KEY, fetchFn);
  if (!remote || !remote.status) {
    return { active: false, error: "stripe_unreachable" };
  }
  return { active: STRIPE_ACTIVE_STATUSES.has(remote.status) };
}

async function validateByEmail(
  email: string,
  env: Env,
  fetchFn: typeof fetch,
): Promise<ValidateResponse> {
  const record = await readEmailRecord(env.KV, email);
  if (!record) {
    return { active: false };
  }

  // Confirm with Stripe — the email record has no lifecycle hooks of its own,
  // so a stale "active" entry would otherwise outlive a cancellation.
  const remote = await fetchStripeSubscription(
    record.subscriptionId,
    env.STRIPE_SECRET_KEY,
    fetchFn,
  );
  if (!remote || !remote.status) {
    return { active: false, error: "stripe_unreachable" };
  }
  const active = STRIPE_ACTIVE_STATUSES.has(remote.status);
  return {
    active,
    subscriptionId: record.subscriptionId,
    customerId: record.customerId,
  };
}

async function handleValidate(
  request: Request,
  env: Env,
  fetchFn: typeof fetch = fetch,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  let body: ValidateBody = {};
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ active: false, error: "invalid_json" }, 200, origin);
  }

  try {
    if (body.installId) {
      const result = await validateByInstall(body.installId, env, fetchFn);
      return jsonResponse(result, 200, origin);
    }
    if (body.subscriptionId) {
      const result = await validateBySubscription(body.subscriptionId, env, fetchFn);
      return jsonResponse(result, 200, origin);
    }
    return jsonResponse({ active: false }, 200, origin);
  } catch (err) {
    return jsonResponse(
      { active: false, error: err instanceof Error ? err.message : "unknown" },
      200,
      origin,
    );
  }
}

// ── /validate-email handler ───────────────────────────────────────────────────

interface ValidateEmailBody {
  email?: string;
}

async function handleValidateEmail(
  request: Request,
  env: Env,
  fetchFn: typeof fetch = fetch,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  let body: ValidateEmailBody = {};
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ active: false, error: "invalid_json" }, 200, origin);
  }

  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!email) {
    return jsonResponse({ active: false }, 200, origin);
  }

  try {
    const result = await validateByEmail(email, env, fetchFn);
    return jsonResponse(result, 200, origin);
  } catch (err) {
    return jsonResponse(
      { active: false, error: err instanceof Error ? err.message : "unknown" },
      200,
      origin,
    );
  }
}

// ── Router ────────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (request.method === "POST" && url.pathname === "/webhook") {
      return handleWebhook(request, env, ctx);
    }
    if (request.method === "POST" && url.pathname === "/validate") {
      return handleValidate(request, env);
    }
    if (request.method === "POST" && url.pathname === "/validate-email") {
      return handleValidateEmail(request, env);
    }

    return jsonResponse({ error: "not_found" }, 404, origin);
  },
};

// ── Test helpers (exported for unit tests, never imported by router) ─────────

export const __test = {
  parseSignatureHeader,
  hexToBytes,
  STRIPE_ACTIVE_STATUSES,
  installKey,
  subKey,
  emailKey,
  handleValidate,
  handleValidateEmail,
  handleWebhook,
};
