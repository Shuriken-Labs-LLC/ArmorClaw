/**
 * Unit tests for wrapper/billing/license.ts.
 *
 * All file I/O uses a temp directory.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activateWithEmail,
  clearLicenseForTesting,
  createInactiveLicense,
  loadLicense,
  pollForActivation,
  setLicensePathForTesting,
  validateStripeSubscription,
} from "../../../billing/license.ts";
import type { License } from "../../../billing/license.ts";

// ── Test setup ─────────────────���─────────────────────────────────────��────────

const TMP_DIR = join(tmpdir(), "armorclaw-lic-test-" + Date.now());
const TMP_FILE = join(TMP_DIR, "license.json");

beforeEach(() => {
  mkdirSync(TMP_DIR, { recursive: true });
  setLicensePathForTesting(TMP_FILE);
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

// ── Helpers ───────────────────���──────────────────────────────���────────────────

function writeLicense(license: License): void {
  writeFileSync(TMP_FILE, JSON.stringify(license, null, 2), "utf-8");
}

function readLicense(): License {
  return JSON.parse(readFileSync(TMP_FILE, "utf-8")) as License;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── createInactiveLicense ─────────────────────────────────────────���─────────────

describe("createInactiveLicense", () => {
  it("creates a license with tier = 'inactive'", () => {
    const lic = createInactiveLicense();
    expect(lic.tier).toBe("inactive");
  });

  it("sets valid = false", () => {
    const lic = createInactiveLicense();
    expect(lic.valid).toBe(false);
  });

  it("does not include stripeCustomerId or stripeSubscriptionId", () => {
    const lic = createInactiveLicense();
    expect(lic.stripeCustomerId).toBeUndefined();
    expect(lic.stripeSubscriptionId).toBeUndefined();
  });

  it("generates a UUID-shaped installId", () => {
    const lic = createInactiveLicense();
    expect(lic.installId).toMatch(UUID_RE);
  });

  it("generates a unique installId per call", () => {
    const a = createInactiveLicense();
    const b = createInactiveLicense();
    expect(a.installId).not.toBe(b.installId);
  });
});

// ── loadLicense — first install ────────────���──────────────────────────────────

describe("loadLicense — first install", () => {
  it("creates an inactive license when no file exists", async () => {
    const lic = await loadLicense();
    expect(lic.tier).toBe("inactive");
    expect(lic.valid).toBe(false);
  });

  it("persists the license to disk", async () => {
    await loadLicense();
    const ondisk = readLicense();
    expect(ondisk.tier).toBe("inactive");
  });

  it("persists installId to disk on first install", async () => {
    const lic = await loadLicense();
    const ondisk = readLicense();
    expect(ondisk.installId).toBe(lic.installId);
    expect(ondisk.installId).toMatch(UUID_RE);
  });

  it("preserves installId across loads (never regenerated)", async () => {
    const first = await loadLicense();
    const second = await loadLicense();
    expect(second.installId).toBe(first.installId);
  });
});

// ── loadLicense — installId backfill ──────────────────────────────────────────

describe("loadLicense — installId backfill", () => {
  it("backfills installId for licenses written before the field existed", async () => {
    const legacy = {
      tier: "inactive",
      valid: false,
    } as unknown as License;
    writeLicense(legacy);

    const lic = await loadLicense();
    expect(lic.installId).toMatch(UUID_RE);
    expect(readLicense().installId).toBe(lic.installId);
  });
});

// ── loadLicense — legacy tier migration ───────────────────────────────────────

describe("loadLicense — legacy tier migration", () => {
  it("migrates legacy 'trial' tier to 'inactive'", async () => {
    writeLicense({
      tier: "trial" as unknown as License["tier"],
      installId: "11111111-1111-1111-1111-111111111111",
      valid: true,
    } as License);
    const lic = await loadLicense();
    expect(lic.tier).toBe("inactive");
    expect(lic.valid).toBe(false);
  });

  it("migrates legacy 'pro' tier to 'active'", async () => {
    writeLicense({
      tier: "pro" as unknown as License["tier"],
      installId: "11111111-1111-1111-1111-111111111111",
      stripeSubscriptionId: "sub_123",
      valid: true,
    } as License);
    const lic = await loadLicense();
    expect(lic.tier).toBe("active");
  });

  it("migrates legacy 'expired' tier to 'inactive'", async () => {
    writeLicense({
      tier: "expired" as unknown as License["tier"],
      installId: "11111111-1111-1111-1111-111111111111",
      valid: false,
    } as License);
    const lic = await loadLicense();
    expect(lic.tier).toBe("inactive");
    expect(lic.valid).toBe(false);
  });
});

// ── loadLicense — active / Stripe validation ──────────────────────────────────

describe("loadLicense — active tier", () => {
  function activeLicense(valid = true): License {
    return {
      tier: "active",
      installId: "11111111-1111-1111-1111-111111111111",
      stripeCustomerId: "cus_123",
      stripeSubscriptionId: "sub_456",
      valid,
    };
  }

  it("validates against Stripe when tier is active", async () => {
    writeLicense(activeLicense());
    const validator = vi.fn().mockResolvedValue(true);
    const lic = await loadLicense({ stripeValidator: validator });
    expect(validator).toHaveBeenCalledTimes(1);
    expect(lic.valid).toBe(true);
    expect(lic.tier).toBe("active");
  });

  it("sets tier = inactive if Stripe says inactive", async () => {
    writeLicense(activeLicense());
    const validator = vi.fn().mockResolvedValue(false);
    const lic = await loadLicense({ stripeValidator: validator });
    expect(lic.tier).toBe("inactive");
    expect(lic.valid).toBe(false);
  });

  it("persists Stripe validation result to disk", async () => {
    writeLicense(activeLicense());
    const validator = vi.fn().mockResolvedValue(false);
    await loadLicense({ stripeValidator: validator });
    const ondisk = readLicense();
    expect(ondisk.tier).toBe("inactive");
  });
});

// ── validateStripeSubscription ────────────────────────────────────────────────

describe("validateStripeSubscription", () => {
  function license(overrides: Partial<License> = {}): License {
    return {
      tier: "active",
      installId: "22222222-2222-2222-2222-222222222222",
      stripeSubscriptionId: "sub_123",
      valid: true,
      ...overrides,
    };
  }

  it("returns false when no installId is present", async () => {
    const lic = { ...license(), installId: "" } as License;
    const result = await validateStripeSubscription(lic);
    expect(result).toBe(false);
  });

  it("posts { installId } to the validation endpoint", async () => {
    const lic = license();
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ active: true }),
    });
    await validateStripeSubscription(lic, { fetchFn: fetchFn as unknown as typeof fetch });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [, init] = fetchFn.mock.calls[0];
    const body = JSON.parse((init as { body: string }).body) as { installId: string };
    expect(body.installId).toBe(lic.installId);
  });

  it("returns true when remote says active", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ active: true }),
    });
    const result = await validateStripeSubscription(license(), {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result).toBe(true);
  });

  it("returns cached valid on non-ok response", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false });
    const result = await validateStripeSubscription(license({ valid: true }), {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result).toBe(true);
  });

  it("returns cached valid on network error", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("network down"));
    const result = await validateStripeSubscription(license({ valid: false }), {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result).toBe(false);
  });
});

// ── pollForActivation ─────────��────────────────────────────────��──────────────

describe("pollForActivation", () => {
  const inactiveLicense: License = {
    tier: "inactive",
    installId: "33333333-3333-3333-3333-333333333333",
    valid: false,
  };

  it("returns license unchanged when tier is not inactive", async () => {
    const activeLic: License = { ...inactiveLicense, tier: "active", valid: true };
    const fetchFn = vi.fn();
    const result = await pollForActivation(activeLic, {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result).toBe(activeLic);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("returns license unchanged when installId is missing", async () => {
    const noId = { ...inactiveLicense, installId: "" } as License;
    const fetchFn = vi.fn();
    const result = await pollForActivation(noId, {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result).toBe(noId);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("promotes to active when worker reports active subscription", async () => {
    writeLicense(inactiveLicense);
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          active: true,
          subscriptionId: "sub_NEW",
          customerId: "cus_NEW",
        }),
    });
    const result = await pollForActivation(inactiveLicense, {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result.tier).toBe("active");
    expect(result.stripeSubscriptionId).toBe("sub_NEW");
    expect(result.stripeCustomerId).toBe("cus_NEW");
    expect(result.valid).toBe(true);
    expect(result.installId).toBe(inactiveLicense.installId);
  });

  it("persists promotion to disk", async () => {
    writeLicense(inactiveLicense);
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          active: true,
          subscriptionId: "sub_NEW",
          customerId: "cus_NEW",
        }),
    });
    await pollForActivation(inactiveLicense, {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const ondisk = readLicense();
    expect(ondisk.tier).toBe("active");
    expect(ondisk.stripeSubscriptionId).toBe("sub_NEW");
  });

  it("returns inactive unchanged when worker says active:false", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ active: false }),
    });
    const result = await pollForActivation(inactiveLicense, {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result.tier).toBe("inactive");
  });

  it("returns inactive unchanged when worker says active without ids", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ active: true }),
    });
    const result = await pollForActivation(inactiveLicense, {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result.tier).toBe("inactive");
  });

  it("returns inactive unchanged on non-ok response", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false });
    const result = await pollForActivation(inactiveLicense, {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result).toBe(inactiveLicense);
  });

  it("returns inactive unchanged on network error (never throws)", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("offline"));
    const result = await pollForActivation(inactiveLicense, {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result).toBe(inactiveLicense);
  });

  it("posts { installId } to the validation endpoint", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ active: false }),
    });
    await pollForActivation(inactiveLicense, {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const [, init] = fetchFn.mock.calls[0];
    const body = JSON.parse((init as { body: string }).body) as { installId: string };
    expect(body.installId).toBe(inactiveLicense.installId);
  });
});

// ── activateWithEmail ────────────────────────────────────────────────────────

describe("activateWithEmail", () => {
  const inactiveLicense: License = {
    tier: "inactive",
    installId: "44444444-4444-4444-4444-444444444444",
    valid: false,
  };

  function activeResponse(): ValidateBody {
    return { active: true, subscriptionId: "sub_EMAIL", customerId: "cus_EMAIL" };
  }
  type ValidateBody = {
    active?: boolean;
    subscriptionId?: string;
    customerId?: string;
  };

  function okFetch(body: ValidateBody) {
    return vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(body),
    });
  }

  it("rejects an empty email as invalid_email", async () => {
    const fetchFn = vi.fn();
    const result = await activateWithEmail("", inactiveLicense, {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid_email");
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects a malformed email without calling the network", async () => {
    const fetchFn = vi.fn();
    const result = await activateWithEmail("not-an-email", inactiveLicense, {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid_email");
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("posts the trimmed email to /validate-email", async () => {
    const fetchFn = okFetch({ active: false });
    await activateWithEmail("  buyer@example.com  ", inactiveLicense, {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [, init] = fetchFn.mock.calls[0];
    const body = JSON.parse((init as { body: string }).body) as { email: string };
    expect(body.email).toBe("buyer@example.com");
  });

  it("promotes an inactive license to active on a positive response", async () => {
    writeLicense(inactiveLicense);
    const fetchFn = okFetch(activeResponse());
    const result = await activateWithEmail("buyer@example.com", inactiveLicense, {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.license.tier).toBe("active");
      expect(result.license.valid).toBe(true);
      expect(result.license.stripeSubscriptionId).toBe("sub_EMAIL");
      expect(result.license.stripeCustomerId).toBe("cus_EMAIL");
      expect(result.license.installId).toBe(inactiveLicense.installId);
    }
  });

  it("persists the promoted license to disk", async () => {
    writeLicense(inactiveLicense);
    const fetchFn = okFetch(activeResponse());
    await activateWithEmail("buyer@example.com", inactiveLicense, {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const ondisk = readLicense();
    expect(ondisk.tier).toBe("active");
    expect(ondisk.stripeSubscriptionId).toBe("sub_EMAIL");
  });

  it("returns not_found when the worker says active:false", async () => {
    const fetchFn = okFetch({ active: false });
    const result = await activateWithEmail("buyer@example.com", inactiveLicense, {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not_found");
    }
  });

  it("returns not_found when the worker omits the ids", async () => {
    const fetchFn = okFetch({ active: true });
    const result = await activateWithEmail("buyer@example.com", inactiveLicense, {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not_found");
    }
  });

  it("refuses when the license is already bound to a different subscription", async () => {
    const bound: License = {
      ...inactiveLicense,
      stripeSubscriptionId: "sub_OTHER",
      stripeCustomerId: "cus_EMAIL",
    };
    const fetchFn = okFetch(activeResponse());
    const result = await activateWithEmail("buyer@example.com", bound, {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("mismatch");
    }
  });

  it("refuses when the license is bound to a different customer", async () => {
    const bound: License = {
      ...inactiveLicense,
      stripeCustomerId: "cus_OTHER",
    };
    const fetchFn = okFetch(activeResponse());
    const result = await activateWithEmail("buyer@example.com", bound, {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("mismatch");
    }
  });

  it("accepts a matching prior binding (idempotent re-activation)", async () => {
    const bound: License = {
      ...inactiveLicense,
      stripeSubscriptionId: "sub_EMAIL",
      stripeCustomerId: "cus_EMAIL",
    };
    writeLicense(bound);
    const fetchFn = okFetch(activeResponse());
    const result = await activateWithEmail("buyer@example.com", bound, {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.license.tier).toBe("active");
    }
  });

  it("returns network on a non-ok response without persisting", async () => {
    writeLicense(inactiveLicense);
    const fetchFn = vi.fn().mockResolvedValue({ ok: false });
    const result = await activateWithEmail("buyer@example.com", inactiveLicense, {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("network");
    }
    expect(readLicense().tier).toBe("inactive");
  });

  it("returns network on fetch rejection", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("offline"));
    const result = await activateWithEmail("buyer@example.com", inactiveLicense, {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("network");
    }
  });
});
