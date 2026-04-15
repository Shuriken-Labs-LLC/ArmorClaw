/**
 * Unit tests for the GET /api/skills/bundled endpoint logic.
 *
 * Tests getBundledSkillStatuses() with various .env configurations.
 * No real file I/O — env is injected as a plain Record<string, string>.
 *
 * Coverage target: 80%+ line coverage on getBundledSkillStatuses.
 */

import { describe, expect, it, vi } from "vitest";

// ── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("../../../security/permissions.ts", () => ({
  getPendingApprovals: vi.fn(() => []),
  resolveApproval: vi.fn(() => true),
  onApprovalChange: vi.fn(() => () => {}),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { getBundledSkillStatuses } from "../../../dashboard/server.ts";
import type { BundledSkillStatus } from "../../../dashboard/server.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

function findSkill(statuses: BundledSkillStatus[], id: string): BundledSkillStatus | undefined {
  return statuses.find((s) => s.id === id);
}

// ── email-calendar ────────────────────────────────────────────────────────────

describe("email-calendar status", () => {
  it("active when Google OAuth tokens exist", () => {
    const env = { GOOGLE_OAUTH_ACCESS_TOKEN: "ya29.a0AfH6SM..." };
    const result = findSkill(getBundledSkillStatuses(env), "email-calendar")!;
    expect(result.status).toBe("active");
    expect(result.missingConfig).toBeUndefined();
  });

  it("active when Google refresh token exists", () => {
    const env = { GOOGLE_OAUTH_REFRESH_TOKEN: "1//0abc..." };
    const result = findSkill(getBundledSkillStatuses(env), "email-calendar")!;
    expect(result.status).toBe("active");
  });

  it("active when Microsoft OAuth tokens exist", () => {
    const env = { MICROSOFT_OAUTH_ACCESS_TOKEN: "eyJ0eXAi..." };
    const result = findSkill(getBundledSkillStatuses(env), "email-calendar")!;
    expect(result.status).toBe("active");
  });

  it("active when Microsoft refresh token exists", () => {
    const env = { MICROSOFT_OAUTH_REFRESH_TOKEN: "M.R3_BAY..." };
    const result = findSkill(getBundledSkillStatuses(env), "email-calendar")!;
    expect(result.status).toBe("active");
  });

  it("not_configured when only client ID exists but no tokens", () => {
    const env = { GOOGLE_OAUTH_CLIENT_ID: "282171340527-xxx.apps.googleusercontent.com" };
    const result = findSkill(getBundledSkillStatuses(env), "email-calendar")!;
    expect(result.status).toBe("not_configured");
  });

  it("not_configured when no email env vars", () => {
    const result = findSkill(getBundledSkillStatuses({}), "email-calendar")!;
    expect(result.status).toBe("not_configured");
    expect(result.missingConfig).toContain("Gmail or Outlook");
    expect(result.missingConfig).toContain("Settings");
  });

  it("not_configured when only unrelated env vars are set", () => {
    const env = { ARMORCLAW_MODEL_PROVIDER: "anthropic" };
    const result = findSkill(getBundledSkillStatuses(env), "email-calendar")!;
    expect(result.status).toBe("not_configured");
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
    const env = { GOOGLE_OAUTH_CLIENT_ID: "x" };
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
  it("returns exactly 3 skills", () => {
    expect(getBundledSkillStatuses({})).toHaveLength(3);
  });

  it("returns the expected skill ids in order", () => {
    const ids = getBundledSkillStatuses({}).map((s) => s.id);
    expect(ids).toEqual(["email-calendar", "secure-files", "browser"]);
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
      GOOGLE_OAUTH_ACCESS_TOKEN: "ya29.test",
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
