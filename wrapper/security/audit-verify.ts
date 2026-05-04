/**
 * Audit log chain validator. Reads the NDJSON log, walks each line, recomputes
 * HMAC and prev-hash chain, returns a structured result.
 *
 * Status semantics:
 *  - "ok"        : every entry has a verified HMAC and an intact prevHash chain
 *  - "partial"   : chain intact, but one or more entries had hmac: null AND
 *                  no signed entry has been seen yet (legitimate keychain
 *                  warm-up window at daemon start)
 *  - "broken"    : prevHash mismatch, HMAC mismatch, parse failure, OR
 *                  null-HMAC after the chain has produced a signed entry;
 *                  walking stops at the first break
 *  - "missing"   : audit log file does not exist or is unreadable
 *
 * Null-after-signed rule: once the chain has produced a verified-signed
 * entry, any subsequent unsigned entry breaks the chain. Phase 2d's
 * keychain warm-up race makes the leading entries legitimately unsigned
 * (hmac: null) until the keychain becomes available; after that point, no
 * legitimate writer should produce an unsigned entry. An attacker who lands
 * entries during a later keychain outage would otherwise be indistinguishable
 * from a benign cold-start — this rule converts those into observable
 * tamper signals.
 *
 * Cold-start case (legitimate, status: "partial"):
 *   seq=1 hmac=null, seq=2 hmac=null, seq=3 hmac=<sig>, seq=4 hmac=<sig>
 *
 * Attack case (status: "broken" at seq=4):
 *   seq=1 hmac=null, seq=2 hmac=<sig>, seq=3 hmac=<sig>, seq=4 hmac=null
 */

import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAuditKey } from "./audit-key.ts";

export type VerifyStatus = "ok" | "broken" | "partial" | "missing";

export interface VerifyResult {
  status: VerifyStatus;
  totalEntries: number;
  validEntries: number;
  unverifiedEntries: number;
  firstBrokenSeq: number | null;
  message: string;
}

interface ParsedEntry {
  seq?: number;
  prevHash?: string;
  hmac?: string | null;
  [key: string]: unknown;
}

export async function verifyAuditLog(): Promise<VerifyResult> {
  const path = join(homedir(), ".armorclaw", "audit.log");
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return {
      status: "missing",
      totalEntries: 0,
      validEntries: 0,
      unverifiedEntries: 0,
      firstBrokenSeq: null,
      message: "Audit log file not found.",
    };
  }

  const key = await getAuditKey();
  let prevHash = "GENESIS";
  let totalEntries = 0;
  let validEntries = 0;
  let unverifiedEntries = 0;
  let firstBrokenSeq: number | null = null;
  let seenSignedEntry = false;
  let breakReason: "prevHash" | "hmac" | "null-after-signed" | "parse" | null = null;

  for (const line of content.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    totalEntries++;
    let entry: ParsedEntry;
    try {
      entry = JSON.parse(line) as ParsedEntry;
    } catch {
      firstBrokenSeq = totalEntries;
      breakReason = "parse";
      break;
    }

    if (entry.prevHash !== prevHash) {
      firstBrokenSeq = entry.seq ?? totalEntries;
      breakReason = "prevHash";
      break;
    }

    // Null-HMAC after the chain has produced a verified-signed entry breaks
    // the chain. See module docstring.
    if ((entry.hmac === null || entry.hmac === undefined) && seenSignedEntry) {
      firstBrokenSeq = entry.seq ?? totalEntries;
      breakReason = "null-after-signed";
      break;
    }

    if (entry.hmac === null || entry.hmac === undefined) {
      unverifiedEntries++;
    } else if (key) {
      const { hmac, ...rest } = entry;
      const expected = createHmac("sha256", key).update(JSON.stringify(rest)).digest("hex");
      if (expected !== hmac) {
        firstBrokenSeq = entry.seq ?? totalEntries;
        breakReason = "hmac";
        break;
      }
      validEntries++;
      seenSignedEntry = true;
    } else {
      // hmac present but key unavailable — cannot verify
      unverifiedEntries++;
    }

    prevHash = createHash("sha256").update(line).digest("hex");
  }

  let status: VerifyStatus;
  let message: string;
  if (firstBrokenSeq !== null) {
    status = "broken";
    message =
      breakReason === "null-after-signed"
        ? `Chain broken at seq ${firstBrokenSeq}: unsigned entry after the chain became signed. This may indicate tampering or a process that bypassed the keychain warm-up.`
        : `Chain broken at seq ${firstBrokenSeq}. ${validEntries} entries verified, ${unverifiedEntries} unverified.`;
  } else if (unverifiedEntries > 0) {
    status = "partial";
    message = `Chain intact. ${validEntries} entries verified, ${unverifiedEntries} unverified (HMAC key was unavailable when written).`;
  } else {
    status = "ok";
    message = `Audit log verified. ${validEntries} entries with valid HMAC and intact chain.`;
  }

  return { status, totalEntries, validEntries, unverifiedEntries, firstBrokenSeq, message };
}
