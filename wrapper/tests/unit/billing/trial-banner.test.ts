/**
 * Unit tests for wrapper/billing/trial-banner.ts.
 *
 * Tests the banner threshold logic:
 *   Days 11+:  none (silent)
 *   Days 4–10: subtle (amber)
 *   Days 1–3:  prominent
 *   Day 0:     overlay (expired)
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { License } from "../../../billing/license.ts";
import {
  buildOverlayBody,
  getTrialBannerState,
  getTrialSummary,
} from "../../../billing/trial-banner.ts";

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

// ── getTrialSummary ───────────────────────────────────────────────────────────

const TMP_DIR = join(tmpdir(), "armorclaw-banner-test-" + Date.now());
const TMP_AUDIT = join(TMP_DIR, "audit.log");
const TMP_TOKENS = join(TMP_DIR, "tokens.ndjson");

beforeEach(() => {
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("getTrialSummary", () => {
  it("returns all zeros when audit log does not exist", () => {
    const summary = getTrialSummary({
      auditLogPath: join(TMP_DIR, "nonexistent.log"),
      tokensPath: join(TMP_DIR, "nonexistent.ndjson"),
    });
    expect(summary.tasksCompleted).toBe(0);
    expect(summary.injectionsBlocked).toBe(0);
    expect(summary.totalSpendUSD).toBe(0);
    expect(summary.estimatedHoursSaved).toBe(0);
  });

  it("returns all zeros for an empty audit log", () => {
    writeFileSync(TMP_AUDIT, "", "utf-8");
    writeFileSync(TMP_TOKENS, "", "utf-8");
    const summary = getTrialSummary({
      auditLogPath: TMP_AUDIT,
      tokensPath: TMP_TOKENS,
    });
    expect(summary.tasksCompleted).toBe(0);
    expect(summary.injectionsBlocked).toBe(0);
  });

  it("counts only outcome:success for tasksCompleted", () => {
    const lines = [
      JSON.stringify({ outcome: "success", skill: "email-calendar" }),
      JSON.stringify({ outcome: "success", skill: "crm-leadgen" }),
      JSON.stringify({ outcome: "error", skill: "email-calendar" }),
      JSON.stringify({ outcome: "rejected", skill: "email-calendar" }),
    ].join("\n");
    writeFileSync(TMP_AUDIT, lines, "utf-8");
    const summary = getTrialSummary({ auditLogPath: TMP_AUDIT, tokensPath: TMP_TOKENS });
    expect(summary.tasksCompleted).toBe(2);
  });

  it("counts only outcome:rejected for injectionsBlocked", () => {
    const lines = [
      JSON.stringify({ outcome: "rejected", skill: "injection-filter" }),
      JSON.stringify({ outcome: "rejected", skill: "injection-filter" }),
      JSON.stringify({ outcome: "success", skill: "email-calendar" }),
    ].join("\n");
    writeFileSync(TMP_AUDIT, lines, "utf-8");
    const summary = getTrialSummary({ auditLogPath: TMP_AUDIT, tokensPath: TMP_TOKENS });
    expect(summary.injectionsBlocked).toBe(2);
  });

  it("sums estimatedCostUSD from token events", () => {
    const lines = [
      JSON.stringify({ estimatedCostUSD: 0.5 }),
      JSON.stringify({ estimatedCostUSD: 1.25 }),
      JSON.stringify({ estimatedCostUSD: 0.1 }),
    ].join("\n");
    writeFileSync(TMP_TOKENS, lines, "utf-8");
    writeFileSync(TMP_AUDIT, "", "utf-8");
    const summary = getTrialSummary({ auditLogPath: TMP_AUDIT, tokensPath: TMP_TOKENS });
    expect(summary.totalSpendUSD).toBe(1.85);
  });

  it("handles missing tokens.ndjson gracefully", () => {
    writeFileSync(TMP_AUDIT, JSON.stringify({ outcome: "success" }), "utf-8");
    const summary = getTrialSummary({
      auditLogPath: TMP_AUDIT,
      tokensPath: join(TMP_DIR, "nope.ndjson"),
    });
    expect(summary.tasksCompleted).toBe(1);
    expect(summary.totalSpendUSD).toBe(0);
  });

  it("skips malformed JSON lines without crashing", () => {
    const lines = [
      JSON.stringify({ outcome: "success" }),
      "not valid json",
      JSON.stringify({ outcome: "success" }),
    ].join("\n");
    writeFileSync(TMP_AUDIT, lines, "utf-8");
    const summary = getTrialSummary({ auditLogPath: TMP_AUDIT, tokensPath: TMP_TOKENS });
    expect(summary.tasksCompleted).toBe(2);
  });

  it("calculates estimatedHoursSaved as tasksCompleted * 0.25", () => {
    const lines = Array.from({ length: 10 }, () => JSON.stringify({ outcome: "success" })).join(
      "\n",
    );
    writeFileSync(TMP_AUDIT, lines, "utf-8");
    const summary = getTrialSummary({ auditLogPath: TMP_AUDIT, tokensPath: TMP_TOKENS });
    expect(summary.estimatedHoursSaved).toBe(2.5);
  });

  it("rounds estimatedHoursSaved to 1 decimal place", () => {
    // 3 tasks → 0.75 hours → should show 0.8 (ceil at 1 decimal)
    // Actually: Math.round(3 * 0.25 * 10) / 10 = Math.round(7.5) / 10 = 8/10 = 0.8
    const lines = Array.from({ length: 3 }, () => JSON.stringify({ outcome: "success" })).join(
      "\n",
    );
    writeFileSync(TMP_AUDIT, lines, "utf-8");
    const summary = getTrialSummary({ auditLogPath: TMP_AUDIT, tokensPath: TMP_TOKENS });
    expect(summary.estimatedHoursSaved).toBe(0.8);
  });

  it("rounds totalSpendUSD to 2 decimal places", () => {
    const lines = [
      JSON.stringify({ estimatedCostUSD: 0.001 }),
      JSON.stringify({ estimatedCostUSD: 0.002 }),
      JSON.stringify({ estimatedCostUSD: 0.003 }),
    ].join("\n");
    writeFileSync(TMP_TOKENS, lines, "utf-8");
    writeFileSync(TMP_AUDIT, "", "utf-8");
    const summary = getTrialSummary({ auditLogPath: TMP_AUDIT, tokensPath: TMP_TOKENS });
    expect(summary.totalSpendUSD).toBe(0.01);
  });

  it("ignores token events without estimatedCostUSD", () => {
    const lines = [
      JSON.stringify({ skill: "foo" }),
      JSON.stringify({ estimatedCostUSD: 1.0 }),
    ].join("\n");
    writeFileSync(TMP_TOKENS, lines, "utf-8");
    writeFileSync(TMP_AUDIT, "", "utf-8");
    const summary = getTrialSummary({ auditLogPath: TMP_AUDIT, tokensPath: TMP_TOKENS });
    expect(summary.totalSpendUSD).toBe(1.0);
  });
});

// ── buildOverlayBody ──────────────────────────────────────────────────────────

describe("buildOverlayBody", () => {
  it("shows zero-usage message when all values are zero", () => {
    const body = buildOverlayBody({
      tasksCompleted: 0,
      injectionsBlocked: 0,
      totalSpendUSD: 0,
      estimatedHoursSaved: 0,
    });
    expect(body).toContain("Subscribe to start automating your work");
    expect(body).toContain("$19/month");
    expect(body).not.toContain("During your trial");
  });

  it("includes task count when tasks > 0", () => {
    const body = buildOverlayBody({
      tasksCompleted: 42,
      injectionsBlocked: 0,
      totalSpendUSD: 5.0,
      estimatedHoursSaved: 10.5,
    });
    expect(body).toContain("completed 42 tasks");
    expect(body).toContain("During your trial");
  });

  it("includes injection count when injections > 0", () => {
    const body = buildOverlayBody({
      tasksCompleted: 10,
      injectionsBlocked: 3,
      totalSpendUSD: 0,
      estimatedHoursSaved: 2.5,
    });
    expect(body).toContain("blocked 3 suspicious instructions");
  });

  it("includes estimated hours saved", () => {
    const body = buildOverlayBody({
      tasksCompleted: 20,
      injectionsBlocked: 0,
      totalSpendUSD: 0,
      estimatedHoursSaved: 5,
    });
    expect(body).toContain("saved you an estimated 5 hours");
  });

  it("uses singular 'task' for 1 task", () => {
    const body = buildOverlayBody({
      tasksCompleted: 1,
      injectionsBlocked: 0,
      totalSpendUSD: 0,
      estimatedHoursSaved: 0.3,
    });
    expect(body).toContain("completed 1 task");
    expect(body).not.toContain("1 tasks");
  });

  it("uses singular 'instruction' for 1 injection", () => {
    const body = buildOverlayBody({
      tasksCompleted: 0,
      injectionsBlocked: 1,
      totalSpendUSD: 0,
      estimatedHoursSaved: 0,
    });
    expect(body).toContain("blocked 1 suspicious instruction");
    expect(body).not.toContain("1 suspicious instructions");
  });

  it("always includes data safety message", () => {
    const body = buildOverlayBody({
      tasksCompleted: 0,
      injectionsBlocked: 0,
      totalSpendUSD: 0,
      estimatedHoursSaved: 0,
    });
    expect(body).toContain("Nothing is deleted");
    expect(body).toContain("stays on your machine");
  });

  it("includes data safety message with usage too", () => {
    const body = buildOverlayBody({
      tasksCompleted: 5,
      injectionsBlocked: 2,
      totalSpendUSD: 3,
      estimatedHoursSaved: 1.3,
    });
    expect(body).toContain("Nothing is deleted");
  });
});
