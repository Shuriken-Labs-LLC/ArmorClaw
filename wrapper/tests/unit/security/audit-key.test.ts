import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the keytar dynamic import. The audit-key module does
// `await import("keytar")` so the mock factory below is what gets resolved.
vi.mock("keytar", () => ({
  getPassword: vi.fn(),
  setPassword: vi.fn(),
}));

import * as keytar from "keytar";
import {
  clearAuditKeyCacheForTesting,
  getAuditKey,
  getAuditKeySync,
} from "../../../security/audit-key.ts";

const KEY_LENGTH_BYTES = 32;
const SERVICE = "armorclaw";
const ACCOUNT = "audit-hmac-key";

beforeEach(() => {
  vi.mocked(keytar.getPassword).mockReset();
  vi.mocked(keytar.setPassword).mockReset();
  clearAuditKeyCacheForTesting();
});

describe("getAuditKey — first run (no existing key)", () => {
  it("generates a fresh 32-byte key when keychain is empty", async () => {
    vi.mocked(keytar.getPassword).mockResolvedValueOnce(null);
    vi.mocked(keytar.setPassword).mockResolvedValueOnce(undefined);

    const key = await getAuditKey();

    expect(key).not.toBeNull();
    expect(key!.length).toBe(KEY_LENGTH_BYTES);
  });

  it("stores the freshly generated key via setPassword (base64-encoded)", async () => {
    vi.mocked(keytar.getPassword).mockResolvedValueOnce(null);
    vi.mocked(keytar.setPassword).mockResolvedValueOnce(undefined);

    await getAuditKey();

    expect(keytar.setPassword).toHaveBeenCalledOnce();
    const [service, account, value] = vi.mocked(keytar.setPassword).mock.calls[0]!;
    expect(service).toBe(SERVICE);
    expect(account).toBe(ACCOUNT);
    // Base64 representation of 32 bytes is 44 chars (with padding)
    expect(value.length).toBe(44);
    expect(Buffer.from(value, "base64").length).toBe(KEY_LENGTH_BYTES);
  });

  it("calls getPassword with the correct service and account", async () => {
    vi.mocked(keytar.getPassword).mockResolvedValueOnce(null);
    vi.mocked(keytar.setPassword).mockResolvedValueOnce(undefined);

    await getAuditKey();

    expect(keytar.getPassword).toHaveBeenCalledWith(SERVICE, ACCOUNT);
  });
});

describe("getAuditKey — existing key", () => {
  it("returns the stored key without invoking setPassword", async () => {
    const stored = Buffer.alloc(KEY_LENGTH_BYTES, 0xab);
    vi.mocked(keytar.getPassword).mockResolvedValueOnce(stored.toString("base64"));

    const key = await getAuditKey();

    expect(key).not.toBeNull();
    expect(Buffer.compare(key!, stored)).toBe(0);
    expect(keytar.setPassword).not.toHaveBeenCalled();
  });
});

describe("getAuditKey — caching", () => {
  it("caches the key after first call (subsequent calls do not invoke keytar)", async () => {
    vi.mocked(keytar.getPassword).mockResolvedValueOnce(null);
    vi.mocked(keytar.setPassword).mockResolvedValueOnce(undefined);

    const first = await getAuditKey();
    const second = await getAuditKey();
    const third = await getAuditKey();

    expect(first).toBe(second);
    expect(second).toBe(third);
    // First call invoked getPassword once; subsequent calls should not
    expect(keytar.getPassword).toHaveBeenCalledOnce();
    expect(keytar.setPassword).toHaveBeenCalledOnce();
  });

  it("concurrent first calls share a single in-flight load", async () => {
    vi.mocked(keytar.getPassword).mockResolvedValueOnce(null);
    vi.mocked(keytar.setPassword).mockResolvedValueOnce(undefined);

    const [a, b, c] = await Promise.all([getAuditKey(), getAuditKey(), getAuditKey()]);

    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(keytar.getPassword).toHaveBeenCalledOnce();
  });

  it("after clearAuditKeyCacheForTesting, next call re-loads from keychain", async () => {
    vi.mocked(keytar.getPassword)
      .mockResolvedValueOnce(null) // first run: generates fresh
      .mockResolvedValueOnce(Buffer.alloc(KEY_LENGTH_BYTES, 0xcd).toString("base64")); // second run: returns existing
    vi.mocked(keytar.setPassword).mockResolvedValueOnce(undefined);

    const first = await getAuditKey();
    clearAuditKeyCacheForTesting();
    const second = await getAuditKey();

    expect(keytar.getPassword).toHaveBeenCalledTimes(2);
    expect(Buffer.compare(first!, second!)).not.toBe(0); // different keys after reset
  });
});

describe("getAuditKey — keychain failures", () => {
  it("returns null when getPassword throws", async () => {
    vi.mocked(keytar.getPassword).mockRejectedValueOnce(new Error("keychain unlocked failed"));

    const key = await getAuditKey();

    expect(key).toBeNull();
  });

  it("returns null when setPassword throws on first run", async () => {
    vi.mocked(keytar.getPassword).mockResolvedValueOnce(null);
    vi.mocked(keytar.setPassword).mockRejectedValueOnce(new Error("write denied"));

    const key = await getAuditKey();

    expect(key).toBeNull();
  });

  it("caches null after a failure (does not retry)", async () => {
    vi.mocked(keytar.getPassword).mockRejectedValueOnce(new Error("denied"));

    const a = await getAuditKey();
    const b = await getAuditKey();

    expect(a).toBeNull();
    expect(b).toBeNull();
    expect(keytar.getPassword).toHaveBeenCalledOnce();
  });
});

describe("getAuditKeySync", () => {
  it("returns null before any async load has completed", () => {
    expect(getAuditKeySync()).toBeNull();
  });

  it("returns the cached key after getAuditKey resolves", async () => {
    const stored = Buffer.alloc(KEY_LENGTH_BYTES, 0xef);
    vi.mocked(keytar.getPassword).mockResolvedValueOnce(stored.toString("base64"));

    await getAuditKey();
    const sync = getAuditKeySync();

    expect(sync).not.toBeNull();
    expect(Buffer.compare(sync!, stored)).toBe(0);
  });

  it("returns null after a failed load", async () => {
    vi.mocked(keytar.getPassword).mockRejectedValueOnce(new Error("nope"));

    await getAuditKey();

    expect(getAuditKeySync()).toBeNull();
  });
});

describe("getAuditKey — keytar import failure", () => {
  it("returns null when the keytar module itself cannot be loaded", async () => {
    // Simulate keytar throwing on every call (proxy for an unloadable native module).
    // The internal _keytar reference still resolves, but getPassword failing immediately
    // exercises the same null-return path.
    vi.mocked(keytar.getPassword).mockImplementationOnce(() => {
      throw new Error("native binding missing");
    });

    const key = await getAuditKey();

    expect(key).toBeNull();
  });
});
