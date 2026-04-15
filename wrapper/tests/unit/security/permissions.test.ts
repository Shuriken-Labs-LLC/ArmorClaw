import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import permissionsPlugin, {
  HARD_BANNED_PERMISSIONS,
  PermissionLoadError,
  checkToolPermission,
  clearManifestsForTesting,
  getPendingApprovals,
  getRegisteredManifests,
  loadPermissionManifest,
  registerPermissionFilter,
} from "../../../security/permissions.ts";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeMockApi() {
  let capturedHandler: (
    event: { toolName: string; params: Record<string, unknown> },
    ctx: Record<string, unknown>,
  ) => unknown = () => undefined;

  return {
    on: vi.fn((_hookName: string, fn: typeof capturedHandler) => {
      capturedHandler = fn;
    }),
    get capturedHandler() {
      return capturedHandler;
    },
  };
}

function validManifest(
  overrides: Partial<{
    skillId: string;
    allowedTools: string[];
    allowedPermissions: string[];
  }> = {},
) {
  return {
    skillId: overrides.skillId ?? "test-skill",
    allowedTools: overrides.allowedTools ?? ["read_file", "write_file"],
    allowedPermissions: overrides.allowedPermissions ?? ["files:local"],
  };
}

// ── Isolation ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  clearManifestsForTesting();
});

afterEach(() => {
  clearManifestsForTesting();
});

// ── HARD_BANNED_PERMISSIONS ───────────────────────────────────────────────────

describe("HARD_BANNED_PERMISSIONS", () => {
  it("contains system:root", () => {
    expect(HARD_BANNED_PERMISSIONS.has("system:root")).toBe(true);
  });

  it("contains system:exec", () => {
    expect(HARD_BANNED_PERMISSIONS.has("system:exec")).toBe(true);
  });

  it("contains files:global", () => {
    expect(HARD_BANNED_PERMISSIONS.has("files:global")).toBe(true);
  });

  it("does not contain safe permission levels", () => {
    expect(HARD_BANNED_PERMISSIONS.has("files:local")).toBe(false);
    expect(HARD_BANNED_PERMISSIONS.has("network:read")).toBe(false);
  });
});

// ── PermissionLoadError ───────────────────────────────────────────────────────

describe("PermissionLoadError", () => {
  it("is an instance of Error", () => {
    const err = new PermissionLoadError("my-skill", "system:root");
    expect(err).toBeInstanceOf(Error);
  });

  it("has name PermissionLoadError", () => {
    const err = new PermissionLoadError("my-skill", "system:exec");
    expect(err.name).toBe("PermissionLoadError");
  });

  it("exposes skillId and bannedLevel properties", () => {
    const err = new PermissionLoadError("skill-a", "files:global");
    expect(err.skillId).toBe("skill-a");
    expect(err.bannedLevel).toBe("files:global");
  });

  it("message contains skillId and bannedLevel", () => {
    const err = new PermissionLoadError("skill-a", "system:root");
    expect(err.message).toContain("skill-a");
    expect(err.message).toContain("system:root");
  });
});

// ── loadPermissionManifest — happy path ──────────────────────────────────────

describe("loadPermissionManifest — happy path", () => {
  it("loads a valid manifest without throwing", () => {
    expect(() => loadPermissionManifest(validManifest())).not.toThrow();
  });

  it("stores the manifest in the registry", () => {
    loadPermissionManifest(validManifest({ skillId: "skill-x" }));
    expect(getRegisteredManifests().has("skill-x")).toBe(true);
  });

  it("stores allowedTools correctly", () => {
    loadPermissionManifest(validManifest({ skillId: "s", allowedTools: ["tool_a", "tool_b"] }));
    expect(getRegisteredManifests().get("s")?.allowedTools).toContain("tool_a");
    expect(getRegisteredManifests().get("s")?.allowedTools).toContain("tool_b");
  });

  it("stores allowedPermissions correctly", () => {
    loadPermissionManifest(
      validManifest({ skillId: "s", allowedPermissions: ["files:local", "network:read"] }),
    );
    expect(getRegisteredManifests().get("s")?.allowedPermissions).toContain("files:local");
    expect(getRegisteredManifests().get("s")?.allowedPermissions).toContain("network:read");
  });

  it("accepts manifests with empty allowedTools", () => {
    expect(() =>
      loadPermissionManifest(validManifest({ skillId: "empty-tools", allowedTools: [] })),
    ).not.toThrow();
  });

  it("accepts manifests with empty allowedPermissions", () => {
    expect(() =>
      loadPermissionManifest(validManifest({ skillId: "empty-perms", allowedPermissions: [] })),
    ).not.toThrow();
  });

  it("allows multiple distinct skills to be loaded", () => {
    loadPermissionManifest(validManifest({ skillId: "skill-1" }));
    loadPermissionManifest(validManifest({ skillId: "skill-2" }));
    expect(getRegisteredManifests().size).toBe(2);
  });
});

