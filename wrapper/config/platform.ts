/**
 * Platform compatibility checks — run at daemon startup.
 *
 * Responsibilities:
 *  1. Enforce Node.js 22+ (throws on older versions).
 *  2. Windows: verify Git for Windows is installed.
 *  3. Linux: check for libsecret before keytar can initialise.
 *  4. All platforms: emit platform metadata to the audit log for diagnostics.
 *
 * All checks are synchronous and complete before any skill or hook is registered.
 */

import { execSync } from "node:child_process";
import { writeAuditEntry } from "../security/audit-logger.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PlatformCheckResult {
  platform: NodeJS.Platform;
  nodeVersion: string;
  /** True if all checks passed without throwing. */
  ok: boolean;
  /** Human-readable diagnostics, one entry per check performed. */
  diagnostics: string[];
}

// ── Node version ──────────────────────────────────────────────────────────────

/**
 * Parse the major version number from a Node.js version string such as "v22.1.0".
 * Returns NaN if the string is malformed.
 */
export function parseNodeMajor(versionString: string): number {
  const match = /^v?(\d+)/.exec(versionString);
  return match ? parseInt(match[1], 10) : NaN;
}

// ── Platform-specific checks ──────────────────────────────────────────────────

/**
 * Returns true when `git` is found on PATH (Windows-only check).
 * Uses an injectable `runCommand` so the check can be tested without spawning.
 */
export function isGitAvailable(
  runCommand: (cmd: string) => void = (cmd) => execSync(cmd, { stdio: "ignore" }),
): boolean {
  try {
    runCommand("git --version");
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns true when libsecret is found on the system (Linux-only check).
 * Checks for `libsecret-1.so` via ldconfig; falls back to a file probe on
 * systems without ldconfig (e.g. Alpine/busybox).
 *
 * Uses an injectable `runCommand` so the check can be tested without spawning.
 */
export function isLibsecretAvailable(
  runCommand: (cmd: string) => string = (cmd) =>
    execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }),
): boolean {
  try {
    const output = runCommand("ldconfig -p 2>/dev/null || echo ''");
    if (output.includes("libsecret-1.so")) {
      return true;
    }
  } catch {
    /* ldconfig absent — fall through to file probe */
  }
  // Minimal file-existence probe for systems without ldconfig
  try {
    runCommand(
      "ls /usr/lib/x86_64-linux-gnu/libsecret-1.so* 2>/dev/null || ls /usr/lib/libsecret-1.so* 2>/dev/null",
    );
    return true;
  } catch {
    return false;
  }
}

// ── Main entry point ──────────────────────────────────────────────────────────

export interface PlatformCheckOptions {
  /** Override process.version (test injection). */
  nodeVersion?: string;
  /** Override process.platform (test injection). */
  platform?: NodeJS.Platform;
  /** Override the command runner for isGitAvailable. */
  runCommand?: (cmd: string) => void;
  /** Override the command runner for isLibsecretAvailable. */
  runCommandOutput?: (cmd: string) => string;
}

/**
 * Run all platform compatibility checks.
 *
 * Throws `Error` if a hard requirement is not met (Node version, missing
 * Git on Windows, missing libsecret on Linux). Returns a `PlatformCheckResult`
 * on success.
 *
 * Also writes an audit entry with platform metadata — this is always emitted
 * regardless of outcome so that support can diagnose issues without asking
 * the user what OS they are on.
 */
export function checkPlatformCompatibility(
  options: PlatformCheckOptions = {},
): PlatformCheckResult {
  const nodeVersion = options.nodeVersion ?? process.version;
  const platform = options.platform ?? process.platform;
  const diagnostics: string[] = [];

  // 1. Node.js version check (all platforms)
  const major = parseNodeMajor(nodeVersion);
  if (isNaN(major) || major < 22) {
    const msg = `ArmorClaw requires Node.js 22 or later. You are running ${nodeVersion}. Please upgrade Node.js and restart.`;
    writeAuditEntry({
      timestamp: new Date().toISOString(),
      skill: "platform-check",
      permissionsUsed: [],
      inputSummary: `node-version-too-old:${nodeVersion}`.slice(0, 80),
      outcome: "error",
      durationMs: 0,
    });
    throw new Error(msg);
  }
  diagnostics.push(`Node.js ${nodeVersion} — ok`);

  // 2. Windows: Git for Windows
  if (platform === "win32") {
    const gitOk = isGitAvailable(options.runCommand as ((cmd: string) => void) | undefined);
    if (!gitOk) {
      const msg =
        "ArmorClaw requires Git for Windows to be installed. " +
        "Download it from https://git-scm.com/download/win and restart.";
      writeAuditEntry({
        timestamp: new Date().toISOString(),
        skill: "platform-check",
        permissionsUsed: [],
        inputSummary: "windows:git-not-found".slice(0, 80),
        outcome: "error",
        durationMs: 0,
      });
      throw new Error(msg);
    }
    diagnostics.push("Git for Windows — ok");
  }

  // 3. Linux: libsecret (keytar dependency)
  if (platform === "linux") {
    const libsecretOk = isLibsecretAvailable(
      options.runCommandOutput as ((cmd: string) => string) | undefined,
    );
    if (!libsecretOk) {
      const msg =
        "ArmorClaw needs libsecret to store your credentials safely. " +
        "Install it with: sudo apt install libsecret-1-dev";
      writeAuditEntry({
        timestamp: new Date().toISOString(),
        skill: "platform-check",
        permissionsUsed: [],
        inputSummary: "linux:libsecret-not-found".slice(0, 80),
        outcome: "error",
        durationMs: 0,
      });
      throw new Error(msg);
    }
    diagnostics.push("libsecret — ok");
  }

  // 4. Emit platform metadata to audit log for diagnostics
  writeAuditEntry({
    timestamp: new Date().toISOString(),
    skill: "platform-check",
    permissionsUsed: [],
    inputSummary: `platform:${platform}:node:${nodeVersion}`.slice(0, 80),
    outcome: "success",
    durationMs: 0,
  });

  return { platform, nodeVersion, ok: true, diagnostics };
}
