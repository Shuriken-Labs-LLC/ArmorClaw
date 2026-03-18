/**
 * ArmorClaw skill: CRM + lead gen (crm-leadgen)
 *
 * Capabilities:
 *  - enrich-prospect:  public-web research via allowlisted domains only
 *  - draft-followup:   generate a follow-up sequence for user review (never auto-send)
 *  - create-contact:   create a new contact record in the CRM
 *  - update-contact:   update an existing contact (snapshot → undo)
 *  - create-deal:      create a new deal record
 *  - update-deal:      update an existing deal (snapshot → undo)
 *  - overdue-followups: surface stale / overdue contacts
 *
 * CRM write constraints:
 *  - Audit log records the record id and field names changed — never field values
 *  - update-contact and update-deal fetch the prior state first (for undo snapshot)
 *  - Raw prospect data is never stored locally — reads go directly to the provider
 *
 * Undo: update-contact and update-deal register a 60s undo window that restores
 * the full record to its pre-update state via a second updateContact/updateDeal call.
 *
 * Permission manifest: read:crm, write:crm, network:outbound
 */

import { registerSkill } from "../../lib/skill-registry.ts";
import { writeAuditEntry } from "../../security/audit-logger.ts";
import { registerUndo } from "../../undo/registry.ts";
import { AirtableAdapter } from "./adapters/airtable.ts";
import { HubSpotAdapter } from "./adapters/hubspot.ts";
import { enrichProspect } from "./enrichment.ts";
import type {
  CRMContact,
  CRMDeal,
  CRMInput,
  CRMOutput,
  CRMRecordSnapshot,
  FollowUpItem,
  FollowUpSequence,
  ICRMAdapter,
} from "./types.ts";

// ── Skill metadata ────────────────────────────────────────────────────────────

export const SKILL_NAME = "crm-leadgen";
export const SKILL_VERSION = "1.0.0";
export const PERMISSION_MANIFEST = ["read:crm", "write:crm", "network:outbound"] as const;

// ── Provider detection ────────────────────────────────────────────────────────

export function resolveAdapter(preference?: "hubspot" | "airtable"): ICRMAdapter {
  const hasHubSpot = Boolean(process.env["HUBSPOT_API_KEY"]);
  const hasAirtable = Boolean(process.env["AIRTABLE_API_KEY"]);

  if (preference === "hubspot" && hasHubSpot) return new HubSpotAdapter();
  if (preference === "airtable" && hasAirtable) return new AirtableAdapter();
  if (hasHubSpot) return new HubSpotAdapter();
  if (hasAirtable) return new AirtableAdapter();

  throw new Error("No CRM provider configured. Connect HubSpot or Airtable in Settings.");
}

// ── Skill factory (injectable adapter for tests) ──────────────────────────────

export function createCRMSkill(adapter: ICRMAdapter): {
  run: (input: CRMInput) => Promise<CRMOutput>;
  undo: () => Promise<void>;
} {
  return { run: (input) => runWithAdapter(input, adapter), undo };
}

// ── Exported skill entrypoints ────────────────────────────────────────────────

export async function run(input: CRMInput): Promise<CRMOutput> {
  const adapter = resolveAdapter(input.provider);
  return runWithAdapter(input, adapter);
}

export async function undo(): Promise<void> {
  // No-op: individual record undos are registered as closures in update handlers.
}

// ── Audit helpers ─────────────────────────────────────────────────────────────

/**
 * Log a CRM write to the audit log.
 * Records the record id and field names ONLY — never field values.
 */
function auditCRMWrite(
  action: string,
  recordType: "contact" | "deal",
  recordId: string,
  fieldNames: string[],
  outcome: "success" | "error",
  durationMs: number,
): void {
  const fieldList = fieldNames.join(",");
  writeAuditEntry({
    timestamp: new Date().toISOString(),
    skill: SKILL_NAME,
    permissionsUsed: [...PERMISSION_MANIFEST],
    // inputSummary contains only record id and field names — no values
    inputSummary: `${action}:${recordType}:${recordId}:fields=${fieldList}`.slice(0, 80),
    outcome,
    durationMs,
  });
}

// ── Action dispatcher ─────────────────────────────────────────────────────────

