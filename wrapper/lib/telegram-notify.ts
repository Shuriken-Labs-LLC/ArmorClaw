/**
 * Telegram approval notification — fire-and-forget UX nudge.
 *
 * Sends a single plain-text message to the configured Telegram account when
 * the approval gate (`wrapper/security/permissions.ts`) suspends a tool call.
 * Without it, a user chatting via Telegram sees silence for up to 5 minutes
 * while the gate is open.
 *
 * NOT a security gate. Failure must never affect the approval flow itself.
 * Returns void, never throws, silently no-ops when:
 *   - TELEGRAM_BOT_TOKEN is not configured
 *   - No defaultTo (chat_id) can be resolved from openclaw.json
 *   - The Bot API call fails for any reason
 *
 * All I/O is injectable via {@link TelegramNotifyDeps} for tests.
 *
 * Hard rules: no imports from `wrapper/dashboard/` or `wrapper/security/`,
 * no logger import (avoids any circular-dependency risk on the security path).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface TelegramNotifyDeps {
  /** Read a key from the .env file. Defaults to reading ARMORCLAW_REPO_ROOT-relative .env. */
  readEnvKey?: (key: string) => string | undefined;
  /** Read openclaw.json. Defaults to reading ~/.openclaw/openclaw.json. */
  readOpenclaw?: () => unknown;
  /** fetch implementation. Defaults to global fetch. */
  fetchFn?: typeof fetch;
}

/**
 * Send a plain-text approval notification to the configured Telegram account.
 * Fire-and-forget: returns void, never throws.
 */
export async function sendTelegramApprovalNotification(
  toolName: string,
  toolParams: Record<string, unknown>,
  deps?: TelegramNotifyDeps,
): Promise<void> {
  try {
    const readEnvKey = deps?.readEnvKey ?? defaultReadEnvKey;
    const readOpenclaw = deps?.readOpenclaw ?? defaultReadOpenclaw;
    const fetchFn = deps?.fetchFn ?? fetch;

    const token = readEnvKey("TELEGRAM_BOT_TOKEN");
    if (!token) {
      return;
    }

    let openclaw: unknown;
    try {
      openclaw = readOpenclaw();
    } catch {
      return;
    }

    const chatId = resolveChatId(openclaw);
    if (chatId === undefined) {
      return;
    }

    const text = buildMessage(toolName, toolParams);

    try {
      await fetchFn(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          disable_notification: false,
        }),
        signal: AbortSignal.timeout(8_000),
      });
    } catch {
      /* network / abort / non-2xx — silent no-op */
    }
  } catch {
    /* defensive outer guard — module contract is "never throws" */
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildMessage(toolName: string, toolParams: Record<string, unknown>): string {
  const hasParams = Object.keys(toolParams).length > 0;
  const lines = ["⚠️ ArmorClaw needs your approval", "", `Tool: ${toolName}`];
  if (hasParams) {
    lines.push(`Params: ${JSON.stringify(toolParams, null, 2)}`);
  }
  lines.push(
    "",
    "Open the ArmorClaw dashboard on your Mac to approve or reject:",
    "http://localhost:7390",
    "",
    "This request will auto-reject in 5 minutes.",
  );
  return lines.join("\n");
}

/**
 * Walk openclaw.json looking for a Telegram chat_id.
 *   1. channels.telegram.defaultTo (flat config — string or number)
 *   2. channels.telegram.accounts.<firstKey-with-defaultTo>.defaultTo
 *      (multi-account — first account that has a defaultTo wins)
 * Returns undefined if neither shape produces one.
 */
function resolveChatId(openclaw: unknown): string | number | undefined {
  if (!isRecord(openclaw)) {
    return undefined;
  }
  const channels = openclaw["channels"];
  if (!isRecord(channels)) {
    return undefined;
  }
  const telegram = channels["telegram"];
  if (!isRecord(telegram)) {
    return undefined;
  }

  const flat = telegram["defaultTo"];
  if (typeof flat === "string" && flat.trim().length > 0) {
    return flat.trim();
  }
  if (typeof flat === "number") {
    return flat;
  }

  const accounts = telegram["accounts"];
  if (isRecord(accounts)) {
    for (const acct of Object.values(accounts)) {
      if (!isRecord(acct)) {
        continue;
      }
      const acctDefaultTo = acct["defaultTo"];
      if (typeof acctDefaultTo === "string" && acctDefaultTo.trim().length > 0) {
        return acctDefaultTo.trim();
      }
      if (typeof acctDefaultTo === "number") {
        return acctDefaultTo;
      }
    }
  }

  return undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function defaultReadEnvKey(key: string): string | undefined {
  try {
    const root = process.env["ARMORCLAW_REPO_ROOT"] ?? join(import.meta.dirname, "..", "..");
    const raw = readFileSync(join(root, ".env"), "utf-8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      const eq = trimmed.indexOf("=");
      if (eq === -1) {
        continue;
      }
      const k = trimmed.slice(0, eq).trim();
      if (k !== key) {
        continue;
      }
      return trimmed
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
    }
  } catch {
    /* .env missing or unreadable — silent no-op */
  }
  return undefined;
}

/* v8 ignore next 4 — stdlib glue (homedir + JSON.parse(readFileSync)); covered indirectly via deps injection in tests */
function defaultReadOpenclaw(): unknown {
  const path = join(homedir(), ".openclaw", "openclaw.json");
  return JSON.parse(readFileSync(path, "utf-8"));
}
