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

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

// ── Trial summary ─────────────────────────────────────────────────────────────

export interface TrialSummary {
  tasksCompleted: number;
  injectionsBlocked: number;
  totalSpendUSD: number;
  /** tasksCompleted * 0.25, rounded to 1 decimal place. */
  estimatedHoursSaved: number;
}

export interface TrialSummaryOptions {
  /** Override audit log path (default: ~/.armorclaw/audit.log). */
  auditLogPath?: string;
  /** Override tokens file path (default: ~/.armorclaw/tokens.ndjson). */
  tokensPath?: string;
}

/**
 * Read the audit log and token tracker to build a usage summary for the
 * trial expiry overlay.
 *
 * Never throws — returns all zeros on any I/O error.
 */
export function getTrialSummary(options: TrialSummaryOptions = {}): TrialSummary {
  const auditPath = options.auditLogPath ?? join(homedir(), ".armorclaw", "audit.log");
  const tokensPath = options.tokensPath ?? join(homedir(), ".armorclaw", "tokens.ndjson");

  let tasksCompleted = 0;
  let injectionsBlocked = 0;

  // Read audit log
  try {
    const content = readFileSync(auditPath, "utf-8");
    for (const line of content.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      try {
        const entry = JSON.parse(line) as { outcome?: string };
        if (entry.outcome === "success") {
          tasksCompleted++;
        }
        if (entry.outcome === "rejected") {
          injectionsBlocked++;
        }
      } catch {
        // Skip malformed lines
      }
    }
  } catch {
    // File absent or unreadable — keep zeros
  }

  // Read tokens
  let totalSpendUSD = 0;
  try {
    const content = readFileSync(tokensPath, "utf-8");
    for (const line of content.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      try {
        const event = JSON.parse(line) as { estimatedCostUSD?: number };
        if (typeof event.estimatedCostUSD === "number") {
          totalSpendUSD += event.estimatedCostUSD;
        }
      } catch {
        // Skip malformed lines
      }
    }
  } catch {
    // File absent or unreadable — keep zero
  }

  // Round to 2 decimals for currency
  totalSpendUSD = Math.round(totalSpendUSD * 100) / 100;

  // Conservative estimate: 15 min per task → 0.25 hours
  const estimatedHoursSaved = Math.round(tasksCompleted * 0.25 * 10) / 10;

  return { tasksCompleted, injectionsBlocked, totalSpendUSD, estimatedHoursSaved };
}

/**
 * Build the overlay body text, including a usage summary when the user
 * actually used the product during their trial.
 */
export function buildOverlayBody(summary: TrialSummary): string {
  const hasUsage = summary.tasksCompleted > 0 || summary.injectionsBlocked > 0;

  const dataMessage =
    "Your configuration stays on your machine. Nothing is deleted. " +
    "Your agent just won't run until you subscribe.";

  if (!hasUsage) {
    return (
      "Your trial has ended. Subscribe to start automating your work — $19/month.\n\n" + dataMessage
    );
  }

  const parts: string[] = [];

  parts.push("During your trial, ArmorClaw");

  const items: string[] = [];
  if (summary.tasksCompleted > 0) {
    items.push(
      `completed ${summary.tasksCompleted} task${summary.tasksCompleted === 1 ? "" : "s"}`,
    );
  }
  if (summary.injectionsBlocked > 0) {
    items.push(
      `blocked ${summary.injectionsBlocked} suspicious instruction${summary.injectionsBlocked === 1 ? "" : "s"}`,
    );
  }
  if (summary.estimatedHoursSaved > 0) {
    items.push(
      `saved you an estimated ${summary.estimatedHoursSaved} hour${summary.estimatedHoursSaved === 1 ? "" : "s"} of manual work`,
    );
  }

  // Join with commas and "and"
  if (items.length === 1) {
    parts.push(` ${items[0]}.`);
  } else if (items.length === 2) {
    parts.push(` ${items[0]} and ${items[1]}.`);
  } else {
    parts.push(` ${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}.`);
  }

  parts.push(
    "\n\nSubscribe to keep your agent running — your settings, skills, and recipes are all saved.\n\n",
  );
  parts.push(dataMessage);

  return parts.join("");
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
