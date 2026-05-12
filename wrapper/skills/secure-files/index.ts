/**
 * ArmorClaw skill: Secure file access (secure-files)
 *
 * Capabilities:
 *  - read:       Read a file within the sandbox
 *  - write:      Write a file within the sandbox (snapshot → undo)
 *  - move:       Rename / move a file within the sandbox (snapshot → undo)
 *  - delete:     Delete a file — requires explicit confirmation; NOT undoable
 *  - summarise:  Return the first 500 chars of a file as a preview
 *  - watch:      Set up an fs.watch listener on a sandbox directory
 *  - unwatch:    Close an active watcher by id
 *
 * Security constraints:
 *  - Sandbox root read from ARMORCLAW_SANDBOX_DIR at runtime — never hardcoded
 *  - ALL path inputs validated with path.resolve against the sandbox root
 *  - Traversal attempts (../) are rejected and logged with outcome "rejected"
 *  - Symlinks are followed only if their real path stays within the sandbox
 *  - Delete requires confirmed:true — never auto-executes
 *  - File delete is NOT undoable (confirmation is the safety mechanism)
 *
 * Undo: write and move register a 60s undo window capturing the pre-op state.
 *
 * Permission manifest: read:files, write:files
 */

import * as fsSync from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as nodePath from "node:path";
import { registerSkill } from "../../lib/skill-registry.ts";
import { writeAuditEntry } from "../../security/audit-logger.ts";
import { loadPermissionManifest } from "../../security/permissions.ts";
import { registerUndo } from "../../undo/registry.ts";
import type {
  FileInfo,
  FileSnapshot,
  IFileSystemAdapter,
  MoveSnapshot,
  SecureFilesInput,
  SecureFilesOutput,
} from "./types.ts";

// ── Skill metadata ────────────────────────────────────────────────────────────

export const SKILL_NAME = "secure-files";
export const SKILL_VERSION = "1.0.0";
export const PERMISSION_MANIFEST = ["read:files", "write:files"] as const;

const SUMMARY_MAX_CHARS = 500;

// ── Path validation errors ────────────────────────────────────────────────────

/**
 * Thrown when a path input fails sandbox validation.
 * Caught in the dispatcher and logged with outcome "rejected".
 */
export class PathValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathValidationError";
  }
}

// ── Path validation (pure — exported for 100% unit-test coverage) ─────────────

/**
 * Resolve `inputPath` relative to `sandboxRoot` and verify the result stays
 * within the sandbox.
 *
 * - Uses `path.resolve(sandboxRoot, inputPath)` to canonicalise.
 * - Accepts both relative paths and absolute paths that are already inside the
 *   sandbox (e.g. when the caller pre-resolves them).
 * - Rejects anything that resolves to a location outside the sandbox, including
 *   `../` traversals and absolute paths to other directories.
 *
 * @throws PathValidationError on any violation.
 * @returns The validated, resolved absolute path.
 */
export function validatePath(inputPath: string, sandboxRoot: string): string {
  if (!inputPath || !inputPath.trim()) {
    throw new PathValidationError("Path is required.");
  }

  if (inputPath.includes("\0")) {
    throw new PathValidationError(`Path "${inputPath}" rejected: null-byte.`);
  }

  const normalizedRoot = nodePath.resolve(sandboxRoot);
  const resolved = nodePath.resolve(normalizedRoot, inputPath);

  // Must equal sandbox root or be a direct descendant
  if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot + nodePath.sep)) {
    throw new PathValidationError(`Path "${inputPath}" resolves outside the sandbox.`);
  }

  return resolved;
}

// ── Symlink escape check ──────────────────────────────────────────────────────

/**
 * If `resolvedPath` is a symlink, verify its real target stays within the
 * sandbox. Silently returns when the path does not yet exist (valid for writes).
 *
 * @throws PathValidationError when a symlink escapes the sandbox.
 */
async function assertNotSymlinkEscape(
  resolvedPath: string,
  sandboxRoot: string,
  fs: IFileSystemAdapter,
): Promise<void> {
  let lstat: { isSymbolicLink(): boolean };
  try {
    lstat = await fs.lstat(resolvedPath);
  } catch {
    // Path does not exist — acceptable for write/move destinations
    return;
  }

  if (!lstat.isSymbolicLink()) {
    return;
  }

  const real = await fs.realpath(resolvedPath);
  const normalizedRoot = nodePath.resolve(sandboxRoot);

  if (real !== normalizedRoot && !real.startsWith(normalizedRoot + nodePath.sep)) {
    throw new PathValidationError(
      `Symlink at "${resolvedPath}" points outside the sandbox to "${real}".`,
    );
  }
}

