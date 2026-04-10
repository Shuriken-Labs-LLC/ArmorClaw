/**
 * Gateway process manager — starts, monitors, and stops the OpenClaw gateway.
 *
 * Polls the dashboard SSE endpoint for status. Emits state changes so the
 * tray module can update the icon and menu.
 *
 * KEY FIX: Packaged Electron apps do NOT inherit the user's shell PATH.
 * - macOS: /opt/homebrew/bin (Apple Silicon) and /usr/local/bin (Intel) missing
 * - Windows: Program Files paths may not be in PATH inside packaged .exe
 *
 * We resolve the node binary path explicitly and inject a platform-aware PATH
 * into every child process.
 *
 * All child process and HTTP operations are injectable for testing.
 */

import { execSync, spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Types ─────────────────────────────────────────────────────────────────────

export type AgentState = "starting" | "running" | "paused" | "error" | "stopped";

export interface GatewayStatus {
  state: AgentState;
  pendingApprovals: number;
  dashboardUrl: string;
}

// ── Platform detection ────────────────────────────────────────────────────────

const IS_WIN = process.platform === "win32";

// ── PATH for child processes ──────────────────────────────────────────────────

/**
 * Build a full PATH that covers common install locations for node on each platform.
 * On Windows the installer usually sets PATH correctly, so we just pass through
 * with the Program Files paths prepended as a safety net.
 * On Mac/Linux we prepend Homebrew, system, and version-manager paths.
 */
function buildFullPath(): string {
  const existing = process.env["PATH"] ?? "";

  if (IS_WIN) {
    const appData = process.env["APPDATA"] ?? "";
    const localAppData = process.env["LOCALAPPDATA"] ?? "";
    const extra = [
      "C:\\Program Files\\nodejs",
      "C:\\Program Files (x86)\\nodejs",
      localAppData ? join(localAppData, "Programs", "nodejs") : "",
      appData ? join(appData, "npm") : "",
      appData ? join(appData, "nvm", "current") : "",
    ].filter(Boolean);
    return [...extra, existing].join(";");
  }

  // Mac / Linux
  const extra = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    join(homedir(), ".nvm/versions/node"),
    join(homedir(), ".local/share/fnm/aliases/default/bin"),
  ];
  return [...extra, existing].join(":");
}

const FULL_PATH = buildFullPath();

/** Environment passed to all child processes. */
function childEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PATH: FULL_PATH };
}

// ── Node path resolution ──────────────────────────────────────────────────────

/**
 * Find the node binary. Packaged Electron apps don't inherit PATH, so we
 * probe common install locations before falling back to `which` / `where`.
 *
 * Injectable via the `nodePath` parameter on GatewayManagerOptions for testing.
 */
