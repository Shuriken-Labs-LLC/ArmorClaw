/**
 * Gateway hardening — run at daemon startup.
 *
 * Responsibilities:
 *  1. Validate GATEWAY_HOST: reject 0.0.0.0 and any public IP with a
 *     plain-language error before the daemon starts.
 *  2. Generate a cryptographically random auth token (≥ 48 chars,
 *     crypto.randomBytes) on every daemon restart.
 *  3. Write the token to .env only — never to logs, audit output, or
 *     error messages.
 *  4. Register a session_start hook for ongoing token rotation.
 *  5. Call checkPlatformCompatibility() as the very first step.
 *
 * All external I/O and randomness are injectable for testing.
 */

import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { writeAuditEntry } from "../security/audit-logger.ts";
import { checkPlatformCompatibility } from "./platform.ts";

// ── Error type ─────────────────────────────────────────────────────────────────

export class GatewayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayConfigError";
  }
}

// ── Public-IP detection ───────────────────────────────────────────────────────

/**
 * Returns true if `host` is a public IP address or an all-interface binding
 * that would expose the gateway to the open internet.
 *
 * Explicitly allowed (returns false):
 *  - "localhost"
 *  - Loopback: 127.x.x.x, ::1
 *  - Private IPv4: 10.x, 172.16–31.x, 192.168.x
 *
 * Rejected (returns true):
 *  - 0.0.0.0 and :: (all-interface bindings)
 *  - Any other IPv4 address (routable on the public internet)
 *  - Any other IPv6 address
 *
 * Hostnames (non-IP strings like "myserver.local") are not rejected by
 * this check — only IP literals are evaluated.
 */
export function isPublicIp(host: string): boolean {
  const h = host.trim();

  // All-interface bindings — always reject
  if (h === "0.0.0.0" || h === "::") {
    return true;
  }

  // Loopback — always allow
  if (h === "localhost" || h === "::1") {
    return false;
  }
  if (h.startsWith("127.")) {
    return false;
  }

  // Private IPv4 ranges (RFC 1918) — allow
  if (h.startsWith("10.")) {
    return false;
  }
  if (h.startsWith("192.168.")) {
    return false;
  }
  const m172 = /^172\.(\d+)\./.exec(h);
  if (m172) {
    const octet = parseInt(m172[1], 10);
    if (octet >= 16 && octet <= 31) {
      return false;
    }
  }

  // Any other IPv4 literal — public, reject
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) {
    return true;
  }

  // Any other IPv6 literal (contains colons, is not ::1) — public, reject
  if (h.includes(":")) {
    return true;
  }

  // Hostname string (not an IP literal) — not rejected by this check
  return false;
}

// ── Token generation ──────────────────────────────────────────────────────────

/**
 * Generate a cryptographically random auth token.
 * 32 random bytes → 64-character hex string (well above the 48-char minimum).
 *
 * @param randomBytesFn - Injectable random source (default: crypto.randomBytes).
 */
export function generateAuthToken(randomBytesFn: (n: number) => Buffer = randomBytes): string {
  return randomBytesFn(32).toString("hex");
}

// ── .env token writer ─────────────────────────────────────────────────────────

/**
 * The .env file lives two directories above this file:
 * wrapper/config/ → wrapper/ → armorclaw/ (repo root).
 */
const ENV_FILE = join(import.meta.dirname, "..", "..", ".env");

/**
 * Write ARMORCLAW_GATEWAY_TOKEN to the repo-root .env file.
 * Preserves all other lines. Never throws. Returns true on success.
 *
 * SECURITY: The token value is written only here — never to the audit log,
 * never to console output, never interpolated into error messages.
 */
export function writeTokenToEnv(token: string, envFile = ENV_FILE): boolean {
  try {
    let existing = "";
    try {
      existing = readFileSync(envFile, "utf-8");
    } catch {
      /* new file */
    }
    const prefix = "ARMORCLAW_GATEWAY_TOKEN=";
    let found = false;
    const lines = existing.split("\n").map((line) => {
      if (line.startsWith(prefix)) {
        found = true;
        return `${prefix}${token}`;
      }
      return line;
    });
    if (!found) {
      lines.push(`${prefix}${token}`);
    }
    writeFileSync(envFile, lines.join("\n").replace(/\n+$/, "") + "\n", "utf-8");
    return true;
  } catch {
    return false;
  }
}

