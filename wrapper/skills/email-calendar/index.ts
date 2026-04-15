/**
 * ArmorClaw skill: Email + calendar (email-calendar)
 *
 * Capabilities:
 *  - Inbox triage: return structured unread emails for the agent to summarise
 *  - Draft replies: save to provider, return for user confirmation (NEVER auto-send)
 *  - Confirm-send: only sends after explicit confirmed:true — no implicit send path
 *  - Calendar events: retrieve upcoming events, schedule new ones
 *  - Daily briefing: combined email + events snapshot for the digest
 *
 * Sending an email always requires two separate calls:
 *   1. action:'draft-reply'  → saves draft, returns pendingDraft
 *   2. action:'confirm-send' → sends only if confirmed:true
 *
 * Undo: after draft-reply the undo registry holds a 60-second window to delete
 * the draft before the user confirms. Once confirm-send succeeds the window
 * has already been used; deleteDraft is idempotent so a late undo is a no-op.
 *
 * Permission manifest: read:email, send:email, read:calendar, write:calendar
 * OAuth tokens stored via keytar system keychain — never plaintext.
 */

import { registerSkill } from "../../lib/skill-registry.ts";
import { writeAuditEntry } from "../../security/audit-logger.ts";
import { registerUndo } from "../../undo/registry.ts";
import { ImapAdapter } from "./adapters/imap.ts";
import type {
  CalendarEvent,
  EmailCalendarInput,
  EmailCalendarOutput,
  IEmailCalendarAdapter,
} from "./types.ts";

// ── Skill metadata ────────────────────────────────────────────────────────────

export const SKILL_NAME = "email-calendar";
export const SKILL_VERSION = "1.0.0";
export const PERMISSION_MANIFEST = [
  "read:email",
  "send:email",
  "read:calendar",
  "write:calendar",
] as const;

// ── Provider detection ────────────────────────────────────────────────────────

/**
 * Return the appropriate adapter based on env config.
 * Gmail IMAP is the only supported provider for v1.
 *
 * @param _preference  Ignored in v1 (Gmail only).
 */
export function resolveAdapter(_preference?: "gmail" | "outlook"): IEmailCalendarAdapter {
  const hasGmail = Boolean(process.env["ARMORCLAW_GMAIL_CONNECTED"]);

  if (hasGmail) {
    return new ImapAdapter();
  }

  throw new Error(
    "Gmail is not connected. Open Settings and connect your Gmail account to use the email skill.",
  );
}

// ── Skill factory (injectable adapter for tests) ──────────────────────────────

/**
 * Create a bound skill `run` function that uses the given adapter.
 * Use this in tests to inject a mock adapter without touching the env.
 */
export function createEmailCalendarSkill(adapter: IEmailCalendarAdapter): {
  run: (input: EmailCalendarInput) => Promise<EmailCalendarOutput>;
  undo: () => Promise<void>;
} {
  return { run: (input) => runWithAdapter(input, adapter), undo };
}

// ── Exported skill entrypoints ────────────────────────────────────────────────

/**
 * Main run function. Resolves the provider adapter from env, then dispatches.
 */
export async function run(input: EmailCalendarInput): Promise<EmailCalendarOutput> {
  const adapter = resolveAdapter(input.provider);
  return runWithAdapter(input, adapter);
}

/**
 * Undo function — required by the skill registry because undoable:true.
 * The undo entry registered during draft-reply captures a specific deleteDraft
 * closure; this top-level undo() is a no-op (the registry calls the closure
 * directly). It is exported to satisfy the registry contract at load time.
 */
export async function undo(): Promise<void> {
  // No-op: individual draft undos are registered as closures in draft-reply.
  // This export exists so the skill registry can verify the undo contract.
}

// ── Action dispatcher ─────────────────────────────────────────────────────────

async function runWithAdapter(
  input: EmailCalendarInput,
  adapter: IEmailCalendarAdapter,
): Promise<EmailCalendarOutput> {
  const start = Date.now();

  try {
    let output: EmailCalendarOutput;

    switch (input.action) {
      case "triage":
        output = await handleTriage(input, adapter);
        break;
      case "draft-reply":
        output = await handleDraftReply(input, adapter);
        break;
      case "confirm-send":
        output = await handleConfirmSend(input, adapter);
        break;
      case "get-events":
        output = await handleGetEvents(input, adapter);
        break;
      case "schedule-event":
        output = await handleScheduleEvent(input, adapter);
        break;
      case "daily-briefing":
        output = await handleDailyBriefing(input, adapter);
        break;
      default: {
        const exhaustive: never = input.action;
        output = { success: false, message: `Unknown action: ${String(exhaustive)}` };
      }
    }

    writeAuditEntry({
      timestamp: new Date().toISOString(),
      skill: SKILL_NAME,
      permissionsUsed: [...PERMISSION_MANIFEST],
      inputSummary: `action:${input.action}`.slice(0, 80),
      outcome: output.success ? "success" : "error",
      durationMs: Date.now() - start,
    });

    return output;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeAuditEntry({
      timestamp: new Date().toISOString(),
      skill: SKILL_NAME,
      permissionsUsed: [...PERMISSION_MANIFEST],
      inputSummary: `action:${input.action}`.slice(0, 80),
      outcome: "error",
      durationMs: Date.now() - start,
    });
    return { success: false, message };
  }
}

// ── Action handlers ───────────────────────────────────────────────────────────

