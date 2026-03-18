/**
 * Unit tests for the Step 7 gateway launch sequence.
 *
 * All child process, HTTP, and file operations are injected.
 * No real gateway is spawned; no real files are read.
 */

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("../../../config/gateway.ts", () => ({
  generateAuthToken: vi.fn().mockReturnValue("a".repeat(64)),
}));

vi.mock("../../../onboarding/env-writer.ts", () => ({
  setEnvVar: vi.fn(),
  maskApiKey: vi.fn(),
}));

vi.mock("../../../onboarding/state.ts", () => ({
  getState: vi.fn().mockReturnValue({
    currentStep: 7,
    completedSteps: [1, 2, 3, 4, 5, 6],
    telegramConnected: false,
    whatsappConnected: false,
    signalConnected: false,
  }),
  updateState: vi.fn(),
  advanceStep: vi.fn(),
  goBack: vi.fn(),
  notifyListeners: vi.fn(),
  onStateChange: vi.fn().mockReturnValue(() => {}),
}));

vi.mock("../../../onboarding/tailscale.ts", () => ({
  detectTailscale: vi.fn(),
  pollForTailscale: vi.fn(),
  serveTailscale: vi.fn(),
  tailscaleDownloadUrl: vi.fn(),
}));

vi.mock("../../../onboarding/validators.ts", () => ({
  validateStep1: vi.fn(),
  validateStep2: vi.fn(),
  validateStep4: vi.fn(),
  validateStep5: vi.fn(),
  validateStep6: vi.fn(),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { setEnvVar } from "../../../onboarding/env-writer.ts";
import {
  launchGateway,
  setExecCommandForTesting,
  setHttpGetForTesting,
  setSpawnGatewayForTesting,
} from "../../../onboarding/server.ts";
import type { LaunchStep } from "../../../onboarding/server.ts";
import { getState } from "../../../onboarding/state.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMockChild() {
  const child = new EventEmitter() as EventEmitter & {
    kill: ReturnType<typeof vi.fn>;
    unref: ReturnType<typeof vi.fn>;
  };
  child.kill = vi.fn();
  child.unref = vi.fn();
  return child;
}

const DASHBOARD_SNAPSHOT = JSON.stringify({
  agentStatus: { status: "running" },
  skills: [{ skillId: "email-calendar", author: "bundled" }],
  feed: [{ skill: "gateway-config", outcome: "success" }],
  pendingApprovals: [],
});

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getState).mockReturnValue({
    currentStep: 7,
    completedSteps: [1, 2, 3, 4, 5, 6],
    telegramConnected: false,
    whatsappConnected: false,
    signalConnected: false,
  } as ReturnType<typeof getState>);
  setExecCommandForTesting(vi.fn());
  setSpawnGatewayForTesting(
    () => makeMockChild() as ReturnType<typeof import("node:child_process").spawn>,
  );
  setHttpGetForTesting(async () => DASHBOARD_SNAPSHOT);
});

afterEach(() => {
  // Restore defaults isn't needed since each test overrides
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("launchGateway", () => {
  it("returns ok: true when all steps succeed", async () => {
    const result = await launchGateway();
    expect(result.ok).toBe(true);
  });

  it("returns steps array with all 6 steps", async () => {
    const result = await launchGateway();
    expect(result.steps).toHaveLength(6);
  });

  it("all steps are done or warn on success", async () => {
    const result = await launchGateway();
    for (const step of result.steps) {
      expect(["done", "warn"]).toContain(step.status);
    }
  });

  it("writes ARMORCLAW_GATEWAY_MODE and ARMORCLAW_GATEWAY_TOKEN to .env", async () => {
    await launchGateway();
    expect(setEnvVar).toHaveBeenCalledWith("ARMORCLAW_GATEWAY_MODE", "local");
    expect(setEnvVar).toHaveBeenCalledWith("ARMORCLAW_GATEWAY_TOKEN", expect.any(String));
  });

  it("runs all 5 openclaw config set commands", async () => {
    const commands: string[] = [];
    setExecCommandForTesting((cmd: string) => {
      commands.push(cmd);
    });
    await launchGateway();

    expect(commands).toHaveLength(5);
    expect(commands.some((c) => c.includes("gateway.mode local"))).toBe(true);
    expect(commands.some((c) => c.includes("gateway.auth.token"))).toBe(true);
    expect(commands.some((c) => c.includes("plugins.load.paths"))).toBe(true);
    expect(commands.some((c) => c.includes("plugins.allow"))).toBe(true);
    expect(commands.some((c) => c.includes("plugins.entries.armorclaw.path"))).toBe(true);
  });

  it("plugin path uses absolute path to wrapper/", async () => {
    const commands: string[] = [];
    setExecCommandForTesting((cmd: string) => {
      commands.push(cmd);
    });
    await launchGateway();

    const entryCmd = commands.find((c) => c.includes("plugins.entries.armorclaw.path"));
    expect(entryCmd).toBeDefined();
    // Must contain an absolute path (starts with /)
    expect(entryCmd).toMatch(/\/.*wrapper/);
  });

  it("spawns the gateway process", async () => {
    const spawnFn = vi.fn().mockReturnValue(makeMockChild());
    setSpawnGatewayForTesting(
      spawnFn as () => ReturnType<typeof import("node:child_process").spawn>,
    );
    await launchGateway();
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it("calls unref() on the spawned child to detach it", async () => {
    const child = makeMockChild();
    setSpawnGatewayForTesting(() => child as ReturnType<typeof import("node:child_process").spawn>);
    await launchGateway();
    expect(child.unref).toHaveBeenCalledTimes(1);
  });
});

describe("launchGateway — gateway reachability", () => {
  it("polls until the gateway responds", async () => {
    let callCount = 0;
    setHttpGetForTesting(async () => {
      callCount++;
      return callCount >= 3 ? DASHBOARD_SNAPSHOT : null;
    });

    const result = await launchGateway();
    expect(result.ok).toBe(true);
    expect(callCount).toBeGreaterThanOrEqual(3);
  });

  it("returns error when gateway never responds", async () => {
    setHttpGetForTesting(async () => null);
    // Override setTimeout to resolve instantly so we don't wait 15s
    const origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void) => origSetTimeout(fn, 0)) as typeof setTimeout;
    try {
      const result = await launchGateway();
      expect(result.ok).toBe(false);
      const reachableStep = result.steps.find((s) => s.id === "gateway-reachable");
      expect(reachableStep?.status).toBe("error");
    } finally {
      globalThis.setTimeout = origSetTimeout;
    }
  }, 30_000);

  it("error message suggests Retry", async () => {
    setHttpGetForTesting(async () => null);
    const origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void) => origSetTimeout(fn, 0)) as typeof setTimeout;
    try {
      const result = await launchGateway();
      expect(result.message).toContain("Retry");
    } finally {
      globalThis.setTimeout = origSetTimeout;
    }
  }, 30_000);
});