// ── Options & result types ────────────────────────────────────────────────────

export interface GatewayConfigOptions {
  /** Override env host reader (default: process.env.GATEWAY_HOST). */
  getGatewayHost?: () => string | undefined;
  /**
   * Override token writer (default: writeTokenToEnv).
   * Receives the raw token — must not log it.
   */
  writeToken?: (token: string) => boolean;
  /** Override random bytes source (default: crypto.randomBytes). */
  randomBytesFn?: (n: number) => Buffer;
  /** Override platform check (default: checkPlatformCompatibility). */
  platformCheck?: () => void;
}

export interface GatewayConfigResult {
  /** Effective GATEWAY_HOST value, or null if unset. */
  gatewayHost: string | null;
  /** True if the token was successfully written to .env. */
  tokenWritten: boolean;
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Validate the gateway configuration and rotate the auth token.
 *
 * Steps (in order):
 *  1. Platform compatibility check (throws on hard failures).
 *  2. Validate GATEWAY_HOST — throws GatewayConfigError if it is 0.0.0.0
 *     or any public IP address.
 *  3. Generate a new auth token and write it to .env.
 *  4. Write an audit entry (never includes the token value).
 *
 * Throws GatewayConfigError if the gateway host is unsafe.
 * Never includes the auth token in any thrown error or log message.
 */
export function validateGatewayConfig(options: GatewayConfigOptions = {}): GatewayConfigResult {
  // 1. Platform compatibility — throws on hard failure
  const platformCheck = options.platformCheck ?? (() => checkPlatformCompatibility());
  platformCheck();

  // 2. Validate GATEWAY_HOST
  const getGatewayHost = options.getGatewayHost ?? (() => process.env["GATEWAY_HOST"]);
  const rawHost = getGatewayHost();
  const host = rawHost?.trim() || null;

  if (host && isPublicIp(host)) {
    // Error message deliberately contains the offending host value (not a secret)
    // but NEVER contains the auth token.
    throw new GatewayConfigError(
      `ArmorClaw cannot start: GATEWAY_HOST is set to "${host}", which would expose ` +
        `your agent to the open internet. Use 127.0.0.1 or a Tailscale address instead. ` +
        `For remote access, configure Tailscale Serve (onboarding Step 5).`,
    );
  }

  // 3. Generate and write a new auth token
  const randomBytesFn = options.randomBytesFn ?? randomBytes;
  const token = generateAuthToken(randomBytesFn);
  const writeToken = options.writeToken ?? ((t: string) => writeTokenToEnv(t));
  const tokenWritten = writeToken(token);

  // 4. Audit entry — outcome only, no token value, no host secrets
  writeAuditEntry({
    timestamp: new Date().toISOString(),
    skill: "gateway-config",
    permissionsUsed: [],
    inputSummary: `gateway-startup:token-rotated:host:${host ?? "unset"}`.slice(0, 80),
    outcome: "success",
    durationMs: 0,
  });

  return { gatewayHost: host, tokenWritten };
}

// ── Session-start token rotation ──────────────────────────────────────────────

export interface TokenRotationOptions {
  /** Override random bytes source (default: crypto.randomBytes). */
  randomBytesFn?: (n: number) => Buffer;
  /** Override token writer (default: writeTokenToEnv). */
  writeToken?: (token: string) => boolean;
}

/**
 * Register a session_start hook that rotates the auth token on every new
 * session. Call once at daemon startup, after validateGatewayConfig().
 *
 * The token is written silently — no value appears in the audit log.
 */
export function registerTokenRotation(
  api: OpenClawPluginApi,
  options: TokenRotationOptions = {},
): void {
  const randomBytesFn = options.randomBytesFn ?? randomBytes;
  const writeToken = options.writeToken ?? ((t: string) => writeTokenToEnv(t));

  api.on("session_start", () => {
    const token = generateAuthToken(randomBytesFn);
    writeToken(token);
    writeAuditEntry({
      timestamp: new Date().toISOString(),
      skill: "gateway-config",
      permissionsUsed: [],
      inputSummary: "gateway-token:rotated-on-session-start",
      outcome: "success",
      durationMs: 0,
    });
  });
}
