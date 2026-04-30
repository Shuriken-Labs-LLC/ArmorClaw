/**
 * Browser domain allowlist. Loaded from ~/.armorclaw/browser-allowlist.json.
 * Empty by default; user adds domains via dashboard Settings or onboarding.
 *
 * Domain matching:
 *   - "github.com" allows github.com AND any subdomain (api.github.com, gist.github.com)
 *   - "github.com" does NOT allow githubusercontent.com or github.com.attacker.com
 *   - Apex+subdomain is the only mode in v1; no leading-dot syntax
 *   - Punycode/IDN: hostnames normalized to punycode form before comparison
 *   - Case-insensitive
 *   - Port numbers ignored
 *   - URLs with no host (file://, data:) are never allowed
 *   - Localhost / 127.x / 10.x / 172.16-31.x / 192.168.x / ::1 / 0.0.0.0 are
 *     ALWAYS blocked, even if explicitly listed — DNS rebinding defense.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

function allowlistPath(): string {
  return join(homedir(), ".armorclaw", "browser-allowlist.json");
}

let cachedAllowlist: string[] | null = null;

export function getAllowedDomains(): string[] {
  if (cachedAllowlist !== null) {
    return cachedAllowlist;
  }
  try {
    const content = readFileSync(allowlistPath(), "utf-8");
    const parsed = JSON.parse(content) as unknown;
    if (!Array.isArray(parsed)) {
      cachedAllowlist = [];
      return cachedAllowlist;
    }
    cachedAllowlist = parsed.filter((d): d is string => typeof d === "string");
    return cachedAllowlist;
  } catch {
    cachedAllowlist = [];
    return cachedAllowlist;
  }
}

export function setAllowedDomains(domains: readonly string[]): string[] {
  const normalized = Array.from(
    new Set(
      domains.map((d) => normalizeDomain(d)).filter((d): d is string => d !== null && d.length > 0),
    ),
  );
  const path = allowlistPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(normalized, null, 2), "utf-8");
  cachedAllowlist = normalized;
  return normalized;
}

export function isDomainAllowed(url: string): boolean {
  const host = extractHost(url);
  if (host === null) {
    return false;
  }
  if (isPrivateAddress(host)) {
    return false;
  }
  const normalizedHost = normalizeDomain(host);
  if (normalizedHost === null) {
    return false;
  }
  return getAllowedDomains().some((allowed) => matchesDomainOrSubdomain(normalizedHost, allowed));
}

export function extractHost(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "") {
      return null;
    }
    let host = parsed.hostname;
    // WHATWG URL retains square brackets around IPv6 literals — strip them
    // so isPrivateAddress / normalizeDomain see a plain address.
    if (host.startsWith("[") && host.endsWith("]")) {
      host = host.slice(1, -1);
    }
    return host;
  } catch {
    return null;
  }
}

function isIPv4Octet(value: string): number | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }
  const n = Number(value);
  if (n < 0 || n > 255) {
    return null;
  }
  return n;
}

function isIPv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const octets: number[] = [];
  for (const part of parts) {
    const n = isIPv4Octet(part);
    if (n === null) {
      return null;
    }
    octets.push(n);
  }
  return octets;
}

export function isPrivateAddress(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower === "localhost" || lower === "ip6-localhost" || lower === "ip6-loopback") {
    return true;
  }
  // IPv6 loopback / unspecified (URL parser strips brackets but leaves the address)
  if (
    lower === "::1" ||
    lower === "::" ||
    lower === "0:0:0:0:0:0:0:1" ||
    lower === "0:0:0:0:0:0:0:0"
  ) {
    return true;
  }
  // IPv6 link-local (fe80::/10) and unique-local (fc00::/7)
  if (/^fe[89ab][0-9a-f]?:/.test(lower) || /^f[cd][0-9a-f]{2}:/.test(lower)) {
    return true;
  }
  // IPv4-mapped IPv6 like ::ffff:127.0.0.1
  const v4MappedMatch = lower.match(/^::ffff:([0-9.]+)$/);
  if (v4MappedMatch) {
    const inner = isIPv4(v4MappedMatch[1]);
    if (inner !== null) {
      return isPrivateIPv4(inner);
    }
  }
  const octets = isIPv4(lower);
  if (octets !== null) {
    return isPrivateIPv4(octets);
  }
  return false;
}

function isPrivateIPv4(octets: number[]): boolean {
  const [a, b] = octets as [number, number, number, number];
  // 0.0.0.0/8 — "this network"
  if (a === 0) {
    return true;
  }
  // 10.0.0.0/8
  if (a === 10) {
    return true;
  }
  // 127.0.0.0/8 — loopback
  if (a === 127) {
    return true;
  }
  // 169.254.0.0/16 — link-local
  if (a === 169 && b === 254) {
    return true;
  }
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  // 192.168.0.0/16
  if (a === 192 && b === 168) {
    return true;
  }
  return false;
}

export function normalizeDomain(input: string): string | null {
  const trimmed = input.trim().replace(/\.+$/, "").toLowerCase();
  if (trimmed === "") {
    return null;
  }
  // Use URL constructor for IDN/punycode normalization.
  try {
    return new URL(`http://${trimmed}/`).hostname;
  } catch {
    return null;
  }
}

export function matchesDomainOrSubdomain(host: string, allowed: string): boolean {
  const allowedNorm = normalizeDomain(allowed);
  if (allowedNorm === null) {
    return false;
  }
  if (host === allowedNorm) {
    return true;
  }
  return host.endsWith("." + allowedNorm);
}

export function clearAllowlistCacheForTesting(): void {
  cachedAllowlist = null;
}
