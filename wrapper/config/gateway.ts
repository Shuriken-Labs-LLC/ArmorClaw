/**
 * Gateway hardening — run at daemon startup.
 *
 * Responsibilities:
 *  1. Validate GATEWAY_HOST: reject 0.0.0.0 and any public IP with a
 *     plain-language error before the daemon starts.
 *  2. Call checkPlatformCompatibility() as the very first step.
 *
 * Token management is NOT done here — the gateway owns its token entirely.
 * It generates a random token on startup, writes it to openclaw.json, and
 * ArmorClaw reads it back after the gateway is confirmed reachable.
 *
 * All external I/O is injectable for testing.
 */

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

// ── Options type ────────────────────────────────────────────────────────────

export interface ValidateGatewayHostOptions {
  /** Override env host reader (default: process.env.GATEWAY_HOST). */
  getGatewayHost?: () => string | undefined;
  /** Override platform check (default: checkPlatformCompatibility). */
  platformCheck?: () => void;
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Validate the gateway host configuration.
 *
 * Steps (in order):
 *  1. Platform compatibility check (throws on hard failures).
 *  2. Validate GATEWAY_HOST — throws GatewayConfigError if it is 0.0.0.0
 *     or any public IP address.
 *  3. Write an audit entry.
 *
 * Throws GatewayConfigError if the gateway host is unsafe.
 */
export function validateGatewayHost(options: ValidateGatewayHostOptions = {}): void {
  // 1. Platform compatibility — throws on hard failure
  const platformCheck = options.platformCheck ?? (() => checkPlatformCompatibility());
  platformCheck();

  // 2. Validate GATEWAY_HOST
  const getGatewayHost = options.getGatewayHost ?? (() => process.env["GATEWAY_HOST"]);
  const rawHost = getGatewayHost();
  const host = rawHost?.trim() || null;

  if (host && isPublicIp(host)) {
    throw new GatewayConfigError(
      `ArmorClaw cannot start: GATEWAY_HOST is set to "${host}", which would expose ` +
        `your agent to the open internet. Use 127.0.0.1 or a Tailscale address instead. ` +
        `For remote access, configure Tailscale Serve (onboarding Step 5).`,
    );
  }

  // 3. Audit entry — outcome only
  writeAuditEntry({
    timestamp: new Date().toISOString(),
    skill: "gateway-config",
    permissionsUsed: [],
    inputSummary: `gateway-startup:host-validated:host:${host ?? "unset"}`.slice(0, 80),
    outcome: "success",
    durationMs: 0,
  });
}
