/**
 * Unit tests for wrapper/billing/trial-banner.ts.
 *
 * Tests the banner threshold logic:
 *   Days 11+:  none (silent)
 *   Days 4–10: subtle (amber)
 *   Days 1–3:  prominent
 *   Day 0:     overlay (expired)
 */

import { describe, expect, it } from "vitest";
import type { License } from "../../../billing/license.ts";
import { getTrialBannerState } from "../../../billing/trial-banner.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

/** Create a trial license starting at `start`, with optional overrides. */
function trialLicense(start: Date, overrides: Partial<License> = {}): License {
  const trialStartedAt = start.toISOString();
  const trialEndsAt = new Date(start.getTime() + 30 * DAY_MS).toISOString();
  return {
    tier: "trial",
    trialStartedAt,
    trialEndsAt,
    valid: true,
    ...overrides,
  };
}

/** Compute "now" as `daysFromEnd` days before trialEndsAt. */
function nowAtDaysLeft(trialEndsAt: string, daysLeft: number): Date {
  return new Date(new Date(trialEndsAt).getTime() - daysLeft * DAY_MS);
}

// ── Silent period (days 11+) ──────────────────────────────────────────────────

describe("silent period (days 11+)", () => {
  it("shows no banner on day 1 (30 days left)", () => {
    const lic = trialLicense(new Date("2026-03-01T00:00:00.000Z"));
    const now = nowAtDaysLeft(lic.trialEndsAt, 30);
    const state = getTrialBannerState(lic, now);
    expect(state.level).toBe("none");
    expect(state.daysLeft).toBe(30);
    expect(state.heading).toBeNull();
    expect(state.showSubscribeButton).toBe(false);
  });

  it("shows no banner at 20 days left", () => {
    const lic = trialLicense(new Date("2026-03-01T00:00:00.000Z"));
    const now = nowAtDaysLeft(lic.trialEndsAt, 20);
    const state = getTrialBannerState(lic, now);
    expect(state.level).toBe("none");
    expect(state.daysLeft).toBe(20);
  });

  it("shows no banner at 11 days left", () => {
    const lic = trialLicense(new Date("2026-03-01T00:00:00.000Z"));
    const now = nowAtDaysLeft(lic.trialEndsAt, 11);
    const state = getTrialBannerState(lic, now);
    expect(state.level).toBe("none");
  });
});

// ── Subtle amber banner (days 4–10) ──────────────────────────────────────────

describe("subtle banner (days 4–10)", () => {
  it("shows subtle at 10 days left", () => {
    const lic = trialLicense(new Date("2026-03-01T00:00:00.000Z"));
    const now = nowAtDaysLeft(lic.trialEndsAt, 10);
    const state = getTrialBannerState(lic, now);
    expect(state.level).toBe("subtle");
    expect(state.daysLeft).toBe(10);
    expect(state.showSubscribeButton).toBe(true);
  });

  it("shows subtle at 7 days left", () => {
    const lic = trialLicense(new Date("2026-03-01T00:00:00.000Z"));
    const now = nowAtDaysLeft(lic.trialEndsAt, 7);
    const state = getTrialBannerState(lic, now);
    expect(state.level).toBe("subtle");
    expect(state.heading).toContain("7 days");
  });

  it("shows subtle at 4 days left", () => {
    const lic = trialLicense(new Date("2026-03-01T00:00:00.000Z"));
    const now = nowAtDaysLeft(lic.trialEndsAt, 4);
    const state = getTrialBannerState(lic, now);
    expect(state.level).toBe("subtle");
  });

  it("subtle banner body mentions $19/month", () => {
    const lic = trialLicense(new Date("2026-03-01T00:00:00.000Z"));
    const now = nowAtDaysLeft(lic.trialEndsAt, 7);
    const state = getTrialBannerState(lic, now);
    expect(state.body).toContain("$19/month");
  });
});

// ── Prominent banner (days 1–3) ──────────────────────────────────────────────

