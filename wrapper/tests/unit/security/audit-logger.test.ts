import { createHash, createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoist fs mock before any imports.
vi.mock("node:fs", () => ({
  appendFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
  renameSync: vi.fn(),
}));

// Mock the audit-key module so writeAuditEntry stays isolated from the real
// keychain. Tests opt into a key by calling _setMockedKey(...) below.
vi.mock("../../../security/audit-key.ts", () => {
  let mockedKey: Buffer | null = null;
  return {
    getAuditKey: vi.fn(async () => mockedKey),
    getAuditKeySync: vi.fn(() => mockedKey),
    clearAuditKeyCacheForTesting: vi.fn(() => {
      mockedKey = null;
    }),
    _setMockedKey(key: Buffer | null) {
      mockedKey = key;
    },
  };
});

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import * as auditKeyModule from "../../../security/audit-key.ts";
import auditLoggerPlugin, {
  buildInputSummary,
  clearMemoryBufferForTesting,
  exportAuditLog,
  getMemoryBuffer,
  registerAuditLogger,
  resetChainStateForTesting,
  writeAuditEntry,
  type AuditEntry,
  type SignedAuditEntry,
} from "../../../security/audit-logger.ts";

const setMockedKey = (auditKeyModule as unknown as { _setMockedKey: (k: Buffer | null) => void })
  ._setMockedKey;

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

function lastWrittenLine(): string {
  const calls = vi.mocked(appendFileSync).mock.calls;
  const [, content] = calls[calls.length - 1] as [string, string, string];
  return content.trimEnd();
}

function lastWrittenSigned(): SignedAuditEntry {
  return JSON.parse(lastWrittenLine()) as SignedAuditEntry;
}

// ── Isolation ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.mocked(appendFileSync).mockReset();
  vi.mocked(mkdirSync).mockReset();
  vi.mocked(readFileSync).mockReset();
  vi.mocked(existsSync).mockReset();
  vi.mocked(existsSync).mockReturnValue(false);
  vi.mocked(renameSync).mockReset();
  clearMemoryBufferForTesting();
  resetChainStateForTesting();
  setMockedKey(null);
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
});

// ── writeAuditEntry — chain semantics ────────────────────────────────────────

describe("writeAuditEntry — chain semantics", () => {
  it("first entry has seq 1 and prevHash 'GENESIS'", () => {
    writeAuditEntry(sampleEntry());
    const signed = lastWrittenSigned();
    expect(signed.seq).toBe(1);
    expect(signed.prevHash).toBe("GENESIS");
  });

  it("seq increments monotonically across calls", () => {
    writeAuditEntry(sampleEntry({ skill: "a" }));
    writeAuditEntry(sampleEntry({ skill: "b" }));
    writeAuditEntry(sampleEntry({ skill: "c" }));
    const calls = vi.mocked(appendFileSync).mock.calls;
    const seqs = calls.map((c) => (JSON.parse((c[1] as string).trimEnd()) as SignedAuditEntry).seq);
    expect(seqs).toEqual([1, 2, 3]);
  });

  it("prevHash of entry N is SHA-256 of the previous serialized line", () => {
    writeAuditEntry(sampleEntry({ skill: "first" }));
    writeAuditEntry(sampleEntry({ skill: "second" }));
    const calls = vi.mocked(appendFileSync).mock.calls;
    const firstLine = (calls[0][1] as string).trimEnd();
    const secondSigned = JSON.parse((calls[1][1] as string).trimEnd()) as SignedAuditEntry;
    const expected = createHash("sha256").update(firstLine).digest("hex");
    expect(secondSigned.prevHash).toBe(expected);
  });

  it("hmac is null when no key is loaded", () => {
    setMockedKey(null);
    writeAuditEntry(sampleEntry());
    expect(lastWrittenSigned().hmac).toBeNull();
  });

  it("hmac is non-null hex string when a key is loaded", () => {
    setMockedKey(Buffer.alloc(32, 0xab));
    writeAuditEntry(sampleEntry());
    const signed = lastWrittenSigned();
    expect(signed.hmac).not.toBeNull();
    expect(signed.hmac).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hmac value is HMAC-SHA256 over the entry content excluding hmac itself", () => {
    const key = Buffer.alloc(32, 0x11);
    setMockedKey(key);
    const entry = sampleEntry({ skill: "verify_me" });
    writeAuditEntry(entry);
    const signed = lastWrittenSigned();
    const { hmac, ...rest } = signed;
    const expected = createHmac("sha256", key).update(JSON.stringify(rest)).digest("hex");
    expect(hmac).toBe(expected);
  });

  it("resumes from last seq after process restart (re-init from existing log)", () => {
    // Simulate a process restart with existing entries already on disk.
    resetChainStateForTesting();
    vi.mocked(existsSync).mockReturnValue(true);
    const existing: SignedAuditEntry[] = [
      {
        timestamp: "2026-03-17T00:00:00.000Z",
        skill: "old1",
        permissionsUsed: [],
        inputSummary: "{}",
        outcome: "success",
        durationMs: 0,
        seq: 1,
        prevHash: "GENESIS",
        hmac: null,
      },
      {
        timestamp: "2026-03-17T00:00:01.000Z",
        skill: "old2",
        permissionsUsed: [],
        inputSummary: "{}",
        outcome: "success",
        durationMs: 0,
        seq: 2,
        prevHash: "irrelevant",
        hmac: null,
      },
    ];
    const lastLine = JSON.stringify(existing[1]);
    const fileContent = JSON.stringify(existing[0]) + "\n" + lastLine + "\n";
    vi.mocked(readFileSync).mockReturnValue(fileContent);

    writeAuditEntry(sampleEntry({ skill: "fresh" }));

    const signed = lastWrittenSigned();
    expect(signed.seq).toBe(3);
    expect(signed.prevHash).toBe(createHash("sha256").update(lastLine).digest("hex"));
  });
});

