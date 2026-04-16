/**
 * Unit tests for wrapper/billing/stripe-redirect.ts.
 */

import { describe, expect, it } from "vitest";
import {
  buildCancelUrl,
  buildCheckoutUrl,
  STRIPE_DEFAULTS,
} from "../../../billing/stripe-redirect.ts";

describe("buildCheckoutUrl", () => {
  it("returns the default payment link when no options", () => {
    const url = buildCheckoutUrl();
    expect(url).toBe("https://buy.stripe.com/test_7sYdR3gog8xJ4bu8mx7ok00");
  });

  it("uses the new Stripe test payment link as the default base", () => {
    const url = buildCheckoutUrl({ installId: "abc" });
    expect(url.startsWith("https://buy.stripe.com/test_7sYdR3gog8xJ4bu8mx7ok00?")).toBe(true);
  });

  it("includes prefilled_email when email is provided", () => {
    const url = buildCheckoutUrl({ email: "user@example.com" });
    expect(url).toContain("prefilled_email=user%40example.com");
  });

  it("includes client_reference_id when installId is provided", () => {
    const url = buildCheckoutUrl({ installId: "abc-123" });
    expect(url).toContain("client_reference_id=abc-123");
  });

  it("does not include success_url anywhere (Payment Links ignore it)", () => {
    const url = buildCheckoutUrl({ email: "user@example.com", installId: "abc-123" });
    expect(url).not.toContain("success_url");
  });

  it("omits client_reference_id when installId is absent", () => {
    const url = buildCheckoutUrl({ email: "user@example.com" });
    expect(url).not.toContain("client_reference_id");
  });

  it("omits prefilled_email when email is absent", () => {
    const url = buildCheckoutUrl({ installId: "abc-123" });
    expect(url).not.toContain("prefilled_email");
  });

  it("returns base with no query string when no options yield params", () => {
    const url = buildCheckoutUrl();
    expect(url).not.toContain("?");
  });

  it("uses custom paymentLinkBase", () => {
    const url = buildCheckoutUrl({
      paymentLinkBase: "https://custom.stripe.com/pay",
      installId: "x",
    });
    expect(url.startsWith("https://custom.stripe.com/pay?")).toBe(true);
  });

  it("properly encodes special characters in email", () => {
    const url = buildCheckoutUrl({ email: "a+b@example.com" });
    expect(url).toContain("prefilled_email=a%2Bb%40example.com");
  });

  it("properly encodes special characters in installId", () => {
    const url = buildCheckoutUrl({ installId: "id with spaces" });
    expect(url).toContain("client_reference_id=id+with+spaces");
  });

  it("combines installId and email in a single query string", () => {
    const url = buildCheckoutUrl({
      installId: "abc-123",
      email: "user@example.com",
    });
    expect(url).toContain("client_reference_id=abc-123");
    expect(url).toContain("prefilled_email=user%40example.com");
    expect(url.split("?").length).toBe(2);
  });
});

describe("buildCancelUrl", () => {
  it("defaults to localhost dashboard with #billing hash", () => {
    const url = buildCancelUrl();
    expect(url).toBe("http://127.0.0.1:7390/#billing");
  });

  it("uses custom dashboard URL", () => {
    const url = buildCancelUrl("https://mydevice.ts.net");
    expect(url).toBe("https://mydevice.ts.net/#billing");
  });
});

describe("STRIPE_DEFAULTS", () => {
  it("exposes the new test payment link", () => {
    expect(STRIPE_DEFAULTS.paymentLink).toBe("https://buy.stripe.com/test_7sYdR3gog8xJ4bu8mx7ok00");
  });

  it("exposes armorclaw.app as the success base", () => {
    expect(STRIPE_DEFAULTS.successBase).toBe("https://armorclaw.app");
  });
});
