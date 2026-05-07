/**
 * ArmorClaw skill: Code Agent (code-agent)
 *
 * Spawns a Claude Code CLI session in non-interactive (print) mode to
 * perform coding tasks on the ArmorClaw project. This is the bridge
 * between ArmorClaw's messaging channels (Telegram, WhatsApp, Signal)
 * and full Claude Code coding capabilities.
 *
 * Architecture:
 *  - User sends a coding task via Telegram (or other channel)
 *  - The agent routes it to this skill
 *  - This skill spawns `claude -p` as a child process
 *  - Claude Code reads/writes files, runs tests, etc. within the project
 *  - Output is captured and returned to the user via the channel
 *
 * Security constraints:
 *  - Uses the scoped `exec:claude-cli` permission — not the banned `system:exec`
 *  - Claude Code runs with `--allowedTools` to restrict available tools
 *  - The working directory is validated against ARMORCLAW_PROJECT_ROOT
 *  - Claude Code inherits only the ANTHROPIC_API_KEY env var — no other secrets
 *  - All invocations are logged to the audit log
 *  - The injection filter runs on the prompt before this skill executes
 *  - Timeout enforced via AbortController to prevent runaway sessions
 *
 * Permission manifest: exec:claude-cli, read:files
 */

import { execFile } from "node:child_process";
import * as nodePath from "node:path";
import { registerSkill } from "../../lib/skill-registry.ts";
import { writeAuditEntry } from "../../security/audit-logger.ts";
import { loadPermissionManifest } from "../../security/permissions.ts";
import type { CodeAgentConfig, CodeAgentInput, CodeAgentOutput } from "./types.ts";

// ── Skill metadata ────────────────────────────────────────────────────────────

export const SKILL_NAME = "code-agent";
export const SKILL_VERSION = "1.0.0";
export const PERMISSION_MANIFEST = ["exec:claude-cli", "read:files"] as const;

// ── Default safe tool set ─────────────────────────────────────────────────────

const DEFAULT_ALLOWED_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "Edit",
  "Write",
  "Bash(git:*)",
  "Bash(npm test:*)",
  "Bash(npm run:*)",
  "Bash(npx:*)",
  "Bash(ls:*)",
  "Bash(cat:*)",
  "Bash(head:*)",
  "Bash(tail:*)",
];

const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes
const MAX_TIMEOUT_MS = 600_000; // 10 minutes hard cap
const MAX_OUTPUT_LENGTH = 50_000; // Truncate output for messaging channels

// ── Configuration ─────────────────────────────────────────────────────────────

/**
 * Resolve the code-agent configuration from environment variables.
 *
 * Required env vars:
 *  - ARMORCLAW_PROJECT_ROOT: Absolute path to the project Claude Code operates on.
 *    Falls back to ARMORCLAW_SANDBOX_DIR if not set.
 *  - ANTHROPIC_API_KEY: API key for the Claude Code subprocess.
 *
 * Optional:
 *  - ARMORCLAW_CLAUDE_CLI_PATH: Path to the claude binary (default: "claude")
 */
export function resolveConfig(): CodeAgentConfig {
  const projectRoot = process.env["ARMORCLAW_PROJECT_ROOT"] ?? process.env["ARMORCLAW_SANDBOX_DIR"];

  if (!projectRoot?.trim()) {
    throw new Error(
      "Code agent: project root not configured. Set ARMORCLAW_PROJECT_ROOT or ARMORCLAW_SANDBOX_DIR.",
    );
  }

  const anthropicApiKey = process.env["ANTHROPIC_API_KEY"];
  if (!anthropicApiKey?.trim()) {
    throw new Error("Code agent: ANTHROPIC_API_KEY is required for Claude Code sessions.");
  }

  const cliBinaryPath = process.env["ARMORCLAW_CLAUDE_CLI_PATH"] ?? "claude";

  return {
    projectRoot: nodePath.resolve(projectRoot.trim()),
    cliBinaryPath: cliBinaryPath.trim(),
    anthropicApiKey: anthropicApiKey.trim(),
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    defaultAllowedTools: [...DEFAULT_ALLOWED_TOOLS],
  };
}

// ── Path validation ───────────────────────────────────────────────────────────

/**
 * Validate that a subdirectory stays within the project root.
 * Returns the resolved absolute path.
 */
export function validateSubdir(subdir: string, projectRoot: string): string {
  const resolved = nodePath.resolve(projectRoot, subdir);
  const normalized = nodePath.resolve(projectRoot);

  if (resolved !== normalized && !resolved.startsWith(normalized + nodePath.sep)) {
    throw new Error(`Subdirectory "${subdir}" resolves outside the project root.`);
  }

  return resolved;
}

// ── Core execution ────────────────────────────────────────────────────────────

/**
 * Spawn a Claude Code CLI session and capture the output.
 *
 * Uses `claude -p` (print mode) for non-interactive execution.
 * The process inherits a minimal environment: only ANTHROPIC_API_KEY.
 */
