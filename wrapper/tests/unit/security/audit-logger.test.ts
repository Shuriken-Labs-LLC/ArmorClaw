import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoist fs mock before any imports.
vi.mock("node:fs", () => ({
  appendFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
}));

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import auditLoggerPlugin, {
  buildInputSummary,
  clearMemoryBufferForTesting,
  exportAuditLog,
  getMemoryBuffer,
  registerAuditLogger,
  writeAuditEntry,
  type AuditEntry,
} from "../../../security/audit-logger.ts";
import { clearManifestsForTesting, loadPermissionManifest } from "../../../security/permissions.ts";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeMockApi() {
  let capturedHandler: (
    event: {
      toolName: string;
      params: Record<string, unknown>;
      result?: unknown;
      error?: string;
      durationMs?: number;
    },
    ctx: { agentId?: string },
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

function sampleEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    timestamp: "2026-03-17T00:00:00.000Z",
    skill: "test_tool",
    permissionsUsed: [],
    inputSummary: '{"query":"hello"}',
    outcome: "success",
    durationMs: 42,
    ...overrides,
  };
}

const EXPECTED_HEADER = "timestamp,skill,permissionsUsed,inputSummary,outcome,durationMs";

// ── Isolation ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.mocked(appendFileSync).mockReset();
  vi.mocked(mkdirSync).mockReset();
  vi.mocked(readFileSync).mockReset();
  clearMemoryBufferForTesting();
  clearManifestsForTesting();
});

// ── buildInputSummary ─────────────────────────────────────────────────────────

describe("buildInputSummary", () => {
  it("returns JSON-serialized params truncated to 80 chars", () => {
    const result = buildInputSummary({ query: "hello" });
    expect(result).toBe('{"query":"hello"}');
    expect(result.length).toBeLessThanOrEqual(80);
  });

  it("truncates to 80 chars for long params", () => {
    const result = buildInputSummary({ data: "x".repeat(200) });
    expect(result.length).toBe(80);
  });

  it("redacts values with 'password' key", () => {
    const result = buildInputSummary({ password: "s3cr3t" });
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("s3cr3t");
  });

  it("redacts values with 'token' key", () => {
    const result = buildInputSummary({ token: "abc123" });
    expect(result).toContain("[REDACTED]");
  });

  it("redacts values with 'secret' key", () => {
    const result = buildInputSummary({ secret: "mysecret" });
    expect(result).toContain("[REDACTED]");
  });

  it("redacts values with 'key' key", () => {
    const result = buildInputSummary({ key: "api-key-value" });
    expect(result).toContain("[REDACTED]");
  });

  it("redacts values with 'auth' key", () => {
    const result = buildInputSummary({ auth: "Bearer xyz" });
    expect(result).toContain("[REDACTED]");
  });

  it("redacts values with 'credential' key", () => {
    const result = buildInputSummary({ credential: "user:pass" });
    expect(result).toContain("[REDACTED]");
  });

  it("does not redact non-secret keys", () => {
    const result = buildInputSummary({ query: "safe value" });
    expect(result).toContain("safe value");
    expect(result).not.toContain("[REDACTED]");
  });

  it("keeps safe keys alongside redacted secret keys", () => {
    const result = buildInputSummary({ query: "find me", token: "secret" });
    expect(result).toContain("find me");
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain('"secret"');
  });

  it("returns empty-object JSON for empty params", () => {
    expect(buildInputSummary({})).toBe("{}");
  });
});

// ── writeAuditEntry — happy path ──────────────────────────────────────────────

