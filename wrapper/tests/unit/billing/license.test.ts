/**
 * Unit tests for wrapper/billing/license.ts.
 *
 * All file I/O uses a temp directory. Time is injected via `now` params.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearLicenseForTesting,
  computeTrialEnd,
  createTrialLicense,
  daysRemaining,
  loadLicense,
  setLicensePathForTesting,
  validateStripeSubscription,
} from "../../../billing/license.ts";
import type { License } from "../../../billing/license.ts";

// ── Test setup ────────────────────────────────────────────────────────────────

const TMP_DIR = join(tmpdir(), "armorclaw-lic-test-" + Date.now());
const TMP_FILE = join(TMP_DIR, "license.json");

beforeEach(() => {
  mkdirSync(TMP_DIR, { recursive: true });
  setLicensePathForTesting(TMP_FILE);
  // Remove file if it exists
  try {
    rmSync(TMP_FILE);
  } catch {
    /* absent */
  }
});

afterEach(() => {
  clearLicenseForTesting();
  try {
    rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function writeLicense(license: License): void {
  writeFileSync(TMP_FILE, JSON.stringify(license, null, 2), "utf-8");
}

function readLicense(): License {
  return JSON.parse(readFileSync(TMP_FILE, "utf-8")) as License;
}

const DAY_MS = 86_400_000;

// ── computeTrialEnd ───────────────────────────────────────────────────────────

describe("computeTrialEnd", () => {
  it("returns a date 30 days after the input", () => {
    const start = "2026-01-01T00:00:00.000Z";
    const end = computeTrialEnd(start);
    expect(end).toBe("2026-01-31T00:00:00.000Z");
  });

  it("handles mid-month dates", () => {
    const start = "2026-03-15T12:00:00.000Z";
    const end = computeTrialEnd(start);
    const expected = new Date(new Date(start).getTime() + 30 * DAY_MS).toISOString();
    expect(end).toBe(expected);
  });
});

// ── daysRemaining ─────────────────────────────────────────────────────────────

describe("daysRemaining", () => {
  it("returns 30 on the first day of a 30-day trial", () => {
    const start = new Date("2026-01-01T00:00:00.000Z");
    const end = new Date(start.getTime() + 30 * DAY_MS).toISOString();
    expect(daysRemaining(end, start)).toBe(30);
  });

  it("returns 1 on the last day", () => {
    const end = "2026-01-31T00:00:00.000Z";
    const now = new Date("2026-01-30T12:00:00.000Z");
    expect(daysRemaining(end, now)).toBe(1);
  });

  it("returns 0 when the trial is expired", () => {
    const end = "2026-01-31T00:00:00.000Z";
    const now = new Date("2026-02-01T00:00:00.000Z");
    expect(daysRemaining(end, now)).toBe(0);
  });

  it("never returns a negative number", () => {
    const end = "2020-01-01T00:00:00.000Z";
    const now = new Date("2026-06-01T00:00:00.000Z");
    expect(daysRemaining(end, now)).toBe(0);
  });

  it("returns 15 at the midpoint", () => {
    const end = "2026-01-31T00:00:00.000Z";
    const now = new Date("2026-01-16T00:00:00.000Z");
    expect(daysRemaining(end, now)).toBe(15);
  });
});

// ── createTrialLicense ────────────────────────────────────────────────────────

describe("createTrialLicense", () => {
  it("creates a trial with tier = 'trial'", () => {
    const lic = createTrialLicense(new Date("2026-03-01T00:00:00.000Z"));
    expect(lic.tier).toBe("trial");
  });

  it("sets trialStartedAt to now", () => {
    const now = new Date("2026-03-01T12:00:00.000Z");
    const lic = createTrialLicense(now);
    expect(lic.trialStartedAt).toBe(now.toISOString());
  });

  it("sets trialEndsAt to 30 days from now", () => {
    const now = new Date("2026-03-01T00:00:00.000Z");
    const lic = createTrialLicense(now);
    expect(lic.trialEndsAt).toBe("2026-03-31T00:00:00.000Z");
  });

  it("sets valid = true", () => {
    const lic = createTrialLicense();
    expect(lic.valid).toBe(true);
  });

  it("does not include stripeCustomerId or stripeSubscriptionId", () => {
    const lic = createTrialLicense();
    expect(lic.stripeCustomerId).toBeUndefined();
    expect(lic.stripeSubscriptionId).toBeUndefined();
  });
});

// ── loadLicense — first install ───────────────────────────────────────────────

describe("loadLicense — first install", () => {
  it("creates a trial license when no file exists", async () => {
    const lic = await loadLicense({ now: new Date("2026-03-01T00:00:00.000Z") });
    expect(lic.tier).toBe("trial");
    expect(lic.valid).toBe(true);
  });

  it("persists the license to disk", async () => {
    await loadLicense({ now: new Date("2026-03-01T00:00:00.000Z") });
    const ondisk = readLicense();
    expect(ondisk.tier).toBe("trial");
    expect(ondisk.trialStartedAt).toBe("2026-03-01T00:00:00.000Z");
  });
});

// ── loadLicense — trial expiry detection ──────────────────────────────────────

describe("loadLicense — trial expiry", () => {
  it("sets tier = expired when trial has ended", async () => {
    const start = new Date("2026-01-01T00:00:00.000Z");
    writeLicense(createTrialLicense(start));

    const afterExpiry = new Date("2026-02-01T00:00:00.000Z");
    const lic = await loadLicense({ now: afterExpiry });
    expect(lic.tier).toBe("expired");
    expect(lic.valid).toBe(false);
  });

  it("keeps tier = trial when still within 30 days", async () => {
    const start = new Date("2026-03-01T00:00:00.000Z");
    writeLicense(createTrialLicense(start));

    const day15 = new Date("2026-03-16T00:00:00.000Z");
    const lic = await loadLicense({ now: day15 });
    expect(lic.tier).toBe("trial");
    expect(lic.valid).toBe(true);
  });

  it("keeps tier = trial on the exact last millisecond", async () => {
    const start = new Date("2026-03-01T00:00:00.000Z");
    writeLicense(createTrialLicense(start));

    // trialEndsAt = "2026-03-31T00:00:00.000Z", so exactly at that ms is NOT expired yet
    const exactEnd = new Date("2026-03-31T00:00:00.000Z");
    const lic = await loadLicense({ now: exactEnd });
    expect(lic.tier).toBe("trial");
  });

  it("sets tier = expired 1ms after trialEndsAt", async () => {
    const start = new Date("2026-03-01T00:00:00.000Z");
    writeLicense(createTrialLicense(start));

    const justAfter = new Date("2026-03-31T00:00:00.001Z");
    const lic = await loadLicense({ now: justAfter });
    expect(lic.tier).toBe("expired");
  });

  it("persists expired state to disk", async () => {
    const start = new Date("2026-01-01T00:00:00.000Z");
    writeLicense(createTrialLicense(start));

    await loadLicense({ now: new Date("2026-02-15T00:00:00.000Z") });
    const ondisk = readLicense();
    expect(ondisk.tier).toBe("expired");
    expect(ondisk.valid).toBe(false);
  });
});

// ── loadLicense — pro / Stripe validation ─────────────────────────────────────

describe("loadLicense — pro tier", () => {
  function proLicense(active = true): License {
    return {
      tier: "pro",
      trialStartedAt: "2026-01-01T00:00:00.000Z",
      trialEndsAt: "2026-01-31T00:00:00.000Z",
      stripeCustomerId: "cus_123",
      stripeSubscriptionId: "sub_456",
      valid: active,
    };
  }

  it("validates against Stripe when tier is pro", async () => {
    writeLicense(proLicense());
    const validator = vi.fn().mockResolvedValue(true);
    const lic = await loadLicense({ stripeValidator: validator });
    expect(validator).toHaveBeenCalledTimes(1);
    expect(lic.valid).toBe(true);
    expect(lic.tier).toBe("pro");
  });

  it("sets tier = expired if Stripe says inactive", async () => {
    writeLicense(proLicense());
    const validator = vi.fn().mockResolvedValue(false);
    const lic = await loadLicense({ stripeValidator: validator });
    expect(lic.tier).toBe("expired");
    expect(lic.valid).toBe(false);
  });

  it("persists Stripe validation result to disk", async () => {
    writeLicense(proLicense());
    const validator = vi.fn().mockResolvedValue(false);
    await loadLicense({ stripeValidator: validator });
    const ondisk = readLicense();
    expect(ondisk.tier).toBe("expired");
  });
});

// ── validateStripeSubscription ────────────────────────────────────────────────

describe("validateStripeSubscription", () => {
  it("returns false when no subscriptionId is present", async () => {
    const lic = createTrialLicense();
    const result = await validateStripeSubscription(lic);
    expect(result).toBe(false);
  });

  it("returns true when remote says active", async () => {
    const lic: License = {
      tier: "pro",
      trialStartedAt: "2026-01-01T00:00:00.000Z",
      trialEndsAt: "2026-01-31T00:00:00.000Z",
      stripeSubscriptionId: "sub_123",
      valid: true,
    };
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ active: true }),
    });
    const result = await validateStripeSubscription(lic, {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result).toBe(true);
  });

  it("returns cached valid on non-ok response", async () => {
    const lic: License = {
      tier: "pro",
      trialStartedAt: "2026-01-01T00:00:00.000Z",
      trialEndsAt: "2026-01-31T00:00:00.000Z",
      stripeSubscriptionId: "sub_123",
      valid: true,
    };
    const fetchFn = vi.fn().mockResolvedValue({ ok: false });
    const result = await validateStripeSubscription(lic, {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result).toBe(true); // cached
  });

  it("returns cached valid on network error", async () => {
    const lic: License = {
      tier: "pro",
      trialStartedAt: "2026-01-01T00:00:00.000Z",
      trialEndsAt: "2026-01-31T00:00:00.000Z",
      stripeSubscriptionId: "sub_123",
      valid: false,
    };
    const fetchFn = vi.fn().mockRejectedValue(new Error("network down"));
    const result = await validateStripeSubscription(lic, {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result).toBe(false); // cached false
  });
});
