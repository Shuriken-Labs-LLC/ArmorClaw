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

function makeLicense(tier: "active" | "inactive", valid = tier === "active"): License {
  return {
    tier,
    installId: "00000000-0000-0000-0000-000000000000",
    valid,
  };
}

// ── canRunSkills ──────────────────────────────────────────────────────────────

describe("canRunSkills", () => {
  it("allows active", () => {
    expect(canRunSkills(makeLicense("active")).allowed).toBe(true);
  });

  it("blocks inactive", () => {
    const result = canRunSkills(makeLicense("inactive"));
    expect(result.allowed).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it("blocks invalid license (valid: false)", () => {
    const lic = makeLicense("active", false);
    expect(canRunSkills(lic).allowed).toBe(false);
  });

  it("blocked reason mentions $19/month", () => {
    const result = canRunSkills(makeLicense("inactive"));
    expect(result.reason).toContain("$19/month");
  });
});

// ── canRunRecipes ─────────────────────────────────────────────────────────────

describe("canRunRecipes", () => {
  it("allows active", () => {
    expect(canRunRecipes(makeLicense("active")).allowed).toBe(true);
  });

  it("blocks inactive", () => {
    expect(canRunRecipes(makeLicense("inactive")).allowed).toBe(false);
  });
});

// ── canExportData — always allowed ────────────────────────────────────────────

describe("canExportData", () => {
  it("allows active", () => {
    expect(canExportData(makeLicense("active")).allowed).toBe(true);
  });

  it("allows inactive — never traps the user", () => {
    expect(canExportData(makeLicense("inactive")).allowed).toBe(true);
  });
});

// ── canAccessSettings — always allowed ────────────────────────────────────────

describe("canAccessSettings", () => {
  it("allows inactive", () => {
    expect(canAccessSettings(makeLicense("inactive")).allowed).toBe(true);
  });
});

// ── canAccessDashboard — always allowed ───────────────────────────────────────

describe("canAccessDashboard", () => {
  it("allows inactive", () => {
    expect(canAccessDashboard(makeLicense("inactive")).allowed).toBe(true);
  });
});

// ── isFullAccess ──────────────────────────────────────────────────────────────

describe("isFullAccess", () => {
  it("active = full access", () => {
    expect(isFullAccess("active")).toBe(true);
  });

  it("inactive = no full access", () => {
    expect(isFullAccess("inactive")).toBe(false);
  });
});
