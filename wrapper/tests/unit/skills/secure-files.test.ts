/**
 * Unit tests for the secure-files skill.
 *
 * All filesystem operations are injected via mock IFileSystemAdapter.
 * No real disk I/O occurs.
 *
 * Coverage targets:
 *  - validatePath: 100% (path traversal is a critical security boundary)
 *  - Overall skill: 90%+ line coverage
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("../../../security/audit-logger.ts", () => ({
  writeAuditEntry: vi.fn(),
}));

vi.mock("../../../lib/skill-registry.ts", () => ({
  registerSkill: vi.fn(),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { writeAuditEntry } from "../../../security/audit-logger.ts";
import {
  PathValidationError,
  clearWatchersForTesting,
  createSecureFilesSkill,
  getSandboxRoot,
  validatePath,
} from "../../../skills/secure-files/index.ts";
import type { IFileSystemAdapter } from "../../../skills/secure-files/types.ts";
import { clearUndoForTesting, getCurrentUndo } from "../../../undo/registry.ts";

// ── Constants ─────────────────────────────────────────────────────────────────

const SANDBOX = "/home/user/sandbox";

// ── Mock fs factory ───────────────────────────────────────────────────────────

function makeMockFs(overrides: Partial<IFileSystemAdapter> = {}): IFileSystemAdapter {
  return {
    readFile: vi.fn().mockResolvedValue(Buffer.from("file content")),
    writeFile: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
    lstat: vi.fn().mockResolvedValue({ isSymbolicLink: () => false, size: 100 }),
    realpath: vi.fn().mockResolvedValue(`${SANDBOX}/file.txt`),
    stat: vi.fn().mockResolvedValue({
      size: 100,
      isDirectory: () => false,
      mtimeMs: Date.now(),
    }),
    watch: vi.fn().mockReturnValue({ close: vi.fn() }),
    ...overrides,
  };
}

function makeSkill(fsOverrides: Partial<IFileSystemAdapter> = {}) {
  const fs = makeMockFs(fsOverrides);
  const skill = createSecureFilesSkill({
    getSandboxRoot: () => SANDBOX,
    fsAdapter: fs,
  });
  return { skill, fs };
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  clearUndoForTesting();
  clearWatchersForTesting();
});

afterEach(() => {
  clearWatchersForTesting();
});

// ── validatePath (pure — 100% coverage required) ─────────────────────────────

describe("validatePath", () => {
  it("accepts a relative path inside the sandbox", () => {
    const result = validatePath("notes/todo.txt", SANDBOX);
    expect(result).toBe(`${SANDBOX}/notes/todo.txt`);
  });

  it("accepts a path equal to the sandbox root", () => {
    const result = validatePath(".", SANDBOX);
    expect(result).toBe(SANDBOX);
  });

  it("accepts an absolute path that is inside the sandbox", () => {
    const result = validatePath(`${SANDBOX}/file.txt`, SANDBOX);
    expect(result).toBe(`${SANDBOX}/file.txt`);
  });

  it("rejects an empty path", () => {
    expect(() => validatePath("", SANDBOX)).toThrow(PathValidationError);
    expect(() => validatePath("  ", SANDBOX)).toThrow(PathValidationError);
  });

  it("rejects a simple ../ traversal", () => {
    expect(() => validatePath("../secret", SANDBOX)).toThrow(PathValidationError);
  });

  it("rejects a deeply nested traversal", () => {
    expect(() => validatePath("a/b/../../../../../../etc/passwd", SANDBOX)).toThrow(
      PathValidationError,
    );
  });

  it("rejects an absolute path outside the sandbox", () => {
    expect(() => validatePath("/etc/passwd", SANDBOX)).toThrow(PathValidationError);
  });

  it("rejects a path that starts with the sandbox root as a prefix but is actually outside", () => {
    // e.g. sandbox=/home/user/sandbox and path=/home/user/sandbox-evil/file
    expect(() => validatePath("/home/user/sandbox-evil/file", SANDBOX)).toThrow(
      PathValidationError,
    );
  });

  it("normalises redundant separators without escaping", () => {
    const result = validatePath("a//b/../c", SANDBOX);
    expect(result).toBe(`${SANDBOX}/a/c`);
  });

  it("error message includes the offending path", () => {
    let caught: Error | null = null;
    try {
      validatePath("../etc/passwd", SANDBOX);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeInstanceOf(PathValidationError);
    expect(caught?.message).toContain("../etc/passwd");
  });
});

// ── getSandboxRoot ────────────────────────────────────────────────────────────

describe("getSandboxRoot", () => {
  it("returns the resolved ARMORCLAW_SANDBOX_DIR value", () => {
    process.env["ARMORCLAW_SANDBOX_DIR"] = SANDBOX;
    expect(getSandboxRoot()).toBe(SANDBOX);
    delete process.env["ARMORCLAW_SANDBOX_DIR"];
  });

  it("throws when ARMORCLAW_SANDBOX_DIR is not set", () => {
    const saved = process.env["ARMORCLAW_SANDBOX_DIR"];
    delete process.env["ARMORCLAW_SANDBOX_DIR"];
    expect(() => getSandboxRoot()).toThrow(/Sandbox directory not configured/);
    if (saved !== undefined) process.env["ARMORCLAW_SANDBOX_DIR"] = saved;
  });

  it("throws when ARMORCLAW_SANDBOX_DIR is blank", () => {
    process.env["ARMORCLAW_SANDBOX_DIR"] = "   ";
    expect(() => getSandboxRoot()).toThrow(/Sandbox directory not configured/);
    delete process.env["ARMORCLAW_SANDBOX_DIR"];
  });
});

// ── Sandbox root unconfigured ─────────────────────────────────────────────────

describe("unconfigured sandbox", () => {
  it("returns an error when getSandboxRoot throws", async () => {
    const skill = createSecureFilesSkill({
      getSandboxRoot: () => {
        throw new Error("Sandbox not set.");
      },
    });
    const result = await skill.run({ action: "read", path: "file.txt" });
    expect(result.success).toBe(false);
    expect(result.message).toContain("Sandbox not set.");
  });
});

// ── Traversal rejection ───────────────────────────────────────────────────────

describe("path traversal rejection", () => {
  it("rejects traversal on read and logs outcome rejected", async () => {
    const { skill } = makeSkill();
    const result = await skill.run({ action: "read", path: "../outside.txt" });
    expect(result.success).toBe(false);
    expect(result.message).toContain("outside the sandbox");

    const calls = vi.mocked(writeAuditEntry).mock.calls;
    const auditEntry = calls[calls.length - 1][0];
    expect(auditEntry.outcome).toBe("rejected");
  });

  it("rejects traversal on write", async () => {
    const { skill } = makeSkill();
    const result = await skill.run({
      action: "write",
      path: "../../etc/hosts",
      content: "malicious",
    });
    expect(result.success).toBe(false);
    expect(result.message).toContain("outside the sandbox");
  });

  it("rejects traversal on move (source)", async () => {
    const { skill } = makeSkill();
    const result = await skill.run({
      action: "move",
      path: "../../src.txt",
      destPath: "dest.txt",
    });
    expect(result.success).toBe(false);
    expect(result.message).toContain("outside the sandbox");
  });

  it("rejects traversal on move (destination)", async () => {
    const { skill } = makeSkill();
    const result = await skill.run({
      action: "move",
      path: "src.txt",
      destPath: "../../dest.txt",
    });
    expect(result.success).toBe(false);
    expect(result.message).toContain("outside the sandbox");
  });

  it("rejects traversal on delete", async () => {
    const { skill } = makeSkill();
    const result = await skill.run({
      action: "delete",
      path: "../../etc/passwd",
      confirmed: true,
    });
    expect(result.success).toBe(false);
    expect(result.message).toContain("outside the sandbox");
  });

  it("rejects traversal on summarise", async () => {
    const { skill } = makeSkill();
    const result = await skill.run({ action: "summarise", path: "../private.key" });
    expect(result.success).toBe(false);
    expect(result.message).toContain("outside the sandbox");
  });

  it("rejects traversal on watch", async () => {
    const { skill } = makeSkill();
    const result = await skill.run({ action: "watch", path: "../../logs" });
    expect(result.success).toBe(false);
    expect(result.message).toContain("outside the sandbox");
  });

  it("does not call any fs method on traversal rejection", async () => {
    const { skill, fs } = makeSkill();
    await skill.run({ action: "read", path: "../../secret" });
    expect(fs.readFile).not.toHaveBeenCalled();
    expect(fs.stat).not.toHaveBeenCalled();
  });
});

// ── Symlink escape prevention ─────────────────────────────────────────────────

describe("symlink escape prevention", () => {
  it("rejects a symlink pointing outside the sandbox on read", async () => {
    const { skill } = makeSkill({
      lstat: vi.fn().mockResolvedValue({ isSymbolicLink: () => true, size: 0 }),
      realpath: vi.fn().mockResolvedValue("/etc/passwd"),
    });
    const result = await skill.run({ action: "read", path: "link.txt" });
    expect(result.success).toBe(false);
    expect(result.message).toContain("Symlink");
    expect(result.message).toContain("outside the sandbox");
  });

  it("allows a symlink pointing inside the sandbox", async () => {
    const { skill } = makeSkill({
      lstat: vi.fn().mockResolvedValue({ isSymbolicLink: () => true, size: 100 }),
      realpath: vi.fn().mockResolvedValue(`${SANDBOX}/real-file.txt`),
    });
    const result = await skill.run({ action: "read", path: "link.txt" });
    expect(result.success).toBe(true);
  });

  it("passes non-symlink files without calling realpath", async () => {
    const { skill, fs } = makeSkill({
      lstat: vi.fn().mockResolvedValue({ isSymbolicLink: () => false, size: 100 }),
    });
    await skill.run({ action: "read", path: "file.txt" });
    expect(fs.realpath).not.toHaveBeenCalled();
  });

  it("does not reject when lstat throws (path not yet created — write case)", async () => {
    const { skill } = makeSkill({
      lstat: vi.fn().mockRejectedValue(new Error("ENOENT")),
    });
    const result = await skill.run({
      action: "write",
      path: "newfile.txt",
      content: "hello",
    });
    expect(result.success).toBe(true);
  });

  it("rejects symlink escape on write", async () => {
    const { skill } = makeSkill({
      lstat: vi.fn().mockResolvedValue({ isSymbolicLink: () => true, size: 0 }),
      realpath: vi.fn().mockResolvedValue("/tmp/outside"),
    });
    const result = await skill.run({
      action: "write",
      path: "evil-link",
      content: "data",
    });
    expect(result.success).toBe(false);
    expect(result.message).toContain("Symlink");
  });
});

// ── read ──────────────────────────────────────────────────────────────────────

describe("read", () => {
  it("returns file content and metadata", async () => {
    const mtime = Date.now();
    const { skill } = makeSkill({
      readFile: vi.fn().mockResolvedValue(Buffer.from("hello world")),
      stat: vi.fn().mockResolvedValue({ size: 11, isDirectory: () => false, mtimeMs: mtime }),
    });
    const result = await skill.run({ action: "read", path: "file.txt" });
    expect(result.success).toBe(true);
    expect(result.data?.content).toBe("hello world");
    expect(result.data?.fileInfo?.size).toBe(11);
  });

  it("requires a path", async () => {
    const { skill } = makeSkill();
    const result = await skill.run({ action: "read" });
    expect(result.success).toBe(false);
  });

  it("propagates readFile errors", async () => {
    const { skill } = makeSkill({
      readFile: vi.fn().mockRejectedValue(new Error("ENOENT: no such file")),
    });
    const result = await skill.run({ action: "read", path: "missing.txt" });
    expect(result.success).toBe(false);
    expect(result.message).toContain("ENOENT");
  });

  it("logs a success audit entry", async () => {
    const { skill } = makeSkill();
    await skill.run({ action: "read", path: "file.txt" });
    const calls = vi.mocked(writeAuditEntry).mock.calls;
    expect(calls.some(([e]) => e.outcome === "success" && e.inputSummary.startsWith("read:"))).toBe(
      true,
    );
  });
});

// ── write ─────────────────────────────────────────────────────────────────────

describe("write", () => {
  it("requires content", async () => {
    const { skill } = makeSkill();
    const result = await skill.run({ action: "write", path: "file.txt" });
    expect(result.success).toBe(false);
    expect(result.message).toContain("'content'");
  });

  it("writes file and returns success", async () => {
    const { skill, fs } = makeSkill({
      readFile: vi.fn().mockRejectedValue(new Error("ENOENT")), // file doesn't exist yet
    });
    const result = await skill.run({
      action: "write",
      path: "new.txt",
      content: "hello",
    });
    expect(result.success).toBe(true);
    expect(fs.writeFile).toHaveBeenCalledWith(`${SANDBOX}/new.txt`, Buffer.from("hello"));
  });

  it("captures snapshot of existing file before overwrite", async () => {
    const existing = Buffer.from("old content");
    const { skill } = makeSkill({
      readFile: vi.fn().mockResolvedValue(existing),
    });
    await skill.run({ action: "write", path: "file.txt", content: "new content" });

    const undo = getCurrentUndo();
    expect(undo).not.toBeNull();
    const snapshot = undo!.snapshot as { existed: boolean; content: Buffer };
    expect(snapshot.existed).toBe(true);
    expect(snapshot.content).toEqual(existing);
  });

  it("snapshot has existed:false when file is new", async () => {
    const { skill } = makeSkill({
      readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
    });
    await skill.run({ action: "write", path: "new.txt", content: "data" });

    const undo = getCurrentUndo();
    const snapshot = undo!.snapshot as { existed: boolean };
    expect(snapshot.existed).toBe(false);
  });

  it("undo restores previous content for existing file", async () => {
    const existing = Buffer.from("original");
    const { skill, fs } = makeSkill({
      readFile: vi.fn().mockResolvedValue(existing),
    });
    await skill.run({ action: "write", path: "file.txt", content: "updated" });

    vi.clearAllMocks();
    const entry = getCurrentUndo()!;
    await entry.undoFn();

    expect(fs.writeFile).toHaveBeenCalledWith(`${SANDBOX}/file.txt`, existing);
  });

  it("undo deletes file when it was newly created", async () => {
    const { skill, fs } = makeSkill({
      readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
    });
    await skill.run({ action: "write", path: "new.txt", content: "data" });

    vi.clearAllMocks();
    const entry = getCurrentUndo()!;
    await entry.undoFn();

    expect(fs.unlink).toHaveBeenCalledWith(`${SANDBOX}/new.txt`);
  });

  it("undo is idempotent when file already deleted", async () => {
    const { skill, fs } = makeSkill({
      readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
    });
    await skill.run({ action: "write", path: "new.txt", content: "data" });

    (fs.unlink as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("ENOENT"));

    const entry = getCurrentUndo()!;
    await expect(entry.undoFn()).resolves.not.toThrow();
  });

  it("registers undo with actionType file-write", async () => {
    const { skill } = makeSkill({
      readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
    });
    await skill.run({ action: "write", path: "a.txt", content: "x" });
    const undo = getCurrentUndo();
    expect(undo?.actionType).toBe("file-write");
  });
});

// ── move ──────────────────────────────────────────────────────────────────────

describe("move", () => {
  it("requires destPath", async () => {
    const { skill } = makeSkill();
    const result = await skill.run({ action: "move", path: "src.txt" });
    expect(result.success).toBe(false);
    expect(result.message).toContain("'destPath'");
  });

  it("renames the file and returns success", async () => {
    const { skill, fs } = makeSkill();
    const result = await skill.run({
      action: "move",
      path: "src.txt",
      destPath: "dest.txt",
    });
    expect(result.success).toBe(true);
    expect(fs.rename).toHaveBeenCalledWith(`${SANDBOX}/src.txt`, `${SANDBOX}/dest.txt`);
  });

  it("registers undo that moves file back", async () => {
    const { skill, fs } = makeSkill();
    await skill.run({
      action: "move",
      path: "src.txt",
      destPath: "dest.txt",
    });

    vi.clearAllMocks();
    const entry = getCurrentUndo()!;
    await entry.undoFn();

    expect(fs.rename).toHaveBeenCalledWith(`${SANDBOX}/dest.txt`, `${SANDBOX}/src.txt`);
  });

  it("undo is idempotent when rename throws", async () => {
    const { skill, fs } = makeSkill();
    await skill.run({ action: "move", path: "a.txt", destPath: "b.txt" });

    (fs.rename as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("ENOENT"));

    const entry = getCurrentUndo()!;
    await expect(entry.undoFn()).resolves.not.toThrow();
  });

  it("validates both src and dest paths", async () => {
    const { skill } = makeSkill();
    const r1 = await skill.run({ action: "move", path: "../src.txt", destPath: "dest.txt" });
    expect(r1.success).toBe(false);

    const r2 = await skill.run({ action: "move", path: "src.txt", destPath: "../../dest.txt" });
    expect(r2.success).toBe(false);
  });

  it("logs audit on success", async () => {
    const { skill } = makeSkill();
    await skill.run({ action: "move", path: "a.txt", destPath: "b.txt" });
    expect(vi.mocked(writeAuditEntry).mock.calls.some(([e]) => e.outcome === "success")).toBe(true);
  });
});

// ── delete ────────────────────────────────────────────────────────────────────

describe("delete", () => {
  it("returns requiresConfirmation without confirmed flag", async () => {
    const { skill } = makeSkill({
      stat: vi.fn().mockResolvedValue({ size: 512, isDirectory: () => false, mtimeMs: 0 }),
    });
    const result = await skill.run({ action: "delete", path: "file.txt" });
    expect(result.success).toBe(false);
    expect(result.data?.requiresConfirmation).toBe(true);
    expect(result.data?.fileSize).toBe(512);
    expect(result.data?.filePath).toBe(`${SANDBOX}/file.txt`);
  });

  it("confirmation message includes filename and size", async () => {
    const { skill } = makeSkill({
      stat: vi.fn().mockResolvedValue({ size: 1024, isDirectory: () => false, mtimeMs: 0 }),
    });
    const result = await skill.run({ action: "delete", path: "report.pdf" });
    expect(result.message).toContain("report.pdf");
    expect(result.message).toContain("1024");
    expect(result.message).toContain("confirmed: true");
  });

  it("does not call unlink without confirmation", async () => {
    const { skill, fs } = makeSkill();
    await skill.run({ action: "delete", path: "file.txt" });
    expect(fs.unlink).not.toHaveBeenCalled();
  });

  it("executes deletion when confirmed:true", async () => {
    const { skill, fs } = makeSkill({
      stat: vi.fn().mockResolvedValue({ size: 200, isDirectory: () => false, mtimeMs: 0 }),
    });
    const result = await skill.run({
      action: "delete",
      path: "file.txt",
      confirmed: true,
    });
    expect(result.success).toBe(true);
    expect(fs.unlink).toHaveBeenCalledWith(`${SANDBOX}/file.txt`);
  });

  it("returns error when file not found", async () => {
    const { skill } = makeSkill({
      stat: vi.fn().mockRejectedValue(new Error("ENOENT")),
    });
    const result = await skill.run({
      action: "delete",
      path: "missing.txt",
      confirmed: true,
    });
    expect(result.success).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("does NOT register an undo entry", async () => {
    const { skill } = makeSkill({
      stat: vi.fn().mockResolvedValue({ size: 10, isDirectory: () => false, mtimeMs: 0 }),
    });
    await skill.run({ action: "delete", path: "file.txt", confirmed: true });
    expect(getCurrentUndo()).toBeNull();
  });

  it("logs audit on successful delete", async () => {
    const { skill } = makeSkill({
      stat: vi.fn().mockResolvedValue({ size: 50, isDirectory: () => false, mtimeMs: 0 }),
    });
    await skill.run({ action: "delete", path: "file.txt", confirmed: true });
    const entries = vi.mocked(writeAuditEntry).mock.calls.map(([e]) => e);
    expect(
      entries.some((e) => e.outcome === "success" && e.inputSummary.startsWith("delete:")),
    ).toBe(true);
  });
});

// ── summarise ─────────────────────────────────────────────────────────────────

describe("summarise", () => {
  it("returns full content for short files", async () => {
    const { skill } = makeSkill({
      readFile: vi.fn().mockResolvedValue(Buffer.from("short content")),
    });
    const result = await skill.run({ action: "summarise", path: "file.txt" });
    expect(result.success).toBe(true);
    expect(result.data?.summary).toBe("short content");
    expect(result.data?.summary?.endsWith("…")).toBe(false);
  });

  it("truncates at 500 chars and appends ellipsis", async () => {
    const long = "x".repeat(600);
    const { skill } = makeSkill({
      readFile: vi.fn().mockResolvedValue(Buffer.from(long)),
    });
    const result = await skill.run({ action: "summarise", path: "big.txt" });
    expect(result.data?.summary?.length).toBe(501); // 500 + "…"
    expect(result.data?.summary?.endsWith("…")).toBe(true);
  });

  it("returns fileInfo in response", async () => {
    const { skill } = makeSkill({
      readFile: vi.fn().mockResolvedValue(Buffer.from("data")),
      stat: vi.fn().mockResolvedValue({ size: 4, isDirectory: () => false, mtimeMs: 0 }),
    });
    const result = await skill.run({ action: "summarise", path: "file.txt" });
    expect(result.data?.fileInfo?.size).toBe(4);
  });
});

// ── watch / unwatch ───────────────────────────────────────────────────────────

describe("watch", () => {
  it("returns a watcherId", async () => {
    const { skill } = makeSkill();
    const result = await skill.run({ action: "watch", path: "." });
    expect(result.success).toBe(true);
    expect(typeof result.data?.watcherId).toBe("string");
    expect(result.data?.watcherId?.length).toBeGreaterThan(0);
  });

  it("calls fs.watch on the validated path", async () => {
    const { skill, fs } = makeSkill();
    await skill.run({ action: "watch", path: "docs" });
    expect(fs.watch).toHaveBeenCalledWith(`${SANDBOX}/docs`, expect.any(Function));
  });

  it("watch callback writes an audit entry on file change", async () => {
    let capturedCallback: ((event: string, filename: string | null) => void) | null = null;

    const { skill } = makeSkill({
      watch: vi.fn().mockImplementation((_dir, cb) => {
        capturedCallback = cb;
        return { close: vi.fn() };
      }),
    });

    await skill.run({ action: "watch", path: "." });
    vi.clearAllMocks();

    capturedCallback!("change", "readme.txt");

    expect(vi.mocked(writeAuditEntry)).toHaveBeenCalledWith(
      expect.objectContaining({
        skill: "secure-files",
        outcome: "success",
      }),
    );
  });

  it("rejects traversal before setting up watcher", async () => {
    const { skill, fs } = makeSkill();
    const result = await skill.run({ action: "watch", path: "../../etc" });
    expect(result.success).toBe(false);
    expect(fs.watch).not.toHaveBeenCalled();
  });
});

describe("unwatch", () => {
  it("requires watcherId", async () => {
    const { skill } = makeSkill();
    const result = await skill.run({ action: "unwatch" });
    expect(result.success).toBe(false);
    expect(result.message).toContain("'watcherId'");
  });

  it("closes and removes an active watcher", async () => {
    const closeFn = vi.fn();
    const { skill } = makeSkill({
      watch: vi.fn().mockReturnValue({ close: closeFn }),
    });

    const watchResult = await skill.run({ action: "watch", path: "." });
    const watcherId = watchResult.data!.watcherId!;

    const result = await skill.run({ action: "unwatch", watcherId });
    expect(result.success).toBe(true);
    expect(closeFn).toHaveBeenCalled();
  });

  it("returns error for unknown watcherId", async () => {
    const { skill } = makeSkill();
    const result = await skill.run({
      action: "unwatch",
      watcherId: "nonexistent-id",
    });
    expect(result.success).toBe(false);
    expect(result.message).toContain("No active watcher");
  });

  it("returns watcherId in response on success", async () => {
    const { skill } = makeSkill();
    const watchResult = await skill.run({ action: "watch", path: "." });
    const watcherId = watchResult.data!.watcherId!;

    const result = await skill.run({ action: "unwatch", watcherId });
    expect(result.data?.watcherId).toBe(watcherId);
  });
});

// ── Audit logging ─────────────────────────────────────────────────────────────

describe("audit logging", () => {
  it("traversal rejection is logged with outcome rejected", async () => {
    const { skill } = makeSkill();
    await skill.run({ action: "read", path: "../../secret" });

    const entries = vi.mocked(writeAuditEntry).mock.calls.map(([e]) => e);
    expect(entries.some((e) => e.outcome === "rejected")).toBe(true);
  });

  it("all audit entries use skill name secure-files", async () => {
    const { skill } = makeSkill();
    await skill.run({ action: "read", path: "file.txt" });

    const entries = vi.mocked(writeAuditEntry).mock.calls.map(([e]) => e);
    expect(entries.every((e) => e.skill === "secure-files")).toBe(true);
  });

  it("write audit does not include file content in inputSummary", async () => {
    const { skill } = makeSkill({
      readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
    });
    const secret = "my-super-secret-content";
    await skill.run({ action: "write", path: "file.txt", content: secret });

    const entries = vi.mocked(writeAuditEntry).mock.calls.map(([e]) => e);
    expect(entries.some((e) => e.inputSummary.includes(secret))).toBe(false);
  });

  it("permission manifest is included in every audit entry", async () => {
    const { skill } = makeSkill();
    await skill.run({ action: "read", path: "file.txt" });

    const entries = vi.mocked(writeAuditEntry).mock.calls.map(([e]) => e);
    expect(
      entries.every(
        (e) =>
          e.permissionsUsed.includes("read:files") && e.permissionsUsed.includes("write:files"),
      ),
    ).toBe(true);
  });
});
