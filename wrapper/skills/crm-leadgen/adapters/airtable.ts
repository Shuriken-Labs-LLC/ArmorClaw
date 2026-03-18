/**
 * Airtable CRM adapter for the crm-leadgen skill.
 *
 * Uses the Airtable REST API v0 via gaxios.
 * API key is read from the system keychain via the credential store.
 *
 * Convention: the Airtable base contains a "Contacts" table and a "Deals" table
 * with fields matching the CRMContact / CRMDeal shapes. The base id and table
 * names are read from env vars (AIRTABLE_BASE_ID, AIRTABLE_CONTACTS_TABLE,
 * AIRTABLE_DEALS_TABLE) with sensible defaults.
 *
 * Never stores raw contact data locally — all reads go directly to Airtable.
 */

import { request } from "gaxios";
import { getCredential } from "../../../lib/credential-store.ts";
import type { CRMContact, CRMDeal, ICRMAdapter } from "../types.ts";

// ── Constants ─────────────────────────────────────────────────────────────────

const AT_BASE_URL = "https://api.airtable.com/v0";
const KEYCHAIN_SERVICE = "armorclaw-airtable";
const KEYCHAIN_ACCOUNT = "api-key";

function baseId(): string {
  return process.env["AIRTABLE_BASE_ID"] ?? "";
}
function contactsTable(): string {
  return process.env["AIRTABLE_CONTACTS_TABLE"] ?? "Contacts";
}
function dealsTable(): string {
  return process.env["AIRTABLE_DEALS_TABLE"] ?? "Deals";
}

// ── Internal resource shapes ──────────────────────────────────────────────────

interface AirtableContactFields {
  "First Name"?: string;
  "Last Name"?: string;
  Email?: string;
  Phone?: string;
  Company?: string;
  "Job Title"?: string;
  "Last Contacted"?: string;
  "Created At"?: string;
  Notes?: string;
  [key: string]: unknown;
}

interface AirtableRecord<T> {
  id: string;
  fields: T;
  createdTime?: string;
}

