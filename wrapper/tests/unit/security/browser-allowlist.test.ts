import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoist fs mock before module import.
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  clearAllowlistCacheForTesting,
  extractHost,
  getAllowedDomains,
  isDomainAllowed,
  isPrivateAddress,
  matchesDomainOrSubdomain,
  normalizeDomain,
  setAllowedDomains,
} from "../../../security/browser-allowlist.ts";

beforeEach(() => {
  vi.mocked(readFileSync).mockReset();
  vi.mocked(writeFileSync).mockReset();
  vi.mocked(mkdirSync).mockReset();
  clearAllowlistCacheForTesting();
});

// ── getAllowedDomains ────────────────────────────────────────────────────────

describe("getAllowedDomains", () => {
  it("returns [] when file is missing", () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(getAllowedDomains()).toEqual([]);
  });

  it("returns parsed array from valid file", () => {
    vi.mocked(readFileSync).mockReturnValueOnce(JSON.stringify(["github.com", "wikipedia.org"]));
    expect(getAllowedDomains()).toEqual(["github.com", "wikipedia.org"]);
  });

  it("returns [] when file is malformed JSON", () => {
    vi.mocked(readFileSync).mockReturnValueOnce("not valid json{{{");
    expect(getAllowedDomains()).toEqual([]);
  });

  it("returns [] when JSON is not an array", () => {
    vi.mocked(readFileSync).mockReturnValueOnce(JSON.stringify({ domains: ["x"] }));
    expect(getAllowedDomains()).toEqual([]);
  });

  it("filters out non-string entries", () => {
    vi.mocked(readFileSync).mockReturnValueOnce(
      JSON.stringify(["github.com", 42, null, "wikipedia.org", { not: "a string" }]),
    );
    expect(getAllowedDomains()).toEqual(["github.com", "wikipedia.org"]);
  });

  it("caches across calls — second call does not read file", () => {
    vi.mocked(readFileSync).mockReturnValueOnce(JSON.stringify(["github.com"]));
    expect(getAllowedDomains()).toEqual(["github.com"]);
    expect(getAllowedDomains()).toEqual(["github.com"]);
    expect(readFileSync).toHaveBeenCalledTimes(1);
  });
});

// ── setAllowedDomains ────────────────────────────────────────────────────────

describe("setAllowedDomains", () => {
  it("writes normalized JSON, dedupes, and creates parent directory", () => {
    setAllowedDomains(["GitHub.com", "github.com", "wikipedia.org"]);
    expect(mkdirSync).toHaveBeenCalledTimes(1);
    expect(writeFileSync).toHaveBeenCalledTimes(1);
    const writeArgs = vi.mocked(writeFileSync).mock.calls[0];
    const written = JSON.parse(writeArgs[1] as string) as string[];
    expect(written).toEqual(["github.com", "wikipedia.org"]);
  });

  it("returns the normalized list", () => {
    const result = setAllowedDomains(["GitHub.com", "wikipedia.org"]);
    expect(result).toEqual(["github.com", "wikipedia.org"]);
  });

  it("filters out empty strings and unparseable inputs", () => {
    const result = setAllowedDomains(["github.com", "", "  ", "not a domain at all", "\n"]);
    // Empty/whitespace inputs and inputs containing characters URL rejects
    // (whitespace, control chars) all drop out via normalizeDomain -> null.
    expect(result).toEqual(["github.com"]);
  });

  it("updates the in-memory cache so getAllowedDomains reflects the new state", () => {
    vi.mocked(readFileSync).mockReturnValueOnce(JSON.stringify(["wikipedia.org"]));
    expect(getAllowedDomains()).toEqual(["wikipedia.org"]);

    setAllowedDomains(["github.com"]);
    // No re-read needed; cache updated
    expect(getAllowedDomains()).toEqual(["github.com"]);
  });
});

// ── extractHost ──────────────────────────────────────────────────────────────

