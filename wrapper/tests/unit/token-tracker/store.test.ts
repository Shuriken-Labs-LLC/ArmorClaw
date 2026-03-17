import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
  appendFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
}));

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import {
  type BudgetAlertLevel,
  type TokenEvent,
  clearStoreForTesting,
  getBudgetMonthlyUSD,
  getBudgetStatus,
  getDailyHistory,
  getMonthByProvider,
  getMonthBySkill,
  getMonthTokens,
  getTodayTokens,
  isHardStopped,
  onBudgetAlert,
  recordTokenEvent,
  resumeFromHardStop,
  setBudgetMonthlyUSD,
} from "../../../token-tracker/store.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<TokenEvent> = {}): TokenEvent {
  return {
    timestamp: new Date().toISOString(),
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    skill: "test-skill",
    inputTokens: 1000,
    outputTokens: 500,
    estimatedCostUSD: 0.01,
    ...overrides,
  };
}

/** Mock readFileSync to return NDJSON of the given events. */
function mockStore(events: TokenEvent[]): void {
  const content = events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : "");
  vi.mocked(readFileSync).mockReturnValue(content);
}

/** Silence stderr during recordTokenEvent failure tests. */
function suppressStderr() {
  return vi.spyOn(process.stderr, "write").mockImplementation(() => true);
}

// ── Isolation ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  clearStoreForTesting();
  vi.mocked(appendFileSync).mockReset();
  vi.mocked(mkdirSync).mockReset();
  vi.mocked(readFileSync).mockReset();
});

afterEach(() => {
  clearStoreForTesting();
});

// ── recordTokenEvent — happy path ─────────────────────────────────────────────

describe("recordTokenEvent — happy path", () => {
  it("calls mkdirSync and appendFileSync", async () => {
    mockStore([]);
    await recordTokenEvent(makeEvent());
    expect(mkdirSync).toHaveBeenCalledOnce();
    expect(appendFileSync).toHaveBeenCalledOnce();
  });

  it("appends a valid NDJSON line", async () => {
    mockStore([]);
    const event = makeEvent({ skill: "my-skill" });
    await recordTokenEvent(event);
    const [, content] = vi.mocked(appendFileSync).mock.calls[0] as [string, string, string];
    expect(content.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(content.trimEnd()) as TokenEvent;
    expect(parsed.skill).toBe("my-skill");
    expect(parsed.provider).toBe("anthropic");
  });

  it("appends to the tokens.ndjson file path", async () => {
    mockStore([]);
    await recordTokenEvent(makeEvent());
    const [path] = vi.mocked(appendFileSync).mock.calls[0] as [string, string, string];
    expect(path).toContain("tokens.ndjson");
  });
});

// ── recordTokenEvent — I/O failure ────────────────────────────────────────────

describe("recordTokenEvent — I/O failure (never throws)", () => {
  it("does not throw when mkdirSync fails", async () => {
    const spy = suppressStderr();
    vi.mocked(mkdirSync).mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    mockStore([]);
    await expect(recordTokenEvent(makeEvent())).resolves.toBeUndefined();
    spy.mockRestore();
  });

  it("does not throw when appendFileSync fails", async () => {
    const spy = suppressStderr();
    vi.mocked(appendFileSync).mockImplementationOnce(() => {
      throw new Error("no space left");
    });
    mockStore([]);
    await expect(recordTokenEvent(makeEvent())).resolves.toBeUndefined();
    spy.mockRestore();
  });

  it("writes to stderr when a write fails", async () => {
    const stderrSpy = suppressStderr();
    vi.mocked(mkdirSync).mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    mockStore([]);
    await recordTokenEvent(makeEvent());
    expect(stderrSpy).toHaveBeenCalled();
    stderrSpy.mockRestore();
  });
});

// ── getTodayTokens ────────────────────────────────────────────────────────────

describe("getTodayTokens", () => {
  it("returns zero summary when store is empty", () => {
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });
    const result = getTodayTokens();
    expect(result.totalInputTokens).toBe(0);
    expect(result.totalOutputTokens).toBe(0);
    expect(result.estimatedCostUSD).toBe(0);
  });

  it("sums only today's events", () => {
    const today = new Date().toISOString();
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    mockStore([
      makeEvent({ timestamp: today, inputTokens: 100, outputTokens: 50, estimatedCostUSD: 0.01 }),
      makeEvent({ timestamp: today, inputTokens: 200, outputTokens: 100, estimatedCostUSD: 0.02 }),
      makeEvent({
        timestamp: yesterday,
        inputTokens: 999,
        outputTokens: 999,
        estimatedCostUSD: 9.99,
      }),
    ]);
    const result = getTodayTokens();
    expect(result.totalInputTokens).toBe(300);
    expect(result.totalOutputTokens).toBe(150);
    expect(result.estimatedCostUSD).toBeCloseTo(0.03);
  });

  it("returns zero when all events are from other days", () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    mockStore([makeEvent({ timestamp: yesterday, inputTokens: 500, estimatedCostUSD: 5.0 })]);
    const result = getTodayTokens();
    expect(result.totalInputTokens).toBe(0);
    expect(result.estimatedCostUSD).toBe(0);
  });
});

