import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ArmorClawSkillManifest,
  SkillRegistryError,
  clearRegistryForTesting,
  getAllSkills,
  getBundledSkills,
  getSkill,
  isRecipeEligible,
  isUndoable,
  registerSkill,
} from "../../../lib/skill-registry.ts";
import { PermissionLoadError } from "../../../security/permissions.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

function bundledManifest(overrides: Partial<ArmorClawSkillManifest> = {}): ArmorClawSkillManifest {
  return {
    skillId: "test-skill",
    displayName: "Test Skill",
    description: "Does test things.",
    version: "1.0.0",
    author: "bundled",
    permissionManifest: ["files:local"],
    undoable: false,
    recipeEligible: false,
    digestMention: false,
    ...overrides,
  };
}

// ── Isolation ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  clearRegistryForTesting();
});

// ── registerSkill — happy path ─────────────────────────────────────────────────

describe("registerSkill — bundled skill", () => {
  it("registers without throwing", () => {
    expect(() => registerSkill(bundledManifest())).not.toThrow();
  });

  it("stores the manifest in the registry", () => {
    registerSkill(bundledManifest({ skillId: "bundled-a" }));
    expect(getSkill("bundled-a")).toBeDefined();
  });

  it("stored manifest matches input fields", () => {
    registerSkill(
      bundledManifest({
        skillId: "bundled-b",
        displayName: "My Bundled",
        version: "2.0.0",
        digestMention: true,
        recipeEligible: true,
      }),
    );
    const stored = getSkill("bundled-b");
    expect(stored?.displayName).toBe("My Bundled");
    expect(stored?.version).toBe("2.0.0");
    expect(stored?.digestMention).toBe(true);
    expect(stored?.recipeEligible).toBe(true);
  });

  it("author is bundled", () => {
    registerSkill(bundledManifest({ skillId: "bundled-c" }));
    expect(getSkill("bundled-c")?.author).toBe("bundled");
  });
});

// ── registerSkill — permission validation ─────────────────────────────────────

describe("registerSkill — banned permission rejection", () => {
  it("throws PermissionLoadError for system:root", () => {
    expect(() => registerSkill(bundledManifest({ permissionManifest: ["system:root"] }))).toThrow(
      PermissionLoadError,
    );
  });

  it("throws PermissionLoadError for system:exec", () => {
    expect(() => registerSkill(bundledManifest({ permissionManifest: ["system:exec"] }))).toThrow(
      PermissionLoadError,
    );
  });

  it("throws PermissionLoadError for files:global", () => {
    expect(() => registerSkill(bundledManifest({ permissionManifest: ["files:global"] }))).toThrow(
      PermissionLoadError,
    );
  });

  it("throws even when banned level is mixed with safe levels", () => {
    expect(() =>
      registerSkill(bundledManifest({ permissionManifest: ["files:local", "system:exec"] })),
    ).toThrow(PermissionLoadError);
  });

  it("error carries the correct skillId and bannedLevel", () => {
    let caught: PermissionLoadError | undefined;
    try {
      registerSkill(bundledManifest({ skillId: "bad-skill", permissionManifest: ["system:root"] }));
    } catch (e) {
      caught = e as PermissionLoadError;
    }
    expect(caught?.skillId).toBe("bad-skill");
    expect(caught?.bannedLevel).toBe("system:root");
  });

  it("does not register the skill when a banned level is detected", () => {
    try {
      registerSkill(
        bundledManifest({ skillId: "bad-skill", permissionManifest: ["files:global"] }),
      );
    } catch {
      // expected
    }
    expect(getSkill("bad-skill")).toBeUndefined();
  });
});

// ── registerSkill — duplicate skillId ─────────────────────────────────────────

describe("registerSkill — duplicate skillId rejection", () => {
  it("throws SkillRegistryError on second registration of same skillId", () => {
    registerSkill(bundledManifest({ skillId: "dup" }));
    expect(() => registerSkill(bundledManifest({ skillId: "dup" }))).toThrow(SkillRegistryError);
  });

  it("error message contains the duplicate skillId", () => {
    registerSkill(bundledManifest({ skillId: "dup2" }));
    expect(() => registerSkill(bundledManifest({ skillId: "dup2" }))).toThrow(/dup2/);
  });

  it("SkillRegistryError name is correct", () => {
    registerSkill(bundledManifest({ skillId: "dup3" }));
    let caught: SkillRegistryError | undefined;
    try {
      registerSkill(bundledManifest({ skillId: "dup3" }));
    } catch (e) {
      caught = e as SkillRegistryError;
    }
    expect(caught?.name).toBe("SkillRegistryError");
    expect(caught).toBeInstanceOf(SkillRegistryError);
    expect(caught).toBeInstanceOf(Error);
  });
});

// ── registerSkill — undoable contract ─────────────────────────────────────────

