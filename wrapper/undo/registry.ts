import { writeAuditEntry } from "../security/audit-logger.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

export type UndoActionType = "email-draft" | "file-write" | "crm-write";

export interface UndoEntry {
  id: string; // uuid
  actionType: UndoActionType;
  skill: string;
  timestamp: string; // ISO 8601
  expiresAt: string; // timestamp + 60s
  snapshot: unknown; // serialised pre-action state
  undoFn: () => Promise<void>; // async function that restores state
}

export interface RegisterUndoOptions {
  id?: string; // override uuid for testing
  actionType: UndoActionType;
  skill: string;
  snapshot: unknown;
  undoFn: () => Promise<void>;
  /** Injectable clock for testing. Defaults to Date.now(). */
  nowMs?: () => number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const EXPIRY_MS = 60_000;

// ── Registry state ────────────────────────────────────────────────────────────

// At most one entry at a time. A new registration discards the previous.
let current: UndoEntry | null = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function generateId(): string {
  // Crypto-random UUID via Node built-in
  return crypto.randomUUID();
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Register an undoable action.
 *
 * Replaces any existing entry (single-slot design). The caller must have already
 * captured the snapshot synchronously before the action executed.
 *
 * Returns the registered entry (useful for inspecting id/expiresAt in tests).
 */
export function registerUndo(options: RegisterUndoOptions): UndoEntry {
  const nowMs = options.nowMs ?? (() => Date.now());
  const now = nowMs();
  const timestamp = new Date(now).toISOString();
  const expiresAt = new Date(now + EXPIRY_MS).toISOString();

  const entry: UndoEntry = {
    id: options.id ?? generateId(),
    actionType: options.actionType,
    skill: options.skill,
    timestamp,
    expiresAt,
    snapshot: options.snapshot,
    undoFn: options.undoFn,
  };

  current = entry;
  return entry;
}

/**
 * Returns the current undo entry if it exists and has not expired.
 * Returns null if no entry has been registered or the entry has expired.
 */
export function getCurrentUndo(nowMs?: () => number): UndoEntry | null {
  if (!current) {
    return null;
  }

  const now = nowMs ? nowMs() : Date.now();
  if (now >= new Date(current.expiresAt).getTime()) {
    // Expired — discard
    current = null;
    return null;
  }

  return current;
}

/**
 * Execute the current undo action.
 *
 * - Returns false if no entry exists or the entry has expired.
 * - Calls undoFn(), then clears the registry slot.
 * - Logs the execution to the audit log with outcome "undone".
 * - `undoFn` is expected to be idempotent — calling twice must not corrupt state.
 */
export async function executeUndo(nowMs?: () => number): Promise<boolean> {
  const entry = getCurrentUndo(nowMs);
  if (!entry) {
    return false;
  }

  const startMs = nowMs ? nowMs() : Date.now();

  await entry.undoFn();

  const durationMs = (nowMs ? nowMs() : Date.now()) - startMs;

  // Clear the slot immediately after execution (before logging) so a second
  // call within the same tick also returns false.
  current = null;

  writeAuditEntry({
    timestamp: new Date(startMs).toISOString(),
    skill: entry.skill,
    permissionsUsed: [],
    inputSummary: `undo:${entry.actionType}:${entry.id}`.slice(0, 80),
    outcome: "undone",
    durationMs,
  });

  return true;
}

/**
 * Clear registry state. Intended for test isolation only.
 */
export function clearUndoForTesting(): void {
  current = null;
}
