import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// ── Types ────────────────────────────────────────────────────────────────────

export type AuditOutcome = "success" | "rejected" | "error" | "undone";

export type AuditEntry = {
  timestamp: string; // ISO 8601
  skill: string; // tool name (or agentId when available)
  permissionsUsed: string[];
  inputSummary: string; // first 80 chars, secrets redacted
  outcome: AuditOutcome;
  durationMs: number;
};

// ── Path helpers ──────────────────────────────────────────────────────────────

// Lazy — defer homedir() call so tests can isolate HOME
function auditDir(): string {
  return join(homedir(), ".armorclaw");
}
function auditLogPath(): string {
  return join(auditDir(), "audit.log");
}

// ── In-memory buffer (fallback when file I/O fails) ──────────────────────────

// Module-level so we can accumulate across calls within a process lifetime
const memoryBuffer: AuditEntry[] = [];

/** Clear the in-memory buffer. Intended for test isolation only. */
export function clearMemoryBufferForTesting(): void {
  memoryBuffer.length = 0;
}

/** Read-only snapshot of the in-memory buffer. Intended for tests. */
export function getMemoryBuffer(): ReadonlyArray<AuditEntry> {
  return memoryBuffer;
}

// ── Secret scrubbing ──────────────────────────────────────────────────────────

// Key names that suggest sensitive values
const SECRET_KEY = /password|token|secret|key|auth|credential/i;

/**
 * Serialize tool params to a short summary string.
 * Redacts values whose key names match common secret patterns.
 * Truncates to 80 characters.
 */
export function buildInputSummary(params: Record<string, unknown>): string {
  const scrubbed: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    scrubbed[k] = SECRET_KEY.test(k) ? "[REDACTED]" : v;
  }
  return JSON.stringify(scrubbed).slice(0, 80);
}

// ── File write ────────────────────────────────────────────────────────────────

/**
 * Append an NDJSON entry to the audit log.
 * On any I/O error, silently pushes to the in-memory buffer instead.
 * Never throws.
 */
export function writeAuditEntry(entry: AuditEntry): void {
  try {
    mkdirSync(auditDir(), { recursive: true });
    appendFileSync(auditLogPath(), JSON.stringify(entry) + "\n", "utf-8");
  } catch {
    // I/O failure — buffer for later export via exportAuditLog()
    memoryBuffer.push(entry);
  }
}

// ── CSV export ────────────────────────────────────────────────────────────────

const CSV_HEADER = "timestamp,skill,permissionsUsed,inputSummary,outcome,durationMs";

/** Escape a CSV field value (quote and double any internal quotes). */
function csvField(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function entryToCsvRow(e: AuditEntry): string {
  return [
    e.timestamp,
    e.skill,
    (e.permissionsUsed ?? []).join("|"),
    csvField(e.inputSummary ?? ""),
    e.outcome,
    String(e.durationMs ?? 0),
  ].join(",");
}

/**
 * Produce a CSV representation of all audit log entries.
 *
 * Reads from the NDJSON log file when possible; falls back to the in-memory
 * buffer when the file is absent or unreadable. Skips malformed NDJSON lines.
 */
export function exportAuditLog(): string {
  const entries: AuditEntry[] = [];

  try {
    const content = readFileSync(auditLogPath(), "utf-8");
    for (const line of content.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      try {
        entries.push(JSON.parse(line) as AuditEntry);
      } catch {
        // Skip malformed lines silently
      }
    }
  } catch {
    // File unavailable — export from in-memory buffer
    entries.push(...memoryBuffer);
  }

  const rows = entries.map(entryToCsvRow).join("\n");
  return rows.length > 0 ? `${CSV_HEADER}\n${rows}` : CSV_HEADER;
}

// ── Hook registration ─────────────────────────────────────────────────────────

/**
 * Register the audit logger on the after_tool_call hook.
 * Fires for every tool execution that completes (whether successfully or with an error).
 * Never throws — all I/O is wrapped.
 */
export function registerAuditLogger(api: OpenClawPluginApi): void {
  api.on("after_tool_call", (event, ctx) => {
    const outcome: AuditOutcome = event.error ? "error" : "success";
    const entry: AuditEntry = {
      timestamp: new Date().toISOString(),
      // Prefer agentId from context; fall back to tool name as the skill identifier
      skill: ctx.agentId ?? event.toolName,
      permissionsUsed: [],
      inputSummary: buildInputSummary(event.params),
      outcome,
      durationMs: event.durationMs ?? 0,
    };
    writeAuditEntry(entry);
  });
}

// ── Plugin definition ────────────────────────────────────────────────────────

export default {
  id: "armorclaw-audit-logger",
  name: "ArmorClaw Audit Logger",
  description: "Records tool call outcomes to ~/.armorclaw/audit.log in NDJSON; exports to CSV",
  register(api: OpenClawPluginApi): void {
    registerAuditLogger(api);
  },
};
