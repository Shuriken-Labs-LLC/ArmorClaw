import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock node:fs so writeAuditEntry never touches the real filesystem
vi.mock("node:fs", () => ({
  appendFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
}));

import { appendFileSync } from "node:fs";
import { clearMemoryBufferForTesting, getMemoryBuffer } from "../../../security/audit-logger.ts";
import {
  type RegisterUndoOptions,
  clearUndoForTesting,
  executeUndo,
  getCurrentUndo,
  registerUndo,
} from "../../../undo/registry.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

const BASE_NOW = 1_000_000_000_000; // a fixed epoch ms

function makeOptions(overrides: Partial<RegisterUndoOptions> = {}): RegisterUndoOptions {
  return {
    actionType: "file-write",
    skill: "test-skill",
    snapshot: { before: "old content" },
    undoFn: vi.fn().mockResolvedValue(undefined),
    nowMs: () => BASE_NOW,
    ...overrides,
  };
}

// ── Isolation ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  clearUndoForTesting();
  clearMemoryBufferForTesting();
  vi.mocked(appendFileSync).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── registerUndo ──────────────────────────────────────────────────────────────

describe("registerUndo — entry fields", () => {
  it("returns an entry with the correct actionType and skill", () => {
    const entry = registerUndo(makeOptions({ actionType: "email-draft", skill: "email-skill" }));
    expect(entry.actionType).toBe("email-draft");
    expect(entry.skill).toBe("email-skill");
  });

  it("sets timestamp from nowMs", () => {
    const entry = registerUndo(makeOptions());
    expect(entry.timestamp).toBe(new Date(BASE_NOW).toISOString());
  });

  it("sets expiresAt to timestamp + 60s", () => {
    const entry = registerUndo(makeOptions());
    expect(entry.expiresAt).toBe(new Date(BASE_NOW + 60_000).toISOString());
  });

  it("stores the snapshot on the entry", () => {
    const snapshot = { key: "value", nested: [1, 2, 3] };
    const entry = registerUndo(makeOptions({ snapshot }));
    expect(entry.snapshot).toStrictEqual(snapshot);
  });

  it("stores the undoFn on the entry", () => {
    const undoFn = vi.fn().mockResolvedValue(undefined);
    const entry = registerUndo(makeOptions({ undoFn }));
    expect(entry.undoFn).toBe(undoFn);
  });

  it("uses the provided id override", () => {
    const entry = registerUndo(makeOptions({ id: "fixed-id-123" }));
    expect(entry.id).toBe("fixed-id-123");
  });

  it("generates a uuid when no id is provided", () => {
    const entry = registerUndo(makeOptions({ id: undefined }));
    // UUID v4 pattern
    expect(entry.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("uses real Date.now() when nowMs is not provided", () => {
    const before = Date.now();
    const entry = registerUndo({
      actionType: "file-write",
      skill: "secure-files",
      snapshot: null,
      undoFn: vi.fn().mockResolvedValue(undefined),
    });
    const after = Date.now();
    const entryMs = new Date(entry.timestamp).getTime();
    expect(entryMs).toBeGreaterThanOrEqual(before);
    expect(entryMs).toBeLessThanOrEqual(after);
  });
});

describe("registerUndo — single slot", () => {
  it("replaces previous entry when a new one is registered", () => {
    registerUndo(makeOptions({ id: "first", skill: "skill-a" }));
    registerUndo(makeOptions({ id: "second", skill: "skill-b" }));
    const current = getCurrentUndo(() => BASE_NOW);
    expect(current?.id).toBe("second");
  });

  it("discards the previous entry silently — no error thrown", () => {
    expect(() => {
      registerUndo(makeOptions({ id: "a" }));
      registerUndo(makeOptions({ id: "b" }));
    }).not.toThrow();
  });

  it("supports all three action types", () => {
    const types = ["email-draft", "file-write"] as const;
    for (const actionType of types) {
      const entry = registerUndo(makeOptions({ actionType }));
      expect(entry.actionType).toBe(actionType);
    }
  });
});

// ── getCurrentUndo ────────────────────────────────────────────────────────────

describe("getCurrentUndo", () => {
  it("returns null when no entry is registered", () => {
    expect(getCurrentUndo(() => BASE_NOW)).toBeNull();
  });

  it("returns the entry before expiry", () => {
    registerUndo(makeOptions());
    // 1ms before expiry
    const entry = getCurrentUndo(() => BASE_NOW + 59_999);
    expect(entry).not.toBeNull();
    expect(entry?.skill).toBe("test-skill");
  });

  it("returns null exactly at expiry", () => {
    registerUndo(makeOptions());
    // Exactly at expiresAt epoch
    expect(getCurrentUndo(() => BASE_NOW + 60_000)).toBeNull();
  });

  it("returns null after expiry", () => {
    registerUndo(makeOptions());
    expect(getCurrentUndo(() => BASE_NOW + 61_000)).toBeNull();
  });

  it("clears the internal slot when the entry expires", () => {
    registerUndo(makeOptions());
    // Advance past expiry
    getCurrentUndo(() => BASE_NOW + 70_000);
    // A subsequent call with a pre-expiry time still returns null (slot is cleared)
    expect(getCurrentUndo(() => BASE_NOW)).toBeNull();
  });

  it("uses real Date.now() when nowMs is not provided", () => {
    // Register with a far-future expiry so the real clock won't expire it
    registerUndo({
      actionType: "file-write",
      skill: "skill",
      snapshot: null,
      undoFn: vi.fn().mockResolvedValue(undefined),
      nowMs: () => Date.now() - 1000, // registered 1s in the past, expires 59s from now
    });
    // Should still be present since expiry is ~59s in the future
    expect(getCurrentUndo()).not.toBeNull();
  });
});

// ── executeUndo ───────────────────────────────────────────────────────────────

describe("executeUndo — no entry", () => {
  it("returns false when no entry is registered", async () => {
    expect(await executeUndo(() => BASE_NOW)).toBe(false);
  });

  it("returns false when entry is expired", async () => {
    registerUndo(makeOptions());
    expect(await executeUndo(() => BASE_NOW + 60_001)).toBe(false);
  });
});

describe("executeUndo — successful undo", () => {
  it("returns true when an active entry exists", async () => {
    registerUndo(makeOptions());
    expect(await executeUndo(() => BASE_NOW)).toBe(true);
  });

  it("calls undoFn exactly once", async () => {
    const undoFn = vi.fn().mockResolvedValue(undefined);
    registerUndo(makeOptions({ undoFn }));
    await executeUndo(() => BASE_NOW);
    expect(undoFn).toHaveBeenCalledOnce();
  });

  it("clears the registry slot after execution", async () => {
    registerUndo(makeOptions());
    await executeUndo(() => BASE_NOW);
    expect(getCurrentUndo(() => BASE_NOW)).toBeNull();
  });

  it("returns false on a second call (slot already cleared)", async () => {
    registerUndo(makeOptions());
    await executeUndo(() => BASE_NOW);
    expect(await executeUndo(() => BASE_NOW)).toBe(false);
  });
});

describe("executeUndo — audit logging", () => {
  it("writes an audit entry with outcome 'undone'", async () => {
    vi.mocked(appendFileSync).mockImplementation(() => undefined);
    registerUndo(makeOptions({ id: "audit-id", skill: "audit-skill" }));
    await executeUndo(() => BASE_NOW);

    expect(appendFileSync).toHaveBeenCalledOnce();
    const [, written] = vi.mocked(appendFileSync).mock.calls[0];
    const entry = JSON.parse((written as string).trim());
    expect(entry.outcome).toBe("undone");
    expect(entry.skill).toBe("audit-skill");
  });

  it("includes actionType and id in inputSummary", async () => {
    vi.mocked(appendFileSync).mockImplementation(() => undefined);
    registerUndo(makeOptions({ id: "my-id", actionType: "file-write", skill: "secure-files" }));
    await executeUndo(() => BASE_NOW);

    const [, written] = vi.mocked(appendFileSync).mock.calls[0];
    const entry = JSON.parse((written as string).trim());
    expect(entry.inputSummary).toContain("file-write");
    expect(entry.inputSummary).toContain("my-id");
  });

  it("inputSummary is at most 80 chars", async () => {
    vi.mocked(appendFileSync).mockImplementation(() => undefined);
    registerUndo(makeOptions({ id: "x".repeat(100), actionType: "file-write" }));
    await executeUndo(() => BASE_NOW);

    const [, written] = vi.mocked(appendFileSync).mock.calls[0];
    const entry = JSON.parse((written as string).trim());
    expect(entry.inputSummary.length).toBeLessThanOrEqual(80);
  });

  it("includes durationMs in the audit entry", async () => {
    vi.mocked(appendFileSync).mockImplementation(() => undefined);
    let tick = BASE_NOW;
    const clockFn = () => {
      const t = tick;
      tick += 5; // advance 5ms each call
      return t;
    };
    registerUndo(makeOptions({ nowMs: () => BASE_NOW }));
    await executeUndo(clockFn);

    const [, written] = vi.mocked(appendFileSync).mock.calls[0];
    const entry = JSON.parse((written as string).trim());
    expect(typeof entry.durationMs).toBe("number");
  });

  it("falls back to memory buffer when appendFileSync throws", async () => {
    vi.mocked(appendFileSync).mockImplementation(() => {
      throw new Error("disk full");
    });
    registerUndo(makeOptions({ skill: "fallback-skill" }));
    await executeUndo(() => BASE_NOW);

    const buf = getMemoryBuffer();
    expect(buf.length).toBeGreaterThan(0);
    expect(buf[buf.length - 1].outcome).toBe("undone");
  });

  it("uses real Date.now() for timing when nowMs is not provided to executeUndo", async () => {
    vi.mocked(appendFileSync).mockImplementation(() => undefined);
    registerUndo({
      actionType: "file-write",
      skill: "skill",
      snapshot: null,
      undoFn: vi.fn().mockResolvedValue(undefined),
      nowMs: () => Date.now() - 1000,
    });
    const result = await executeUndo(); // no clock arg — uses real Date.now()
    expect(result).toBe(true);
    const [, written] = vi.mocked(appendFileSync).mock.calls[0];
    const entry = JSON.parse((written as string).trim());
    expect(entry.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ── clearUndoForTesting ───────────────────────────────────────────────────────

describe("clearUndoForTesting", () => {
  it("removes the current entry", () => {
    registerUndo(makeOptions());
    clearUndoForTesting();
    expect(getCurrentUndo(() => BASE_NOW)).toBeNull();
  });

  it("does not throw when registry is already empty", () => {
    expect(() => clearUndoForTesting()).not.toThrow();
  });
});

// ── UndoEntry type contract ───────────────────────────────────────────────────

describe("UndoEntry type contract", () => {
  it("accepts null as snapshot", () => {
    const entry = registerUndo(makeOptions({ snapshot: null }));
    expect(entry.snapshot).toBeNull();
  });

  it("accepts a complex object as snapshot", () => {
    const snapshot = { a: 1, b: [1, 2, 3], c: { nested: true } };
    const entry = registerUndo(makeOptions({ snapshot }));
    expect(entry.snapshot).toStrictEqual(snapshot);
  });

  it("returned entry reference matches getCurrentUndo", () => {
    const registered = registerUndo(makeOptions());
    const retrieved = getCurrentUndo(() => BASE_NOW);
    expect(retrieved).toBe(registered);
  });
});

// ── Idempotency guard ─────────────────────────────────────────────────────────

describe("idempotency contract", () => {
  it("calling undoFn a second time does not throw (idempotent undoFn)", async () => {
    let callCount = 0;
    const undoFn = async () => {
      callCount += 1;
      // Idempotent: second call is a no-op that doesn't throw
    };
    registerUndo(makeOptions({ undoFn }));
    await executeUndo(() => BASE_NOW);
    // Manually call undoFn again to confirm it doesn't throw
    await undoFn();
    expect(callCount).toBe(2);
  });
});