async function handleTriage(
  input: EmailCalendarInput,
  adapter: IEmailCalendarAdapter,
): Promise<EmailCalendarOutput> {
  const maxDays = Math.min(input.maxDays ?? 7, 90);
  const emails = await adapter.getUnreadEmails(maxDays);

  return {
    success: true,
    message:
      emails.length === 0
        ? `No unread email in the last ${maxDays} day${maxDays !== 1 ? "s" : ""}.`
        : `Found ${emails.length} unread email${emails.length !== 1 ? "s" : ""} in the last ${maxDays} day${maxDays !== 1 ? "s" : ""}.`,
    data: { emails, maxDays },
  };
}

async function handleDraftReply(
  input: EmailCalendarInput,
  adapter: IEmailCalendarAdapter,
): Promise<EmailCalendarOutput> {
  const { to, subject, body, replyToThreadId } = input;

  if (!to?.trim()) {
    return { success: false, message: "draft-reply requires a 'to' address." };
  }
  if (!subject?.trim()) {
    return { success: false, message: "draft-reply requires a 'subject'." };
  }
  if (!body?.trim()) {
    return { success: false, message: "draft-reply requires a 'body'." };
  }

  const draft = await adapter.createDraft(to.trim(), subject.trim(), body.trim(), replyToThreadId);

  // Register undo: delete the draft from the provider if the user cancels.
  // undoFn is idempotent — deleteDraft swallows 404/already-sent errors.
  registerUndo({
    actionType: "email-draft",
    skill: SKILL_NAME,
    snapshot: { draft },
    undoFn: async () => {
      await adapter.deleteDraft(draft.id);
    },
  });

  return {
    success: true,
    message: `Draft ready: "${draft.subject}" to ${draft.to}. Awaiting your confirmation before sending.`,
    pendingDraft: draft,
  };
}

async function handleConfirmSend(
  input: EmailCalendarInput,
  adapter: IEmailCalendarAdapter,
): Promise<EmailCalendarOutput> {
  if (!input.draftId?.trim()) {
    return { success: false, message: "confirm-send requires a 'draftId'." };
  }
  if (input.confirmed !== true) {
    return {
      success: false,
      message: "confirm-send requires confirmed:true. Set confirmed:true to send the draft.",
    };
  }

  await adapter.sendDraft(input.draftId.trim());

  return {
    success: true,
    message: `Email sent (draft ${input.draftId}).`,
    data: { draftId: input.draftId },
  };
}

async function handleGetEvents(
  input: EmailCalendarInput,
  adapter: IEmailCalendarAdapter,
): Promise<EmailCalendarOutput> {
  const startTime = input.startDate ?? new Date().toISOString();
  const endTime = input.endDate ?? new Date(Date.now() + 7 * 86_400_000).toISOString();

  const events = await adapter.getEvents(startTime, endTime);

  return {
    success: true,
    message:
      events.length === 0
        ? "No calendar events in the requested range."
        : `Found ${events.length} event${events.length !== 1 ? "s" : ""}.`,
    data: { events, startTime, endTime },
  };
}

async function handleScheduleEvent(
  input: EmailCalendarInput,
  adapter: IEmailCalendarAdapter,
): Promise<EmailCalendarOutput> {
  if (!input.eventTitle?.trim()) {
    return { success: false, message: "schedule-event requires an 'eventTitle'." };
  }
  if (!input.eventStart?.trim()) {
    return { success: false, message: "schedule-event requires an 'eventStart' (ISO 8601)." };
  }
  if (!input.eventEnd?.trim()) {
    return { success: false, message: "schedule-event requires an 'eventEnd' (ISO 8601)." };
  }

  const eventToCreate: Omit<CalendarEvent, "id"> = {
    title: input.eventTitle.trim(),
    startTime: input.eventStart.trim(),
    endTime: input.eventEnd.trim(),
    location: input.eventLocation?.trim(),
    description: input.eventDescription?.trim(),
  };

  const created = await adapter.createEvent(eventToCreate);

  return {
    success: true,
    message: `Event "${created.title}" scheduled for ${created.startTime}.`,
    data: { event: created },
  };
}

async function handleDailyBriefing(
  input: EmailCalendarInput,
  adapter: IEmailCalendarAdapter,
): Promise<EmailCalendarOutput> {
  const maxDays = Math.min(input.maxDays ?? 1, 90);
  const startTime = new Date().toISOString();
  const endTime = new Date(Date.now() + 24 * 3_600_000).toISOString();

  const [emails, events] = await Promise.all([
    adapter.getUnreadEmails(maxDays),
    adapter.getEvents(startTime, endTime),
  ]);

  return {
    success: true,
    message: `Daily briefing: ${emails.length} unread email${emails.length !== 1 ? "s" : ""}, ${events.length} event${events.length !== 1 ? "s" : ""} today.`,
    data: { emails, events, date: startTime.slice(0, 10) },
  };
}

// ── Registration ──────────────────────────────────────────────────────────────

registerSkill(
  {
    skillId: SKILL_NAME,
    displayName: "Email + calendar",
    description: "Inbox triage and draft replies for Gmail via app password.",
    version: SKILL_VERSION,
    author: "bundled",
    permissionManifest: [...PERMISSION_MANIFEST],
    undoable: true,
    recipeEligible: true,
    digestMention: true,
  },
  { run, undo },
);
