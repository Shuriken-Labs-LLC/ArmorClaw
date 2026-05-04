/**
 * Regression guard: no user-skill loading.
 *
 * Phase 1a of the security overhaul (0.3.0) removed every code path that
 * loaded user-authored skills — auto-discovery from ~/.armorclaw/skills/,
 * GitHub URL fetch + install, ClawHub catalog browse, and any disk-backed
 * registry of installed skills. If a future change accidentally re-introduces
 * any of those paths, one of the assertions below fails loud.
 *
 * Three invariants are enforced:
 *   1. Every registered skill is `author: "bundled"`.
 *   2. No exported symbol starts with `scan` or matches /loadUser/i.
 *   3. The registry module never reads from disk (readdirSync is never invoked).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoist fs mock before any registry import — readdirSync must be observable.
vi.mock("node:fs", () => ({
  readdirSync: vi.fn(),
  appendFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import { readdirSync } from "node:fs";
import * as Registry from "../../../lib/skill-registry.ts";

beforeEach(() => {
  Registry.clearRegistryForTesting();
  vi.mocked(readdirSync).mockReset();
});

describe("no user-skill loading", () => {
  it('every registered skill has author: "bundled"', () => {
    Registry.registerSkill({
      skillId: "guard-bundled",
      displayName: "Guard",
      description: "Bundled fixture for the regression guard.",
      version: "1.0.0",
      author: "bundled",
      permissionManifest: ["files:local"],
      undoable: false,
      recipeEligible: false,
      digestMention: false,
    });

    const skills = Registry.getAllSkills();
    expect(skills.length).toBeGreaterThan(0);
    expect(skills.every((s) => s.author === "bundled")).toBe(true);
  });

  it("registry module exports no scan* or loadUser* symbols", () => {
    const exportNames = Object.keys(Registry);
    const offending = exportNames.filter(
      (name) => name.startsWith("scan") || /loadUser/i.test(name),
    );
    expect(offending).toEqual([]);
  });

  it("calling every public registry function never invokes readdirSync", () => {
    Registry.registerSkill({
      skillId: "guard-no-disk",
      displayName: "Guard",
      description: "Bundled fixture for the disk-read guard.",
      version: "1.0.0",
      author: "bundled",
      permissionManifest: ["files:local"],
      undoable: false,
      recipeEligible: false,
      digestMention: false,
    });

    Registry.getSkill("guard-no-disk");
    Registry.getSkill("does-not-exist");
    Registry.getAllSkills();
    Registry.getBundledSkills();
    Registry.isUndoable("guard-no-disk");
    Registry.isUndoable("does-not-exist");
    Registry.isRecipeEligible("guard-no-disk");
    Registry.isRecipeEligible("does-not-exist");

    expect(vi.mocked(readdirSync)).not.toHaveBeenCalled();
  });
});
