/**
 * Unit tests for the browser automation skill.
 *
 * Playwright is mocked entirely — no real browser is launched.
 * All behaviour is tested through the IBrowserAdapter interface.
 *
 * Coverage targets:
 *  - 90%+ line coverage on browser/index.ts
 */

import { homedir } from "node:os";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("../../../security/audit-logger.ts", () => ({
  writeAuditEntry: vi.fn(),
}));

vi.mock("../../../lib/skill-registry.ts", () => ({
  registerSkill: vi.fn(),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { writeAuditEntry } from "../../../security/audit-logger.ts";
import {
  createBrowserSkill,
  extractHostname,
  getAllowedFormDomains,
  getBrowserProfilePath,
  getPlaywrightCachePath,
  isHeadedModeEnabled,
  resetDefaultAdapterForTesting,
} from "../../../skills/browser/index.ts";
import type { BrowserInput, CookieInfo, IBrowserAdapter } from "../../../skills/browser/types.ts";

// ── Mock adapter factory ──────────────────────────────────────────────────────

function makeMockAdapter(overrides: Partial<IBrowserAdapter> = {}): IBrowserAdapter {
  return {
    navigate: vi.fn().mockResolvedValue({ title: "Test Page", url: "https://example.com/" }),
    fillForm: vi.fn().mockResolvedValue({ title: "Success", url: "https://example.com/thanks" }),
    extract: vi.fn().mockResolvedValue(["item 1", "item 2", "item 3"]),
    screenshot: vi.fn().mockResolvedValue(Buffer.from("PNG_DATA")),
    getCookies: vi.fn().mockResolvedValue([]),
    clearCookies: vi.fn().mockResolvedValue(undefined),
    allowCookiesForDomain: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeSkill(adapterOverrides: Partial<IBrowserAdapter> = {}) {
  const adapter = makeMockAdapter(adapterOverrides);
  const skill = createBrowserSkill(adapter);
  return { skill, adapter };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const EXPECTED_PROFILE_PATH = nodePath.join(homedir(), ".armorclaw", "browser-profile");
const EXPECTED_CACHE_PATH = nodePath.join(homedir(), ".armorclaw", "playwright-cache");

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  resetDefaultAdapterForTesting();
  delete process.env["ARMORCLAW_BROWSER_HEADED"];
  delete process.env["ARMORCLAW_BROWSER_ALLOWED_DOMAINS"];
});

afterEach(() => {
  delete process.env["ARMORCLAW_BROWSER_HEADED"];
  delete process.env["ARMORCLAW_BROWSER_ALLOWED_DOMAINS"];
});

// ── Path helpers ──────────────────────────────────────────────────────────────

describe("getBrowserProfilePath", () => {
  it("returns path under ~/.armorclaw/browser-profile", () => {
    expect(getBrowserProfilePath()).toBe(EXPECTED_PROFILE_PATH);
  });

  it("never returns the user's default browser profile path", () => {
    const profilePath = getBrowserProfilePath();
    // Must not be Chrome's default profile
    expect(profilePath).not.toContain("Google/Chrome");
    expect(profilePath).not.toContain("Chromium");
    expect(profilePath).not.toContain("Default");
  });

  it("is under the .armorclaw directory", () => {
    expect(getBrowserProfilePath()).toContain(".armorclaw");
  });
});

describe("getPlaywrightCachePath", () => {
  it("returns path under ~/.armorclaw/playwright-cache", () => {
    expect(getPlaywrightCachePath()).toBe(EXPECTED_CACHE_PATH);
  });

  it("is isolated from system Playwright installations", () => {
    // Must not collide with system-level Playwright cache
    const cachePath = getPlaywrightCachePath();
    expect(cachePath).toContain(".armorclaw");
    expect(cachePath).not.toBe(nodePath.join(homedir(), ".cache", "ms-playwright"));
  });
});

// ── Configuration helpers ─────────────────────────────────────────────────────

describe("isHeadedModeEnabled", () => {
  it("returns false by default (headless is the default)", () => {
    expect(isHeadedModeEnabled()).toBe(false);
  });

  it("returns true when ARMORCLAW_BROWSER_HEADED=true", () => {
    process.env["ARMORCLAW_BROWSER_HEADED"] = "true";
    expect(isHeadedModeEnabled()).toBe(true);
  });

  it("returns false for any other value (strict opt-in)", () => {
    process.env["ARMORCLAW_BROWSER_HEADED"] = "1";
    expect(isHeadedModeEnabled()).toBe(false);
    process.env["ARMORCLAW_BROWSER_HEADED"] = "yes";
    expect(isHeadedModeEnabled()).toBe(false);
  });
});

describe("getAllowedFormDomains", () => {
  it("returns empty set when env var not set", () => {
    expect(getAllowedFormDomains().size).toBe(0);
  });

  it("parses comma-separated domains", () => {
    process.env["ARMORCLAW_BROWSER_ALLOWED_DOMAINS"] = "example.com,app.test.io";
    const domains = getAllowedFormDomains();
    expect(domains.has("example.com")).toBe(true);
    expect(domains.has("app.test.io")).toBe(true);
  });

  it("lowercases domain entries", () => {
    process.env["ARMORCLAW_BROWSER_ALLOWED_DOMAINS"] = "Example.COM";
    expect(getAllowedFormDomains().has("example.com")).toBe(true);
  });

  it("trims whitespace from entries", () => {
    process.env["ARMORCLAW_BROWSER_ALLOWED_DOMAINS"] = " example.com , other.io ";
    const domains = getAllowedFormDomains();
    expect(domains.has("example.com")).toBe(true);
    expect(domains.has("other.io")).toBe(true);
  });
});

describe("extractHostname", () => {
  it("returns the hostname from a valid URL", () => {
    expect(extractHostname("https://example.com/path?q=1")).toBe("example.com");
  });

  it("returns empty string for an invalid URL", () => {
    expect(extractHostname("not-a-url")).toBe("");
  });

  it("lowercases the hostname", () => {
    expect(extractHostname("https://EXAMPLE.COM/")).toBe("example.com");
  });
});

// ── navigate ──────────────────────────────────────────────────────────────────

describe("navigate", () => {
  it("requires a url", async () => {
    const { skill } = makeSkill();
    const result = await skill.run({ action: "navigate" });
    expect(result.success).toBe(false);
    expect(result.message).toContain("'url'");
  });

  it("calls adapter.navigate and returns title and url", async () => {
    const { skill, adapter } = makeSkill({
      navigate: vi.fn().mockResolvedValue({
        title: "My Page",
        url: "https://example.com/page",
      }),
    });

    const result = await skill.run({
      action: "navigate",
      url: "https://example.com/page",
    });

    expect(result.success).toBe(true);
    expect(result.data?.pageTitle).toBe("My Page");
    expect(result.data?.pageUrl).toBe("https://example.com/page");
    expect(adapter.navigate).toHaveBeenCalledWith(
      "https://example.com/page",
      expect.objectContaining({}),
    );
  });

  it("passes waitForSelector to adapter", async () => {
    const { skill, adapter } = makeSkill();
    await skill.run({
      action: "navigate",
      url: "https://example.com",
      waitForSelector: "#content",
    });
    expect(adapter.navigate).toHaveBeenCalledWith(
      "https://example.com",
      expect.objectContaining({ waitForSelector: "#content" }),
    );
  });

  it("logs a success audit entry", async () => {
    const { skill } = makeSkill();
    await skill.run({ action: "navigate", url: "https://example.com" });
    const entries = vi.mocked(writeAuditEntry).mock.calls.map(([e]) => e);
    expect(
      entries.some((e) => e.outcome === "success" && e.inputSummary.startsWith("navigate:")),
    ).toBe(true);
  });

  it("logs error outcome on failure", async () => {
    const { skill } = makeSkill({
      navigate: vi.fn().mockRejectedValue(new Error("net::ERR_NAME_NOT_RESOLVED")),
    });
    const result = await skill.run({ action: "navigate", url: "https://bad.example" });
    expect(result.success).toBe(false);
    const entries = vi.mocked(writeAuditEntry).mock.calls.map(([e]) => e);
    expect(entries.some((e) => e.outcome === "error")).toBe(true);
  });
});

// ── fill-form ─────────────────────────────────────────────────────────────────

describe("fill-form", () => {
  it("requires a url", async () => {
    const { skill } = makeSkill();
    const result = await skill.run({
      action: "fill-form",
      fields: [{ selector: "#name", value: "Alice" }],
    });
    expect(result.success).toBe(false);
    expect(result.message).toContain("'url'");
  });

  it("requires fields array", async () => {
    const { skill } = makeSkill();
    const result = await skill.run({
      action: "fill-form",
      url: "https://example.com",
    });
    expect(result.success).toBe(false);
    expect(result.message).toContain("'fields'");
  });

  it("rejects domains not in ARMORCLAW_BROWSER_ALLOWED_DOMAINS when set", async () => {
    process.env["ARMORCLAW_BROWSER_ALLOWED_DOMAINS"] = "allowed.com";
    const { skill, adapter } = makeSkill();

    const result = await skill.run({
      action: "fill-form",
      url: "https://notallowed.com/form",
      fields: [{ selector: "#q", value: "test" }],
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("notallowed.com");
    expect(result.message).toContain("ARMORCLAW_BROWSER_ALLOWED_DOMAINS");
    expect(adapter.fillForm).not.toHaveBeenCalled();
  });

  it("logs outcome rejected when domain is blocked", async () => {
    process.env["ARMORCLAW_BROWSER_ALLOWED_DOMAINS"] = "allowed.com";
    const { skill } = makeSkill();
    await skill.run({
      action: "fill-form",
      url: "https://blocked.com/form",
      fields: [{ selector: "#q", value: "x" }],
    });
    const entries = vi.mocked(writeAuditEntry).mock.calls.map(([e]) => e);
    expect(entries.some((e) => e.outcome === "rejected")).toBe(true);
  });

  it("allows form fill when domain is in allowed list", async () => {
    process.env["ARMORCLAW_BROWSER_ALLOWED_DOMAINS"] = "example.com";
    const { skill, adapter } = makeSkill();

    const result = await skill.run({
      action: "fill-form",
      url: "https://example.com/login",
      fields: [{ selector: "#user", value: "alice" }],
    });

    expect(result.success).toBe(true);
    expect(adapter.fillForm).toHaveBeenCalled();
  });

  it("allows form fill when no allowed domains are configured (open mode)", async () => {
    // ARMORCLAW_BROWSER_ALLOWED_DOMAINS not set — all domains allowed
    const { skill, adapter } = makeSkill();

    const result = await skill.run({
      action: "fill-form",
      url: "https://anywhere.com/form",
      fields: [{ selector: "#q", value: "data" }],
    });

    expect(result.success).toBe(true);
    expect(adapter.fillForm).toHaveBeenCalled();
  });

  it("passes fields and submitSelector to adapter", async () => {
    const { skill, adapter } = makeSkill();
    const fields = [
      { selector: "#name", value: "Bob" },
      { selector: "#email", value: "bob@example.com" },
    ];

    await skill.run({
      action: "fill-form",
      url: "https://example.com/form",
      fields,
      submitSelector: "#submit",
    });

    expect(adapter.fillForm).toHaveBeenCalledWith(
      "https://example.com/form",
      fields,
      expect.objectContaining({ submitSelector: "#submit" }),
    );
  });
});

// ── extract ───────────────────────────────────────────────────────────────────

describe("extract", () => {
  it("requires a url", async () => {
    const { skill } = makeSkill();
    const result = await skill.run({ action: "extract", selector: "h1" });
    expect(result.success).toBe(false);
    expect(result.message).toContain("'url'");
  });

  it("requires a selector", async () => {
    const { skill } = makeSkill();
    const result = await skill.run({
      action: "extract",
      url: "https://example.com",
    });
    expect(result.success).toBe(false);
    expect(result.message).toContain("'selector'");
  });

  it("returns extracted results", async () => {
    const { skill, adapter } = makeSkill({
      extract: vi.fn().mockResolvedValue(["First", "Second", "Third"]),
    });

    const result = await skill.run({
      action: "extract",
      url: "https://example.com",
      selector: "li",
    });

    expect(result.success).toBe(true);
    expect(result.data?.extracted).toEqual(["First", "Second", "Third"]);
    expect(result.message).toContain("3 results");
  });

  it("passes attribute to adapter", async () => {
    const { skill, adapter } = makeSkill();
    await skill.run({
      action: "extract",
      url: "https://example.com",
      selector: "a",
      attribute: "href",
    });
    expect(adapter.extract).toHaveBeenCalledWith("https://example.com", "a", "href");
  });

  it("uses singular message for 1 result", async () => {
    const { skill } = makeSkill({
      extract: vi.fn().mockResolvedValue(["only one"]),
    });
    const result = await skill.run({
      action: "extract",
      url: "https://example.com",
      selector: "h1",
    });
    expect(result.message).toContain("1 result");
    expect(result.message).not.toContain("results");
  });
});

// ── screenshot ────────────────────────────────────────────────────────────────

describe("screenshot", () => {
  it("requires a url", async () => {
    const { skill } = makeSkill();
    const result = await skill.run({ action: "screenshot" });
    expect(result.success).toBe(false);
    expect(result.message).toContain("'url'");
  });

  it("returns screenshot as base64", async () => {
    const pngBytes = Buffer.from("fake-png-data");
    const { skill } = makeSkill({
      screenshot: vi.fn().mockResolvedValue(pngBytes),
    });

    const result = await skill.run({
      action: "screenshot",
      url: "https://example.com",
    });

    expect(result.success).toBe(true);
    expect(result.data?.screenshotBase64).toBe(pngBytes.toString("base64"));
  });

  it("reports byte count in message", async () => {
    const buf = Buffer.alloc(2048);
    const { skill } = makeSkill({
      screenshot: vi.fn().mockResolvedValue(buf),
    });
    const result = await skill.run({
      action: "screenshot",
      url: "https://example.com",
    });
    expect(result.message).toContain("2048 bytes");
  });
});

// ── Session cookie isolation ──────────────────────────────────────────────────

describe("session cookie isolation", () => {
  it("allow-cookies requires a domain", async () => {
    const { skill } = makeSkill();
    const result = await skill.run({ action: "allow-cookies" });
    expect(result.success).toBe(false);
    expect(result.message).toContain("'domain'");
  });

  it("allow-cookies calls adapter.allowCookiesForDomain", async () => {
    const { skill, adapter } = makeSkill();
    const result = await skill.run({
      action: "allow-cookies",
      domain: "myapp.com",
    });
    expect(result.success).toBe(true);
    expect(adapter.allowCookiesForDomain).toHaveBeenCalledWith("myapp.com");
  });

  it("clear-cookies calls adapter.clearCookies without domain", async () => {
    const { skill, adapter } = makeSkill();
    const result = await skill.run({ action: "clear-cookies" });
    expect(result.success).toBe(true);
    expect(adapter.clearCookies).toHaveBeenCalledWith(undefined);
    expect(result.message).toContain("All browser cookies cleared");
  });

  it("clear-cookies with domain scopes the clear operation", async () => {
    const { skill, adapter } = makeSkill();
    const result = await skill.run({
      action: "clear-cookies",
      domain: "tracker.io",
    });
    expect(result.success).toBe(true);
    expect(adapter.clearCookies).toHaveBeenCalledWith("tracker.io");
    expect(result.message).toContain("tracker.io");
  });

  it("get-cookies returns cookies from adapter", async () => {
    const cookies: CookieInfo[] = [
      { name: "session", domain: "example.com", expires: 9999999 },
      { name: "pref", domain: "example.com" },
    ];
    const { skill } = makeSkill({
      getCookies: vi.fn().mockResolvedValue(cookies),
    });

    const result = await skill.run({ action: "get-cookies" });
    expect(result.success).toBe(true);
    expect(result.data?.cookies).toEqual(cookies);
    expect(result.message).toContain("2 cookies");
  });

  it("get-cookies filters by domain when provided", async () => {
    const { skill, adapter } = makeSkill({
      getCookies: vi.fn().mockResolvedValue([]),
    });
    await skill.run({ action: "get-cookies", domain: "example.com" });
    expect(adapter.getCookies).toHaveBeenCalledWith("example.com");
  });
});

// ── Dedicated profile enforcement ─────────────────────────────────────────────

describe("dedicated profile enforcement", () => {
  it("profile path is under .armorclaw, not the default browser profile", () => {
    const profile = getBrowserProfilePath();

    // Must be the armorclaw-specific profile
    expect(profile).toContain(".armorclaw");
    expect(profile).toContain("browser-profile");

    // Must NOT be any of the common default profile paths
    expect(profile).not.toContain("Google/Chrome");
    expect(profile).not.toContain("BraveSoftware");
    expect(profile).not.toContain("Microsoft/Edge");
    expect(profile).not.toContain("firefox");
  });

  it("profile path does not contain the user's home dir user-data-dir without armorclaw prefix", () => {
    const profile = getBrowserProfilePath();
    const homeBase = homedir();
    // The path starts with home dir but must pass through .armorclaw
    const relative = nodePath.relative(homeBase, profile);
    expect(relative.startsWith(".armorclaw")).toBe(true);
  });

  it("playwright cache path is isolated from system playwright cache", () => {
    const cache = getPlaywrightCachePath();
    expect(cache).toContain(".armorclaw");
    expect(cache).toContain("playwright-cache");
    // Not the default ms-playwright location
    expect(cache).not.toContain("ms-playwright");
  });
});

// ── Headless / headed mode ────────────────────────────────────────────────────

describe("headless / headed mode", () => {
  it("headless is the default (ARMORCLAW_BROWSER_HEADED not set)", () => {
    expect(isHeadedModeEnabled()).toBe(false);
  });

  it("headed mode enabled by explicit opt-in only", () => {
    process.env["ARMORCLAW_BROWSER_HEADED"] = "true";
    expect(isHeadedModeEnabled()).toBe(true);
  });

  it("headed mode is not enabled by truthy-ish values other than 'true'", () => {
    for (const val of ["1", "yes", "TRUE", "on", "enabled"]) {
      process.env["ARMORCLAW_BROWSER_HEADED"] = val;
      expect(isHeadedModeEnabled()).toBe(false);
    }
  });
});

// ── Audit logging ─────────────────────────────────────────────────────────────

describe("audit logging", () => {
  it("all audit entries carry the skill name 'browser'", async () => {
    const { skill } = makeSkill();
    await skill.run({ action: "navigate", url: "https://example.com" });
    const entries = vi.mocked(writeAuditEntry).mock.calls.map(([e]) => e);
    expect(entries.every((e) => e.skill === "browser")).toBe(true);
  });

  it("all audit entries include the permission manifest", async () => {
    const { skill } = makeSkill();
    await skill.run({ action: "navigate", url: "https://example.com" });
    const entries = vi.mocked(writeAuditEntry).mock.calls.map(([e]) => e);
    expect(
      entries.every(
        (e) =>
          e.permissionsUsed.includes("browser:sandboxed") &&
          e.permissionsUsed.includes("network:outbound"),
      ),
    ).toBe(true);
  });

  it("inputSummary does not contain form field values", async () => {
    const { skill } = makeSkill();
    const secret = "my-secret-password";
    await skill.run({
      action: "fill-form",
      url: "https://example.com/login",
      fields: [{ selector: "#password", value: secret }],
    });
    const entries = vi.mocked(writeAuditEntry).mock.calls.map(([e]) => e);
    expect(entries.some((e) => e.inputSummary.includes(secret))).toBe(false);
  });

  it("screenshot inputSummary includes the hostname not the full URL", async () => {
    const { skill } = makeSkill();
    await skill.run({
      action: "screenshot",
      url: "https://my-site.example.com/very/long/path?token=abc",
    });
    const entries = vi.mocked(writeAuditEntry).mock.calls.map(([e]) => e);
    const screenshotEntry = entries.find((e) => e.inputSummary.startsWith("screenshot:"));
    expect(screenshotEntry).toBeDefined();
    expect(screenshotEntry!.inputSummary).toContain("my-site.example.com");
    expect(screenshotEntry!.inputSummary).not.toContain("token=abc");
  });
});
