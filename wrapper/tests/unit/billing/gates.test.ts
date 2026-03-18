/**
 * Unit tests for wrapper/billing/gates.ts.
 */

import { describe, expect, it } from "vitest";
import {
  canAccessDashboard,
  canAccessSettings,
  canExportData,
  canRunRecipes,
  canRunSkills,
  isFullAccess,
} from "../../../billing/gates.ts";
import type { License } from "../../../billing/license.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeLicense(tier: "trial" | "pro" | "expired", valid = tier !== "expired"): License {
  return {
    tier,
    trialStartedAt: "2026-01-01T00:00:00.000Z",
    trialEndsAt: "2026-01-31T00:00:00.000Z",
    valid,
  };
}

// ── canRunSkills ──────────────────────────────────────────────────────────────

describe("canRunSkills", () => {
  it("allows trial", () => {
    expect(canRunSkills(makeLicense("trial")).allowed).toBe(true);
  });

  it("allows pro", () => {
    expect(canRunSkills(makeLicense("pro")).allowed).toBe(true);
  });

  it("blocks expired", () => {
    const result = canRunSkills(makeLicense("expired"));
    expect(result.allowed).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it("blocks invalid license (valid: false)", () => {
    const lic = makeLicense("trial", false);
    expect(canRunSkills(lic).allowed).toBe(false);
  });

  it("blocked reason mentions $19/month", () => {
    const result = canRunSkills(makeLicense("expired"));
    expect(result.reason).toContain("$19/month");
  });
});

// ── canRunRecipes ─────────────────────────────────────────────────────────────

describe("canRunRecipes", () => {
  it("allows trial", () => {
    expect(canRunRecipes(makeLicense("trial")).allowed).toBe(true);
  });

  it("blocks expired", () => {
    expect(canRunRecipes(makeLicense("expired")).allowed).toBe(false);
  });
});

// ── canExportData — always allowed ────────────────────────────────────────────

describe("canExportData", () => {
  it("allows trial", () => {
    expect(canExportData(makeLicense("trial")).allowed).toBe(true);
  });

  it("allows pro", () => {
    expect(canExportData(makeLicense("pro")).allowed).toBe(true);
  });

  it("allows expired — never traps the user", () => {
    expect(canExportData(makeLicense("expired")).allowed).toBe(true);
  });
});

// ── canAccessSettings — always allowed ────────────────────────────────────────

describe("canAccessSettings", () => {
  it("allows expired", () => {
    expect(canAccessSettings(makeLicense("expired")).allowed).toBe(true);
  });
});

// ── canAccessDashboard — always allowed ───────────────────────────────────────

describe("canAccessDashboard", () => {
  it("allows expired", () => {
    expect(canAccessDashboard(makeLicense("expired")).allowed).toBe(true);
  });
});

// ── isFullAccess ──────────────────────────────────────────────────────────────

describe("isFullAccess", () => {
  it("trial = full access", () => {
    expect(isFullAccess("trial")).toBe(true);
  });

  it("pro = full access", () => {
    expect(isFullAccess("pro")).toBe(true);
  });

  it("expired = no full access", () => {
    expect(isFullAccess("expired")).toBe(false);
  });
});
