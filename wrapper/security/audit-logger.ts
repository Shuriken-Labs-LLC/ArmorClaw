import { createHash, createHmac } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
// @ts-ignore — openclaw/plugin-sdk has no type declarations
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { getAuditKey, getAuditKeySync } from "./audit-key.ts";

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

/**
 * Tamper-evident audit entry. Phase 2d added seq/prevHash/hmac fields.
 *
 * - seq: monotonic sequence number, starting at 1.
 * - prevHash: SHA-256 of the previous entry's serialized line (the JSON-stringified
 *   SignedAuditEntry plus trailing newline-stripped). For seq=1, prevHash is "GENESIS".
 * - hmac: HMAC-SHA256 over JSON.stringify({...entry, seq, prevHash}). null when
 *   the keychain key is unavailable; audit-verify reports those as "unverified".
 */
export type SignedAuditEntry = AuditEntry & {
  seq: number;
  prevHash: string;
  hmac: string | null;
};

// ── Path helpers ──────────────────────────────────────────────────────────────

// Lazy — defer homedir() call so tests can isolate HOME
function auditDir(): string {
  return join(homedir(), ".armorclaw");
}
function auditLogPath(): string {
  return join(auditDir(), "audit.log");
}
function preHmacArchivePath(): string {
  return auditLogPath() + ".pre-hmac";
}

// ── Chain state (module-level) ───────────────────────────────────────────────

let lastSeq = 0;
let lastHash = "GENESIS";
let chainInitialized = false;
let migrationDone = false;

/** Reset chain state. Intended for test isolation only. */
export function resetChainStateForTesting(): void {
  lastSeq = 0;
  lastHash = "GENESIS";
  chainInitialized = false;
  migrationDone = false;
}

/**
 * Rotate a pre-HMAC audit.log to .pre-hmac on first HMAC-enabled run.
 * Detected by parsing the first line and checking for the absence of `seq`.
 * Failure is non-fatal — log and continue.
 */
function migratePreHmacLogIfNeeded(): void {
  if (migrationDone) {
    return;
  }
  migrationDone = true;
  try {
    if (!existsSync(auditLogPath())) {
      return;
    }
    const content = readFileSync(auditLogPath(), "utf-8");
    const firstLine = content.split("\n").find((l) => l.trim());
    if (!firstLine) {
      return;
    }
    let parsed: Partial<SignedAuditEntry>;
    try {
      parsed = JSON.parse(firstLine) as Partial<SignedAuditEntry>;
    } catch {
      return; // unreadable first line — leave alone
    }
    if (parsed.seq === undefined) {
      renameSync(auditLogPath(), preHmacArchivePath());
    }
  } catch {
    // Migration is best-effort — don't block the new chain from starting.
  }
}

/**
 * Read the existing audit.log to find the highest seq and compute its hash,
 * so we resume the chain across process restarts. Called once on first write.
 * On any failure, leaves lastSeq=0 / lastHash="GENESIS" (fresh chain).
 */
function initLastSeqAndHashIfNeeded(): void {
  if (chainInitialized) {
    return;
  }
  chainInitialized = true;
  try {
    if (!existsSync(auditLogPath())) {
      return;
    }
    const content = readFileSync(auditLogPath(), "utf-8");
    let lastValidLine: string | null = null;
    let lastValidSeq = 0;
    for (const line of content.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as Partial<SignedAuditEntry>;
        if (typeof parsed.seq === "number" && parsed.seq > lastValidSeq) {
          lastValidSeq = parsed.seq;
          lastValidLine = line;
        }
      } catch {
        // skip malformed line
      }
    }
    if (lastValidLine !== null) {
      lastSeq = lastValidSeq;
      lastHash = createHash("sha256").update(lastValidLine).digest("hex");
    }
  } catch {
    // Leave fresh-chain defaults.
  }
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
 * Append a tamper-evident NDJSON entry to the audit log.
 * On any I/O error, silently pushes to the in-memory buffer instead.
 * Never throws.
 */
export function writeAuditEntry(entry: AuditEntry): void {
  try {
    migratePreHmacLogIfNeeded();
    initLastSeqAndHashIfNeeded();

    const seq = lastSeq + 1;
    const prevHash = lastHash;
    const key = getAuditKeySync();

    const contentForHmac = JSON.stringify({ ...entry, seq, prevHash });
    const hmac = key ? createHmac("sha256", key).update(contentForHmac).digest("hex") : null;

    const signed: SignedAuditEntry = { ...entry, seq, prevHash, hmac };
    const line = JSON.stringify(signed);

    mkdirSync(auditDir(), { recursive: true });
    appendFileSync(auditLogPath(), line + "\n", "utf-8");

    lastSeq = seq;
    lastHash = createHash("sha256").update(line).digest("hex");
  } catch {
    // I/O failure — buffer for later export via exportAuditLog()
    memoryBuffer.push(entry);
  }
}

// ── CSV export ────────────────────────────────────────────────────────────────

const CSV_HEADER =
  "timestamp,skill,permissionsUsed,inputSummary,outcome,durationMs,seq,prevHash,hmac";

/** Escape a CSV field value (quote and double any internal quotes). */
function csvField(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function entryToCsvRow(e: AuditEntry | SignedAuditEntry): string {
  const signed = e as Partial<SignedAuditEntry>;
  return [
    e.timestamp,
    e.skill,
    (e.permissionsUsed ?? []).join("|"),
    csvField(e.inputSummary ?? ""),
    e.outcome,
    String(e.durationMs ?? 0),
    signed.seq !== undefined ? String(signed.seq) : "",
    signed.prevHash ?? "",
    signed.hmac ?? "",
  ].join(",");
}

/**
 * Produce a CSV representation of all audit log entries.
 *
 * Reads from the NDJSON log file when possible; falls back to the in-memory
 * buffer when the file is absent or unreadable. Skips malformed NDJSON lines.
 * Pre-HMAC entries (lacking seq/prevHash/hmac) get empty values for those columns.
 */
export function exportAuditLog(): string {
  const entries: (AuditEntry | SignedAuditEntry)[] = [];

  try {
    const content = readFileSync(auditLogPath(), "utf-8");
    for (const line of content.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      try {
        entries.push(JSON.parse(line) as SignedAuditEntry);
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
 *
 * Warms the keychain HMAC key cache so subsequent writes can sign synchronously.
 * Race window: the first few entries written before the key resolves get
 * hmac: null (audit-verify reports them as "unverified", chain still intact).
 */
export function registerAuditLogger(api: OpenClawPluginApi): void {
  // Fire-and-forget warm-up; getAuditKey never throws.
  void getAuditKey();

  api.on("after_tool_call", (event: unknown, ctx: unknown) => {
    const evt = event as {
      error?: unknown;
      toolName: string;
      params?: unknown;
      durationMs?: number;
    };
    const context = ctx as { agentId?: string };
    const outcome: AuditOutcome = evt.error ? "error" : "success";
    const entry: AuditEntry = {
      timestamp: new Date().toISOString(),
      // Prefer agentId from context; fall back to tool name as the skill identifier
      skill: context.agentId ?? evt.toolName,
      permissionsUsed: [],
      inputSummary: buildInputSummary(evt.params as Record<string, unknown>),
      outcome,
      durationMs: evt.durationMs ?? 0,
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
