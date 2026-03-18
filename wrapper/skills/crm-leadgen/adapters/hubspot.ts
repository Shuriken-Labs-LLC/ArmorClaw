/**
 * HubSpot CRM adapter for the crm-leadgen skill.
 *
 * Uses the HubSpot CRM v3 REST API via gaxios.
 * API key is read from the system keychain via the credential store.
 * Never stores raw contact data locally — all reads go directly to HubSpot.
 */

import { request } from "gaxios";
import { getCredential } from "../../../lib/credential-store.ts";
import type { CRMContact, CRMDeal, ICRMAdapter } from "../types.ts";

// ── Constants ─────────────────────────────────────────────────────────────────

const HS_BASE = "https://api.hubapi.com/crm/v3";
const KEYCHAIN_SERVICE = "armorclaw-hubspot";
const KEYCHAIN_ACCOUNT = "api-key";

// ── Internal resource shapes ──────────────────────────────────────────────────

interface HSProperties {
  firstname?: string;
  lastname?: string;
  email?: string;
  phone?: string;
  company?: string;
  jobtitle?: string;
  notes_last_contacted?: string;
  createdate?: string;
  [key: string]: string | undefined;
}

interface HSContactResource {
  id: string;
  properties: HSProperties;
}

interface HSDealProperties {
  dealname?: string;
  dealstage?: string;
  amount?: string;
  closedate?: string;
  createdate?: string;
  hubspot_owner_id?: string;
  [key: string]: string | undefined;
}

interface HSDealResource {
  id: string;
  properties: HSDealProperties;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseContact(raw: HSContactResource): CRMContact {
  const p = raw.properties;
  return {
    id: raw.id,
    firstName: p.firstname,
    lastName: p.lastname,
    email: p.email,
    phone: p.phone,
    company: p.company,
    jobTitle: p.jobtitle,
    lastContactedAt: p.notes_last_contacted,
    createdAt: p.createdate,
  };
}

function parseDeal(raw: HSDealResource): CRMDeal {
  const p = raw.properties;
  return {
    id: raw.id,
    name: p.dealname ?? "",
    stage: p.dealstage,
    amount: p.amount ? Number(p.amount) : undefined,
    ownerId: p.hubspot_owner_id,
    closeDate: p.closedate,
    createdAt: p.createdate,
  };
}

async function authHeaders(): Promise<Record<string, string>> {
  const key = await getCredential(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
  if (!key) {
    throw new Error("HubSpot is not connected. Add your HubSpot API key in Settings.");
  }
  return { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

const CONTACT_PROPS =
  "firstname,lastname,email,phone,company,jobtitle,notes_last_contacted,createdate";

// ── Adapter ───────────────────────────────────────────────────────────────────

export class HubSpotAdapter implements ICRMAdapter {
  async getContact(contactId: string): Promise<CRMContact | null> {
    const headers = await authHeaders();
    try {
      const res = await request<HSContactResource>({
        url: `${HS_BASE}/objects/contacts/${contactId}`,
        headers,
        params: { properties: CONTACT_PROPS },
      });
      return parseContact(res.data);
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response?.status;
      if (status === 404) return null;
      throw err;
    }
  }

  async searchContacts(query: string): Promise<CRMContact[]> {
    const headers = await authHeaders();
    const res = await request<{ results?: HSContactResource[] }>({
      url: `${HS_BASE}/objects/contacts/search`,
      method: "POST",
      headers,
      data: {
        query,
        limit: 50,
        properties: CONTACT_PROPS.split(","),
      },
    });
    return (res.data.results ?? []).map(parseContact);
  }

  async createContact(data: Omit<CRMContact, "id">): Promise<CRMContact> {
    const headers = await authHeaders();
    const res = await request<HSContactResource>({
      url: `${HS_BASE}/objects/contacts`,
      method: "POST",
      headers,
      data: {
        properties: {
          firstname: data.firstName,
          lastname: data.lastName,
          email: data.email,
          phone: data.phone,
          company: data.company,
          jobtitle: data.jobTitle,
        },
      },
    });
    return parseContact(res.data);
  }

  async updateContact(contactId: string, data: Partial<CRMContact>): Promise<CRMContact> {
    const headers = await authHeaders();
    const res = await request<HSContactResource>({
      url: `${HS_BASE}/objects/contacts/${contactId}`,
      method: "PATCH",
      headers,
      data: {
        properties: {
          ...(data.firstName !== undefined && { firstname: data.firstName }),
          ...(data.lastName !== undefined && { lastname: data.lastName }),
          ...(data.email !== undefined && { email: data.email }),
          ...(data.phone !== undefined && { phone: data.phone }),
          ...(data.company !== undefined && { company: data.company }),
          ...(data.jobTitle !== undefined && { jobtitle: data.jobTitle }),
          ...(data.notes !== undefined && { hs_note_body: data.notes }),
        },
      },
    });
    return parseContact(res.data);
  }

  async getStaleContacts(daysSince: number): Promise<CRMContact[]> {
    const headers = await authHeaders();
    const cutoff = new Date(Date.now() - daysSince * 86_400_000).toISOString();

    const res = await request<{ results?: HSContactResource[] }>({
      url: `${HS_BASE}/objects/contacts/search`,
      method: "POST",
      headers,
      data: {
        filterGroups: [
          {
            filters: [
              {
                propertyName: "notes_last_contacted",
                operator: "LT",
                value: cutoff,
              },
            ],
          },
          {
            filters: [
              {
                propertyName: "notes_last_contacted",
                operator: "NOT_HAS_PROPERTY",
              },
            ],
          },
        ],
        limit: 50,
        properties: CONTACT_PROPS.split(","),
        sorts: [{ propertyName: "notes_last_contacted", direction: "ASCENDING" }],
      },
    });

    return (res.data.results ?? []).map(parseContact);
  }

  async getDeal(dealId: string): Promise<CRMDeal | null> {
    const headers = await authHeaders();
    try {
      const res = await request<HSDealResource>({
        url: `${HS_BASE}/objects/deals/${dealId}`,
        headers,
        params: { properties: "dealname,dealstage,amount,closedate,createdate,hubspot_owner_id" },
      });
      return parseDeal(res.data);
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response?.status;
      if (status === 404) return null;
      throw err;
    }
  }

  async createDeal(data: Omit<CRMDeal, "id">): Promise<CRMDeal> {
    const headers = await authHeaders();
    const res = await request<HSDealResource>({
      url: `${HS_BASE}/objects/deals`,
      method: "POST",
      headers,
      data: {
        properties: {
          dealname: data.name,
          dealstage: data.stage,
          amount: data.amount !== undefined ? String(data.amount) : undefined,
          closedate: data.closeDate,
        },
      },
    });
    return parseDeal(res.data);
  }

  async updateDeal(dealId: string, data: Partial<CRMDeal>): Promise<CRMDeal> {
    const headers = await authHeaders();
    const res = await request<HSDealResource>({
      url: `${HS_BASE}/objects/deals/${dealId}`,
      method: "PATCH",
      headers,
      data: {
        properties: {
          ...(data.name !== undefined && { dealname: data.name }),
          ...(data.stage !== undefined && { dealstage: data.stage }),
          ...(data.amount !== undefined && { amount: String(data.amount) }),
          ...(data.closeDate !== undefined && { closedate: data.closeDate }),
        },
      },
    });
    return parseDeal(res.data);
  }
}
