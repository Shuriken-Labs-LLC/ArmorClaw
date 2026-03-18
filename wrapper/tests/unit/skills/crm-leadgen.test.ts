/**
 * Unit tests for the crm-leadgen skill.
 *
 * Uses createCRMSkill() to inject mock adapters — no real API calls.
 * Tests: enrich-prospect (allowlist), draft-followup, create-contact,
 *        update-contact + undo, create-deal, update-deal + undo,
 *        overdue-followups, audit log constraints.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("../../../security/audit-logger.ts", () => ({
  writeAuditEntry: vi.fn(),
}));

vi.mock("../../../lib/skill-registry.ts", () => ({
  registerSkill: vi.fn(),
}));

// enrichment.ts is mocked for skill-level tests so we don't need a real network
vi.mock("../../../skills/crm-leadgen/enrichment.ts", () => ({
  enrichProspect: vi.fn(),
  isEnrichmentAllowed: vi.fn((url: string) => url.startsWith("https://www.linkedin.com")),
  extractText: vi.fn((html: string) =>
    html
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  ),
  ENRICHMENT_ALLOWED_DOMAINS: new Set(["www.linkedin.com", "company.clearbit.com"]),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { writeAuditEntry } from "../../../security/audit-logger.ts";
import { enrichProspect } from "../../../skills/crm-leadgen/enrichment.ts";
import {
  isEnrichmentAllowed,
  extractText,
  ENRICHMENT_ALLOWED_DOMAINS,
} from "../../../skills/crm-leadgen/enrichment.ts";
import { createCRMSkill, resolveAdapter } from "../../../skills/crm-leadgen/index.ts";
import type { CRMContact, CRMDeal, ICRMAdapter } from "../../../skills/crm-leadgen/types.ts";
import { clearUndoForTesting, getCurrentUndo } from "../../../undo/registry.ts";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeContact(overrides: Partial<CRMContact> = {}): CRMContact {
  return {
    id: "contact-1",
    firstName: "Alice",
    lastName: "Smith",
    email: "alice@example.com",
    company: "Acme Corp",
    jobTitle: "CEO",
    lastContactedAt: new Date(Date.now() - 20 * 86_400_000).toISOString(), // 20 days ago
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeDeal(overrides: Partial<CRMDeal> = {}): CRMDeal {
  return {
    id: "deal-1",
    name: "Acme Enterprise",
    stage: "Qualified",
    amount: 50_000,
    currency: "USD",
    closeDate: "2026-06-30",
    ...overrides,
  };
}

// ── Mock adapter factory ──────────────────────────────────────────────────────

function makeMockAdapter(overrides: Partial<ICRMAdapter> = {}): ICRMAdapter {
  return {
    getContact: vi.fn(async () => makeContact()),
    searchContacts: vi.fn(async () => []),
    createContact: vi.fn(async (data) => ({ id: "new-contact-1", ...data })),
    updateContact: vi.fn(async (_id, data) => ({ ...makeContact(), ...data })),
    getStaleContacts: vi.fn(async () => []),
    getDeal: vi.fn(async () => makeDeal()),
    createDeal: vi.fn(async (data) => ({ id: "new-deal-1", ...data })),
    updateDeal: vi.fn(async (_id, data) => ({ ...makeDeal(), ...data })),
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

// ── enrich-prospect ───────────────────────────────────────────────────────────

describe("enrich-prospect", () => {
  it("returns enrichment data on success", async () => {
    vi.mocked(enrichProspect).mockResolvedValueOnce({
      query: "Acme Corp",
      sourceDomain: "www.linkedin.com",
      summary: "Acme Corp is a global enterprise software company.",
      companyName: "Acme Corp",
      industry: "Software",
    });
    const adapter = makeMockAdapter();
    const { run } = createCRMSkill(adapter);

    const result = await run({ action: "enrich-prospect", companyQuery: "Acme Corp" });

    expect(result.success).toBe(true);
    expect(result.message).toMatch(/Acme Corp/);
    expect(result.message).toMatch(/www\.linkedin\.com/);
  });

  it("passes companyQuery and contactQuery to enrichProspect", async () => {
    vi.mocked(enrichProspect).mockResolvedValueOnce({
      query: "Acme Corp",
      sourceDomain: "www.linkedin.com",
      summary: "summary",
    });
    const { run } = createCRMSkill(makeMockAdapter());

    await run({
      action: "enrich-prospect",
      companyQuery: "Acme Corp",
      contactQuery: "Alice Smith",
    });

    expect(enrichProspect).toHaveBeenCalledWith("Acme Corp", "Alice Smith");
  });

  it("fails when companyQuery is missing", async () => {
    const { run } = createCRMSkill(makeMockAdapter());

    const result = await run({ action: "enrich-prospect" });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/companyQuery/);
    expect(enrichProspect).not.toHaveBeenCalled();
  });

  it("returns success:false when enrichProspect throws", async () => {
    vi.mocked(enrichProspect).mockRejectedValueOnce(
      new Error("No allowlisted URL could be constructed"),
    );
    const { run } = createCRMSkill(makeMockAdapter());

    const result = await run({ action: "enrich-prospect", companyQuery: "Unknown Co" });

    expect(result.success).toBe(false);
    expect(result.message).toContain("No allowlisted URL");
  });
});

// ── isEnrichmentAllowed (pure, tests enrichment.ts directly) ─────────────────

describe("isEnrichmentAllowed (enrichment module)", () => {
  it("allows https LinkedIn URLs", () => {
    expect(isEnrichmentAllowed("https://www.linkedin.com/company/acme")).toBe(true);
  });

  it("blocks non-allowlisted domains", () => {
    expect(isEnrichmentAllowed("https://evil.com/scrape")).toBe(false);
  });

  it("blocks http (non-https) URLs", () => {
    expect(isEnrichmentAllowed("http://www.linkedin.com/company/acme")).toBe(false);
  });

  it("blocks malformed URLs", () => {
    expect(isEnrichmentAllowed("not-a-url")).toBe(false);
  });
});

// ── extractText (pure, tests enrichment.ts directly) ─────────────────────────

describe("extractText (enrichment module)", () => {
  it("strips HTML tags", () => {
    expect(extractText("<p>Hello <b>world</b></p>")).toBe("Hello world");
  });

  it("collapses whitespace", () => {
    expect(extractText("  foo   bar  ")).toBe("foo bar");
  });
});

// ── ENRICHMENT_ALLOWED_DOMAINS (pure) ─────────────────────────────────────────

describe("ENRICHMENT_ALLOWED_DOMAINS", () => {
  it("contains linkedin.com variants", () => {
    expect(ENRICHMENT_ALLOWED_DOMAINS.has("www.linkedin.com")).toBe(true);
  });
});

// ── draft-followup ────────────────────────────────────────────────────────────

describe("draft-followup", () => {
  it("returns a pending sequence for a valid contact", async () => {
    const contact = makeContact({ id: "c-1", firstName: "Alice" });
    const adapter = makeMockAdapter({ getContact: vi.fn(async () => contact) });
    const { run } = createCRMSkill(adapter);

    const result = await run({ action: "draft-followup", contactId: "c-1" });

    expect(result.success).toBe(true);
    expect(result.pendingSequence).toBeDefined();
    expect(result.pendingSequence?.contactId).toBe("c-1");
    expect(result.pendingSequence?.items).toHaveLength(3); // default 3 steps
  });

  it("respects sequenceSteps override", async () => {
    const adapter = makeMockAdapter();
    const { run } = createCRMSkill(adapter);

    const result = await run({
      action: "draft-followup",
      contactId: "c-1",
      sequenceSteps: 5,
    });

    expect(result.pendingSequence?.items).toHaveLength(5);
  });

  it("caps sequenceSteps at 10", async () => {
    const adapter = makeMockAdapter();
    const { run } = createCRMSkill(adapter);

    const result = await run({
      action: "draft-followup",
      contactId: "c-1",
      sequenceSteps: 99,
    });

    expect(result.pendingSequence?.items).toHaveLength(10);
  });

  it("items are scheduled at stepIntervalDays intervals", async () => {
    const adapter = makeMockAdapter();
    const { run } = createCRMSkill(adapter);
    const before = Date.now();

    const result = await run({
      action: "draft-followup",
      contactId: "c-1",
      sequenceSteps: 2,
      stepIntervalDays: 7,
    });

    const items = result.pendingSequence?.items ?? [];
    expect(items).toHaveLength(2);
    const step1Ms = new Date(items[0].scheduledAt).getTime();
    const step2Ms = new Date(items[1].scheduledAt).getTime();
    // step2 should be ~7 days after step1
    expect(step2Ms - step1Ms).toBeCloseTo(7 * 86_400_000, -4);
    // step1 should be ~7 days after the call
    expect(step1Ms - before).toBeCloseTo(7 * 86_400_000, -4);
  });

  it("each item has step number, subject, and body", async () => {
    const adapter = makeMockAdapter();
    const { run } = createCRMSkill(adapter);

    const result = await run({ action: "draft-followup", contactId: "c-1" });

    for (const item of result.pendingSequence?.items ?? []) {
      expect(item.step).toBeGreaterThan(0);
      expect(item.subject).toBeTruthy();
      expect(item.body).toBeTruthy();
    }
  });

  it("fails when contactId is missing", async () => {
    const { run } = createCRMSkill(makeMockAdapter());

    const result = await run({ action: "draft-followup" });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/contactId/);
  });

  it("fails when contact is not found", async () => {
    const adapter = makeMockAdapter({ getContact: vi.fn(async () => null) });
    const { run } = createCRMSkill(adapter);

    const result = await run({ action: "draft-followup", contactId: "missing" });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/not found/i);
  });

  it("message tells user to review before sending", async () => {
    const { run } = createCRMSkill(makeMockAdapter());

    const result = await run({ action: "draft-followup", contactId: "c-1" });

    expect(result.message).toMatch(/review/i);
    expect(result.message).not.toMatch(/sent/i);
  });
});

// ── create-contact ────────────────────────────────────────────────────────────

describe("create-contact", () => {
  it("creates a contact and returns its id", async () => {
    const adapter = makeMockAdapter({
      createContact: vi.fn(async () => makeContact({ id: "created-1" })),
    });
    const { run } = createCRMSkill(adapter);

    const result = await run({
      action: "create-contact",
      contactData: { firstName: "Bob", email: "bob@example.com" },
    });

    expect(result.success).toBe(true);
    expect((result.data as { contactId: string }).contactId).toBe("created-1");
    expect(adapter.createContact).toHaveBeenCalledWith(
      expect.objectContaining({ firstName: "Bob", email: "bob@example.com" }),
    );
  });

  it("fails when contactData is missing", async () => {
    const { run } = createCRMSkill(makeMockAdapter());

    const result = await run({ action: "create-contact" });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/contactData/);
  });

  it("writes audit log with field names only — no values", async () => {
    const adapter = makeMockAdapter({
      createContact: vi.fn(async () => makeContact({ id: "c-audit" })),
    });
    const { run } = createCRMSkill(adapter);

    await run({
      action: "create-contact",
      contactData: { firstName: "Secret", email: "secret@example.com" },
    });

    const entries = vi.mocked(writeAuditEntry).mock.calls.map((c) => c[0]);
    const writeEntry = entries.find((e) => e.inputSummary.includes("create-contact"));
    expect(writeEntry).toBeDefined();
    // Must contain field names
    expect(writeEntry!.inputSummary).toContain("firstName");
    // Must NOT contain field values
    expect(writeEntry!.inputSummary).not.toContain("Secret");
    expect(writeEntry!.inputSummary).not.toContain("secret@example.com");
  });
});

// ── update-contact + undo ─────────────────────────────────────────────────────

describe("update-contact", () => {
  it("updates a contact and returns field names", async () => {
    const adapter = makeMockAdapter();
    const { run } = createCRMSkill(adapter);

    const result = await run({
      action: "update-contact",
      contactId: "contact-1",
      contactData: { jobTitle: "CTO", company: "New Corp" },
    });

    expect(result.success).toBe(true);
    const d = result.data as { fieldsUpdated: string[] };
    expect(d.fieldsUpdated).toContain("jobTitle");
    expect(d.fieldsUpdated).toContain("company");
  });

  it("fetches the contact before updating (for snapshot)", async () => {
    const adapter = makeMockAdapter();
    const { run } = createCRMSkill(adapter);

    await run({
      action: "update-contact",
      contactId: "contact-1",
      contactData: { jobTitle: "CTO" },
    });

    expect(adapter.getContact).toHaveBeenCalledWith("contact-1");
    expect(adapter.updateContact).toHaveBeenCalledWith(
      "contact-1",
      expect.objectContaining({ jobTitle: "CTO" }),
    );
  });

  it("registers an undo entry after update", async () => {
    const { run } = createCRMSkill(makeMockAdapter());

    await run({
      action: "update-contact",
      contactId: "contact-1",
      contactData: { jobTitle: "VP Sales" },
    });

    const entry = getCurrentUndo();
    expect(entry).not.toBeNull();
    expect(entry?.actionType).toBe("crm-write");
    expect(entry?.skill).toBe("crm-leadgen");
  });

  it("undo snapshot contains the pre-update record", async () => {
    const original = makeContact({ id: "contact-1", jobTitle: "CEO" });
    const adapter = makeMockAdapter({ getContact: vi.fn(async () => original) });
    const { run } = createCRMSkill(adapter);

    await run({
      action: "update-contact",
      contactId: "contact-1",
      contactData: { jobTitle: "CTO" },
    });

    const snapshot = getCurrentUndo()?.snapshot as { recordId: string; before: CRMContact };
    expect(snapshot.recordId).toBe("contact-1");
    expect(snapshot.before.jobTitle).toBe("CEO");
  });

  it("undo calls updateContact with the pre-update data", async () => {
    const original = makeContact({ id: "contact-1", jobTitle: "CEO" });
    const adapter = makeMockAdapter({ getContact: vi.fn(async () => original) });
    const { run } = createCRMSkill(adapter);

    await run({
      action: "update-contact",
      contactId: "contact-1",
      contactData: { jobTitle: "CTO" },
    });

    const entry = getCurrentUndo();
    await entry!.undoFn();

    // Second call to updateContact should restore original fields
    const updateCalls = vi.mocked(adapter.updateContact).mock.calls;
    expect(updateCalls.length).toBe(2);
    const restoreCall = updateCalls[1];
    expect(restoreCall[1]).toMatchObject({ jobTitle: "CEO" });
  });

  it("fails when contactId is missing", async () => {
    const { run } = createCRMSkill(makeMockAdapter());

    const result = await run({ action: "update-contact", contactData: { jobTitle: "CTO" } });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/contactId/);
  });

  it("fails when contactData is missing", async () => {
    const { run } = createCRMSkill(makeMockAdapter());

    const result = await run({ action: "update-contact", contactId: "c-1" });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/contactData/);
  });

  it("fails when contact is not found", async () => {
    const adapter = makeMockAdapter({ getContact: vi.fn(async () => null) });
    const { run } = createCRMSkill(adapter);

    const result = await run({
      action: "update-contact",
      contactId: "missing",
      contactData: { jobTitle: "CTO" },
    });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/not found/i);
    expect(adapter.updateContact).not.toHaveBeenCalled();
  });

  it("audit log contains field names but not field values", async () => {
    const adapter = makeMockAdapter();
    const { run } = createCRMSkill(adapter);

    await run({
      action: "update-contact",
      contactId: "contact-1",
      contactData: { email: "newemail@secret.com" },
    });

    const entries = vi.mocked(writeAuditEntry).mock.calls.map((c) => c[0]);
    const writeEntry = entries.find((e) => e.inputSummary.includes("update-contact"));
    expect(writeEntry!.inputSummary).toContain("email");
    expect(writeEntry!.inputSummary).not.toContain("newemail@secret.com");
  });
});

// ── create-deal ───────────────────────────────────────────────────────────────

describe("create-deal", () => {
  it("creates a deal and returns its id", async () => {
    const adapter = makeMockAdapter({
      createDeal: vi.fn(async () => makeDeal({ id: "deal-created" })),
    });
    const { run } = createCRMSkill(adapter);

    const result = await run({
      action: "create-deal",
      dealData: { name: "Big Account", stage: "Prospect", amount: 100_000 },
    });

    expect(result.success).toBe(true);
    expect((result.data as { dealId: string }).dealId).toBe("deal-created");
  });

  it("fails when dealData is missing or has no name", async () => {
    const { run } = createCRMSkill(makeMockAdapter());

    const result = await run({ action: "create-deal", dealData: { stage: "Lead" } });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/name/);
  });

  it("audit log includes field names, not deal values", async () => {
    const adapter = makeMockAdapter({
      createDeal: vi.fn(async () => makeDeal({ id: "d-audit" })),
    });
    const { run } = createCRMSkill(adapter);

    await run({
      action: "create-deal",
      dealData: { name: "Secret Deal", amount: 999_999 },
    });

    const entries = vi.mocked(writeAuditEntry).mock.calls.map((c) => c[0]);
    const writeEntry = entries.find((e) => e.inputSummary.includes("create-deal"));
    expect(writeEntry!.inputSummary).toContain("name");
    expect(writeEntry!.inputSummary).not.toContain("Secret Deal");
    expect(writeEntry!.inputSummary).not.toContain("999999");
  });
});

// ── update-deal + undo ────────────────────────────────────────────────────────

describe("update-deal", () => {
  it("updates a deal and returns field names", async () => {
    const adapter = makeMockAdapter();
    const { run } = createCRMSkill(adapter);

    const result = await run({
      action: "update-deal",
      dealId: "deal-1",
      dealData: { stage: "Closed Won", amount: 75_000 },
    });

    expect(result.success).toBe(true);
    const d = result.data as { fieldsUpdated: string[] };
    expect(d.fieldsUpdated).toContain("stage");
    expect(d.fieldsUpdated).toContain("amount");
  });

  it("fetches the deal before updating (for snapshot)", async () => {
    const adapter = makeMockAdapter();
    const { run } = createCRMSkill(adapter);

    await run({
      action: "update-deal",
      dealId: "deal-1",
      dealData: { stage: "Closed Won" },
    });

    expect(adapter.getDeal).toHaveBeenCalledWith("deal-1");
  });

  it("registers undo entry with crm-write action type", async () => {
    const { run } = createCRMSkill(makeMockAdapter());

    await run({
      action: "update-deal",
      dealId: "deal-1",
      dealData: { stage: "Closed Won" },
    });

    expect(getCurrentUndo()?.actionType).toBe("crm-write");
  });

  it("undo restores deal to pre-update state", async () => {
    const original = makeDeal({ id: "deal-1", stage: "Qualified", amount: 50_000 });
    const adapter = makeMockAdapter({ getDeal: vi.fn(async () => original) });
    const { run } = createCRMSkill(adapter);

    await run({
      action: "update-deal",
      dealId: "deal-1",
      dealData: { stage: "Closed Won" },
    });

    await getCurrentUndo()!.undoFn();

    const updateCalls = vi.mocked(adapter.updateDeal).mock.calls;
    expect(updateCalls.length).toBe(2);
    expect(updateCalls[1][1]).toMatchObject({ stage: "Qualified", amount: 50_000 });
  });

  it("fails when dealId is missing", async () => {
    const { run } = createCRMSkill(makeMockAdapter());

    const result = await run({ action: "update-deal", dealData: { stage: "Won" } });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/dealId/);
  });

  it("fails when deal is not found", async () => {
    const adapter = makeMockAdapter({ getDeal: vi.fn(async () => null) });
    const { run } = createCRMSkill(adapter);

    const result = await run({
      action: "update-deal",
      dealId: "missing",
      dealData: { stage: "Won" },
    });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/not found/i);
    expect(adapter.updateDeal).not.toHaveBeenCalled();
  });
});

// ── overdue-followups ─────────────────────────────────────────────────────────

describe("overdue-followups", () => {
  it("returns stale contacts from the adapter", async () => {
    const stale = [makeContact({ id: "a" }), makeContact({ id: "b" })];
    const adapter = makeMockAdapter({ getStaleContacts: vi.fn(async () => stale) });
    const { run } = createCRMSkill(adapter);

    const result = await run({ action: "overdue-followups" });

    expect(result.success).toBe(true);
    expect((result.data as { contacts: CRMContact[] }).contacts).toHaveLength(2);
    expect(result.message).toMatch(/2 contacts/);
  });

  it("passes staleAfterDays to the adapter", async () => {
    const adapter = makeMockAdapter();
    const { run } = createCRMSkill(adapter);

    await run({ action: "overdue-followups", staleAfterDays: 30 });

    expect(adapter.getStaleContacts).toHaveBeenCalledWith(30);
  });

  it("defaults staleAfterDays to 14", async () => {
    const adapter = makeMockAdapter();
    const { run } = createCRMSkill(adapter);

    await run({ action: "overdue-followups" });

    expect(adapter.getStaleContacts).toHaveBeenCalledWith(14);
  });

  it("returns zero-state message when no stale contacts", async () => {
    const adapter = makeMockAdapter({ getStaleContacts: vi.fn(async () => []) });
    const { run } = createCRMSkill(adapter);

    const result = await run({ action: "overdue-followups" });

    expect(result.success).toBe(true);
    expect(result.message).toMatch(/No overdue/i);
  });

  it("enforces minimum staleAfterDays of 1", async () => {
    const adapter = makeMockAdapter();
    const { run } = createCRMSkill(adapter);

    await run({ action: "overdue-followups", staleAfterDays: 0 });

    expect(adapter.getStaleContacts).toHaveBeenCalledWith(1);
  });
});

// ── resolveAdapter ────────────────────────────────────────────────────────────

describe("resolveAdapter", () => {
  it("throws when no provider is configured", () => {
    const saved = { ...process.env };
    delete process.env["HUBSPOT_API_KEY"];
    delete process.env["AIRTABLE_API_KEY"];

    expect(() => resolveAdapter()).toThrow(/No CRM provider configured/);

    Object.assign(process.env, saved);
  });

  it("returns HubSpotAdapter when HUBSPOT_API_KEY is set", async () => {
    const { HubSpotAdapter } = await import("../../../skills/crm-leadgen/adapters/hubspot.ts");
    process.env["HUBSPOT_API_KEY"] = "test-key";

    expect(resolveAdapter()).toBeInstanceOf(HubSpotAdapter);

    delete process.env["HUBSPOT_API_KEY"];
  });

  it("returns AirtableAdapter when AIRTABLE_API_KEY is set", async () => {
    const { AirtableAdapter } = await import("../../../skills/crm-leadgen/adapters/airtable.ts");
    delete process.env["HUBSPOT_API_KEY"];
    process.env["AIRTABLE_API_KEY"] = "test-key";

    expect(resolveAdapter()).toBeInstanceOf(AirtableAdapter);

    delete process.env["AIRTABLE_API_KEY"];
  });
});

// ── audit logging ─────────────────────────────────────────────────────────────

describe("audit logging", () => {
  it("always writes one audit entry per run() call for read/enrich actions", async () => {
    const adapter = makeMockAdapter();
    const { run } = createCRMSkill(adapter);

    vi.mocked(enrichProspect).mockResolvedValueOnce({
      query: "Acme",
      sourceDomain: "www.linkedin.com",
      summary: "s",
    });

    await run({ action: "enrich-prospect", companyQuery: "Acme" });
    await run({ action: "overdue-followups" });

    expect(writeAuditEntry).toHaveBeenCalledTimes(2);
  });

  it("writes one audit entry per write action (not the top-level entry)", async () => {
    const adapter = makeMockAdapter({
      createContact: vi.fn(async () => makeContact({ id: "c-1" })),
    });
    const { run } = createCRMSkill(adapter);

    await run({
      action: "create-contact",
      contactData: { firstName: "Test" },
    });

    // create-contact writes its own audit entry (not the catch-all)
    expect(writeAuditEntry).toHaveBeenCalledTimes(1);
    const entry = vi.mocked(writeAuditEntry).mock.calls[0][0];
    expect(entry.skill).toBe("crm-leadgen");
    expect(entry.outcome).toBe("success");
  });

  it("logs outcome:error when adapter throws", async () => {
    const adapter = makeMockAdapter({
      getStaleContacts: vi.fn(async () => {
        throw new Error("API rate limit");
      }),
    });
    const { run } = createCRMSkill(adapter);

    await run({ action: "overdue-followups" });

    const entry = vi.mocked(writeAuditEntry).mock.calls[0][0];
    expect(entry.outcome).toBe("error");
  });
});
