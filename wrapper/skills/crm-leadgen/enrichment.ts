/**
 * Prospect enrichment — fetch public data from allowlisted domains only.
 *
 * Allowlist: LinkedIn public profiles and company websites listed in
 * ENRICHMENT_ALLOWED_DOMAINS. Gated pages (login-required) are never scraped.
 * Raw HTML is stripped; only plain-text summaries are returned.
 *
 * Network calls use the network:outbound permission.
 */

import { request } from "gaxios";
import type { EnrichmentResult } from "./types.ts";

// ── Allowlist ─────────────────────────────────────────────────────────────────

/**
 * Domains from which enrichment data may be fetched.
 * LinkedIn is included for public profile pages only.
 * Login-required pages return HTTP 999/redirect and are silently skipped.
 */
export const ENRICHMENT_ALLOWED_DOMAINS: ReadonlySet<string> = new Set([
  "linkedin.com",
  "www.linkedin.com",
  "crunchbase.com",
  "www.crunchbase.com",
  "clearbit.com",
  "company.clearbit.com",
]);

const MAX_BODY_BYTES = 32_768; // 32 KB — enough for public profile snippets
const FETCH_TIMEOUT_MS = 8_000;

// ── Allowlist guard ───────────────────────────────────────────────────────────

/**
 * Returns true only if `url` is an https URL pointing to an allowlisted domain.
 * Exported for testing without network calls.
 */
export function isEnrichmentAllowed(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && ENRICHMENT_ALLOWED_DOMAINS.has(parsed.hostname);
  } catch {
    return false;
  }
}

// ── Text extraction ───────────────────────────────────────────────────────────

/**
 * Strip HTML tags and collapse whitespace to produce a plain-text summary.
 * Limits output to `maxChars` characters.
 */
export function extractText(html: string, maxChars = 1_200): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

// ── Main enrichment function ──────────────────────────────────────────────────

/**
 * Fetch public enrichment data for a prospect.
 *
 * Builds candidate URLs from the query, filters to the allowlist, fetches the
 * first permitted URL, and returns a plain-text summary.
 *
 * @throws  When no allowlisted URL can be constructed from the query.
 */
export async function enrichProspect(
  companyQuery: string,
  contactQuery?: string,
): Promise<EnrichmentResult> {
  // Build candidate LinkedIn / Clearbit URLs from the query
  const companySlug = companyQuery
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  const candidates: string[] = [
    `https://company.clearbit.com/v1/companies/domain/${companySlug}.com`,
    `https://www.linkedin.com/company/${companySlug}`,
  ];

  if (contactQuery) {
    const contactSlug = contactQuery
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    candidates.push(`https://www.linkedin.com/in/${contactSlug}`);
  }

  const allowed = candidates.filter(isEnrichmentAllowed);
  if (allowed.length === 0) {
    throw new Error(
      `No allowlisted enrichment URL could be constructed for query: "${companyQuery}". ` +
        `Only ${[...ENRICHMENT_ALLOWED_DOMAINS].join(", ")} are permitted.`,
    );
  }

  // Try each candidate; return on first successful fetch
  for (const url of allowed) {
    try {
      const res = await request<string>({
        url,
        method: "GET",
        responseType: "text",
        timeout: FETCH_TIMEOUT_MS,
        headers: {
          "User-Agent": "ArmorClaw/1.0 (public data enrichment)",
          Accept: "text/html,application/json",
        },
      });

      // Gated pages redirect to login — treat non-200 as not available
      if (typeof res.data !== "string" || res.data.length === 0) {
        continue;
      }

      const rawText = (res.data as string).slice(0, MAX_BODY_BYTES);
      const summary = extractText(rawText);

      const hostname = new URL(url).hostname;

      return {
        query: companyQuery,
        sourceDomain: hostname,
        summary: summary || `No public data found for "${companyQuery}" on ${hostname}.`,
        companyName: companyQuery,
      };
    } catch {
      // Network error or non-200 — try next candidate
    }
  }

  // All candidates failed — return a structured empty result rather than throwing
  return {
    query: companyQuery,
    sourceDomain: "none",
    summary: `No public data could be retrieved for "${companyQuery}". The company may not have a public profile on supported sources.`,
    companyName: companyQuery,
  };
}
