/**
 * Outlook + Microsoft 365 Calendar adapter for the email-calendar skill.
 *
 * Uses the Microsoft Graph API via gaxios.
 * OAuth access token is read from the system keychain via the credential store.
 * Never stores tokens in env vars, plaintext config, or log output.
 */

import { request } from "gaxios";
import { getCredential } from "../../../lib/credential-store.ts";
import type { CalendarEvent, EmailDraft, EmailMessage, IEmailCalendarAdapter } from "../types.ts";

// ── Constants ─────────────────────────────────────────────────────────────────

const GRAPH_BASE = "https://graph.microsoft.com/v1.0/me";

const KEYCHAIN_SERVICE = "armorclaw-outlook";
const KEYCHAIN_ACCOUNT = "oauth-token";

const MAX_DAYS_HARD_CAP = 90;

// ── Internal resource shapes (partial) ───────────────────────────────────────

interface GraphEmailAddress {
  address?: string;
  name?: string;
}

interface GraphRecipient {
  emailAddress?: GraphEmailAddress;
}

interface GraphMessageResource {
  id: string;
  conversationId?: string;
  from?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  subject?: string;
  bodyPreview?: string;
  body?: { content?: string; contentType?: string };
  receivedDateTime?: string;
  isRead?: boolean;
}

interface GraphDraftResource {
  id: string;
  conversationId?: string;
}

interface GraphDateTimeTimeZone {
  dateTime?: string;
  timeZone?: string;
}

interface GraphAttendee {
  emailAddress?: GraphEmailAddress;
}

interface GraphEventResource {
  id: string;
  subject?: string;
  location?: { displayName?: string };
  bodyPreview?: string;
  start?: GraphDateTimeTimeZone;
  end?: GraphDateTimeTimeZone;
  attendees?: GraphAttendee[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function recipientEmail(r: GraphRecipient | undefined): string {
  return r?.emailAddress?.address ?? "";
}

function parseGraphMessage(raw: GraphMessageResource): EmailMessage {
  return {
    id: raw.id,
    threadId: raw.conversationId ?? raw.id,
    from: recipientEmail(raw.from),
    to: (raw.toRecipients ?? []).map((r) => recipientEmail(r)).filter(Boolean),
    subject: raw.subject ?? "",
    snippet: raw.bodyPreview ?? "",
    body: raw.body?.content ?? "",
    date: raw.receivedDateTime ?? new Date().toISOString(),
    isRead: raw.isRead ?? false,
  };
}

function graphDateTimeToIso(dt: GraphDateTimeTimeZone | undefined): string {
  if (!dt?.dateTime) {
    return "";
  }
  // Graph returns UTC datetime without 'Z'; append it for valid ISO 8601
  const s = dt.dateTime;
  return s.endsWith("Z") ? s : `${s}Z`;
}

function parseGraphEvent(raw: GraphEventResource): CalendarEvent {
  return {
    id: raw.id,
    title: raw.subject ?? "(no title)",
    startTime: graphDateTimeToIso(raw.start),
    endTime: graphDateTimeToIso(raw.end),
    location: raw.location?.displayName,
    description: raw.bodyPreview,
    attendees: (raw.attendees ?? []).map((a) => a.emailAddress?.address ?? "").filter(Boolean),
  };
}

function isoToGraphDateTime(iso: string): { dateTime: string; timeZone: string } {
  // Normalize to UTC for the Graph API
  const dt = iso.endsWith("Z") ? iso : `${iso}Z`;
  return { dateTime: dt.replace("Z", ""), timeZone: "UTC" };
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export class OutlookAdapter implements IEmailCalendarAdapter {
  private async authHeader(): Promise<string> {
    const token = await getCredential(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
    if (!token) {
      throw new Error(
        "Outlook is not connected. Reconnect Outlook in Settings to use the email skill.",
      );
    }
    return `Bearer ${token}`;
  }

  async getUnreadEmails(maxDays = 7): Promise<EmailMessage[]> {
    const days = Math.min(maxDays, MAX_DAYS_HARD_CAP);
    const cutoffDate = new Date(Date.now() - days * 86_400_000).toISOString();
    const auth = await this.authHeader();

    const res = await request<{ value?: GraphMessageResource[] }>({
      url: `${GRAPH_BASE}/mailFolders/inbox/messages`,
      headers: { Authorization: auth },
      params: {
        $filter: `isRead eq false and receivedDateTime ge ${cutoffDate}`,
        $orderby: "receivedDateTime desc",
        $top: 50,
        $select:
          "id,conversationId,from,toRecipients,subject,bodyPreview,body,receivedDateTime,isRead",
      },
    });

    const cutoffMs = Date.now() - MAX_DAYS_HARD_CAP * 86_400_000;
    return (res.data.value ?? [])
      .map(parseGraphMessage)
      .filter((m) => new Date(m.date).getTime() >= cutoffMs);
  }

  async createDraft(
    to: string,
    subject: string,
    body: string,
    replyToThreadId?: string,
  ): Promise<EmailDraft> {
    const auth = await this.authHeader();

    const payload: Record<string, unknown> = {
      subject,
      body: { contentType: "Text", content: body },
      toRecipients: [{ emailAddress: { address: to } }],
    };

    if (replyToThreadId) {
      payload.conversationId = replyToThreadId;
    }

    const res = await request<GraphDraftResource>({
      url: `${GRAPH_BASE}/messages`,
      method: "POST",
      headers: { Authorization: auth },
      data: payload,
    });

    return {
      id: res.data.id,
      to,
      subject,
      body,
      replyToThreadId: res.data.conversationId,
      createdAt: new Date().toISOString(),
    };
  }

  async sendDraft(draftId: string): Promise<void> {
    const auth = await this.authHeader();
    await request({
      url: `${GRAPH_BASE}/messages/${draftId}/send`,
      method: "POST",
      headers: { Authorization: auth },
    });
  }

  async deleteDraft(draftId: string): Promise<void> {
    const auth = await this.authHeader();
    try {
      await request({
        url: `${GRAPH_BASE}/messages/${draftId}`,
        method: "DELETE",
        headers: { Authorization: auth },
      });
    } catch {
      // Draft may already be sent or deleted — idempotent, swallow error
    }
  }

  async getEvents(startTime: string, endTime: string): Promise<CalendarEvent[]> {
    const auth = await this.authHeader();

    const res = await request<{ value?: GraphEventResource[] }>({
      url: `${GRAPH_BASE}/calendarView`,
      headers: { Authorization: auth },
      params: {
        startDateTime: startTime,
        endDateTime: endTime,
        $orderby: "start/dateTime",
        $top: 50,
        $select: "id,subject,location,bodyPreview,start,end,attendees",
      },
    });

    return (res.data.value ?? []).map(parseGraphEvent);
  }

  async createEvent(event: Omit<CalendarEvent, "id">): Promise<CalendarEvent> {
    const auth = await this.authHeader();

    const res = await request<GraphEventResource>({
      url: `${GRAPH_BASE}/events`,
      method: "POST",
      headers: { Authorization: auth },
      data: {
        subject: event.title,
        location: event.location ? { displayName: event.location } : undefined,
        body: event.description ? { contentType: "Text", content: event.description } : undefined,
        start: isoToGraphDateTime(event.startTime),
        end: isoToGraphDateTime(event.endTime),
        attendees: (event.attendees ?? []).map((email) => ({
          emailAddress: { address: email },
        })),
      },
    });

    return parseGraphEvent(res.data);
  }
}
