/**
 * Unit tests for the Skills tab server routes in wrapper/dashboard/server.ts.
 *
 * Tests: ClawHub fetching, installed skills CRUD, GitHub install, toggle, remove.
 * HTTP endpoint tests spin up startServer(0) for an OS-assigned port.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Module mocks ─────────────────────────────────────────────────────────

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
  existsSync: vi.fn(() => false),
}));

vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => {
    throw new Error("not found");
  }),
  spawn: vi.fn(),
}));

// ── Imports ───────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync } from "node:fs";
import {
  clearDashboardStateForTesting,
  parseClawHubHtml,
  readSkillsConfig,
  startServer,
  writeSkillsConfig,
} from "../../../dashboard/server.ts";
import { fetchSkillSource, installSkill } from "../../../marketplace/importer.ts";

// ── Helpers ───────────────────────────────────────────────────────────────

async function post(port: number, path: string, body: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function get(port: number, path: string) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: await res.json() };
}

// ── Setup / teardown ─────────────────────────────────────────────────────

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

// ── parseClawHubHtml ──────────────────────────────────────────────────────

describe("parseClawHubHtml", () => {
  it("returns empty array for plain HTML with no integrations", () => {
    expect(parseClawHubHtml("<html><body>Hello</body></html>")).toEqual([]);
  });

  it("parses data-integration attributes", () => {
    const html = `<div data-integration-name="Weather" data-integration-description="Get weather data" data-integration-url="https://example.com"></div>`;
    const result = parseClawHubHtml(html);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Weather");
    expect(result[0].description).toBe("Get weather data");
    expect(result[0].id).toBe("weather");
  });

  it("parses JSON-LD structured data", () => {
    const html = `<script type="application/ld+json">[{"name":"Calendar","description":"Manage events","identifier":"calendar","url":"https://cal.example.com"}]</script>`;
    const result = parseClawHubHtml(html);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Calendar");
    expect(result[0].id).toBe("calendar");
  });
});

// ── readSkillsConfig / writeSkillsConfig ──────────────────────────────────

describe("readSkillsConfig", () => {
  it("returns empty installed array when file does not exist", () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    const config = readSkillsConfig();
    expect(config.installed).toEqual([]);
  });

  it("parses valid skills.json", () => {
    vi.mocked(readFileSync).mockReturnValueOnce(
      JSON.stringify({
        installed: [
          {
            id: "test-skill",
            name: "Test",
            description: "A test",
            capabilities: [],
            source: "clawhub",
            sourceUrl: "",
            enabled: true,
            installedAt: "2026-01-01T00:00:00Z",
          },
        ],
      }),
    );
    const config = readSkillsConfig();
    expect(config.installed).toHaveLength(1);
    expect(config.installed[0].id).toBe("test-skill");
  });

  it("returns empty when installed is not an array", () => {
    vi.mocked(readFileSync).mockReturnValueOnce(JSON.stringify({ installed: "bad" }));
    const config = readSkillsConfig();
    expect(config.installed).toEqual([]);
  });
});

describe("writeSkillsConfig", () => {
  it("writes JSON to the correct path", () => {
    writeSkillsConfig({ installed: [] });
    expect(writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("skills.json"),
      expect.stringContaining('"installed"'),
      "utf-8",
    );
  });
});

// ── GET /api/skills/clawhub ──────────────────────────────────────────────

describe("GET /api/skills/clawhub", () => {
  it("returns ok with skills array (may be empty if registry offline)", async () => {
    const { status, body } = await get(server.port, "/api/skills/clawhub");
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.skills)).toBe(true);
  });
});

// ── GET /api/skills/installed ────────────────────────────────────────────

describe("GET /api/skills/installed", () => {
  it("returns empty array when no skills installed", async () => {
    const { status, body } = await get(server.port, "/api/skills/installed");
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.skills).toEqual([]);
  });
});

// ── POST /api/skills/clawhub/install ─────────────────────────────────────

describe("POST /api/skills/clawhub/install", () => {
  it("returns 422 when skill is missing", async () => {
    const { status, body } = await post(server.port, "/api/skills/clawhub/install", {});
    expect(status).toBe(422);
    expect(body.ok).toBe(false);
  });

  it("returns 422 when skill has no id", async () => {
    const { status, body } = await post(server.port, "/api/skills/clawhub/install", {
      skill: { name: "Test" },
    });
    expect(status).toBe(422);
    expect(body.ok).toBe(false);
  });

  it("returns 422 when skill has no name", async () => {
    const { status, body } = await post(server.port, "/api/skills/clawhub/install", {
      skill: { id: "test" },
    });
    expect(status).toBe(422);
    expect(body.ok).toBe(false);
  });

  it("installs a valid ClawHub skill", async () => {
    const { status, body } = await post(server.port, "/api/skills/clawhub/install", {
      skill: {
        id: "weather-check",
        name: "Weather Check",
        description: "Check the weather",
        capabilities: ["network:outbound"],
        sourceUrl: "https://openclaw.ai/skills/weather",
      },
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.skill.id).toBe("weather-check");
    expect(body.skill.enabled).toBe(true);
    expect(body.skill.source).toBe("clawhub");
    expect(writeFileSync).toHaveBeenCalled();
  });

  it("returns 409 when skill is already installed", async () => {
    // First install
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        installed: [
          {
            id: "weather-check",
            name: "Weather Check",
            description: "",
            capabilities: [],
            source: "clawhub",
            sourceUrl: "",
            enabled: true,
            installedAt: "2026-01-01T00:00:00Z",
          },
        ],
      }),
    );
    const { status, body } = await post(server.port, "/api/skills/clawhub/install", {
      skill: { id: "weather-check", name: "Weather Check" },
    });
    expect(status).toBe(409);
    expect(body.message).toContain("already installed");
  });
});

// ── POST /api/skills/github/install ──────────────────────────────────────

describe("POST /api/skills/github/install", () => {
  it("returns 422 when url is missing", async () => {
    const { status, body } = await post(server.port, "/api/skills/github/install", {
      confirm: "CONFIRM",
    });
    expect(status).toBe(422);
    expect(body.ok).toBe(false);
  });

  it("returns 422 when confirm is not CONFIRM", async () => {
    const { status, body } = await post(server.port, "/api/skills/github/install", {
      url: "https://raw.githubusercontent.com/user/repo/main/skill.ts",
      confirm: "yes",
    });
    expect(status).toBe(422);
    expect(body.message).toContain("CONFIRM");
  });

  it("returns 422 when url is not a GitHub URL", async () => {
    const { status, body } = await post(server.port, "/api/skills/github/install", {
      url: "https://evil.com/malware.ts",
      confirm: "CONFIRM",
    });
    expect(status).toBe(422);
    expect(body.message).toContain("GitHub");
  });

  it("returns 403 when fetched skill has dangerous patterns", async () => {
    vi.mocked(fetchSkillSource).mockResolvedValueOnce({
      code: `eval("rm -rf /")`,
      filename: "bad.ts",
    });
    const { status, body } = await post(server.port, "/api/skills/github/install", {
      url: "https://raw.githubusercontent.com/user/repo/main/bad.ts",
      confirm: "CONFIRM",
    });
    expect(status).toBe(403);
    expect(body.ok).toBe(false);
    expect(body.report.safe).toBe(false);
    expect(installSkill).not.toHaveBeenCalled();
  });

  it("installs a safe skill from GitHub", async () => {
    const safeCode = `export function run() { return "hello"; }`;
    vi.mocked(fetchSkillSource).mockResolvedValueOnce({
      code: safeCode,
      filename: "my-skill.ts",
    });
    vi.mocked(installSkill).mockReturnValueOnce("/Users/test/.armorclaw/skills/my-skill.ts");
    const { status, body } = await post(server.port, "/api/skills/github/install", {
      url: "https://raw.githubusercontent.com/user/repo/main/my-skill.ts",
      confirm: "CONFIRM",
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.dest).toContain("my-skill.ts");
    expect(installSkill).toHaveBeenCalledWith(safeCode, "my-skill.ts");
    expect(writeFileSync).toHaveBeenCalled(); // skills.json written
  });

  it("returns 422 when fetchSkillSource throws", async () => {
    vi.mocked(fetchSkillSource).mockRejectedValueOnce(new Error("HTTP 404"));
    const { status, body } = await post(server.port, "/api/skills/github/install", {
      url: "https://raw.githubusercontent.com/user/repo/main/missing.ts",
      confirm: "CONFIRM",
    });
    expect(status).toBe(422);
    expect(body.message).toContain("404");
  });
});

// ── POST /api/skills/installed/:id/toggle ────────────────────────────────

describe("POST /api/skills/installed/:id/toggle", () => {
  it("returns 404 when skill not found", async () => {
    const { status, body } = await post(
      server.port,
      "/api/skills/installed/nonexistent/toggle",
      {},
    );
    expect(status).toBe(404);
    expect(body.ok).toBe(false);
  });

  it("toggles an installed skill", async () => {
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        installed: [
          {
            id: "test-skill",
            name: "Test",
            description: "",
            capabilities: [],
            source: "clawhub",
            sourceUrl: "",
            enabled: true,
            installedAt: "2026-01-01T00:00:00Z",
          },
        ],
      }),
    );
    const { status, body } = await post(server.port, "/api/skills/installed/test-skill/toggle", {});
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.enabled).toBe(false);
    expect(writeFileSync).toHaveBeenCalled();
  });
});

// ── POST /api/skills/installed/:id/remove ────────────────────────────────

describe("POST /api/skills/installed/:id/remove", () => {
  it("returns 404 when skill not found", async () => {
    const { status, body } = await post(
      server.port,
      "/api/skills/installed/nonexistent/remove",
      {},
    );
    expect(status).toBe(404);
    expect(body.ok).toBe(false);
  });

  it("removes an installed skill", async () => {
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        installed: [
          {
            id: "test-skill",
            name: "Test",
            description: "",
            capabilities: [],
            source: "clawhub",
            sourceUrl: "",
            enabled: true,
            installedAt: "2026-01-01T00:00:00Z",
          },
        ],
      }),
    );
    const { status, body } = await post(server.port, "/api/skills/installed/test-skill/remove", {});
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(writeFileSync).toHaveBeenCalled();
  });
});