export function spawnClaudeSession(
  prompt: string,
  cwd: string,
  config: CodeAgentConfig,
  options: {
    allowedTools: string[];
    effort: string;
    timeoutMs: number;
  },
): Promise<{ output: string; exitCode: number; timedOut: boolean }> {
  return new Promise((resolve) => {
    const args = [
      "--print",
      "--allowedTools",
      ...options.allowedTools,
      "--effort",
      options.effort,
      prompt,
    ];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const proc = execFile(
      config.cliBinaryPath,
      args,
      {
        cwd,
        env: {
          ANTHROPIC_API_KEY: config.anthropicApiKey,
          HOME: process.env["HOME"] ?? "",
          PATH: process.env["PATH"] ?? "",
          // Node needs this to resolve modules
          NODE_PATH: process.env["NODE_PATH"] ?? "",
        },
        maxBuffer: 10 * 1024 * 1024, // 10 MB
        timeout: options.timeoutMs,
        signal: controller.signal,
      },
      (error, stdoutBuf, stderrBuf) => {
        clearTimeout(timeout);

        stdout = stdoutBuf?.toString() ?? "";
        stderr = stderrBuf?.toString() ?? "";

        if (error && "killed" in error && error.killed) {
          timedOut = true;
        }

        const exitCode = error
          ? ((error as NodeJS.ErrnoException & { code?: number }).code ?? 1)
          : 0;

        resolve({
          output: stdout || stderr,
          exitCode: typeof exitCode === "number" ? exitCode : 1,
          timedOut,
        });
      },
    );

    // Handle abort
    controller.signal.addEventListener("abort", () => {
      timedOut = true;
      proc.kill("SIGTERM");
    });
  });
}

// ── Truncation helper ─────────────────────────────────────────────────────────

function truncateOutput(output: string, maxLength: number = MAX_OUTPUT_LENGTH): string {
  if (output.length <= maxLength) {
    return output;
  }
  const truncated = output.slice(0, maxLength);
  return `${truncated}\n\n[... output truncated at ${maxLength} characters]`;
}

// ── Skill entry points ────────────────────────────────────────────────────────

export async function run(input: CodeAgentInput): Promise<CodeAgentOutput> {
  const start = Date.now();

  // Validate input
  if (!input.prompt?.trim()) {
    return { success: false, message: "A coding task prompt is required." };
  }

  // Resolve config
  let config: CodeAgentConfig;
  try {
    config = resolveConfig();
  } catch (err) {
    return {
      success: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  // Resolve working directory
  let cwd = config.projectRoot;
  if (input.subdir?.trim()) {
    try {
      cwd = validateSubdir(input.subdir, config.projectRoot);
    } catch (err) {
      writeAuditEntry({
        timestamp: new Date().toISOString(),
        skill: SKILL_NAME,
        permissionsUsed: [...PERMISSION_MANIFEST],
        inputSummary: `subdir-rejected:${input.subdir}`.slice(0, 80),
        outcome: "rejected",
        durationMs: Date.now() - start,
      });
      return {
        success: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // Resolve options with defaults
  const allowedTools = input.allowedTools ?? config.defaultAllowedTools;
  const effort = input.effort ?? "high";
  const timeoutMs = Math.min(input.timeoutMs ?? config.defaultTimeoutMs, MAX_TIMEOUT_MS);

  // Audit: starting
  writeAuditEntry({
    timestamp: new Date().toISOString(),
    skill: SKILL_NAME,
    permissionsUsed: [...PERMISSION_MANIFEST],
    inputSummary: input.prompt.slice(0, 80),
    outcome: "success",
    durationMs: 0,
  });

  // Spawn the Claude Code session
  try {
    const result = await spawnClaudeSession(input.prompt, cwd, config, {
      allowedTools,
      effort,
      timeoutMs,
    });

    const durationMs = Date.now() - start;
    const output = truncateOutput(result.output);

    // Audit: completed
    writeAuditEntry({
      timestamp: new Date().toISOString(),
      skill: SKILL_NAME,
      permissionsUsed: [...PERMISSION_MANIFEST],
      inputSummary: input.prompt.slice(0, 80),
      outcome: result.exitCode === 0 ? "success" : "error",
      durationMs,
    });

    if (result.timedOut) {
      return {
        success: false,
        message: `Session timed out after ${Math.round(timeoutMs / 1000)}s. Partial output below.`,
        data: {
          output,
          exitCode: result.exitCode,
          durationMs,
          timedOut: true,
        },
      };
    }

    return {
      success: result.exitCode === 0,
      message:
        result.exitCode === 0
          ? `Coding session completed in ${Math.round(durationMs / 1000)}s.`
          : `Session exited with code ${result.exitCode}.`,
      data: {
        output,
        exitCode: result.exitCode,
        durationMs,
        timedOut: false,
      },
    };
  } catch (err) {
    const durationMs = Date.now() - start;

    writeAuditEntry({
      timestamp: new Date().toISOString(),
      skill: SKILL_NAME,
      permissionsUsed: [...PERMISSION_MANIFEST],
      inputSummary: input.prompt.slice(0, 80),
      outcome: "error",
      durationMs,
    });

    return {
      success: false,
      message: `Failed to start Claude Code session: ${err instanceof Error ? err.message : String(err)}`,
      data: { durationMs, exitCode: 1, timedOut: false },
    };
  }
}

/**
 * Undo is not supported for code-agent sessions.
 * Claude Code modifies files through its own Edit/Write tools, and tracking
 * all possible mutations across a full coding session is not feasible.
 * The user should use git to revert changes if needed.
 */
export async function undo(): Promise<void> {
  // Not undoable — git is the undo mechanism for code changes.
}

// ── Registration ──────────────────────────────────────────────────────────────

registerSkill(
  {
    skillId: SKILL_NAME,
    displayName: "Code agent",
    description:
      "Run Claude Code sessions on your project from any connected channel. Read, edit, test, and commit code remotely.",
    version: SKILL_VERSION,
    author: "bundled",
    permissionManifest: [...PERMISSION_MANIFEST],
    undoable: false,
    recipeEligible: false, // Coding sessions are interactive, not schedulable
    digestMention: true,
  },
  { run, undo },
);

// ── Permission manifest (approval flow) ──────────────────────────────────────

loadPermissionManifest({
  skillId: SKILL_NAME,
  allowedTools: ["exec", "process", "read", "write", "edit", "sessions_spawn", "sessions_yield"],
  allowedPermissions: [...PERMISSION_MANIFEST],
});