// ── loadPermissionManifest — hard-banned rejection ───────────────────────────

describe("loadPermissionManifest — hard-banned permissions", () => {
  it("throws PermissionLoadError for system:root", () => {
    expect(() =>
      loadPermissionManifest(validManifest({ allowedPermissions: ["system:root"] })),
    ).toThrow(PermissionLoadError);
  });

  it("throws PermissionLoadError for system:exec", () => {
    expect(() =>
      loadPermissionManifest(validManifest({ allowedPermissions: ["system:exec"] })),
    ).toThrow(PermissionLoadError);
  });

  it("throws PermissionLoadError for files:global", () => {
    expect(() =>
      loadPermissionManifest(validManifest({ allowedPermissions: ["files:global"] })),
    ).toThrow(PermissionLoadError);
  });

  it("throws even when banned level is mixed with safe levels", () => {
    expect(() =>
      loadPermissionManifest(validManifest({ allowedPermissions: ["files:local", "system:exec"] })),
    ).toThrow(PermissionLoadError);
  });

  it("does not register the manifest when a banned level is detected", () => {
    try {
      loadPermissionManifest(
        validManifest({ skillId: "bad-skill", allowedPermissions: ["system:root"] }),
      );
    } catch {
      // expected
    }
    expect(getRegisteredManifests().has("bad-skill")).toBe(false);
  });

  it("error references the correct skillId", () => {
    let caught: PermissionLoadError | undefined;
    try {
      loadPermissionManifest(
        validManifest({ skillId: "villain", allowedPermissions: ["system:exec"] }),
      );
    } catch (e) {
      caught = e as PermissionLoadError;
    }
    expect(caught?.skillId).toBe("villain");
    expect(caught?.bannedLevel).toBe("system:exec");
  });
});

// ── loadPermissionManifest — immutability ────────────────────────────────────

describe("loadPermissionManifest — immutability", () => {
  it("throws when registering the same skillId twice", () => {
    loadPermissionManifest(validManifest({ skillId: "dup-skill" }));
    expect(() => loadPermissionManifest(validManifest({ skillId: "dup-skill" }))).toThrow();
  });

  it("error message mentions the skillId", () => {
    loadPermissionManifest(validManifest({ skillId: "dup-skill" }));
    expect(() => loadPermissionManifest(validManifest({ skillId: "dup-skill" }))).toThrow(
      /dup-skill/,
    );
  });

  it("stored manifest allowedTools array is frozen", () => {
    loadPermissionManifest(validManifest({ skillId: "frozen-skill" }));
    const stored = getRegisteredManifests().get("frozen-skill");
    // Attempting to push to a frozen array throws in strict mode
    expect(() => {
      (stored!.allowedTools as string[]).push("injected_tool");
    }).toThrow();
  });
});

// ── checkToolPermission ───────────────────────────────────────────────────────

describe("checkToolPermission", () => {
  it("allows when no manifests are registered (ArmorClaw inactive)", () => {
    const result = checkToolPermission("any_tool");
    expect(result.decision).toBe("allow");
  });

  it("allows a tool listed in a registered manifest", () => {
    loadPermissionManifest(validManifest({ allowedTools: ["read_file"] }));
    const result = checkToolPermission("read_file");
    expect(result.decision).toBe("allow");
  });

  it("returns approval_required for a tool not in any manifest", () => {
    loadPermissionManifest(validManifest({ allowedTools: ["read_file"] }));
    const result = checkToolPermission("bash");
    expect(result.decision).toBe("approval_required");
    expect(result.reason).toContain("bash");
  });

  it("allows a tool covered by any one of multiple manifests", () => {
    loadPermissionManifest(validManifest({ skillId: "skill-a", allowedTools: ["tool_a"] }));
    loadPermissionManifest(validManifest({ skillId: "skill-b", allowedTools: ["tool_b"] }));
    expect(checkToolPermission("tool_a").decision).toBe("allow");
    expect(checkToolPermission("tool_b").decision).toBe("allow");
  });

  it("requires approval for a tool not in any of multiple manifests", () => {
    loadPermissionManifest(validManifest({ skillId: "skill-a", allowedTools: ["tool_a"] }));
    loadPermissionManifest(validManifest({ skillId: "skill-b", allowedTools: ["tool_b"] }));
    expect(checkToolPermission("tool_c").decision).toBe("approval_required");
  });

  it("approval reason includes the tool name", () => {
    loadPermissionManifest(validManifest({ allowedTools: ["read_file"] }));
    const result = checkToolPermission("forbidden_tool");
    expect(result.reason).toContain("forbidden_tool");
  });
});