describe("launchGateway — plugin verification", () => {
  it("marks plugin-loaded as done when skills contain bundled entries", async () => {
    const result = await launchGateway();
    const step = result.steps.find((s) => s.id === "plugin-loaded");
    expect(step?.status).toBe("done");
  });

  it("marks plugin-loaded as warn when no bundled skills found", async () => {
    setHttpGetForTesting(async () =>
      JSON.stringify({
        agentStatus: { status: "running" },
        skills: [],
        feed: [],
        pendingApprovals: [],
      }),
    );
    const result = await launchGateway();
    const step = result.steps.find((s) => s.id === "plugin-loaded");
    expect(step?.status).toBe("warn");
  });

  it("detects plugin via gateway-config audit entry in feed", async () => {
    setHttpGetForTesting(async () =>
      JSON.stringify({
        agentStatus: { status: "running" },
        skills: [],
        feed: [{ skill: "gateway-config", outcome: "success" }],
        pendingApprovals: [],
      }),
    );
    const result = await launchGateway();
    const step = result.steps.find((s) => s.id === "plugin-loaded");
    expect(step?.status).toBe("done");
  });
});

describe("launchGateway — channel check", () => {
  it("marks channel-check as done when Telegram is connected", async () => {
    vi.mocked(getState).mockReturnValue({
      currentStep: 7,
      completedSteps: [1, 2, 3, 4, 5, 6],
      telegramConnected: true,
      whatsappConnected: false,
      signalConnected: false,
    } as ReturnType<typeof getState>);
    const result = await launchGateway();
    const step = result.steps.find((s) => s.id === "channel-check");
    expect(step?.status).toBe("done");
  });

  it("marks channel-check as warn when no channels connected", async () => {
    vi.mocked(getState).mockReturnValue({
      currentStep: 7,
      completedSteps: [1, 2, 3, 4, 5, 6],
      telegramConnected: false,
      whatsappConnected: false,
      signalConnected: false,
    } as ReturnType<typeof getState>);
    const result = await launchGateway();
    const step = result.steps.find((s) => s.id === "channel-check");
    expect(step?.status).toBe("warn");
    expect(step?.detail).toContain("Settings");
  });
});

describe("launchGateway — spawn failure", () => {
  it("returns ok: false when spawn throws", async () => {
    setSpawnGatewayForTesting(() => {
      throw new Error("ENOENT");
    });
    const result = await launchGateway();
    expect(result.ok).toBe(false);
    const step = result.steps.find((s) => s.id === "gateway-start");
    expect(step?.status).toBe("error");
  });

  it("error message is plain language", async () => {
    setSpawnGatewayForTesting(() => {
      throw new Error("ENOENT");
    });
    const result = await launchGateway();
    expect(result.message).toContain("restart");
  });
});

describe("launchGateway — config command failures", () => {
  it("continues when some config commands fail", async () => {
    let count = 0;
    setExecCommandForTesting(() => {
      count++;
      if (count === 2) {
        throw new Error("config set failed");
      }
    });
    const result = await launchGateway();
    expect(result.ok).toBe(true);
    const step = result.steps.find((s) => s.id === "config");
    expect(step?.status).toBe("warn");
  });

  it("marks config as done when all commands succeed", async () => {
    setExecCommandForTesting(vi.fn());
    const result = await launchGateway();
    const step = result.steps.find((s) => s.id === "config");
    expect(step?.status).toBe("done");
  });
});

describe("launchGateway — progress steps shape", () => {
  it("every step has id, label, and status", async () => {
    const result = await launchGateway();
    for (const step of result.steps) {
      expect(step.id).toBeTruthy();
      expect(step.label).toBeTruthy();
      expect(["pending", "running", "done", "warn", "error"]).toContain(step.status);
    }
  });

  it("step ids are in the expected order", async () => {
    const result = await launchGateway();
    const ids = result.steps.map((s: LaunchStep) => s.id);
    expect(ids).toEqual([
      "backup",
      "config",
      "gateway-start",
      "gateway-reachable",
      "plugin-loaded",
      "channel-check",
    ]);
  });
});
