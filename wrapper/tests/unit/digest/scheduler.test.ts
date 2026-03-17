import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the composer so the scheduler test doesn't hit real I/O
vi.mock("../../../digest/composer.ts", () => ({
  buildDigestData: vi.fn(),
}));

import { buildDigestData } from "../../../digest/composer.ts";
import {
  type CronFn,
  type SchedulerHandle,
  startDigestScheduler,
} from "../../../digest/scheduler.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * A synchronous fake cron function that captures the callback
 * and returns a controllable handle.
 */
function makeFakeCron() {
  let capturedExpression = "";
  let capturedTimezone = "";
  let capturedCallback: (() => void | Promise<void>) | null = null;
  const handle: SchedulerHandle = { stop: vi.fn() };

  const cronFn: CronFn = (expression, timezone, callback) => {
    capturedExpression = expression;
    capturedTimezone = timezone;
    capturedCallback = callback;
    return handle;
  };

  return {
    cronFn,
    handle,
    get expression() {
      return capturedExpression;
    },
    get timezone() {
      return capturedTimezone;
    },
    async trigger() {
      await capturedCallback?.();
    },
  };
}

// ── Isolation ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.mocked(buildDigestData).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── startDigestScheduler ──────────────────────────────────────────────────────

describe("startDigestScheduler — cron registration", () => {
  it("calls cronFn with the configured expression", () => {
    const fake = makeFakeCron();
    startDigestScheduler({
      getTimezone: () => "UTC",
      sendMessage: vi.fn().mockResolvedValue(undefined),
      schedule: "0 9 * * *",
      cronFn: fake.cronFn,
    });
    expect(fake.expression).toBe("0 9 * * *");
  });

  it("defaults to '0 8 * * *' when no schedule is provided", () => {
    const fake = makeFakeCron();
    startDigestScheduler({
      getTimezone: () => "UTC",
      sendMessage: vi.fn().mockResolvedValue(undefined),
      cronFn: fake.cronFn,
    });
    expect(fake.expression).toBe("0 8 * * *");
  });

  it("passes the timezone from getTimezone() to the cron function", () => {
    const fake = makeFakeCron();
    startDigestScheduler({
      getTimezone: () => "America/New_York",
      sendMessage: vi.fn().mockResolvedValue(undefined),
      cronFn: fake.cronFn,
    });
    expect(fake.timezone).toBe("America/New_York");
  });

  it("returns a handle with a stop() method", () => {
    const fake = makeFakeCron();
    const handle = startDigestScheduler({
      getTimezone: () => "UTC",
      sendMessage: vi.fn().mockResolvedValue(undefined),
      cronFn: fake.cronFn,
    });
    expect(typeof handle.stop).toBe("function");
  });

  it("stop() on the returned handle delegates to the cron handle", () => {
    const fake = makeFakeCron();
    const handle = startDigestScheduler({
      getTimezone: () => "UTC",
      sendMessage: vi.fn().mockResolvedValue(undefined),
      cronFn: fake.cronFn,
    });
    handle.stop();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(fake.handle.stop).toHaveBeenCalledOnce();
  });
});

describe("startDigestScheduler — timezone read", () => {
  it("reads timezone from getTimezone() at schedule time", () => {
    const fake = makeFakeCron();
    const getTimezone = vi.fn().mockReturnValue("Europe/London");
    startDigestScheduler({
      getTimezone,
      sendMessage: vi.fn().mockResolvedValue(undefined),
      cronFn: fake.cronFn,
    });
    expect(getTimezone).toHaveBeenCalled();
    expect(fake.timezone).toBe("Europe/London");
  });
});

describe("startDigestScheduler — on tick", () => {
  it("calls buildDigestData when the cron fires", async () => {
    vi.mocked(buildDigestData).mockReturnValue({
      input: {
        date: "2026-03-17",
        yesterdayActivity: [],
        pendingItems: [],
        calendarEvents: [],
        tokenYesterdayUSD: 0,
        tokenMonthToDateUSD: 0,
        monthlyBudgetUSD: 20,
        isQuiet: true,
        calendarUnavailable: false,
      },
      prompt: "Good morning!",
      isBudgetPaused: false,
    });

    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const fake = makeFakeCron();
    startDigestScheduler({
      getTimezone: () => "UTC",
      sendMessage,
      cronFn: fake.cronFn,
    });

    await fake.trigger();
    expect(buildDigestData).toHaveBeenCalledOnce();
  });

  it("sends the prompt from buildDigestData to sendMessage", async () => {
    vi.mocked(buildDigestData).mockReturnValue({
      input: {
        date: "2026-03-17",
        yesterdayActivity: [],
        pendingItems: [],
        calendarEvents: [],
        tokenYesterdayUSD: 0,
        tokenMonthToDateUSD: 0,
        monthlyBudgetUSD: 20,
        isQuiet: true,
        calendarUnavailable: false,
      },
      prompt: "The model prompt text",
      isBudgetPaused: false,
    });

    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const fake = makeFakeCron();
    startDigestScheduler({
      getTimezone: () => "UTC",
      sendMessage,
      cronFn: fake.cronFn,
    });

    await fake.trigger();
    expect(sendMessage).toHaveBeenCalledWith("The model prompt text");
  });

  it("sends the budget-paused message verbatim when isBudgetPaused is true", async () => {
    const PAUSED_MSG = "Your ArmorClaw budget is paused. Go to your dashboard to resume.";
    vi.mocked(buildDigestData).mockReturnValue({
      input: {
        date: "2026-03-17",
        yesterdayActivity: [],
        pendingItems: [],
        calendarEvents: [],
        tokenYesterdayUSD: 0,
        tokenMonthToDateUSD: 0,
        monthlyBudgetUSD: 20,
        isQuiet: true,
        calendarUnavailable: false,
      },
      prompt: PAUSED_MSG,
      isBudgetPaused: true,
    });

    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const fake = makeFakeCron();
    startDigestScheduler({
      getTimezone: () => "UTC",
      sendMessage,
      cronFn: fake.cronFn,
    });

    await fake.trigger();
    expect(sendMessage).toHaveBeenCalledWith(PAUSED_MSG);
  });
});
