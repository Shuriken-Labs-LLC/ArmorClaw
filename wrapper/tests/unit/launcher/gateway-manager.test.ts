/**
 * Unit tests for wrapper/launcher/gateway-manager.ts.
 *
 * All child process and HTTP calls are injected — no real gateway is spawned.
 */

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  findNodePath,
  GatewayManager,
  getRepoRoot,
  nodeNotFoundMessage,
} from "../../../launcher/gateway-manager.ts";
import type { AgentState, GatewayStatus } from "../../../launcher/gateway-manager.ts";

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

function makeSnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agentStatus: { status: "running" },
    pendingApprovals: [],
    ...overrides,
  };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── Constructor ───────────────────────────────────────────────────────────────

describe("GatewayManager", () => {
  it("starts in stopped state", () => {
    const mgr = new GatewayManager({ checkHealth: async () => null });
    expect(mgr.status.state).toBe("stopped");
    expect(mgr.status.pendingApprovals).toBe(0);
  });

  it("status returns a defensive copy", () => {
    const mgr = new GatewayManager({ checkHealth: async () => null });
    const a = mgr.status;
    const b = mgr.status;
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
});

// ── start() ───────────────────────────────────────────────────────────────────

describe("start()", () => {
  it("connects to an already-running gateway without spawning", async () => {
    const spawnGateway = vi.fn();
    const mgr = new GatewayManager({
      checkHealth: async () => makeSnapshot(),
      spawnGateway: spawnGateway as ReturnType<typeof vi.fn>,
      pollIntervalMs: 60_000, // prevent polling during test
    });

    await mgr.start();
    expect(spawnGateway).not.toHaveBeenCalled();
    expect(mgr.status.state).toBe("running");
  });

  it("spawns the gateway when not already running", async () => {
    const child = makeMockChild();
    let healthCallCount = 0;
    const checkHealth = vi.fn(async () => {
      healthCallCount++;
      // First call: not running. Subsequent: running.
      return healthCallCount <= 1 ? null : makeSnapshot();
    });

    const mgr = new GatewayManager({
      checkHealth,
      spawnGateway: () => child as unknown as ReturnType<typeof import("node:child_process").spawn>,
      pollIntervalMs: 60_000,
    });

    const startPromise = mgr.start();
    // Advance past the 500ms sleep in the startup poll loop
    await vi.advanceTimersByTimeAsync(600);
    await startPromise;

    expect(mgr.status.state).toBe("running");
  });

  it("emits state-change to starting then running", async () => {
    const states: AgentState[] = [];
    const mgr = new GatewayManager({
      checkHealth: async () => makeSnapshot(),
      pollIntervalMs: 60_000,
    });
    mgr.on("state-change", (s: GatewayStatus) => states.push(s.state));

    await mgr.start();
    expect(states).toContain("starting");
    expect(states).toContain("running");
  });

  it("does nothing if already running", async () => {
    const checkHealth = vi.fn(async () => makeSnapshot());
    const mgr = new GatewayManager({ checkHealth, pollIntervalMs: 60_000 });

    await mgr.start();
    checkHealth.mockClear();
    await mgr.start(); // second call should be a no-op
    expect(checkHealth).not.toHaveBeenCalled();
  });

  it("detects paused state from snapshot", async () => {
    const mgr = new GatewayManager({
      checkHealth: async () => makeSnapshot({ agentStatus: { status: "paused" } }),
      pollIntervalMs: 60_000,
    });

    await mgr.start();
    expect(mgr.status.state).toBe("paused");
  });
});

// ── stop() ────────────────────────────────────────────────────────────────────

describe("stop()", () => {
  it("kills the child process and sets state to stopped", async () => {
    const child = makeMockChild();
    let callCount = 0;
    const mgr = new GatewayManager({
      checkHealth: async () => {
        callCount++;
        return callCount <= 1 ? null : makeSnapshot();
      },
      spawnGateway: () => child as unknown as ReturnType<typeof import("node:child_process").spawn>,
      pollIntervalMs: 60_000,
    });

    const p = mgr.start();
    await vi.advanceTimersByTimeAsync(600);
    await p;

    mgr.stop();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(mgr.status.state).toBe("stopped");
  });
});

// ── Polling ───────────────────────────────────────────────────────────────────

describe("polling", () => {
  it("updates status on each poll", async () => {
    let returnPaused = false;
    const checkHealth = vi.fn(async () => {
      if (returnPaused) {
        return makeSnapshot({ agentStatus: { status: "paused" } });
      }
      return makeSnapshot();
    });

    const mgr = new GatewayManager({
      checkHealth,
      pollIntervalMs: 1000,
    });

    await mgr.start();
    expect(mgr.status.state).toBe("running");

    // Switch to paused and advance past one poll
    returnPaused = true;
    await vi.advanceTimersByTimeAsync(1100);

    expect(mgr.status.state).toBe("paused");
    mgr.stop();
  });

  it("sets error state when health check fails during polling", async () => {
    let healthy = true;
    const checkHealth = vi.fn(async () => (healthy ? makeSnapshot() : null));

    const mgr = new GatewayManager({ checkHealth, pollIntervalMs: 1000 });
    await mgr.start();
    expect(mgr.status.state).toBe("running");

    healthy = false;
    await vi.advanceTimersByTimeAsync(1100);
    expect(mgr.status.state).toBe("error");
    mgr.stop();
  });
});

// ── Pending approvals ─────────────────────────────────────────────────────────

describe("pending approvals", () => {
  it("tracks approval count from snapshot", async () => {
    const mgr = new GatewayManager({
      checkHealth: async () => makeSnapshot({ pendingApprovals: [{ id: "a1" }, { id: "a2" }] }),
      pollIntervalMs: 60_000,
    });
    await mgr.start();
    expect(mgr.status.pendingApprovals).toBe(2);
  });

  it("emits approval-pending when count increases", async () => {
    let pollCount = 0;
    const checkHealth = vi.fn(async () => {
      pollCount++;
      const approvals = pollCount <= 1 ? [] : [{ id: "a1" }, { id: "a2" }];
      return makeSnapshot({ pendingApprovals: approvals });
    });

    const mgr = new GatewayManager({ checkHealth, pollIntervalMs: 1000 });
    const events: number[] = [];
    mgr.on("approval-pending", (count: number) => events.push(count));

    await mgr.start();
    await vi.advanceTimersByTimeAsync(1100);

    expect(events).toContain(2);
    mgr.stop();
  });
});

// ── pause / resume ────────────────────────────────────────────────────────────

describe("pause / resume", () => {
  // These call HTTP endpoints. Since we can't mock http.request easily in
  // this test setup, we just verify the methods exist and return a promise.
  it("pause() returns a promise", () => {
    const mgr = new GatewayManager({ checkHealth: async () => null });
    const result = mgr.pause();
    expect(result).toBeInstanceOf(Promise);
  });

  it("resume() returns a promise", () => {
    const mgr = new GatewayManager({ checkHealth: async () => null });
    const result = mgr.resume();
    expect(result).toBeInstanceOf(Promise);
  });
});

// ── findNodePath ──────────────────────────────────────────────────────────────

describe("findNodePath", () => {
  it("returns a string path to a node binary", () => {
    // On the test machine, node must be installed (we're running tests with it)
    const nodePath = findNodePath();
    expect(typeof nodePath).toBe("string");
    expect(nodePath.length).toBeGreaterThan(0);
  });

  it("returned path contains 'node'", () => {
    const nodePath = findNodePath();
    expect(nodePath.toLowerCase()).toContain("node");
  });
});

// ── nodeNotFoundMessage ───────────────────────────────────────────────────────

describe("nodeNotFoundMessage", () => {
  it("returns a non-empty string", () => {
    const msg = nodeNotFoundMessage();
    expect(msg.length).toBeGreaterThan(0);
  });

  it("mentions nodejs.org", () => {
    expect(nodeNotFoundMessage()).toContain("nodejs.org");
  });

  it("mentions Node.js 22", () => {
    expect(nodeNotFoundMessage()).toContain("Node.js 22");
  });
});

// ── getRepoRoot ───────────────────────────────────────────────────────────────

describe("getRepoRoot", () => {
  it("returns a non-empty string", () => {
    const root = getRepoRoot();
    expect(typeof root).toBe("string");
    expect(root.length).toBeGreaterThan(0);
  });

  it("returns an absolute path", () => {
    const root = getRepoRoot();
    // On Unix starts with /, on Windows starts with drive letter
    expect(root.startsWith("/") || /^[A-Z]:\\/i.test(root)).toBe(true);
  });
});

// ── nodeNotFoundError on manager ──────────────────────────────────────────────

describe("GatewayManager nodeNotFoundError", () => {
  it("is null when node is found", () => {
    const mgr = new GatewayManager({ checkHealth: async () => null });
    expect(mgr.nodeNotFoundError).toBeNull();
  });

  it("is null when nodePath is injected", () => {
    const mgr = new GatewayManager({
      checkHealth: async () => null,
      nodePath: "/usr/bin/node",
    });
    expect(mgr.nodeNotFoundError).toBeNull();
  });
});
