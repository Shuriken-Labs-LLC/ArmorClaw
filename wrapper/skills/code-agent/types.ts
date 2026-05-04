/**
 * Types for the code-agent skill.
 *
 * The code-agent skill spawns a Claude Code CLI session in non-interactive
 * (print) mode, pointed at the ArmorClaw repo, and returns the result.
 */

/** Input accepted by the code-agent skill's run() function. */
export interface CodeAgentInput {
  /** The coding task prompt, e.g. "fix the flaky test in outbound-tool-arg-filter.test.ts". */
  prompt: string;

  /**
   * Optional subdirectory within the project root to scope the session to.
   * Must be relative and stay within the project root (validated at runtime).
   * Defaults to the project root itself.
   */
  subdir?: string;

  /**
   * Optional list of allowed tools for the Claude Code session.
   * Defaults to a safe set: ["Read", "Glob", "Grep", "Edit", "Write", "Bash(git:*)"].
   * Use this to further restrict what Claude Code can do.
   */
  allowedTools?: string[];

  /**
   * Optional effort level for the Claude Code session.
   * Defaults to "high".
   */
  effort?: "low" | "medium" | "high" | "max";

  /**
   * Maximum execution time in milliseconds before the process is killed.
   * Defaults to 300_000 (5 minutes).
   */
  timeoutMs?: number;
}

/** Output returned by the code-agent skill's run() function. */
export interface CodeAgentOutput {
  success: boolean;
  message: string;
  data?: {
    /** The full text output from the Claude Code session. */
    output?: string;
    /** The exit code of the Claude Code process. */
    exitCode?: number;
    /** Duration of the session in milliseconds. */
    durationMs?: number;
    /** Whether the session was killed due to timeout. */
    timedOut?: boolean;
  };
}

/** Configuration for the code-agent skill, read from environment. */
export interface CodeAgentConfig {
  /** Absolute path to the project root that Claude Code will operate on. */
  projectRoot: string;
  /** Path to the claude CLI binary. */
  cliBinaryPath: string;
  /** Anthropic API key (passed to the subprocess). */
  anthropicApiKey: string;
  /** Default timeout in ms. */
  defaultTimeoutMs: number;
  /** Default allowed tools. */
  defaultAllowedTools: string[];
}
