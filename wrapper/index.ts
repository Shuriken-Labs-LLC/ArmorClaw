import { emptyPluginConfigSchema, type OpenClawPluginApi } from "openclaw/plugin-sdk";
import { validateGatewayHost } from "./config/gateway.ts";
import { sendTelegramApprovalNotification } from "./lib/telegram-notify.ts";
import { initRecipeScheduler } from "./recipes/index.ts";
import { registerAuditLogger } from "./security/audit-logger.ts";
import { registerBrowserAllowlistFilter } from "./security/browser-allowlist-filter.ts";
import { registerInboundContentClassifier } from "./security/inbound-content-classifier.ts";
import { registerOutboundToolArgFilter } from "./security/outbound-tool-arg-filter.ts";
import {
  loadPermissionManifest,
  registerPermissionFilter,
  setApprovalNotifier,
} from "./security/permissions.ts";
import { registerSourceTagger } from "./security/source-tagger.ts";

// ── ArmorClaw plugin entry point ──────────────────────────────────────────────
//
// Registered via plugins.load.paths in openclaw.json (see loading instructions
// at the bottom of this file). OpenClaw's plugin loader discovers this default
// export and calls register(api) at daemon startup.

const armorClawPlugin = {
  id: "wrapper",
  name: "ArmorClaw",
  description:
    "Hardened security layer: injection filter, permission engine, and audit logger for every tool call.",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi): void {
    // Gateway host validation — reject public IPs (security gate from CLAUDE.md).
    // Token management is NOT done here — the gateway owns its token entirely.
    // ArmorClaw reads it back from openclaw.json after the gateway is reachable.
    validateGatewayHost();

    // Core agent manifest — covers all standard OpenClaw tools the agent uses
    // directly (not via ArmorClaw skills). Loaded first so the registry is
    // non-empty before skill manifests register; any tool NOT listed here AND
    // not listed in a skill manifest will be queued for dashboard approval.
    loadPermissionManifest({
      skillId: "core-agent",
      allowedTools: [
        // File system
        "read",
        "write",
        "edit",
        // Runtime
        "exec",
        "process",
        // Web
        "web_search",
        "web_fetch",
        "browser",
        // Memory
        "memory_search",
        "memory_get",
        // Sessions / agents
        "sessions_list",
        "sessions_history",
        "sessions_send",
        "sessions_spawn",
        "sessions_yield",
        "subagents",
        "session_status",
        "agents_list",
        // Messaging & media
        "message",
        "tts",
        "image",
        "pdf",
        "canvas",
      ],
      allowedPermissions: ["network:outbound", "files:local", "browser:sandboxed"],
    });
    // Security filter stack — order is load-bearing:
    //   1. Outbound tool-arg filter: blocks malicious args + enforces pause.
    //   2. Permission engine: validates declared permissions.
    //   3. Browser allowlist filter: gates browser navigation (Phase 2f).
    //   4. Audit logger: observes outcomes of all the above.
    //   Inbound classifier (before_prompt_build) runs independently on a
    //   different hook — not part of this before_tool_call chain.
    registerOutboundToolArgFilter(api);
    registerPermissionFilter(api);
    // Fire-and-forget Telegram notification when the approval gate suspends a
    // tool call — bridges the silence gap for users chatting via Telegram.
    setApprovalNotifier((toolName, toolParams) => {
      void sendTelegramApprovalNotification(toolName, toolParams);
    });
    registerBrowserAllowlistFilter(api);
    registerAuditLogger(api);
    // Source-tagger fires on tool_result_persist (different hook from the
    // before/after_tool_call trio above) — registration order has no effect
    // on correctness, but grouping under Security architecture is intentional.
    registerSourceTagger(api);
    // Inbound content classifier fires on before_prompt_build (hard-mitigation
    // pair to the source-tagger's soft framing). Walks the messages array
    // each turn, scores any framed external content the source-tagger
    // produced, and prepends a system-context warning for high-risk blocks.
    registerInboundContentClassifier(api);
    // Start recipe scheduler after security hooks are in place
    initRecipeScheduler();
  },
};

export default armorClawPlugin;
