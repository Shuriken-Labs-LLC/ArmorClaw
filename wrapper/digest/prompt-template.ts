// ── Types ─────────────────────────────────────────────────────────────────────

export interface ActivityEntry {
  /** Human-readable skill name from the skill registry, e.g. "Lead scorer". */
  displayName: string;
  /** Number of successful and error actions run by this skill yesterday. */
  actionCount: number;
}

export interface CalendarEvent {
  /** Display time string, e.g. "9:00am". */
  time: string;
  /** Event title. */
  title: string;
}

export interface DigestInput {
  /** ISO date for yesterday: "YYYY-MM-DD". */
  date: string;
  /** Actions the agent took yesterday, grouped by skill. */
  yesterdayActivity: ActivityEntry[];
  /** Human-readable descriptions of items waiting for the user's attention. */
  pendingItems: string[];
  /** First 3 calendar events for today, ordered by time. */
  calendarEvents: CalendarEvent[];
  /** Yesterday's estimated AI API cost in USD. */
  tokenYesterdayUSD: number;
  /** Month-to-date estimated AI API cost in USD. */
  tokenMonthToDateUSD: number;
  /** User's configured monthly budget in USD. */
  monthlyBudgetUSD: number;
  /** Optional high-confidence suggestion based on usage patterns. */
  suggestion?: string;
  /** true when the agent was idle yesterday — shorter quiet-day message. */
  isQuiet: boolean;
  /** true when the calendar skill is unavailable (e.g. OAuth expired). */
  calendarUnavailable: boolean;
}

// ── Formatting helpers ────────────────────────────────────────────────────────

/** Format a USD amount using the display rules from CLAUDE.md. */
export function formatUSD(amount: number): string {
  if (amount < 1) {
    return `$${amount.toFixed(2)}`;
  }
  // Round to cents for amounts ≥ $1
  return `$${Math.round(amount * 100) / 100}`;
}

/** Pluralise a word with a simple -s rule. */
function plural(count: number, word: string): string {
  return count === 1 ? `${count} ${word}` : `${count} ${word}s`;
}

/** Convert an ActivityEntry array into a natural-language action summary. */
export function formatActivity(activity: ActivityEntry[]): string {
  if (activity.length === 0) {
    return "";
  }
  const parts = activity.map((a) => `${plural(a.actionCount, "action")} via ${a.displayName}`);
  if (parts.length === 1) {
    return parts[0];
  }
  if (parts.length === 2) {
    return `${parts[0]} and ${parts[1]}`;
  }
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

// ── Prompt template ───────────────────────────────────────────────────────────

/**
 * Build the model prompt for the daily digest.
 *
 * The returned string is handed directly to the model adapter. The model writes
 * a 4–6 sentence plain-English digest message using the structured data as
 * ground truth. Callers must not add extra instructions to this string.
 */
export function buildPrompt(input: DigestInput): string {
  const lines: string[] = [
    "You are ArmorClaw, a personal AI assistant. Write a brief, warm morning digest",
    "message for your user. Use first-person ('I did…', 'You have…'). Write in plain",
    "prose — no bullet points, no technical terms, no raw numbers like token counts or",
    "model names. The message must be 4–6 sentences. Never longer.",
    "",
    "Use only the data below. Do not invent facts.",
    "",
    "--- DATA ---",
    `Date: ${input.date}`,
  ];

  if (input.isQuiet) {
    lines.push("Yesterday: The agent was idle — no actions were taken.");
  } else {
    lines.push(`Yesterday's actions: ${formatActivity(input.yesterdayActivity)}`);
  }

  if (input.pendingItems.length > 0) {
    lines.push(`Pending items: ${input.pendingItems.join("; ")}`);
  } else {
    lines.push("Pending items: none");
  }

  if (input.calendarUnavailable) {
    lines.push("Calendar: unavailable — calendar skill needs reconnecting in settings");
  } else if (input.calendarEvents.length > 0) {
    const events = input.calendarEvents.map((e) => `${e.time} — ${e.title}`).join("; ");
    lines.push(`Today's calendar (first 3 events): ${events}`);
  } else {
    lines.push("Today's calendar: no events scheduled");
  }

  lines.push(
    `Token spend: yesterday ${formatUSD(input.tokenYesterdayUSD)}, ` +
      `month-to-date ${formatUSD(input.tokenMonthToDateUSD)} of ` +
      `${formatUSD(input.monthlyBudgetUSD)} budget`,
  );

  if (input.suggestion) {
    lines.push(`Suggestion: ${input.suggestion}`);
  }

  lines.push(
    "",
    "--- END DATA ---",
    "",
    "Write the digest message now. Remember: 4–6 sentences, warm and plain, first person.",
  );

  return lines.join("\n");
}
