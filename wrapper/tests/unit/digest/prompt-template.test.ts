import { describe, expect, it } from "vitest";
import {
  type ActivityEntry,
  type CalendarEvent,
  type DigestInput,
  buildPrompt,
  formatActivity,
  formatUSD,
} from "../../../digest/prompt-template.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

function baseInput(overrides: Partial<DigestInput> = {}): DigestInput {
  return {
    date: "2026-03-17",
    yesterdayActivity: [{ displayName: "Lead scorer", actionCount: 3 }],
    pendingItems: [],
    calendarEvents: [],
    tokenYesterdayUSD: 0.12,
    tokenMonthToDateUSD: 6.82,
    monthlyBudgetUSD: 20,
    isQuiet: false,
    calendarUnavailable: false,
    ...overrides,
  };
}

// ── formatUSD ─────────────────────────────────────────────────────────────────

describe("formatUSD", () => {
  it("formats amounts under $1 to two decimal places", () => {
    expect(formatUSD(0.12)).toBe("$0.12");
    expect(formatUSD(0.0)).toBe("$0.00");
    expect(formatUSD(0.99)).toBe("$0.99");
  });

  it("rounds amounts of $1 or more to cents", () => {
    expect(formatUSD(1.0)).toBe("$1");
    expect(formatUSD(6.82)).toBe("$6.82");
    expect(formatUSD(20.0)).toBe("$20");
    expect(formatUSD(19.999)).toBe("$20");
  });

  it("handles large amounts correctly", () => {
    expect(formatUSD(100.5)).toBe("$100.5");
    expect(formatUSD(1000.0)).toBe("$1000");
  });
});

// ── formatActivity ────────────────────────────────────────────────────────────

describe("formatActivity", () => {
  it("returns empty string for empty activity list", () => {
    expect(formatActivity([])).toBe("");
  });

  it("formats a single skill correctly", () => {
    const result = formatActivity([{ displayName: "Lead scorer", actionCount: 1 }]);
    expect(result).toBe("1 action via Lead scorer");
  });

  it("pluralises action count > 1", () => {
    const result = formatActivity([{ displayName: "Email triage", actionCount: 5 }]);
    expect(result).toBe("5 actions via Email triage");
  });

  it("joins two skills with 'and'", () => {
    const activity: ActivityEntry[] = [
      { displayName: "Lead scorer", actionCount: 3 },
      { displayName: "Email triage", actionCount: 7 },
    ];
    const result = formatActivity(activity);
    expect(result).toContain("and");
    expect(result).toContain("Lead scorer");
    expect(result).toContain("Email triage");
  });

  it("joins three or more skills with Oxford comma and 'and'", () => {
    const activity: ActivityEntry[] = [
      { displayName: "Lead scorer", actionCount: 2 },
      { displayName: "Email triage", actionCount: 4 },
      { displayName: "File organiser", actionCount: 1 },
    ];
    const result = formatActivity(activity);
    expect(result).toContain(", and");
    expect(result).toContain("Lead scorer");
    expect(result).toContain("File organiser");
  });
});

// ── buildPrompt — structure ───────────────────────────────────────────────────

describe("buildPrompt — structural requirements", () => {
  it("returns a non-empty string", () => {
    expect(buildPrompt(baseInput()).length).toBeGreaterThan(0);
  });

  it("includes the date", () => {
    expect(buildPrompt(baseInput())).toContain("2026-03-17");
  });

  it("includes instructions to write 4–6 sentences", () => {
    const prompt = buildPrompt(baseInput());
    expect(prompt).toContain("4–6 sentences");
  });

  it("includes instruction to use first-person language", () => {
    const prompt = buildPrompt(baseInput());
    expect(prompt.toLowerCase()).toContain("first");
  });

  it("includes instruction to avoid bullet points and technical terms", () => {
    const prompt = buildPrompt(baseInput());
    expect(prompt).toContain("no bullet points");
  });

  it("includes token spend data", () => {
    const prompt = buildPrompt(baseInput({ tokenYesterdayUSD: 0.12, tokenMonthToDateUSD: 6.82 }));
    expect(prompt).toContain("$0.12");
    expect(prompt).toContain("$6.82");
  });

  it("includes monthly budget", () => {
    const prompt = buildPrompt(baseInput({ monthlyBudgetUSD: 20 }));
    expect(prompt).toContain("$20");
  });
});

// ── buildPrompt — activity section ────────────────────────────────────────────

describe("buildPrompt — activity section", () => {
  it("includes yesterday's skill activity when not quiet", () => {
    const prompt = buildPrompt(
      baseInput({ yesterdayActivity: [{ displayName: "Lead scorer", actionCount: 3 }] }),
    );
    expect(prompt).toContain("Lead scorer");
    expect(prompt).toContain("3 action");
  });

  it("shows idle message when isQuiet is true", () => {
    const prompt = buildPrompt(baseInput({ isQuiet: true, yesterdayActivity: [] }));
    expect(prompt).toContain("idle");
    expect(prompt).not.toContain("Lead scorer");
  });
});

// ── buildPrompt — pending items ────────────────────────────────────────────────

describe("buildPrompt — pending items", () => {
  it("shows 'none' when no pending items", () => {
    const prompt = buildPrompt(baseInput({ pendingItems: [] }));
    expect(prompt).toContain("none");
  });

  it("includes pending items when present", () => {
    const prompt = buildPrompt(baseInput({ pendingItems: ["1 email draft waiting for approval"] }));
    expect(prompt).toContain("email draft waiting");
  });

  it("joins multiple pending items with semicolons", () => {
    const prompt = buildPrompt(baseInput({ pendingItems: ["item one", "item two"] }));
    expect(prompt).toContain("item one; item two");
  });
});

// ── buildPrompt — calendar section ────────────────────────────────────────────

describe("buildPrompt — calendar section", () => {
  it("shows no-events message when calendar is empty and available", () => {
    const prompt = buildPrompt(baseInput({ calendarEvents: [], calendarUnavailable: false }));
    expect(prompt).toContain("no events scheduled");
  });

  it("shows reconnect message when calendar is unavailable", () => {
    const prompt = buildPrompt(baseInput({ calendarUnavailable: true }));
    expect(prompt).toContain("reconnect");
    expect(prompt).not.toContain("no events scheduled");
  });

  it("lists calendar events when present", () => {
    const events: CalendarEvent[] = [
      { time: "9:00am", title: "Standup" },
      { time: "2:00pm", title: "Client call" },
    ];
    const prompt = buildPrompt(baseInput({ calendarEvents: events }));
    expect(prompt).toContain("9:00am");
    expect(prompt).toContain("Standup");
    expect(prompt).toContain("Client call");
  });

  it("separates calendar events with semicolons", () => {
    const events: CalendarEvent[] = [
      { time: "9:00am", title: "Standup" },
      { time: "2:00pm", title: "Client call" },
    ];
    const prompt = buildPrompt(baseInput({ calendarEvents: events }));
    expect(prompt).toContain("; ");
  });
});

// ── buildPrompt — suggestion section ─────────────────────────────────────────

describe("buildPrompt — suggestion section", () => {
  it("omits suggestion section when suggestion is undefined", () => {
    const prompt = buildPrompt(baseInput({ suggestion: undefined }));
    expect(prompt).not.toContain("Suggestion:");
  });

  it("includes suggestion when provided", () => {
    const prompt = buildPrompt(
      baseInput({ suggestion: "You haven't reviewed leads in 5 days — want me to surface them?" }),
    );
    expect(prompt).toContain("Suggestion:");
    expect(prompt).toContain("leads in 5 days");
  });
});
