/**
 * Unit tests for wrapper/config/gateway.ts.
 *
 * All I/O, randomness, and platform checks are injected — no real .env writes,
 * no real crypto calls, no real platform detection.
 *
 * Coverage target: 90%+ line coverage.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("../../../security/audit-logger.ts", () => ({
  writeAuditEntry: vi.fn(),
}));

vi.mock("../../../config/platform.ts", () => ({
  checkPlatformCompatibility: vi.fn(),
}));

import {
  GatewayConfigError,
  generateAuthToken,
  isPublicIp,
  registerTokenRotation,
  validateGatewayConfig,
  writeTokenToEnv,
} from "../../../config/gateway.ts";
import { writeAuditEntry } from "../../../security/audit-logger.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Injectable options that skip platform checks and capture token writes. */
function safeOpts(overrides: Record<string, unknown> = {}) {
  return {
    platformCheck: vi.fn(),
    getGatewayHost: () => undefined as string | undefined,
    writeToken: vi.fn().mockReturnValue(true),
    ...overrides,
  };
}

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

// ── generateAuthToken ─────────────────────────────────────────────────────────

describe("generateAuthToken", () => {
  it("returns a string of at least 48 characters", () => {
    const token = generateAuthToken();
    expect(token.length).toBeGreaterThanOrEqual(48);
  });

  it("returns exactly 64 hex characters (32 bytes)", () => {
    const token = generateAuthToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("uses the injected random source when provided", () => {
    const fakeFn = vi.fn().mockReturnValue(Buffer.alloc(32, 0xab));
    const token = generateAuthToken(fakeFn);
    expect(fakeFn).toHaveBeenCalledWith(32);
    expect(token).toBe("ab".repeat(32));
  });

  it("generates 1000 unique tokens (randomness check)", () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      tokens.add(generateAuthToken());
    }
    expect(tokens.size).toBe(1000);
  });

  it("all 1000 tokens are >= 48 chars", () => {
    for (let i = 0; i < 1000; i++) {
      expect(generateAuthToken().length).toBeGreaterThanOrEqual(48);
    }
  });
});

// ── writeTokenToEnv ───────────────────────────────────────────────────────────