// ── Sandbox root ──────────────────────────────────────────────────────────────

/**
 * Read the sandbox root from the environment.
 *
 * @throws Error when ARMORCLAW_SANDBOX_DIR is not set.
 */
export function getSandboxRoot(): string {
  const dir = process.env["ARMORCLAW_SANDBOX_DIR"];
  if (!dir || !dir.trim()) {
    throw new Error("Sandbox directory not configured. Set ARMORCLAW_SANDBOX_DIR in Settings.");
  }
  return nodePath.resolve(dir.trim());
}

// ── Real filesystem adapter ───────────────────────────────────────────────────

const realFsAdapter: IFileSystemAdapter = {
  readFile: (p) => fsPromises.readFile(p),
  writeFile: (p, content) => fsPromises.writeFile(p, content),
  rename: (src, dest) => fsPromises.rename(src, dest),
  unlink: (p) => fsPromises.unlink(p),
  lstat: (p) => fsPromises.lstat(p),
  realpath: (p) => fsPromises.realpath(p),
  stat: (p) => fsPromises.stat(p),
  watch: (dir, cb) =>
    fsSync.watch(dir, { recursive: true }, (event, filename) => cb(event, filename)),
};

// ── Active watchers (module-level, survives factory re-creation) ──────────────

const activeWatchers = new Map<string, { close(): void }>();

/** Clear all watchers. Intended for test isolation only. */
export function clearWatchersForTesting(): void {
  for (const w of activeWatchers.values()) {
    try {
      w.close();
    } catch {
      // Ignore
    }
  }
  activeWatchers.clear();
}

// ── Skill factory (injectable for tests) ─────────────────────────────────────

export interface SecureFilesOptions {
  getSandboxRoot?: () => string;
  fsAdapter?: IFileSystemAdapter;
}

export function createSecureFilesSkill(options: SecureFilesOptions = {}): {
  run: (input: SecureFilesInput) => Promise<SecureFilesOutput>;
  undo: () => Promise<void>;
} {
  const resolveSandboxRoot = options.getSandboxRoot ?? getSandboxRoot;
  const fs = options.fsAdapter ?? realFsAdapter;

  return {
    run: (input) => runWithDeps(input, resolveSandboxRoot, fs),
    undo,
  };
}

// ── Exported skill entrypoints ────────────────────────────────────────────────

export async function run(input: SecureFilesInput): Promise<SecureFilesOutput> {
  return runWithDeps(input, getSandboxRoot, realFsAdapter);
}

export async function undo(): Promise<void> {
  // No-op: individual write/move undos are registered as closures in their handlers.
}

// ── Audit helper ──────────────────────────────────────────────────────────────

function auditFileOp(
  action: string,
  resolvedPath: string,
  outcome: "success" | "error" | "rejected",
  durationMs: number,
  detail = "",
): void {
  const name = nodePath.basename(resolvedPath);
  const summary = `${action}:${name}${detail ? ":" + detail : ""}`.slice(0, 80);
  writeAuditEntry({
    timestamp: new Date().toISOString(),
    skill: SKILL_NAME,
    permissionsUsed: [...PERMISSION_MANIFEST],
    inputSummary: summary,
    outcome,
    durationMs,
  });
}

// ── Action dispatcher ─────────────────────────────────────────────────────────