async function runWithAdapter(input: CRMInput, adapter: ICRMAdapter): Promise<CRMOutput> {
  const start = Date.now();

  try {
    let output: CRMOutput;

    switch (input.action) {
      case "enrich-prospect":
        output = await handleEnrich(input);
        break;
      case "draft-followup":
        output = await handleDraftFollowup(input, adapter);
        break;
      case "create-contact":
        output = await handleCreateContact(input, adapter);
        break;
      case "update-contact":
        output = await handleUpdateContact(input, adapter);
        break;
      case "create-deal":
        output = await handleCreateDeal(input, adapter);
        break;
      case "update-deal":
        output = await handleUpdateDeal(input, adapter);
        break;
      case "overdue-followups":
        output = await handleOverdueFollowups(input, adapter);
        break;
      default: {
        const exhaustive: never = input.action;
        output = { success: false, message: `Unknown action: ${String(exhaustive)}` };
      }
    }

    // Non-write actions audit themselves inline; writes audit in their handlers.
    // For read/enrich/draft actions, log a top-level entry here.
    if (
      input.action === "enrich-prospect" ||
      input.action === "draft-followup" ||
      input.action === "overdue-followups"
    ) {
      writeAuditEntry({
        timestamp: new Date().toISOString(),
        skill: SKILL_NAME,
        permissionsUsed: [...PERMISSION_MANIFEST],
        inputSummary: `action:${input.action}`.slice(0, 80),
        outcome: output.success ? "success" : "error",
        durationMs: Date.now() - start,
      });
    }

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

async function handleEnrich(input: CRMInput): Promise<CRMOutput> {
  if (!input.companyQuery?.trim()) {
    return { success: false, message: "enrich-prospect requires a 'companyQuery'." };
  }

  const result = await enrichProspect(input.companyQuery.trim(), input.contactQuery?.trim());

  return {
    success: true,
    message: `Enrichment complete for "${result.companyName ?? input.companyQuery}" from ${result.sourceDomain}.`,
    data: { enrichment: result },
  };
}

async function handleDraftFollowup(input: CRMInput, adapter: ICRMAdapter): Promise<CRMOutput> {
  if (!input.contactId?.trim()) {
    return { success: false, message: "draft-followup requires a 'contactId'." };
  }

  const contact = await adapter.getContact(input.contactId.trim());
  if (!contact) {
    return {
      success: false,
      message: `Contact ${input.contactId} not found in CRM.`,
    };
  }

  const steps = Math.max(1, Math.min(input.sequenceSteps ?? 3, 10));
  const intervalDays = Math.max(1, input.stepIntervalDays ?? 3);
  const context = input.context?.trim() ?? "";
  const contactName =
    [contact.firstName, contact.lastName].filter(Boolean).join(" ") || contact.email || contact.id;

  const items: FollowUpItem[] = Array.from({ length: steps }, (_, i) => {
    const scheduledAt = new Date(Date.now() + (i + 1) * intervalDays * 86_400_000).toISOString();

    const stepNum = i + 1;
    const subjectPrefixes = ["Following up", "Checking in", "Quick note"];
    const subject = `${subjectPrefixes[i % subjectPrefixes.length]}: ${contact.company ?? "your project"}`;

    const introLines = [
      `Hi ${contact.firstName ?? contactName},`,
      `Hey ${contact.firstName ?? contactName},`,
      `Hello ${contact.firstName ?? contactName},`,
    ];

    const bodyLines = [
      context
        ? `I wanted to follow up on ${context}.`
        : `I wanted to reach out and see how things are going.`,
      stepNum === 1
        ? `Would you have 15 minutes to connect this week?`
        : stepNum === steps
          ? `I understand you may be busy — just wanted to make sure this didn't slip through.`
          : `Please let me know if there's a good time to chat.`,
      `\nBest,\n[Your name]`,
    ];

    return {
      step: stepNum,
      scheduledAt,
      subject,
      body: [introLines[i % introLines.length], "", ...bodyLines].join("\n"),
    };
  });

  const sequence: FollowUpSequence = {
    contactId: contact.id,
    contactName,
    items,
    createdAt: new Date().toISOString(),
  };

  return {
    success: true,
    message: `${steps}-step follow-up sequence drafted for ${contactName}. Review and approve each step before sending.`,
    pendingSequence: sequence,
  };
}

async function handleCreateContact(input: CRMInput, adapter: ICRMAdapter): Promise<CRMOutput> {
  if (!input.contactData || Object.keys(input.contactData).length === 0) {
    return { success: false, message: "create-contact requires 'contactData'." };
  }

  const start = Date.now();
  const created = await adapter.createContact(input.contactData as Omit<CRMContact, "id">);

  auditCRMWrite(
    "create-contact",
    "contact",
    created.id,
    Object.keys(input.contactData),
    "success",
    Date.now() - start,
  );

  return {
    success: true,
    message: `Contact created (id: ${created.id}).`,
    data: { contactId: created.id },
  };
}

async function handleUpdateContact(input: CRMInput, adapter: ICRMAdapter): Promise<CRMOutput> {
  if (!input.contactId?.trim()) {
    return { success: false, message: "update-contact requires a 'contactId'." };
  }
  if (!input.contactData || Object.keys(input.contactData).length === 0) {
    return { success: false, message: "update-contact requires 'contactData'." };
  }

  // Snapshot the current state before writing — required for undo
  const before = await adapter.getContact(input.contactId.trim());
  if (!before) {
    return {
      success: false,
      message: `Contact ${input.contactId} not found. Cannot update.`,
    };
  }

  const snapshot: CRMRecordSnapshot = {
    recordType: "contact",
    recordId: before.id,
    before,
  };

  const start = Date.now();
  const updated = await adapter.updateContact(input.contactId.trim(), input.contactData);

  const fieldNames = Object.keys(input.contactData);
  auditCRMWrite("update-contact", "contact", updated.id, fieldNames, "success", Date.now() - start);

  // Register undo: revert to the snapshot state
  registerUndo({
    actionType: "crm-write",
    skill: SKILL_NAME,
    snapshot,
    undoFn: async () => {
      // Restore all fields that were in the pre-update snapshot
      const { id: _, ...restorableFields } = before;
      await adapter.updateContact(before.id, restorableFields);
    },
  });

  return {
    success: true,
    message: `Contact ${updated.id} updated (fields: ${fieldNames.join(", ")}).`,
    data: { contactId: updated.id, fieldsUpdated: fieldNames },
  };
}

async function handleCreateDeal(input: CRMInput, adapter: ICRMAdapter): Promise<CRMOutput> {
  if (!input.dealData?.name) {
    return { success: false, message: "create-deal requires 'dealData' with a 'name' field." };
  }

  const start = Date.now();
  const created = await adapter.createDeal(input.dealData as Omit<CRMDeal, "id">);

  auditCRMWrite(
    "create-deal",
    "deal",
    created.id,
    Object.keys(input.dealData),
    "success",
    Date.now() - start,
  );

  return {
    success: true,
    message: `Deal "${created.name}" created (id: ${created.id}).`,
    data: { dealId: created.id },
  };
}

async function handleUpdateDeal(input: CRMInput, adapter: ICRMAdapter): Promise<CRMOutput> {
  if (!input.dealId?.trim()) {
    return { success: false, message: "update-deal requires a 'dealId'." };
  }
  if (!input.dealData || Object.keys(input.dealData).length === 0) {
    return { success: false, message: "update-deal requires 'dealData'." };
  }

  // Snapshot before write — required for undo
  const before = await adapter.getDeal(input.dealId.trim());
  if (!before) {
    return { success: false, message: `Deal ${input.dealId} not found. Cannot update.` };
  }

  const snapshot: CRMRecordSnapshot = {
    recordType: "deal",
    recordId: before.id,
    before,
  };

  const start = Date.now();
  const updated = await adapter.updateDeal(input.dealId.trim(), input.dealData);

  const fieldNames = Object.keys(input.dealData);
  auditCRMWrite("update-deal", "deal", updated.id, fieldNames, "success", Date.now() - start);

  registerUndo({
    actionType: "crm-write",
    skill: SKILL_NAME,
    snapshot,
    undoFn: async () => {
      const { id: _, ...restorableFields } = before;
      await adapter.updateDeal(before.id, restorableFields);
    },
  });

  return {
    success: true,
    message: `Deal ${updated.id} updated (fields: ${fieldNames.join(", ")}).`,
    data: { dealId: updated.id, fieldsUpdated: fieldNames },
  };
}

async function handleOverdueFollowups(input: CRMInput, adapter: ICRMAdapter): Promise<CRMOutput> {
  const staleAfterDays = Math.max(1, input.staleAfterDays ?? 14);
  const contacts = await adapter.getStaleContacts(staleAfterDays);

  return {
    success: true,
    message:
      contacts.length === 0
        ? `No overdue follow-ups found (threshold: ${staleAfterDays} days).`
        : `${contacts.length} contact${contacts.length !== 1 ? "s" : ""} overdue for follow-up (last contacted more than ${staleAfterDays} days ago).`,
    data: { contacts, staleAfterDays },
  };
}

// ── Registration ──────────────────────────────────────────────────────────────

registerSkill(
  {
    skillId: SKILL_NAME,
    displayName: "CRM + lead gen",
    description:
      "Prospect research, follow-up drafts, and CRM record management for HubSpot and Airtable.",
    version: SKILL_VERSION,
    author: "bundled",
    permissionManifest: [...PERMISSION_MANIFEST],
    undoable: true,
    recipeEligible: true,
    digestMention: true,
  },
  { run, undo },
);