describe("prominent banner (days 1–3)", () => {
  it("shows prominent at 3 days left", () => {
    const lic = trialLicense(new Date("2026-03-01T00:00:00.000Z"));
    const now = nowAtDaysLeft(lic.trialEndsAt, 3);
    const state = getTrialBannerState(lic, now);
    expect(state.level).toBe("prominent");
    expect(state.daysLeft).toBe(3);
    expect(state.showSubscribeButton).toBe(true);
  });

  it("shows prominent at 2 days left", () => {
    const lic = trialLicense(new Date("2026-03-01T00:00:00.000Z"));
    const now = nowAtDaysLeft(lic.trialEndsAt, 2);
    const state = getTrialBannerState(lic, now);
    expect(state.level).toBe("prominent");
    expect(state.heading).toContain("2 days");
  });

  it("shows prominent at 1 day left (singular)", () => {
    const lic = trialLicense(new Date("2026-03-01T00:00:00.000Z"));
    const now = nowAtDaysLeft(lic.trialEndsAt, 1);
    const state = getTrialBannerState(lic, now);
    expect(state.level).toBe("prominent");
    expect(state.heading).toContain("1 day left");
    // Should be singular "day", not "days"
    expect(state.heading).not.toContain("1 days");
  });
});

// ── Overlay (expired) ─────────────────────────────────────────────────────────

describe("overlay (expired)", () => {
  it("shows overlay when tier is expired", () => {
    const lic = trialLicense(new Date("2026-01-01T00:00:00.000Z"), {
      tier: "expired",
      valid: false,
    });
    const state = getTrialBannerState(lic, new Date("2026-06-01T00:00:00.000Z"));
    expect(state.level).toBe("overlay");
    expect(state.daysLeft).toBe(0);
  });

  it("shows overlay when daysLeft = 0 and tier still trial", () => {
    const lic = trialLicense(new Date("2026-03-01T00:00:00.000Z"));
    const justAfter = new Date(new Date(lic.trialEndsAt).getTime() + 1);
    const state = getTrialBannerState(lic, justAfter);
    expect(state.level).toBe("overlay");
  });

  it("overlay heading says trial has ended", () => {
    const lic = trialLicense(new Date("2026-01-01T00:00:00.000Z"), {
      tier: "expired",
      valid: false,
    });
    const state = getTrialBannerState(lic);
    expect(state.heading).toContain("trial has ended");
  });

  it("overlay body mentions settings and data are saved", () => {
    const lic = trialLicense(new Date("2026-01-01T00:00:00.000Z"), {
      tier: "expired",
      valid: false,
    });
    const state = getTrialBannerState(lic);
    expect(state.body).toContain("settings, skills, and recipes are all saved");
  });

  it("overlay body explains data safety", () => {
    const lic = trialLicense(new Date("2026-01-01T00:00:00.000Z"), {
      tier: "expired",
      valid: false,
    });
    const state = getTrialBannerState(lic);
    expect(state.body).toContain("Nothing is deleted");
    expect(state.body).toContain("stays on your machine");
  });

  it("overlay shows subscribe and export buttons", () => {
    const lic = trialLicense(new Date("2026-01-01T00:00:00.000Z"), {
      tier: "expired",
      valid: false,
    });
    const state = getTrialBannerState(lic);
    expect(state.showSubscribeButton).toBe(true);
    expect(state.showExportButton).toBe(true);
  });
});

// ── Pro tier — no banner ──────────────────────────────────────────────────────

describe("pro tier", () => {
  it("never shows a banner", () => {
    const lic = trialLicense(new Date("2026-03-01T00:00:00.000Z"), {
      tier: "pro",
      stripeSubscriptionId: "sub_123",
    });
    const state = getTrialBannerState(lic, new Date("2026-03-25T00:00:00.000Z"));
    expect(state.level).toBe("none");
    expect(state.heading).toBeNull();
    expect(state.showSubscribeButton).toBe(false);
  });
});

// ── Export always available ───────────────────────────────────────────────────

describe("export data always accessible", () => {
  it("overlay has showExportButton = true", () => {
    const lic = trialLicense(new Date("2026-01-01T00:00:00.000Z"), {
      tier: "expired",
      valid: false,
    });
    const state = getTrialBannerState(lic);
    expect(state.showExportButton).toBe(true);
  });

  it("non-expired states have showExportButton = false (no overlay needed)", () => {
    const lic = trialLicense(new Date("2026-03-01T00:00:00.000Z"));
    const state = getTrialBannerState(lic, new Date("2026-03-05T00:00:00.000Z"));
    expect(state.showExportButton).toBe(false);
  });
});
