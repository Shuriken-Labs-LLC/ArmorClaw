import { emptyPluginConfigSchema, type OpenClawPluginApi } from "openclaw/plugin-sdk";
import { validateGatewayHost } from "./config/gateway.ts";
import { initRecipeScheduler } from "./recipes/index.ts";
import { registerAuditLogger } from "./security/audit-logger.ts";
import { registerInboundContentClassifier } from "./security/inbound-content-classifier.ts";
import { registerInjectionFilter } from "./security/injection-filter.ts";
import { registerPermissionFilter } from "./security/permissions.ts";
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
    // Order matters: injection check runs first, then permission check, then
    // the audit logger observes the final outcome after execution.
    registerInjectionFilter(api);
    registerPermissionFilter(api);
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