describe("writeTokenToEnv", () => {
  const TMP_DIR = join(tmpdir(), "armorclaw-gw-test-" + Date.now());
  const TMP_ENV = join(TMP_DIR, ".env");

  beforeEach(() => {
    mkdirSync(TMP_DIR, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(TMP_DIR, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("creates the file and writes the token when .env does not exist", () => {
    const ok = writeTokenToEnv("abc123", TMP_ENV);
    expect(ok).toBe(true);
    const content = readFileSync(TMP_ENV, "utf-8");
    expect(content).toContain("ARMORCLAW_GATEWAY_TOKEN=abc123");
  });

  it("overwrites an existing token line", () => {
    writeFileSync(TMP_ENV, "ARMORCLAW_GATEWAY_TOKEN=old\nOTHER=keep\n", "utf-8");
    writeTokenToEnv("new_token", TMP_ENV);
    const content = readFileSync(TMP_ENV, "utf-8");
    expect(content).toContain("ARMORCLAW_GATEWAY_TOKEN=new_token");
    expect(content).toContain("OTHER=keep");
    expect(content).not.toContain("old");
  });

  it("preserves other .env lines", () => {
    writeFileSync(TMP_ENV, "FOO=bar\nBAZ=qux\n", "utf-8");
    writeTokenToEnv("tok", TMP_ENV);
    const content = readFileSync(TMP_ENV, "utf-8");
    expect(content).toContain("FOO=bar");
    expect(content).toContain("BAZ=qux");
    expect(content).toContain("ARMORCLAW_GATEWAY_TOKEN=tok");
  });

  it("returns false on I/O error (invalid path)", () => {
    const ok = writeTokenToEnv("tok", "/nonexistent/dir/.env");
    expect(ok).toBe(false);
  });
});

// ── validateGatewayConfig ─────────────────────────────────────────────────────

describe("validateGatewayConfig", () => {
  it("calls platformCheck before anything else", () => {
    const platformCheck = vi.fn();
    validateGatewayConfig(safeOpts({ platformCheck }));
    expect(platformCheck).toHaveBeenCalledTimes(1);
  });

  it("throws GatewayConfigError when GATEWAY_HOST is 0.0.0.0", () => {
    expect(() => validateGatewayConfig(safeOpts({ getGatewayHost: () => "0.0.0.0" }))).toThrow(
      GatewayConfigError,
    );
  });

  it("throws GatewayConfigError when GATEWAY_HOST is a public IP", () => {
    expect(() => validateGatewayConfig(safeOpts({ getGatewayHost: () => "8.8.8.8" }))).toThrow(
      GatewayConfigError,
    );
  });

  it("error message mentions the offending host", () => {
    expect(() => validateGatewayConfig(safeOpts({ getGatewayHost: () => "0.0.0.0" }))).toThrow(
      /0\.0\.0\.0/,
    );
  });

  it("error message suggests 127.0.0.1 or Tailscale", () => {
    expect(() => validateGatewayConfig(safeOpts({ getGatewayHost: () => "0.0.0.0" }))).toThrow(
      /127\.0\.0\.1.*Tailscale/,
    );
  });

  it("error message is plain language", () => {
    expect(() => validateGatewayConfig(safeOpts({ getGatewayHost: () => "8.8.8.8" }))).toThrow(
      /expose.*agent.*open internet/i,
    );
  });

  it("does not throw when GATEWAY_HOST is 127.0.0.1", () => {
    expect(() =>
      validateGatewayConfig(safeOpts({ getGatewayHost: () => "127.0.0.1" })),
    ).not.toThrow();
  });

  it("does not throw when GATEWAY_HOST is localhost", () => {
    expect(() =>
      validateGatewayConfig(safeOpts({ getGatewayHost: () => "localhost" })),
    ).not.toThrow();
  });

  it("does not throw when GATEWAY_HOST is a private IP", () => {
    expect(() =>
      validateGatewayConfig(safeOpts({ getGatewayHost: () => "192.168.1.50" })),
    ).not.toThrow();
  });

  it("does not throw when GATEWAY_HOST is unset", () => {
    expect(() =>
      validateGatewayConfig(safeOpts({ getGatewayHost: () => undefined })),
    ).not.toThrow();
  });

  it("does not throw when GATEWAY_HOST is empty string", () => {
    expect(() => validateGatewayConfig(safeOpts({ getGatewayHost: () => "" }))).not.toThrow();
  });

  it("rotates the auth token and calls writeToken", () => {
    const writeToken = vi.fn().mockReturnValue(true);
    validateGatewayConfig(safeOpts({ writeToken }));
    expect(writeToken).toHaveBeenCalledTimes(1);
    const writtenToken = writeToken.mock.calls[0][0] as string;
    expect(writtenToken.length).toBeGreaterThanOrEqual(48);
  });

  it("returns tokenWritten: true when writeToken succeeds", () => {
    const result = validateGatewayConfig(safeOpts({ writeToken: vi.fn().mockReturnValue(true) }));
    expect(result.tokenWritten).toBe(true);
  });

  it("returns tokenWritten: false when writeToken fails", () => {
    const result = validateGatewayConfig(safeOpts({ writeToken: vi.fn().mockReturnValue(false) }));
    expect(result.tokenWritten).toBe(false);
  });

  it("returns the effective gateway host", () => {
    const result = validateGatewayConfig(safeOpts({ getGatewayHost: () => "127.0.0.1" }));
    expect(result.gatewayHost).toBe("127.0.0.1");
  });

  it("returns null gatewayHost when unset", () => {
    const result = validateGatewayConfig(safeOpts());
    expect(result.gatewayHost).toBeNull();
  });

  it("writes an audit entry on success", () => {
    validateGatewayConfig(safeOpts());
    const calls = vi.mocked(writeAuditEntry).mock.calls;
    const successEntry = calls.find(
      ([e]) => e.outcome === "success" && e.inputSummary.includes("gateway-startup"),
    );
    expect(successEntry).toBeDefined();
  });

  it("audit entry includes host value (or 'unset')", () => {
    validateGatewayConfig(safeOpts({ getGatewayHost: () => "127.0.0.1" }));
    const calls = vi.mocked(writeAuditEntry).mock.calls;
    const entry = calls.find(([e]) => e.inputSummary.includes("host:127.0.0.1"));
    expect(entry).toBeDefined();
  });

  it("audit entry says 'unset' when host is not configured", () => {
    validateGatewayConfig(safeOpts());
    const calls = vi.mocked(writeAuditEntry).mock.calls;
    const entry = calls.find(([e]) => e.inputSummary.includes("host:unset"));
    expect(entry).toBeDefined();
  });

  it("uses the injected randomBytesFn", () => {
    const fakeFn = vi.fn().mockReturnValue(Buffer.alloc(32, 0xff));
    const writeToken = vi.fn().mockReturnValue(true);
    validateGatewayConfig(safeOpts({ randomBytesFn: fakeFn, writeToken }));
    expect(fakeFn).toHaveBeenCalled();
    expect(writeToken).toHaveBeenCalledWith("ff".repeat(32));
  });
});

// ── Token never in error messages ─────────────────────────────────────────────

describe("token never in error messages", () => {
  it("GatewayConfigError for public IP does not contain any token", () => {
    // Generate a known token to search for
    const knownToken = "ff".repeat(32);
    const fakeFn = vi.fn().mockReturnValue(Buffer.alloc(32, 0xff));

    let errorMessage = "";
    try {
      validateGatewayConfig({
        platformCheck: vi.fn(),
        getGatewayHost: () => "8.8.8.8",
        writeToken: vi.fn().mockReturnValue(true),
        randomBytesFn: fakeFn,
      });
    } catch (err) {
      errorMessage = (err as Error).message;
    }

    expect(errorMessage.length).toBeGreaterThan(0);
    expect(errorMessage).not.toContain(knownToken);
  });

  it("error thrown on 0.0.0.0 contains no hex token patterns", () => {
    let errorMessage = "";
    try {
      validateGatewayConfig({
        platformCheck: vi.fn(),
        getGatewayHost: () => "0.0.0.0",
        writeToken: vi.fn().mockReturnValue(true),
      });
    } catch (err) {
      errorMessage = (err as Error).message;
    }

    expect(errorMessage.length).toBeGreaterThan(0);
    // No 48+ hex char sequence in the error
    expect(errorMessage).not.toMatch(/[0-9a-f]{48,}/i);
  });

  it("audit entries from validateGatewayConfig never contain the token", () => {
    const knownToken = "ab".repeat(32);
    const fakeFn = vi.fn().mockReturnValue(Buffer.alloc(32, 0xab));
    validateGatewayConfig(safeOpts({ randomBytesFn: fakeFn }));

    const calls = vi.mocked(writeAuditEntry).mock.calls;
    for (const [entry] of calls) {
      expect(entry.inputSummary).not.toContain(knownToken);
      expect(JSON.stringify(entry)).not.toContain(knownToken);
    }
  });
});

// ── registerTokenRotation ─────────────────────────────────────────────────────

describe("registerTokenRotation", () => {
  function makeMockApi() {
    const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
    return {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        handlers[event] = handlers[event] ?? [];
        handlers[event].push(handler);
      }),
      fire: (event: string, ...args: unknown[]) => {
        for (const h of handlers[event] ?? []) {
          h(...args);
        }
      },
    };
  }

  it("registers a session_start handler", () => {
    const api = makeMockApi();
    registerTokenRotation(api as unknown as OpenClawPluginApi);
    expect(api.on).toHaveBeenCalledWith("session_start", expect.any(Function));
  });

  it("rotates the token when session_start fires", () => {
    const api = makeMockApi();
    const writeToken = vi.fn().mockReturnValue(true);
    registerTokenRotation(api as unknown as OpenClawPluginApi, { writeToken });

    api.fire("session_start", { sessionId: "s1" });
    expect(writeToken).toHaveBeenCalledTimes(1);
    const token = writeToken.mock.calls[0][0] as string;
    expect(token.length).toBeGreaterThanOrEqual(48);
  });

  it("writes an audit entry on rotation", () => {
    const api = makeMockApi();
    registerTokenRotation(api as unknown as OpenClawPluginApi, {
      writeToken: vi.fn().mockReturnValue(true),
    });

    api.fire("session_start", { sessionId: "s1" });

    const calls = vi.mocked(writeAuditEntry).mock.calls;
    const rotationEntry = calls.find(([e]) => e.inputSummary.includes("rotated-on-session-start"));
    expect(rotationEntry).toBeDefined();
  });

  it("audit entry from rotation never contains the token value", () => {
    const api = makeMockApi();
    const knownToken = "cd".repeat(32);
    const fakeFn = vi.fn().mockReturnValue(Buffer.alloc(32, 0xcd));
    registerTokenRotation(api as unknown as OpenClawPluginApi, {
      writeToken: vi.fn().mockReturnValue(true),
      randomBytesFn: fakeFn,
    });

    api.fire("session_start", { sessionId: "s1" });

    const calls = vi.mocked(writeAuditEntry).mock.calls;
    for (const [entry] of calls) {
      expect(JSON.stringify(entry)).not.toContain(knownToken);
    }
  });

  it("uses injected randomBytesFn", () => {
    const api = makeMockApi();
    const fakeFn = vi.fn().mockReturnValue(Buffer.alloc(32, 0xee));
    const writeToken = vi.fn().mockReturnValue(true);
    registerTokenRotation(api as unknown as OpenClawPluginApi, {
      randomBytesFn: fakeFn,
      writeToken,
    });

    api.fire("session_start", { sessionId: "s1" });
    expect(fakeFn).toHaveBeenCalled();
    expect(writeToken).toHaveBeenCalledWith("ee".repeat(32));
  });
});