describe("writeAuditEntry — happy path", () => {
  it("calls mkdirSync and appendFileSync", () => {
    writeAuditEntry(sampleEntry());
    expect(mkdirSync).toHaveBeenCalledOnce();
    expect(appendFileSync).toHaveBeenCalledOnce();
  });

  it("writes a valid NDJSON line with a trailing newline", () => {
    writeAuditEntry(sampleEntry());
    const [, content] = vi.mocked(appendFileSync).mock.calls[0] as [string, string, string];
    expect(content.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(content.trimEnd());
    expect(parsed).toMatchObject({
      timestamp: expect.any(String),
      skill: "test_tool",
      outcome: "success",
      durationMs: 42,
    });
  });

  it("does not push to memory buffer on success", () => {
    writeAuditEntry(sampleEntry());
    expect(getMemoryBuffer()).toHaveLength(0);
  });

  // Regression guard — make sure HMAC tamper-evidence fields don't sneak back in.
  it("written entry has no hmac, prevHash, or seq keys", () => {
    writeAuditEntry(sampleEntry());
    const [, content] = vi.mocked(appendFileSync).mock.calls[0] as [string, string, string];
    const parsed = JSON.parse(content.trimEnd()) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty("hmac");
    expect(parsed).not.toHaveProperty("prevHash");
    expect(parsed).not.toHaveProperty("seq");
  });
});

// ── writeAuditEntry — I/O failure ────────────────────────────────────────────

describe("writeAuditEntry — I/O failure (silent buffering)", () => {
  it("does not throw when mkdirSync fails", () => {
    vi.mocked(mkdirSync).mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    expect(() => writeAuditEntry(sampleEntry())).not.toThrow();
  });

  it("pushes to memory buffer when mkdirSync fails", () => {
    vi.mocked(mkdirSync).mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    const entry = sampleEntry({ skill: "buffered_tool" });
    writeAuditEntry(entry);
    expect(getMemoryBuffer()).toHaveLength(1);
    expect(getMemoryBuffer()[0].skill).toBe("buffered_tool");
  });

  it("does not throw when appendFileSync fails", () => {
    vi.mocked(appendFileSync).mockImplementationOnce(() => {
      throw new Error("no space left");
    });
    expect(() => writeAuditEntry(sampleEntry())).not.toThrow();
  });

  it("pushes to memory buffer when appendFileSync fails", () => {
    vi.mocked(appendFileSync).mockImplementationOnce(() => {
      throw new Error("no space left");
    });
    writeAuditEntry(sampleEntry({ skill: "failed_write" }));
    expect(getMemoryBuffer()[0].skill).toBe("failed_write");
  });
});

// ── exportAuditLog — from file ────────────────────────────────────────────────

describe("exportAuditLog — reading from file", () => {
  it("returns CSV with the 6-column header when file has one entry", () => {
    const entry = sampleEntry();
    vi.mocked(readFileSync).mockReturnValueOnce(JSON.stringify(entry) + "\n");
    const csv = exportAuditLog();
    expect(csv).toContain(EXPECTED_HEADER);
    expect(csv).toContain("2026-03-17T00:00:00.000Z");
    expect(csv).toContain("success");
  });

  it("CSV header does NOT contain seq, prevHash, or hmac columns", () => {
    vi.mocked(readFileSync).mockReturnValueOnce("");
    const csv = exportAuditLog();
    expect(csv).not.toContain("seq");
    expect(csv).not.toContain("prevHash");
    expect(csv).not.toContain("hmac");
  });

  it("returns CSV with multiple rows for multiple entries", () => {
    const lines =
      [
        JSON.stringify(sampleEntry({ skill: "tool_a", outcome: "success" })),
        JSON.stringify(sampleEntry({ skill: "tool_b", outcome: "error" })),
      ].join("\n") + "\n";
    vi.mocked(readFileSync).mockReturnValueOnce(lines);
    const csv = exportAuditLog();
    expect(csv).toContain("tool_a");
    expect(csv).toContain("tool_b");
  });

  it("skips blank lines in NDJSON without error", () => {
    const content = JSON.stringify(sampleEntry()) + "\n\n\n";
    vi.mocked(readFileSync).mockReturnValueOnce(content);
    expect(() => exportAuditLog()).not.toThrow();
  });

  it("skips malformed NDJSON lines without error", () => {
    const content = "not valid json\n" + JSON.stringify(sampleEntry()) + "\n";
    vi.mocked(readFileSync).mockReturnValueOnce(content);
    const csv = exportAuditLog();
    expect(csv).toContain("success"); // valid entry still present
  });

  it("returns only header row for empty file", () => {
    vi.mocked(readFileSync).mockReturnValueOnce("");
    const csv = exportAuditLog();
    expect(csv).toBe(EXPECTED_HEADER);
  });
});

// ── exportAuditLog — fallback to memory buffer ────────────────────────────────

describe("exportAuditLog — fallback to memory buffer", () => {
  it("falls back to memory buffer when readFileSync throws", () => {
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw new Error("ENOENT: file not found");
    });
    const entry = sampleEntry({ skill: "buffered_skill" });
    memoryBuffer.push(entry); // directly simulate prior write failure

    const csv = exportAuditLog();
    expect(csv).toContain("buffered_skill");
  });

  it("returns only header when buffer is empty and file is unavailable", () => {
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });
    const csv = exportAuditLog();
    expect(csv).toBe(EXPECTED_HEADER);
  });
});

