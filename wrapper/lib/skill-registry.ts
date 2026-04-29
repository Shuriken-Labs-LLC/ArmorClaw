import { HARD_BANNED_PERMISSIONS, PermissionLoadError } from "../security/permissions.ts";

// ── Types ────────────────────────────────────────────────────────────────────

/** A permission level string, e.g. "files:local", "network:read". */
export type PermissionLevel = string;

/**
 * Full manifest every skill must supply when calling `registerSkill()`.
 *
 * Only bundled skills are supported. User-created skills were removed in 0.3.0
 * (Phase 1a of the security overhaul) — see CLAUDE.md hard stops for the rationale.
 */
export interface ArmorClawSkillManifest {
  /** Unique kebab-case identifier, e.g. "my-lead-scorer". */
  skillId: string;
  /** Human-readable name shown in the activity feed: "Lead scorer". */
  displayName: string;
  /** One sentence shown in the Skills view and recipe library. */
  description: string;
  /** Semver string: "1.0.0". */
  version: string;
  /** Provenance: always "bundled" — user-authored skills are not loaded. */
  author: "bundled";
  /** Permission levels this skill requires. Hard-banned levels are rejected at load time. */
  permissionManifest: PermissionLevel[];
  /** true = skill must also export undo(); shown as undoable in dashboard. */
  undoable: boolean;
  /** true = skill can be scheduled via the recipe cron scheduler. */
  recipeEligible: boolean;
  /** true = skill is named in the daily digest action summary. */
  digestMention: boolean;
}

// ── Error type ────────────────────────────────────────────────────────────────

/** Thrown when skill registration fails for reasons other than a banned permission. */
export class SkillRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillRegistryError";
  }
}

// ── Registry ──────────────────────────────────────────────────────────────────

// Module-level; rebuilt on every daemon restart by bundled skills calling registerSkill().
const registry = new Map<string, Readonly<ArmorClawSkillManifest>>();

// ── Registration ──────────────────────────────────────────────────────────────

/**
 * Register an ArmorClaw skill.
 *
 * Validation (all run before the manifest is stored):
 *  1. `permissionManifest` must not contain a hard-banned level — throws {@link PermissionLoadError}.
 *  2. `skillId` must be unique — throws {@link SkillRegistryError}.
 *  3. If `undoable: true` and `exports` is provided, `exports.undo` must be a function —
 *     throws {@link SkillRegistryError}. When `exports` is omitted the check is skipped
 *     (the caller is responsible for supplying them when the undo contract can be verified).
 *
 * @param manifest  Skill metadata and permission declaration.
 * @param exports   Optional: the skill module's exported functions. When provided and
 *                  `manifest.undoable` is `true`, the presence of an `undo()` function is
 *                  verified at registration time rather than deferred to runtime.
 */
export function registerSkill(
  manifest: ArmorClawSkillManifest,
  exports?: Record<string, unknown>,
): void {
  // 1. Hard-banned permission check — identical to the permission engine
  for (const level of manifest.permissionManifest) {
    if (HARD_BANNED_PERMISSIONS.has(level)) {
      throw new PermissionLoadError(manifest.skillId, level);
    }
  }

  // 2. Duplicate skillId guard — registry is immutable after registration
  if (registry.has(manifest.skillId)) {
    throw new SkillRegistryError(`ArmorClaw: skill "${manifest.skillId}" is already registered`);
  }

  // 3. Undo contract check — only when exports are supplied
  if (manifest.undoable && exports !== undefined && typeof exports.undo !== "function") {
    throw new SkillRegistryError(
      `ArmorClaw: skill "${manifest.skillId}" declares undoable:true but does not export undo()`,
    );
  }

  registry.set(manifest.skillId, Object.freeze({ ...manifest }));
}

// ── Query functions ───────────────────────────────────────────────────────────

/** Returns the manifest for `skillId`, or `undefined` if not registered. */
export function getSkill(skillId: string): Readonly<ArmorClawSkillManifest> | undefined {
  return registry.get(skillId);
}

/** Returns all registered manifests. All manifests are bundled. */
export function getAllSkills(): ReadonlyArray<Readonly<ArmorClawSkillManifest>> {
  return [...registry.values()];
}

/** Returns only manifests with `author: "bundled"` — currently equivalent to `getAllSkills()`. */
export function getBundledSkills(): ReadonlyArray<Readonly<ArmorClawSkillManifest>> {
  return [...registry.values()].filter((s) => s.author === "bundled");
}

/** Returns `true` if the skill is registered and declares `undoable: true`. */
export function isUndoable(skillId: string): boolean {
  return registry.get(skillId)?.undoable ?? false;
}

/** Returns `true` if the skill is registered and declares `recipeEligible: true`. */
export function isRecipeEligible(skillId: string): boolean {
  return registry.get(skillId)?.recipeEligible ?? false;
}

// ── Testing helper ────────────────────────────────────────────────────────────

/**
 * Clear all registered skills.
 * Intended for test isolation only — do not call in production code.
 */
export function clearRegistryForTesting(): void {
  registry.clear();
}
