// @ts-ignore — openclaw/plugin-sdk has no type declarations
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// ── Hard-banned permission levels ─────────────────────────────────────────────

/**
 * Permission levels that may never appear in any ArmorClaw skill manifest.
 * Declaring any of these at load time causes an immediate hard error.
 * These are the ONLY hard blocks — everything else is a user confirmation.
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
   * Tools not listed here trigger a user approval prompt instead of blocking.
   */
  readonly allowedTools: ReadonlyArray<string>;
  /**
   * Logical permission levels this skill is granted (e.g., "files:local", "network:read").
   * Hard-banned levels (system:root, system:exec, files:global) are rejected at load time.
   */
  readonly allowedPermissions: ReadonlyArray<string>;
};

/**
 * Result of a permission check.
 * - "allow": tool is in the manifest, proceed immediately
 * - "approval_required": tool is not in the manifest, needs user confirmation
 * - "blocked": tool requires a hard-banned permission, reject unconditionally
 */
export type PermissionCheckResult = {
  decision: "allow" | "approval_required" | "blocked";
  reason?: string;
};

// ── Approval queue ───────────────────────────────────────────────────────────

export interface PendingToolApproval {
  id: string;
  toolName: string;
  skillId: string | null;
  timestamp: string;
  resolved: boolean;
  approved: boolean;
  /** The literal params the tool was called with. Included in dashboard payload. */
  toolParams: Record<string, unknown>;
  /**
   * Resolves the async gate in registerPermissionFilter.
   * Set to null once called (approve, reject, or timeout).
   * Never serialized — stays in-memory only.
   */
  resolveGate: ((approved: boolean) => void) | null;
}

const _pendingApprovals: PendingToolApproval[] = [];
const _approvalListeners = new Set<() => void>();

let _approvalCounter = 0;

// Injected at startup by wrapper/index.ts — wired to the Telegram notify utility.
// Null by default so this module stays I/O-free in isolation. The dependency
// flows through this slot only; permissions.ts must not import the notifier.
let _approvalNotifier: ((toolName: string, toolParams: Record<string, unknown>) => void) | null =
  null;

export function setApprovalNotifier(
  fn: ((toolName: string, toolParams: Record<string, unknown>) => void) | null,
): void {
  _approvalNotifier = fn;
}

export function getPendingApprovals(): PendingToolApproval[] {
  return _pendingApprovals.filter((a) => !a.resolved);
}

export function onApprovalChange(fn: () => void): () => void {
  _approvalListeners.add(fn);
  return () => _approvalListeners.delete(fn);
}

function notifyApprovalListeners(): void {
  for (const fn of _approvalListeners) {
    try {
      fn();
    } catch {
      /* never crash */
    }
  }
}

/**
 * Approve or deny a pending tool call.
 * Returns true if the approval was found and resolved.
 */
export function resolveApproval(id: string, approved: boolean): boolean {
  const entry = _pendingApprovals.find((a) => a.id === id && !a.resolved);
  if (!entry) {
    return false;
  }
  entry.resolved = true;
  entry.approved = approved;
  if (entry.resolveGate) {
    entry.resolveGate(approved);
    entry.resolveGate = null;
  }
  notifyApprovalListeners();
  return true;
}

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
 * Returns the union of `allowedPermissions` from every registered manifest
 * that lists `toolName` in its `allowedTools`.
 * Returns an empty array if no manifest covers the tool (e.g. unknown/external tool).
 * Deterministic output: sorted for stable audit log output.
 */
export function getPermissionsForTool(toolName: string): string[] {
  const levels = new Set<string>();
  for (const [, manifest] of registry) {
    if ((manifest.allowedTools as string[]).includes(toolName)) {
      for (const level of manifest.allowedPermissions) {
        levels.add(level);
      }
    }
  }
  return [...levels].toSorted();
}

