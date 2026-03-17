import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoist fs mock before any imports
vi.mock("node:fs", () => ({
  readdirSync: vi.fn(),
  appendFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import { appendFileSync, mkdirSync, readdirSync } from "node:fs";
import {
  type ArmorClawSkillManifest,
  SkillRegistryError,
  clearRegistryForTesting,
  getAllSkills,
  getBundledSkills,
  getSkill,
  getUserSkills,
  isRecipeEligible,
  isUndoable,
  registerSkill,
  scanUserSkills,
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

function userManifest(overrides: Partial<ArmorClawSkillManifest> = {}): ArmorClawSkillManifest {
  return bundledManifest({ skillId: "user-skill", author: "user", ...overrides });
}

// ── Isolation ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  clearRegistryForTesting();
  vi.mocked(readdirSync).mockReset();
  vi.mocked(appendFileSync).mockReset();
  vi.mocked(mkdirSync).mockReset();
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

describe("registerSkill — user skill", () => {
  it("registers without throwing", () => {
    expect(() => registerSkill(userManifest())).not.toThrow();
  });

  it("stores the manifest with author:user", () => {
    registerSkill(userManifest({ skillId: "user-a" }));
    expect(getSkill("user-a")?.author).toBe("user");
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
    registerSkill(userManifest({ skillId: "a2" }));
    expect(getAllSkills()).toHaveLength(2);
  });

  it("includes both bundled and user skills", () => {
    registerSkill(bundledManifest({ skillId: "b1" }));
    registerSkill(userManifest({ skillId: "u1" }));
    const ids = getAllSkills().map((s) => s.skillId);
    expect(ids).toContain("b1");
    expect(ids).toContain("u1");
  });
});

// ── getBundledSkills ──────────────────────────────────────────────────────────

describe("getBundledSkills", () => {
  it("returns empty array when no skills registered", () => {
    expect(getBundledSkills()).toHaveLength(0);
  });

  it("returns only bundled skills", () => {
    registerSkill(bundledManifest({ skillId: "bund-1" }));
    registerSkill(userManifest({ skillId: "user-1" }));
    const bundled = getBundledSkills();
    expect(bundled).toHaveLength(1);
    expect(bundled[0].skillId).toBe("bund-1");
    expect(bundled[0].author).toBe("bundled");
  });

  it("returns multiple bundled skills", () => {
    registerSkill(bundledManifest({ skillId: "b-x" }));
    registerSkill(bundledManifest({ skillId: "b-y" }));
    registerSkill(userManifest({ skillId: "u-z" }));
    expect(getBundledSkills()).toHaveLength(2);
  });
});

// ── getUserSkills ─────────────────────────────────────────────────────────────

describe("getUserSkills", () => {
  it("returns empty array when no skills registered", () => {
    expect(getUserSkills()).toHaveLength(0);
  });

  it("returns only user skills", () => {
    registerSkill(bundledManifest({ skillId: "bundled-x" }));
    registerSkill(userManifest({ skillId: "user-x" }));
    const user = getUserSkills();
    expect(user).toHaveLength(1);
    expect(user[0].skillId).toBe("user-x");
    expect(user[0].author).toBe("user");
  });

  it("returns multiple user skills", () => {
    registerSkill(userManifest({ skillId: "u-1" }));
    registerSkill(userManifest({ skillId: "u-2" }));
    registerSkill(bundledManifest({ skillId: "b-1" }));
    expect(getUserSkills()).toHaveLength(2);
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

// ── scanUserSkills ────────────────────────────────────────────────────────────

describe("scanUserSkills — directory handling", () => {
  it("returns without error when directory does not exist", async () => {
    vi.mocked(readdirSync).mockImplementationOnce(() => {
      throw new Error("ENOENT: no such file or directory");
    });
    await expect(scanUserSkills("/nonexistent")).resolves.toBeUndefined();
  });

  it("returns without error when directory is empty", async () => {
    vi.mocked(readdirSync).mockReturnValueOnce([]);
    await expect(scanUserSkills("/empty-dir")).resolves.toBeUndefined();
  });

  it("uses the default importer when none is provided (covers default param body)", async () => {
    // Pass a .js file that doesn't exist — default import() will throw,
    // error is caught, audit entry is written. Exercises the default importer lambda.
    vi.mocked(readdirSync).mockReturnValueOnce(["nonexistent.js"] as unknown as ReturnType<
      typeof readdirSync
    >);
    await scanUserSkills("/definitely/nonexistent/skills/path");
    // Import failed → audit entry written
    expect(appendFileSync).toHaveBeenCalledOnce();
  });
});

describe("scanUserSkills — file filtering", () => {
  it("only processes .ts and .js files", async () => {
    const mockImporter = vi.fn().mockResolvedValue({ default: vi.fn() });
    vi.mocked(readdirSync).mockReturnValueOnce([
      "skill.ts",
      "skill.js",
      "README.md",
      "image.png",
    ] as unknown as ReturnType<typeof readdirSync>);
    await scanUserSkills("/skills", mockImporter);
    expect(mockImporter).toHaveBeenCalledTimes(2);
  });

  it("passes the correct path to the importer", async () => {
    const mockImporter = vi.fn().mockResolvedValue({ default: vi.fn() });
    vi.mocked(readdirSync).mockReturnValueOnce(["my-skill.ts"] as unknown as ReturnType<
      typeof readdirSync
    >);
    await scanUserSkills("/skills", mockImporter);
    expect(mockImporter).toHaveBeenCalledWith("/skills/my-skill.ts");
  });
});

describe("scanUserSkills — successful import", () => {
  it("calls the default export of each imported module", async () => {
    const setup = vi.fn();
    const mockImporter = vi.fn().mockResolvedValue({ default: setup });
    vi.mocked(readdirSync).mockReturnValueOnce(["skill.ts"] as unknown as ReturnType<
      typeof readdirSync
    >);
    await scanUserSkills("/skills", mockImporter);
    expect(setup).toHaveBeenCalledOnce();
  });

  it("skips modules without a default export function", async () => {
    const mockImporter = vi.fn().mockResolvedValue({ notDefault: vi.fn() });
    vi.mocked(readdirSync).mockReturnValueOnce(["no-default.ts"] as unknown as ReturnType<
      typeof readdirSync
    >);
    await expect(scanUserSkills("/skills", mockImporter)).resolves.toBeUndefined();
    // No audit write on successful (but empty) import
    expect(appendFileSync).not.toHaveBeenCalled();
  });

  it("skips modules where default export is not a function", async () => {
    const mockImporter = vi.fn().mockResolvedValue({ default: "not-a-function" });
    vi.mocked(readdirSync).mockReturnValueOnce(["bad-export.ts"] as unknown as ReturnType<
      typeof readdirSync
    >);
    await expect(scanUserSkills("/skills", mockImporter)).resolves.toBeUndefined();
    expect(appendFileSync).not.toHaveBeenCalled();
  });
});

describe("scanUserSkills — bad file handling", () => {
  it("does not throw when a file import fails", async () => {
    const mockImporter = vi.fn().mockRejectedValueOnce(new Error("parse error"));
    vi.mocked(readdirSync).mockReturnValueOnce(["bad.ts"] as unknown as ReturnType<
      typeof readdirSync
    >);
    await expect(scanUserSkills("/skills", mockImporter)).resolves.toBeUndefined();
  });

  it("logs to audit log when a file import fails", async () => {
    const mockImporter = vi.fn().mockRejectedValueOnce(new Error("parse error"));
    vi.mocked(readdirSync).mockReturnValueOnce(["bad.ts"] as unknown as ReturnType<
      typeof readdirSync
    >);
    await scanUserSkills("/skills", mockImporter);
    expect(appendFileSync).toHaveBeenCalledOnce();
    const [, content] = vi.mocked(appendFileSync).mock.calls[0] as [string, string, string];
    const parsed = JSON.parse(content.trimEnd());
    expect(parsed.skill).toBe("registry");
    expect(parsed.outcome).toBe("error");
  });

  it("does not throw when default export function throws", async () => {
    const setup = vi.fn().mockImplementationOnce(() => {
      throw new Error("setup error");
    });
    const mockImporter = vi.fn().mockResolvedValue({ default: setup });
    vi.mocked(readdirSync).mockReturnValueOnce(["throwing.ts"] as unknown as ReturnType<
      typeof readdirSync
    >);
    await expect(scanUserSkills("/skills", mockImporter)).resolves.toBeUndefined();
  });

  it("logs to audit log when default export function throws", async () => {
    const setup = vi.fn().mockImplementationOnce(() => {
      throw new Error("setup error");
    });
    const mockImporter = vi.fn().mockResolvedValue({ default: setup });
    vi.mocked(readdirSync).mockReturnValueOnce(["throwing.ts"] as unknown as ReturnType<
      typeof readdirSync
    >);
    await scanUserSkills("/skills", mockImporter);
    expect(appendFileSync).toHaveBeenCalledOnce();
    const [, content] = vi.mocked(appendFileSync).mock.calls[0] as [string, string, string];
    const parsed = JSON.parse(content.trimEnd());
    expect(parsed.outcome).toBe("error");
  });

  it("continues loading remaining files after one fails", async () => {
    const goodSetup = vi.fn();
    const mockImporter = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValueOnce({ default: goodSetup });
    vi.mocked(readdirSync).mockReturnValueOnce(["bad.ts", "good.ts"] as unknown as ReturnType<
      typeof readdirSync
    >);
    await scanUserSkills("/skills", mockImporter);
    expect(goodSetup).toHaveBeenCalledOnce();
  });

  it("writes one audit entry per failed file", async () => {
    const mockImporter = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail1"))
      .mockRejectedValueOnce(new Error("fail2"));
    vi.mocked(readdirSync).mockReturnValueOnce(["a.ts", "b.ts"] as unknown as ReturnType<
      typeof readdirSync
    >);
    await scanUserSkills("/skills", mockImporter);
    expect(appendFileSync).toHaveBeenCalledTimes(2);
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