// ── writeAuditEntry — pre-HMAC migration ─────────────────────────────────────

describe("writeAuditEntry — pre-HMAC migration", () => {
  it("renames audit.log to audit.log.pre-hmac when first line lacks seq field", () => {
    resetChainStateForTesting();
    vi.mocked(existsSync).mockReturnValue(true);
    const preHmacLog =
      JSON.stringify({
        timestamp: "2026-03-17T00:00:00.000Z",
        skill: "old",
        permissionsUsed: [],
        inputSummary: "{}",
        outcome: "success",
        durationMs: 0,
      }) + "\n";
    vi.mocked(readFileSync).mockReturnValue(preHmacLog);

    writeAuditEntry(sampleEntry());

    expect(renameSync).toHaveBeenCalledOnce();
    const [from, to] = vi.mocked(renameSync).mock.calls[0];
    expect(from).toMatch(/audit\.log$/);
    expect(to).toMatch(/audit\.log\.pre-hmac$/);
  });

  it("does not rename when the existing log already has seq fields", () => {
    resetChainStateForTesting();
    vi.mocked(existsSync).mockReturnValue(true);
    const newFormatLog =
      JSON.stringify({
        timestamp: "2026-03-17T00:00:00.000Z",
        skill: "new",
        permissionsUsed: [],
        inputSummary: "{}",
        outcome: "success",
        durationMs: 0,
        seq: 1,
        prevHash: "GENESIS",
        hmac: null,
      }) + "\n";
    vi.mocked(readFileSync).mockReturnValue(newFormatLog);

    writeAuditEntry(sampleEntry());

    expect(renameSync).not.toHaveBeenCalled();
  });

  it("does not crash when audit.log is missing", () => {
    resetChainStateForTesting();
    vi.mocked(existsSync).mockReturnValue(false);
    expect(() => writeAuditEntry(sampleEntry())).not.toThrow();
    expect(renameSync).not.toHaveBeenCalled();
  });

  it("does not crash on a malformed first line (best-effort migration)", () => {
    resetChainStateForTesting();
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue("not-json{}{{\n");
    expect(() => writeAuditEntry(sampleEntry())).not.toThrow();
    expect(renameSync).not.toHaveBeenCalled();
  });

  it("treats an empty existing audit.log as nothing to migrate", () => {
    resetChainStateForTesting();
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue("");
    expect(() => writeAuditEntry(sampleEntry())).not.toThrow();
    expect(renameSync).not.toHaveBeenCalled();
  });

  it("does not throw if renameSync fails (migration is best-effort)", () => {
    resetChainStateForTesting();
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ timestamp: "x", skill: "y", outcome: "success" }) + "\n",
    );
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw new Error("EACCES");
    });
    expect(() => writeAuditEntry(sampleEntry())).not.toThrow();
  });

  it("only attempts migration once per process (caches migrationDone)", () => {
    resetChainStateForTesting();
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ timestamp: "x", skill: "y", outcome: "success" }) + "\n",
    );

    writeAuditEntry(sampleEntry());
    writeAuditEntry(sampleEntry());
    writeAuditEntry(sampleEntry());

    expect(renameSync).toHaveBeenCalledOnce();
  });
});

// ── writeAuditEntry — chain init resilience ──────────────────────────────────