interface AirtableDealFields {
  Name?: string;
  Stage?: string;
  Amount?: number;
  Currency?: string;
  "Close Date"?: string;
  "Contact ID"?: string;
  "Owner ID"?: string;
  [key: string]: unknown;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseContact(raw: AirtableRecord<AirtableContactFields>): CRMContact {
  const f = raw.fields;
  return {
    id: raw.id,
    firstName: f["First Name"],
    lastName: f["Last Name"],
    email: f.Email,
    phone: f.Phone,
    company: f.Company,
    jobTitle: f["Job Title"],
    lastContactedAt: f["Last Contacted"],
    createdAt: f["Created At"] ?? raw.createdTime,
    notes: f.Notes,
  };
}

function parseDeal(raw: AirtableRecord<AirtableDealFields>): CRMDeal {
  const f = raw.fields;
  return {
    id: raw.id,
    name: f.Name ?? "",
    stage: f.Stage,
    amount: f.Amount,
    currency: f.Currency,
    closeDate: f["Close Date"],
    contactId: f["Contact ID"],
    ownerId: f["Owner ID"],
    createdAt: raw.createdTime,
  };
}

async function authHeader(): Promise<string> {
  const key = await getCredential(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
  if (!key) {
    throw new Error("Airtable is not connected. Add your Airtable API key in Settings.");
  }
  return `Bearer ${key}`;
}

function tableUrl(table: string): string {
  const base = baseId();
  if (!base) {
    throw new Error("AIRTABLE_BASE_ID is not configured. Set it in your .env or Settings.");
  }
  return `${AT_BASE_URL}/${base}/${encodeURIComponent(table)}`;
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export class AirtableAdapter implements ICRMAdapter {
  async getContact(contactId: string): Promise<CRMContact | null> {
    const auth = await authHeader();
    try {
      const res = await request<AirtableRecord<AirtableContactFields>>({
        url: `${tableUrl(contactsTable())}/${contactId}`,
        headers: { Authorization: auth },
      });
      return parseContact(res.data);
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response?.status;
      if (status === 404) return null;
      throw err;
    }
  }

  async searchContacts(query: string): Promise<CRMContact[]> {
    const auth = await authHeader();
    // Airtable filterByFormula: match against name or email fields
    const formula =
      `OR(SEARCH("${query.replace(/"/g, '\\"')}",LOWER({First Name}&" "&{Last Name})),` +
      `SEARCH("${query.replace(/"/g, '\\"')}",LOWER({Email})))`;

    const res = await request<{ records?: AirtableRecord<AirtableContactFields>[] }>({
      url: tableUrl(contactsTable()),
      headers: { Authorization: auth },
      params: { filterByFormula: formula, maxRecords: 50 },
    });

    return (res.data.records ?? []).map(parseContact);
  }

  async createContact(data: Omit<CRMContact, "id">): Promise<CRMContact> {
    const auth = await authHeader();
    const res = await request<AirtableRecord<AirtableContactFields>>({
      url: tableUrl(contactsTable()),
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      data: {
        fields: {
          "First Name": data.firstName,
          "Last Name": data.lastName,
          Email: data.email,
          Phone: data.phone,
          Company: data.company,
          "Job Title": data.jobTitle,
          Notes: data.notes,
        },
      },
    });
    return parseContact(res.data);
  }

  async updateContact(contactId: string, data: Partial<CRMContact>): Promise<CRMContact> {
    const auth = await authHeader();
    const fields: AirtableContactFields = {};
    if (data.firstName !== undefined) fields["First Name"] = data.firstName;
    if (data.lastName !== undefined) fields["Last Name"] = data.lastName;
    if (data.email !== undefined) fields.Email = data.email;
    if (data.phone !== undefined) fields.Phone = data.phone;
    if (data.company !== undefined) fields.Company = data.company;
    if (data.jobTitle !== undefined) fields["Job Title"] = data.jobTitle;
    if (data.notes !== undefined) fields.Notes = data.notes;
    if (data.lastContactedAt !== undefined) fields["Last Contacted"] = data.lastContactedAt;

    const res = await request<AirtableRecord<AirtableContactFields>>({
      url: `${tableUrl(contactsTable())}/${contactId}`,
      method: "PATCH",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      data: { fields },
    });
    return parseContact(res.data);
  }

  async getStaleContacts(daysSince: number): Promise<CRMContact[]> {
    const auth = await authHeader();
    const cutoff = new Date(Date.now() - daysSince * 86_400_000).toISOString().slice(0, 10);

    // Match contacts where Last Contacted is before cutoff OR the field is empty
    const formula = `OR(IS_BEFORE({Last Contacted},"${cutoff}"),{Last Contacted}="",NOT({Last Contacted}))`;

    const res = await request<{ records?: AirtableRecord<AirtableContactFields>[] }>({
      url: tableUrl(contactsTable()),
      headers: { Authorization: auth },
      params: {
        filterByFormula: formula,
        maxRecords: 50,
        sort: [{ field: "Last Contacted", direction: "asc" }],
      },
    });

    return (res.data.records ?? []).map(parseContact);
  }

  async getDeal(dealId: string): Promise<CRMDeal | null> {
    const auth = await authHeader();
    try {
      const res = await request<AirtableRecord<AirtableDealFields>>({
        url: `${tableUrl(dealsTable())}/${dealId}`,
        headers: { Authorization: auth },
      });
      return parseDeal(res.data);
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response?.status;
      if (status === 404) return null;
      throw err;
    }
  }

  async createDeal(data: Omit<CRMDeal, "id">): Promise<CRMDeal> {
    const auth = await authHeader();
    const res = await request<AirtableRecord<AirtableDealFields>>({
      url: tableUrl(dealsTable()),
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      data: {
        fields: {
          Name: data.name,
          Stage: data.stage,
          Amount: data.amount,
          Currency: data.currency,
          "Close Date": data.closeDate,
          "Contact ID": data.contactId,
        },
      },
    });
    return parseDeal(res.data);
  }

  async updateDeal(dealId: string, data: Partial<CRMDeal>): Promise<CRMDeal> {
    const auth = await authHeader();
    const fields: AirtableDealFields = {};
    if (data.name !== undefined) fields.Name = data.name;
    if (data.stage !== undefined) fields.Stage = data.stage;
    if (data.amount !== undefined) fields.Amount = data.amount;
    if (data.closeDate !== undefined) fields["Close Date"] = data.closeDate;

    const res = await request<AirtableRecord<AirtableDealFields>>({
      url: `${tableUrl(dealsTable())}/${dealId}`,
      method: "PATCH",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      data: { fields },
    });
    return parseDeal(res.data);
  }
}
