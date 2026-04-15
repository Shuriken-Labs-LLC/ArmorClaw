/**
 * Unit tests for the Channels tab — config, status, and validation logic.
 *
 * Tests cover:
 *   - readChannelsConfig / writeChannelsConfig
 *   - getChannelTypes (status derivation)
 *   - validateTelegramToken (format check + API call)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("../../../token-tracker/store.ts", () => ({
  getBudgetStatus: vi.fn(() => ({
    monthlyBudgetUSD: 20,
    spentThisMonthUSD: 4,
    percentUsed: 20,
    isHardStopped: false,
  })),
  getMonthTokens: vi.fn(() => ({
    totalInputTokens: 800,
    totalOutputTokens: 400,
    estimatedCostUSD: 4,
  })),
  getTodayTokens: vi.fn(() => ({
    totalInputTokens: 100,
    totalOutputTokens: 50,
    estimatedCostUSD: 0.5,
  })),
  getMonthBySkill: vi.fn(() => ({})),
  getDailyHistory: vi.fn(() => []),
  getRecentEvents: vi.fn(() => []),
  setBudgetMonthlyUSD: vi.fn(),
  resumeFromHardStop: vi.fn(),
}));

vi.mock("../../../undo/registry.ts", () => ({
  getCurrentUndo: vi.fn(() => null),
  executeUndo: vi.fn(async () => true),
}));

vi.mock("../../../lib/skill-registry.ts", () => ({
  getAllSkills: vi.fn(() => []),
}));

vi.mock("../../../security/permissions.ts", () => ({
  getPendingApprovals: vi.fn(() => []),
  resolveApproval: vi.fn(() => true),
  onApprovalChange: vi.fn(() => () => {}),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => {
    throw new Error("not found");
  }),
  spawn: vi.fn(() => ({
    unref: vi.fn(),
    pid: 12345,
    on: vi.fn(),
  })),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import {
  clearDashboardStateForTesting,
  readChannelsConfig,
  writeChannelsConfig,
  getChannelTypes,
  validateTelegramToken,
} from "../../../dashboard/server.ts";

// ── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  clearDashboardStateForTesting();
  vi.clearAllMocks();
  // Default: all files absent
  vi.mocked(readFileSync).mockImplementation(() => {
    throw new Error("ENOENT");
  });
});

afterEach(() => {
  clearDashboardStateForTesting();
});

// ── readChannelsConfig ──────────────────────────────────────────────────────

describe("readChannelsConfig", () => {
  it("returns empty channels when file is absent", () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(readChannelsConfig()).toEqual({ channels: {} });
  });

  it("parses valid channels config", () => {
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      if (String(path).includes("channels.json")) {
        return JSON.stringify({
          channels: {
            telegram: { enabled: true, token: "123:abc", allowFrom: ["alice"] },
          },
        });
      }
      throw new Error("ENOENT");
    });
    const config = readChannelsConfig();
    expect(config.channels["telegram"]).toBeDefined();
    expect(config.channels["telegram"].enabled).toBe(true);
    expect(config.channels["telegram"].token).toBe("123:abc");
    expect(config.channels["telegram"].allowFrom).toEqual(["alice"]);
  });

  it("returns empty channels for malformed JSON", () => {
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      if (String(path).includes("channels.json")) {
        return "not json";
      }
      throw new Error("ENOENT");
    });
    expect(readChannelsConfig()).toEqual({ channels: {} });
  });

  it("returns empty channels when channels key is missing", () => {
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      if (String(path).includes("channels.json")) {
        return JSON.stringify({ other: "data" });
      }
      throw new Error("ENOENT");
    });
    expect(readChannelsConfig()).toEqual({ channels: {} });
  });

  it("returns empty channels when channels key is not an object", () => {
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      if (String(path).includes("channels.json")) {
        return JSON.stringify({ channels: "string" });
      }
      throw new Error("ENOENT");
    });
    expect(readChannelsConfig()).toEqual({ channels: {} });
  });
});

// ── writeChannelsConfig ─────────────────────────────────────────────────────

describe("writeChannelsConfig", () => {
  it("creates directory and writes JSON", () => {
    writeChannelsConfig({
      channels: {
        telegram: { enabled: true, token: "123:abc", allowFrom: ["bob"] },
      },
    });
    expect(vi.mocked(mkdirSync)).toHaveBeenCalledWith(
      expect.stringContaining("armorclaw-launcher"),
      { recursive: true },
    );
    expect(vi.mocked(writeFileSync)).toHaveBeenCalledWith(
      expect.stringContaining("channels.json"),
      expect.stringContaining('"telegram"'),
      "utf-8",
    );
  });

  it("writes valid JSON that can be parsed back", () => {
    writeChannelsConfig({
      channels: {
        telegram: { enabled: true, token: "test:tok", allowFrom: ["user1"] },
      },
    });
    const channelsWrite = vi
      .mocked(writeFileSync)
      .mock.calls.find((c) => String(c[0]).includes("channels.json"));
    expect(channelsWrite).toBeDefined();
    const parsed = JSON.parse(channelsWrite![1] as string);
    expect(parsed.channels.telegram.token).toBe("test:tok");
    expect(parsed.channels.telegram.allowFrom).toEqual(["user1"]);
  });

  it("output ends with a newline", () => {
    writeChannelsConfig({ channels: {} });
    const channelsWrite = vi
      .mocked(writeFileSync)
      .mock.calls.find((c) => String(c[0]).includes("channels.json"));
    expect(channelsWrite).toBeDefined();
    expect((channelsWrite![1] as string).endsWith("\n")).toBe(true);
  });
});

// ── getChannelTypes ─────────────────────────────────────────────────────────

describe("getChannelTypes", () => {
  it("returns all 4 channel types", () => {
    const types = getChannelTypes();
    expect(types).toHaveLength(4);
    const ids = types.map((t) => t.id);
    expect(ids).toContain("telegram");
    expect(ids).toContain("whatsapp");
    expect(ids).toContain("googlechat");
    expect(ids).toContain("imessage");
  });

  it("telegram shows not_configured when no config exists", () => {
    const tg = getChannelTypes().find((c) => c.id === "telegram");
    expect(tg?.status).toBe("not_configured");
    expect(tg?.configurable).toBe(true);
  });

  it("telegram shows active when config has enabled + token", () => {
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      if (String(path).includes("channels.json")) {
        return JSON.stringify({
          channels: {
            telegram: { enabled: true, token: "123:abc", allowFrom: ["alice"] },
          },
        });
      }
      throw new Error("ENOENT");
    });
    const tg = getChannelTypes().find((c) => c.id === "telegram");
    expect(tg?.status).toBe("active");
  });

  it("telegram shows not_configured when enabled but no token", () => {
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      if (String(path).includes("channels.json")) {
        return JSON.stringify({
          channels: {
            telegram: { enabled: true },
          },
        });
      }
      throw new Error("ENOENT");
    });
    const tg = getChannelTypes().find((c) => c.id === "telegram");
    expect(tg?.status).toBe("not_configured");
  });

  it("telegram shows not_configured when disabled with token", () => {
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      if (String(path).includes("channels.json")) {
        return JSON.stringify({
          channels: {
            telegram: { enabled: false, token: "123:abc" },
          },
        });
      }
      throw new Error("ENOENT");
    });
    const tg = getChannelTypes().find((c) => c.id === "telegram");
    expect(tg?.status).toBe("not_configured");
  });

  it("whatsapp, googlechat, imessage are all coming_soon", () => {
    const types = getChannelTypes();
    for (const id of ["whatsapp", "googlechat", "imessage"]) {
      const ch = types.find((t) => t.id === id);
      expect(ch?.status).toBe("coming_soon");
      expect(ch?.configurable).toBe(false);
    }
  });

  it("each channel has name, description, and icon", () => {
    const types = getChannelTypes();
    for (const ch of types) {
      expect(ch.name).toBeTruthy();
      expect(ch.description).toBeTruthy();
      expect(ch.icon).toBeTruthy();
    }
  });

  it("telegram is the first item in the list", () => {
    const types = getChannelTypes();
    expect(types[0].id).toBe("telegram");
  });
});

// ── validateTelegramToken ───────────────────────────────────────────────────

describe("validateTelegramToken", () => {
  it("rejects empty token", async () => {
    const result = await validateTelegramToken("");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("required");
  });

  it("rejects whitespace-only token", async () => {
    const result = await validateTelegramToken("   ");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("required");
  });

  it("rejects malformed token format", async () => {
    const result = await validateTelegramToken("not-a-valid-token");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("format");
  });

  it("rejects token without colon separator", async () => {
    const result = await validateTelegramToken("123456789ABCdef");
    expect(result.ok).toBe(false);
  });

  it("rejects token with letters before colon", async () => {
    const result = await validateTelegramToken("abc:DEFghijkl");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("format");
  });

  it("accepts correctly formatted token and calls getMe", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { username: "test_bot" } }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await validateTelegramToken("123456789:ABCdef_ghiJKL");
    expect(result.ok).toBe(true);
    expect(result.username).toBe("test_bot");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.telegram.org/bot123456789:ABCdef_ghiJKL/getMe",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    vi.unstubAllGlobals();
  });

  it("returns error when Telegram API rejects the token", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await validateTelegramToken("123456789:InvalidToken_here");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("rejected");

    vi.unstubAllGlobals();
  });

  it("returns error when network fails", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("network error"));
    vi.stubGlobal("fetch", mockFetch);

    const result = await validateTelegramToken("123456789:ABCdef_ghiJKL");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("internet");

    vi.unstubAllGlobals();
  });

  it("returns error when API returns ok but no username", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: {} }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await validateTelegramToken("123456789:ABCdef_ghiJKL");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("username");

    vi.unstubAllGlobals();
  });

  it("trims whitespace from token before validation", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { username: "bot" } }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await validateTelegramToken("  123456789:ABCdef_ghiJKL  ");
    expect(result.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.telegram.org/bot123456789:ABCdef_ghiJKL/getMe",
      expect.anything(),
    );

    vi.unstubAllGlobals();
  });
});
