import { readdirSync } from "node:fs";
import { join } from "node:path";
import { type AuditEntry, writeAuditEntry } from "../security/audit-logger.ts";
import { HARD_BANNED_PERMISSIONS, PermissionLoadError } from "../security/permissions.ts";

// ── Types ────────────────────────────────────────────────────────────────────

/** A permission level string, e.g. "files:local", "network:read". */
export type PermissionLevel = string;

/**
 * Full manifest every skill must supply when calling `registerSkill()`.
 * Bundled and user-created skills share the same shape.
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
  /** Provenance: bundled = shipped with ArmorClaw; user = vibe-coded by the user. */
  author: "bundled" | "user";
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

// Module-level; rebuilt on every daemon restart via scanUserSkills()
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

/** Returns all registered manifests (bundled and user). */
export function getAllSkills(): ReadonlyArray<Readonly<ArmorClawSkillManifest>> {
  return [...registry.values()];
}

/** Returns only manifests with `author: "bundled"`. */
export function getBundledSkills(): ReadonlyArray<Readonly<ArmorClawSkillManifest>> {
  return [...registry.values()].filter((s) => s.author === "bundled");
}

/** Returns only manifests with `author: "user"`. */
export function getUserSkills(): ReadonlyArray<Readonly<ArmorClawSkillManifest>> {
  return [...registry.values()].filter((s) => s.author === "user");
}

/** Returns `true` if the skill is registered and declares `undoable: true`. */
export function isUndoable(skillId: string): boolean {
  return registry.get(skillId)?.undoable ?? false;
}

/** Returns `true` if the skill is registered and declares `recipeEligible: true`. */
export function isRecipeEligible(skillId: string): boolean {
  return registry.get(skillId)?.recipeEligible ?? false;
}

// ── Auto-discovery ────────────────────────────────────────────────────────────

/**
 * Function signature for the dynamic importer used by `scanUserSkills`.
 * Defaults to `import(filePath)` but is injectable for test isolation.
 */
type SkillImporter = (filePath: string) => Promise<Record<string, unknown>>;

/**
 * Scan a directory for user skill files (`.ts` / `.js`), import each one,
 * and call its default export (the skill setup function).
 *
 * Discovery errors (missing directory, bad import, registration rejection) are
 * written to the audit log with `outcome: "error"` and `skill: "registry"`.
 * They never crash the daemon — the bad file is skipped and the rest load normally.
 *
 * @param dir       Directory to scan, typically `~/.armorclaw/skills/`.
 * @param importer  Override the default `import()` for test injection.
 */
export async function scanUserSkills(
  dir: string,
  importer: SkillImporter = (p) => import(p) as Promise<Record<string, unknown>>,
): Promise<void> {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".ts") || f.endsWith(".js"));
  } catch {
    // Directory absent or unreadable — not an error condition, nothing to load
    return;
  }

  for (const file of files) {
    const filePath = join(dir, file);
    try {
      const mod = await importer(filePath);
      if (typeof mod.default === "function") {
        (mod.default as () => unknown)();
      }
    } catch {
      const auditEntry: AuditEntry = {
        timestamp: new Date().toISOString(),
        skill: "registry",
        permissionsUsed: [],
        inputSummary: `Failed to load skill: ${file}`.slice(0, 80),
        outcome: "error",
        durationMs: 0,
      };
      writeAuditEntry(auditEntry);
    }
  }
}

// ── Testing helper ────────────────────────────────────────────────────────────

/**
 * Clear all registered skills.
 * Intended for test isolation only — do not call in production code.
 */
export function clearRegistryForTesting(): void {
  registry.clear();
}