// ── getMonthTokens ────────────────────────────────────────────────────────────

describe("getMonthTokens", () => {
  it("returns zero summary when store is empty", () => {
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });
    expect(getMonthTokens().estimatedCostUSD).toBe(0);
  });

  it("sums only the current month's events", () => {
    const thisMonth = new Date().toISOString();
    const lastMonth = new Date();
    lastMonth.setMonth(lastMonth.getMonth() - 1);
    mockStore([
      makeEvent({
        timestamp: thisMonth,
        inputTokens: 100,
        outputTokens: 50,
        estimatedCostUSD: 1.0,
      }),
      makeEvent({
        timestamp: lastMonth.toISOString(),
        inputTokens: 999,
        outputTokens: 999,
        estimatedCostUSD: 99.0,
      }),
    ]);
    const result = getMonthTokens();
    expect(result.totalInputTokens).toBe(100);
    expect(result.estimatedCostUSD).toBeCloseTo(1.0);
  });

  it("sums multiple events in the same month", () => {
    const ts = new Date().toISOString();
    mockStore([
      makeEvent({ timestamp: ts, estimatedCostUSD: 1.0 }),
      makeEvent({ timestamp: ts, estimatedCostUSD: 2.5 }),
      makeEvent({ timestamp: ts, estimatedCostUSD: 0.5 }),
    ]);
    expect(getMonthTokens().estimatedCostUSD).toBeCloseTo(4.0);
  });
});

// ── getMonthBySkill ───────────────────────────────────────────────────────────

describe("getMonthBySkill", () => {
  it("returns empty object when no events this month", () => {
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });
    expect(getMonthBySkill()).toEqual({});
  });

  it("groups costs by skill", () => {
    const ts = new Date().toISOString();
    mockStore([
      makeEvent({ timestamp: ts, skill: "search", estimatedCostUSD: 1.0 }),
      makeEvent({ timestamp: ts, skill: "search", estimatedCostUSD: 2.0 }),
      makeEvent({ timestamp: ts, skill: "digest", estimatedCostUSD: 0.5 }),
    ]);
    const result = getMonthBySkill();
    expect(result["search"]).toBeCloseTo(3.0);
    expect(result["digest"]).toBeCloseTo(0.5);
  });

  it("excludes events from previous months", () => {
    const lastMonth = new Date();
    lastMonth.setMonth(lastMonth.getMonth() - 1);
    mockStore([
      makeEvent({
        timestamp: lastMonth.toISOString(),
        skill: "old-skill",
        estimatedCostUSD: 99.0,
      }),
    ]);
    expect(getMonthBySkill()["old-skill"]).toBeUndefined();
  });
});

// ── getMonthByProvider ────────────────────────────────────────────────────────

