/**
 * Unit tests for wrapper/config/platform.ts.
 *
 * All OS-level calls (execSync, process.version, process.platform) are injected
 * via options — no real processes are spawned.
 *
 * Coverage targets: 100% line coverage.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("../../../security/audit-logger.ts", () => ({
  writeAuditEntry: vi.fn(),
}));

import {
  parseNodeMajor,
  isGitAvailable,
  isLibsecretAvailable,
  checkPlatformCompatibility,
} from "../../../config/platform.ts";
import { writeAuditEntry } from "../../../security/audit-logger.ts";

// ── parseNodeMajor ────────────────────────────────────────────────────────────

describe("parseNodeMajor", () => {
  it("parses vXX.Y.Z format", () => {
    expect(parseNodeMajor("v22.1.0")).toBe(22);
  });

  it("parses XX.Y.Z without leading v", () => {
    expect(parseNodeMajor("20.0.0")).toBe(20);
  });

  it("parses large major versions", () => {
    expect(parseNodeMajor("v100.0.0")).toBe(100);
  });

  it("returns NaN for empty string", () => {
    expect(parseNodeMajor("")).toBeNaN();
  });

  it("returns NaN for malformed string", () => {
    expect(parseNodeMajor("not-a-version")).toBeNaN();
  });
});

// ── isGitAvailable ────────────────────────────────────────────────────────────

describe("isGitAvailable", () => {
  it("returns true when command succeeds", () => {
    const runCommand = vi.fn(); // no throw
    expect(isGitAvailable(runCommand)).toBe(true);
    expect(runCommand).toHaveBeenCalledWith("git --version");
  });

  it("returns false when command throws", () => {
    const runCommand = vi.fn().mockImplementation(() => {
      throw new Error("not found");
    });
    expect(isGitAvailable(runCommand)).toBe(false);
  });
});

// ── isLibsecretAvailable ──────────────────────────────────────────────────────

describe("isLibsecretAvailable", () => {
  it("returns true when ldconfig output includes libsecret-1.so", () => {
    const runCommand = vi
      .fn()
      .mockReturnValue("libsecret-1.so.0 => /usr/lib/x86_64-linux-gnu/libsecret-1.so.0");
    expect(isLibsecretAvailable(runCommand)).toBe(true);
  });

  it("returns true when ldconfig fails but file probe succeeds", () => {
    const runCommand = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("ldconfig not found");
      })
      .mockReturnValue("/usr/lib/libsecret-1.so.0");
    expect(isLibsecretAvailable(runCommand)).toBe(true);
  });

  it("returns false when both ldconfig and file probe fail", () => {
    const runCommand = vi.fn().mockImplementation(() => {
      throw new Error("not found");
    });
    expect(isLibsecretAvailable(runCommand)).toBe(false);
  });

  it("returns false when ldconfig succeeds but does not mention libsecret and file probe also fails", () => {
    const runCommand = vi
      .fn()
      .mockReturnValueOnce("libc.so.6 => /lib/x86_64-linux-gnu/libc.so.6") // ldconfig — no libsecret
      .mockImplementationOnce(() => {
        throw new Error("no such file");
      }); // file probe fails
    expect(isLibsecretAvailable(runCommand)).toBe(false);
  });
});

// ── checkPlatformCompatibility ────────────────────────────────────────────────

describe("checkPlatformCompatibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Node version ──

  it("passes on Node 22+", () => {
    const result = checkPlatformCompatibility({
      nodeVersion: "v22.1.0",
      platform: "darwin",
    });
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toContain("Node.js v22.1.0 — ok");
  });

  it("passes on Node 25", () => {
    const result = checkPlatformCompatibility({
      nodeVersion: "v25.0.0",
      platform: "darwin",
    });
    expect(result.ok).toBe(true);
  });

  it("throws on Node 20", () => {
    expect(() =>
      checkPlatformCompatibility({ nodeVersion: "v20.0.0", platform: "darwin" }),
    ).toThrow(/Node.js 22 or later/);
  });

  it("throws on Node 18", () => {
    expect(() =>
      checkPlatformCompatibility({ nodeVersion: "v18.0.0", platform: "darwin" }),
    ).toThrow(/Node.js 22 or later/);
  });

  it("throws on malformed version string", () => {
    expect(() => checkPlatformCompatibility({ nodeVersion: "bad", platform: "darwin" })).toThrow(
      /Node.js 22 or later/,
    );
  });

  it("writes error audit entry when Node version check fails", () => {
    try {
      checkPlatformCompatibility({ nodeVersion: "v18.0.0", platform: "darwin" });
    } catch {
      /* expected */
    }
    const calls = vi.mocked(writeAuditEntry).mock.calls;
    const errorEntry = calls.find(
      ([e]) => e.outcome === "error" && e.inputSummary.includes("node-version-too-old"),
    );
    expect(errorEntry).toBeDefined();
  });

  // ── Windows ──

  it("passes on Windows with Git available", () => {
    const runCommand = vi.fn(); // no throw
    const result = checkPlatformCompatibility({
      nodeVersion: "v22.0.0",
      platform: "win32",
      runCommand,
    });
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toContain("Git for Windows — ok");
    expect(runCommand).toHaveBeenCalledWith("git --version");
  });

  it("throws on Windows when Git is missing", () => {
    const runCommand = vi.fn().mockImplementation(() => {
      throw new Error("git not found");
    });
    expect(() =>
      checkPlatformCompatibility({ nodeVersion: "v22.0.0", platform: "win32", runCommand }),
    ).toThrow(/Git for Windows/);
  });

  it("writes error audit entry when Git check fails on Windows", () => {
    const runCommand = vi.fn().mockImplementation(() => {
      throw new Error("not found");
    });
    try {
      checkPlatformCompatibility({ nodeVersion: "v22.0.0", platform: "win32", runCommand });
    } catch {
      /* expected */
    }
    const calls = vi.mocked(writeAuditEntry).mock.calls;
    const errorEntry = calls.find(
      ([e]) => e.outcome === "error" && e.inputSummary.includes("windows:git-not-found"),
    );
    expect(errorEntry).toBeDefined();
  });

  it("does not run Git check on macOS", () => {
    const runCommand = vi.fn();
    checkPlatformCompatibility({ nodeVersion: "v22.0.0", platform: "darwin", runCommand });
    expect(runCommand).not.toHaveBeenCalled();
  });

  // ── Linux ──

  it("passes on Linux with libsecret available", () => {
    const runCommandOutput = vi.fn().mockReturnValue("libsecret-1.so.0 => /usr/lib");
    const result = checkPlatformCompatibility({
      nodeVersion: "v22.0.0",
      platform: "linux",
      runCommandOutput,
    });
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toContain("libsecret — ok");
  });

  it("throws on Linux when libsecret is missing", () => {
    const runCommandOutput = vi.fn().mockImplementation(() => {
      throw new Error("not found");
    });
    expect(() =>
      checkPlatformCompatibility({ nodeVersion: "v22.0.0", platform: "linux", runCommandOutput }),
    ).toThrow(/libsecret/);
  });

  it("thrown error on Linux includes install command", () => {
    const runCommandOutput = vi.fn().mockImplementation(() => {
      throw new Error("not found");
    });
    expect(() =>
      checkPlatformCompatibility({ nodeVersion: "v22.0.0", platform: "linux", runCommandOutput }),
    ).toThrow(/sudo apt install libsecret-1-dev/);
  });

  it("writes error audit entry when libsecret check fails", () => {
    const runCommandOutput = vi.fn().mockImplementation(() => {
      throw new Error("not found");
    });
    try {
      checkPlatformCompatibility({ nodeVersion: "v22.0.0", platform: "linux", runCommandOutput });
    } catch {
      /* expected */
    }
    const calls = vi.mocked(writeAuditEntry).mock.calls;
    const errorEntry = calls.find(
      ([e]) => e.outcome === "error" && e.inputSummary.includes("linux:libsecret-not-found"),
    );
    expect(errorEntry).toBeDefined();
  });

  it("does not run libsecret check on macOS", () => {
    const runCommandOutput = vi.fn().mockReturnValue("");
    checkPlatformCompatibility({ nodeVersion: "v22.0.0", platform: "darwin", runCommandOutput });
    expect(runCommandOutput).not.toHaveBeenCalled();
  });

  // ── Audit log (success path) ──

  it("writes a success audit entry with platform and node version", () => {
    checkPlatformCompatibility({ nodeVersion: "v22.1.0", platform: "darwin" });
    const calls = vi.mocked(writeAuditEntry).mock.calls;
    const successEntry = calls.find(
      ([e]) => e.outcome === "success" && e.inputSummary.includes("platform:darwin"),
    );
    expect(successEntry).toBeDefined();
  });

  it("audit inputSummary includes node version", () => {
    checkPlatformCompatibility({ nodeVersion: "v22.1.0", platform: "darwin" });
    const calls = vi.mocked(writeAuditEntry).mock.calls;
    const successEntry = calls.find(
      ([e]) => e.outcome === "success" && e.inputSummary.includes("node:v22.1.0"),
    );
    expect(successEntry).toBeDefined();
  });

  it("returns the platform and nodeVersion in result", () => {
    const result = checkPlatformCompatibility({ nodeVersion: "v22.1.0", platform: "darwin" });
    expect(result.platform).toBe("darwin");
    expect(result.nodeVersion).toBe("v22.1.0");
  });
});
