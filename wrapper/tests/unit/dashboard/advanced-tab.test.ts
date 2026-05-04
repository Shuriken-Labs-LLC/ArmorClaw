/**
 * Unit tests for the Advanced tab features:
 * - Config backup endpoint
 * - Gateway probe endpoint
 * - Platform-aware config paths in skills/channels config
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
  cpSync: vi.fn(),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(() => {
    throw new Error("ENOENT");
  }),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => {
    throw new Error("not found");
  }),
  spawn: vi.fn(),
}));

vi.mock("node:net", () => {
  const { EventEmitter } = require("node:events");

  function createConnection() {
    const sock = new EventEmitter();
    sock.destroy = vi.fn();
    // Default: simulate unreachable gateway (emit "error" async)
    process.nextTick(() => sock.emit("error", new Error("ECONNREFUSED")));
    return sock;
  }

  return { createConnection, default: { createConnection } };
});

// ── Imports ──────────────────────────────────────────────────────────────────

import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readChannelsConfig, writeChannelsConfig, createApp } from "../../../dashboard/server.ts";
import { getLauncherDataPath } from "../../../lib/platform-paths.ts";

// ── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Platform-aware config paths ─────────────────────────────────────────────

describe("channelsConfigPath uses platform-paths", () => {
  it("readChannelsConfig returns empty when file absent", () => {
    const config = readChannelsConfig();
    expect(config).toEqual({ channels: {} });
  });

  it("writeChannelsConfig writes to platform-correct path", () => {
    writeChannelsConfig({ channels: {} });
    const expectedDir = getLauncherDataPath();
    expect(vi.mocked(mkdirSync)).toHaveBeenCalledWith(expectedDir, { recursive: true });
    const writtenPath = vi.mocked(writeFileSync).mock.calls[0]?.[0] as string;
    expect(writtenPath).toContain("channels.json");
    expect(writtenPath.startsWith(expectedDir)).toBe(true);
  });
});

// ── Backup config endpoint ──────────────────────────────────────────────────

describe("POST /api/advanced/backup-config", () => {
  it("returns 404 when config directory does not exist", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const app = createApp();
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/advanced/backup-config`, {
        method: "POST",
      });
      const body = (await res.json()) as { ok: boolean; message?: string };
      expect(res.status).toBe(404);
      expect(body.ok).toBe(false);
      expect(body.message).toContain("No config directory");
    } finally {
      server.close();
    }
  });

  it("copies config directory to timestamped backup when it exists", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(cpSync).mockImplementation(() => undefined);

    const app = createApp();
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/advanced/backup-config`, {
        method: "POST",
      });
      const body = (await res.json()) as { ok: boolean; path?: string };
      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.path).toContain("armorclaw-backup-");
      // Verify cpSync was called with correct source
      expect(vi.mocked(cpSync)).toHaveBeenCalledTimes(1);
      const [src, dest, opts] = vi.mocked(cpSync).mock.calls[0] as [
        string,
        string,
        Record<string, boolean>,
      ];
      expect(src).toBe(getLauncherDataPath());
      expect(dest).toContain("armorclaw-backup-");
      expect(opts.recursive).toBe(true);
    } finally {
      server.close();
    }
  });

  it("returns 500 when copy fails", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(cpSync).mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });

    const app = createApp();
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/advanced/backup-config`, {
        method: "POST",
      });
      const body = (await res.json()) as { ok: boolean; message?: string };
      expect(res.status).toBe(500);
      expect(body.ok).toBe(false);
      expect(body.message).toContain("EACCES");
    } finally {
      server.close();
    }
  });
});

// ── Gateway probe endpoint ──────────────────────────────────────────────────

describe("GET /api/advanced/gateway-probe", () => {
  it("returns reachable: false when gateway is not running", async () => {
    // Gateway is not running on port 18789 in test environment
    const app = createApp();
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/advanced/gateway-probe`);
      const body = (await res.json()) as { ok: boolean; reachable: boolean };
      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.reachable).toBe(false);
    } finally {
      server.close();
    }
  });
});
