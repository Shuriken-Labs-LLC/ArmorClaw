/**
 * Feature gates — controls what the agent can do based on license tier.
 *
 * active:   full access to everything
 * inactive: agent pauses, no skills run
 */

import type { License, LicenseTier } from "./license.ts";

// ── Gate results ──────────────────────────────────────────────────────────────

export interface GateResult {
  /** True if the action is allowed. */
  allowed: boolean;
  /** Human-readable reason when blocked. */
  reason?: string;
}

// ── Gate functions ────────────────────────────────────────────────────────────

/** Can the agent run skills? */
export function canRunSkills(license: License): GateResult {
  if (!license.valid) {
    return {
      allowed: false,
      reason: "Your subscription is inactive. Subscribe to keep your agent running — $19/month.",
    };
  }
  return { allowed: true };
}

/** Can the agent execute recipes? */
export function canRunRecipes(license: License): GateResult {
  return canRunSkills(license);
}

/** Can the user export their data? Always yes — never trap the user. */
export function canExportData(_license: License): GateResult {
  return { allowed: true };
}

/** Can the user access settings? Always yes — they need to disconnect OAuth. */
export function canAccessSettings(_license: License): GateResult {
  return { allowed: true };
}

/** Can the user view the dashboard? Always yes — they should see what they'd lose. */
export function canAccessDashboard(_license: License): GateResult {
  return { allowed: true };
}

// ── Convenience ───────────────────────────────────────────────────────────────

/** True if the tier grants full agent access. */
export function isFullAccess(tier: LicenseTier): boolean {
  return tier === "active";
}
