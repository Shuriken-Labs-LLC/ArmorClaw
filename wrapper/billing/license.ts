/**
 * License management — persists to ~/.armorclaw/license.json.
 *
 * Two states:
 *   active   — Stripe subscription confirmed
 *   inactive — no checkout yet, or Stripe subscription lapsed
 *
 * The free month is configured on the Stripe price object, not in the app.
 * On first install: creates an inactive license with a fresh installId.
 * On each startup: validates Stripe subscription if active, and polls the
 *                  billing Worker to see whether the user has completed checkout.
 * Never blocks startup on network failure — uses cached result.
 *
 * All I/O and time are injectable for testing.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Types ─────────────────────────────────────────────────────────────────────

export type LicenseTier = "active" | "inactive";

export interface License {
  tier: LicenseTier;
  /** UUID — set once on first install, never regenerated. Used as Stripe client_reference_id. */
  installId: string;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  /** True when the license allows the agent to run. */
  valid: boolean;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const VALIDATION_URL = "https://armorclaw-billing.armorclaw.workers.dev/validate";

// ── File path (injectable for testing) ────────────────────────────────────────

let _filePathOverride: string | null = null;

function licensePath(): string {
  return _filePathOverride ?? join(homedir(), ".armorclaw", "license.json");
}

/** Override the file path. Pass null to restore the default. Test use only. */
export function setLicensePathForTesting(path: string | null): void {
  _filePathOverride = path;
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

// ── License creation ──────────────────────────────────────────────────────────

export function createInactiveLicense(): License {
  return {
    tier: "inactive",
    installId: randomUUID(),
    valid: false,
  };
}

// ── Stripe validation (async, never throws) ──────────────────────────────────

export interface StripeValidatorOptions {
  /** Override the fetch function (default: globalThis.fetch). */
  fetchFn?: typeof fetch;
  /** Override the validation endpoint. */
  validationUrl?: string;
}

export interface ValidateResponse {
  active?: boolean;
  subscriptionId?: string;
  customerId?: string;
}

/**
 * Validate a license against the billing Worker.
 *
 * The Worker accepts an installId and looks up the subscription from KV
 * (populated when the Stripe webhook fires after checkout). If the install
 * has no recorded subscription yet, the Worker returns { active: false }.
 *
 * Returns the cached `valid` value on any network failure — never blocks startup.
 */
export async function validateStripeSubscription(
  license: License,
  options: StripeValidatorOptions = {},
): Promise<boolean> {
  if (!license.installId) {
    return false;
  }

  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const url = options.validationUrl ?? VALIDATION_URL;

  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ installId: license.installId }),
    });
    if (!res.ok) {
      return license.valid;
    } // fallback to cache
    const body = (await res.json()) as ValidateResponse;
    return body.active === true;
  } catch {
    // Network failure — use cached result, never block
    return license.valid;
  }
}

// ── Main entry point ──────────────────────────────────────────────────────────

export interface LoadLicenseOptions {
  /** Override Stripe validation. */
  stripeValidator?: (license: License) => Promise<boolean>;
}

/**
 * Load (or create) the license and check its status.
 *
 * First install:  creates an inactive license with a fresh installId.
 * Active:         validates against Stripe (async, fallback to cache).
 *                 If Stripe says no, sets tier = "inactive", valid = false.
 *
 * Always returns a License — never throws.
 */
export async function loadLicense(options: LoadLicenseOptions = {}): Promise<License> {
  let license = readLicenseFile();

  // First install — create inactive license
  if (!license) {
    license = createInactiveLicense();
    writeLicenseFile(license);
    return license;
  }

  // Backfill installId for licenses created before this field existed
  if (!license.installId) {
    license.installId = randomUUID();
    writeLicenseFile(license);
  }

  // Migrate legacy tier values to active/inactive
  if (!["active", "inactive"].includes(license.tier)) {
    const legacyTier = license.tier as string;
    if (legacyTier === "pro") {
      license.tier = "active";
    } else {
      license.tier = "inactive";
      license.valid = false;
    }
    writeLicenseFile(license);
    return license;
  }

  // Active — validate Stripe subscription
  if (license.tier === "active" && license.stripeSubscriptionId) {
    const validator = options.stripeValidator ?? ((l: License) => validateStripeSubscription(l));
    const active = await validator(license);
    license.valid = active;
    if (!active) {
      license.tier = "inactive";
    }
    writeLicenseFile(license);
    return license;
  }

  return license;
}

// ── Inactive → Active activation poll ─────────────────────────────────────────

export interface PollForActivationOptions {
  /** Override the fetch function (default: globalThis.fetch). */
  fetchFn?: typeof fetch;
  /** Override the validation endpoint. */
  validationUrl?: string;
}

/**
 * If the license is `inactive` and has an installId, ask the billing Worker
 * whether the user has completed checkout since last run. If the Worker
 * returns { active: true, subscriptionId, customerId }, promote the license
 * to `active` and persist.
 *
 * Never throws — fails silently and returns the input license unchanged on
 * any network or parse failure. Safe to call on every startup.
 */
export async function pollForActivation(
  license: License,
  options: PollForActivationOptions = {},
): Promise<License> {
  if (license.tier !== "inactive" || !license.installId) {
    return license;
  }

  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const url = options.validationUrl ?? VALIDATION_URL;

  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ installId: license.installId }),
    });
    if (!res.ok) {
      return license;
    }
    const body = (await res.json()) as ValidateResponse;
    if (body.active === true && body.subscriptionId && body.customerId) {
      const promoted: License = {
        ...license,
        tier: "active",
        stripeCustomerId: body.customerId,
        stripeSubscriptionId: body.subscriptionId,
        valid: true,
      };
      writeLicenseFile(promoted);
      return promoted;
    }
    return license;
  } catch {
    return license;
  }
}

/** Reset for test isolation. */
export function clearLicenseForTesting(): void {
  _filePathOverride = null;
}