/**
 * Check whether a tool call is permitted by the registered manifests.
 *
 * Philosophy: ArmorClaw is not a capability ceiling. Instead of hard-blocking
 * undeclared tools, we route them through the approval system so the user can
 * decide. Only hard-banned permission levels (system:root, system:exec,
 * files:global) are unconditionally blocked.
 *
 * Returns:
 * - "allow" if the tool is in a registered manifest
 * - "approval_required" if the tool is not declared but not banned
 * - "blocked" if the tool requires a hard-banned permission
 * - "allow" if no manifests are registered (layer inactive)
 */
export function checkToolPermission(toolName: string): PermissionCheckResult {
  // No manifests registered → permission layer is not active
  if (registry.size === 0) {
    return { decision: "allow" };
  }

  // Check if the tool is in any registered manifest → allow immediately
  for (const [, manifest] of registry) {
    if ((manifest.allowedTools as string[]).includes(toolName)) {
      return { decision: "allow" };
    }
  }

  // Not in any manifest — route through approval instead of blocking
  return {
    decision: "approval_required",
    reason: `Tool "${toolName}" is not in any skill's declared manifest. User approval required.`,
  };
}

// ── Hook registration ─────────────────────────────────────────────────────────

/**
 * Register the permission filter on the before_tool_call hook.
 *
 * Undeclared tools are NOT blocked — they are queued for user approval via the
 * dashboard's pending approvals card. Only hard-banned permissions cause a
 * hard block.
 */
export function registerPermissionFilter(api: OpenClawPluginApi): void {
  api.on("before_tool_call", async (event: unknown, _ctx: unknown) => {
    const evt = event as { toolName: string; params?: Record<string, unknown> };
    const result = checkToolPermission(evt.toolName);

    if (result.decision === "allow") {
      return undefined;
    }

    if (result.decision === "blocked") {
      return {
        block: true,
        blockReason: `ArmorClaw: ${result.reason}`,
      };
    }

    // approval_required — queue the approval and block until resolved or timed out.
    _approvalCounter++;
    const approvalId = `approval-${_approvalCounter}-${Date.now()}`;

    const gatePromise = new Promise<boolean>((resolve) => {
      const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

      const timeoutHandle = setTimeout(() => {
        const entry = _pendingApprovals.find((a) => a.id === approvalId);
        if (entry && !entry.resolved) {
          entry.resolved = true;
          entry.resolveGate = null;
          notifyApprovalListeners();
        }
        resolve(false); // auto-reject on timeout
      }, TIMEOUT_MS);

      const approval: PendingToolApproval = {
        id: approvalId,
        toolName: evt.toolName,
        skillId: null,
        timestamp: new Date().toISOString(),
        resolved: false,
        approved: false,
        toolParams: evt.params ?? {},
        resolveGate: (approved: boolean) => {
          clearTimeout(timeoutHandle);
          resolve(approved);
        },
      };

      _pendingApprovals.push(approval);
      notifyApprovalListeners();

      // Fire-and-forget UX notification — must not affect gate logic
      if (_approvalNotifier) {
        try {
          _approvalNotifier(evt.toolName, evt.params ?? {});
        } catch {
          /* never crash the gate */
        }
      }
    });

    const approved = await gatePromise;

    if (!approved) {
      return {
        block: true,
        blockReason: `ArmorClaw: Tool "${evt.toolName}" was blocked — user rejected or approval timed out.`,
      };
    }

    return undefined; // approved — proceed
  });
}

// ── Testing helper ────────────────────────────────────────────────────────────

/**
 * Clear all registered manifests and pending approvals.
 * Intended for test isolation only — do not call in production code.
 */
export function clearManifestsForTesting(): void {
  registry.clear();
  _pendingApprovals.length = 0;
  _approvalCounter = 0;
  _approvalNotifier = null;
}

// ── Plugin definition ────────────────────────────────────────────────────────

export default {
  id: "armorclaw-permissions",
  name: "ArmorClaw Permission Filter",
  description:
    "Enforces per-skill tool permission manifests. Undeclared tools " +
    "trigger user approval; only hard-banned levels are blocked.",
  register(api: OpenClawPluginApi): void {
    registerPermissionFilter(api);
  },
};