describe("extractHost", () => {
  it("returns hostname for https://", () => {
    expect(extractHost("https://github.com/foo")).toBe("github.com");
  });

  it("returns hostname for http:// with port", () => {
    expect(extractHost("http://github.com:8080/foo")).toBe("github.com");
  });

  it("returns null for file://", () => {
    expect(extractHost("file:///etc/passwd")).toBeNull();
  });

  it("returns null for data:", () => {
    expect(extractHost("data:text/html;base64,SGVsbG8=")).toBeNull();
  });

  it("returns null for unparseable URL", () => {
    expect(extractHost("not a url at all")).toBeNull();
  });

  it("strips brackets from IPv6 literal hostnames", () => {
    expect(extractHost("https://[::1]/")).toBe("::1");
    expect(extractHost("https://[2001:db8::1]/")).toBe("2001:db8::1");
  });
});

// ── isPrivateAddress ─────────────────────────────────────────────────────────

describe("isPrivateAddress", () => {
  it("returns true for localhost", () => {
    expect(isPrivateAddress("localhost")).toBe(true);
    expect(isPrivateAddress("LOCALHOST")).toBe(true);
  });

  it("returns true for IPv6 loopback variants", () => {
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("0:0:0:0:0:0:0:1")).toBe(true);
    expect(isPrivateAddress("::")).toBe(true);
    expect(isPrivateAddress("0:0:0:0:0:0:0:0")).toBe(true);
    expect(isPrivateAddress("ip6-localhost")).toBe(true);
    expect(isPrivateAddress("ip6-loopback")).toBe(true);
  });

  it("returns true for IPv6 link-local fe80::/10", () => {
    expect(isPrivateAddress("fe80::1")).toBe(true);
    expect(isPrivateAddress("fe9a::1")).toBe(true);
  });

  it("returns true for IPv6 unique-local fc00::/7", () => {
    expect(isPrivateAddress("fc00::1")).toBe(true);
    expect(isPrivateAddress("fd12::5678")).toBe(true);
  });

  it("returns true for IPv4-mapped IPv6 loopback", () => {
    expect(isPrivateAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateAddress("::ffff:10.0.0.1")).toBe(true);
  });

  it("returns false for IPv4-mapped IPv6 of a public address", () => {
    expect(isPrivateAddress("::ffff:8.8.8.8")).toBe(false);
  });

  it("returns false for IPv4-mapped IPv6 with malformed inner address", () => {
    expect(isPrivateAddress("::ffff:not-an-ip")).toBe(false);
  });

  it("returns false for IPv4-mapped IPv6 where digits-and-dots don't form a valid IPv4", () => {
    // Regex matches "::ffff:<digits-and-dots>" but inner isn't four octets.
    expect(isPrivateAddress("::ffff:1.2.3")).toBe(false);
    expect(isPrivateAddress("::ffff:999.0.0.1")).toBe(false);
  });

  it("returns true for 127.0.0.0/8", () => {
    expect(isPrivateAddress("127.0.0.1")).toBe(true);
    expect(isPrivateAddress("127.255.255.254")).toBe(true);
  });

  it("returns true for 10.0.0.0/8", () => {
    expect(isPrivateAddress("10.0.0.1")).toBe(true);
  });

  it("returns true for 172.16.0.0/12", () => {
    expect(isPrivateAddress("172.16.0.1")).toBe(true);
    expect(isPrivateAddress("172.31.255.255")).toBe(true);
  });

  it("returns false for 172.15.x and 172.32.x (outside /12)", () => {
    expect(isPrivateAddress("172.15.0.1")).toBe(false);
    expect(isPrivateAddress("172.32.0.1")).toBe(false);
  });

  it("returns true for 192.168.0.0/16", () => {
    expect(isPrivateAddress("192.168.1.1")).toBe(true);
  });

  it("returns true for 169.254.0.0/16 link-local", () => {
    expect(isPrivateAddress("169.254.169.254")).toBe(true);
  });

  it("returns true for 0.0.0.0/8", () => {
    expect(isPrivateAddress("0.0.0.0")).toBe(true);
  });

  it("returns false for public IPv4 addresses", () => {
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("1.1.1.1")).toBe(false);
    expect(isPrivateAddress("172.32.0.1")).toBe(false);
  });

  it("returns false for non-IP hostnames", () => {
    expect(isPrivateAddress("github.com")).toBe(false);
    expect(isPrivateAddress("api.github.com")).toBe(false);
  });

  it("returns false for malformed IP-like strings", () => {
    expect(isPrivateAddress("999.999.999.999")).toBe(false);
    expect(isPrivateAddress("1.2.3")).toBe(false);
    expect(isPrivateAddress("1.2.3.4.5")).toBe(false);
    expect(isPrivateAddress("1.2.3.abc")).toBe(false);
  });
});

