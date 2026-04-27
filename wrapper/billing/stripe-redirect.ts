/**
 * Stripe checkout redirect — generates the URL the "Subscribe" button opens.
 *
 * Stripe Payment Links ignore success_url passed as a query string, so we use
 * `client_reference_id=<installId>` instead. Stripe forwards that value through
 * to the `checkout.session.completed` webhook as `session.client_reference_id`,
 * which the billing Worker uses to bind the subscription back to the local
 * install. The customer email is pre-filled when known.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CheckoutUrlOptions {
  /** Stripe-hosted payment link base URL. */
  paymentLinkBase?: string;
  /** Pre-fill the customer email in Stripe checkout. */
  email?: string;
  /** Local install identifier — passed to Stripe as client_reference_id. */
  installId?: string;
}

// ── Default values ────────────────────────────────────────────────────────────

const DEFAULT_PAYMENT_LINK = "https://buy.stripe.com/14A00l5Up1HM6eG9qjfjG01";
/** Used by buildCancelUrl as the fallback dashboard origin (kept for cancel URL). */
const DEFAULT_SUCCESS_BASE = "https://armorclaw.app";

// ── Main function ─────────────────────────────────────────────────────────────

/**
 * Build the full Stripe checkout URL with pre-filled fields.
 *
 * Returns a URL string ready to open in the user's browser.
 */
export function buildCheckoutUrl(options: CheckoutUrlOptions = {}): string {
  const base = options.paymentLinkBase ?? DEFAULT_PAYMENT_LINK;

  const params = new URLSearchParams();

  if (options.installId) {
    params.set("client_reference_id", options.installId);
  }
  if (options.email) {
    params.set("prefilled_email", options.email);
  }

  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

/**
 * The cancel URL — where the user lands if they abandon checkout. Stripe
 * Payment Links don't honour a per-checkout cancel_url either, so this is
 * used by ArmorClaw's own redirect handlers (e.g. the dashboard's billing
 * deep link). Defaults to the local dashboard.
 */
export function buildCancelUrl(dashboardUrl = "http://127.0.0.1:7390"): string {
  return `${dashboardUrl}/#billing`;
}

/** Exposed for tests + downstream consumers. */
export const STRIPE_DEFAULTS = {
  paymentLink: DEFAULT_PAYMENT_LINK,
  successBase: DEFAULT_SUCCESS_BASE,
} as const;
