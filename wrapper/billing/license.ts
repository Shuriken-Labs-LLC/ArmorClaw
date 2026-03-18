/**
 * License management — persists to ~/.armorclaw/license.json.
 *
 * On first install: creates a 30-day trial.
 * On each startup: checks expiry, validates Stripe subscription if pro.
 * Never blocks startup on network failure — uses cached result.
 *
 * All I/O and time are injectable for testing.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Types ─────────────────────────────────────────────────────────────────────

export type LicenseTier = "trial" | "pro" | "expired";

export interface License {
  tier: LicenseTier;
  /** ISO 8601 — set once on first install, never changes. */
  trialStartedAt: string;
  /** trialStartedAt + 30 days. */
  trialEndsAt: string;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  /** True when the license allows the agent to run. */
  valid: boolean;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TRIAL_DAYS = 30;
const MS_PER_DAY = 86_400_000;

// ── File path (injectable for testing) ────────────────────────────────────────

let _filePathOverride: string | null = null;

function licensePath(): string {
  return _filePathOverride ?? join(homedir(), ".armorclaw", "license.json");
}

/** Override the file path. Pass null to restore the default. Test use only. */
export function setLicensePathForTesting(path: string | null): void {
  _filePathOverride = path;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function computeTrialEnd(startIso: string): string {
  const start = new Date(startIso);
  return new Date(start.getTime() + TRIAL_DAYS * MS_PER_DAY).toISOString();
}

export function daysRemaining(trialEndsAt: string, now: Date = new Date()): number {
  const end = new Date(trialEndsAt);
  const diff = end.getTime() - now.getTime();
  return Math.max(0, Math.ceil(diff / MS_PER_DAY));
}

// ── Read / write ──────────────────────────────────────────────────────────────

function readLicenseFile(): License | null {
  try {
    const raw = readFileSync(licensePath(), "utf-8");
    return JSON.parse(raw) as License;
  } catch {
    return null;
  }
}

function writeLicenseFile(license: License): void {
  try {
    const dir = join(licensePath(), "..");
    mkdirSync(dir, { recursive: true });
    writeFileSync(licensePath(), JSON.stringify(license, null, 2), "utf-8");
  } catch {
    // Best-effort — in-memory result still returned
  }
}

// ── Trial creation ────────────────────────────────────────────────────────────

export function createTrialLicense(now: Date = new Date()): License {
  const trialStartedAt = now.toISOString();
  const trialEndsAt = computeTrialEnd(trialStartedAt);
  return {
    tier: "trial",
    trialStartedAt,
    trialEndsAt,
    valid: true,
  };
}

// ── Stripe validation (async, never throws) ──────────────────────────────────

export interface StripeValidatorOptions {
  /** Override the fetch function (default: globalThis.fetch). */
  fetchFn?: typeof fetch;
  /** Override the validation endpoint. */
  validationUrl?: string;
}

/**
 * Validate a Stripe subscription against the Cloudflare Worker.
 * Returns true if the subscription is active. Returns the cached `valid`
 * value on any network failure — never blocks startup.
 */
export async function validateStripeSubscription(
  license: License,
  options: StripeValidatorOptions = {},
): Promise<boolean> {
  if (!license.stripeSubscriptionId) {
    return false;
  }

  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const url = options.validationUrl ?? "https://billing.armorclaw.ai/validate";

  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subscriptionId: license.stripeSubscriptionId,
        customerId: license.stripeCustomerId,
      }),
    });
    if (!res.ok) {
      return license.valid;
    } // fallback to cache
    const body = (await res.json()) as { active?: boolean };
    return body.active === true;
  } catch {
    // Network failure — use cached result, never block
    return license.valid;
  }
}

// ── Main entry point ──────────────────────────────────────────────────────────

export interface LoadLicenseOptions {
  /** Override current time. */
  now?: Date;
  /** Override Stripe validation. */
  stripeValidator?: (license: License) => Promise<boolean>;
}

/**
 * Load (or create) the license and check its status.
 *
 * First install:  creates a trial license.
 * Trial expired:  sets tier = "expired", valid = false.
 * Pro:            validates against Stripe (async, fallback to cache).
 *
 * Always returns a License — never throws.
 */
export async function loadLicense(options: LoadLicenseOptions = {}): Promise<License> {
  const now = options.now ?? new Date();
  let license = readLicenseFile();

  // First install — create trial
  if (!license) {
    license = createTrialLicense(now);
    writeLicenseFile(license);
    return license;
  }

  // Trial expiry check
  if (license.tier === "trial" && now.getTime() > new Date(license.trialEndsAt).getTime()) {
    license.tier = "expired";
    license.valid = false;
    writeLicenseFile(license);
    return license;
  }

  // Pro — validate Stripe subscription
  if (license.tier === "pro" && license.stripeSubscriptionId) {
    const validator = options.stripeValidator ?? ((l: License) => validateStripeSubscription(l));
    const active = await validator(license);
    license.valid = active;
    if (!active) {
      license.tier = "expired";
    }
    writeLicenseFile(license);
    return license;
  }

  // Trial still active or other state — return as-is
  return license;
}

/** Reset for test isolation. */
export function clearLicenseForTesting(): void {
  _filePathOverride = null;
}