// ── registerPermissionFilter ──────────────────────────────────────────────────

describe("registerPermissionFilter", () => {
  it("registers a before_tool_call handler on the api", () => {
    const mockApi = makeMockApi();
    registerPermissionFilter(mockApi as unknown as OpenClawPluginApi);
    expect(mockApi.on).toHaveBeenCalledWith("before_tool_call", expect.any(Function));
  });

  it("allows all tool calls when no manifests are registered", () => {
    const mockApi = makeMockApi();
    registerPermissionFilter(mockApi as unknown as OpenClawPluginApi);
    const result = mockApi.capturedHandler({ toolName: "any_tool", params: {} }, {});
    expect(result).toBeUndefined();
  });

  it("allows a tool that is in a registered manifest", () => {
    loadPermissionManifest(validManifest({ allowedTools: ["safe_tool"] }));
    const mockApi = makeMockApi();
    registerPermissionFilter(mockApi as unknown as OpenClawPluginApi);
    const result = mockApi.capturedHandler({ toolName: "safe_tool", params: {} }, {});
    expect(result).toBeUndefined();
  });

  it("allows undeclared tools (queues for approval instead of blocking)", () => {
    loadPermissionManifest(validManifest({ allowedTools: ["safe_tool"] }));
    const mockApi = makeMockApi();
    registerPermissionFilter(mockApi as unknown as OpenClawPluginApi);
    const result = mockApi.capturedHandler({ toolName: "dangerous_tool", params: {} }, {});
    // Undeclared tools are allowed through but queued for approval
    expect(result).toBeUndefined();
  });

  it("queues a pending approval for undeclared tools", () => {
    loadPermissionManifest(validManifest({ allowedTools: ["safe_tool"] }));
    const mockApi = makeMockApi();
    registerPermissionFilter(mockApi as unknown as OpenClawPluginApi);
    mockApi.capturedHandler({ toolName: "unknown_tool", params: {} }, {});
    const pending = getPendingApprovals();
    expect(pending.length).toBeGreaterThan(0);
    expect(pending[0].toolName).toBe("unknown_tool");
  });
});

// ── clearManifestsForTesting ──────────────────────────────────────────────────

describe("clearManifestsForTesting", () => {
  it("removes all registered manifests", () => {
    loadPermissionManifest(validManifest({ skillId: "to-clear" }));
    clearManifestsForTesting();
    expect(getRegisteredManifests().size).toBe(0);
  });

  it("allows re-registering the same skillId after clearing", () => {
    loadPermissionManifest(validManifest({ skillId: "reusable" }));
    clearManifestsForTesting();
    expect(() => loadPermissionManifest(validManifest({ skillId: "reusable" }))).not.toThrow();
  });
});

// ── getRegisteredManifests ────────────────────────────────────────────────────

describe("getRegisteredManifests", () => {
  it("returns an empty map when no manifests are loaded", () => {
    expect(getRegisteredManifests().size).toBe(0);
  });

  it("returns a map with one entry after loading one manifest", () => {
    loadPermissionManifest(validManifest({ skillId: "one" }));
    expect(getRegisteredManifests().size).toBe(1);
  });
});

// ── default plugin export ─────────────────────────────────────────────────────

describe("default export (plugin definition)", () => {
  it("has the correct plugin id", () => {
    expect(permissionsPlugin.id).toBe("armorclaw-permissions");
  });

  it("register() calls api.on with before_tool_call", () => {
    const mockApi = makeMockApi();
    permissionsPlugin.register(mockApi as unknown as OpenClawPluginApi);
    expect(mockApi.on).toHaveBeenCalledWith("before_tool_call", expect.any(Function));
  });
});
