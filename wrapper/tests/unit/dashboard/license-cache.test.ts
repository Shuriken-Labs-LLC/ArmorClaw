/**
 * Unit tests for primeLicenseCache's refresh-timer behaviour.
 *
 * The fix under test: each tick must call pollForActivation() after
 * loadLicense(), not just loadLicense(). Without it, a customer who
 * subscribes inside a running ArmorClaw stays inactive until restart.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { License } from "../../../billing/license.ts";

// ── Module mock ──────────────────────────────────────────────────────────────
// Stub both billing functions so no file I/O or network call occurs.
vi.mock("../../../billing/license.ts", () => ({
  loadLicense: vi.fn(),
  pollForActivation: vi.fn(),
}));

import * as licenseModule from "../../../billing/license.ts";
import {
  clearLicenseCacheForTesting,
  getCachedLicense,
  primeLicenseCache,
} from "../../../dashboard/server.ts";

const REFRESH_MS = 60_000;

const INACTIVE: License = { tier: "inactive", installId: "test-install", valid: false };
const ACTIVE: License = {
  tier: "active",
  installId: "test-install",
  valid: true,
  stripeCustomerId: "cus_test",
  stripeSubscriptionId: "sub_test",
};

describe("primeLicenseCache", () => {
  let loadLicense: ReturnType<typeof vi.fn>;
  let pollForActivation: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    clearLicenseCacheForTesting();
    loadLicense = licenseModule.loadLicense as ReturnType<typeof vi.fn>;
    pollForActivation = licenseModule.pollForActivation as ReturnType<typeof vi.fn>;
    loadLicense.mockReset();
    pollForActivation.mockReset();
  });

  afterEach(() => {
    clearLicenseCacheForTesting();
    vi.useRealTimers();
  });

  it("boot path: calls loadLicense + pollForActivation once and returns the polled result", async () => {
    loadLicense.mockResolvedValue(INACTIVE);
    pollForActivation.mockResolvedValue(ACTIVE);

    const result = await primeLicenseCache();

    expect(loadLicense).toHaveBeenCalledTimes(1);
    expect(pollForActivation).toHaveBeenCalledTimes(1);
    expect(pollForActivation).toHaveBeenCalledWith(INACTIVE);
    expect(result).toEqual(ACTIVE);
    expect(getCachedLicense()).toEqual(ACTIVE);
  });

  it("is idempotent: second call returns the cached value without re-invoking either function", async () => {
    loadLicense.mockResolvedValue(INACTIVE);
    pollForActivation.mockResolvedValue(INACTIVE);

    await primeLicenseCache();
    loadLicense.mockClear();
    pollForActivation.mockClear();

    const result = await primeLicenseCache();

    expect(loadLicense).not.toHaveBeenCalled();
    expect(pollForActivation).not.toHaveBeenCalled();
    expect(result).toEqual(INACTIVE);
  });

  it("regression guard: refresh tick calls BOTH loadLicense and pollForActivation, not just loadLicense", async () => {
    loadLicense.mockResolvedValue(INACTIVE);
    pollForActivation.mockResolvedValue(INACTIVE);

    await primeLicenseCache();
    expect(loadLicense).toHaveBeenCalledTimes(1);
    expect(pollForActivation).toHaveBeenCalledTimes(1);

    // Advance the fake clock one full refresh interval and let the queued
    // microtasks run so the timer's async body completes.
    await vi.advanceTimersByTimeAsync(REFRESH_MS);

    expect(loadLicense).toHaveBeenCalledTimes(2);
    expect(pollForActivation).toHaveBeenCalledTimes(2);
  });

  it("promotion on tick: loadLicense returns inactive but pollForActivation promotes — cache flips to active", async () => {
    // Boot: still inactive.
    loadLicense.mockResolvedValueOnce(INACTIVE);
    pollForActivation.mockResolvedValueOnce(INACTIVE);
    await primeLicenseCache();
    expect(getCachedLicense()).toEqual(INACTIVE);

    // One minute later, the customer has subscribed. license.json still
    // reads inactive (the file hasn't been rewritten yet), but the poll
    // hits the billing Worker and gets back active.
    loadLicense.mockResolvedValueOnce(INACTIVE);
    pollForActivation.mockResolvedValueOnce(ACTIVE);
    await vi.advanceTimersByTimeAsync(REFRESH_MS);

    expect(getCachedLicense()).toEqual(ACTIVE);
  });

  it("resilience: loadLicense rejection on a tick keeps the previous cache intact", async () => {
    loadLicense.mockResolvedValueOnce(ACTIVE);
    pollForActivation.mockResolvedValueOnce(ACTIVE);
    await primeLicenseCache();
    expect(getCachedLicense()).toEqual(ACTIVE);

    // Next tick: loadLicense throws (disk error, transient FS hiccup).
    loadLicense.mockRejectedValueOnce(new Error("EIO"));
    await vi.advanceTimersByTimeAsync(REFRESH_MS);

    expect(getCachedLicense()).toEqual(ACTIVE);
  });
});