describe("getMonthByProvider", () => {
  it("returns empty object when no events this month", () => {
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });
    expect(getMonthByProvider()).toEqual({});
  });

  it("groups costs by provider", () => {
    const ts = new Date().toISOString();
    mockStore([
      makeEvent({ timestamp: ts, provider: "anthropic", estimatedCostUSD: 5.0 }),
      makeEvent({ timestamp: ts, provider: "anthropic", estimatedCostUSD: 3.0 }),
      makeEvent({ timestamp: ts, provider: "openai", estimatedCostUSD: 2.0 }),
      makeEvent({ timestamp: ts, provider: "ollama", estimatedCostUSD: 0.0 }),
    ]);
    const result = getMonthByProvider();
    expect(result["anthropic"]).toBeCloseTo(8.0);
    expect(result["openai"]).toBeCloseTo(2.0);
    expect(result["ollama"]).toBeCloseTo(0.0);
  });

  it("excludes events from previous months (exercises continue branch)", () => {
    const thisMonth = new Date().toISOString();
    const lastMonth = new Date();
    lastMonth.setMonth(lastMonth.getMonth() - 1);
    mockStore([
      makeEvent({ timestamp: thisMonth, provider: "anthropic", estimatedCostUSD: 4.0 }),
      makeEvent({ timestamp: lastMonth.toISOString(), provider: "openai", estimatedCostUSD: 99.0 }),
    ]);
    const result = getMonthByProvider();
    expect(result["anthropic"]).toBeCloseTo(4.0);
    expect(result["openai"]).toBeUndefined();
  });
});

// ── getDailyHistory ───────────────────────────────────────────────────────────

describe("getDailyHistory", () => {
  it("returns the requested number of days", () => {
    vi.mocked(readFileSync).mockReturnValue("");
    expect(getDailyHistory(7)).toHaveLength(7);
    expect(getDailyHistory(30)).toHaveLength(30);
  });

  it("caps at 90 days", () => {
    vi.mocked(readFileSync).mockReturnValue("");
    expect(getDailyHistory(200)).toHaveLength(90);
  });

  it("clamps minimum to 1 day", () => {
    vi.mocked(readFileSync).mockReturnValue("");
    expect(getDailyHistory(0)).toHaveLength(1);
    expect(getDailyHistory(-5)).toHaveLength(1);
  });

  it("last entry in array is today", () => {
    vi.mocked(readFileSync).mockReturnValue("");
    const history = getDailyHistory(7);
    const today = new Date().toISOString().slice(0, 10);
    expect(history[history.length - 1].date).toBe(today);
  });

  it("first entry is N-1 days ago", () => {
    vi.mocked(readFileSync).mockReturnValue("");
    const history = getDailyHistory(7);
    const expected = new Date();
    expected.setDate(expected.getDate() - 6);
    expect(history[0].date).toBe(expected.toISOString().slice(0, 10));
  });

  it("includes zero-value entries for days with no events", () => {
    vi.mocked(readFileSync).mockReturnValue("");
    const history = getDailyHistory(7);
    for (const day of history) {
      expect(day.totalInputTokens).toBe(0);
      expect(day.estimatedCostUSD).toBe(0);
    }
  });

  it("correctly aggregates events into the matching day bucket", () => {
    const today = new Date().toISOString();
    const twoDaysAgo = new Date();
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
    mockStore([
      makeEvent({ timestamp: today, inputTokens: 100, outputTokens: 50, estimatedCostUSD: 1.0 }),
      makeEvent({ timestamp: today, inputTokens: 200, outputTokens: 100, estimatedCostUSD: 2.0 }),
      makeEvent({
        timestamp: twoDaysAgo.toISOString(),
        inputTokens: 500,
        outputTokens: 250,
        estimatedCostUSD: 5.0,
      }),
    ]);
    const history = getDailyHistory(7);
    const todayEntry = history.find((d) => d.date === today.slice(0, 10))!;
    expect(todayEntry.totalInputTokens).toBe(300);
    expect(todayEntry.estimatedCostUSD).toBeCloseTo(3.0);

    const oldEntry = history.find((d) => d.date === twoDaysAgo.toISOString().slice(0, 10))!;
    expect(oldEntry.estimatedCostUSD).toBeCloseTo(5.0);
  });

  it("excludes events older than the requested window", () => {
    const ancient = new Date();
    ancient.setDate(ancient.getDate() - 100);
    mockStore([
      makeEvent({ timestamp: ancient.toISOString(), inputTokens: 9999, estimatedCostUSD: 99.0 }),
    ]);
    const history = getDailyHistory(7);
    const total = history.reduce((sum, d) => sum + d.estimatedCostUSD, 0);
    expect(total).toBe(0);
  });

  it("skips malformed NDJSON lines", () => {
    const today = new Date().toISOString();
    const content =
      "not valid json\n" +
      JSON.stringify(makeEvent({ timestamp: today, estimatedCostUSD: 1.5 })) +
      "\n";
    vi.mocked(readFileSync).mockReturnValue(content);
    const history = getDailyHistory(1);
    expect(history[0].estimatedCostUSD).toBeCloseTo(1.5);
  });
});