// Helper to directly push to buffer for testing
const { memoryBuffer } = await import("../../../security/audit-logger.ts").then((m) => ({
  memoryBuffer: m.getMemoryBuffer() as AuditEntry[],
}));

// ── exportAuditLog — CSV formatting ──────────────────────────────────────────

describe("exportAuditLog — CSV formatting", () => {
  it("escapes double quotes in inputSummary", () => {
    const entry = sampleEntry({ inputSummary: 'has "quotes" inside' });
    vi.mocked(readFileSync).mockReturnValueOnce(JSON.stringify(entry) + "\n");
    const csv = exportAuditLog();
    expect(csv).toContain('"has ""quotes"" inside"');
  });

  it("joins permissionsUsed with pipe separator", () => {
    const entry = sampleEntry({ permissionsUsed: ["files:local", "network:read"] });
    vi.mocked(readFileSync).mockReturnValueOnce(JSON.stringify(entry) + "\n");
    const csv = exportAuditLog();
    expect(csv).toContain("files:local|network:read");
  });

  it("writes durationMs as a plain number", () => {
    const entry = sampleEntry({ durationMs: 1234 });
    vi.mocked(readFileSync).mockReturnValueOnce(JSON.stringify(entry) + "\n");
    const csv = exportAuditLog();
    expect(csv).toContain("1234");
  });

  it("handles zero durationMs", () => {
    const entry = sampleEntry({ durationMs: 0 });
    vi.mocked(readFileSync).mockReturnValueOnce(JSON.stringify(entry) + "\n");
    const csv = exportAuditLog();
    expect(csv).toContain(",0");
  });

  it("uses ?? defaults for missing permissionsUsed, inputSummary, and durationMs", () => {
    const incomplete = JSON.stringify({
      timestamp: "2026-03-17T00:00:00.000Z",
      skill: "partial_tool",
      outcome: "success",
    });
    vi.mocked(readFileSync).mockReturnValueOnce(incomplete + "\n");
    const csv = exportAuditLog();
    expect(csv).toContain("partial_tool");
    expect(csv).toContain(",0"); // durationMs defaulted to 0
  });
});

// ── registerAuditLogger ───────────────────────────────────────────────────────