export function findNodePath(): string {
  const appData = process.env["APPDATA"] ?? "";
  const localAppData = process.env["LOCALAPPDATA"] ?? "";

  const candidates = IS_WIN
    ? [
        "C:\\Program Files\\nodejs\\node.exe",
        "C:\\Program Files (x86)\\nodejs\\node.exe",
        localAppData ? join(localAppData, "Programs", "nodejs", "node.exe") : "",
        appData ? join(appData, "npm", "node.exe") : "",
        appData ? join(appData, "nvm", "current", "node.exe") : "",
        process.execPath,
      ].filter(Boolean)
    : [
        "/opt/homebrew/bin/node", // Apple Silicon Mac (Homebrew)
        "/usr/local/bin/node", // Intel Mac (Homebrew / installer)
        "/usr/bin/node", // System node / Linux
        process.execPath, // Electron's own node (last resort)
      ];

  for (const candidate of candidates) {
    try {
      execSync(`"${candidate}" --version`, { stdio: "ignore", timeout: 3000 });
      return candidate;
    } catch {
      // Not found or not executable — try next
    }
  }

  // Shell fallback — platform aware
  try {
    const cmd = IS_WIN ? "where node" : "which node";
    const result = execSync(cmd, {
      env: { ...process.env, PATH: FULL_PATH },
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
    // `where` on Windows may return multiple lines — take the first
    return result.split("\n")[0].trim();
  } catch {
    // Will be caught by the caller
  }

  throw new Error("node-not-found");
}

/**
 * Human-readable error message when node is not found.
 * Windows needs a restart after installing node for PATH to update.
 */
export function nodeNotFoundMessage(): string {
  if (IS_WIN) {
    return (
      "ArmorClaw requires Node.js 22 or higher.\n\n" +
      "Please install it from nodejs.org, restart your computer, " +
      "then open ArmorClaw again."
    );
  }
  return (
    "ArmorClaw requires Node.js 22 or higher.\n\n" +
    "Please install it from nodejs.org and restart ArmorClaw."
  );
}

// ── Install path resolution ───────────────────────────────────────────────────

/**
 * Config directory:
 * - Windows: %APPDATA%\ArmorClaw
 * - Mac/Linux: ~/.armorclaw
 */
function armorclawConfigDir(): string {
  if (IS_WIN) {
    const appData = process.env["APPDATA"];
    return appData ? join(appData, "ArmorClaw") : join(homedir(), ".armorclaw");
  }
  return join(homedir(), ".armorclaw");
}

const INSTALL_PATH_FILE = join(armorclawConfigDir(), "install-path.txt");

/**
 * Read the ArmorClaw repo root path (the directory containing openclaw.mjs).
 *
 * Resolution order:
 *  1. ~/.armorclaw/install-path.txt — written by the onboarding wizard (Step 6).
 *     Only used if openclaw.mjs actually exists at the stored path.
 *  2. Walk up from import.meta.dirname (works in dev mode from source tree).
 *  3. Scan common locations in the user's home directory.
 *  4. Walk up from process.cwd() as last resort.
 */
export function getRepoRoot(): string {
  // 1. User-written install path (post-onboarding)
  try {
    if (existsSync(INSTALL_PATH_FILE)) {
      const stored = readFileSync(INSTALL_PATH_FILE, "utf-8").trim();
      if (stored && existsSync(join(stored, "openclaw.mjs"))) {
        return stored;
      }
    }
  } catch {
    // Fall through
  }

  // 2. Walk up from import.meta.dirname (works in dev mode)
  let dir = import.meta.dirname;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "openclaw.mjs"))) {
      return dir;
    }
    const parent = join(dir, "..");
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  // 3. Scan common locations where the repo might be cloned
  const home = homedir();
  const candidates = [
    join(home, "armorclaw"),
    join(home, "ArmorClaw"),
    join(home, "projects", "armorclaw"),
    join(home, "dev", "armorclaw"),
    join(home, "src", "armorclaw"),
    join(home, "code", "armorclaw"),
    join(home, "Desktop", "armorclaw"),
    join(home, "Documents", "armorclaw"),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "openclaw.mjs"))) {
      return candidate;
    }
  }

  // 4. Walk up from cwd (may work if launched from the repo)
  dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "openclaw.mjs"))) {
      return dir;
    }
    const parent = join(dir, "..");
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  // 5. Last resort — return a path that will fail clearly
  return join(home, "armorclaw");
}

// ── Constants ─────────────────────────────────────────────────────────────────

const DASHBOARD_PORT = 7390;
const DASHBOARD_URL = `http://127.0.0.1:${DASHBOARD_PORT}`;
const GATEWAY_PORT = 18789;
const POLL_INTERVAL_MS = 5_000;
const STARTUP_TIMEOUT_MS = 15_000;

// ── LaunchAgent registration ──────────────────────────────────────────────

/**
 * Return the expected LaunchAgent plist path for the current platform.
 * Only macOS uses LaunchAgents. Windows and Linux return null (gateway is
 * started directly as a child process, not via a service manager).
 */
function getLaunchAgentPlistPath(): string | null {
  if (process.platform !== "darwin") {
    return null;
  }
  return join(homedir(), "Library", "LaunchAgents", "ai.openclaw.gateway.plist");
}

/**
 * Disable the OpenClaw LaunchAgent on macOS if it is present.
 *
 * ArmorClaw owns the gateway process lifecycle — it generates the auth token
 * before spawning and passes it via --token. A concurrently-running
 * LaunchAgent gateway (KeepAlive: true) generates its own token, which
 * conflicts with ours and causes permanent "Connecting..." in the dashboard.
 *
 * If the plist exists, unload it so launchd stops managing the gateway.
 * ArmorClaw then spawns it directly as a child process.
 * Never installs the plist — that would re-introduce the conflict.
 * Silent on success; logs on failure but never throws.
 */
