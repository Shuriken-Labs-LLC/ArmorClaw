import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Provider } from "./pricing.ts";

// ── Path helpers ──────────────────────────────────────────────────────────────

function dataDir(): string {
  return join(homedir(), ".armorclaw");
}
function tokenLogPath(): string {
  return join(dataDir(), "tokens.ndjson");
}

// ── Types ────────────────────────────────────────────────────────────────────

export type { Provider };

/** A single model API call's token usage and cost, appended to tokens.ndjson. */
export interface TokenEvent {
  timestamp: string; // ISO 8601
  provider: Provider;
  model: string; // e.g. "claude-sonnet-4-6", "gpt-4o"
  skill: string; // skill name, "wizard", or "dashboard"
  inputTokens: number;
  outputTokens: number;
  estimatedCostUSD: number; // 0 for unknown-price models and Ollama
}

/** Aggregated token and cost totals for a time window. */
export interface TokenSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCostUSD: number;
}

/** Daily aggregated totals, used by getDailyHistory(). */
export interface DailyTotal {
  date: string; // "YYYY-MM-DD"
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCostUSD: number;
}

/** Current budget standing, consumed by the dashboard. */
export interface BudgetStatus {
  monthlyBudgetUSD: number;
  spentThisMonthUSD: number;
  percentUsed: number; // 0–100+; can exceed 100 if budget has been hit
  isHardStopped: boolean;
}

export type BudgetAlertLevel = "80%" | "100%";
export type BudgetAlertHandler = (
  level: BudgetAlertLevel,
  message: string,
  budgetUSD: number,
) => void;

// ── Module state ──────────────────────────────────────────────────────────────

// Budget is in-memory with a default of $20. The settings layer (not yet built)
// calls setBudgetMonthlyUSD() at startup to restore any user-configured value.
let monthlyBudgetUSD = 20;

// Hard-stop flag — set true when spend reaches 100% of budget.
// Cleared only by explicit resumeFromHardStop() call.
let hardStoppedFlag = false;

// Deduplication: track which month+threshold combinations have already fired.
// Key format: "YYYY-MM-80" or "YYYY-MM-100". Prevents repeated alerts per event.
const firedAlerts = new Set<string>();

// Optional callback registered by the dashboard/notification layer.
let budgetAlertHandler: BudgetAlertHandler | null = null;

// ── NDJSON helpers ────────────────────────────────────────────────────────────

/**
 * Load all token events from the NDJSON store.
 * Returns an empty array if the file is absent or unreadable.
 * Silently skips malformed lines.
 */
function loadEvents(): TokenEvent[] {
  let raw: string;
  try {
    raw = readFileSync(tokenLogPath(), "utf-8");
  } catch {
    return [];
  }
  const events: TokenEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      events.push(JSON.parse(line) as TokenEvent);
    } catch {
      // Skip malformed lines silently
    }
  }
  return events;
}

/** ISO date string for "today" in the local timezone: "YYYY-MM-DD". */
function todayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Current month prefix: "YYYY-MM". */
function currentMonthPrefix(): string {
  return new Date().toISOString().slice(0, 7);
}

// ── Write ────────────────────────────────────────────────────────────────────

/**
 * Record a token event to the NDJSON store.
 *
 * Fire-and-forget: this function is async but callers must NOT await it on the
 * critical path. It returns a Promise so callers can await in tests.
 *
 * On any I/O error, logs to stderr and continues — never surfaces a token
 * tracking error to the skill response.
 */
export async function recordTokenEvent(event: TokenEvent): Promise<void> {
  try {
    mkdirSync(dataDir(), { recursive: true });
    appendFileSync(tokenLogPath(), JSON.stringify(event) + "\n", "utf-8");
  } catch (err) {
    // Token tracking must never crash or block the skill
    process.stderr.write(`[ArmorClaw token-tracker] write failed: ${String(err)}\n`);
  }

  // Budget check runs even if the write failed (we still spent tokens)
  checkBudgetAlerts();
}

// ── Budget alert logic ────────────────────────────────────────────────────────
//
// Called after every token write. Fires each threshold at most once per
// calendar month (tracked by firedAlerts Set with month-scoped keys).

function checkBudgetAlerts(): void {
  const status = getBudgetStatus();
  const monthKey = currentMonthPrefix();

  if (status.percentUsed >= 100) {
    const key100 = `${monthKey}-100`;
    if (!firedAlerts.has(key100)) {
      firedAlerts.add(key100);
      hardStoppedFlag = true;
      const msg =
        `You've reached your $${status.monthlyBudgetUSD} monthly budget. ` +
        `ArmorClaw has paused to avoid charges. Go to your dashboard to adjust ` +
        `your budget or resume.`;
      budgetAlertHandler?.("100%", msg, status.monthlyBudgetUSD);
    }
    // 100% implies ≥80%; skip the 80% check once we've hit 100%
    return;
  }

  if (status.percentUsed >= 80) {
    const key80 = `${monthKey}-80`;
    if (!firedAlerts.has(key80)) {
      firedAlerts.add(key80);
      const msg = `Heads up — you've used 80% of your $${status.monthlyBudgetUSD} monthly AI budget.`;
      budgetAlertHandler?.("80%", msg, status.monthlyBudgetUSD);
    }
  }
}

// ── Aggregation functions ────────────────────────────────────────────────────

const EMPTY_SUMMARY: TokenSummary = {
  totalInputTokens: 0,
  totalOutputTokens: 0,
  estimatedCostUSD: 0,
};

function sumEvents(events: TokenEvent[]): TokenSummary {
  return events.reduce<TokenSummary>(
    (acc, e) => ({
      totalInputTokens: acc.totalInputTokens + e.inputTokens,
      totalOutputTokens: acc.totalOutputTokens + e.outputTokens,
      estimatedCostUSD: acc.estimatedCostUSD + e.estimatedCostUSD,
    }),
    { ...EMPTY_SUMMARY },
  );
}