describe("registerAuditLogger", () => {
  it("registers an after_tool_call handler on the api", () => {
    const mockApi = makeMockApi();
    registerAuditLogger(mockApi as unknown as OpenClawPluginApi);
    expect(mockApi.on).toHaveBeenCalledWith("after_tool_call", expect.any(Function));
  });

  it("writes an audit entry on a successful tool call", () => {
    const mockApi = makeMockApi();
    registerAuditLogger(mockApi as unknown as OpenClawPluginApi);
    mockApi.capturedHandler(
      { toolName: "my_tool", params: { q: "hello" }, result: "ok", durationMs: 100 },
      { agentId: "agent-1" },
    );
    expect(appendFileSync).toHaveBeenCalledOnce();
    const [, content] = vi.mocked(appendFileSync).mock.calls[0] as [string, string, string];
    const parsed = JSON.parse(content.trimEnd()) as AuditEntry;
    expect(parsed.outcome).toBe("success");
    expect(parsed.skill).toBe("agent-1");
    expect(parsed.durationMs).toBe(100);
  });

  it("records outcome:error when event.error is set", () => {
    const mockApi = makeMockApi();
    registerAuditLogger(mockApi as unknown as OpenClawPluginApi);
    mockApi.capturedHandler(
      { toolName: "my_tool", params: {}, error: "tool failed", durationMs: 50 },
      {},
    );
    const [, content] = vi.mocked(appendFileSync).mock.calls[0] as [string, string, string];
    const parsed = JSON.parse(content.trimEnd()) as AuditEntry;
    expect(parsed.outcome).toBe("error");
  });

  it("falls back to toolName as skill when agentId is absent", () => {
    const mockApi = makeMockApi();
    registerAuditLogger(mockApi as unknown as OpenClawPluginApi);
    mockApi.capturedHandler({ toolName: "fallback_tool", params: {} }, {});
    const [, content] = vi.mocked(appendFileSync).mock.calls[0] as [string, string, string];
    const parsed = JSON.parse(content.trimEnd()) as AuditEntry;
    expect(parsed.skill).toBe("fallback_tool");
  });

  it("records durationMs:0 when not provided", () => {
    const mockApi = makeMockApi();
    registerAuditLogger(mockApi as unknown as OpenClawPluginApi);
    mockApi.capturedHandler({ toolName: "t", params: {} }, {});
    const [, content] = vi.mocked(appendFileSync).mock.calls[0] as [string, string, string];
    const parsed = JSON.parse(content.trimEnd()) as AuditEntry;
    expect(parsed.durationMs).toBe(0);
  });

  it("never throws even when file write fails", () => {
    vi.mocked(mkdirSync).mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    const mockApi = makeMockApi();
    registerAuditLogger(mockApi as unknown as OpenClawPluginApi);
    expect(() => mockApi.capturedHandler({ toolName: "t", params: {} }, {})).not.toThrow();
  });

  it("redacts secret keys in input summary", () => {
    const mockApi = makeMockApi();
    registerAuditLogger(mockApi as unknown as OpenClawPluginApi);
    mockApi.capturedHandler(
      { toolName: "auth_tool", params: { token: "super-secret", query: "safe" } },
      {},
    );
    const [, content] = vi.mocked(appendFileSync).mock.calls[0] as [string, string, string];
    const parsed = JSON.parse(content.trimEnd()) as AuditEntry;
    expect(parsed.inputSummary).toContain("[REDACTED]");
    expect(parsed.inputSummary).not.toContain("super-secret");
  });

  it("permissionsUsed is populated from the permission registry", () => {
    loadPermissionManifest({
      skillId: "test-skill",
      allowedTools: ["some_tool"],
      allowedPermissions: ["network:outbound"],
    });
    const mockApi = makeMockApi();
    registerAuditLogger(mockApi as unknown as OpenClawPluginApi);
    mockApi.capturedHandler({ toolName: "some_tool", params: {} }, {});
    const [, content] = vi.mocked(appendFileSync).mock.calls[0] as [string, string, string];
    const parsed = JSON.parse(content.trimEnd()) as AuditEntry;
    expect(parsed.permissionsUsed).toEqual(["network:outbound"]);
  });

  it("permissionsUsed is empty when tool has no registered manifest", () => {
    const mockApi = makeMockApi();
    registerAuditLogger(mockApi as unknown as OpenClawPluginApi);
    mockApi.capturedHandler({ toolName: "unknown_tool", params: {} }, {});
    const [, content] = vi.mocked(appendFileSync).mock.calls[0] as [string, string, string];
    const parsed = JSON.parse(content.trimEnd()) as AuditEntry;
    expect(parsed.permissionsUsed).toEqual([]);
  });
});

// ── clearMemoryBufferForTesting ───────────────────────────────────────────────

describe("clearMemoryBufferForTesting", () => {
  it("empties the memory buffer", () => {
    vi.mocked(mkdirSync).mockImplementationOnce(() => {
      throw new Error("fail");
    });
    writeAuditEntry(sampleEntry());
    expect(getMemoryBuffer().length).toBeGreaterThan(0);
    clearMemoryBufferForTesting();
    expect(getMemoryBuffer()).toHaveLength(0);
  });
});

// ── default plugin export ─────────────────────────────────────────────────────

describe("default export (plugin definition)", () => {
  it("has the correct plugin id", () => {
    expect(auditLoggerPlugin.id).toBe("armorclaw-audit-logger");
  });

  it("register() calls api.on with after_tool_call", () => {
    const mockApi = makeMockApi();
    auditLoggerPlugin.register(mockApi as unknown as OpenClawPluginApi);
    expect(mockApi.on).toHaveBeenCalledWith("after_tool_call", expect.any(Function));
  });
});
