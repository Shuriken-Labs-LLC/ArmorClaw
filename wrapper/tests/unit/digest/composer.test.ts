import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock node:fs before all imports
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  appendFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

// Mock the token tracker so we control its output
vi.mock("../../../token-tracker/store.ts", () => ({
  getDailyHistory: vi.fn(),
  getMonthTokens: vi.fn(),
  getBudgetMonthlyUSD: vi.fn(),
  isHardStopped: vi.fn(),
}));

// Mock the skill registry so display-name lookups are controllable
vi.mock("../../../lib/skill-registry.ts", () => ({
  getSkill: vi.fn(),
}));

import { readFileSync } from "node:fs";
import {
  BUDGET_PAUSED_MESSAGE,
  aggregateActivity,
  buildDigestData,
  loadAuditEntriesForDate,
  todayDateString,
  yesterdayDateString,
} from "../../../digest/composer.ts";
import { getSkill } from "../../../lib/skill-registry.ts";
import {
  getBudgetMonthlyUSD,
  getDailyHistory,
  getMonthTokens,
  isHardStopped,
} from "../../../token-tracker/store.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeAuditLine(
  overrides: {
    timestamp?: string;
    skill?: string;
    outcome?: string;
  } = {},
): string {
  return JSON.stringify({
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    skill: overrides.skill ?? "test-skill",
    permissionsUsed: [],
    inputSummary: "{}",
    outcome: overrides.outcome ?? "success",
    durationMs: 10,
  });
}

function setupStoreMocks({
  hardStopped = false,
  budget = 20,
  yesterdayCost = 0.12,
  monthCost = 6.82,
}: {
  hardStopped?: boolean;
  budget?: number;
  yesterdayCost?: number;
  monthCost?: number;
} = {}) {
  vi.mocked(isHardStopped).mockReturnValue(hardStopped);
  vi.mocked(getBudgetMonthlyUSD).mockReturnValue(budget);
  vi.mocked(getDailyHistory).mockReturnValue([
    {
      date: yesterdayDateString(),
      totalInputTokens: 1000,
      totalOutputTokens: 500,
      estimatedCostUSD: yesterdayCost,
    },
    {
      date: todayDateString(),
      totalInputTokens: 0,
      totalOutputTokens: 0,
      estimatedCostUSD: 0,
    },
  ]);
  vi.mocked(getMonthTokens).mockReturnValue({
    totalInputTokens: 5000,
    totalOutputTokens: 2500,
    estimatedCostUSD: monthCost,
  });
}

// ── Isolation ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.mocked(readFileSync).mockReset();
  vi.mocked(isHardStopped).mockReset();
  vi.mocked(getBudgetMonthlyUSD).mockReset();
  vi.mocked(getDailyHistory).mockReset();
  vi.mocked(getMonthTokens).mockReset();
  vi.mocked(getSkill).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── yesterdayDateString / todayDateString ─────────────────────────────────────

describe("yesterdayDateString", () => {
  it("returns a YYYY-MM-DD string", () => {
    expect(yesterdayDateString()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns a date one day before today", () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    expect(yesterdayDateString()).toBe(yesterday.toISOString().slice(0, 10));
  });
});

describe("todayDateString", () => {
  it("returns today's YYYY-MM-DD string", () => {
    expect(todayDateString()).toBe(new Date().toISOString().slice(0, 10));
  });
});

// ── loadAuditEntriesForDate ────────────────────────────────────────────────────

describe("loadAuditEntriesForDate", () => {
  it("returns empty array when file does not exist", () => {
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });
    expect(loadAuditEntriesForDate("2026-03-16")).toEqual([]);
  });

  it("returns entries matching the given date", () => {
    const line = makeAuditLine({ timestamp: "2026-03-16T09:00:00.000Z" });
    vi.mocked(readFileSync).mockReturnValueOnce(line + "\n");
    const entries = loadAuditEntriesForDate("2026-03-16");
    expect(entries).toHaveLength(1);
    expect(entries[0].skill).toBe("test-skill");
  });

  it("excludes entries from other dates", () => {
    const content =
      [
        makeAuditLine({ timestamp: "2026-03-16T09:00:00.000Z" }),
        makeAuditLine({ timestamp: "2026-03-15T09:00:00.000Z" }),
      ].join("\n") + "\n";
    vi.mocked(readFileSync).mockReturnValueOnce(content);
    expect(loadAuditEntriesForDate("2026-03-16")).toHaveLength(1);
  });

  it("skips blank lines", () => {
    const content = makeAuditLine({ timestamp: "2026-03-16T09:00:00.000Z" }) + "\n\n\n";
    vi.mocked(readFileSync).mockReturnValueOnce(content);
    expect(loadAuditEntriesForDate("2026-03-16")).toHaveLength(1);
  });

  it("skips malformed JSON lines", () => {
    const content = "not-json\n" + makeAuditLine({ timestamp: "2026-03-16T09:00:00.000Z" }) + "\n";
    vi.mocked(readFileSync).mockReturnValueOnce(content);
    expect(loadAuditEntriesForDate("2026-03-16")).toHaveLength(1);
  });

  it("skips lines without a skill or outcome field", () => {
    const noSkill = JSON.stringify({ timestamp: "2026-03-16T09:00:00.000Z", outcome: "success" });
    const noOutcome = JSON.stringify({ timestamp: "2026-03-16T09:00:00.000Z", skill: "foo" });
    const content = [noSkill, noOutcome].join("\n") + "\n";
    vi.mocked(readFileSync).mockReturnValueOnce(content);
    expect(loadAuditEntriesForDate("2026-03-16")).toHaveLength(0);
  });

  it("skips injection-rejection entries (no outcome field)", () => {
    const injectionLine = JSON.stringify({
      timestamp: "2026-03-16T09:00:00.000Z",
      type: "injection_rejected",
      tool: "bash",
      category: "instruction_override",
      input: "ignore previous instructions",
    });
    vi.mocked(readFileSync).mockReturnValueOnce(injectionLine + "\n");
    expect(loadAuditEntriesForDate("2026-03-16")).toHaveLength(0);
  });

  it("returns entries with outcome:error too", () => {
    const line = makeAuditLine({ timestamp: "2026-03-16T09:00:00.000Z", outcome: "error" });
    vi.mocked(readFileSync).mockReturnValueOnce(line + "\n");
    const entries = loadAuditEntriesForDate("2026-03-16");
    expect(entries).toHaveLength(1);
    expect(entries[0].outcome).toBe("error");
  });
});