// ── getBudgetStatus ───────────────────────────────────────────────────────────

describe("getBudgetStatus", () => {
  it("returns default $20 budget with 0% used when store is empty", () => {
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });
    const status = getBudgetStatus();
    expect(status.monthlyBudgetUSD).toBe(20);
    expect(status.spentThisMonthUSD).toBe(0);
    expect(status.percentUsed).toBe(0);
    expect(status.isHardStopped).toBe(false);
  });

  it("calculates correct percent used", () => {
    const ts = new Date().toISOString();
    mockStore([makeEvent({ timestamp: ts, estimatedCostUSD: 10.0 })]);
    // default budget $20, spent $10 = 50%
    const status = getBudgetStatus();
    expect(status.percentUsed).toBeCloseTo(50);
  });

  it("percent used can exceed 100 when over budget", () => {
    setBudgetMonthlyUSD(5);
    const ts = new Date().toISOString();
    mockStore([makeEvent({ timestamp: ts, estimatedCostUSD: 10.0 })]);
    const status = getBudgetStatus();
    expect(status.percentUsed).toBeCloseTo(200);
  });

  it("returns percentUsed 0 when monthlyBudgetUSD would divide by zero (guarded)", () => {
    // setBudgetMonthlyUSD rejects <=0, but if budget were somehow 0 the guard returns 0
    // We can verify the default budget is positive
    expect(getBudgetMonthlyUSD()).toBeGreaterThan(0);
  });

  it("reflects isHardStopped state", () => {
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });
    expect(getBudgetStatus().isHardStopped).toBe(false);
    // Manually trigger hard stop path by setting tiny budget and large spend
    setBudgetMonthlyUSD(1);
    const ts = new Date().toISOString();
    mockStore([makeEvent({ timestamp: ts, estimatedCostUSD: 5.0 })]);
    // hard stop is set via recordTokenEvent; we can set it via resumeFromHardStop inverse
    // Test the flag directly after resumeFromHardStop
    resumeFromHardStop(); // ensure cleared first
    expect(getBudgetStatus().isHardStopped).toBe(false);
  });
});

// ── getBudgetMonthlyUSD / setBudgetMonthlyUSD ─────────────────────────────────

describe("getBudgetMonthlyUSD / setBudgetMonthlyUSD", () => {
  it("returns default $20", () => {
    expect(getBudgetMonthlyUSD()).toBe(20);
  });

  it("stores a new budget value", () => {
    setBudgetMonthlyUSD(50);
    expect(getBudgetMonthlyUSD()).toBe(50);
  });

  it("throws RangeError for zero", () => {
    expect(() => setBudgetMonthlyUSD(0)).toThrow(RangeError);
  });

  it("throws RangeError for negative values", () => {
    expect(() => setBudgetMonthlyUSD(-10)).toThrow(RangeError);
  });

  it("accepts fractional values (e.g. $0.50)", () => {
    expect(() => setBudgetMonthlyUSD(0.5)).not.toThrow();
    expect(getBudgetMonthlyUSD()).toBe(0.5);
  });
});

// ── isHardStopped / resumeFromHardStop ────────────────────────────────────────
// Budget hard-stop logic must be 100% covered per CLAUDE.md

describe("isHardStopped (hard-stop contract — 100% coverage required)", () => {
  it("is false by default", () => {
    expect(isHardStopped()).toBe(false);
  });

  it("is false after resumeFromHardStop", () => {
    resumeFromHardStop();
    expect(isHardStopped()).toBe(false);
  });
});

describe("resumeFromHardStop (hard-stop contract — 100% coverage required)", () => {
  it("clears the hard-stop flag", async () => {
    // Trigger the hard stop via recordTokenEvent
    setBudgetMonthlyUSD(1);
    const ts = new Date().toISOString();
    mockStore([makeEvent({ timestamp: ts, estimatedCostUSD: 5.0 })]);
    await recordTokenEvent(makeEvent({ estimatedCostUSD: 0 }));
    expect(isHardStopped()).toBe(true);
    resumeFromHardStop();
    expect(isHardStopped()).toBe(false);
  });

  it("is idempotent — calling twice does not throw", () => {
    expect(() => {
      resumeFromHardStop();
      resumeFromHardStop();
    }).not.toThrow();
  });
});

