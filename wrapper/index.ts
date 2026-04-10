import { emptyPluginConfigSchema, type OpenClawPluginApi } from "openclaw/plugin-sdk";
import { registerTokenRotation, validateGatewayConfig } from "./config/gateway.ts";
import { initRecipeScheduler } from "./recipes/index.ts";
import { registerAuditLogger } from "./security/audit-logger.ts";
import { registerInjectionFilter } from "./security/injection-filter.ts";
import { registerPermissionFilter } from "./security/permissions.ts";

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
    // Gateway validation first: platform check + host validation + token rotation.
    validateGatewayConfig();
    registerTokenRotation(api);
    // Order matters: injection check runs first, then permission check, then
    // the audit logger observes the final outcome after execution.
    registerInjectionFilter(api);
    registerPermissionFilter(api);
    registerAuditLogger(api);
    // Start recipe scheduler after security hooks are in place
    initRecipeScheduler();
  },
};

export default armorClawPlugin;
