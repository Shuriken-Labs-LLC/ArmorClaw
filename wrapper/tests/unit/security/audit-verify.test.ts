import { createHash, createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
}));

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

import { readFileSync } from "node:fs";
import * as auditKeyModule from "../../../security/audit-key.ts";
import { verifyAuditLog } from "../../../security/audit-verify.ts";

const setMockedKey = (auditKeyModule as unknown as { _setMockedKey: (k: Buffer | null) => void })
  ._setMockedKey;

interface SignedFixture {
  timestamp: string;
  skill: string;
  permissionsUsed: string[];
  inputSummary: string;
  outcome: "success" | "rejected" | "error" | "undone";
  durationMs: number;
  seq: number;
  prevHash: string;
  hmac: string | null;
}

function buildEntry(
  partial: Partial<SignedFixture> & { seq: number; prevHash: string },
  key: Buffer | null,
): { entry: SignedFixture; line: string } {
  const base: Omit<SignedFixture, "hmac"> = {
    timestamp: "2026-04-29T00:00:00.000Z",
    skill: "tool",
    permissionsUsed: [],
    inputSummary: "{}",
    outcome: "success",
    durationMs: 0,
    ...partial,
  };
  const hmac = key ? createHmac("sha256", key).update(JSON.stringify(base)).digest("hex") : null;
  const entry: SignedFixture = { ...base, hmac };
  return { entry, line: JSON.stringify(entry) };
}

function buildChain(
  count: number,
  key: Buffer | null,
  options: { unsignedSeqs?: number[] } = {},
): { lines: string[]; content: string } {
  const lines: string[] = [];
  let prevHash = "GENESIS";
  for (let i = 1; i <= count; i++) {
    const entryKey = options.unsignedSeqs?.includes(i) ? null : key;
    const { line } = buildEntry({ seq: i, prevHash, skill: `tool-${i}` }, entryKey);
    lines.push(line);
    prevHash = createHash("sha256").update(line).digest("hex");
  }
  return { lines, content: lines.join("\n") + "\n" };
}

beforeEach(() => {
  vi.mocked(readFileSync).mockReset();
  setMockedKey(null);
});

describe("verifyAuditLog — file missing", () => {
  it("returns status 'missing' when readFileSync throws ENOENT", async () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    const result = await verifyAuditLog();
    expect(result.status).toBe("missing");
    expect(result.totalEntries).toBe(0);
    expect(result.message).toMatch(/not found/i);
  });
});

describe("verifyAuditLog — single entry", () => {
  it("status 'ok' for one valid signed entry", async () => {
    const key = Buffer.alloc(32, 0xaa);
    setMockedKey(key);
    const { content } = buildChain(1, key);
    vi.mocked(readFileSync).mockReturnValue(content);

    const result = await verifyAuditLog();

    expect(result.status).toBe("ok");
    expect(result.totalEntries).toBe(1);
    expect(result.validEntries).toBe(1);
    expect(result.unverifiedEntries).toBe(0);
    expect(result.firstBrokenSeq).toBeNull();
  });
});

describe("verifyAuditLog — chain of valid entries", () => {
  it("status 'ok' for three valid signed entries", async () => {
    const key = Buffer.alloc(32, 0xbb);
    setMockedKey(key);
    const { content } = buildChain(3, key);
    vi.mocked(readFileSync).mockReturnValue(content);

    const result = await verifyAuditLog();

    expect(result.status).toBe("ok");
    expect(result.totalEntries).toBe(3);
    expect(result.validEntries).toBe(3);
    expect(result.firstBrokenSeq).toBeNull();
  });
});

