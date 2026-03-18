/**
 * Stripe checkout redirect — generates the URL the "Subscribe" button opens.
 *
 * Pre-fills the customer email (from config if available) and encodes
 * a success_url that includes the license key for activation on redirect.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CheckoutUrlOptions {
  /** Stripe-hosted payment link base URL. */
  paymentLinkBase?: string;
  /** Pre-fill the customer email in Stripe checkout. */
  email?: string;
  /** License key to embed in the success redirect. */
  licenseKey?: string;
  /** Override the success URL base (default: https://armorclaw.ai). */
  successUrlBase?: string;
}

// ── Default values ────────────────────────────────────────────────────────────

const DEFAULT_PAYMENT_LINK = "https://buy.stripe.com/armorclaw_pro";
const DEFAULT_SUCCESS_BASE = "https://armorclaw.ai";

// ── Main function ─────────────────────────────────────────────────────────────

/**
 * Build the full Stripe checkout URL with pre-filled fields.
 *
 * Returns a URL string ready to open in the user's browser.
 */
export function buildCheckoutUrl(options: CheckoutUrlOptions = {}): string {
  const base = options.paymentLinkBase ?? DEFAULT_PAYMENT_LINK;
  const successBase = options.successUrlBase ?? DEFAULT_SUCCESS_BASE;

  const params = new URLSearchParams();

  if (options.email) {
    params.set("prefilled_email", options.email);
  }

  // success_url includes the license key so the redirect handler can activate
  const successUrl = options.licenseKey
    ? `${successBase}/subscribe/success?key=${encodeURIComponent(options.licenseKey)}`
    : `${successBase}/subscribe/success`;

  params.set("success_url", successUrl);

  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

/**
 * The cancel URL — where Stripe redirects if the user abandons checkout.
 * Points back to the ArmorClaw dashboard.
 */
export function buildCancelUrl(dashboardUrl = "http://127.0.0.1:7390"): string {
  return `${dashboardUrl}/#billing`;
}
