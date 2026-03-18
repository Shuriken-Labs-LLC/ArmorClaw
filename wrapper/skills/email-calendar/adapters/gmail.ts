/**
 * Gmail + Google Calendar adapter for the email-calendar skill.
 *
 * Uses the Gmail REST API and Google Calendar API via gaxios.
 * OAuth access token is read from the system keychain via the credential store.
 * Never stores tokens in env vars, plaintext config, or log output.
 */

import { request } from "gaxios";
import { getCredential } from "../../../lib/credential-store.ts";
import type { CalendarEvent, EmailDraft, EmailMessage, IEmailCalendarAdapter } from "../types.ts";

// ── Constants ─────────────────────────────────────────────────────────────────

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const CAL_BASE = "https://www.googleapis.com/calendar/v3/calendars/primary";

const KEYCHAIN_SERVICE = "armorclaw-gmail";
const KEYCHAIN_ACCOUNT = "oauth-token";

const MAX_DAYS_HARD_CAP = 90;

// ── Internal resource shapes (partial) ───────────────────────────────────────

interface GmailHeader {
  name: string;
  value: string;
}

interface GmailPart {
  mimeType: string;
  body?: { data?: string };
  parts?: GmailPart[];
}

interface GmailMessageResource {
  id: string;
  threadId: string;
  snippet: string;
  payload?: {
    headers?: GmailHeader[];
    mimeType?: string;
    body?: { data?: string };
    parts?: GmailPart[];
  };
  internalDate?: string;
  labelIds?: string[];
}

interface GmailDraftResource {
  id: string;
  message?: { threadId?: string };
}

interface GCalDateTime {
  dateTime?: string;
  date?: string;
}

interface GCalAttendee {
  email: string;
}

