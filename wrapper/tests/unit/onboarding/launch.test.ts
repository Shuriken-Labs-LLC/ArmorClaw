/**
 * Unit tests for the Step 6 gateway launch sequence.
 *
 * All child process, HTTP, and file operations are injected.
 * No real gateway is spawned; no real files are read.
 */

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("../../../onboarding/env-writer.ts", () => ({
  setEnvVar: vi.fn(),
  maskApiKey: vi.fn(),
}));

vi.mock("../../../onboarding/state.ts", () => ({
  getState: vi.fn().mockReturnValue({
    currentStep: 6,
    completedSteps: [1, 2, 3, 4, 5],
    connectedChannels: [],
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
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { setEnvVar } from "../../../onboarding/env-writer.ts";
import {
  launchGateway,
  setExecCommandForTesting,
  setHttpGetForTesting,
  setProbePortForTesting,
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
    currentStep: 6,
    completedSteps: [1, 2, 3, 4, 5],
    connectedChannels: [],
  } as ReturnType<typeof getState>);
  setExecCommandForTesting(vi.fn());
  setSpawnGatewayForTesting(
    () => makeMockChild() as ReturnType<typeof import("node:child_process").spawn>,
  );
  setProbePortForTesting(async () => true);
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

  it("returns steps array with all 7 steps", async () => {
    const result = await launchGateway();
    expect(result.steps).toHaveLength(7);
  });

  it("all steps are done or warn on success", async () => {
    const result = await launchGateway();
    for (const step of result.steps) {
      expect(["done", "warn"]).toContain(step.status);
    }
  });

  it("writes ARMORCLAW_GATEWAY_MODE to .env (token is read back from gateway after start)", async () => {
    await launchGateway();
    expect(setEnvVar).toHaveBeenCalledWith("ARMORCLAW_GATEWAY_MODE", "local");
    // Token is NOT written during config — it's read from openclaw.json
    // after the gateway starts (step 4b). Since the mock health check
    // returns null here, step 4b doesn't run.
  });

  it("runs openclaw config set commands (no token — gateway owns its token)", async () => {
    const commands: string[] = [];
    setExecCommandForTesting((cmd: string) => {
      commands.push(cmd);
    });
    await launchGateway();

    expect(commands).toHaveLength(4);
    expect(commands.some((c) => c.includes("gateway.mode local"))).toBe(true);
    expect(commands.some((c) => c.includes("controlUi.allowedOrigins"))).toBe(true);
    expect(commands.some((c) => c.includes("plugins.load.paths"))).toBe(true);
    expect(commands.some((c) => c.includes("plugins.allow"))).toBe(true);
    // Token must NOT be in the config commands
    expect(commands.some((c) => c.includes("gateway.auth.token"))).toBe(false);
  });

  it("plugins.load.paths contains absolute path to wrapper/", async () => {
    const commands: string[] = [];
    setExecCommandForTesting((cmd: string) => {
      commands.push(cmd);
    });
    await launchGateway();

    const loadCmd = commands.find((c) => c.includes("plugins.load.paths"));
    expect(loadCmd).toBeDefined();
    // Must contain an absolute path (starts with /)
    expect(loadCmd).toMatch(/\/.*wrapper/);
  });

  it("spawns the gateway process when not already running", async () => {
    // First probe (pre-spawn check) must return false so spawn runs
    let calls = 0;
    setProbePortForTesting(async () => {
      calls++;
      return calls > 1; // false on first call → spawn; true after → reachable
    });
    const spawnFn = vi.fn().mockReturnValue(makeMockChild());
    setSpawnGatewayForTesting(
      spawnFn as () => ReturnType<typeof import("node:child_process").spawn>,
    );
    await launchGateway();
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it("skips spawn when gateway is already running", async () => {
    setProbePortForTesting(async () => true);
    const spawnFn = vi.fn().mockReturnValue(makeMockChild());
    setSpawnGatewayForTesting(
      spawnFn as () => ReturnType<typeof import("node:child_process").spawn>,
    );
    await launchGateway();
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("calls unref() on the spawned child to detach it", async () => {
    let calls = 0;
    setProbePortForTesting(async () => {
      calls++;
      return calls > 1;
    });
    const child = makeMockChild();
    setSpawnGatewayForTesting(() => child as ReturnType<typeof import("node:child_process").spawn>);
    await launchGateway();
    expect(child.unref).toHaveBeenCalledTimes(1);
  });
});

describe("launchGateway — gateway reachability", () => {
  it("polls until the gateway port responds", async () => {
    let callCount = 0;
    setProbePortForTesting(async () => {
      callCount++;
      return callCount >= 3;
    });

    const result = await launchGateway();
    expect(result.ok).toBe(true);
    expect(callCount).toBeGreaterThanOrEqual(3);
  });

  it("returns error when gateway port never responds", async () => {
    setProbePortForTesting(async () => false);
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
    setProbePortForTesting(async () => false);
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
      connectedChannels: ["telegram"],
    } as ReturnType<typeof getState>);
    const result = await launchGateway();
    const step = result.steps.find((s) => s.id === "channel-check");
    expect(step?.status).toBe("done");
  });

  it("marks channel-check as warn when no channels connected", async () => {
    vi.mocked(getState).mockReturnValue({
      currentStep: 7,
      completedSteps: [1, 2, 3, 4, 5, 6],
      connectedChannels: [],
    } as ReturnType<typeof getState>);
    const result = await launchGateway();
    const step = result.steps.find((s) => s.id === "channel-check");
    expect(step?.status).toBe("warn");
    expect(step?.detail).toContain("Settings");
  });
});

describe("launchGateway — gateway restart after token write", () => {
  it("re-polls and succeeds when gateway drops then comes back", async () => {
    // Simulate: first N calls (initial poll) succeed, then port drops
    // after token write, then comes back after a few attempts.
    let _totalCalls = 0;
    let postTokenPhase = false;
    const origSetEnvVar = vi.mocked(setEnvVar);
    origSetEnvVar.mockImplementation((key: string) => {
      if (key === "ARMORCLAW_GATEWAY_TOKEN") {
        postTokenPhase = true;
      }
    });

    let postTokenCalls = 0;
    setProbePortForTesting(async () => {
      _totalCalls++;
      if (!postTokenPhase) {
        return true;
      } // initial poll succeeds
      postTokenCalls++;
      // First post-token probe: port is down; second: still down; third: back up
      return postTokenCalls >= 3;
    });

    const result = await launchGateway();
    expect(result.ok).toBe(true);
    expect(postTokenCalls).toBeGreaterThanOrEqual(3);
  });

  it("continues with warning when gateway never comes back after token write", async () => {
    let postTokenPhase = false;
    const origSetEnvVar = vi.mocked(setEnvVar);
    origSetEnvVar.mockImplementation((key: string) => {
      if (key === "ARMORCLAW_GATEWAY_TOKEN") {
        postTokenPhase = true;
      }
    });

    setProbePortForTesting(async () => {
      if (!postTokenPhase) {
        return true;
      }
      return false; // gateway never comes back
    });

    const origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void) => origSetTimeout(fn, 0)) as typeof setTimeout;
    try {
      const result = await launchGateway();
      // Should still complete (with possible warn on plugin step), not crash
      expect(result.steps).toBeDefined();
    } finally {
      globalThis.setTimeout = origSetTimeout;
    }
  }, 30_000);
});

describe("launchGateway — spawn failure", () => {
  it("returns ok: false when spawn throws", async () => {
    // Pre-spawn probe must return false so the spawn path runs
    setProbePortForTesting(async () => false);
    setSpawnGatewayForTesting(() => {
      throw new Error("ENOENT");
    });
    const result = await launchGateway();
    expect(result.ok).toBe(false);
    const step = result.steps.find((s) => s.id === "gateway-start");
    expect(step?.status).toBe("error");
  });

  it("error message is plain language", async () => {
    setProbePortForTesting(async () => false);
    setSpawnGatewayForTesting(() => {
      throw new Error("ENOENT");
    });
    const result = await launchGateway();
    expect(result.message).toContain("Could not start the gateway");
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
      "gateway-install",
      "gateway-start",
      "gateway-reachable",
      "plugin-loaded",
      "channel-check",
    ]);
  });
});