describe("writeAuditEntry — chain init resilience", () => {
  it("falls back to fresh GENESIS chain when readFileSync throws", () => {
    resetChainStateForTesting();
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error("EIO");
    });
    writeAuditEntry(sampleEntry());
    const signed = lastWrittenSigned();
    expect(signed.seq).toBe(1);
    expect(signed.prevHash).toBe("GENESIS");
  });

  it("ignores malformed lines while finding the last valid seq", () => {
    resetChainStateForTesting();
    vi.mocked(existsSync).mockReturnValue(true);
    const valid = JSON.stringify({
      timestamp: "x",
      skill: "y",
      permissionsUsed: [],
      inputSummary: "{}",
      outcome: "success",
      durationMs: 0,
      seq: 5,
      prevHash: "g",
      hmac: null,
    });
    const content = `garbage\n${valid}\nmore garbage\n`;
    vi.mocked(readFileSync).mockReturnValue(content);
    writeAuditEntry(sampleEntry());
    expect(lastWrittenSigned().seq).toBe(6);
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
  it("returns CSV with the new header (timestamp..hmac) when file has one entry", () => {
    const entry = sampleEntry();
    vi.mocked(readFileSync).mockReturnValueOnce(JSON.stringify(entry) + "\n");
    const csv = exportAuditLog();
    expect(csv).toContain(
      "timestamp,skill,permissionsUsed,inputSummary,outcome,durationMs,seq,prevHash,hmac",
    );
    expect(csv).toContain("2026-03-17T00:00:00.000Z");
    expect(csv).toContain("success");
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
    expect(csv).toBe(
      "timestamp,skill,permissionsUsed,inputSummary,outcome,durationMs,seq,prevHash,hmac",
    );
  });

  it("includes seq, prevHash, and hmac columns for signed entries", () => {
    const signed: SignedAuditEntry = {
      timestamp: "2026-03-17T00:00:00.000Z",
      skill: "signed_tool",
      permissionsUsed: [],
      inputSummary: "{}",
      outcome: "success",
      durationMs: 10,
      seq: 7,
      prevHash: "abc123",
      hmac: "def456",
    };
    vi.mocked(readFileSync).mockReturnValueOnce(JSON.stringify(signed) + "\n");
    const csv = exportAuditLog();
    expect(csv).toContain(",7,abc123,def456");
  });

  it("emits empty seq/prevHash/hmac fields for pre-HMAC entries", () => {
    const preHmac = sampleEntry({ skill: "ancient" });
    vi.mocked(readFileSync).mockReturnValueOnce(JSON.stringify(preHmac) + "\n");
    const csv = exportAuditLog();
    expect(csv).toContain("ancient");
    expect(csv).toMatch(/,42,,,$/m); // durationMs,42 then three empty trailing fields
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
    expect(csv).toBe(
      "timestamp,skill,permissionsUsed,inputSummary,outcome,durationMs,seq,prevHash,hmac",
    );
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
    // The field should be wrapped in quotes with internal quotes doubled
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
    // Entries parsed from NDJSON may lack fields (e.g., mixed-origin log entries
    // written by the injection or permission filter with a different shape).
    const incomplete = JSON.stringify({
      timestamp: "2026-03-17T00:00:00.000Z",
      skill: "partial_tool",
      outcome: "success",
      // permissionsUsed, inputSummary, and durationMs intentionally absent
    });
    vi.mocked(readFileSync).mockReturnValueOnce(incomplete + "\n");
    const csv = exportAuditLog();
    // ?? [] → empty join → empty string between commas
    // ?? "" → csvField("") → ""
    // ?? 0 → "0"
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

  it("warms the audit-key cache via getAuditKey", () => {
    const mockApi = makeMockApi();
    registerAuditLogger(mockApi as unknown as OpenClawPluginApi);
    expect(auditKeyModule.getAuditKey).toHaveBeenCalled();
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
    const parsed = JSON.parse(content.trimEnd()) as SignedAuditEntry;
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
    const parsed = JSON.parse(content.trimEnd()) as SignedAuditEntry;
    expect(parsed.outcome).toBe("error");
  });

  it("falls back to toolName as skill when agentId is absent", () => {
    const mockApi = makeMockApi();
    registerAuditLogger(mockApi as unknown as OpenClawPluginApi);
    mockApi.capturedHandler(
      { toolName: "fallback_tool", params: {} },
      {}, // no agentId
    );
    const [, content] = vi.mocked(appendFileSync).mock.calls[0] as [string, string, string];
    const parsed = JSON.parse(content.trimEnd()) as SignedAuditEntry;
    expect(parsed.skill).toBe("fallback_tool");
  });

  it("records durationMs:0 when not provided", () => {
    const mockApi = makeMockApi();
    registerAuditLogger(mockApi as unknown as OpenClawPluginApi);
    mockApi.capturedHandler({ toolName: "t", params: {} }, {});
    const [, content] = vi.mocked(appendFileSync).mock.calls[0] as [string, string, string];
    const parsed = JSON.parse(content.trimEnd()) as SignedAuditEntry;
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
    const parsed = JSON.parse(content.trimEnd()) as SignedAuditEntry;
    expect(parsed.inputSummary).toContain("[REDACTED]");
    expect(parsed.inputSummary).not.toContain("super-secret");
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
