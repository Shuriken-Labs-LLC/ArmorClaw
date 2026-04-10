/**
 * Unit tests for wrapper/config/gateway.ts.
 *
 * All I/O and platform checks are injected — no real .env writes,
 * no real platform detection.
 *
 * Coverage target: 90%+ line coverage.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("../../../security/audit-logger.ts", () => ({
  writeAuditEntry: vi.fn(),
}));

vi.mock("../../../config/platform.ts", () => ({
  checkPlatformCompatibility: vi.fn(),
}));

import { GatewayConfigError, isPublicIp, validateGatewayHost } from "../../../config/gateway.ts";
import { writeAuditEntry } from "../../../security/audit-logger.ts";

beforeEach(() => {
  vi.clearAllMocks();
});

// ── isPublicIp ────────────────────────────────────────────────────────────────

describe("isPublicIp", () => {
  describe("rejects public / all-interface bindings", () => {
    it("rejects 0.0.0.0", () => {
      expect(isPublicIp("0.0.0.0")).toBe(true);
    });

    it("rejects :: (IPv6 all-interface)", () => {
      expect(isPublicIp("::")).toBe(true);
    });

    it("rejects routable IPv4: 8.8.8.8", () => {
      expect(isPublicIp("8.8.8.8")).toBe(true);
    });

    it("rejects routable IPv4: 1.2.3.4", () => {
      expect(isPublicIp("1.2.3.4")).toBe(true);
    });

    it("rejects routable IPv4: 203.0.113.1", () => {
      expect(isPublicIp("203.0.113.1")).toBe(true);
    });

    it("rejects 172.15.0.1 (not in 172.16–31 private range)", () => {
      expect(isPublicIp("172.15.0.1")).toBe(true);
    });

    it("rejects 172.32.0.1 (above 172.16–31 private range)", () => {
      expect(isPublicIp("172.32.0.1")).toBe(true);
    });

    it("rejects public IPv6 literal", () => {
      expect(isPublicIp("2001:db8::1")).toBe(true);
    });
  });

  describe("accepts localhost and private addresses", () => {
    it("accepts localhost", () => {
      expect(isPublicIp("localhost")).toBe(false);
    });

    it("accepts 127.0.0.1", () => {
      expect(isPublicIp("127.0.0.1")).toBe(false);
    });

    it("accepts 127.0.1.1", () => {
      expect(isPublicIp("127.0.1.1")).toBe(false);
    });

    it("accepts ::1 (IPv6 loopback)", () => {
      expect(isPublicIp("::1")).toBe(false);
    });

    it("accepts 10.0.0.1 (Class A private)", () => {
      expect(isPublicIp("10.0.0.1")).toBe(false);
    });

    it("accepts 10.255.255.255", () => {
      expect(isPublicIp("10.255.255.255")).toBe(false);
    });

    it("accepts 192.168.1.1 (Class C private)", () => {
      expect(isPublicIp("192.168.1.1")).toBe(false);
    });

    it("accepts 192.168.0.100", () => {
      expect(isPublicIp("192.168.0.100")).toBe(false);
    });

    it("accepts 172.16.0.1 (lower bound of 172 private)", () => {
      expect(isPublicIp("172.16.0.1")).toBe(false);
    });

    it("accepts 172.31.255.255 (upper bound of 172 private)", () => {
      expect(isPublicIp("172.31.255.255")).toBe(false);
    });

    it("accepts hostname strings (not IP literals)", () => {
      expect(isPublicIp("myserver.local")).toBe(false);
    });

    it("accepts Tailscale-style hostname", () => {
      expect(isPublicIp("mydevice.ts.net")).toBe(false);
    });
  });

  it("trims whitespace before evaluation", () => {
    expect(isPublicIp("  0.0.0.0  ")).toBe(true);
    expect(isPublicIp("  127.0.0.1  ")).toBe(false);
  });
});

// ── validateGatewayHost ───────────────────────────────────────────────────────

describe("validateGatewayHost", () => {
  it("calls platformCheck before anything else", () => {
    const platformCheck = vi.fn();
    validateGatewayHost({ platformCheck });
    expect(platformCheck).toHaveBeenCalledTimes(1);
  });

  it("throws GatewayConfigError when GATEWAY_HOST is 0.0.0.0", () => {
    expect(() =>
      validateGatewayHost({ platformCheck: vi.fn(), getGatewayHost: () => "0.0.0.0" }),
    ).toThrow(GatewayConfigError);
  });

  it("throws GatewayConfigError when GATEWAY_HOST is a public IP", () => {
    expect(() =>
      validateGatewayHost({ platformCheck: vi.fn(), getGatewayHost: () => "8.8.8.8" }),
    ).toThrow(GatewayConfigError);
  });

  it("error message mentions the offending host", () => {
    expect(() =>
      validateGatewayHost({ platformCheck: vi.fn(), getGatewayHost: () => "0.0.0.0" }),
    ).toThrow(/0\.0\.0\.0/);
  });

  it("error message suggests 127.0.0.1 or Tailscale", () => {
    expect(() =>
      validateGatewayHost({ platformCheck: vi.fn(), getGatewayHost: () => "0.0.0.0" }),
    ).toThrow(/127\.0\.0\.1.*Tailscale/);
  });

  it("error message is plain language", () => {
    expect(() =>
      validateGatewayHost({ platformCheck: vi.fn(), getGatewayHost: () => "8.8.8.8" }),
    ).toThrow(/expose.*agent.*open internet/i);
  });

  it("does not throw when GATEWAY_HOST is 127.0.0.1", () => {
    expect(() =>
      validateGatewayHost({ platformCheck: vi.fn(), getGatewayHost: () => "127.0.0.1" }),
    ).not.toThrow();
  });

  it("does not throw when GATEWAY_HOST is localhost", () => {
    expect(() =>
      validateGatewayHost({ platformCheck: vi.fn(), getGatewayHost: () => "localhost" }),
    ).not.toThrow();
  });

  it("does not throw when GATEWAY_HOST is a private IP", () => {
    expect(() =>
      validateGatewayHost({ platformCheck: vi.fn(), getGatewayHost: () => "192.168.1.50" }),
    ).not.toThrow();
  });

  it("does not throw when GATEWAY_HOST is unset", () => {
    expect(() =>
      validateGatewayHost({ platformCheck: vi.fn(), getGatewayHost: () => undefined }),
    ).not.toThrow();
  });

  it("does not throw when GATEWAY_HOST is empty string", () => {
    expect(() =>
      validateGatewayHost({ platformCheck: vi.fn(), getGatewayHost: () => "" }),
    ).not.toThrow();
  });

  it("writes an audit entry on success", () => {
    validateGatewayHost({ platformCheck: vi.fn() });
    const calls = vi.mocked(writeAuditEntry).mock.calls;
    const successEntry = calls.find(
      ([e]) => e.outcome === "success" && e.inputSummary.includes("gateway-startup"),
    );
    expect(successEntry).toBeDefined();
  });

  it("audit entry includes host value (or 'unset')", () => {
    validateGatewayHost({ platformCheck: vi.fn(), getGatewayHost: () => "127.0.0.1" });
    const calls = vi.mocked(writeAuditEntry).mock.calls;
    const entry = calls.find(([e]) => e.inputSummary.includes("host:127.0.0.1"));
    expect(entry).toBeDefined();
  });

  it("audit entry says 'unset' when host is not configured", () => {
    validateGatewayHost({ platformCheck: vi.fn() });
    const calls = vi.mocked(writeAuditEntry).mock.calls;
    const entry = calls.find(([e]) => e.inputSummary.includes("host:unset"));
    expect(entry).toBeDefined();
  });
});
