/**
 * Gateway process manager — starts, monitors, and stops the OpenClaw gateway.
 *
 * Polls the dashboard SSE endpoint for status. Emits state changes so the
 * tray module can update the icon and menu.
 *
 * All child process and HTTP operations are injectable for testing.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import http from "node:http";
import { join } from "node:path";

// ── Types ─────────────────────────────────────────────────────────────────────

export type AgentState = "starting" | "running" | "paused" | "error" | "stopped";

export interface GatewayStatus {
  state: AgentState;
  pendingApprovals: number;
  dashboardUrl: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const OPENCLAW_MJS = join(REPO_ROOT, "openclaw.mjs");
const DASHBOARD_PORT = 7390;
const DASHBOARD_URL = `http://127.0.0.1:${DASHBOARD_PORT}`;
const POLL_INTERVAL_MS = 5_000;
const STARTUP_TIMEOUT_MS = 15_000;

// ── Gateway Manager ───────────────────────────────────────────────────────────

export interface GatewayManagerOptions {
  /** Override gateway spawn (test injection). */
  spawnGateway?: () => ChildProcess;
  /** Override health check (test injection). Returns parsed dashboard snapshot or null. */
  checkHealth?: () => Promise<Record<string, unknown> | null>;
  /** Override poll interval in ms. */
  pollIntervalMs?: number;
}

export class GatewayManager extends EventEmitter {
  private _status: GatewayStatus = {
    state: "stopped",
    pendingApprovals: 0,
    dashboardUrl: DASHBOARD_URL,
  };
  private _child: ChildProcess | null = null;
  private _pollTimer: ReturnType<typeof setInterval> | null = null;
  private _spawnGateway: () => ChildProcess;
  private _checkHealth: () => Promise<Record<string, unknown> | null>;
  private _pollIntervalMs: number;

  constructor(options: GatewayManagerOptions = {}) {
    super();
    this._spawnGateway =
      options.spawnGateway ??
      (() =>
        spawn("node", [OPENCLAW_MJS, "gateway"], {
          stdio: "ignore",
          cwd: REPO_ROOT,
        }));
    this._checkHealth = options.checkHealth ?? (() => defaultHealthCheck());
    this._pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  }

  get status(): GatewayStatus {
    return { ...this._status };
  }

  /**
   * Start the gateway. If already running, does nothing.
   * Resolves when the gateway is confirmed reachable or startup times out.
   */
  async start(): Promise<void> {
    if (this._status.state === "running" || this._status.state === "starting") {
      return;
    }

    this._updateState("starting");

    // Check if gateway is already running (user may have started it manually)
    const existing = await this._checkHealth();
    if (existing) {
      this._applySnapshot(existing);
      this._startPolling();
      return;
    }

    // Spawn the gateway process
    try {
      this._child = this._spawnGateway();
      this._child.on("exit", (code) => {
        if (this._status.state !== "stopped") {
          this._updateState(code === 0 ? "stopped" : "error");
        }
        this._child = null;
      });
    } catch {
      this._updateState("error");
      return;
    }

    // Poll until reachable or timeout
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(500);
      const snap = await this._checkHealth();
      if (snap) {
        this._applySnapshot(snap);
        this._startPolling();
        return;
      }
    }

    // Timed out — might still be starting, keep polling
    this._updateState("running");
    this._startPolling();
  }

  /** Stop the gateway and clean up. */
  stop(): void {
    this._stopPolling();
    if (this._child) {
      try {
        this._child.kill("SIGTERM");
      } catch {
        // Already dead
      }
      this._child = null;
    }
    this._updateState("stopped");
  }

  /** Pause the agent via the dashboard API. */
  async pause(): Promise<boolean> {
    return postApi("/api/agent/pause");
  }

  /** Resume the agent via the dashboard API. */
  async resume(): Promise<boolean> {
    return postApi("/api/agent/resume");
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private _updateState(state: AgentState): void {
    const prev = this._status.state;
    this._status.state = state;
    if (prev !== state) {
      this.emit("state-change", this.status);
    }
  }

  private _applySnapshot(snap: Record<string, unknown>): void {
    const agentStatus = snap["agentStatus"] as { status?: string } | undefined;
    if (agentStatus?.status === "paused") {
      this._status.state = "paused";
    } else if (agentStatus?.status === "error") {
      this._status.state = "error";
    } else {
      this._status.state = "running";
    }

    const approvals = snap["pendingApprovals"] as unknown[] | undefined;
    const prevApprovals = this._status.pendingApprovals;
    this._status.pendingApprovals = Array.isArray(approvals) ? approvals.length : 0;

    this.emit("state-change", this.status);

    // Notify on new approvals
    if (this._status.pendingApprovals > prevApprovals) {
      this.emit("approval-pending", this._status.pendingApprovals);
    }
  }

  private _startPolling(): void {
    this._stopPolling();
    this._pollTimer = setInterval(() => {
      void this._poll();
    }, this._pollIntervalMs);
  }

  private _stopPolling(): void {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  private async _poll(): Promise<void> {
    const snap = await this._checkHealth();
    if (snap) {
      this._applySnapshot(snap);
    } else if (this._status.state === "running") {
      this._updateState("error");
    }
  }
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function defaultHealthCheck(): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const req = http.get(`${DASHBOARD_URL}/api/dashboard`, { timeout: 3000 }, (res) => {
      if (res.statusCode !== 200) {
        resolve(null);
        res.resume();
        return;
      }
      let data = "";
      res.on("data", (chunk: Buffer) => {
        data += chunk.toString();
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(data) as Record<string, unknown>);
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

async function postApi(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      `${DASHBOARD_URL}${path}`,
      { method: "POST", timeout: 3000 },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on("error", () => resolve(false));
    req.end();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