interface GCalEventResource {
  id: string;
  summary?: string;
  location?: string;
  description?: string;
  start?: GCalDateTime;
  end?: GCalDateTime;
  attendees?: GCalAttendee[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function header(hdrs: GmailHeader[] | undefined, name: string): string {
  return hdrs?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function extractTextBody(part: GmailPart): string {
  if (part.mimeType === "text/plain" && part.body?.data) {
    return Buffer.from(part.body.data, "base64url").toString("utf-8");
  }
  for (const child of part.parts ?? []) {
    const text = extractTextBody(child);
    if (text) {
      return text;
    }
  }
  return "";
}

function parseGmailMessage(raw: GmailMessageResource): EmailMessage {
  const hdrs = raw.payload?.headers ?? [];
  const body = raw.payload ? extractTextBody(raw.payload as GmailPart) : "";
  const dateMs = raw.internalDate ? Number(raw.internalDate) : Date.now();

  return {
    id: raw.id,
    threadId: raw.threadId,
    from: header(hdrs, "from"),
    to: header(hdrs, "to")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    subject: header(hdrs, "subject"),
    snippet: raw.snippet ?? "",
    body,
    date: new Date(dateMs).toISOString(),
    isRead: !(raw.labelIds ?? []).includes("UNREAD"),
  };
}

function parseGCalEvent(raw: GCalEventResource): CalendarEvent {
  return {
    id: raw.id,
    title: raw.summary ?? "(no title)",
    startTime: raw.start?.dateTime ?? raw.start?.date ?? "",
    endTime: raw.end?.dateTime ?? raw.end?.date ?? "",
    location: raw.location,
    description: raw.description,
    attendees: (raw.attendees ?? []).map((a) => a.email),
  };
}

/**
 * Encode a plain email as a base64url-encoded RFC 2822 message.
 * Suitable for use with the Gmail drafts API.
 */
function encodeMimeMessage(to: string, subject: string, body: string): string {
  const lines = [
    `To: ${to}`,
    `Subject: ${subject}`,
    `Content-Type: text/plain; charset=utf-8`,
    `MIME-Version: 1.0`,
    ``,
    body,
  ];
  return Buffer.from(lines.join("\r\n")).toString("base64url");
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export class GmailAdapter implements IEmailCalendarAdapter {
  private async authHeader(): Promise<string> {
    const token = await getCredential(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
    if (!token) {
      throw new Error(
        "Gmail is not connected. Reconnect Gmail in Settings to use the email skill.",
      );
    }
    return `Bearer ${token}`;
  }

  async getUnreadEmails(maxDays = 7): Promise<EmailMessage[]> {
    const days = Math.min(maxDays, MAX_DAYS_HARD_CAP);
    const afterSec = Math.floor((Date.now() - days * 86_400_000) / 1_000);
    const auth = await this.authHeader();

    const listRes = await request<{ messages?: Array<{ id: string; threadId: string }> }>({
      url: `${GMAIL_BASE}/messages`,
      headers: { Authorization: auth },
      params: { q: `is:unread after:${afterSec}`, maxResults: 50 },
    });

    const ids = listRes.data.messages ?? [];
    const emails: EmailMessage[] = [];

    for (const { id, threadId } of ids) {
      try {
        const msgRes = await request<GmailMessageResource>({
          url: `${GMAIL_BASE}/messages/${id}`,
          headers: { Authorization: auth },
          params: { format: "full" },
        });
        const parsed = parseGmailMessage(msgRes.data);
        // Enforce 90-day cap at parse time as well (belt-and-suspenders)
        const cutoff = Date.now() - MAX_DAYS_HARD_CAP * 86_400_000;
        if (new Date(parsed.date).getTime() >= cutoff) {
          emails.push(parsed);
        }
      } catch {
        // A single bad message must not block the full triage
      }
    }

    return emails;
  }

  async createDraft(
    to: string,
    subject: string,
    body: string,
    replyToThreadId?: string,
  ): Promise<EmailDraft> {
    const auth = await this.authHeader();
    const raw = encodeMimeMessage(to, subject, body);

    const payload: Record<string, unknown> = { message: { raw } };
    if (replyToThreadId) {
      (payload.message as Record<string, unknown>).threadId = replyToThreadId;
    }

    const res = await request<GmailDraftResource>({
      url: `${GMAIL_BASE}/drafts`,
      method: "POST",
      headers: { Authorization: auth },
      data: payload,
    });

    return {
      id: res.data.id,
      to,
      subject,
      body,
      replyToThreadId,
      createdAt: new Date().toISOString(),
    };
  }

  async sendDraft(draftId: string): Promise<void> {
    const auth = await this.authHeader();
    await request({
      url: `${GMAIL_BASE}/drafts/send`,
      method: "POST",
      headers: { Authorization: auth },
      data: { id: draftId },
    });
  }

  async deleteDraft(draftId: string): Promise<void> {
    const auth = await this.authHeader();
    try {
      await request({
        url: `${GMAIL_BASE}/drafts/${draftId}`,
        method: "DELETE",
        headers: { Authorization: auth },
      });
    } catch {
      // Draft may already be sent or deleted — idempotent, swallow error
    }
  }

  async getEvents(startTime: string, endTime: string): Promise<CalendarEvent[]> {
    const auth = await this.authHeader();
    const res = await request<{ items?: GCalEventResource[] }>({
      url: `${CAL_BASE}/events`,
      headers: { Authorization: auth },
      params: {
        timeMin: startTime,
        timeMax: endTime,
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 50,
      },
    });

    return (res.data.items ?? []).map(parseGCalEvent);
  }

  async createEvent(event: Omit<CalendarEvent, "id">): Promise<CalendarEvent> {
    const auth = await this.authHeader();
    const res = await request<GCalEventResource>({
      url: `${CAL_BASE}/events`,
      method: "POST",
      headers: { Authorization: auth },
      data: {
        summary: event.title,
        location: event.location,
        description: event.description,
        start: { dateTime: event.startTime },
        end: { dateTime: event.endTime },
        attendees: (event.attendees ?? []).map((email) => ({ email })),
      },
    });

    return parseGCalEvent(res.data);
  }
}