describe("verifyAuditLog — broken prevHash", () => {
  it("detects a tampered prevHash on entry 2", async () => {
    const key = Buffer.alloc(32, 0xcc);
    setMockedKey(key);
    const { lines } = buildChain(3, key);
    // Tamper: rewrite the second entry's prevHash and re-sign so HMAC matches
    // but the chain link breaks.
    const second = JSON.parse(lines[1]) as SignedFixture;
    second.prevHash = "0".repeat(64); // wrong prev
    const { hmac: _hmac, ...rest } = second;
    second.hmac = createHmac("sha256", key).update(JSON.stringify(rest)).digest("hex");
    const tampered = [lines[0], JSON.stringify(second), lines[2]].join("\n") + "\n";
    vi.mocked(readFileSync).mockReturnValue(tampered);

    const result = await verifyAuditLog();

    expect(result.status).toBe("broken");
    expect(result.firstBrokenSeq).toBe(2);
  });
});

describe("verifyAuditLog — tampered content (HMAC mismatch)", () => {
  it("detects a flipped field whose HMAC no longer matches", async () => {
    const key = Buffer.alloc(32, 0xdd);
    setMockedKey(key);
    const { lines } = buildChain(2, key);
    const second = JSON.parse(lines[1]) as SignedFixture;
    // Flip a field but leave the (now-invalid) HMAC in place
    second.skill = "TAMPERED";
    const tampered = [lines[0], JSON.stringify(second)].join("\n") + "\n";
    vi.mocked(readFileSync).mockReturnValue(tampered);

    const result = await verifyAuditLog();

    expect(result.status).toBe("broken");
    expect(result.firstBrokenSeq).toBe(2);
    expect(result.validEntries).toBe(1); // first entry is still good
  });
});

describe("verifyAuditLog — partial (some unsigned entries)", () => {
  it("returns 'partial' when some entries have hmac:null", async () => {
    const key = Buffer.alloc(32, 0xee);
    setMockedKey(key);
    const { content } = buildChain(3, key, { unsignedSeqs: [2] });
    vi.mocked(readFileSync).mockReturnValue(content);

    const result = await verifyAuditLog();

    expect(result.status).toBe("partial");
    expect(result.validEntries).toBe(2);
    expect(result.unverifiedEntries).toBe(1);
    expect(result.firstBrokenSeq).toBeNull();
  });

  it("returns 'partial' when ALL entries are unsigned", async () => {
    const { content } = buildChain(3, null);
    setMockedKey(Buffer.alloc(32, 0xff)); // key now available, but old entries lack hmac
    vi.mocked(readFileSync).mockReturnValue(content);

    const result = await verifyAuditLog();

    expect(result.status).toBe("partial");
    expect(result.validEntries).toBe(0);
    expect(result.unverifiedEntries).toBe(3);
  });
});

describe("verifyAuditLog — malformed JSON", () => {
  it("treats a malformed line as the broken point", async () => {
    const key = Buffer.alloc(32, 0xa0);
    setMockedKey(key);
    const { lines } = buildChain(2, key);
    const content = `${lines[0]}\nnot-valid-json{{{\n${lines[1]}\n`;
    vi.mocked(readFileSync).mockReturnValue(content);

    const result = await verifyAuditLog();

    expect(result.status).toBe("broken");
    expect(result.firstBrokenSeq).toBe(2); // 2nd line counted, malformed
    expect(result.totalEntries).toBe(2);
  });

  it("does not crash on a single malformed line", async () => {
    setMockedKey(Buffer.alloc(32, 0xa1));
    vi.mocked(readFileSync).mockReturnValue("garbage\n");
    await expect(verifyAuditLog()).resolves.toMatchObject({ status: "broken" });
  });
});

describe("verifyAuditLog — key unavailable at verify time", () => {
  it("treats signed entries as unverified when getAuditKey returns null", async () => {
    // Build with a key, then verify with no key.
    const key = Buffer.alloc(32, 0xbe);
    const { content } = buildChain(2, key);
    setMockedKey(null);
    vi.mocked(readFileSync).mockReturnValue(content);

    const result = await verifyAuditLog();

    expect(result.status).toBe("partial");
    expect(result.unverifiedEntries).toBe(2);
    expect(result.validEntries).toBe(0);
  });
});

