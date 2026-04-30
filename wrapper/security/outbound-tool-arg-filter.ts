/**
 * Outbound tool-arg filter — `before_tool_call` hook.
 *
 * Screens arguments the agent is about to pass TO a tool. Catches:
 *   - Instruction-override patterns in tool args (prompt hijacking via
 *     malicious outbound payload)
 *   - Agent-paused enforcement (blocks all tool calls while paused)
 *
 * This is one of two filters in the ArmorClaw security pipeline:
 *
 *   1. Outbound (this file): `before_tool_call` — inspects what the
 *      model wants to SEND to a tool. Runs first, before the permission
 *      check and the browser allowlist filter.
 *
 *   2. Inbound (`wrapper/security/inbound-content-classifier.ts`):
 *      `before_prompt_build` — classifies content the model has READ
 *      from prior tool results before it's assembled into the next
 *      prompt turn.
 *
 * Do NOT subscribe this file to `before_prompt_build`. That hook is the
 * inbound classifier's domain.
 *
 * Non-negotiable gate (CLAUDE.md): run `npm run test:security` before
 * committing any changes to this file. Cannot be bypassed, disabled,
 * or given exceptions. Hard stop.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { getAgentStatus } from "../lib/agent-status.ts";

// Lazy path helpers — defer homedir() so tests can isolate HOME
function auditDir(): string {
  return join(homedir(), ".armorclaw");
}
function auditLogPath(): string {
  return join(auditDir(), "audit.log");
}

// ── Types ────────────────────────────────────────────────────────────────────

export type InjectionCategory =
  | "instruction_override"
  | "role_jailbreak"
  | "encoded_payload"
  | "multi_turn";

export type InjectionRejection = {
  category: InjectionCategory;
  /** First 120 chars of the offending (possibly decoded) string. */
  offendingInput: string;
};

// ── Pattern registry ─────────────────────────────────────────────────────────

type PatternEntry = {
  pattern: RegExp;
  /** Category to assign when this pattern matches on the raw (non-encoded) value. */
  category: Exclude<InjectionCategory, "encoded_payload">;
};

export const INJECTION_PATTERNS: ReadonlyArray<PatternEntry> = [
  // Instruction override — direct rewrites of the system context
  {
    pattern: /ignore\s+(previous|prior|all|your)\s+instructions?/i,
    category: "instruction_override",
  },
  {
    pattern: /disregard\s+(your|all|previous|prior)\s+/i,
    category: "instruction_override",
  },
  { pattern: /new\s+system\s+prompt/i, category: "instruction_override" },
  {
    pattern: /your\s+instructions?\s+(have\s+been\s+)?(updated|changed|replaced|overridden)/i,
    category: "instruction_override",
  },
  {
    pattern: /override\s+your\s+(instructions?|guidelines?|rules?|behavior|training)/i,
    category: "instruction_override",
  },
  {
    pattern: /forget\s+(your|all|previous|prior)\s+(instructions?|guidelines?|rules?|training)/i,
    category: "instruction_override",
  },
  {
    pattern: /bypass\s+your\s+(guidelines?|restrictions?|rules?|filters?|safety)/i,
    category: "instruction_override",
  },

  // Role reassignment / jailbreak — identity substitution patterns
  {
    pattern: /you\s+are\s+now\s+(?:a|an|the)\b/i,
    category: "role_jailbreak",
  },
  { pattern: /pretend\s+you\s+are\b/i, category: "role_jailbreak" },
  {
    pattern: /from\s+now\s+on\s+(?:you\s+are|act|behave)/i,
    category: "role_jailbreak",
  },
  {
    pattern: /your\s+new\s+(?:role|identity|instructions?|persona)\s+(?:are?|is)\b/i,
    category: "role_jailbreak",
  },
  {
    pattern: /roleplay\s+as\s+(?:a|an|the)\b/i,
    category: "role_jailbreak",
  },
  {
    pattern: /act\s+as\s+if\s+you\s+have\s+no\s+restrictions?/i,
    category: "role_jailbreak",
  },
  {
    pattern: /you\s+have\s+no\s+(?:rules?|restrictions?|guidelines?|limits?|ethics?)\b/i,
    category: "role_jailbreak",
  },
  // Well-known jailbreak keywords
  { pattern: /\bDAN\b/, category: "role_jailbreak" },
  { pattern: /\bjailbreak\b/i, category: "role_jailbreak" },
  { pattern: /\bdeveloper\s+mode\b/i, category: "role_jailbreak" },
  { pattern: /\bgod\s+mode\b/i, category: "role_jailbreak" },
  { pattern: /\bunrestricted\s+mode\b/i, category: "role_jailbreak" },

  // Multi-turn injection — chaining across tool calls or sessions
  {
    pattern: /remember\s+(?:this|the\s+following)\s+for\s+(?:all\s+)?future/i,
    category: "multi_turn",
  },
  {
    pattern: /for\s+(?:all\s+)?future\s+(?:tool\s+calls?|requests?|messages?|interactions?)/i,
    category: "multi_turn",
  },
  {
    pattern: /my\s+previous\s+instruction\s+was/i,
    category: "multi_turn",
  },
  {
    pattern: /as\s+(?:i\s+)?(?:told|instructed|said)\s+(?:you\s+)?(?:earlier|before|previously)/i,
    category: "multi_turn",
  },
  {
    pattern: /continuing\s+from\s+(?:the\s+)?previous\s+(?:turn|message|context)/i,
    category: "multi_turn",
  },
];

// ── Decoder ──────────────────────────────────────────────────────────────────

