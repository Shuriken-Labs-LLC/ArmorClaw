/**
 * Unit tests for wrapper/dashboard/server.ts.
 *
 * Pure logic (agent status, env reader, audit log, snapshot) is tested
 * directly. All I/O is mocked via vi.mock so no disk access occurs.
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
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => {
    throw new Error("not found");
  }),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import {
  clearDashboardStateForTesting,
  getDashboardSnapshot,
  getAgentStatus,
  getSecurityStats,
  getTailscaleUrl,
  getPendingApprovals,
  notifyListeners,
  onDashboardChange,
  readEnvConfig,
  readRecentAuditEntries,
  resetTailscaleCacheForTesting,
  resetTelegramCacheForTesting,
  setAgentStatus,
  writeEnvVar,
} from "../../../dashboard/server.ts";
import { getBudgetStatus } from "../../../token-tracker/store.ts";
import { getCurrentUndo } from "../../../undo/registry.ts";

// ── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  clearDashboardStateForTesting();
  vi.clearAllMocks();
  vi.mocked(getCurrentUndo).mockReturnValue(null);
  // Default: both .env and audit log absent
  vi.mocked(readFileSync).mockImplementation(() => {
    throw new Error("ENOENT");
  });
});

afterEach(() => {
  clearDashboardStateForTesting();
});

// ── Agent status ─────────────────────────────────────────────────────────────

describe("agent status", () => {
  it("defaults to 'running'", () => {
    expect(getAgentStatus()).toBe("running");
  });

  it("setAgentStatus('paused') updates the value", () => {
    setAgentStatus("paused");
    expect(getAgentStatus()).toBe("paused");
  });

  it("setAgentStatus('error') updates the value", () => {
    setAgentStatus("error");
    expect(getAgentStatus()).toBe("error");
  });

  it("can cycle back to running", () => {
    setAgentStatus("paused");
    setAgentStatus("running");
    expect(getAgentStatus()).toBe("running");
  });
});

// ── Pending approvals ─────────────────────────────────────────────────────────

describe("pending approvals", () => {
  it("returns empty array when no pending approvals exist", async () => {
    const result = await getPendingApprovals();
    expect(result).toHaveLength(0);
    expect(result).toEqual([]);
  });

  it("maps permission engine approvals to dashboard PendingApproval shape", async () => {
    const { getPendingApprovals: mockGetPending } =
      await import("../../../security/permissions.ts");
    (mockGetPending as ReturnType<typeof vi.fn>).mockReturnValueOnce([
      {
        id: "approval-1-12345",
        toolName: "read_email",
        skillId: null,
        timestamp: "2026-04-06T12:00:00Z",
        resolved: false,
        approved: false,
      },
    ]);
    const result = await getPendingApprovals();
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "approval-1-12345",
      skill: "read_email",
      displayName: "Read email",
      requestedAt: "2026-04-06T12:00:00Z",
      source: "local",
    });
  });
});

// ── SSE listeners ─────────────────────────────────────────────────────────────

describe("SSE listeners", () => {
  it("notifyListeners() fires all registered listeners", () => {
    const fn = vi.fn();
    onDashboardChange(fn);
    notifyListeners();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe prevents further calls", () => {
    const fn = vi.fn();
    const unsub = onDashboardChange(fn);
    unsub();
    notifyListeners();
    expect(fn).not.toHaveBeenCalled();
  });

  it("multiple listeners all fire", () => {
    const a = vi.fn();
    const b = vi.fn();
    onDashboardChange(a);
    onDashboardChange(b);
    notifyListeners();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("a throwing listener does not prevent others from firing", () => {
    const bad = vi.fn(() => {
      throw new Error("boom");
    });
    const good = vi.fn();
    onDashboardChange(bad);
    onDashboardChange(good);
    expect(() => notifyListeners()).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
  });
});

// ── .env config reader ────────────────────────────────────────────────────────

describe("readEnvConfig", () => {
  it("returns an empty object when the file is missing", () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(readEnvConfig()).toEqual({});
  });

  it("parses key=value pairs", () => {
    vi.mocked(readFileSync).mockReturnValue(
      "ANTHROPIC_API_KEY=sk-abc\nARMORCLAW_MODEL_PROVIDER=anthropic\n",
    );
    const cfg = readEnvConfig();
    expect(cfg["ANTHROPIC_API_KEY"]).toBe("sk-abc");
    expect(cfg["ARMORCLAW_MODEL_PROVIDER"]).toBe("anthropic");
  });

  it("ignores blank lines and comment lines", () => {
    vi.mocked(readFileSync).mockReturnValue("# a comment\n\nKEY=val\n");
    const cfg = readEnvConfig();
    expect(Object.keys(cfg)).toEqual(["KEY"]);
    expect(cfg["KEY"]).toBe("val");
  });

  it("strips surrounding quotes from values", () => {
    vi.mocked(readFileSync).mockReturnValue('KEY="quoted value"\n');
    expect(readEnvConfig()["KEY"]).toBe("quoted value");
  });

  it("handles values that contain '='", () => {
    vi.mocked(readFileSync).mockReturnValue("TOKEN=abc=def=ghi\n");
    expect(readEnvConfig()["TOKEN"]).toBe("abc=def=ghi");
  });
});

// ── Audit log reader ──────────────────────────────────────────────────────────

describe("readRecentAuditEntries", () => {
  // readFileSync is called for both .env and audit log; we only mock the audit log here.
  // Use a helper that throws for .env paths and returns data for the audit log path.
  const mkMock = (content: string) =>
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      if (String(path).endsWith("audit.log")) {
        return content;
      }
      throw new Error("ENOENT");
    });

  it("returns [] when log is absent", () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(readRecentAuditEntries()).toEqual([]);
  });

  it("returns entries newest-first", () => {
    const e1 = {
      timestamp: "2024-01-01T00:00:00Z",
      skill: "a",
      permissionsUsed: [],
      inputSummary: "",
      outcome: "success",
      durationMs: 1,
    };
    const e2 = {
      timestamp: "2024-01-02T00:00:00Z",
      skill: "b",
      permissionsUsed: [],
      inputSummary: "",
      outcome: "success",
      durationMs: 1,
    };
    mkMock(`${JSON.stringify(e1)}\n${JSON.stringify(e2)}\n`);
    const result = readRecentAuditEntries();
    expect(result[0].skill).toBe("b"); // newest first
    expect(result[1].skill).toBe("a");
  });

  it("skips malformed lines", () => {
    const valid = {
      timestamp: "2024-01-01T00:00:00Z",
      skill: "ok",
      permissionsUsed: [],
      inputSummary: "",
      outcome: "success",
      durationMs: 1,
    };
    mkMock(`{bad json\n${JSON.stringify(valid)}\n`);
    expect(readRecentAuditEntries()).toHaveLength(1);
  });

  it("respects the limit", () => {
    const lines = Array.from({ length: 25 }, (_, i) =>
      JSON.stringify({
        timestamp: `2024-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
        skill: `s${i}`,
        permissionsUsed: [],
        inputSummary: "",
        outcome: "success",
        durationMs: 1,
      }),
    ).join("\n");
    mkMock(lines);
    expect(readRecentAuditEntries(10)).toHaveLength(10);
  });

  it("skips blank lines", () => {
    const valid = {
      timestamp: "2024-01-01T00:00:00Z",
      skill: "ok",
      permissionsUsed: [],
      inputSummary: "",
      outcome: "success",
      durationMs: 1,
    };
    mkMock(`\n\n${JSON.stringify(valid)}\n\n`);
    expect(readRecentAuditEntries()).toHaveLength(1);
  });
});

// ── Tailscale URL detection ───────────────────────────────────────────────────

describe("getTailscaleUrl", () => {
  beforeEach(() => resetTailscaleCacheForTesting());

  it("returns null when tailscale command is absent", () => {
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error("not found");
    });
    expect(getTailscaleUrl()).toBeNull();
  });

  it("parses DNSName from tailscale status JSON", () => {
    vi.mocked(execSync).mockReturnValue(
      JSON.stringify({ Self: { DNSName: "my-mac.tail1234.ts.net." } }),
    );
    expect(getTailscaleUrl()).toBe("https://my-mac.tail1234.ts.net");
  });

  it("strips trailing dot from DNSName", () => {
    vi.mocked(execSync).mockReturnValue(
      JSON.stringify({ Self: { DNSName: "device.tailnet.ts.net." } }),
    );
    expect(getTailscaleUrl()).toBe("https://device.tailnet.ts.net");
  });

  it("returns null when Self.DNSName is missing", () => {
    vi.mocked(execSync).mockReturnValue(JSON.stringify({ Self: {} }));
    expect(getTailscaleUrl()).toBeNull();
  });

  it("returns null when tailscale output is not valid JSON", () => {
    vi.mocked(execSync).mockReturnValue("not json");
    expect(getTailscaleUrl()).toBeNull();
  });

  it("caches the result on second call", () => {
    vi.mocked(execSync).mockReturnValue(JSON.stringify({ Self: { DNSName: "host.ts.net." } }));
    getTailscaleUrl();
    getTailscaleUrl();
    expect(vi.mocked(execSync)).toHaveBeenCalledTimes(1);
  });
});

// ── writeEnvVar ───────────────────────────────────────────────────────────────

describe("writeEnvVar", () => {
  it("adds a new key when file is missing", () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    const result = writeEnvVar("NEW_KEY", "newval");
    expect(result).toBe(true);
    expect(vi.mocked(writeFileSync)).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("NEW_KEY=newval"),
      "utf-8",
    );
  });

  it("updates an existing key in place", () => {
    vi.mocked(readFileSync).mockReturnValue("OLD_KEY=old\nOTHER=keep\n");
    writeEnvVar("OLD_KEY", "updated");
    const written = vi.mocked(writeFileSync).mock.calls[0][1] as string;
    expect(written).toContain("OLD_KEY=updated");
    expect(written).toContain("OTHER=keep");
    expect(written).not.toContain("OLD_KEY=old");
  });

  it("returns false on write error", () => {
    vi.mocked(readFileSync).mockReturnValue("");
    vi.mocked(writeFileSync).mockImplementation(() => {
      throw new Error("EPERM");
    });
    expect(writeEnvVar("K", "v")).toBe(false);
  });
});

// ── Security stats ────────────────────────────────────────────────────────────

describe("getSecurityStats", () => {
  const mkMock = (content: string) =>
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      if (String(path).endsWith("audit.log")) {
        return content;
      }
      throw new Error("ENOENT");
    });

  it("returns safe defaults when audit log is absent", () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    const s = getSecurityStats();
    expect(s.injectionFilterActive).toBe(true);
    expect(s.rejectionsToday).toBe(0);
    expect(s.sparkline7d).toHaveLength(7);
    expect(s.sparkline7d.every((n) => n === 0)).toBe(true);
    expect(s.gatewayHost).toBe("127.0.0.1");
  });

  it("counts only rejected entries for today in rejectionsToday", () => {
    const todayISO = new Date().toISOString();
    const rejected = {
      timestamp: todayISO,
      skill: "filter",
      permissionsUsed: [],
      inputSummary: "",
      outcome: "rejected",
      durationMs: 1,
    };
    const success = {
      timestamp: todayISO,
      skill: "a",
      permissionsUsed: [],
      inputSummary: "",
      outcome: "success",
      durationMs: 1,
    };
    mkMock(`${JSON.stringify(rejected)}\n${JSON.stringify(success)}\n`);
    expect(getSecurityStats().rejectionsToday).toBe(1);
  });

  it("sparkline7d has 7 elements, last element equals rejectionsToday", () => {
    const todayISO = new Date().toISOString();
    const entry = {
      timestamp: todayISO,
      skill: "f",
      permissionsUsed: [],
      inputSummary: "",
      outcome: "rejected",
      durationMs: 1,
    };
    mkMock(`${JSON.stringify(entry)}\n`);
    const s = getSecurityStats();
    expect(s.sparkline7d).toHaveLength(7);
    expect(s.sparkline7d[6]).toBe(s.rejectionsToday);
  });

  it("skips malformed audit lines without throwing", () => {
    mkMock("{bad\n");
    expect(() => getSecurityStats()).not.toThrow();
    expect(getSecurityStats().rejectionsToday).toBe(0);
  });

  it("injectionFilterActive is always true", () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(getSecurityStats().injectionFilterActive).toBe(true);
  });
});

// ── Dashboard snapshot ────────────────────────────────────────────────────────

describe("getDashboardSnapshot", () => {
  beforeEach(() => {
    resetTelegramCacheForTesting();
    // Suppress Telegram API call — token not present in env during tests
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
  });

  it("returns the expected shape", async () => {
    const snap = await getDashboardSnapshot();
    expect(snap).toHaveProperty("agentStatus");
    expect(snap).toHaveProperty("config");
    expect(snap).toHaveProperty("channels");
    expect(snap).toHaveProperty("budget");
    expect(snap).toHaveProperty("monthTokens");
    expect(snap).toHaveProperty("undo");
    expect(snap).toHaveProperty("pendingApprovals");
    expect(snap).toHaveProperty("feed");
    expect(snap).toHaveProperty("skills");
    expect(snap).toHaveProperty("recipes");
    expect(snap).toHaveProperty("connectedServices");
    expect(snap).toHaveProperty("tailscaleUrl");
    expect(snap).toHaveProperty("paymentLinkBase");
    expect(snap).toHaveProperty("stripeCustomerPortalUrl");
    expect(typeof snap.stripeCustomerPortalUrl).toBe("string");
    expect(snap).toHaveProperty("security");
    expect(snap).toHaveProperty("serverTime");
  });

  it("reflects current agent status", async () => {
    setAgentStatus("paused");
    const snap = await getDashboardSnapshot();
    expect(snap.agentStatus).toBe("paused");
  });

  it("pendingApprovals is always empty (stub)", async () => {
    const snap = await getDashboardSnapshot();
    expect(snap.pendingApprovals).toEqual([]);
  });

  it("recipes returns all bundled recipes", async () => {
    const snap = await getDashboardSnapshot();
    expect(Array.isArray(snap.recipes)).toBe(true);
    expect(snap.recipes.length).toBeGreaterThan(0);
    expect(snap.recipes[0]).toHaveProperty("id");
    expect(snap.recipes[0]).toHaveProperty("active");
  });

  it("undo is null when no entry exists", async () => {
    vi.mocked(getCurrentUndo).mockReturnValue(null);
    expect((await getDashboardSnapshot()).undo).toBeNull();
  });

  it("undo is populated when an entry exists", async () => {
    vi.mocked(getCurrentUndo).mockReturnValue({
      id: "u1",
      actionType: "file-write",
      skill: "secure-files",
      timestamp: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      snapshot: null,
      undoFn: async () => {},
    });
    const snap = await getDashboardSnapshot();
    expect(snap.undo?.id).toBe("u1");
    expect(snap.undo?.actionType).toBe("file-write");
  });

  it("config reads model provider and sandbox dir from .env", async () => {
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      if (String(path).endsWith(".env")) {
        return "ARMORCLAW_MODEL_PROVIDER=anthropic\nARMORCLAW_SANDBOX_DIR=/Users/test/ArmorClaw\n";
      }
      throw new Error("ENOENT");
    });
    const snap = await getDashboardSnapshot();
    expect(snap.config.modelProvider).toBe("anthropic");
    expect(snap.config.sandboxDir).toBe("/Users/test/ArmorClaw");
  });

  it("config fields are null when .env is missing", async () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    const snap = await getDashboardSnapshot();
    expect(snap.config.modelProvider).toBeNull();
    expect(snap.config.sandboxDir).toBeNull();
  });

  it("budget comes from getBudgetStatus()", async () => {
    vi.mocked(getBudgetStatus).mockReturnValue({
      monthlyBudgetUSD: 50,
      spentThisMonthUSD: 12,
      percentUsed: 24,
      isHardStopped: false,
    });
    expect((await getDashboardSnapshot()).budget.monthlyBudgetUSD).toBe(50);
  });

  it("connectedServices reflects .env keys", async () => {
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      if (String(path).endsWith(".env")) {
        return "ARMORCLAW_GMAIL_CONNECTED=true\n";
      }
      throw new Error("ENOENT");
    });
    const snap = await getDashboardSnapshot();
    expect(snap.connectedServices.gmail).toBe(true);
    expect(snap.connectedServices.outlook).toBe(false);
  });

  it("paymentLinkBase falls back to STRIPE_DEFAULTS when env is unset", async () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    const { STRIPE_DEFAULTS } = await import("../../../billing/stripe-redirect.ts");
    const snap = await getDashboardSnapshot();
    expect(snap.paymentLinkBase).toBe(STRIPE_DEFAULTS.paymentLink);
  });

  it("stripeCustomerPortalUrl falls back to STRIPE_DEFAULTS when env is unset", async () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    const { STRIPE_DEFAULTS } = await import("../../../billing/stripe-redirect.ts");
    const snap = await getDashboardSnapshot();
    expect(snap.stripeCustomerPortalUrl).toBe(STRIPE_DEFAULTS.customerPortalUrl);
  });

  it("stripeCustomerPortalUrl reads from env var when set", async () => {
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      if (String(path).endsWith(".env")) {
        return "STRIPE_CUSTOMER_PORTAL_URL=https://billing.stripe.com/custom\n";
      }
      throw new Error("ENOENT");
    });
    const snap = await getDashboardSnapshot();
    expect(snap.stripeCustomerPortalUrl).toBe("https://billing.stripe.com/custom");
  });

  it("paymentLinkBase reads from STRIPE_PAYMENT_LINK env var", async () => {
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      if (String(path).endsWith(".env")) {
        return "STRIPE_PAYMENT_LINK=https://buy.stripe.com/custom\n";
      }
      throw new Error("ENOENT");
    });
    const snap = await getDashboardSnapshot();
    expect(snap.paymentLinkBase).toBe("https://buy.stripe.com/custom");
  });

  it("serverTime is a recent ISO 8601 string", async () => {
    const before = Date.now();
    const snap = await getDashboardSnapshot();
    const t = new Date(snap.serverTime).getTime();
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(Date.now());
  });
});