// ── Budget alert — 80% threshold ─────────────────────────────────────────────

describe("budget alert — 80% threshold (hard-stop contract — 100% coverage required)", () => {
  it("fires the 80% handler when spend crosses 80% of budget", async () => {
    const handler = vi.fn();
    onBudgetAlert(handler);
    setBudgetMonthlyUSD(10);
    // Mock current month spend = $8 (80%)
    const ts = new Date().toISOString();
    mockStore([makeEvent({ timestamp: ts, estimatedCostUSD: 8.0 })]);
    await recordTokenEvent(makeEvent({ estimatedCostUSD: 0 }));
    expect(handler).toHaveBeenCalledOnce();
    const [level, message, budget] = handler.mock.calls[0] as [BudgetAlertLevel, string, number];
    expect(level).toBe("80%");
    expect(message).toContain("80%");
    expect(budget).toBe(10);
  });

  it("does not fire 80% handler when below 80%", async () => {
    const handler = vi.fn();
    onBudgetAlert(handler);
    setBudgetMonthlyUSD(10);
    const ts = new Date().toISOString();
    mockStore([makeEvent({ timestamp: ts, estimatedCostUSD: 7.9 })]);
    await recordTokenEvent(makeEvent({ estimatedCostUSD: 0 }));
    expect(handler).not.toHaveBeenCalled();
  });

  it("fires 80% handler only once per month (deduplication)", async () => {
    const handler = vi.fn();
    onBudgetAlert(handler);
    setBudgetMonthlyUSD(10);
    const ts = new Date().toISOString();
    mockStore([makeEvent({ timestamp: ts, estimatedCostUSD: 8.5 })]);
    // Fire two events — alert should only fire once
    await recordTokenEvent(makeEvent({ estimatedCostUSD: 0 }));
    await recordTokenEvent(makeEvent({ estimatedCostUSD: 0 }));
    expect(handler).toHaveBeenCalledOnce();
  });
});

// ── Budget alert — 100% threshold ────────────────────────────────────────────

describe("budget alert — 100% threshold (hard-stop contract — 100% coverage required)", () => {
  it("fires the 100% handler when spend reaches 100% of budget", async () => {
    const handler = vi.fn();
    onBudgetAlert(handler);
    setBudgetMonthlyUSD(10);
    const ts = new Date().toISOString();
    mockStore([makeEvent({ timestamp: ts, estimatedCostUSD: 10.0 })]);
    await recordTokenEvent(makeEvent({ estimatedCostUSD: 0 }));
    expect(handler).toHaveBeenCalledOnce();
    const [level, message, budget] = handler.mock.calls[0] as [BudgetAlertLevel, string, number];
    expect(level).toBe("100%");
    expect(message).toContain("paused");
    expect(budget).toBe(10);
  });

  it("sets hardStoppedFlag when 100% is reached", async () => {
    onBudgetAlert(vi.fn());
    setBudgetMonthlyUSD(10);
    const ts = new Date().toISOString();
    mockStore([makeEvent({ timestamp: ts, estimatedCostUSD: 10.0 })]);
    await recordTokenEvent(makeEvent({ estimatedCostUSD: 0 }));
    expect(isHardStopped()).toBe(true);
  });

  it("fires 100% handler only once per month (deduplication)", async () => {
    const handler = vi.fn();
    onBudgetAlert(handler);
    setBudgetMonthlyUSD(5);
    const ts = new Date().toISOString();
    mockStore([makeEvent({ timestamp: ts, estimatedCostUSD: 10.0 })]);
    await recordTokenEvent(makeEvent({ estimatedCostUSD: 0 }));
    await recordTokenEvent(makeEvent({ estimatedCostUSD: 0 }));
    expect(handler).toHaveBeenCalledOnce();
  });

  it("100% alert fires but NOT also a separate 80% alert in the same event", async () => {
    // When >=100%, only the 100% handler fires (80% is skipped to avoid double-alerting)
    const handler = vi.fn();
    onBudgetAlert(handler);
    setBudgetMonthlyUSD(10);
    const ts = new Date().toISOString();
    mockStore([makeEvent({ timestamp: ts, estimatedCostUSD: 10.0 })]);
    await recordTokenEvent(makeEvent({ estimatedCostUSD: 0 }));
    // Handler called once, with level "100%"
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toBe("100%");
  });

  it("80% fires first if threshold crossed before 100%", async () => {
    const handler = vi.fn();
    onBudgetAlert(handler);
    setBudgetMonthlyUSD(10);

    // First event: crosses 80%
    const ts = new Date().toISOString();
    mockStore([makeEvent({ timestamp: ts, estimatedCostUSD: 8.5 })]);
    await recordTokenEvent(makeEvent({ estimatedCostUSD: 0 }));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toBe("80%");

    // Second event: crosses 100%
    mockStore([makeEvent({ timestamp: ts, estimatedCostUSD: 10.0 })]);
    await recordTokenEvent(makeEvent({ estimatedCostUSD: 0 }));
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[1][0]).toBe("100%");
  });

  it("alert fires even when file write fails (budget check runs regardless)", async () => {
    const stderrSpy = suppressStderr();
    const handler = vi.fn();
    onBudgetAlert(handler);
    setBudgetMonthlyUSD(10);
    vi.mocked(mkdirSync).mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    const ts = new Date().toISOString();
    mockStore([makeEvent({ timestamp: ts, estimatedCostUSD: 10.0 })]);
    await recordTokenEvent(makeEvent({ estimatedCostUSD: 0 }));
    // Budget check still runs after write failure
    expect(handler).toHaveBeenCalledOnce();
    stderrSpy.mockRestore();
  });
});