// ── normalizeDomain ──────────────────────────────────────────────────────────

describe("normalizeDomain", () => {
  it("lowercases input", () => {
    expect(normalizeDomain("GitHub.COM")).toBe("github.com");
  });

  it("strips trailing dots", () => {
    expect(normalizeDomain("github.com.")).toBe("github.com");
    expect(normalizeDomain("github.com...")).toBe("github.com");
  });

  it("trims whitespace", () => {
    expect(normalizeDomain("  github.com  ")).toBe("github.com");
  });

  it("returns null for empty input", () => {
    expect(normalizeDomain("")).toBeNull();
    expect(normalizeDomain("   ")).toBeNull();
  });

  it("punycode-encodes IDN input", () => {
    // bücher.example -> xn--bcher-kva.example
    expect(normalizeDomain("bücher.example")).toBe("xn--bcher-kva.example");
  });

  it("accepts already-punycoded input", () => {
    expect(normalizeDomain("xn--bcher-kva.example")).toBe("xn--bcher-kva.example");
  });

  it("returns null for inputs that can't form a URL hostname", () => {
    // URL constructor throws on whitespace and on inputs that won't parse
    // as a hostname after the http:// prefix is added.
    expect(normalizeDomain("\n")).toBeNull();
    expect(normalizeDomain("not a host")).toBeNull();
  });
});

// ── matchesDomainOrSubdomain ─────────────────────────────────────────────────

describe("matchesDomainOrSubdomain", () => {
  it("matches exact apex", () => {
    expect(matchesDomainOrSubdomain("github.com", "github.com")).toBe(true);
  });

  it("matches a subdomain", () => {
    expect(matchesDomainOrSubdomain("api.github.com", "github.com")).toBe(true);
    expect(matchesDomainOrSubdomain("a.b.c.github.com", "github.com")).toBe(true);
  });

  it("rejects suffix-only attack (e.g. github.com.attacker.com)", () => {
    expect(matchesDomainOrSubdomain("github.com.attacker.com", "github.com")).toBe(false);
  });

  it("rejects unrelated domain", () => {
    expect(matchesDomainOrSubdomain("attacker.com", "github.com")).toBe(false);
  });

  it("rejects partial match (githubusercontent.com is not a github.com subdomain)", () => {
    expect(matchesDomainOrSubdomain("raw.githubusercontent.com", "github.com")).toBe(false);
  });

  it("returns false when allowed entry can't be normalized", () => {
    expect(matchesDomainOrSubdomain("github.com", "")).toBe(false);
  });
});

// ── isDomainAllowed (integration) ────────────────────────────────────────────