// ── aggregateActivity ─────────────────────────────────────────────────────────

describe("aggregateActivity", () => {
  it("returns empty array for no entries", () => {
    vi.mocked(getSkill).mockReturnValue(undefined);
    expect(aggregateActivity([])).toEqual([]);
  });

  it("counts actions per skill", () => {
    vi.mocked(getSkill).mockReturnValue(undefined);
    const entries = [
      { timestamp: "2026-03-16T09:00:00.000Z", skill: "lead-scorer", outcome: "success" as const },
      { timestamp: "2026-03-16T10:00:00.000Z", skill: "lead-scorer", outcome: "success" as const },
      { timestamp: "2026-03-16T11:00:00.000Z", skill: "email-triage", outcome: "success" as const },
    ];
    const result = aggregateActivity(entries);
    const leadScorer = result.find((a) => a.displayName === "lead-scorer");
    expect(leadScorer?.actionCount).toBe(2);
    const emailTriage = result.find((a) => a.displayName === "email-triage");
    expect(emailTriage?.actionCount).toBe(1);
  });

  it("uses displayName from skill registry when available", () => {
    vi.mocked(getSkill).mockImplementation((id) => {
      if (id === "lead-scorer") {
        return {
          skillId: "lead-scorer",
          displayName: "Lead scorer",
          description: "...",
          version: "1.0.0",
          author: "bundled" as const,
          permissionManifest: [],
          undoable: false,
          recipeEligible: false,
          digestMention: true,
        };
      }
      return undefined;
    });
    const entries = [
      { timestamp: "2026-03-16T09:00:00.000Z", skill: "lead-scorer", outcome: "success" as const },
    ];
    const result = aggregateActivity(entries);
    expect(result[0].displayName).toBe("Lead scorer");
  });

  it("falls back to skillId when skill is not registered", () => {
    vi.mocked(getSkill).mockReturnValue(undefined);
    const entries = [
      {
        timestamp: "2026-03-16T09:00:00.000Z",
        skill: "unknown-skill",
        outcome: "success" as const,
      },
    ];
    const result = aggregateActivity(entries);
    expect(result[0].displayName).toBe("unknown-skill");
  });
});

// ── buildDigestData — budget paused ───────────────────────────────────────────

