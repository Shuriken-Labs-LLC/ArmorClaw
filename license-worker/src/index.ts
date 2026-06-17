// ArmorClaw License Validator
//
// Endpoints:
//   POST /auth/magic-link              { email }        -> { ok: true }
//   POST /auth/exchange                { token }        -> { jwt, expires_at, sub_status, email }
//   POST /auth/refresh                 { jwt }          -> { jwt, expires_at, sub_status }
//
//   POST /subscription/status          { jwt }          -> { sub_status, next_invoice_at, first_charge_at, refund_eligible_until }
//   POST /subscription/cancel          { jwt }          -> { ok, sub_status }
//   POST /subscription/cancel-and-refund { jwt }        -> { ok, refunded_amount } | 403 (not eligible)
//
// Source of truth: Stripe. KV used only for refund abuse mitigation (payment method fingerprint).

import { Hono } from "hono";
import Stripe from "stripe";

export interface Env {
  STRIPE_SECRET_KEY: string;
  JWT_SIGNING_KEY: string;
  RESEND_API_KEY: string;
  STRIPE_PRICE_ID: string;
  APP_URL: string;
  DEEP_LINK_SCHEME: string;
  REFUND_FINGERPRINTS: KVNamespace;
}

type SubStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "none";

const REFUND_WINDOW_DAYS = 7;
const REFUND_COOLDOWN_DAYS = 365;
const JWT_EXPIRY_DAYS = 7;
const MAGIC_LINK_EXPIRY_MS = 15 * 60 * 1000;

const app = new Hono<{ Bindings: Env }>();

// ---------- Auth ----------

app.post("/auth/magic-link", async (c) => {
  const { email } = await c.req.json<{ email: string }>();
  if (!email || !isValidEmail(email)) {
    return c.json({ error: "invalid email" }, 400);
  }

  const token = await signMagicToken(email, c.env.JWT_SIGNING_KEY);

  const magicLink = `${c.env.DEEP_LINK_SCHEME}://auth?token=${encodeURIComponent(token)}`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${c.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "ArmorClaw <noreply@armorclaw.app>",
      to: [email],
      subject: "Sign in to ArmorClaw",
      html: `<p>Click the link below to sign in to ArmorClaw:</p>
             <p><a href="${magicLink}">Sign in to ArmorClaw</a></p>
             <p>This link expires in 15 minutes.</p>
             <p>If you didn't request this, you can ignore this email.</p>`,
    }),
  });

  if (!res.ok) {
    return c.json({ error: "failed to send email" }, 500);
  }

  return c.json({ ok: true });
});

app.post("/auth/exchange", async (c) => {
  const { token } = await c.req.json<{ token: string }>();
  if (!token) return c.json({ error: "missing token" }, 400);

  const email = await verifyMagicToken(token, c.env.JWT_SIGNING_KEY);
  if (!email) return c.json({ error: "invalid or expired token" }, 401);

  const stripe = stripeClient(c.env);
  const sub_status = await getOrCreateSubscription(stripe, email, c.env);

  return c.json(await freshLicense(c.env, email, sub_status));
});

app.post("/auth/refresh", async (c) => {
  const { jwt: oldJwt } = await c.req.json<{ jwt: string }>();
  if (!oldJwt) return c.json({ error: "missing jwt" }, 400);

  const email = await verifyJwtAllowingExpired(oldJwt, c.env.JWT_SIGNING_KEY, 30);
  if (!email) return c.json({ error: "invalid jwt" }, 401);

  const stripe = stripeClient(c.env);
  const sub_status = await readSubscriptionStatus(stripe, email);

  return c.json(await freshLicense(c.env, email, sub_status));
});

// ---------- Subscription self-service ----------

app.post("/subscription/status", async (c) => {
  const { jwt: t } = await c.req.json<{ jwt: string }>();
  const email = await verifyJwt(t, c.env.JWT_SIGNING_KEY);
  if (!email) return c.json({ error: "invalid jwt" }, 401);

  const stripe = stripeClient(c.env);
  const customer = await findCustomerByEmail(stripe, email);
  if (!customer) return c.json({ sub_status: "none" });

  const sub = await getActiveSubscription(stripe, customer.id);
  if (!sub) return c.json({ sub_status: "none" });

  const first_charge_at = await firstChargeTimestamp(stripe, customer.id);
  const refund_eligible_until = first_charge_at
    ? first_charge_at + REFUND_WINDOW_DAYS * 24 * 60 * 60 * 1000
    : null;

  return c.json({
    sub_status: sub.status as SubStatus,
    next_invoice_at: sub.current_period_end * 1000,
    first_charge_at,
    refund_eligible_until,
  });
});

