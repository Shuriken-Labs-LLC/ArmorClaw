/**
 * Trial countdown banner logic.
 *
 * Controls what banner (if any) the dashboard shows based on how many
 * trial days remain:
 *
 *   Days 1–20:  no banner (let them enjoy the product)
 *   Days 21–27: subtle amber banner with subscribe CTA
 *   Days 28–30: prominent banner on every view
 *   Day 0:      full-screen expiry overlay — agent paused
 *
 * The overlay never traps the user:
 *   - "Export my data" always works
 *   - Settings remain accessible
 *   - Plain-language explanation of data safety
 */

import type { License } from "./license.ts";
import { daysRemaining } from "./license.ts";

// ── Banner types ──────────────────────────────────────────────────────────────

export type BannerLevel = "none" | "subtle" | "prominent" | "overlay";

export interface TrialBannerState {
  level: BannerLevel;
  daysLeft: number;
  /** The heading text for the banner/overlay. Null when level is "none". */
  heading: string | null;
  /** The body / description text. Null when level is "none". */
  body: string | null;
  /** Whether to show the "Subscribe now" / "Subscribe — $19/month" button. */
  showSubscribeButton: boolean;
  /** Whether to show the "Export my data" button (only on overlay). */
  showExportButton: boolean;
}

// ── Threshold constants (exported for testing) ────────────────────────────────

export const SILENT_UNTIL_DAYS_LEFT = 10;
export const SUBTLE_UNTIL_DAYS_LEFT = 3;

// ── Main function ─────────────────────────────────────────────────────────────

/**
 * Compute the banner state for the current license.
 *
 * @param license - The current license object.
 * @param now     - Override current time (test injection).
 */
export function getTrialBannerState(license: License, now: Date = new Date()): TrialBannerState {
  const daysLeft = daysRemaining(license.trialEndsAt, now);

  // Expired (trial or pro that lost subscription)
  if (license.tier === "expired" || (!license.valid && license.tier !== "trial")) {
    return {
      level: "overlay",
      daysLeft: 0,
      heading: "Your trial has ended",
      body:
        "Subscribe to keep your agent running — your settings, skills, and recipes " +
        "are all saved.\n\n" +
        "Your configuration stays on your machine. Nothing is deleted. " +
        "Your agent just won't run until you subscribe.",
      showSubscribeButton: true,
      showExportButton: true,
    };
  }

  // Pro — no banner ever
  if (license.tier === "pro") {
    return {
      level: "none",
      daysLeft,
      heading: null,
      body: null,
      showSubscribeButton: false,
      showExportButton: false,
    };
  }

  // Trial — day 0 (expired but tier hasn't been flipped yet, edge case)
  if (daysLeft === 0) {
    return {
      level: "overlay",
      daysLeft: 0,
      heading: "Your trial has ended",
      body:
        "Subscribe to keep your agent running — your settings, skills, and recipes " +
        "are all saved.\n\n" +
        "Your configuration stays on your machine. Nothing is deleted. " +
        "Your agent just won't run until you subscribe.",
      showSubscribeButton: true,
      showExportButton: true,
    };
  }

  // Days 1–3: prominent banner
  if (daysLeft <= SUBTLE_UNTIL_DAYS_LEFT) {
    return {
      level: "prominent",
      daysLeft,
      heading: `${daysLeft} day${daysLeft === 1 ? "" : "s"} left in your trial`,
      body: null,
      showSubscribeButton: true,
      showExportButton: false,
    };
  }

  // Days 4–10: subtle amber banner
  if (daysLeft <= SILENT_UNTIL_DAYS_LEFT) {
    return {
      level: "subtle",
      daysLeft,
      heading: `Your free trial ends in ${daysLeft} days`,
      body: "Subscribe to keep ArmorClaw running — $19/month.",
      showSubscribeButton: true,
      showExportButton: false,
    };
  }

  // Days 11+: no banner
  return {
    level: "none",
    daysLeft,
    heading: null,
    body: null,
    showSubscribeButton: false,
    showExportButton: false,
  };
}
