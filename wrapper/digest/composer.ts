import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getSkill } from "../lib/skill-registry.ts";
import {
  getBudgetMonthlyUSD,
  getDailyHistory,
  getMonthTokens,
  isHardStopped,
} from "../token-tracker/store.ts";
import {
  type ActivityEntry,
  type CalendarEvent,
  type DigestInput,
  buildPrompt,
} from "./prompt-template.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

export type { ActivityEntry, CalendarEvent, DigestInput };

/**
 * Fully assembled digest payload: structured data + the model prompt.
 * `isBudgetPaused` is true when the hard stop is active; in that case
 * `prompt` is a pre-written human message, not a model prompt.
 */
export interface DigestData {
  input: DigestInput;
  /** Ready-to-send string: a model prompt normally, or the budget-paused notice. */
  prompt: string;
  /** true when the budget hard-stop is active. Prompt is pre-written, not a model call. */
  isBudgetPaused: boolean;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Sent verbatim (no model call) when the budget hard-stop is active. */
export const BUDGET_PAUSED_MESSAGE =
  "Your ArmorClaw budget is paused. Go to your dashboard to resume.";

// ── Audit log reader ──────────────────────────────────────────────────────────

// Shape of entries written by audit-logger.ts
interface AuditEntry {
  timestamp: string;
  skill: string;
  outcome: "success" | "rejected" | "error";
}

function auditLogPath(): string {
  return join(homedir(), ".armorclaw", "audit.log");
}

/**
 * Load all audit entries for a specific date (YYYY-MM-DD).
 * Reads the NDJSON audit log, skips blank and malformed lines.
 * Returns an empty array on any I/O error.
 */
export function loadAuditEntriesForDate(date: string): AuditEntry[] {
  let raw: string;
  try {
    raw = readFileSync(auditLogPath(), "utf-8");
  } catch {
    return [];
  }
  const results: AuditEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      const entry = JSON.parse(line) as Partial<AuditEntry>;
      // Only include entries that look like AuditEntry (have skill + outcome)
      if (
        entry.timestamp?.startsWith(date) &&
        typeof entry.skill === "string" &&
        typeof entry.outcome === "string"
      ) {
        results.push(entry as AuditEntry);
      }
    } catch {
      // Skip malformed lines
    }
  }
  return results;
}

// ── Date helpers ──────────────────────────────────────────────────────────────

export function yesterdayDateString(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

export function todayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── Activity aggregation ──────────────────────────────────────────────────────

/**
 * Group audit entries by skill and count actions.
 * Maps skillId to displayName using the skill registry; falls back to the skillId
 * if the skill is not registered (user-removed skill, registry cleared, etc.).
 */
export function aggregateActivity(entries: AuditEntry[]): ActivityEntry[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    counts.set(entry.skill, (counts.get(entry.skill) ?? 0) + 1);
  }
  return [...counts.entries()].map(([skillId, actionCount]) => ({
    displayName: getSkill(skillId)?.displayName ?? skillId,
    actionCount,
  }));
}

// ── Composer ──────────────────────────────────────────────────────────────────

/**
 * Build the full digest payload for the current day.
 *
 * When the budget hard-stop is active, returns a pre-written notice and sets
 * `isBudgetPaused: true` — callers must send `prompt` verbatim without a model call.
 *
 * Otherwise, returns structured `DigestInput` and a model prompt ready for the
 * model adapter. The model's response is the actual message sent to channels.
 *
 * @param calendarEvents  Optional: calendar events injected by the calendar skill.
 *                        Default: empty array with `calendarUnavailable: false`.
 * @param calendarUnavailable  Pass `true` when the calendar skill cannot be reached.
 * @param pendingItems    Optional: pending item strings from skill state.
 * @param suggestion      Optional: high-confidence usage pattern suggestion.
 */
export function buildDigestData(options?: {
  calendarEvents?: CalendarEvent[];
  calendarUnavailable?: boolean;
  pendingItems?: string[];
  suggestion?: string;
}): DigestData {
  // Hard-stop check — send pre-written notice, no model call
  if (isHardStopped()) {
    const quietInput: DigestInput = {
      date: todayDateString(),
      yesterdayActivity: [],
      pendingItems: [],
      calendarEvents: [],
      tokenYesterdayUSD: 0,
      tokenMonthToDateUSD: 0,
      monthlyBudgetUSD: getBudgetMonthlyUSD(),
      isQuiet: true,
      calendarUnavailable: false,
    };
    return {
      input: quietInput,
      prompt: BUDGET_PAUSED_MESSAGE,
      isBudgetPaused: true,
    };
  }

  // Read yesterday's audit log entries
  const yesterday = yesterdayDateString();
  const auditEntries = loadAuditEntriesForDate(yesterday);
  const yesterdayActivity = aggregateActivity(auditEntries);

  // Token data
  // getDailyHistory(2) → [yesterday, today]; take index 0 for yesterday
  const dailyHistory = getDailyHistory(2);
  const tokenYesterdayUSD = dailyHistory[0]?.estimatedCostUSD ?? 0;
  const { estimatedCostUSD: tokenMonthToDateUSD } = getMonthTokens();
  const monthlyBudgetUSD = getBudgetMonthlyUSD();

  const input: DigestInput = {
    date: todayDateString(),
    yesterdayActivity,
    pendingItems: options?.pendingItems ?? [],
    calendarEvents: options?.calendarEvents ?? [],
    tokenYesterdayUSD,
    tokenMonthToDateUSD,
    monthlyBudgetUSD,
    suggestion: options?.suggestion,
    isQuiet: yesterdayActivity.length === 0,
    calendarUnavailable: options?.calendarUnavailable ?? false,
  };

  return {
    input,
    prompt: buildPrompt(input),
    isBudgetPaused: false,
  };
}
