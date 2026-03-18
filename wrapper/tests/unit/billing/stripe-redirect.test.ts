/**
 * Unit tests for wrapper/billing/stripe-redirect.ts.
 */

import { describe, expect, it } from "vitest";
import { buildCancelUrl, buildCheckoutUrl } from "../../../billing/stripe-redirect.ts";

describe("buildCheckoutUrl", () => {
  it("returns the default payment link when no options", () => {
    const url = buildCheckoutUrl();
    expect(url).toContain("buy.stripe.com/armorclaw_pro");
  });

  it("includes prefilled_email when email is provided", () => {
    const url = buildCheckoutUrl({ email: "user@example.com" });
    expect(url).toContain("prefilled_email=user%40example.com");
  });

  it("includes success_url with license key", () => {
    const url = buildCheckoutUrl({ licenseKey: "abc-123" });
    expect(url).toContain("success_url=");
    expect(url).toContain("key%3Dabc-123");
  });

  it("includes success_url without key when no licenseKey", () => {
    const url = buildCheckoutUrl();
    expect(url).toContain("success_url=");
    expect(url).toContain("subscribe%2Fsuccess");
  });

  it("uses custom paymentLinkBase", () => {
    const url = buildCheckoutUrl({ paymentLinkBase: "https://custom.stripe.com/pay" });
    expect(url.startsWith("https://custom.stripe.com/pay?")).toBe(true);
  });

  it("uses custom successUrlBase", () => {
    const url = buildCheckoutUrl({
      successUrlBase: "https://custom.ai",
      licenseKey: "key123",
    });
    expect(url).toContain("custom.ai");
  });

  it("properly encodes special characters in email", () => {
    const url = buildCheckoutUrl({ email: "a+b@example.com" });
    expect(url).toContain("prefilled_email=a%2Bb%40example.com");
  });

  it("properly encodes special characters in licenseKey", () => {
    const url = buildCheckoutUrl({ licenseKey: "key=val&other" });
    // The key is encodeURIComponent'd inside the success_url, which is then
    // encoded again by URLSearchParams — verify the key value is present
    expect(url).toContain("key%3Dkey");
    expect(url).toContain("other");
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
