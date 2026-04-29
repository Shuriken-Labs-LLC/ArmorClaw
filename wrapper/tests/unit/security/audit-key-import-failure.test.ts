/**
 * Covers the import-failure branch in audit-key.ts: when `await import("keytar")`
 * itself rejects (e.g., native binding missing), loadKeytar's catch sets _keytar=null
 * and doLoad's `if (!kt)` branch returns null. Isolated to its own file because the
 * mock factory must throw at module-resolve time, which would corrupt other suites.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("keytar", () => {
  throw new Error("native binding missing");
});

import { clearAuditKeyCacheForTesting, getAuditKey } from "../../../security/audit-key.ts";

describe("getAuditKey — keytar dynamic import rejects", () => {
  it("returns null when the keytar module itself fails to load", async () => {
    clearAuditKeyCacheForTesting();
    const key = await getAuditKey();
    expect(key).toBeNull();
  });
});
