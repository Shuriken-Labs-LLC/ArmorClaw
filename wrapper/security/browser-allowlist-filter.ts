/**
 * Browser allowlist filter — subscribes to before_tool_call.
 *
 * Hard-blocks browser-tool navigation calls (action: open / navigate) whose
 * URL-bearing params point outside the user-managed allowlist at
 * ~/.armorclaw/browser-allowlist.json.
 *
 * Gate order in wrapper/index.ts:
 *   1. Injection filter (rejects instruction-override patterns)
 *   2. Permission filter (validates declared permissions)
 *   3. Browser allowlist filter (gates browser navigation)  ← this module
 *   4. Audit logger (observes the final outcome)
 *
 * Non-browser tool calls and non-navigation browser actions (snapshot,
 * screenshot, tabs, etc.) pass through unchanged. The block message points
 * the user at dashboard Settings → Browser allowlist.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { writeAuditEntry } from "./audit-logger.ts";
import { extractHost, isDomainAllowed } from "./browser-allowlist.ts";

const URL_PARAM_KEYS = ["targetUrl", "url"] as const;

/**
 * Browser actions that can navigate to a URL. Confirmed against
 * src/agents/tools/browser-tool.ts: only `open` and `navigate` call
 * `readTargetUrlParam()`. Other actions (status, snapshot, screenshot,
 * tabs, focus, close, console, pdf, upload, dialog, act, …) do not
 * navigate, even when a URL field is present.
 */
const NAVIGATING_ACTIONS = new Set(["open", "navigate"]);

type BeforeToolCallEvent = {
  toolName?: unknown;
  params?: unknown;
};

function isStringRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function describeHost(url: string): string {
  return extractHost(url) ?? "unparseable URL";
}

export function registerBrowserAllowlistFilter(api: OpenClawPluginApi): void {
  api.on("before_tool_call", (event: unknown, _ctx: unknown) => {
    const evt = event as BeforeToolCallEvent;
    if (evt.toolName !== "browser") {
      return undefined;
    }
    if (!isStringRecord(evt.params)) {
      return undefined;
    }

    const action = readString(evt.params, "action");
    if (action === undefined || !NAVIGATING_ACTIONS.has(action)) {
      return undefined;
    }

    for (const key of URL_PARAM_KEYS) {
      const url = readString(evt.params, key);
      if (url === undefined || url === "") {
        continue;
      }
      if (isDomainAllowed(url)) {
        continue;
      }

      const host = describeHost(url);
      writeAuditEntry({
        timestamp: new Date().toISOString(),
        skill: "browser-allowlist",
        permissionsUsed: [],
        inputSummary: truncate(`Blocked browser navigation to ${host}`, 80),
        outcome: "rejected",
        durationMs: 0,
      });
      return {
        block: true,
        blockReason: `ArmorClaw: domain not allowlisted (${host}). Add the domain in dashboard Settings → Browser allowlist to allow.`,
      };
    }

    return undefined;
  });
}