/** Token totals and cost for the current calendar day. */
export function getTodayTokens(): TokenSummary {
  const today = todayDateString();
  return sumEvents(loadEvents().filter((e) => e.timestamp.startsWith(today)));
}

/** Token totals and cost for the current calendar month. */
export function getMonthTokens(): TokenSummary {
  const month = currentMonthPrefix();
  return sumEvents(loadEvents().filter((e) => e.timestamp.startsWith(month)));
}

/**
 * Cost breakdown by skill for the current month.
 * Returns a map of skillId → total estimated cost in USD.
 */
export function getMonthBySkill(): Record<string, number> {
  const month = currentMonthPrefix();
  const result: Record<string, number> = {};
  for (const e of loadEvents()) {
    if (!e.timestamp.startsWith(month)) {
      continue;
    }
    result[e.skill] = (result[e.skill] ?? 0) + e.estimatedCostUSD;
  }
  return result;
}

/**
 * Cost breakdown by provider for the current month.
 * Returns a map of provider → total estimated cost in USD.
 */
export function getMonthByProvider(): Record<string, number> {
  const month = currentMonthPrefix();
  const result: Record<string, number> = {};
  for (const e of loadEvents()) {
    if (!e.timestamp.startsWith(month)) {
      continue;
    }
    result[e.provider] = (result[e.provider] ?? 0) + e.estimatedCostUSD;
  }
  return result;
}

/**
 * Daily aggregated totals for the last `days` calendar days (capped at 90).
 * The array is ordered oldest → newest. Days with no events are included
 * as zero-value entries so the chart always has a continuous x-axis.
 */
export function getDailyHistory(days: number): DailyTotal[] {
  const cappedDays = Math.min(Math.max(days, 1), 90);
  const events = loadEvents();

  // Build date list from oldest to today
  const today = new Date();
  const dateList: string[] = [];
  for (let i = cappedDays - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    dateList.push(d.toISOString().slice(0, 10));
  }

  // Index events by date
  const byDate: Record<string, DailyTotal> = {};
  for (const e of events) {
    const date = e.timestamp.slice(0, 10);
    if (!dateList.includes(date)) {
      continue;
    }
    if (!byDate[date]) {
      byDate[date] = { date, totalInputTokens: 0, totalOutputTokens: 0, estimatedCostUSD: 0 };
    }
    byDate[date].totalInputTokens += e.inputTokens;
    byDate[date].totalOutputTokens += e.outputTokens;
    byDate[date].estimatedCostUSD += e.estimatedCostUSD;
  }

  return dateList.map(
    (date) =>
      byDate[date] ?? { date, totalInputTokens: 0, totalOutputTokens: 0, estimatedCostUSD: 0 },
  );
}

/**
 * Current budget standing: month spend vs. configured budget.
 * `percentUsed` can exceed 100 if the user is over budget.
 */
export function getBudgetStatus(): BudgetStatus {
  const { estimatedCostUSD } = getMonthTokens();
  return {
    monthlyBudgetUSD,
    spentThisMonthUSD: estimatedCostUSD,
    percentUsed:
      /* v8 ignore next */ monthlyBudgetUSD > 0 ? (estimatedCostUSD / monthlyBudgetUSD) * 100 : 0,
    isHardStopped: hardStoppedFlag,
  };
}

/**
 * The most recent `limit` token events, newest-first.
 * Returns [] if the store is empty or unavailable.
 */
export function getRecentEvents(limit = 50): TokenEvent[] {
  const events = loadEvents();
  return events.slice(-limit).toReversed();
}

// ── Budget configuration ──────────────────────────────────────────────────────

/** Returns the configured monthly budget in USD (default: $20). */
export function getBudgetMonthlyUSD(): number {
  return monthlyBudgetUSD;
}

/**
 * Set the monthly budget. Must be a positive number.
 * Resetting the budget does NOT automatically clear the hard stop —
 * the user must explicitly call `resumeFromHardStop()` to resume.
 */
export function setBudgetMonthlyUSD(amount: number): void {
  if (amount <= 0) {
    throw new RangeError(`Budget must be a positive number; got ${amount}`);
  }
  monthlyBudgetUSD = amount;
}

// ── Hard stop ─────────────────────────────────────────────────────────────────

/**
 * Returns `true` when the monthly budget has been fully consumed.
 * The model adapter must check this before making any API call.
 * This is a hard gate — not advisory.
 */
export function isHardStopped(): boolean {
  return hardStoppedFlag;
}

/**
 * Clear the hard stop, allowing model calls to resume.
 * Called from the dashboard after the user raises the budget or explicitly
 * acknowledges the overage and chooses to continue.
 */
export function resumeFromHardStop(): void {
  hardStoppedFlag = false;
}

// ── Alert registration ────────────────────────────────────────────────────────

/**
 * Register a handler that fires when budget thresholds are crossed.
 * Only one handler can be registered at a time; calling again replaces the previous one.
 * The handler receives the alert level ("80%" | "100%"), a human-readable message,
 * and the configured monthly budget in USD.
 */
export function onBudgetAlert(handler: BudgetAlertHandler): void {
  budgetAlertHandler = handler;
}

// ── Testing helpers ───────────────────────────────────────────────────────────

/**
 * Reset all module state to defaults.
 * Intended for test isolation only — do not call in production code.
 */
export function clearStoreForTesting(): void {
  monthlyBudgetUSD = 20;
  hardStoppedFlag = false;
  firedAlerts.clear();
  budgetAlertHandler = null;
}