app.post("/subscription/cancel", async (c) => {
  const { jwt: t } = await c.req.json<{ jwt: string }>();
  const email = await verifyJwt(t, c.env.JWT_SIGNING_KEY);
  if (!email) return c.json({ error: "invalid jwt" }, 401);

  const stripe = stripeClient(c.env);
  const customer = await findCustomerByEmail(stripe, email);
  if (!customer) return c.json({ error: "no customer" }, 404);

  const sub = await getActiveSubscription(stripe, customer.id);
  if (!sub) return c.json({ error: "no active subscription" }, 404);

  if (sub.status === "trialing") {
    await stripe.subscriptions.cancel(sub.id);
  } else {
    await stripe.subscriptions.update(sub.id, { cancel_at_period_end: true });
  }

  return c.json({ ok: true, sub_status: "canceled" });
});

app.post("/subscription/cancel-and-refund", async (c) => {
  const { jwt: t } = await c.req.json<{ jwt: string }>();
  const email = await verifyJwt(t, c.env.JWT_SIGNING_KEY);
  if (!email) return c.json({ error: "invalid jwt" }, 401);

  const stripe = stripeClient(c.env);
  const customer = await findCustomerByEmail(stripe, email);
  if (!customer) return c.json({ error: "no customer" }, 404);

  const sub = await getActiveSubscription(stripe, customer.id);
  if (!sub || sub.status === "trialing") {
    return c.json({ error: "use /subscription/cancel for trial users" }, 400);
  }

  const first_charge_at = await firstChargeTimestamp(stripe, customer.id);
  if (!first_charge_at) return c.json({ error: "no charge to refund" }, 400);

  const eligible = Date.now() <= first_charge_at + REFUND_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  if (!eligible) {
    return c.json({ error: "outside 7-day refund window" }, 403);
  }

  const fingerprint = await paymentMethodFingerprint(stripe, customer.id);
  if (fingerprint) {
    const prior = await c.env.REFUND_FINGERPRINTS.get(fingerprint);
    if (prior) {
      const priorMs = Number(prior);
      if (Date.now() - priorMs < REFUND_COOLDOWN_DAYS * 24 * 60 * 60 * 1000) {
        return c.json({
          error: "auto-refund unavailable; contact support@armorclaw.app",
        }, 403);
      }
    }
  }

  const invoice = await latestPaidInvoice(stripe, customer.id);
  if (!invoice || !invoice.payment_intent) {
    return c.json({ error: "no refundable charge" }, 400);
  }
  const refund = await stripe.refunds.create({
    payment_intent: typeof invoice.payment_intent === "string"
      ? invoice.payment_intent
      : invoice.payment_intent.id,
    reason: "requested_by_customer",
  });
  await stripe.subscriptions.cancel(sub.id);

  if (fingerprint) {
    await c.env.REFUND_FINGERPRINTS.put(fingerprint, String(Date.now()));
  }

  return c.json({ ok: true, refunded_amount: refund.amount });
});

export default app;

// ---------- Stripe helpers ----------

function stripeClient(env: Env): Stripe {
  return new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: "2025-02-24.acacia" });
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function freshLicense(env: Env, email: string, sub_status: SubStatus) {
  const expires_at = Date.now() + JWT_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
  const jwt = await signLicenseJwt({ email, sub_status, expires_at }, env.JWT_SIGNING_KEY);
  return { jwt, expires_at, sub_status, email };
}

async function getOrCreateSubscription(stripe: Stripe, email: string, env: Env): Promise<SubStatus> {
  const existing = await findCustomerByEmail(stripe, email);
  if (existing) {
    const sub = await getActiveSubscription(stripe, existing.id);
    if (sub) return sub.status as SubStatus;
  }

  const customer = existing ?? await stripe.customers.create({ email });

  const session = await stripe.checkout.sessions.create({
    customer: customer.id,
    mode: "subscription",
    line_items: [{ price: env.STRIPE_PRICE_ID, quantity: 1 }],
    subscription_data: { trial_period_days: 30 },
    payment_method_collection: "always",
    success_url: `${env.DEEP_LINK_SCHEME}://billing/return?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${env.APP_URL}/`,
  });

  if (session.subscription) {
    const sub = await stripe.subscriptions.retrieve(
      typeof session.subscription === "string"
        ? session.subscription
        : session.subscription.id,
    );
    return sub.status as SubStatus;
  }

  return "trialing";
}

