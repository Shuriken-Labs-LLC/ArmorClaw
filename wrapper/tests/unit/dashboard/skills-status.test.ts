/**
 * Unit tests for the GET /api/skills/bundled endpoint logic.
 *
 * Tests getBundledSkillStatuses() with various .env configurations.
 * No real file I/O — env is injected as a plain Record<string, string>.
 *
 * Coverage target: 80%+ line coverage on getBundledSkillStatuses.
 */

import { describe, expect, it } from "vitest";
import { getBundledSkillStatuses } from "../../../dashboard/server.ts";
import type { BundledSkillStatus } from "../../../dashboard/server.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

function findSkill(statuses: BundledSkillStatus[], id: string): BundledSkillStatus | undefined {
  return statuses.find((s) => s.id === id);
}

// ── email-calendar ────────────────────────────────────────────────────────────

describe("email-calendar status", () => {
  it("active when GOOGLE_CLIENT_ID is set", () => {
    const env = { GOOGLE_CLIENT_ID: "282171340527-xxx.apps.googleusercontent.com" };
    const result = findSkill(getBundledSkillStatuses(env), "email-calendar")!;
    expect(result.status).toBe("active");
    expect(result.missingConfig).toBeUndefined();
  });

  it("active when GOOGLE_AUTH_CODE_PENDING is set", () => {
    const env = { GOOGLE_AUTH_CODE_PENDING: "4/0AfrIepBq..." };
    const result = findSkill(getBundledSkillStatuses(env), "email-calendar")!;
    expect(result.status).toBe("active");
  });

  it("active when MICROSOFT_CLIENT_ID is set", () => {
    const env = { MICROSOFT_CLIENT_ID: "abc-123" };
    const result = findSkill(getBundledSkillStatuses(env), "email-calendar")!;
    expect(result.status).toBe("active");
  });

  it("active when MICROSOFT_AUTH_CODE_PENDING is set", () => {
    const env = { MICROSOFT_AUTH_CODE_PENDING: "M.R3_abc" };
    const result = findSkill(getBundledSkillStatuses(env), "email-calendar")!;
    expect(result.status).toBe("active");
  });

  it("not_configured when no email env vars", () => {
    const result = findSkill(getBundledSkillStatuses({}), "email-calendar")!;
    expect(result.status).toBe("not_configured");
    expect(result.missingConfig).toContain("Gmail or Outlook");
    expect(result.missingConfig).toContain("Settings");
  });

  it("not_configured when only unrelated env vars are set", () => {
    const env = { HUBSPOT_API_KEY: "hk_123", ARMORCLAW_MODEL_PROVIDER: "anthropic" };
    const result = findSkill(getBundledSkillStatuses(env), "email-calendar")!;
    expect(result.status).toBe("not_configured");
  });
});

// ── crm-leadgen ───────────────────────────────────────────────────────────────

describe("crm-leadgen status", () => {
  it("active when HUBSPOT_API_KEY is set", () => {
    const env = { HUBSPOT_API_KEY: "hk_test_123" };
    const result = findSkill(getBundledSkillStatuses(env), "crm-leadgen")!;
    expect(result.status).toBe("active");
    expect(result.missingConfig).toBeUndefined();
  });

  it("active when AIRTABLE_API_KEY is set", () => {
    const env = { AIRTABLE_API_KEY: "patABC123" };
    const result = findSkill(getBundledSkillStatuses(env), "crm-leadgen")!;
    expect(result.status).toBe("active");
  });

  it("active when both CRM keys are set", () => {
    const env = { HUBSPOT_API_KEY: "hk_123", AIRTABLE_API_KEY: "patABC" };
    const result = findSkill(getBundledSkillStatuses(env), "crm-leadgen")!;
    expect(result.status).toBe("active");
  });

  it("not_configured when no CRM env vars", () => {
    const result = findSkill(getBundledSkillStatuses({}), "crm-leadgen")!;
    expect(result.status).toBe("not_configured");
    expect(result.missingConfig).toContain("HubSpot or Airtable");
    expect(result.missingConfig).toContain("Settings");
  });
});

// ── secure-files ──────────────────────────────────────────────────────────────

describe("secure-files status", () => {
  it("always active with empty env", () => {
    const result = findSkill(getBundledSkillStatuses({}), "secure-files")!;
    expect(result.status).toBe("active");
    expect(result.missingConfig).toBeUndefined();
  });

  it("always active regardless of env content", () => {
    const env = { GOOGLE_CLIENT_ID: "x", HUBSPOT_API_KEY: "y" };
    const result = findSkill(getBundledSkillStatuses(env), "secure-files")!;
    expect(result.status).toBe("active");
  });
});

// ── browser ───────────────────────────────────────────────────────────────────

describe("browser status", () => {
  it("always active with empty env", () => {
    const result = findSkill(getBundledSkillStatuses({}), "browser")!;
    expect(result.status).toBe("active");
    expect(result.missingConfig).toBeUndefined();
  });

  it("always active regardless of env content", () => {
    const result = findSkill(getBundledSkillStatuses({ FOO: "bar" }), "browser")!;
    expect(result.status).toBe("active");
  });
});

// ── General shape ─────────────────────────────────────────────────────────────

describe("getBundledSkillStatuses shape", () => {
  it("returns exactly 4 skills", () => {
    expect(getBundledSkillStatuses({})).toHaveLength(4);
  });

  it("returns the expected skill ids in order", () => {
    const ids = getBundledSkillStatuses({}).map((s) => s.id);
    expect(ids).toEqual(["email-calendar", "crm-leadgen", "secure-files", "browser"]);
  });

  it("every skill has displayName, description, version, and status", () => {
    for (const sk of getBundledSkillStatuses({})) {
      expect(sk.displayName).toBeTruthy();
      expect(sk.description).toBeTruthy();
      expect(sk.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(["active", "not_configured"]).toContain(sk.status);
    }
  });

  it("active skills never have missingConfig", () => {
    const env = {
      GOOGLE_CLIENT_ID: "x",
      HUBSPOT_API_KEY: "y",
    };
    for (const sk of getBundledSkillStatuses(env)) {
      if (sk.status === "active") {
        expect(sk.missingConfig).toBeUndefined();
      }
    }
  });

  it("not_configured skills always have missingConfig", () => {
    for (const sk of getBundledSkillStatuses({})) {
      if (sk.status === "not_configured") {
        expect(sk.missingConfig).toBeTruthy();
      }
    }
  });
});
