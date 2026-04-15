/**
 * Unit tests for the code-agent skill.
 *
 * The claude CLI subprocess is mocked via vi.mock("node:child_process").
 * No real processes are spawned.
 *
 * Coverage targets:
 *  - resolveConfig: 100% (env validation is critical)
 *  - validateSubdir: 100% (path traversal prevention)
 *  - run(): all success/error/timeout branches
 *  - Overall: 90%+ line coverage
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("../../../security/audit-logger.ts", () => ({
  writeAuditEntry: vi.fn(),
}));

vi.mock("../../../lib/skill-registry.ts", () => ({
  registerSkill: vi.fn(),
}));

// Mock child_process.execFile
const mockExecFile = vi.fn();
vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { writeAuditEntry } from "../../../security/audit-logger.ts";
import {
  PERMISSION_MANIFEST,
  SKILL_NAME,
  SKILL_VERSION,
  resolveConfig,
  run,
  undo,
  validateSubdir,
} from "../../../skills/code-agent/index.ts";

// ── Setup/teardown ──────────────────────────────────────────────────────────

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env["ARMORCLAW_PROJECT_ROOT"] = "/home/user/armorclaw";
  process.env["ANTHROPIC_API_KEY"] = "sk-ant-test-key-123";
  process.env["HOME"] = "/home/user";
  process.env["PATH"] = "/usr/bin:/usr/local/bin";
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

// ── Metadata ──────────────────────────────────────────────────────────────────

describe("skill metadata", () => {
  it("exports correct name and version", () => {
    expect(SKILL_NAME).toBe("code-agent");
    expect(SKILL_VERSION).toBe("1.0.0");
  });

  it("declares exec:claude-cli and read:files permissions", () => {
    expect(PERMISSION_MANIFEST).toContain("exec:claude-cli");
    expect(PERMISSION_MANIFEST).toContain("read:files");
  });

  it("does not declare any hard-banned permissions", () => {
    const banned = ["system:root", "system:exec", "files:global"];
    for (const level of PERMISSION_MANIFEST) {
      expect(banned).not.toContain(level);
    }
  });
});

// ── resolveConfig ─────────────────────────────────────────────────────────────

describe("resolveConfig", () => {
  it("resolves config from environment variables", () => {
    const config = resolveConfig();
    expect(config.projectRoot).toBe("/home/user/armorclaw");
    expect(config.anthropicApiKey).toBe("sk-ant-test-key-123");
    expect(config.cliBinaryPath).toBe("claude");
    expect(config.defaultTimeoutMs).toBe(300_000);
  });

  it("falls back to ARMORCLAW_SANDBOX_DIR when PROJECT_ROOT is not set", () => {
    delete process.env["ARMORCLAW_PROJECT_ROOT"];
    process.env["ARMORCLAW_SANDBOX_DIR"] = "/home/user/sandbox";
    const config = resolveConfig();
    expect(config.projectRoot).toBe("/home/user/sandbox");
  });

  it("uses custom CLI path when ARMORCLAW_CLAUDE_CLI_PATH is set", () => {
    process.env["ARMORCLAW_CLAUDE_CLI_PATH"] = "/opt/bin/claude";
    const config = resolveConfig();
    expect(config.cliBinaryPath).toBe("/opt/bin/claude");
  });

  it("throws when neither PROJECT_ROOT nor SANDBOX_DIR is set", () => {
    delete process.env["ARMORCLAW_PROJECT_ROOT"];
    delete process.env["ARMORCLAW_SANDBOX_DIR"];
    expect(() => resolveConfig()).toThrow("project root not configured");
  });

  it("throws when ANTHROPIC_API_KEY is not set", () => {
    delete process.env["ANTHROPIC_API_KEY"];
    expect(() => resolveConfig()).toThrow("ANTHROPIC_API_KEY is required");
  });

  it("throws when ANTHROPIC_API_KEY is empty/whitespace", () => {
    process.env["ANTHROPIC_API_KEY"] = "   ";
    expect(() => resolveConfig()).toThrow("ANTHROPIC_API_KEY is required");
  });
});

// ── validateSubdir ────────────────────────────────────────────────────────────

describe("validateSubdir", () => {
  const root = "/home/user/armorclaw";

  it("accepts a valid relative subdirectory", () => {
    expect(validateSubdir("wrapper/skills", root)).toBe("/home/user/armorclaw/wrapper/skills");
  });

  it("accepts the root itself (empty-ish)", () => {
    expect(validateSubdir(".", root)).toBe(root);
  });

  it("rejects traversal attempts", () => {
    expect(() => validateSubdir("../../../etc/passwd", root)).toThrow(
      "resolves outside the project root",
    );
  });

  it("rejects absolute paths outside root", () => {
    expect(() => validateSubdir("/etc/passwd", root)).toThrow("resolves outside the project root");
  });

  it("accepts nested paths within root", () => {
    expect(validateSubdir("wrapper/security", root)).toBe("/home/user/armorclaw/wrapper/security");
  });
});

// ── run() ─────────────────────────────────────────────────────────────────────

describe("run", () => {
  /**
   * Helper: set up mockExecFile to simulate a Claude Code session.
   * The callback signature matches execFile(cmd, args, opts, callback).
   */
  function simulateClaudeSession(stdout: string, stderr: string, error: Error | null = null): void {
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: Record<string, unknown>,
        callback: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        // Simulate async completion
        setTimeout(() => callback(error, stdout, stderr), 10);
        return { kill: vi.fn() };
      },
    );
  }

  it("returns error when prompt is empty", async () => {
    const result = await run({ prompt: "" });
    expect(result.success).toBe(false);
    expect(result.message).toContain("prompt is required");
  });

  it("returns error when prompt is whitespace only", async () => {
    const result = await run({ prompt: "   " });
    expect(result.success).toBe(false);
    expect(result.message).toContain("prompt is required");
  });

  it("executes a successful Claude Code session", async () => {
    simulateClaudeSession("Fixed the bug in line 42.", "");

    const result = await run({ prompt: "fix the bug in foo.ts" });

    expect(result.success).toBe(true);
    expect(result.message).toContain("completed");
    expect(result.data?.output).toContain("Fixed the bug");
    expect(result.data?.exitCode).toBe(0);
    expect(result.data?.timedOut).toBe(false);
  });

  it("passes the prompt as the last CLI argument", async () => {
    simulateClaudeSession("done", "");

    await run({ prompt: "add error handling to parser.ts" });

    expect(mockExecFile).toHaveBeenCalledOnce();
    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args[args.length - 1]).toBe("add error handling to parser.ts");
  });

  it("uses --print flag for non-interactive mode", async () => {
    simulateClaudeSession("done", "");

    await run({ prompt: "list all files" });

    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args).toContain("--print");
  });

  it("passes allowedTools to the CLI", async () => {
    simulateClaudeSession("done", "");

    await run({ prompt: "read foo.ts", allowedTools: ["Read", "Glob"] });

    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args).toContain("--allowedTools");
    expect(args).toContain("Read");
    expect(args).toContain("Glob");
  });

  it("passes effort level to the CLI", async () => {
    simulateClaudeSession("done", "");

    await run({ prompt: "quick check", effort: "low" });

    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args).toContain("--effort");
    expect(args).toContain("low");
  });

  it("sets working directory to project root", async () => {
    simulateClaudeSession("done", "");

    await run({ prompt: "check the code" });

    const opts = mockExecFile.mock.calls[0][2] as Record<string, unknown>;
    expect(opts.cwd).toBe("/home/user/armorclaw");
  });

  it("uses validated subdir as working directory", async () => {
    simulateClaudeSession("done", "");

    await run({ prompt: "check wrapper", subdir: "wrapper" });

    const opts = mockExecFile.mock.calls[0][2] as Record<string, unknown>;
    expect(opts.cwd).toBe("/home/user/armorclaw/wrapper");
  });

  it("rejects traversal in subdir", async () => {
    const result = await run({ prompt: "hack", subdir: "../../etc" });
    expect(result.success).toBe(false);
    expect(result.message).toContain("outside the project root");
  });

  it("only passes ANTHROPIC_API_KEY, HOME, PATH, and NODE_PATH to subprocess", async () => {
    simulateClaudeSession("done", "");

    await run({ prompt: "check" });

    const opts = mockExecFile.mock.calls[0][2] as Record<string, unknown>;
    const env = opts.env as Record<string, string>;
    const keys = Object.keys(env);
    expect(keys).toContain("ANTHROPIC_API_KEY");
    expect(keys).toContain("HOME");
    expect(keys).toContain("PATH");
    expect(keys).toContain("NODE_PATH");
    // Should NOT contain other secrets
    expect(keys).not.toContain("TELEGRAM_BOT_TOKEN");
    expect(keys).not.toContain("GOOGLE_OAUTH_CLIENT_ID");
    expect(keys).not.toContain("ARMORCLAW_GATEWAY_TOKEN");
  });

  it("handles non-zero exit code", async () => {
    const err = new Error("process exited with code 1") as Error & { code: number };
    err.code = 1;
    simulateClaudeSession("", "Error: file not found", err);

    const result = await run({ prompt: "edit missing.ts" });

    expect(result.success).toBe(false);
    expect(result.message).toContain("exited with code");
  });

  it("returns stderr when stdout is empty", async () => {
    const err = new Error("fail") as Error & { code: number };
    err.code = 1;
    simulateClaudeSession("", "Something went wrong", err);

    const result = await run({ prompt: "break things" });
    expect(result.data?.output).toContain("Something went wrong");
  });

  it("caps timeout at MAX_TIMEOUT_MS", async () => {
    simulateClaudeSession("done", "");

    await run({ prompt: "long task", timeoutMs: 999_999_999 });

    const opts = mockExecFile.mock.calls[0][2] as Record<string, unknown>;
    expect(opts.timeout).toBe(600_000);
  });

  it("writes audit entries for invocations", async () => {
    simulateClaudeSession("done", "");

    await run({ prompt: "fix something" });

    expect(writeAuditEntry).toHaveBeenCalled();
    const calls = (writeAuditEntry as ReturnType<typeof vi.fn>).mock.calls;
    const entries = calls.map((c: unknown[]) => c[0] as { skill: string; outcome: string });
    expect(entries.some((e) => e.skill === "code-agent")).toBe(true);
  });

  it("writes audit entry with rejected outcome on subdir traversal", async () => {
    await run({ prompt: "hack", subdir: "../../root" });

    const calls = (writeAuditEntry as ReturnType<typeof vi.fn>).mock.calls;
    const entries = calls.map((c: unknown[]) => c[0] as { outcome: string });
    expect(entries.some((e) => e.outcome === "rejected")).toBe(true);
  });

  it("returns config error when env is missing", async () => {
    delete process.env["ANTHROPIC_API_KEY"];

    const result = await run({ prompt: "test" });
    expect(result.success).toBe(false);
    expect(result.message).toContain("ANTHROPIC_API_KEY");
  });

  it("truncates very long output", async () => {
    const longOutput = "x".repeat(100_000);
    simulateClaudeSession(longOutput, "");

    const result = await run({ prompt: "verbose task" });
    expect(result.data?.output?.length).toBeLessThan(60_000);
    expect(result.data?.output).toContain("truncated");
  });
});

// ── undo ────────────────────────────────────────────────────────────────────

describe("undo", () => {
  it("is a no-op (code changes are undone via git)", async () => {
    await expect(undo()).resolves.toBeUndefined();
  });
});