async function readSubscriptionStatus(stripe: Stripe, email: string): Promise<SubStatus> {
  const customer = await findCustomerByEmail(stripe, email);
  if (!customer) return "none";
  const sub = await getActiveSubscription(stripe, customer.id);
  if (!sub) return "none";
  return sub.status as SubStatus;
}

async function findCustomerByEmail(stripe: Stripe, email: string): Promise<Stripe.Customer | null> {
  const result = await stripe.customers.search({ query: `email:"${email}"`, limit: 1 });
  const customer = result.data[0];
  if (!customer || customer.deleted) return null;
  return customer;
}

async function getActiveSubscription(stripe: Stripe, customerId: string): Promise<Stripe.Subscription | null> {
  const subs = await stripe.subscriptions.list({ customer: customerId, limit: 1 });
  return subs.data[0] ?? null;
}

async function firstChargeTimestamp(stripe: Stripe, customerId: string): Promise<number | null> {
  const charges = await stripe.charges.list({
    customer: customerId,
    limit: 100,
  });
  const succeeded = charges.data
    .filter((ch) => ch.status === "succeeded")
    .sort((a, b) => a.created - b.created);
  const earliest = succeeded[0];
  return earliest ? earliest.created * 1000 : null;
}

async function latestPaidInvoice(stripe: Stripe, customerId: string): Promise<Stripe.Invoice | null> {
  const invoices = await stripe.invoices.list({
    customer: customerId,
    status: "paid",
    limit: 1,
  });
  return invoices.data[0] ?? null;
}

async function paymentMethodFingerprint(stripe: Stripe, customerId: string): Promise<string | null> {
  const methods = await stripe.paymentMethods.list({
    customer: customerId,
    type: "card",
    limit: 1,
  });
  const card = methods.data[0]?.card;
  return card?.fingerprint ?? null;
}

// ---------- JWT helpers (Web Crypto API for Workers) ----------

async function getSigningKey(secret: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function base64UrlEncode(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function signJwt(payload: Record<string, unknown>, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const header = base64UrlEncode(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = base64UrlEncode(enc.encode(JSON.stringify(payload)));
  const signingInput = `${header}.${body}`;
  const key = await getSigningKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(signingInput));
  return `${signingInput}.${base64UrlEncode(sig)}`;
}

async function verifyAndDecodeJwt(
  token: string,
  secret: string,
  maxExpiredDays = 0,
): Promise<Record<string, unknown> | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts as [string, string, string];

  const enc = new TextEncoder();
  const key = await getSigningKey(secret);
  const sigBytes = base64UrlDecode(sig);
  const valid = await crypto.subtle.verify("HMAC", key, sigBytes, enc.encode(`${header}.${body}`));
  if (!valid) return null;

  const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(body))) as Record<string, unknown>;

  if (typeof payload["exp"] === "number") {
    const gracePeriod = maxExpiredDays * 24 * 60 * 60;
    if (Date.now() / 1000 > payload["exp"] + gracePeriod) return null;
  }

  return payload;
}

async function signMagicToken(email: string, secret: string): Promise<string> {
  return signJwt(
    { email, purpose: "magic-link", exp: Math.floor((Date.now() + MAGIC_LINK_EXPIRY_MS) / 1000) },
    secret,
  );
}

async function verifyMagicToken(token: string, secret: string): Promise<string | null> {
  const payload = await verifyAndDecodeJwt(token, secret);
  if (!payload || payload["purpose"] !== "magic-link") return null;
  return (payload["email"] as string) ?? null;
}

async function signLicenseJwt(
  claims: { email: string; sub_status: SubStatus; expires_at: number },
  secret: string,
): Promise<string> {
  return signJwt(
    {
      email: claims.email,
      sub_status: claims.sub_status,
      exp: Math.floor(claims.expires_at / 1000),
      iat: Math.floor(Date.now() / 1000),
      purpose: "license",
    },
    secret,
  );
}

async function verifyJwt(token: string, secret: string): Promise<string | null> {
  const payload = await verifyAndDecodeJwt(token, secret);
  if (!payload || payload["purpose"] !== "license") return null;
  return (payload["email"] as string) ?? null;
}

async function verifyJwtAllowingExpired(token: string, secret: string, maxDaysExpired: number): Promise<string | null> {
  const payload = await verifyAndDecodeJwt(token, secret, maxDaysExpired);
  if (!payload || payload["purpose"] !== "license") return null;
  return (payload["email"] as string) ?? null;
}
