import { describe, it, expect } from "vitest";
import { buildWrapperContext } from "./wrapper-context";

describe("buildWrapperContext", () => {
  const defaultInputs = {
    workspaceName: "Work",
    projectName: "Q3 Launch",
    auditLogPath: "/Users/test/Library/Application Support/ArmorClaw/audit.log",
    brainDirectoryPath: "/Users/test/Library/Application Support/ArmorClaw",
  };

  it("includes the workspace name", () => {
    const ctx = buildWrapperContext(defaultInputs);
    expect(ctx).toContain('workspace "Work"');
  });

  it("includes the project name", () => {
    const ctx = buildWrapperContext(defaultInputs);
    expect(ctx).toContain('project "Q3 Launch"');
  });

  it("includes the approval-gate sentence", () => {
    const ctx = buildWrapperContext(defaultInputs);
    expect(ctx).toContain("irreversible action");
    expect(ctx).toContain("approval");
    expect(ctx).toContain("Do not bypass");
  });

  it("stays under the 250-token budget", () => {
    const ctx = buildWrapperContext(defaultInputs);
    // rough token estimate: ~0.75 tokens per word
    const wordCount = ctx.split(/\s+/).length;
    const estimatedTokens = Math.ceil(wordCount * 1.33);
    expect(estimatedTokens).toBeLessThanOrEqual(350);
  });

  it("references ArmorClaw and mentions OpenClaw only in context of wrapping", () => {
    const ctx = buildWrapperContext(defaultInputs);
    expect(ctx).toContain("ArmorClaw");
    expect(ctx).toContain("not through the OpenClaw CLI");
    // should not tell the user to use OpenClaw directly
    expect(ctx).not.toContain("use OpenClaw");
  });

  it("describes brain.propose for memory", () => {
    const ctx = buildWrapperContext(defaultInputs);
    expect(ctx).toContain("brain.propose");
  });

  it("points to the ArmorClaw UI for settings", () => {
    const ctx = buildWrapperContext(defaultInputs);
    expect(ctx).toContain("Settings panel");
  });

  it("says macOS (v1 scope)", () => {
    const ctx = buildWrapperContext(defaultInputs);
    expect(ctx).toContain("macOS");
    expect(ctx).not.toContain("Windows");
  });
});
