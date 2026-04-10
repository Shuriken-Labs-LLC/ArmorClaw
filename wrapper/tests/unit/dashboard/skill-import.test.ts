/**
 * Unit tests for the /api/skills/* endpoints in wrapper/dashboard/server.ts.
 *
 * Uses real verifySkillSource, isValidGitHubUrl, normalizeGitHubUrl, and
 * sanitizeFilename (no mocks for pure logic).
 * Mocks fetchSkillSource and installSkill to avoid I/O.
 * HTTP endpoint tests spin up startServer(0) for an OS-assigned port.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("../../../marketplace/importer.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../../marketplace/importer.ts")>();
  return {
    ...real,
    fetchSkillSource: vi.fn(),
    installSkill: vi.fn(),
  };
});

vi.mock("../../../token-tracker/store.ts", () => ({
  getBudgetStatus: vi.fn(() => ({
    monthlyBudgetUSD: 20,
    spentThisMonthUSD: 0,
    percentUsed: 0,
    isHardStopped: false,
  })),
  getMonthTokens: vi.fn(() => ({
    totalInputTokens: 0,
    totalOutputTokens: 0,
    estimatedCostUSD: 0,
  })),
  getTodayTokens: vi.fn(() => ({ totalInputTokens: 0, totalOutputTokens: 0, estimatedCostUSD: 0 })),
  getMonthBySkill: vi.fn(() => ({})),
  getDailyHistory: vi.fn(() => []),
  getRecentEvents: vi.fn(() => []),
  setBudgetMonthlyUSD: vi.fn(),
  resumeFromHardStop: vi.fn(),
}));

vi.mock("../../../undo/registry.ts", () => ({
  getCurrentUndo: vi.fn(() => null),
  executeUndo: vi.fn(async () => true),
}));

vi.mock("../../../lib/skill-registry.ts", () => ({
  getAllSkills: vi.fn(() => []),
}));

vi.mock("../../../security/permissions.ts", () => ({
  getPendingApprovals: vi.fn(() => []),
  resolveApproval: vi.fn(() => true),
  onApprovalChange: vi.fn(() => () => {}),
}));

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => {
    throw new Error("ENOENT");
  }),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => {
    throw new Error("not found");
  }),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { clearDashboardStateForTesting, startServer } from "../../../dashboard/server.ts";
import { fetchSkillSource, installSkill } from "../../../marketplace/importer.ts";
import { verifySkillSource } from "../../../marketplace/verifier.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

const SAFE_CODE = `export function run() { return "hello"; }`;
const DANGER_CODE = `eval("rm -rf /")`;
const BASE64 = (s: string) => Buffer.from(s).toString("base64");

async function post(port: number, path: string, body: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

let server: { port: number; close: () => Promise<void> };

beforeEach(async () => {
  clearDashboardStateForTesting();
  vi.clearAllMocks();
  server = await startServer(0);
});

afterEach(async () => {
  await server.close();
  clearDashboardStateForTesting();
});

// ── verifySkillSource (pure, no mocks needed) ─────────────────────────────────

describe("verifySkillSource", () => {
  it("returns safe=true for benign code", () => {
    const r = verifySkillSource(SAFE_CODE);
    expect(r.safe).toBe(true);
    expect(r.dangerousPatterns).toHaveLength(0);
  });

  it("detects eval as danger", () => {
    const r = verifySkillSource(DANGER_CODE);
    expect(r.safe).toBe(false);
    const labels = r.dangerousPatterns.map((p) => p.label);
    expect(labels.some((l) => l.includes("eval"))).toBe(true);
  });

  it("detects new Function constructor as danger", () => {
    const r = verifySkillSource(`new Function("return 1")()`);
    expect(r.safe).toBe(false);
  });

  it("detects child_process import as danger", () => {
    const r = verifySkillSource(`import { execSync } from "node:child_process";`);
    expect(r.safe).toBe(false);
  });

  it("detects process.exit as danger", () => {
    const r = verifySkillSource(`process.exit(1)`);
    expect(r.safe).toBe(false);
  });

  it("detects __proto__ assignment as danger", () => {
    const r = verifySkillSource(`obj.__proto__ = {}`);
    expect(r.safe).toBe(false);
  });

  it("node:fs import is warning, not danger", () => {
    const r = verifySkillSource(`import { readFileSync } from "node:fs";`);
    expect(r.safe).toBe(true);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("process.env access is warning, not danger", () => {
    const r = verifySkillSource(`const k = process.env.MY_KEY;`);
    expect(r.safe).toBe(true);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("extracts permission strings", () => {
    const r = verifySkillSource(`const p = "read:email"; const q = "write:files";`);
    expect(r.permissionsFound).toContain("read:email");
    expect(r.permissionsFound).toContain("write:files");
  });

  it("extracts domains from URL literals", () => {
    const r = verifySkillSource(`fetch("https://api.example.com/data")`);
    expect(r.domainsFound).toContain("api.example.com");
  });

  it("summary includes 'Dangerous patterns detected' when unsafe", () => {
    const r = verifySkillSource(DANGER_CODE);
    expect(r.summary).toMatch(/Dangerous patterns detected/i);
  });

  it("summary includes 'No dangerous patterns' when safe", () => {
    const r = verifySkillSource(SAFE_CODE);
    expect(r.summary).toMatch(/No dangerous patterns/i);
  });
});

// ── POST /api/skills/analyze-url ─────────────────────────────────────────────

describe("POST /api/skills/analyze-url", () => {
  it("returns 422 when url is missing", async () => {
    const { status, body } = await post(server.port, "/api/skills/analyze-url", {});
    expect(status).toBe(422);
    expect(body.ok).toBe(false);
  });

  it("returns 422 when url is not a GitHub URL", async () => {
    const { status, body } = await post(server.port, "/api/skills/analyze-url", {
      url: "https://evil.com/malware.ts",
    });
    expect(status).toBe(422);
    expect(body.ok).toBe(false);
    expect(body.message).toMatch(/github/i);
  });

  it("returns 422 when fetchSkillSource throws", async () => {
    vi.mocked(fetchSkillSource).mockRejectedValueOnce(
      new Error("HTTP 404 from raw.githubusercontent.com"),
    );
    const { status, body } = await post(server.port, "/api/skills/analyze-url", {
      url: "https://raw.githubusercontent.com/user/repo/main/skill.ts",
    });
    expect(status).toBe(422);
    expect(body.ok).toBe(false);
    expect(body.message).toContain("404");
  });

  it("returns ok=true with report for a safe skill", async () => {
    vi.mocked(fetchSkillSource).mockResolvedValueOnce({
      code: SAFE_CODE,
      filename: "skill.ts",
    });
    const { status, body } = await post(server.port, "/api/skills/analyze-url", {
      url: "https://raw.githubusercontent.com/user/repo/main/skill.ts",
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.report.safe).toBe(true);
    expect(body.filename).toBe("skill.ts");
    expect(body.code).toBe(SAFE_CODE);
  });

  it("returns ok=true with unsafe report for a dangerous skill", async () => {
    vi.mocked(fetchSkillSource).mockResolvedValueOnce({
      code: DANGER_CODE,
      filename: "malware.ts",
    });
    const { status, body } = await post(server.port, "/api/skills/analyze-url", {
      url: "https://raw.githubusercontent.com/user/repo/main/malware.ts",
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.report.safe).toBe(false);
  });

  it("accepts github.com blob URL (normalised by fetchSkillSource)", async () => {
    vi.mocked(fetchSkillSource).mockResolvedValueOnce({
      code: SAFE_CODE,
      filename: "skill.ts",
    });
    const { status, body } = await post(server.port, "/api/skills/analyze-url", {
      url: "https://github.com/user/repo/blob/main/skill.ts",
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
  });
});

// ── POST /api/skills/analyze-file ────────────────────────────────────────────

describe("POST /api/skills/analyze-file", () => {
  it("returns 422 when content is missing", async () => {
    const { status, body } = await post(server.port, "/api/skills/analyze-file", {
      filename: "skill.ts",
    });
    expect(status).toBe(422);
    expect(body.ok).toBe(false);
  });

  it("returns 422 when filename is missing", async () => {
    const { status, body } = await post(server.port, "/api/skills/analyze-file", {
      content: BASE64(SAFE_CODE),
    });
    expect(status).toBe(422);
    expect(body.ok).toBe(false);
  });

  it("returns 422 for a disallowed extension", async () => {
    const { status, body } = await post(server.port, "/api/skills/analyze-file", {
      content: BASE64("console.log('hi')"),
      filename: "skill.py",
    });
    expect(status).toBe(422);
    expect(body.ok).toBe(false);
    expect(body.message).toMatch(/\.ts|\.js/i);
  });

  it("returns ok=true with report for a safe .ts file", async () => {
    const { status, body } = await post(server.port, "/api/skills/analyze-file", {
      content: BASE64(SAFE_CODE),
      filename: "my-skill.ts",
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.report.safe).toBe(true);
    expect(body.filename).toBe("my-skill.ts");
  });

  it("returns ok=true with unsafe report for a dangerous .js file", async () => {
    const { status, body } = await post(server.port, "/api/skills/analyze-file", {
      content: BASE64(DANGER_CODE),
      filename: "bad.js",
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.report.safe).toBe(false);
  });

  it("decodes base64 content correctly", async () => {
    const code = `export const X = "hello world";`;
    const { body } = await post(server.port, "/api/skills/analyze-file", {
      content: BASE64(code),
      filename: "skill.ts",
    });
    expect(body.code).toBe(code);
  });
});

// ── POST /api/skills/install ─────────────────────────────────────────────────

describe("POST /api/skills/install", () => {
  it("returns 422 when code is missing", async () => {
    const { status, body } = await post(server.port, "/api/skills/install", {
      filename: "skill.ts",
    });
    expect(status).toBe(422);
    expect(body.ok).toBe(false);
  });

  it("returns 422 when filename is missing", async () => {
    const { status, body } = await post(server.port, "/api/skills/install", {
      code: SAFE_CODE,
    });
    expect(status).toBe(422);
    expect(body.ok).toBe(false);
  });

  it("returns 403 when code has dangerous patterns (re-verifies server-side)", async () => {
    const { status, body } = await post(server.port, "/api/skills/install", {
      code: DANGER_CODE,
      filename: "bad.ts",
    });
    expect(status).toBe(403);
    expect(body.ok).toBe(false);
    expect(body.report).toBeDefined();
    expect(body.report.safe).toBe(false);
    expect(installSkill).not.toHaveBeenCalled();
  });

  it("installs a safe skill and returns dest path", async () => {
    vi.mocked(installSkill).mockReturnValueOnce("/Users/test/.armorclaw/skills/skill.ts");
    const { status, body } = await post(server.port, "/api/skills/install", {
      code: SAFE_CODE,
      filename: "skill.ts",
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.dest).toBe("/Users/test/.armorclaw/skills/skill.ts");
    expect(installSkill).toHaveBeenCalledWith(SAFE_CODE, "skill.ts");
  });

  it("returns 422 when installSkill throws (e.g. bad extension)", async () => {
    vi.mocked(installSkill).mockImplementationOnce(() => {
      throw new Error("Only .ts and .js files may be installed");
    });
    const { status, body } = await post(server.port, "/api/skills/install", {
      code: SAFE_CODE,
      filename: "skill.ts",
    });
    expect(status).toBe(422);
    expect(body.ok).toBe(false);
  });

  it("does not bypass re-verification even if client claims skill is safe", async () => {
    // Client sends dangerous code regardless of claimed report
    const { status } = await post(server.port, "/api/skills/install", {
      code: `new Function("return process.exit(1)")()`,
      filename: "trojan.ts",
    });
    expect(status).toBe(403);
    expect(installSkill).not.toHaveBeenCalled();
  });
});
