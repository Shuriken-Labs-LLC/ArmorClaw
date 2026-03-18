/**
 * Shared types for the crm-leadgen skill and its provider adapters.
 */

// ── Domain types ──────────────────────────────────────────────────────────────

/** A CRM contact record. */
export interface CRMContact {
  id: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  company?: string;
  jobTitle?: string;
  /** ISO 8601 — when this contact was last contacted by the user. */
  lastContactedAt?: string;
  /** ISO 8601 — when this contact was created in the CRM. */
  createdAt?: string;
  /** Free-form notes or status (provider-specific). */
  notes?: string;
  /** Provider-specific extra fields (never logged as values). */
  [key: string]: unknown;
}

/** A CRM deal / opportunity record. */
export interface CRMDeal {
  id: string;
  name: string;
  stage?: string;
  amount?: number;
  currency?: string;
  contactId?: string;
  ownerId?: string;
  /** ISO 8601 — expected close date. */
  closeDate?: string;
  /** ISO 8601. */
  createdAt?: string;
}

/** A follow-up sequence item — one message in a sequence. */
export interface FollowUpItem {
  /** 1-indexed step number. */
  step: number;
  /** ISO 8601 scheduled send time. */
  scheduledAt: string;
  subject: string;
  body: string;
}

/** A full follow-up sequence for a contact. */
export interface FollowUpSequence {
  contactId: string;
  contactName: string;
  items: FollowUpItem[];
  /** ISO 8601 — when this sequence was drafted. */
  createdAt: string;
}

/** A snapshot of a CRM record before an update, used for undo. */
export interface CRMRecordSnapshot {
  recordType: "contact" | "deal";
  recordId: string;
  /** Full record state before the write. */
  before: CRMContact | CRMDeal;
}

// ── Enrichment types ──────────────────────────────────────────────────────────

/** Public enrichment data fetched from allowlisted domains only. */
export interface EnrichmentResult {
  query: string;
  /** Domain that was the primary source for this result. */
  sourceDomain: string;
  /** Plain-text summary — no raw HTML, no scraped gated content. */
  summary: string;
  companyName?: string;
  industry?: string;
  employeeRange?: string;
  linkedinUrl?: string;
}

// ── Adapter interface ─────────────────────────────────────────────────────────

/**
 * Provider-agnostic interface every CRM adapter must implement.
 * All methods that write to the CRM must return enough data to populate
 * a CRMRecordSnapshot for undo purposes.
 */
export interface ICRMAdapter {
  /** Fetch a contact by id. Returns null if not found. */
  getContact(contactId: string): Promise<CRMContact | null>;

  /** Search contacts by name or email. Returns up to 50 results. */
  searchContacts(query: string): Promise<CRMContact[]>;

  /**
   * Create a new contact record.
   * Returns the created record with provider-assigned id.
   */
  createContact(data: Omit<CRMContact, "id">): Promise<CRMContact>;

  /**
   * Update an existing contact record.
   * Returns the updated record. Caller must have fetched the previous state
   * before calling this (for undo snapshot).
   */
  updateContact(contactId: string, data: Partial<CRMContact>): Promise<CRMContact>;

  /** Fetch contacts that have not been contacted since `daysSince` days ago. */
  getStaleContacts(daysSince: number): Promise<CRMContact[]>;

  /** Fetch a deal by id. Returns null if not found. */
  getDeal(dealId: string): Promise<CRMDeal | null>;

  /**
   * Create a new deal record.
   * Returns the created deal with provider-assigned id.
   */
  createDeal(data: Omit<CRMDeal, "id">): Promise<CRMDeal>;

  /**
   * Update an existing deal record.
   * Returns the updated deal.
   */
  updateDeal(dealId: string, data: Partial<CRMDeal>): Promise<CRMDeal>;
}

// ── Skill I/O ──────────────────────────────────────────────────────────────────

export type CRMAction =
  | "enrich-prospect" //    public-web enrichment, allowlisted domains only
  | "draft-followup" //     generate follow-up sequence for review (never auto-send)
  | "create-contact" //     create a new CRM contact record
  | "update-contact" //     update an existing CRM contact record
  | "create-deal" //        create a new deal record
  | "update-deal" //        update an existing deal record
  | "overdue-followups"; // surface contacts that are stale / overdue for contact

export interface CRMInput {
  action: CRMAction;

  // ── enrich-prospect ──
  /** Company name or domain to research. */
  companyQuery?: string;
  /** Contact name to research alongside the company. */
  contactQuery?: string;

  // ── draft-followup ──
  /** Contact id to draft a follow-up sequence for. */
  contactId?: string;
  /** Number of steps to draft (default 3). */
  sequenceSteps?: number;
  /** Spacing between steps in days (default 3). */
  stepIntervalDays?: number;
  /** Context hint for the sequence (e.g. "demo call last week"). */
  context?: string;

  // ── create-contact / update-contact ──
  contactData?: Partial<CRMContact>;

  // ── create-deal / update-deal ──
  dealId?: string;
  dealData?: Partial<CRMDeal>;

  // ── overdue-followups ──
  /** Flag contacts not contacted in this many days (default 14). */
  staleAfterDays?: number;

  // ── provider selection ──
  provider?: "hubspot" | "airtable";
}

export interface CRMOutput {
  success: boolean;
  message: string;
  data?: unknown;
  /**
   * Present when action='draft-followup'.
   * Sequence is ready for user review — no messages have been sent.
   */
  pendingSequence?: FollowUpSequence;
}
