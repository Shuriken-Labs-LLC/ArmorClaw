/**
 * Shared types for the email-calendar skill and its provider adapters.
 */

// ── Domain types ──────────────────────────────────────────────────────────────

/** An email message as returned by any provider adapter. */
export interface EmailMessage {
  id: string;
  threadId: string;
  from: string;
  to: string[];
  subject: string;
  /** Short preview text (no markup). */
  snippet: string;
  /** Full plain-text body. */
  body: string;
  /** ISO 8601. */
  date: string;
  isRead: boolean;
}

/** A draft email awaiting user confirmation before being sent. */
export interface EmailDraft {
  id: string;
  to: string;
  subject: string;
  body: string;
  replyToThreadId?: string;
  /** ISO 8601. */
  createdAt: string;
}

/** A calendar event. */
export interface CalendarEvent {
  id: string;
  title: string;
  /** ISO 8601 datetime. */
  startTime: string;
  /** ISO 8601 datetime. */
  endTime: string;
  location?: string;
  description?: string;
  attendees?: string[];
}

// ── Adapter interface ─────────────────────────────────────────────────────────

/**
 * Provider-agnostic interface that every email+calendar adapter must implement.
 * Skills call this interface — they never import provider SDKs directly.
 */
export interface IEmailCalendarAdapter {
  /**
   * Fetch unread messages from the last `maxDays` calendar days (max 90).
   * Implementations must not return messages older than 90 days regardless
   * of the requested `maxDays`.
   */
  getUnreadEmails(maxDays?: number): Promise<EmailMessage[]>;

  /**
   * Save an email draft via the provider API.
   * Returns the saved draft with a provider-assigned id.
   * Must NOT send the message — sending is a separate step after user confirmation.
   */
  createDraft(
    to: string,
    subject: string,
    body: string,
    replyToThreadId?: string,
  ): Promise<EmailDraft>;

  /**
   * Send a previously saved draft via the provider API.
   *
   * ⚠️  This method must only be called after the user has given explicit
   * confirmation. Never call this from the skill layer without checking
   * `input.confirmed === true` first.
   */
  sendDraft(draftId: string): Promise<void>;

  /**
   * Permanently delete / discard a draft.
   * Called by the undo function to cancel a pending draft before it is sent.
   * Must be idempotent — silently succeed if the draft no longer exists.
   */
  deleteDraft(draftId: string): Promise<void>;

  /** Retrieve calendar events within the given UTC time range. */
  getEvents(startTime: string, endTime: string): Promise<CalendarEvent[]>;

  /**
   * Create a new calendar event.
   * Returns the event as stored by the provider (with a provider-assigned id).
   */
  createEvent(event: Omit<CalendarEvent, "id">): Promise<CalendarEvent>;
}

// ── Skill I/O ──────────────────────────────────────────────────────────────────

export type EmailCalendarAction =
  | "triage" //          summarise unread email, flag action items
  | "draft-reply" //     create draft → return for user confirmation (never auto-send)
  | "confirm-send" //    user confirmed — actually send the pending draft
  | "get-events" //      list upcoming calendar events
  | "schedule-event" //  create a new calendar event
  | "daily-briefing"; // combined: events + email summary

export interface EmailCalendarInput {
  /** The operation this invocation should perform. */
  action: EmailCalendarAction;

  // ── triage / daily-briefing ──
  /** Days back to search for unread email. Default: 7. Hard max: 90. */
  maxDays?: number;

  // ── draft-reply ──
  /** Address of the recipient. */
  to?: string;
  /** Subject line. */
  subject?: string;
  /** Plain-text body of the reply. */
  body?: string;
  /** Provider thread id to reply within. */
  replyToThreadId?: string;

  // ── confirm-send ──
  /** Id of the pending draft to send. */
  draftId?: string;
  /**
   * Must be explicitly `true`.
   * Guards against accidental sends — skill rejects the call if this is not set.
   */
  confirmed?: boolean;

  // ── get-events / schedule-event ──
  /** ISO 8601 date. Defaults to now. */
  startDate?: string;
  /** ISO 8601 date. Defaults to 7 days after startDate. */
  endDate?: string;

  // ── schedule-event ──
  eventTitle?: string;
  /** ISO 8601 datetime. */
  eventStart?: string;
  /** ISO 8601 datetime. */
  eventEnd?: string;
  eventLocation?: string;
  eventDescription?: string;

  // ── provider selection ──
  /** When both Gmail and Outlook are configured, choose which to use. */
  provider?: "gmail" | "outlook";
}

export interface EmailCalendarOutput {
  success: boolean;
  message: string;
  /** Structured payload — shape depends on the action performed. */
  data?: unknown;
  /**
   * Present only when `action === 'draft-reply'`.
   * The draft has been saved to the provider and is awaiting the user's
   * explicit confirmation before sending.
   */
  pendingDraft?: EmailDraft;
}