async function runWithDeps(
  input: SecureFilesInput,
  resolveSandboxRoot: () => string,
  fs: IFileSystemAdapter,
): Promise<SecureFilesOutput> {
  const start = Date.now();

  // Resolve sandbox root eagerly — fail fast if not configured
  let sandboxRoot: string;
  try {
    sandboxRoot = resolveSandboxRoot();
  } catch (err) {
    return {
      success: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  try {
    switch (input.action) {
      case "read":
        return await handleRead(input, sandboxRoot, fs);
      case "write":
        return await handleWrite(input, sandboxRoot, fs);
      case "move":
        return await handleMove(input, sandboxRoot, fs);
      case "delete":
        return await handleDelete(input, sandboxRoot, fs);
      case "summarise":
        return await handleSummarise(input, sandboxRoot, fs);
      case "watch":
        return await handleWatch(input, sandboxRoot, fs);
      case "unwatch":
        return await handleUnwatch(input);
      default: {
        const exhaustive: never = input.action;
        return {
          success: false,
          message: `Unknown action: ${String(exhaustive)}`,
        };
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isTraversal = err instanceof PathValidationError;

    writeAuditEntry({
      timestamp: new Date().toISOString(),
      skill: SKILL_NAME,
      permissionsUsed: [...PERMISSION_MANIFEST],
      inputSummary: `action:${input.action}:error`.slice(0, 80),
      outcome: isTraversal ? "rejected" : "error",
      durationMs: Date.now() - start,
    });

    return { success: false, message };
  }
}

// ── Action handlers ───────────────────────────────────────────────────────────

async function handleRead(
  input: SecureFilesInput,
  sandboxRoot: string,
  fs: IFileSystemAdapter,
): Promise<SecureFilesOutput> {
  const start = Date.now();
  const resolved = validatePath(input.path ?? "", sandboxRoot);
  await assertNotSymlinkEscape(resolved, sandboxRoot, fs);

  const buf = await fs.readFile(resolved);
  const content = buf.toString("utf8");
  const stat = await fs.stat(resolved);

  const fileInfo: FileInfo = {
    path: resolved,
    size: stat.size,
    isDirectory: stat.isDirectory(),
    modifiedAt: new Date(stat.mtimeMs).toISOString(),
  };

  auditFileOp("read", resolved, "success", Date.now() - start);

  return {
    success: true,
    message: `Read ${nodePath.basename(resolved)} (${stat.size} bytes).`,
    data: { content, fileInfo },
  };
}

async function handleWrite(
  input: SecureFilesInput,
  sandboxRoot: string,
  fs: IFileSystemAdapter,
): Promise<SecureFilesOutput> {
  if (input.content === undefined) {
    return { success: false, message: "write requires 'content'." };
  }

  const start = Date.now();
  const resolved = validatePath(input.path ?? "", sandboxRoot);
  await assertNotSymlinkEscape(resolved, sandboxRoot, fs);

  // Capture snapshot synchronously before writing — required for undo
  let snapshot: FileSnapshot;
  try {
    const existing = await fs.readFile(resolved);
    snapshot = { path: resolved, content: existing, existed: true };
  } catch {
    snapshot = { path: resolved, content: null, existed: false };
  }

  const contentBuf = Buffer.from(input.content, "utf8");
  await fs.writeFile(resolved, contentBuf);

  auditFileOp("write", resolved, "success", Date.now() - start);

  registerUndo({
    actionType: "file-write",
    skill: SKILL_NAME,
    snapshot,
    undoFn: async () => {
      if (snapshot.existed && snapshot.content !== null) {
        // Restore previous content
        await fs.writeFile(snapshot.path, snapshot.content);
      } else {
        // File was new — delete it on undo (idempotent)
        try {
          await fs.unlink(snapshot.path);
        } catch {
          // Already gone — idempotent
        }
      }
    },
  });

  return {
    success: true,
    message: `Wrote ${contentBuf.length} bytes to ${nodePath.basename(resolved)}.`,
    data: { filePath: resolved, fileSize: contentBuf.length },
  };
}

async function handleMove(
  input: SecureFilesInput,
  sandboxRoot: string,
  fs: IFileSystemAdapter,
): Promise<SecureFilesOutput> {
  if (!input.destPath?.trim()) {
    return { success: false, message: "move requires a 'destPath'." };
  }

  const start = Date.now();
  const srcResolved = validatePath(input.path ?? "", sandboxRoot);
  const destResolved = validatePath(input.destPath, sandboxRoot);

  await assertNotSymlinkEscape(srcResolved, sandboxRoot, fs);
  await assertNotSymlinkEscape(destResolved, sandboxRoot, fs);

  const snapshot: MoveSnapshot = { srcPath: srcResolved, destPath: destResolved };

  await fs.rename(srcResolved, destResolved);

  auditFileOp(
    "move",
    srcResolved,
    "success",
    Date.now() - start,
    `to:${nodePath.basename(destResolved)}`,
  );

  registerUndo({
    actionType: "file-write",
    skill: SKILL_NAME,
    snapshot,
    undoFn: async () => {
      // Move back: dest → src (idempotent on error)
      try {
        await fs.rename(destResolved, srcResolved);
      } catch {
        // Already moved back or gone — idempotent
      }
    },
  });

  return {
    success: true,
    message: `Moved ${nodePath.basename(srcResolved)} → ${nodePath.basename(destResolved)}.`,
    data: { filePath: destResolved },
  };
}

async function handleDelete(
  input: SecureFilesInput,
  sandboxRoot: string,
  fs: IFileSystemAdapter,
): Promise<SecureFilesOutput> {
  const start = Date.now();
  const resolved = validatePath(input.path ?? "", sandboxRoot);

  // Stat first so we can show the file info in the confirmation prompt
  let size = 0;
  try {
    const stat = await fs.stat(resolved);
    size = stat.size;
  } catch {
    return {
      success: false,
      message: `File not found: ${nodePath.basename(resolved)}`,
    };
  }

  // Require explicit confirmation — never auto-delete
  if (!input.confirmed) {
    return {
      success: false,
      message: `Delete requires confirmation. File: ${nodePath.basename(resolved)} (${size} bytes). Set confirmed: true to proceed.`,
      data: {
        requiresConfirmation: true,
        filePath: resolved,
        fileSize: size,
      },
    };
  }

  await assertNotSymlinkEscape(resolved, sandboxRoot, fs);
  await fs.unlink(resolved);

  auditFileOp("delete", resolved, "success", Date.now() - start, `size:${size}`);

  return {
    success: true,
    message: `Deleted ${nodePath.basename(resolved)} (${size} bytes).`,
    data: { filePath: resolved, fileSize: size },
  };
}

async function handleSummarise(
  input: SecureFilesInput,
  sandboxRoot: string,
  fs: IFileSystemAdapter,
): Promise<SecureFilesOutput> {
  const start = Date.now();
  const resolved = validatePath(input.path ?? "", sandboxRoot);
  await assertNotSymlinkEscape(resolved, sandboxRoot, fs);

  const buf = await fs.readFile(resolved);
  const full = buf.toString("utf8");
  const summary = full.length > SUMMARY_MAX_CHARS ? full.slice(0, SUMMARY_MAX_CHARS) + "…" : full;

  const stat = await fs.stat(resolved);

  auditFileOp("summarise", resolved, "success", Date.now() - start);

  return {
    success: true,
    message: `Summary of ${nodePath.basename(resolved)} (${stat.size} bytes).`,
    data: {
      summary,
      fileInfo: {
        path: resolved,
        size: stat.size,
        isDirectory: stat.isDirectory(),
        modifiedAt: new Date(stat.mtimeMs).toISOString(),
      },
    },
  };
}

async function handleWatch(
  input: SecureFilesInput,
  sandboxRoot: string,
  fs: IFileSystemAdapter,
): Promise<SecureFilesOutput> {
  const resolved = validatePath(input.path ?? "", sandboxRoot);
  await assertNotSymlinkEscape(resolved, sandboxRoot, fs);

  const watcherId = crypto.randomUUID();

  const watcher = fs.watch(resolved, (event, filename) => {
    writeAuditEntry({
      timestamp: new Date().toISOString(),
      skill: SKILL_NAME,
      permissionsUsed: [...PERMISSION_MANIFEST],
      inputSummary: `watch-event:${event}:${filename ?? "unknown"}`.slice(0, 80),
      outcome: "success",
      durationMs: 0,
    });
  });

  activeWatchers.set(watcherId, watcher);

  return {
    success: true,
    message: `Watching "${nodePath.basename(resolved)}" for changes (id: ${watcherId}).`,
    data: { watcherId },
  };
}

async function handleUnwatch(input: SecureFilesInput): Promise<SecureFilesOutput> {
  if (!input.watcherId?.trim()) {
    return { success: false, message: "unwatch requires a 'watcherId'." };
  }

  const watcher = activeWatchers.get(input.watcherId);
  if (!watcher) {
    return {
      success: false,
      message: `No active watcher found for id: ${input.watcherId}.`,
    };
  }

  watcher.close();
  activeWatchers.delete(input.watcherId);

  return {
    success: true,
    message: `Stopped watching (id: ${input.watcherId}).`,
    data: { watcherId: input.watcherId },
  };
}

// ── Registration ──────────────────────────────────────────────────────────────

registerSkill(
  {
    skillId: SKILL_NAME,
    displayName: "Secure file access",
    description:
      "Read, write, move, and delete files within your sandbox directory. Summarise contents and watch for changes.",
    version: SKILL_VERSION,
    author: "bundled",
    permissionManifest: [...PERMISSION_MANIFEST],
    undoable: true,
    recipeEligible: true,
    digestMention: true,
  },
  { run, undo },
);

// ── Permission manifest (approval flow) ──────────────────────────────────────

loadPermissionManifest({
  skillId: SKILL_NAME,
  allowedTools: ["read", "write", "edit"],
  allowedPermissions: [...PERMISSION_MANIFEST],
});
