import { emptyPluginConfigSchema, type OpenClawPluginApi } from "openclaw/plugin-sdk";
import { registerAuditLogger } from "./security/audit-logger.ts";
import { registerInjectionFilter } from "./security/injection-filter.ts";
import { registerPermissionFilter } from "./security/permissions.ts";

// ── ArmorClaw plugin entry point ──────────────────────────────────────────────
//
// Registered via plugins.load.paths in openclaw.json (see loading instructions
// at the bottom of this file). OpenClaw's plugin loader discovers this default
// export and calls register(api) at daemon startup.

const armorClawPlugin = {
  id: "armorclaw",
  name: "ArmorClaw",
  description:
    "Hardened security layer: injection filter, permission engine, and audit logger for every tool call.",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi): void {
    // Order matters: injection check runs first, then permission check, then
    // the audit logger observes the final outcome after execution.
    registerInjectionFilter(api);
    registerPermissionFilter(api);
    registerAuditLogger(api);
  },
};

export default armorClawPlugin;