describe("buildDigestData — budget hard-stop active", () => {
  it("returns isBudgetPaused:true when hard stop is active", () => {
    vi.mocked(isHardStopped).mockReturnValue(true);
    vi.mocked(getBudgetMonthlyUSD).mockReturnValue(20);
    const result = buildDigestData();
    expect(result.isBudgetPaused).toBe(true);
  });

  it("returns the BUDGET_PAUSED_MESSAGE as prompt", () => {
    vi.mocked(isHardStopped).mockReturnValue(true);
    vi.mocked(getBudgetMonthlyUSD).mockReturnValue(20);
    const result = buildDigestData();
    expect(result.prompt).toBe(BUDGET_PAUSED_MESSAGE);
  });

  it("BUDGET_PAUSED_MESSAGE mentions dashboard", () => {
    expect(BUDGET_PAUSED_MESSAGE).toContain("dashboard");
  });

  it("does not read the audit log when budget is paused", () => {
    vi.mocked(isHardStopped).mockReturnValue(true);
    vi.mocked(getBudgetMonthlyUSD).mockReturnValue(20);
    buildDigestData();
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it("returns empty activity when budget is paused", () => {
    vi.mocked(isHardStopped).mockReturnValue(true);
    vi.mocked(getBudgetMonthlyUSD).mockReturnValue(20);
    const result = buildDigestData();
    expect(result.input.yesterdayActivity).toHaveLength(0);
  });
});

// ── buildDigestData — normal active day ───────────────────────────────────────

describe("buildDigestData — normal day with activity", () => {
  it("returns isBudgetPaused:false", () => {
    setupStoreMocks();
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });
    vi.mocked(getSkill).mockReturnValue(undefined);
    expect(buildDigestData().isBudgetPaused).toBe(false);
  });

  it("reads yesterday's audit log", () => {
    setupStoreMocks();
    const yesterday = yesterdayDateString();
    const line = makeAuditLine({
      timestamp: `${yesterday}T09:00:00.000Z`,
      skill: "lead-scorer",
    });
    vi.mocked(readFileSync).mockReturnValueOnce(line + "\n");
    vi.mocked(getSkill).mockReturnValue(undefined);
    const result = buildDigestData();
    expect(result.input.yesterdayActivity).toHaveLength(1);
    expect(result.input.yesterdayActivity[0].actionCount).toBe(1);
  });

  it("sets isQuiet:false when there is activity", () => {
    setupStoreMocks();
    const yesterday = yesterdayDateString();
    vi.mocked(readFileSync).mockReturnValueOnce(
      makeAuditLine({ timestamp: `${yesterday}T09:00:00.000Z` }) + "\n",
    );
    vi.mocked(getSkill).mockReturnValue(undefined);
    expect(buildDigestData().input.isQuiet).toBe(false);
  });

  it("sets isQuiet:true when there is no activity", () => {
    setupStoreMocks();
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });
    vi.mocked(getSkill).mockReturnValue(undefined);
    expect(buildDigestData().input.isQuiet).toBe(true);
  });

  it("populates token spend data from the store", () => {
    setupStoreMocks({ yesterdayCost: 0.12, monthCost: 6.82, budget: 20 });
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });
    vi.mocked(getSkill).mockReturnValue(undefined);
    const result = buildDigestData();
    expect(result.input.tokenYesterdayUSD).toBeCloseTo(0.12);
    expect(result.input.tokenMonthToDateUSD).toBeCloseTo(6.82);
    expect(result.input.monthlyBudgetUSD).toBe(20);
  });

  it("defaults tokenYesterdayUSD to 0 when getDailyHistory returns empty array", () => {
    vi.mocked(isHardStopped).mockReturnValue(false);
    vi.mocked(getBudgetMonthlyUSD).mockReturnValue(20);
    vi.mocked(getDailyHistory).mockReturnValue([]); // empty — covers the ?? 0 branch
    vi.mocked(getMonthTokens).mockReturnValue({
      totalInputTokens: 0,
      totalOutputTokens: 0,
      estimatedCostUSD: 5.0,
    });
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });
    vi.mocked(getSkill).mockReturnValue(undefined);
    const result = buildDigestData();
    expect(result.input.tokenYesterdayUSD).toBe(0);
  });

  it("sets today's date on the input", () => {
    setupStoreMocks();
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });
    vi.mocked(getSkill).mockReturnValue(undefined);
    const result = buildDigestData();
    expect(result.input.date).toBe(todayDateString());
  });

  it("prompt string references the date", () => {
    setupStoreMocks();
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });
    vi.mocked(getSkill).mockReturnValue(undefined);
    const result = buildDigestData();
    expect(result.prompt).toContain(todayDateString());
  });
});

// ── buildDigestData — optional overrides ──────────────────────────────────────

describe("buildDigestData — optional overrides", () => {
  it("uses provided calendarEvents", () => {
    setupStoreMocks();
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });
    vi.mocked(getSkill).mockReturnValue(undefined);
    const events = [{ time: "9:00am", title: "Standup" }];
    const result = buildDigestData({ calendarEvents: events });
    expect(result.input.calendarEvents).toEqual(events);
  });

  it("sets calendarUnavailable when passed", () => {
    setupStoreMocks();
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });
    vi.mocked(getSkill).mockReturnValue(undefined);
    const result = buildDigestData({ calendarUnavailable: true });
    expect(result.input.calendarUnavailable).toBe(true);
    expect(result.prompt).toContain("reconnect");
  });

  it("includes pending items when provided", () => {
    setupStoreMocks();
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });
    vi.mocked(getSkill).mockReturnValue(undefined);
    const result = buildDigestData({ pendingItems: ["1 email draft waiting"] });
    expect(result.input.pendingItems).toEqual(["1 email draft waiting"]);
  });

  it("includes suggestion in prompt when provided", () => {
    setupStoreMocks();
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });
    vi.mocked(getSkill).mockReturnValue(undefined);
    const result = buildDigestData({ suggestion: "Review overdue leads?" });
    expect(result.prompt).toContain("Review overdue leads");
  });

  it("defaults to empty pendingItems and calendarEvents when not provided", () => {
    setupStoreMocks();
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });
    vi.mocked(getSkill).mockReturnValue(undefined);
    const result = buildDigestData();
    expect(result.input.pendingItems).toEqual([]);
    expect(result.input.calendarEvents).toEqual([]);
    expect(result.input.calendarUnavailable).toBe(false);
  });
});