/**
 * Returns the original string plus any successfully decoded variants.
 * Handles URL-encoding, raw percent-sequences, whole-string base64 blobs,
 * and inline base64 data-URI segments. Never throws.
 */
export function decodeVariants(value: string): string[] {
  const results: string[] = [value];

  // Standard URL decoding (decodeURIComponent throws on invalid sequences)
  try {
    const decoded = decodeURIComponent(value);
    if (decoded !== value) {
      results.push(decoded);
    }
  } catch {
    // Invalid percent-encoding — fall through to raw decode below
  }

  // Raw percent-sequence decode (handles malformed/partial encoding)
  const rawPct = value.replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
  if (rawPct !== value && !results.includes(rawPct)) {
    results.push(rawPct);
  }

  // Whole-string base64 blob — require ≥ 20 chars to avoid false positives
  const trimmed = value.trim();
  if (/^[A-Za-z0-9+/]{20,}={0,2}$/.test(trimmed)) {
    const decoded = Buffer.from(trimmed, "base64").toString("utf-8");
    // Only include if the result contains printable ASCII (filters random binary)
    if (/[\x20-\x7e]/.test(decoded)) {
      results.push(decoded);
    }
  }

  // Inline base64 segment (e.g., data URIs or explicit base64 annotation)
  const inlineMatch = value.match(/base64,([A-Za-z0-9+/]+=*)/);
  if (inlineMatch) {
    const decoded = Buffer.from(inlineMatch[1], "base64").toString("utf-8");
    results.push(decoded);
  }

  return results;
}

// ── String extractor ─────────────────────────────────────────────────────────

/** Recursively extract all string leaf values from an unknown structure. */
export function extractStrings(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(extractStrings);
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap(extractStrings);
  }
  return [];
}

// ── Audit write ──────────────────────────────────────────────────────────────

/** Write a rejection entry to the audit log. Silent on any I/O error. */
export function writeRejectionAuditEntry(
  toolName: string,
  category: InjectionCategory,
  offendingInput: string,
): void {
  try {
    mkdirSync(auditDir(), { recursive: true });
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "injection_rejected",
      tool: toolName,
      category,
      input: offendingInput.slice(0, 120),
    });
    appendFileSync(auditLogPath(), entry + "\n", "utf-8");
  } catch {
    // Never throw — audit write failures are intentionally silent
  }
}

// ── Core check ───────────────────────────────────────────────────────────────

/**
 * Inspects all string values in event.params for injection patterns.
 * Tests both raw values and decoded variants (URL/base64).
 * Returns a rejection descriptor, or null if the input is clean.
 *
 * Does NOT write to the audit log — callers must handle that.
 */
export function checkForInjection(event: {
  toolName: string;
  params: Record<string, unknown>;
}): InjectionRejection | null {
  const strings = extractStrings(event.params);
  for (const str of strings) {
    const variants = decodeVariants(str);
    for (let variantIdx = 0; variantIdx < variants.length; variantIdx++) {
      const variant = variants[variantIdx];
      for (const { pattern, category } of INJECTION_PATTERNS) {
        if (pattern.test(variant)) {
          // variantIdx > 0 means the match was on a decoded form
          const wasEncoded = variantIdx > 0;
          return {
            category: wasEncoded ? "encoded_payload" : category,
            offendingInput: variant.slice(0, 120),
          };
        }
      }
    }
  }
  return null;
}

// ── Pause audit write ─────────────────────────────────────────────────────────

/** Write an agent-paused block entry to the audit log. Silent on any I/O error. */
export function writePauseAuditEntry(toolName: string): void {
  try {
    mkdirSync(auditDir(), { recursive: true });
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "agent_paused",
      tool: toolName,
      outcome: "rejected",
    });
    appendFileSync(auditLogPath(), entry + "\n", "utf-8");
  } catch {
    // Never throw — audit write failures are intentionally silent
  }
}

// ── Hook registration ────────────────────────────────────────────────────────

/**
 * Register the outbound tool-arg filter on the before_tool_call hook.
 *
 * Gate order (checked in sequence, first match wins):
 *   1. Agent paused — blocks all tool calls instantly, user must resume from dashboard
 *   2. Injection scan — blocks instruction-override / jailbreak / encoded payloads
 *
 * The handler returns synchronously — resolution happens before the tool fires.
 */
export function registerOutboundToolArgFilter(api: OpenClawPluginApi): void {
  api.on("before_tool_call", (event, _ctx) => {
    // ── Gate 1: agent paused ─────────────────────────────────────────────────
    if (getAgentStatus() === "paused") {
      writePauseAuditEntry(event.toolName);
      return {
        block: true,
        blockReason: "Agent is paused — resume from the ArmorClaw dashboard to continue.",
      };
    }

    // ── Gate 2: injection scan ───────────────────────────────────────────────
    const rejection = checkForInjection(event);
    if (!rejection) {
      return undefined;
    }

    writeRejectionAuditEntry(event.toolName, rejection.category, rejection.offendingInput);
    return {
      block: true,
      blockReason: `ArmorClaw: ${rejection.category} injection pattern detected`,
    };
  });
}

// ── Plugin definition ────────────────────────────────────────────────────────

export default {
  id: "armorclaw-outbound-tool-arg-filter",
  name: "ArmorClaw Outbound Tool-Arg Filter",
  description: "Blocks prompt injection and jailbreak attempts before tool execution",
  register(api: OpenClawPluginApi): void {
    registerOutboundToolArgFilter(api);
  },
};
