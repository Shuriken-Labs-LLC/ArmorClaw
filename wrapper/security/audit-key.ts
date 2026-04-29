/**
 * Audit log HMAC key — loaded from keychain via keytar; generated on first run.
 *
 * Service: "armorclaw"
 * Account: "audit-hmac-key"
 *
 * Never throws. On keychain failure, returns null; the audit logger then
 * writes entries with hmac: null and audit-verify treats them as "unverified".
 *
 * Single key per install. Rotation is post-launch work.
 *
 * The async getAuditKey() loads/generates/caches; the sync getAuditKeySync()
 * returns whatever is cached. The audit-logger uses the sync accessor at write
 * time so writeAuditEntry can stay synchronous (preserving the never-throw
 * contract and avoiding cascading async churn across 26 production call sites);
 * the cache is warmed by a fire-and-forget getAuditKey() call in
 * registerAuditLogger() during plugin startup.
 */

import { randomBytes } from "node:crypto";

const SERVICE = "armorclaw";
const ACCOUNT = "audit-hmac-key";
const KEY_LENGTH_BYTES = 32; // 256 bits

interface KeytarLike {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
}

let cachedKey: Buffer | null = null;
let cacheLoaded = false;
let loadPromise: Promise<Buffer | null> | null = null;

async function loadKeytar(): Promise<KeytarLike | null> {
  try {
    return (await import("keytar")) as unknown as KeytarLike;
  } catch {
    return null;
  }
}

async function doLoad(): Promise<Buffer | null> {
  try {
    const kt = await loadKeytar();
    if (!kt) {
      cachedKey = null;
    } else {
      const existing = await kt.getPassword(SERVICE, ACCOUNT);
      if (existing) {
        cachedKey = Buffer.from(existing, "base64");
      } else {
        const fresh = randomBytes(KEY_LENGTH_BYTES);
        await kt.setPassword(SERVICE, ACCOUNT, fresh.toString("base64"));
        cachedKey = fresh;
      }
    }
  } catch {
    cachedKey = null;
  }
  cacheLoaded = true;
  return cachedKey;
}

/**
 * Async load — returns the cached key, or loads/generates on first call.
 * Concurrent callers share a single in-flight load promise. Never throws.
 */
export async function getAuditKey(): Promise<Buffer | null> {
  if (cacheLoaded) {
    return cachedKey;
  }
  if (!loadPromise) {
    loadPromise = doLoad();
  }
  return loadPromise;
}

/**
 * Sync accessor — returns the cached key or null. Returns null if
 * getAuditKey() has not yet completed (race window during startup).
 * Used by audit-logger.writeAuditEntry to stay synchronous.
 */
export function getAuditKeySync(): Buffer | null {
  return cacheLoaded ? cachedKey : null;
}

/** Reset cache. Intended for test isolation only. */
export function clearAuditKeyCacheForTesting(): void {
  cachedKey = null;
  cacheLoaded = false;
  loadPromise = null;
}
