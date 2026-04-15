/**
 * Unit tests for the email-calendar skill.
 *
 * Uses createEmailCalendarSkill() to inject mock adapters — no real API calls.
 * Tests: triage, draft-reply, confirm-send, get-events, schedule-event,
 *        daily-briefing, undo, 90-day cap, validation, error propagation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Module mocks ─────────────────────────────────────────────────────────────

// Audit logger: prevent disk writes in unit tests
vi.mock("../../../security/audit-logger.ts", () => ({
  writeAuditEntry: vi.fn(),
}));

// Skill registry: prevent duplicate registration errors across test re-imports
vi.mock("../../../lib/skill-registry.ts", () => ({
  registerSkill: vi.fn(),
}));

// Undo registry: use real implementation (we test undo behaviour)
// Import undo module after other mocks to get its real functions.

// ── Imports ───────────────────────────────────────────────────────────────────

import { writeAuditEntry } from "../../../security/audit-logger.ts";
import { createEmailCalendarSkill } from "../../../skills/email-calendar/index.ts";
import type {
  CalendarEvent,
  EmailDraft,
  EmailMessage,
  IEmailCalendarAdapter,
} from "../../../skills/email-calendar/types.ts";
import { clearUndoForTesting, getCurrentUndo } from "../../../undo/registry.ts";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeEmail(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    id: "msg-1",
    threadId: "thread-1",
    from: "alice@example.com",
    to: ["me@example.com"],
    subject: "Hello",
    snippet: "Hi there",
    body: "Hi there, long form",
    date: new Date().toISOString(),
    isRead: false,
    ...overrides,
  };
}

function makeDraft(overrides: Partial<EmailDraft> = {}): EmailDraft {
  return {
    id: "draft-1",
    to: "bob@example.com",
    subject: "Re: Hello",
    body: "Thanks for reaching out.",
    replyToThreadId: "thread-1",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "event-1",
    title: "Team standup",
    startTime: new Date(Date.now() + 3_600_000).toISOString(),
    endTime: new Date(Date.now() + 7_200_000).toISOString(),
    location: "Zoom",
    ...overrides,
  };
}

// ── Mock adapter factory ──────────────────────────────────────────────────────

function makeMockAdapter(overrides: Partial<IEmailCalendarAdapter> = {}): IEmailCalendarAdapter {
  return {
    getUnreadEmails: vi.fn(async () => []),
    createDraft: vi.fn(async () => makeDraft()),
    sendDraft: vi.fn(async () => {}),
    deleteDraft: vi.fn(async () => {}),
    getEvents: vi.fn(async () => []),
    createEvent: vi.fn(async () => makeEvent()),
    ...overrides,
  };
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  clearUndoForTesting();
});

afterEach(() => {
  clearUndoForTesting();
});

// ── triage ────────────────────────────────────────────────────────────────────

describe("triage", () => {
  it("returns success with email list when emails exist", async () => {
    const email = makeEmail();
    const adapter = makeMockAdapter({ getUnreadEmails: vi.fn(async () => [email]) });
    const { run } = createEmailCalendarSkill(adapter);

    const result = await run({ action: "triage" });

    expect(result.success).toBe(true);
    expect(result.message).toMatch(/1 unread email/);
    expect((result.data as { emails: EmailMessage[] }).emails).toHaveLength(1);
  });

  it("returns success with zero-state message when inbox is empty", async () => {
    const adapter = makeMockAdapter({ getUnreadEmails: vi.fn(async () => []) });
    const { run } = createEmailCalendarSkill(adapter);

    const result = await run({ action: "triage" });

    expect(result.success).toBe(true);
    expect(result.message).toMatch(/No unread email/);
  });

  it("passes maxDays to the adapter", async () => {
    const adapter = makeMockAdapter();
    const { run } = createEmailCalendarSkill(adapter);

    await run({ action: "triage", maxDays: 14 });

    expect(adapter.getUnreadEmails).toHaveBeenCalledWith(14);
  });

  it("caps maxDays at 90 regardless of input", async () => {
    const adapter = makeMockAdapter();
    const { run } = createEmailCalendarSkill(adapter);

    await run({ action: "triage", maxDays: 999 });

    expect(adapter.getUnreadEmails).toHaveBeenCalledWith(90);
  });

  it("defaults maxDays to 7 when not provided", async () => {
    const adapter = makeMockAdapter();
    const { run } = createEmailCalendarSkill(adapter);

    await run({ action: "triage" });

    expect(adapter.getUnreadEmails).toHaveBeenCalledWith(7);
  });

  it("returns multiple emails", async () => {
    const emails = [makeEmail({ id: "a" }), makeEmail({ id: "b" }), makeEmail({ id: "c" })];
    const adapter = makeMockAdapter({ getUnreadEmails: vi.fn(async () => emails) });
    const { run } = createEmailCalendarSkill(adapter);

    const result = await run({ action: "triage" });
    expect((result.data as { emails: EmailMessage[] }).emails).toHaveLength(3);
    expect(result.message).toMatch(/3 unread emails/);
  });

  it("returns success:false and message when adapter throws", async () => {
    const adapter = makeMockAdapter({
      getUnreadEmails: vi.fn(async () => {
        throw new Error("OAuth expired");
      }),
    });
    const { run } = createEmailCalendarSkill(adapter);

    const result = await run({ action: "triage" });

    expect(result.success).toBe(false);
    expect(result.message).toContain("OAuth expired");
  });

  it("writes an audit log entry", async () => {
    const adapter = makeMockAdapter();
    const { run } = createEmailCalendarSkill(adapter);

    await run({ action: "triage" });

    expect(writeAuditEntry).toHaveBeenCalledOnce();
    const entry = vi.mocked(writeAuditEntry).mock.calls[0][0];
    expect(entry.skill).toBe("email-calendar");
    expect(entry.outcome).toBe("success");
  });
});

// ── draft-reply ───────────────────────────────────────────────────────────────

describe("draft-reply", () => {
  it("creates a draft and returns pendingDraft", async () => {
    const draft = makeDraft();
    const adapter = makeMockAdapter({ createDraft: vi.fn(async () => draft) });
    const { run } = createEmailCalendarSkill(adapter);

    const result = await run({
      action: "draft-reply",
      to: "bob@example.com",
      subject: "Re: Hello",
      body: "Thanks!",
    });

    expect(result.success).toBe(true);
    expect(result.pendingDraft).toEqual(draft);
    expect(adapter.createDraft).toHaveBeenCalledWith(
      "bob@example.com",
      "Re: Hello",
      "Thanks!",
      undefined,
    );
  });

  it("passes replyToThreadId to the adapter", async () => {
    const adapter = makeMockAdapter();
    const { run } = createEmailCalendarSkill(adapter);

    await run({
      action: "draft-reply",
      to: "bob@example.com",
      subject: "Re: Test",
      body: "Body",
      replyToThreadId: "thread-42",
    });

    expect(adapter.createDraft).toHaveBeenCalledWith(
      "bob@example.com",
      "Re: Test",
      "Body",
      "thread-42",
    );
  });

  it("registers an undo entry after creating the draft", async () => {
    const draft = makeDraft({ id: "draft-undo-test" });
    const adapter = makeMockAdapter({ createDraft: vi.fn(async () => draft) });
    const { run } = createEmailCalendarSkill(adapter);

    await run({ action: "draft-reply", to: "x@y.com", subject: "S", body: "B" });

    const entry = getCurrentUndo();
    expect(entry).not.toBeNull();
    expect(entry?.actionType).toBe("email-draft");
    expect(entry?.skill).toBe("email-calendar");
    expect(entry?.snapshot).toEqual({ draft });
  });

  it("fails when 'to' is missing", async () => {
    const adapter = makeMockAdapter();
    const { run } = createEmailCalendarSkill(adapter);

    const result = await run({ action: "draft-reply", subject: "S", body: "B" });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/to/i);
    expect(adapter.createDraft).not.toHaveBeenCalled();
  });

  it("fails when 'subject' is missing", async () => {
    const adapter = makeMockAdapter();
    const { run } = createEmailCalendarSkill(adapter);

    const result = await run({ action: "draft-reply", to: "x@y.com", body: "B" });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/subject/i);
  });

  it("fails when 'body' is missing", async () => {
    const adapter = makeMockAdapter();
    const { run } = createEmailCalendarSkill(adapter);

    const result = await run({ action: "draft-reply", to: "x@y.com", subject: "S" });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/body/i);
  });

  it("does NOT send the email — only creates the draft", async () => {
    const adapter = makeMockAdapter();
    const { run } = createEmailCalendarSkill(adapter);

    await run({ action: "draft-reply", to: "x@y.com", subject: "S", body: "B" });

    expect(adapter.sendDraft).not.toHaveBeenCalled();
  });

  it("message says 'Awaiting your confirmation'", async () => {
    const adapter = makeMockAdapter();
    const { run } = createEmailCalendarSkill(adapter);

    const result = await run({ action: "draft-reply", to: "x@y.com", subject: "S", body: "B" });

    expect(result.message).toMatch(/awaiting your confirmation/i);
  });
});

// ── confirm-send ──────────────────────────────────────────────────────────────

describe("confirm-send", () => {
  it("sends the draft when confirmed:true", async () => {
    const adapter = makeMockAdapter();
    const { run } = createEmailCalendarSkill(adapter);

    const result = await run({
      action: "confirm-send",
      draftId: "draft-1",
      confirmed: true,
    });

    expect(result.success).toBe(true);
    expect(adapter.sendDraft).toHaveBeenCalledWith("draft-1");
  });

  it("NEVER sends without confirmed:true", async () => {
    const adapter = makeMockAdapter();
    const { run } = createEmailCalendarSkill(adapter);

    const result = await run({ action: "confirm-send", draftId: "draft-1" });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/confirmed:true/);
    expect(adapter.sendDraft).not.toHaveBeenCalled();
  });

  it("rejects confirmed:false explicitly", async () => {
    const adapter = makeMockAdapter();
    const { run } = createEmailCalendarSkill(adapter);

    const result = await run({
      action: "confirm-send",
      draftId: "draft-1",
      confirmed: false,
    });

    expect(result.success).toBe(false);
    expect(adapter.sendDraft).not.toHaveBeenCalled();
  });

  it("fails when draftId is missing", async () => {
    const adapter = makeMockAdapter();
    const { run } = createEmailCalendarSkill(adapter);

    const result = await run({ action: "confirm-send", confirmed: true });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/draftId/i);
    expect(adapter.sendDraft).not.toHaveBeenCalled();
  });

  it("returns success:false when sendDraft throws", async () => {
    const adapter = makeMockAdapter({
      sendDraft: vi.fn(async () => {
        throw new Error("Network error");
      }),
    });
    const { run } = createEmailCalendarSkill(adapter);

    const result = await run({
      action: "confirm-send",
      draftId: "draft-1",
      confirmed: true,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("Network error");
  });

  it("writes an audit entry with outcome 'success' on send", async () => {
    const adapter = makeMockAdapter();
    const { run } = createEmailCalendarSkill(adapter);

    await run({ action: "confirm-send", draftId: "d1", confirmed: true });

    const entry = vi.mocked(writeAuditEntry).mock.calls[0][0];
    expect(entry.outcome).toBe("success");
    expect(entry.skill).toBe("email-calendar");
  });
});

// ── undo ──────────────────────────────────────────────────────────────────────

describe("undo (email-draft)", () => {
  it("undo calls deleteDraft with the correct id", async () => {
    const draft = makeDraft({ id: "draft-to-delete" });
    const adapter = makeMockAdapter({ createDraft: vi.fn(async () => draft) });
    const { run } = createEmailCalendarSkill(adapter);

    // Create draft to register the undo entry
    await run({ action: "draft-reply", to: "x@y.com", subject: "S", body: "B" });

    // Execute the undo entry directly
    const entry = getCurrentUndo();
    expect(entry).not.toBeNull();
    await entry!.undoFn();

    expect(adapter.deleteDraft).toHaveBeenCalledWith("draft-to-delete");
  });

  it("undo is idempotent — calling twice does not throw", async () => {
    const adapter = makeMockAdapter({
      deleteDraft: vi.fn(async () => {}),
    });
    const { run } = createEmailCalendarSkill(adapter);

    await run({ action: "draft-reply", to: "x@y.com", subject: "S", body: "B" });

    const entry = getCurrentUndo();
    await entry!.undoFn();
    await expect(entry!.undoFn()).resolves.not.toThrow();
  });

  it("undo does not call sendDraft", async () => {
    const adapter = makeMockAdapter();
    const { run } = createEmailCalendarSkill(adapter);

    await run({ action: "draft-reply", to: "x@y.com", subject: "S", body: "B" });
    const entry = getCurrentUndo();
    await entry!.undoFn();

    expect(adapter.sendDraft).not.toHaveBeenCalled();
  });

  it("undo is registered as 'email-draft' action type", async () => {
    const adapter = makeMockAdapter();
    const { run } = createEmailCalendarSkill(adapter);

    await run({ action: "draft-reply", to: "x@y.com", subject: "S", body: "B" });

    expect(getCurrentUndo()?.actionType).toBe("email-draft");
  });

  it("undo snapshot contains the draft", async () => {
    const draft = makeDraft({ id: "snap-draft", subject: "Snapshot test" });
    const adapter = makeMockAdapter({ createDraft: vi.fn(async () => draft) });
    const { run } = createEmailCalendarSkill(adapter);

    await run({ action: "draft-reply", to: "x@y.com", subject: "Snapshot test", body: "B" });

    const snapshot = getCurrentUndo()?.snapshot as { draft: EmailDraft };
    expect(snapshot.draft.id).toBe("snap-draft");
    expect(snapshot.draft.subject).toBe("Snapshot test");
  });
});

// ── get-events ────────────────────────────────────────────────────────────────

describe("get-events", () => {
  it("returns events from the adapter", async () => {
    const event = makeEvent();
    const adapter = makeMockAdapter({ getEvents: vi.fn(async () => [event]) });
    const { run } = createEmailCalendarSkill(adapter);

    const result = await run({ action: "get-events" });

    expect(result.success).toBe(true);
    expect((result.data as { events: CalendarEvent[] }).events).toHaveLength(1);
    expect(result.message).toMatch(/1 event/);
  });

  it("passes startDate and endDate to adapter", async () => {
    const adapter = makeMockAdapter();
    const { run } = createEmailCalendarSkill(adapter);
    const start = "2026-03-17T00:00:00.000Z";
    const end = "2026-03-24T00:00:00.000Z";

    await run({ action: "get-events", startDate: start, endDate: end });

    expect(adapter.getEvents).toHaveBeenCalledWith(start, end);
  });

  it("defaults endDate to 7 days after startDate when not provided", async () => {
    const adapter = makeMockAdapter();
    const { run } = createEmailCalendarSkill(adapter);

    await run({ action: "get-events" });

    const [start, end] = vi.mocked(adapter.getEvents).mock.calls[0] as [string, string];
    const diffMs = new Date(end).getTime() - new Date(start).getTime();
    expect(diffMs).toBeCloseTo(7 * 86_400_000, -4); // within a few ms
  });

  it("returns zero-state message when no events", async () => {
    const adapter = makeMockAdapter({ getEvents: vi.fn(async () => []) });
    const { run } = createEmailCalendarSkill(adapter);

    const result = await run({ action: "get-events" });

    expect(result.success).toBe(true);
    expect(result.message).toMatch(/No calendar events/);
  });
});

// ── schedule-event ────────────────────────────────────────────────────────────

describe("schedule-event", () => {
  it("creates an event and returns it", async () => {
    const event = makeEvent({ id: "new-event", title: "Dentist" });
    const adapter = makeMockAdapter({ createEvent: vi.fn(async () => event) });
    const { run } = createEmailCalendarSkill(adapter);

    const result = await run({
      action: "schedule-event",
      eventTitle: "Dentist",
      eventStart: "2026-03-20T10:00:00Z",
      eventEnd: "2026-03-20T11:00:00Z",
    });

    expect(result.success).toBe(true);
    expect((result.data as { event: CalendarEvent }).event.id).toBe("new-event");
    expect(adapter.createEvent).toHaveBeenCalledWith(expect.objectContaining({ title: "Dentist" }));
  });

  it("fails when eventTitle is missing", async () => {
    const adapter = makeMockAdapter();
    const { run } = createEmailCalendarSkill(adapter);

    const result = await run({
      action: "schedule-event",
      eventStart: "2026-03-20T10:00:00Z",
      eventEnd: "2026-03-20T11:00:00Z",
    });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/eventTitle/);
    expect(adapter.createEvent).not.toHaveBeenCalled();
  });

  it("fails when eventStart is missing", async () => {
    const adapter = makeMockAdapter();
    const { run } = createEmailCalendarSkill(adapter);

    const result = await run({
      action: "schedule-event",
      eventTitle: "Test",
      eventEnd: "2026-03-20T11:00:00Z",
    });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/eventStart/);
  });

  it("fails when eventEnd is missing", async () => {
    const adapter = makeMockAdapter();
    const { run } = createEmailCalendarSkill(adapter);

    const result = await run({
      action: "schedule-event",
      eventTitle: "Test",
      eventStart: "2026-03-20T10:00:00Z",
    });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/eventEnd/);
  });

  it("passes optional location and description", async () => {
    const adapter = makeMockAdapter();
    const { run } = createEmailCalendarSkill(adapter);

    await run({
      action: "schedule-event",
      eventTitle: "Lunch",
      eventStart: "2026-03-20T12:00:00Z",
      eventEnd: "2026-03-20T13:00:00Z",
      eventLocation: "Nobu",
      eventDescription: "Client lunch",
    });

    expect(adapter.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({ location: "Nobu", description: "Client lunch" }),
    );
  });
});

// ── daily-briefing ────────────────────────────────────────────────────────────

describe("daily-briefing", () => {
  it("returns both emails and events", async () => {
    const adapter = makeMockAdapter({
      getUnreadEmails: vi.fn(async () => [makeEmail()]),
      getEvents: vi.fn(async () => [makeEvent()]),
    });
    const { run } = createEmailCalendarSkill(adapter);

    const result = await run({ action: "daily-briefing" });

    expect(result.success).toBe(true);
    const data = result.data as { emails: EmailMessage[]; events: CalendarEvent[] };
    expect(data.emails).toHaveLength(1);
    expect(data.events).toHaveLength(1);
    expect(result.message).toMatch(/1 unread email/);
    expect(result.message).toMatch(/1 event/);
  });

  it("fetches emails and events in parallel (both adapters called)", async () => {
    const adapter = makeMockAdapter();
    const { run } = createEmailCalendarSkill(adapter);

    await run({ action: "daily-briefing" });

    expect(adapter.getUnreadEmails).toHaveBeenCalledOnce();
    expect(adapter.getEvents).toHaveBeenCalledOnce();
  });

  it("caps maxDays at 90", async () => {
    const adapter = makeMockAdapter();
    const { run } = createEmailCalendarSkill(adapter);

    await run({ action: "daily-briefing", maxDays: 200 });

    expect(adapter.getUnreadEmails).toHaveBeenCalledWith(90);
  });

  it("defaults maxDays to 1", async () => {
    const adapter = makeMockAdapter();
    const { run } = createEmailCalendarSkill(adapter);

    await run({ action: "daily-briefing" });

    expect(adapter.getUnreadEmails).toHaveBeenCalledWith(1);
  });

  it("includes a date field in data", async () => {
    const adapter = makeMockAdapter();
    const { run } = createEmailCalendarSkill(adapter);

    const result = await run({ action: "daily-briefing" });
    const data = result.data as { date: string };
    expect(data.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ── audit logging ─────────────────────────────────────────────────────────────

describe("audit logging", () => {
  it("logs outcome:error when adapter throws", async () => {
    const adapter = makeMockAdapter({
      getUnreadEmails: vi.fn(async () => {
        throw new Error("connection refused");
      }),
    });
    const { run } = createEmailCalendarSkill(adapter);

    await run({ action: "triage" });

    const entry = vi.mocked(writeAuditEntry).mock.calls[0][0];
    expect(entry.outcome).toBe("error");
  });

  it("logs the correct permission manifest", async () => {
    const adapter = makeMockAdapter();
    const { run } = createEmailCalendarSkill(adapter);

    await run({ action: "triage" });

    const entry = vi.mocked(writeAuditEntry).mock.calls[0][0];
    expect(entry.permissionsUsed).toContain("read:email");
    expect(entry.permissionsUsed).toContain("read:calendar");
  });

  it("always writes exactly one audit entry per run() call", async () => {
    const adapter = makeMockAdapter();
    const { run } = createEmailCalendarSkill(adapter);

    await run({ action: "triage" });
    await run({ action: "get-events" });

    expect(writeAuditEntry).toHaveBeenCalledTimes(2);
  });
});

// ── resolveAdapter ────────────────────────────────────────────────────────────

describe("resolveAdapter", () => {
  it("throws when no provider is configured", async () => {
    const { resolveAdapter } = await import("../../../skills/email-calendar/index.ts");
    const saved = { ...process.env };
    delete process.env["GOOGLE_OAUTH_CLIENT_ID"];
    delete process.env["MICROSOFT_OAUTH_CLIENT_ID"];

    expect(() => resolveAdapter()).toThrow(/No email provider configured/);

    Object.assign(process.env, saved);
  });

  it("returns GmailAdapter when GOOGLE_OAUTH_CLIENT_ID is set", async () => {
    const { resolveAdapter } = await import("../../../skills/email-calendar/index.ts");
    const { GmailAdapter } = await import("../../../skills/email-calendar/adapters/gmail.ts");
    process.env["GOOGLE_OAUTH_CLIENT_ID"] = "test-client-id";

    const adapter = resolveAdapter();
    expect(adapter).toBeInstanceOf(GmailAdapter);

    delete process.env["GOOGLE_OAUTH_CLIENT_ID"];
  });

  it("returns OutlookAdapter when MICROSOFT_OAUTH_CLIENT_ID is set", async () => {
    const { resolveAdapter } = await import("../../../skills/email-calendar/index.ts");
    const { OutlookAdapter } = await import("../../../skills/email-calendar/adapters/outlook.ts");
    delete process.env["GOOGLE_OAUTH_CLIENT_ID"];
    process.env["MICROSOFT_OAUTH_CLIENT_ID"] = "test-client-id";

    const adapter = resolveAdapter();
    expect(adapter).toBeInstanceOf(OutlookAdapter);

    delete process.env["MICROSOFT_OAUTH_CLIENT_ID"];
  });
});