function defaultEnsureLaunchAgent(): void {
  const plistPath = getLaunchAgentPlistPath();
  if (!plistPath) {
    return;
  } // Not macOS — nothing to do

  if (!existsSync(plistPath)) {
    return;
  } // Plist not present — nothing to unload

  try {
    execSync(`launchctl unload "${plistPath}"`, {
      stdio: "pipe",
      timeout: 5_000,
      env: { ...process.env, PATH: FULL_PATH },
    });
    process.stderr.write(
      `[gateway-mgr] unloaded OpenClaw LaunchAgent — ArmorClaw now owns gateway lifecycle\n`,
    );
  } catch (err) {
    // Non-fatal: already unloaded, or launchctl unavailable
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[gateway-mgr] launchctl unload (non-fatal): ${msg.slice(0, 200)}\n`);
  }
}

// ── Token read-back ──────────────────────────────────────────────────────────

/**
 * Read the gateway's auth token from ~/.openclaw/openclaw.json.
 *
 * The gateway owns its token entirely — it generates a random token on
 * startup and writes it to openclaw.json. ArmorClaw reads it back after
 * the gateway is confirmed reachable, then uses it for all WebSocket
 * connections and API calls.
 *
 * Returns empty string if the file is missing, malformed, or has no token.
 */
export function readGatewayTokenFromConfig(): string {
  const configPath = join(homedir(), ".openclaw", "openclaw.json");
  try {
    const raw = readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw) as Record<string, unknown>;
    const gw = config["gateway"] as Record<string, unknown> | undefined;
    const auth = gw?.["auth"] as Record<string, unknown> | undefined;
    return typeof auth?.["token"] === "string" ? auth["token"] : "";
  } catch {
    return "";
  }
}

// ── Config pre-write ──────────────────────────────────────────────────────────

/**
 * Pre-write required gateway config values directly to ~/.openclaw/openclaw.json
 * BEFORE spawning the gateway. This eliminates the need for `config set` commands
 * on a live gateway, which trigger reloads and token regeneration (cascade).
 *
 * Deep-merges into existing config — only writes keys that are missing or wrong.
 * Skips the write entirely if all values are already correct.
 */
function preWriteGatewayConfig(wrapperPath: string): void {
  const configDir = join(homedir(), ".openclaw");
  const configPath = join(configDir, "openclaw.json");

  let config: Record<string, unknown> = {};
  try {
    if (existsSync(configPath)) {
      config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    }
  } catch {
    // Malformed JSON — start fresh (preserving nothing is safer than crashing)
    config = {};
  }

  let changed = false;

  // gateway.mode = "local"
  const gw = (config["gateway"] ?? {}) as Record<string, unknown>;
  if (gw["mode"] !== "local") {
    gw["mode"] = "local";
    changed = true;
  }

  // gateway.controlUi.allowedOrigins = ["*"]
  const controlUi = (gw["controlUi"] ?? {}) as Record<string, unknown>;
  const origins = controlUi["allowedOrigins"];
  if (!Array.isArray(origins) || origins.length !== 1 || origins[0] !== "*") {
    controlUi["allowedOrigins"] = ["*"];
    changed = true;
  }
  gw["controlUi"] = controlUi;
  config["gateway"] = gw;

  // plugins.load.paths = ["<wrapperPath>"]
  const plugins = (config["plugins"] ?? {}) as Record<string, unknown>;
  const load = (plugins["load"] ?? {}) as Record<string, unknown>;
  const paths = load["paths"];
  if (!Array.isArray(paths) || paths.length !== 1 || paths[0] !== wrapperPath) {
    load["paths"] = [wrapperPath];
    changed = true;
  }
  plugins["load"] = load;

  // plugins.allow = ["wrapper"]
  const allow = plugins["allow"];
  if (!Array.isArray(allow) || allow.length !== 1 || allow[0] !== "wrapper") {
    plugins["allow"] = ["wrapper"];
    changed = true;
  }
  config["plugins"] = plugins;

  if (!changed) {
    process.stderr.write(`[gateway-mgr] config already correct — skipping pre-write\n`);
    return;
  }

  mkdirSync(configDir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
  process.stderr.write(`[gateway-mgr] pre-wrote gateway config to ${configPath}\n`);
}

// ── Gateway Manager ───────────────────────────────────────────────────────────

export interface GatewayManagerOptions {
  /** Override gateway spawn (test injection). */
  spawnGateway?: () => ChildProcess;
  /** Override health check (test injection). Returns parsed dashboard snapshot or null. */
  checkHealth?: () => Promise<Record<string, unknown> | null>;
  /** Override poll interval in ms. */
  pollIntervalMs?: number;
  /** Override node binary path (test injection). */
  nodePath?: string;
  /** Override LaunchAgent install check (test injection). */
  ensureLaunchAgent?: () => void;
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
  private _ensureLaunchAgent: () => void;
  private _launchAgentChecked = false;
  private _pollIntervalMs: number;
  /** Set after a failed node lookup so the tray can show a dialog. */
  public nodeNotFoundError: string | null = null;

  constructor(options: GatewayManagerOptions = {}) {
    super();

    if (options.spawnGateway) {
      this._spawnGateway = options.spawnGateway;
    } else {
      // Resolve node + repo root once at construction time
      let nodePath = options.nodePath ?? null;
      if (!nodePath) {
        try {
          nodePath = findNodePath();
        } catch {
          this.nodeNotFoundError = nodeNotFoundMessage();
          nodePath = "node"; // will fail at spawn time — caught gracefully
        }
      }
      const repoRoot = getRepoRoot();
      const openclawMjs = join(repoRoot, "openclaw.mjs");
      const resolvedNode = nodePath;

      this._spawnGateway = () => {
        // Pre-write config so the gateway starts with correct values in place.
        // This replaces the old `config set` calls in launchGateway() which
        // modified openclaw.json on a live gateway, triggering reloads and
        // token regeneration (cascade).
        preWriteGatewayConfig(join(repoRoot, "wrapper"));

        // The gateway owns its auth token — it generates one on startup and
        // writes it to ~/.openclaw/openclaw.json. We read it back after the
        // gateway is confirmed reachable (see start()). No --token flag, no
        // token generation here.
        const args = [openclawMjs, "gateway"];
        const hasKey = Boolean(process.env["ANTHROPIC_API_KEY"] || process.env["OPENAI_API_KEY"]);
        process.stderr.write(
          `[gateway-mgr] spawn: ${resolvedNode} openclaw.mjs gateway ` +
            `apiKey=${hasKey ? "present" : "MISSING"} ` +
            `cwd=${repoRoot}\n`,
        );
        const child = spawn(resolvedNode, args, {
          stdio: ["ignore", "ignore", "pipe"],
          cwd: repoRoot,
          env: childEnv(),
        });
        // Capture stderr so gateway startup errors surface visibly
        if (child.stderr) {
          let stderrBuf = "";
          child.stderr.on("data", (chunk: Buffer) => {
            stderrBuf += chunk.toString();
            // Flush line-by-line
            const lines = stderrBuf.split("\n");
            stderrBuf = lines.pop() ?? "";
            for (const line of lines) {
              if (line.trim()) {
                process.stderr.write(`[gateway] ${line}\n`);
              }
            }
          });
          child.stderr.on("end", () => {
            if (stderrBuf.trim()) {
              process.stderr.write(`[gateway] ${stderrBuf}\n`);
            }
          });
        }
        return child;
      };
    }

    this._checkHealth = options.checkHealth ?? (() => defaultHealthCheck());
    this._ensureLaunchAgent = options.ensureLaunchAgent ?? defaultEnsureLaunchAgent;
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
    process.stderr.write(`[gateway-mgr] start() called\n`);

    // Ensure the LaunchAgent is registered (macOS only, runs once per install)
    if (!this._launchAgentChecked) {
      this._launchAgentChecked = true;
      try {
        this._ensureLaunchAgent();
      } catch {
        // Non-fatal — continue with direct spawn
      }
    }

    // Check if gateway is already running (user may have started it manually)
    const existing = await this._checkHealth();
    if (existing) {
      process.stderr.write(`[gateway-mgr] gateway already running — attaching\n`);
      this._syncTokenFromConfig();
      this._applySnapshot(existing);
      this._startPolling();
      return;
    }

    // Spawn the gateway process
    process.stderr.write(`[gateway-mgr] gateway not running — spawning\n`);
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
        this._syncTokenFromConfig();
        this._applySnapshot(snap);
        this._startPolling();
        return;
      }
    }

    // Timed out — might still be starting, keep polling
    this._syncTokenFromConfig();
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

  /**
   * Read the gateway's self-generated token from openclaw.json and set it
   * in process.env so the dashboard, chat panel, and syncGatewayToken()
   * all use the correct value.
   */
  private _syncTokenFromConfig(): void {
    const token = readGatewayTokenFromConfig();
    if (token) {
      process.env["ARMORCLAW_GATEWAY_TOKEN"] = token;
      process.stderr.write(
        `[gateway-mgr] read token from openclaw.json: ${token.slice(0, 8)}...\n`,
      );
    } else {
      process.stderr.write(
        `[gateway-mgr] warning: no token in openclaw.json after gateway confirmed reachable\n`,
      );
    }
  }

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

/**
 * Verify the gateway WebSocket port (18789) accepts connections.
 * This is the real liveness check — the dashboard on 7390 runs in-process
 * and would always respond even if the gateway never started.
 */
function probeGatewayPort(): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection(
      { host: "127.0.0.1", port: GATEWAY_PORT, timeout: 2000 },
      () => {
        sock.destroy();
        resolve(true);
      },
    );
    sock.on("error", () => resolve(false));
    sock.on("timeout", () => {
      sock.destroy();
      resolve(false);
    });
  });
}

async function defaultHealthCheck(): Promise<Record<string, unknown> | null> {
  // First, verify the actual gateway port is reachable.
  // The dashboard on 7390 runs in-process and always responds — it can't
  // tell us whether the gateway on 18789 is alive.
  const gatewayUp = await probeGatewayPort();
  if (!gatewayUp) {
    return null;
  }

  // Gateway is up — fetch the dashboard snapshot for status details
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
