/**
 * Gmail IMAP/SMTP adapter for the email-calendar skill.
 *
 * Uses IMAP for email access (via imapflow) and SMTP for sending (via nodemailer).
 * Gmail app password is read from the system keychain via the credential store.
 * Calendar is not available over IMAP — only email operations are supported.
 */

import { getCredential } from "../../../lib/credential-store.ts";
import type { CalendarEvent, EmailDraft, EmailMessage, IEmailCalendarAdapter } from "../types.ts";

// ── Constants ─────────────────────────────────────────────────────────────────

const KEYCHAIN_SERVICE = "armorclaw-gmail";
const KEYCHAIN_ACCOUNT_PASSWORD = "app-password";

const MAX_DAYS_HARD_CAP = 90;

// ── Internal types ────────────────────────────────────────────────────────────

/** Local draft storage entry */
interface DraftEntry {
  id: string;
  to: string;
  subject: string;
  body: string;
  replyToThreadId?: string;
  createdAt: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Encode a plain email as an RFC 2822 message.
 * Suitable for use with SMTP.
 */
function encodeRfc2822(to: string, subject: string, body: string): string {
  const lines = [
    `To: ${to}`,
    `Subject: ${subject}`,
    `Content-Type: text/plain; charset=utf-8`,
    `MIME-Version: 1.0`,
    ``,
    body,
  ];
  return lines.join("\r\n");
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export class ImapAdapter implements IEmailCalendarAdapter {
  private drafts = new Map<string, DraftEntry>();

  private async getAppPassword(): Promise<string> {
    const pass = await getCredential(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT_PASSWORD);
    if (!pass) {
      throw new Error(
        "Gmail is not connected. Open Settings and connect your Gmail account to use the email skill.",
      );
    }
    return pass;
  }

  private getEmailAddress(): string {
    const email = process.env["ARMORCLAW_GMAIL_ADDRESS"];
    if (!email) {
      throw new Error(
        "Gmail email address not configured. Open Settings and connect your Gmail account.",
      );
    }
    return email;
  }

  async getUnreadEmails(maxDays = 7): Promise<EmailMessage[]> {
    const days = Math.min(maxDays, MAX_DAYS_HARD_CAP);
    const appPassword = await this.getAppPassword();
    const emailAddress = this.getEmailAddress();

    // Import imapflow dynamically to avoid hard dependency issues
    const { ImapFlow } = (await import("imapflow")) as unknown as {
      ImapFlow: new (opts: unknown) => {
        connect(): Promise<void>;
        mailbox(name: string): Promise<unknown>;
        search(opts: unknown): Promise<unknown[]>;
        fetch(uids: string, opts: unknown): Promise<unknown>;
        close(): Promise<void>;
        logout(): Promise<void>;
      };
    };

    const client = new ImapFlow({
      host: "imap.gmail.com",
      port: 993,
      secure: true,
      auth: { user: emailAddress, pass: appPassword },
      logger: false,
    });

    try {
      await client.connect();

      // Lock INBOX and search for unread messages
      const locked = await client.mailbox("INBOX");
      if (!locked) {
        throw new Error("Could not lock INBOX");
      }

      // Search for unread messages within the time window
      const cutoffTime = new Date(Date.now() - days * 86_400_000);
      const searchResults = (await client.search({
        unseen: true,
        since: cutoffTime,
      })) as unknown[];

      if (!searchResults || searchResults.length === 0) {
        await client.logout();
        return [];
      }

      const emails: EmailMessage[] = [];

      // Fetch headers and body structure for each UID
      for (const uid of searchResults) {
        try {
          // Fetch the envelope and full source
          const fetchResult = (await client.fetch(String(uid), {
            envelope: true,
            bodyStructure: true,
            source: true,
          })) as unknown as AsyncIterable<{
            envelope?: {
              date?: string;
              from?: Array<{ address?: string; name?: string }>;
              to?: Array<{ address?: string; name?: string }>;
              subject?: string;
            };
            text?: string;
          }>;

          // Iterate over fetch results (usually one per UID)
          for await (const item of fetchResult) {
            const envelope = item.envelope;
            const source = item.text || "";

            if (!envelope) {
              continue;
            }

            // Extract plain-text body preview from source
            let snippet = "";
            const sourceLines = source.split("\n");
            for (const line of sourceLines) {
              if (line.trim() && !line.startsWith("From:") && !line.startsWith("Subject:")) {
                snippet = line.substring(0, 120);
                break;
              }
            }

            const fromAddrs = envelope.from ?? [];
            const toAddrs = envelope.to ?? [];

            const email: EmailMessage = {
              id: String(uid),
              threadId: String(uid),
              from: fromAddrs[0]?.address ?? "",
              to: toAddrs.map((a) => a.address ?? "").filter(Boolean),
              subject: envelope.subject ?? "(no subject)",
              snippet: snippet || source.substring(0, 120),
              body: source,
              date: envelope.date
                ? new Date(envelope.date).toISOString()
                : new Date().toISOString(),
              isRead: false,
            };

            // Enforce 90-day cap at parse time
            const cutoff = Date.now() - MAX_DAYS_HARD_CAP * 86_400_000;
            if (new Date(email.date).getTime() >= cutoff) {
              emails.push(email);
            }
          }
        } catch {
          // A single bad message must not block the full triage
        }
      }

      await client.logout();
      return emails;
    } catch (err) {
      try {
        await client.logout();
      } catch {
        // Ignore logout errors
      }
      throw err;
    }
  }

  async createDraft(
    to: string,
    subject: string,
    body: string,
    replyToThreadId?: string,
  ): Promise<EmailDraft> {
    // Generate a unique draft ID
    const id = crypto.randomUUID();

    const draft: DraftEntry = {
      id,
      to,
      subject,
      body,
      replyToThreadId,
      createdAt: new Date().toISOString(),
    };

    this.drafts.set(id, draft);

    return {
      id,
      to,
      subject,
      body,
      replyToThreadId,
      createdAt: draft.createdAt,
    };
  }

  async sendDraft(draftId: string): Promise<void> {
    const draft = this.drafts.get(draftId);
    if (!draft) {
      throw new Error(`Draft ${draftId} not found.`);
    }

    const appPassword = await this.getAppPassword();
    const emailAddress = this.getEmailAddress();

    // Import nodemailer dynamically
    const nodemailer = (await import("nodemailer")) as unknown as {
      createTransport(opts: unknown): {
        sendMail(opts: unknown): Promise<unknown>;
      };
    };

    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 587,
      secure: false, // Use STARTTLS
      auth: {
        user: emailAddress,
        pass: appPassword,
      },
    });

    try {
      await transporter.sendMail({
        from: emailAddress,
        to: draft.to,
        subject: draft.subject,
        text: draft.body,
      });

      // Remove from local map on success
      this.drafts.delete(draftId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to send email: ${msg}`);
    }
  }

  async deleteDraft(draftId: string): Promise<void> {
    // Idempotent — silently succeed if not found
    this.drafts.delete(draftId);
  }

  async getEvents(_startTime: string, _endTime: string): Promise<CalendarEvent[]> {
    // Calendar is not available via IMAP connection
    return [];
  }

  async createEvent(_event: Omit<CalendarEvent, "id">): Promise<CalendarEvent> {
    throw new Error(
      "Calendar not available via IMAP connection. Use the Google Calendar integration for calendar features.",
    );
  }
}
