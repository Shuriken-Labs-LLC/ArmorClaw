/**
 * Audit log chain validator. Reads the NDJSON log, walks each line, recomputes
 * HMAC and prev-hash chain, returns a structured result.
 *
 * Status semantics:
 *  - "ok"        : every entry has a verified HMAC and an intact prevHash chain
 *  - "partial"   : chain intact, but one or more entries had hmac: null (key
 *                  unavailable when written, or unavailable now)
 *  - "broken"    : prevHash mismatch or HMAC mismatch on at least one entry;
 *                  walking stops at the first break
 *  - "missing"   : audit log file does not exist or is unreadable
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
      break;
    }

    if (entry.prevHash !== prevHash) {
      firstBrokenSeq = entry.seq ?? totalEntries;
      break;
    }

    if (entry.hmac === null || entry.hmac === undefined) {
      unverifiedEntries++;
    } else if (key) {
      const { hmac, ...rest } = entry;
      const expected = createHmac("sha256", key).update(JSON.stringify(rest)).digest("hex");
      if (expected !== hmac) {
        firstBrokenSeq = entry.seq ?? totalEntries;
        break;
      }
      validEntries++;
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
    message = `Chain broken at seq ${firstBrokenSeq}. ${validEntries} entries verified, ${unverifiedEntries} unverified.`;
  } else if (unverifiedEntries > 0) {
    status = "partial";
    message = `Chain intact. ${validEntries} entries verified, ${unverifiedEntries} unverified (HMAC key was unavailable when written).`;
  } else {
    status = "ok";
    message = `Audit log verified. ${validEntries} entries with valid HMAC and intact chain.`;
  }

  return { status, totalEntries, validEntries, unverifiedEntries, firstBrokenSeq, message };
}
