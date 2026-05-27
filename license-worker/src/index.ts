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

const app = new Hono<{ Bindings: Env }>();

// ---------- Auth ----------

app.post("/auth/magic-link", async (c) => {
  const { email } = await c.req.json<{ email: string }>();
  if (!email || !isValidEmail(email)) {
    return c.json({ error: "invalid email" }, 400);
  }
  // TODO: generate short-lived one-time token (15min) signed with JWT_SIGNING_KEY
  // TODO: send via Resend with armorclaw://auth?token=...
  // TODO: rate-limit per email and per IP
  return c.json({ ok: true });
});

app.post("/auth/exchange", async (c) => {
  const { token } = await c.req.json<{ token: string }>();
  if (!token) return c.json({ error: "missing token" }, 400);

  // TODO: verify one-time token, extract email
  const email = "TODO";

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
    // No charge yet; cancel immediately, no refund needed.
    await stripe.subscriptions.cancel(sub.id);
  } else {
    // Paid past refund window: cancel at period end so user retains access through current cycle.
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

  // Abuse mitigation: refuse a second auto-refund to the same payment method fingerprint within 12 months.
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

  // Refund latest paid invoice + cancel immediately.
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

// ---------- helpers (stubs) ----------

function stripeClient(env: Env): Stripe {
  return new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: "2025-02-24.acacia" });
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function freshLicense(env: Env, email: string, sub_status: SubStatus) {
  const expires_at = Date.now() + 7 * 24 * 60 * 60 * 1000;
  const jwt = await signLicenseJwt({ email, sub_status, expires_at }, env.JWT_SIGNING_KEY);
  return { jwt, expires_at, sub_status, email };
}

async function getOrCreateSubscription(_stripe: Stripe, _email: string, _env: Env): Promise<SubStatus> {
  // TODO: lookup customer; if missing, create with 30-day trial sub against STRIPE_PRICE_ID; require payment method via Checkout
  return "trialing";
}

async function readSubscriptionStatus(_stripe: Stripe, _email: string): Promise<SubStatus> {
  // TODO
  return "active";
}

async function findCustomerByEmail(_stripe: Stripe, _email: string): Promise<Stripe.Customer | null> {
  // TODO: stripe.customers.search({ query: `email:"${email}"` })
  return null;
}

async function getActiveSubscription(_stripe: Stripe, _customerId: string): Promise<Stripe.Subscription | null> {
  // TODO: stripe.subscriptions.list({ customer, status: 'all', limit: 1 })
  return null;
}

async function firstChargeTimestamp(_stripe: Stripe, _customerId: string): Promise<number | null> {
  // TODO: stripe.charges.list({ customer, limit: 1 }) sorted ascending, return earliest succeeded charge.created * 1000
  return null;
}

async function latestPaidInvoice(_stripe: Stripe, _customerId: string): Promise<Stripe.Invoice | null> {
  // TODO: stripe.invoices.list({ customer, status: 'paid', limit: 1 })
  return null;
}

async function paymentMethodFingerprint(_stripe: Stripe, _customerId: string): Promise<string | null> {
  // TODO: read default payment method, return card.fingerprint (Stripe-stable across customers/cards with same PAN)
  return null;
}

async function signLicenseJwt(
  _claims: { email: string; sub_status: SubStatus; expires_at: number },
  _key: string,
): Promise<string> {
  // TODO: HS256-sign with key
  return "STUB_JWT";
}

async function verifyJwt(_jwt: string, _key: string): Promise<string | null> {
  // TODO: return email if valid, else null
  return null;
}

async function verifyJwtAllowingExpired(_jwt: string, _key: string, _maxDaysExpired: number): Promise<string | null> {
  // TODO: like verifyJwt but accept up to N days of expiry
  return null;
}