describe("registerSkill — undoable:true requires undo() export", () => {
  it("throws SkillRegistryError when undoable:true and exports have no undo", () => {
    expect(() =>
      registerSkill(bundledManifest({ skillId: "no-undo", undoable: true }), {
        run: vi.fn(),
      }),
    ).toThrow(SkillRegistryError);
  });

  it("error message mentions the skillId and undo()", () => {
    expect(() =>
      registerSkill(bundledManifest({ skillId: "no-undo2", undoable: true }), {
        run: vi.fn(),
      }),
    ).toThrow(/no-undo2/);
  });

  it("does not register the skill when undo() is missing", () => {
    try {
      registerSkill(bundledManifest({ skillId: "no-undo3", undoable: true }), { run: vi.fn() });
    } catch {
      // expected
    }
    expect(getSkill("no-undo3")).toBeUndefined();
  });

  it("throws when exports.undo is not a function (present but wrong type)", () => {
    expect(() =>
      registerSkill(bundledManifest({ skillId: "bad-undo", undoable: true }), {
        run: vi.fn(),
        undo: "not-a-function",
      }),
    ).toThrow(SkillRegistryError);
  });

  it("does not throw when undoable:true and exports.undo is a function", () => {
    expect(() =>
      registerSkill(bundledManifest({ skillId: "good-undo", undoable: true }), {
        run: vi.fn(),
        undo: vi.fn(),
      }),
    ).not.toThrow();
  });

  it("does not throw when undoable:true and exports are omitted (check deferred)", () => {
    // When exports are not provided, the undo check is not detectable at this callsite
    expect(() =>
      registerSkill(bundledManifest({ skillId: "undo-no-exports", undoable: true })),
    ).not.toThrow();
  });

  it("does not throw when undoable:false and exports have no undo", () => {
    expect(() =>
      registerSkill(bundledManifest({ skillId: "not-undoable", undoable: false }), {
        run: vi.fn(),
      }),
    ).not.toThrow();
  });
});

// ── getSkill ──────────────────────────────────────────────────────────────────

describe("getSkill", () => {
  it("returns undefined for an unregistered skillId", () => {
    expect(getSkill("nope")).toBeUndefined();
  });

  it("returns the manifest for a registered skill", () => {
    registerSkill(bundledManifest({ skillId: "found-me" }));
    expect(getSkill("found-me")?.skillId).toBe("found-me");
  });
});

// ── getAllSkills ───────────────────────────────────────────────────────────────

describe("getAllSkills", () => {
  it("returns an empty array when no skills are registered", () => {
    expect(getAllSkills()).toHaveLength(0);
  });

  it("returns all registered skills", () => {
    registerSkill(bundledManifest({ skillId: "a1" }));
    registerSkill(bundledManifest({ skillId: "a2" }));
    expect(getAllSkills()).toHaveLength(2);
  });

  it("returns the registered skillIds", () => {
    registerSkill(bundledManifest({ skillId: "b1" }));
    registerSkill(bundledManifest({ skillId: "b2" }));
    const ids = getAllSkills().map((s) => s.skillId);
    expect(ids).toContain("b1");
    expect(ids).toContain("b2");
  });
});

// ── getBundledSkills ──────────────────────────────────────────────────────────

describe("getBundledSkills", () => {
  it("returns empty array when no skills registered", () => {
    expect(getBundledSkills()).toHaveLength(0);
  });

  it("returns the registered bundled skill", () => {
    registerSkill(bundledManifest({ skillId: "bund-1" }));
    const bundled = getBundledSkills();
    expect(bundled).toHaveLength(1);
    expect(bundled[0].skillId).toBe("bund-1");
    expect(bundled[0].author).toBe("bundled");
  });

  it("returns multiple bundled skills", () => {
    registerSkill(bundledManifest({ skillId: "b-x" }));
    registerSkill(bundledManifest({ skillId: "b-y" }));
    expect(getBundledSkills()).toHaveLength(2);
  });
});

// ── isUndoable ────────────────────────────────────────────────────────────────

describe("isUndoable", () => {
  it("returns false for an unregistered skill", () => {
    expect(isUndoable("ghost")).toBe(false);
  });

  it("returns false for a skill registered with undoable:false", () => {
    registerSkill(bundledManifest({ skillId: "not-undo", undoable: false }));
    expect(isUndoable("not-undo")).toBe(false);
  });

  it("returns true for a skill registered with undoable:true", () => {
    registerSkill(bundledManifest({ skillId: "yes-undo", undoable: true }), {
      run: vi.fn(),
      undo: vi.fn(),
    });
    expect(isUndoable("yes-undo")).toBe(true);
  });
});

// ── isRecipeEligible ──────────────────────────────────────────────────────────

describe("isRecipeEligible", () => {
  it("returns false for an unregistered skill", () => {
    expect(isRecipeEligible("ghost")).toBe(false);
  });

  it("returns false for a skill registered with recipeEligible:false", () => {
    registerSkill(bundledManifest({ skillId: "no-recipe", recipeEligible: false }));
    expect(isRecipeEligible("no-recipe")).toBe(false);
  });

  it("returns true for a skill registered with recipeEligible:true", () => {
    registerSkill(bundledManifest({ skillId: "yes-recipe", recipeEligible: true }));
    expect(isRecipeEligible("yes-recipe")).toBe(true);
  });
});

// ── clearRegistryForTesting ───────────────────────────────────────────────────

describe("clearRegistryForTesting", () => {
  it("empties the registry", () => {
    registerSkill(bundledManifest({ skillId: "to-clear" }));
    clearRegistryForTesting();
    expect(getAllSkills()).toHaveLength(0);
  });

  it("allows re-registering the same skillId after clearing", () => {
    registerSkill(bundledManifest({ skillId: "reuse" }));
    clearRegistryForTesting();
    expect(() => registerSkill(bundledManifest({ skillId: "reuse" }))).not.toThrow();
  });
});

// ── SkillRegistryError — standalone ──────────────────────────────────────────

describe("SkillRegistryError", () => {
  it("is an instance of Error", () => {
    expect(new SkillRegistryError("msg")).toBeInstanceOf(Error);
  });

  it("has name SkillRegistryError", () => {
    expect(new SkillRegistryError("msg").name).toBe("SkillRegistryError");
  });

  it("exposes the message", () => {
    expect(new SkillRegistryError("something went wrong").message).toBe("something went wrong");
  });
});
