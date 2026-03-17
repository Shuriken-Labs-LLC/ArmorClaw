import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// ── Hard-banned permission levels ─────────────────────────────────────────────

/**
 * Permission levels that may never appear in any ArmorClaw skill manifest.
 * Declaring any of these at load time causes an immediate hard error.
 */
export const HARD_BANNED_PERMISSIONS: ReadonlySet<string> = new Set([
  "system:root",
  "system:exec",
  "files:global",
]);

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * A skill's declared permission manifest.
 * Registered once at startup; immutable after registration.
 */
export type PermissionManifest = {
  /** Unique identifier for the ArmorClaw skill that owns this manifest. */
  readonly skillId: string;
  /**
   * The exact set of tool names this skill is permitted to invoke.
   * Any tool call not listed here will be blocked.
   */
  readonly allowedTools: ReadonlyArray<string>;
  /**
   * Logical permission levels this skill is granted (e.g., "files:local", "network:read").
   * Hard-banned levels (system:root, system:exec, files:global) are rejected at load time.
   */
  readonly allowedPermissions: ReadonlyArray<string>;
};

// ── Error type ────────────────────────────────────────────────────────────────

export class PermissionLoadError extends Error {
  readonly skillId: string;
  readonly bannedLevel: string;
  constructor(skillId: string, bannedLevel: string) {
    super(`ArmorClaw: skill "${skillId}" declares hard-banned permission level "${bannedLevel}"`);
    this.name = "PermissionLoadError";
    this.skillId = skillId;
    this.bannedLevel = bannedLevel;
  }
}

// ── Registry ──────────────────────────────────────────────────────────────────

// Manifests are stored frozen; the Map itself is module-private
const registry = new Map<string, Readonly<PermissionManifest>>();

// ── Load ──────────────────────────────────────────────────────────────────────

/**
 * Register a permission manifest for an ArmorClaw skill.
 *
 * Throws {@link PermissionLoadError} if any `allowedPermissions` entry is hard-banned.
 * Throws a generic Error if a manifest for `skillId` is already registered
 * (manifests are immutable — re-registration is not permitted).
 */
export function loadPermissionManifest(manifest: PermissionManifest): void {
  // Hard-banned level check — must run before anything is stored
  for (const level of manifest.allowedPermissions) {
    if (HARD_BANNED_PERMISSIONS.has(level)) {
      throw new PermissionLoadError(manifest.skillId, level);
    }
  }

  // Immutability guard — prevent runtime mutation via re-registration
  if (registry.has(manifest.skillId)) {
    throw new Error(
      `ArmorClaw: manifest for skill "${manifest.skillId}" is already registered and immutable`,
    );
  }

  // Deep-freeze to enforce immutability of the stored object
  registry.set(
    manifest.skillId,
    Object.freeze({
      skillId: manifest.skillId,
      allowedTools: Object.freeze([...manifest.allowedTools]),
      allowedPermissions: Object.freeze([...manifest.allowedPermissions]),
    }),
  );
}

// ── Query ─────────────────────────────────────────────────────────────────────

/** Read-only view of all registered manifests. */
export function getRegisteredManifests(): ReadonlyMap<string, Readonly<PermissionManifest>> {
  return registry;
}

/**
 * Check whether a tool call is permitted by the registered manifests.
 *
 * - If no manifests are registered, ArmorClaw is inactive → allow all.
 * - If at least one manifest is registered, the tool must appear in at least
 *   one manifest's `allowedTools`; otherwise it is blocked.
 *
 * Returns a human-readable block reason string, or `null` if the call is allowed.
 */
export function checkToolPermission(toolName: string): string | null {
  // No manifests registered → permission layer is not active
  if (registry.size === 0) {
    return null;
  }

  for (const [, manifest] of registry) {
    if ((manifest.allowedTools as string[]).includes(toolName)) {
      return null;
    }
  }

  return `tool "${toolName}" is not declared in any ArmorClaw skill manifest`;
}

// ── Hook registration ─────────────────────────────────────────────────────────

/**
 * Register the permission filter on the before_tool_call hook.
 * Runs alongside the injection filter; both must pass for the tool to execute.
 */
export function registerPermissionFilter(api: OpenClawPluginApi): void {
  api.on("before_tool_call", (event, _ctx) => {
    const reason = checkToolPermission(event.toolName);
    if (!reason) {
      return undefined;
    }

    return {
      block: true,
      blockReason: `ArmorClaw permission check: ${reason}`,
    };
  });
}

// ── Testing helper ────────────────────────────────────────────────────────────

/**
 * Clear all registered manifests.
 * Intended for test isolation only — do not call in production code.
 */
export function clearManifestsForTesting(): void {
  registry.clear();
}

// ── Plugin definition ────────────────────────────────────────────────────────

export default {
  id: "armorclaw-permissions",
  name: "ArmorClaw Permission Filter",
  description: "Enforces per-skill tool permission manifests; blocks undeclared tool calls",
  register(api: OpenClawPluginApi): void {
    registerPermissionFilter(api);
  },
};