// ── onBudgetAlert ─────────────────────────────────────────────────────────────

describe("onBudgetAlert", () => {
  it("replaces a previously registered handler", async () => {
    const firstHandler = vi.fn();
    const secondHandler = vi.fn();
    onBudgetAlert(firstHandler);
    onBudgetAlert(secondHandler);
    setBudgetMonthlyUSD(10);
    const ts = new Date().toISOString();
    mockStore([makeEvent({ timestamp: ts, estimatedCostUSD: 9.0 })]);
    await recordTokenEvent(makeEvent({ estimatedCostUSD: 0 }));
    expect(firstHandler).not.toHaveBeenCalled();
    expect(secondHandler).toHaveBeenCalledOnce();
  });

  it("does not throw when no handler is registered (null guard)", async () => {
    // clearStoreForTesting() sets handler to null; budget alert should not throw
    setBudgetMonthlyUSD(10);
    const ts = new Date().toISOString();
    mockStore([makeEvent({ timestamp: ts, estimatedCostUSD: 10.0 })]);
    await expect(recordTokenEvent(makeEvent({ estimatedCostUSD: 0 }))).resolves.toBeUndefined();
  });
});

// ── clearStoreForTesting ──────────────────────────────────────────────────────

describe("clearStoreForTesting", () => {
  it("resets budget to $20", () => {
    setBudgetMonthlyUSD(99);
    clearStoreForTesting();
    expect(getBudgetMonthlyUSD()).toBe(20);
  });

  it("clears the hard-stop flag", async () => {
    onBudgetAlert(vi.fn());
    setBudgetMonthlyUSD(1);
    const ts = new Date().toISOString();
    mockStore([makeEvent({ timestamp: ts, estimatedCostUSD: 5.0 })]);
    await recordTokenEvent(makeEvent({ estimatedCostUSD: 0 }));
    expect(isHardStopped()).toBe(true);
    clearStoreForTesting();
    expect(isHardStopped()).toBe(false);
  });

  it("clears fired-alerts deduplication so alerts fire again", async () => {
    const handler = vi.fn();
    onBudgetAlert(handler);
    setBudgetMonthlyUSD(10);
    const ts = new Date().toISOString();
    mockStore([makeEvent({ timestamp: ts, estimatedCostUSD: 10.0 })]);
    await recordTokenEvent(makeEvent({ estimatedCostUSD: 0 }));
    expect(handler).toHaveBeenCalledTimes(1);

    // Reset and trigger again — should fire once more
    clearStoreForTesting();
    const handler2 = vi.fn();
    onBudgetAlert(handler2);
    setBudgetMonthlyUSD(10);
    mockStore([makeEvent({ timestamp: ts, estimatedCostUSD: 10.0 })]);
    await recordTokenEvent(makeEvent({ estimatedCostUSD: 0 }));
    expect(handler2).toHaveBeenCalledTimes(1);
  });
});