describe("isDomainAllowed", () => {
  function withAllowlist(domains: string[]): void {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(domains));
    clearAllowlistCacheForTesting();
  }

  it("returns true when host matches an allowed apex", () => {
    withAllowlist(["github.com"]);
    expect(isDomainAllowed("https://github.com/foo")).toBe(true);
  });

  it("returns true when host is a subdomain of an allowed entry", () => {
    withAllowlist(["github.com"]);
    expect(isDomainAllowed("https://api.github.com/foo")).toBe(true);
  });

  it("returns false for unrelated hosts", () => {
    withAllowlist(["github.com"]);
    expect(isDomainAllowed("https://attacker.com/foo")).toBe(false);
  });

  it("rejects suffix-only attack (github.com.attacker.com)", () => {
    withAllowlist(["github.com"]);
    expect(isDomainAllowed("https://github.com.attacker.com/")).toBe(false);
  });

  it("returns false for file:// (no host)", () => {
    withAllowlist(["github.com"]);
    expect(isDomainAllowed("file:///etc/passwd")).toBe(false);
  });

  it("returns false for data: URLs (no host)", () => {
    withAllowlist(["github.com"]);
    expect(isDomainAllowed("data:text/html;base64,SGVsbG8=")).toBe(false);
  });

  it("returns false for unparseable URL", () => {
    withAllowlist(["github.com"]);
    expect(isDomainAllowed("not a url")).toBe(false);
  });

  it("returns false for localhost even if listed", () => {
    withAllowlist(["localhost", "github.com"]);
    expect(isDomainAllowed("https://localhost/")).toBe(false);
    expect(isDomainAllowed("http://localhost:7390/")).toBe(false);
  });

  it("returns false for 127.0.0.1 even if listed", () => {
    withAllowlist(["127.0.0.1"]);
    expect(isDomainAllowed("https://127.0.0.1/")).toBe(false);
  });

  it("returns false for RFC 1918 ranges", () => {
    withAllowlist(["10.0.0.1", "192.168.1.1", "172.16.0.1"]);
    expect(isDomainAllowed("https://10.0.0.1/")).toBe(false);
    expect(isDomainAllowed("https://192.168.1.1/")).toBe(false);
    expect(isDomainAllowed("https://172.16.0.1/")).toBe(false);
  });

  it("returns false for IPv6 loopback even with brackets", () => {
    withAllowlist(["::1"]);
    expect(isDomainAllowed("https://[::1]/")).toBe(false);
  });

  it("is case-insensitive", () => {
    withAllowlist(["github.com"]);
    expect(isDomainAllowed("https://GitHub.COM/foo")).toBe(true);
  });

  it("accepts punycoded hostnames", () => {
    withAllowlist(["xn--bcher-kva.example"]);
    expect(isDomainAllowed("https://xn--bcher-kva.example/")).toBe(true);
  });

  it("normalizes IDN host on lookup", () => {
    withAllowlist(["xn--bcher-kva.example"]);
    // Decoded form normalizes to the same punycode hostname
    expect(isDomainAllowed("https://bücher.example/")).toBe(true);
  });

  it("empty allowlist rejects everything", () => {
    withAllowlist([]);
    expect(isDomainAllowed("https://github.com/")).toBe(false);
    expect(isDomainAllowed("https://wikipedia.org/")).toBe(false);
  });

  it("rejects bracketed IPv6 loopback", () => {
    withAllowlist(["github.com"]);
    expect(isDomainAllowed("https://[::1]/")).toBe(false);
  });

  it("rejects bracketed IPv6 link-local", () => {
    withAllowlist(["github.com"]);
    expect(isDomainAllowed("https://[fe80::1]/")).toBe(false);
  });

  it("rejects public IPv6 hosts that can't round-trip through normalizeDomain", () => {
    // 2001:db8::1 is non-loopback IPv6. extractHost strips brackets and
    // hands "2001:db8::1" to normalizeDomain, which fails to re-parse as
    // an http:// hostname (colons confuse the host/port split). Result:
    // never matches an apex/subdomain entry.
    withAllowlist(["github.com"]);
    expect(isDomainAllowed("https://[2001:db8::1]/")).toBe(false);
  });
});