describe("verifyAuditLog — empty and whitespace input", () => {
  it("returns 'ok' (zero entries verified) for an empty file", async () => {
    setMockedKey(Buffer.alloc(32, 0xef));
    vi.mocked(readFileSync).mockReturnValue("");

    const result = await verifyAuditLog();

    expect(result.status).toBe("ok");
    expect(result.totalEntries).toBe(0);
    expect(result.validEntries).toBe(0);
  });

  it("ignores blank lines while walking the chain", async () => {
    const key = Buffer.alloc(32, 0xc0);
    setMockedKey(key);
    const { lines } = buildChain(2, key);
    const content = lines[0] + "\n\n" + lines[1] + "\n\n";
    vi.mocked(readFileSync).mockReturnValue(content);

    const result = await verifyAuditLog();

    expect(result.status).toBe("ok");
    expect(result.totalEntries).toBe(2);
  });
});

describe("verifyAuditLog — entry.seq fallback", () => {
  it("falls back to totalEntries when a broken-chain entry lacks seq", async () => {
    const key = Buffer.alloc(32, 0xa9);
    setMockedKey(key);
    // Build a valid first entry, then a second with prevHash mismatch and NO seq field
    const { lines } = buildChain(1, key);
    const malformedSecond = JSON.stringify({
      timestamp: "x",
      skill: "no-seq",
      prevHash: "mismatch",
      hmac: null,
    });
    const content = lines[0] + "\n" + malformedSecond + "\n";
    vi.mocked(readFileSync).mockReturnValue(content);

    const result = await verifyAuditLog();

    expect(result.status).toBe("broken");
    expect(result.firstBrokenSeq).toBe(2); // fell back to totalEntries (the 2nd line)
  });

  it("falls back to totalEntries when an HMAC-mismatched entry lacks seq", async () => {
    const key = Buffer.alloc(32, 0xab);
    setMockedKey(key);
    // First entry valid; second has correct prevHash but wrong hmac AND no seq
    const { lines } = buildChain(1, key);
    const firstHash = createHash("sha256").update(lines[0]).digest("hex");
    const malformedSecond = JSON.stringify({
      timestamp: "x",
      skill: "no-seq-bad-hmac",
      prevHash: firstHash,
      hmac: "f".repeat(64), // arbitrary wrong hmac
    });
    const content = lines[0] + "\n" + malformedSecond + "\n";
    vi.mocked(readFileSync).mockReturnValue(content);

    const result = await verifyAuditLog();

    expect(result.status).toBe("broken");
    expect(result.firstBrokenSeq).toBe(2);
  });
});

describe("verifyAuditLog — message text", () => {
  it("'ok' message includes the verified count", async () => {
    const key = Buffer.alloc(32, 0xc1);
    setMockedKey(key);
    const { content } = buildChain(2, key);
    vi.mocked(readFileSync).mockReturnValue(content);

    const result = await verifyAuditLog();
    expect(result.message).toMatch(/2 entries/);
    expect(result.message).toMatch(/intact chain/);
  });

  it("'broken' message includes the broken seq", async () => {
    const key = Buffer.alloc(32, 0xc2);
    setMockedKey(key);
    const { lines } = buildChain(3, key);
    const second = JSON.parse(lines[1]) as SignedFixture;
    second.prevHash = "0".repeat(64);
    const { hmac: _hmac, ...rest } = second;
    second.hmac = createHmac("sha256", key).update(JSON.stringify(rest)).digest("hex");
    const content = [lines[0], JSON.stringify(second), lines[2]].join("\n") + "\n";
    vi.mocked(readFileSync).mockReturnValue(content);

    const result = await verifyAuditLog();
    expect(result.message).toMatch(/seq 2/);
  });

  it("'partial' message mentions unsigned entries", async () => {
    const key = Buffer.alloc(32, 0xc3);
    setMockedKey(key);
    const { content } = buildChain(2, key, { unsignedSeqs: [1, 2] });
    vi.mocked(readFileSync).mockReturnValue(content);

    const result = await verifyAuditLog();
    expect(result.message).toMatch(/unverified/);
  });
});
