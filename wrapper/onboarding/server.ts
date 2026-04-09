/**
 * Onboarding wizard — Express HTTP server.
 *
 * All routes are bound to localhost only. The server is never exposed on
 * 0.0.0.0 or any public address.
 */

import { execSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import express from "express";

// ── OAuth scope constants ─────────────────────────────────────────────────────

const GOOGLE_SCOPES = "https://mail.google.com/ https://www.googleapis.com/auth/calendar";
const MICROSOFT_SCOPES = "offline_access Mail.Read Mail.Send Calendars.ReadWrite";

import { setEnvVar } from "./env-writer.ts";
import {
  advanceStep,
  getState,
  goBack,
  notifyListeners,
  onStateChange,
  updateState,
} from "./state.ts";
import {
  detectTailscale,
  pollForTailscale,
  serveTailscale,
  tailscaleDownloadUrl,
} from "./tailscale.ts";
import { validateStep1, validateStep2, validateStep4, validateStep5 } from "./validators.ts";

const WIZARD_HTML = join(import.meta.dirname, "public", "wizard.html");

/** Dashboard port — will be served via Tailscale serve in Step 4. */
export const DASHBOARD_PORT = 7390;

/** Set by startServer() so route handlers can build the correct wizard URL. */
let activePort: number | null = null;

/**
 * The port the OAuth callback server is listening on.
 * This is separate from the wizard UI port so that redirect URIs registered
 * in Google Cloud Console / Azure don't break when the wizard UI falls back
 * to a different port. Preferred: 7392.
 */
let callbackPort: number | null = null;

// ── API key test calls ────────────────────────────────────────────────────────

/**
 * Structured result from a live key test.
 * - `blocking: true`  → definite auth failure (401/403); show error and stop.
 * - `warning`         → soft problem (network, timeout, server error); show
 *                       warning but allow the user to continue.
 * - neither           → all good, advance silently.
 */
interface KeyTestResult {
  blocking?: true;
  message?: string; // shown for blocking errors
  warning?: string; // shown for soft warnings
}

async function testAnthropicKey(key: string): Promise<KeyTestResult> {
  try {
    // GET /v1/models: no token spend, returns 401 for bad keys, 200 for valid.
    const res = await fetch("https://api.anthropic.com/v1/models", {
      headers: {
        "x-api-key": key.trim(),
        "anthropic-version": "2023-06-01",
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (res.ok) {
      return {};
    } // 200 — key is valid

    if (res.status === 401 || res.status === 403) {
      return {
        blocking: true,
        message: "That key didn't work — double-check you copied the whole thing.",
      };
    }

    if (res.status === 429) {
      return {
        warning:
          "Key verified — you're hitting rate limits, which means it's working. You can continue.",
      };
    }

    // 5xx or anything else: API-side problem, not a key problem.
    return {
      warning: `We couldn't verify this key right now (server returned ${res.status}), but it looks valid. You can continue and test it later.`,
    };
  } catch (err: unknown) {
    const isTimeout =
      err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
    const reason = isTimeout
      ? "The verification check timed out."
      : "We couldn't reach Anthropic's servers.";
    return {
      warning: `${reason} Your key looks valid, so you can continue. If ArmorClaw can't connect later, check your internet connection.`,
    };
  }
}

async function testOpenAIKey(key: string): Promise<KeyTestResult> {
  try {
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${key.trim()}` },
      signal: AbortSignal.timeout(10_000),
    });

    if (res.ok) {
      return {};
    }

    if (res.status === 401 || res.status === 403) {
      return {
        blocking: true,
        message: "That key didn't work — double-check you copied the whole thing.",
      };
    }

    if (res.status === 429) {
      return {
        warning:
          "Key verified — you're hitting rate limits, which means it's working. You can continue.",
      };
    }

    return {
      warning: `We couldn't verify this key right now (server returned ${res.status}), but it looks valid. You can continue and test it later.`,
    };
  } catch (err: unknown) {
    const isTimeout =
      err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
    const reason = isTimeout
      ? "The verification check timed out."
      : "We couldn't reach OpenAI's servers.";
    return {
      warning: `${reason} Your key looks valid, so you can continue. If ArmorClaw can't connect later, check your internet connection.`,
    };
  }
}

async function testOllamaUrl(url: string): Promise<KeyTestResult> {
  try {
    const base = url.trim().replace(/\/$/, "");
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(5_000) });
    if (res.ok) {
      return {};
    }
    return {
      blocking: true,
      message: `Couldn't connect to Ollama at ${url}. Make sure Ollama is running and the address is correct.`,
    };
  } catch (err: unknown) {
    const isTimeout =
      err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
    return {
      blocking: true,
      message: isTimeout
        ? `Timed out connecting to Ollama at ${url}. Make sure Ollama is running.`
        : `Couldn't connect to Ollama at ${url}. Make sure Ollama is running and the address is correct.`,
    };
  }
}

// ── Mobile ping registry ──────────────────────────────────────────────────────

type MobileChannel = "telegram" | "whatsapp";

const _registeredPings = new Set<MobileChannel>();

export function registerMobilePing(channel: MobileChannel): void {
  _registeredPings.add(channel);
  const channels = [..._registeredPings];
  updateState({ connectedChannels: channels, mobilePingReceived: true });
  notifyListeners();
}

// ── Tailscale background polling ──────────────────────────────────────────────

let _tailscalePollPromise: Promise<void> | null = null;

function startTailscalePoll(): void {
  if (_tailscalePollPromise) {
    return;
  }
  _tailscalePollPromise = (async () => {
    const result = await pollForTailscale(180_000);
    if (result.authenticated) {
      const serveResult = await serveTailscale(DASHBOARD_PORT);
      updateState({
        tailscaleStatus: "detected",
        tailscaleUrl: serveResult.url ?? result.tsNetUrl,
      });
    } else {
      // Reset to "pending" so the UI shows the initial install/defer buttons
      // again instead of being stuck in a dead "installing" state.
      updateState({ tailscaleStatus: "pending" });
    }
    // Allow re-polling if the user clicks "Install Tailscale now" again
    _tailscalePollPromise = null;
    notifyListeners();
  })();
}

// ── OAuth callback handler ────────────────────────────────────────────────────

/**
 * Exchange an OAuth authorization code for access + refresh tokens.
 * Stores both tokens in .env (GOOGLE_OAUTH_ACCESS_TOKEN / _REFRESH_TOKEN
 * or MICROSOFT_OAUTH_ACCESS_TOKEN / _REFRESH_TOKEN).
 *
 * Returns true on success, false on failure.
 */
async function exchangeOAuthCode(
  provider: "gmail" | "outlook",
  code: string,
): Promise<{ ok: boolean; error?: string }> {
  const cbPort = callbackPort ?? 7392;
  const redirectUri =
    provider === "gmail"
      ? `http://localhost:${cbPort}/auth/google/callback`
      : `http://localhost:${cbPort}/auth/microsoft/callback`;

  process.stderr.write(
    `[oauth] exchangeOAuthCode: provider=${provider} code=${code.slice(0, 20)}... redirectUri=${redirectUri}\n`,
  );
  try {
    if (provider === "gmail") {
      const clientId = process.env["GOOGLE_OAUTH_CLIENT_ID"]?.trim();
      const clientSecret = process.env["GOOGLE_OAUTH_CLIENT_SECRET"]?.trim();
      if (!clientId || !clientSecret) {
        process.stderr.write(
          `[oauth] ERROR: Google OAuth credentials not in env (clientId=${!!clientId} clientSecret=${!!clientSecret})\n`,
        );
        return { ok: false, error: "Google OAuth credentials not configured." };
      }
      process.stderr.write(
        `[oauth] POSTing to https://oauth2.googleapis.com/token (clientId=${clientId.slice(0, 20)}...)\n`,
      );
      const res = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const body = await res.text();
        process.stderr.write(
          `[oauth] ERROR: Google token exchange failed (${res.status}): ${body.slice(0, 300)}\n`,
        );
        return {
          ok: false,
          error: `Google token exchange failed (${res.status}): ${body.slice(0, 200)}`,
        };
      }
      const tokens = (await res.json()) as Record<string, unknown>;
      process.stderr.write(
        `[oauth] SUCCESS: Google tokens received — access_token=${typeof tokens["access_token"] === "string" ? "present" : "MISSING"} refresh_token=${typeof tokens["refresh_token"] === "string" ? "present" : "MISSING"}\n`,
      );
      setEnvVar("GOOGLE_OAUTH_ACCESS_TOKEN", (tokens["access_token"] as string) ?? "");
      if (tokens["refresh_token"]) {
        setEnvVar("GOOGLE_OAUTH_REFRESH_TOKEN", tokens["refresh_token"] as string);
      }
    } else {
      const clientId = process.env["MICROSOFT_OAUTH_CLIENT_ID"]?.trim();
      const clientSecret = process.env["MICROSOFT_OAUTH_CLIENT_SECRET"]?.trim();
      if (!clientId || !clientSecret) {
        return { ok: false, error: "Microsoft OAuth credentials not configured." };
      }
      const res = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
          scope: MICROSOFT_SCOPES,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const body = await res.text();
        return {
          ok: false,
          error: `Microsoft token exchange failed (${res.status}): ${body.slice(0, 200)}`,
        };
      }
      const tokens = (await res.json()) as Record<string, unknown>;
      setEnvVar("MICROSOFT_OAUTH_ACCESS_TOKEN", (tokens["access_token"] as string) ?? "");
      if (tokens["refresh_token"]) {
        setEnvVar("MICROSOFT_OAUTH_REFRESH_TOKEN", tokens["refresh_token"] as string);
      }
    }
    return { ok: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

async function handleOAuthCallback(
  provider: "gmail" | "outlook",
  code: string | undefined,
  error: string | undefined,
  res: express.Response,
): Promise<void> {
  if (error || !code) {
    process.stderr.write(`[oauth] handleOAuthCallback: FAILED — error=${error ?? "no code"}\n`);
    res.send(`<!DOCTYPE html><html><head><title>Connection failed</title></head><body>
      <p style="font-family:sans-serif;padding:24px;color:#A32D2D">
        Connection failed${error ? `: ${error}` : ""}. You can close this tab and try again.
      </p>
      <script>setTimeout(() => window.close(), 4000);</script>
    </body></html>`);
    return;
  }

  // Exchange the auth code for access + refresh tokens synchronously
  // so we can show the actual result in the callback page.
  const result = await exchangeOAuthCode(provider, code);

  if (result.ok) {
    if (provider === "gmail") {
      updateState({ gmailConnected: true });
    } else {
      updateState({ outlookConnected: true });
    }
    // Also store the auth code as a fallback marker
    if (provider === "gmail") {
      setEnvVar("GOOGLE_AUTH_CODE_PENDING", code);
    } else {
      setEnvVar("MICROSOFT_AUTH_CODE_PENDING", code);
    }
    notifyListeners();

    res.send(`<!DOCTYPE html><html><head><title>Connected</title></head><body>
      <p style="font-family:sans-serif;padding:24px;color:#1D9E75;font-size:18px">
        ✓ Connected successfully. You can close this tab.
      </p>
      <script>setTimeout(() => window.close(), 3000);</script>
    </body></html>`);
  } else {
    process.stderr.write(`[oauth] handleOAuthCallback: token exchange FAILED — ${result.error}\n`);
    notifyListeners();

    res.send(`<!DOCTYPE html><html><head><title>Connection failed</title></head><body>
      <p style="font-family:sans-serif;padding:24px;color:#A32D2D;max-width:600px">
        Token exchange failed: ${result.error?.replace(/</g, "&lt;").replace(/>/g, "&gt;") ?? "Unknown error"}<br><br>
        You can close this tab and try again.
      </p>
    </body></html>`);
  }
}

// ── Step 6 — Gateway launch sequence ──────────────────────────────────────────

/**
 * Repo root resolution: when running inside the Electron launcher, the
 * ARMORCLAW_REPO_ROOT env var is set by main.ts before importing this module.
 * When running standalone (node wrapper/onboarding/index.ts), fall back to
 * walking up from import.meta.dirname.
 */
function resolveRepoRoot(): string {
  // Env var set by the Electron launcher
  const fromEnv = process.env["ARMORCLAW_REPO_ROOT"];
  if (fromEnv) {
    return fromEnv;
  }
  // Standalone dev mode: onboarding/ → wrapper/ → repo root
  return join(import.meta.dirname, "..", "..");
}

const REPO_ROOT = resolveRepoRoot();
const OPENCLAW_MJS = join(REPO_ROOT, "openclaw.mjs");
const OPENCLAW_CONFIG = join(homedir(), ".openclaw", "openclaw.json");
const ARMORCLAW_DIR = join(homedir(), ".armorclaw");

/**
 * Resolve the node binary path for spawning child processes.
 *
 * When running inside the Electron launcher, ARMORCLAW_NODE_PATH is set by
 * main.ts using findNodePath() (which probes Homebrew, system, and nvm paths).
 * When running standalone, falls back to "node" on PATH.
 */
function resolveNodePath(): string {
  return process.env["ARMORCLAW_NODE_PATH"] ?? "node";
}

/**
 * Injectable seam for `execSync` — used by tests to capture commands
 * without actually spawning processes.
 */
export let _execCommand: (cmd: string) => void = (cmd) =>
  execSync(cmd, {
    stdio: "pipe",
    timeout: 15_000,
    cwd: process.env["ARMORCLAW_REPO_ROOT"] ?? REPO_ROOT,
    env: {
      ...process.env,
      PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${process.env["PATH"] ?? ""}`,
    },
  });

/** Injectable seam for gateway spawn — returns the ChildProcess. */
export let _spawnGateway: () => ReturnType<typeof spawn> = () => {
  const root = process.env["ARMORCLAW_REPO_ROOT"] ?? REPO_ROOT;
  const mjs = join(root, "openclaw.mjs");
  const token = process.env["ARMORCLAW_GATEWAY_TOKEN"] ?? "";
  // If we have a known token, pass it via --token so the gateway uses it
  // instead of auto-generating a different one that won't match.
  const args = [mjs, "gateway"];
  if (token) {
    args.push("--token", token);
  }
  const child = spawn(resolveNodePath(), args, {
    stdio: ["ignore", "ignore", "pipe"],
    detached: true,
    cwd: root,
    env: {
      ...process.env,
      PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${process.env["PATH"] ?? ""}`,
    },
  });
  // Capture stderr so gateway startup failures surface in the launcher log
  if (child.stderr) {
    let buf = "";
    child.stderr.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) {
          process.stderr.write(`[gateway] ${line}\n`);
        }
      }
    });
    child.stderr.on("end", () => {
      if (buf.trim()) {
        process.stderr.write(`[gateway] ${buf}\n`);
      }
    });
  }
  return child;
};

/** Override command runner. Test use only. */
export function setExecCommandForTesting(fn: (cmd: string) => void): void {
  _execCommand = fn;
}

/** Override gateway spawner. Test use only. */
export function setSpawnGatewayForTesting(fn: () => ReturnType<typeof spawn>): void {
  _spawnGateway = fn;
}

// ── Launch checklist types ────────────────────────────────────────────────────

export type LaunchStepId =
  | "backup"
  | "config"
  | "gateway-install"
  | "gateway-start"
  | "gateway-reachable"
  | "plugin-loaded"
  | "channel-check";

export type LaunchStepStatus = "pending" | "running" | "done" | "warn" | "error";

export interface LaunchStep {
  id: LaunchStepId;
  label: string;
  status: LaunchStepStatus;
  detail?: string;
}

export interface LaunchResult {
  ok: boolean;
  message?: string;
  steps: LaunchStep[];
}

/** Listeners for step-by-step progress updates. */
const _launchListeners: Array<(steps: LaunchStep[]) => void> = [];

export function onLaunchProgress(fn: (steps: LaunchStep[]) => void): () => void {
  _launchListeners.push(fn);
  return () => {
    const idx = _launchListeners.indexOf(fn);
    if (idx >= 0) {
      _launchListeners.splice(idx, 1);
    }
  };
}

function emitProgress(steps: LaunchStep[]): void {
  for (const fn of _launchListeners) {
    fn(steps);
  }
}

// ── Injectable health check ──────────────────────────────────────────────────

export let _httpGet: (url: string) => Promise<string | null> = async (url) => {
  const http = await import("node:http");
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 3000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve(null);
        return;
      }
      let data = "";
      res.on("data", (chunk: Buffer) => {
        data += chunk.toString();
      });
      res.on("end", () => resolve(data));
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
};

export function setHttpGetForTesting(fn: (url: string) => Promise<string | null>): void {
  _httpGet = fn;
}

/**
 * Injectable TCP port probe — verifies the gateway WebSocket port is accepting
 * connections. The dashboard on 7390 runs in-process and always responds, so
 * it can't tell us if the gateway actually started.
 */
export let _probePort: (port: number) => Promise<boolean> = async (port) => {
  const net = await import("node:net");
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: "127.0.0.1", port, timeout: 2000 }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.on("error", () => resolve(false));
    sock.on("timeout", () => {
      sock.destroy();
      resolve(false);
    });
  });
};

export function setProbePortForTesting(fn: (port: number) => Promise<boolean>): void {
  _probePort = fn;
}

// ── Launch sequence ──────────────────────────────────────────────────────────

/**
 * Full gateway launch sequence — called by "Finish setup".
 *
 * Steps:
 *  1. Back up existing channel config (if reinstalling)
 *  2. Write gateway + plugin config
 *  3. Start the gateway process
 *  4. Verify gateway is reachable (up to 15s)
 *  5. Verify ArmorClaw plugin is loaded
 *  6. Check messaging channel connectivity
 *
 * Emits progress via onLaunchProgress() so the wizard can show
 * a live checklist with checkmarks appearing one by one.
 */
export async function launchGateway(): Promise<LaunchResult> {
  process.stderr.write(`[launch] launchGateway() called\n`);
  process.stderr.write(`[launch] REPO_ROOT=${REPO_ROOT}\n`);
  process.stderr.write(`[launch] OPENCLAW_MJS=${OPENCLAW_MJS}\n`);
  process.stderr.write(`[launch] OPENCLAW_MJS exists=${existsSync(OPENCLAW_MJS)}\n`);
  process.stderr.write(`[launch] nodeBin=${resolveNodePath()}\n`);

  const steps: LaunchStep[] = [
    { id: "backup", label: "Backing up existing config", status: "pending" },
    { id: "config", label: "Writing gateway configuration", status: "pending" },
    { id: "gateway-install", label: "Gateway registered", status: "pending" },
    { id: "gateway-start", label: "Starting the gateway", status: "pending" },
    { id: "gateway-reachable", label: "Waiting for gateway to respond", status: "pending" },
    { id: "plugin-loaded", label: "Verifying ArmorClaw security layer", status: "pending" },
    { id: "channel-check", label: "Checking messaging channels", status: "pending" },
  ];

  function mark(id: LaunchStepId, status: LaunchStepStatus, detail?: string): void {
    const step = steps.find((s) => s.id === id)!;
    step.status = status;
    if (detail) {
      step.detail = detail;
    }
    emitProgress([...steps]);
  }

  // ── 1. Back up existing channel config ──────────────────────────────────

  mark("backup", "running");
  try {
    if (existsSync(OPENCLAW_CONFIG)) {
      mkdirSync(ARMORCLAW_DIR, { recursive: true });
      copyFileSync(OPENCLAW_CONFIG, join(ARMORCLAW_DIR, "channels-backup.json"));
    }
    mark("backup", "done");
  } catch {
    mark("backup", "warn", "Could not back up existing config — continuing");
  }

  // Write install path so the launcher can find openclaw.mjs from /Applications.
  // Use the env var (set by main.ts from getRepoRoot()) not the module-level
  // REPO_ROOT which may have been evaluated before the env var was set.
  const resolvedRoot = process.env["ARMORCLAW_REPO_ROOT"] ?? REPO_ROOT;
  try {
    mkdirSync(ARMORCLAW_DIR, { recursive: true });
    // Only write if openclaw.mjs actually exists at this path
    if (existsSync(join(resolvedRoot, "openclaw.mjs"))) {
      const { writeFileSync: wfs } = await import("node:fs");
      wfs(join(ARMORCLAW_DIR, "install-path.txt"), resolvedRoot + "\n", "utf-8");
      process.stderr.write(`[launch] wrote install-path.txt → ${resolvedRoot}\n`);
    } else {
      process.stderr.write(
        `[launch] skipped install-path.txt — openclaw.mjs not found at ${resolvedRoot}\n`,
      );
    }
  } catch (err) {
    process.stderr.write(
      `[launch] install-path.txt write failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  // ── 2. Write gateway + plugin config ────────────────────────────────────

  mark("config", "running");
  setEnvVar("ARMORCLAW_GATEWAY_MODE", "local");

  // Use the resolved repo root (from env var) for all paths, not the
  // module-level constants which may point inside the asar.
  const actualRoot = process.env["ARMORCLAW_REPO_ROOT"] ?? REPO_ROOT;
  const actualMjs = join(actualRoot, "openclaw.mjs");
  const actualWrapper = join(actualRoot, "wrapper");
  const nodeBin = resolveNodePath();
  const oc = `"${nodeBin}" "${actualMjs}"`;
  process.stderr.write(
    `[launch] config using: root=${actualRoot} mjs=${actualMjs} wrapper=${actualWrapper}\n`,
  );
  // Do NOT set gateway.auth.token — let the gateway generate and own its token.
  // ArmorClaw reads it back from openclaw.json after the gateway starts.
  const configCommands = [
    `${oc} config set gateway.mode local`,
    `${oc} config set gateway.controlUi.allowedOrigins '["*"]'`,
    `${oc} config set plugins.load.paths '["${actualWrapper}"]'`,
    `${oc} config set plugins.allow '["armorclaw"]'`,
  ];

  // memory.paths was removed — OpenClaw's current schema does not expose a
  // memory.paths config key. Vector search is configured separately when the
  // memory module matures. Attempting to set it causes a config validation
  // error on every launch, so we skip it until the key lands in upstream.

  // If a Telegram bot token was configured in the wizard, set the channel
  // policy so the bot responds to the owner immediately.
  // Note: `openclaw channels add --channel telegram` is not supported in the
  // current OpenClaw build — "Unknown channel: telegram". We write the token
  // to .env (TELEGRAM_BOT_TOKEN) as a fallback, which the gateway picks up,
  // and set allowFrom/dmPolicy via config set which do work.
  const state = getState();
  const telegramToken = process.env["TELEGRAM_BOT_TOKEN"]?.trim();
  if (state.connectedChannels.includes("telegram") || telegramToken) {
    configCommands.push(
      `${oc} config set channels.telegram.allowFrom '["*"]'`,
      `${oc} config set channels.telegram.dmPolicy open`,
    );
  }

  let configErrors = 0;
  for (const cmd of configCommands) {
    try {
      process.stderr.write(`[launch] exec: ${cmd.slice(0, 120)}\n`);
      _execCommand(cmd);
      process.stderr.write(`[launch]   → ok\n`);
    } catch (err) {
      configErrors++;
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[launch]   → FAILED: ${msg.slice(0, 200)}\n`);
    }
  }

  // Restore channel config from backup after writing new config
  try {
    const backupPath = join(ARMORCLAW_DIR, "channels-backup.json");
    if (existsSync(backupPath) && existsSync(OPENCLAW_CONFIG)) {
      const backup = JSON.parse(readFileSync(backupPath, "utf-8")) as Record<string, unknown>;
      const current = JSON.parse(readFileSync(OPENCLAW_CONFIG, "utf-8")) as Record<string, unknown>;
      const channelKeys = ["channels", "telegram", "whatsapp", "signal"];
      let restored = false;
      for (const key of channelKeys) {
        if (backup[key] && !current[key]) {
          current[key] = backup[key];
          restored = true;
        }
      }
      if (restored) {
        const { writeFileSync: wfs } = await import("node:fs");
        wfs(OPENCLAW_CONFIG, JSON.stringify(current, null, 2), "utf-8");
      }
    }
  } catch {
    // Non-fatal
  }

  if (configErrors > 0) {
    mark("config", "warn", `${configErrors} config command(s) failed — gateway may use defaults`);
  } else {
    mark("config", "done");
  }

  // ── 2b. Ensure gateway LaunchAgent is registered (macOS only) ──────────
  //
  // On macOS the gateway runs as a LaunchAgent. If the plist is missing
  // (first install, or user cleaned LaunchAgents), register it now.
  // Non-fatal — if it fails, the direct spawn in step 3 still works.

  mark("gateway-install", "running");
  if (process.platform === "darwin") {
    const plistPath = join(homedir(), "Library", "LaunchAgents", "ai.openclaw.gateway.plist");
    if (existsSync(plistPath)) {
      mark("gateway-install", "done");
    } else {
      try {
        const nodeBinInstall = resolveNodePath();
        const ocInstall = `"${nodeBinInstall}" "${actualMjs}"`;
        process.stderr.write(`[launch] exec: ${ocInstall} gateway install\n`);
        _execCommand(`${ocInstall} gateway install`);
        process.stderr.write(`[launch]   → ok\n`);
        mark("gateway-install", "done");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[launch] gateway install failed (non-fatal): ${msg.slice(0, 200)}\n`);
        mark("gateway-install", "warn", "Could not register gateway service — will start directly");
      }
    }
  } else {
    // Windows/Linux: no LaunchAgent needed — skip silently
    mark("gateway-install", "done");
  }

  // ── 3. Start the gateway ────────────────────────────────────────────────
  //
  // GatewayManager may have already started the gateway before the wizard
  // reaches Step 6. Probe port 18789 first — if it's already reachable,
  // skip the spawn and go straight to config writes and token read.

  const GATEWAY_PORT = 18789;
  const alreadyRunning = await _probePort(GATEWAY_PORT);

  mark("gateway-start", "running");
  if (alreadyRunning) {
    process.stderr.write(
      `[launch] gateway already running on port ${GATEWAY_PORT} — skipping spawn\n`,
    );
    mark("gateway-start", "done");
  } else {
    try {
      process.stderr.write(
        `[launch] spawning gateway: ${resolveNodePath()} ${OPENCLAW_MJS} gateway\n`,
      );
      const child = _spawnGateway();
      child.unref();
      process.stderr.write(`[launch] gateway spawned — pid=${child.pid}\n`);
      // Listen for early exit to catch immediate failures
      child.on("error", (e) =>
        process.stderr.write(`[launch] gateway spawn error: ${e.message}\n`),
      );
      child.on("exit", (code) =>
        process.stderr.write(`[launch] gateway exited with code=${code}\n`),
      );
      mark("gateway-start", "done");
    } catch (err) {
      const detail = `Could not start the gateway: ${err instanceof Error ? err.message : String(err)}`;
      process.stderr.write(`[launch] SPAWN FAILED: ${detail}\n`);
      mark("gateway-start", "error", detail);
      return {
        ok: false,
        message: detail,
        steps,
      };
    }
  }

  // ── 4. Verify gateway is reachable (up to 15s) ─────────────────────────
  //
  // Probe the actual gateway WebSocket port (18789), NOT the dashboard
  // port (7390). The dashboard runs in-process and always responds —
  // it can't tell us whether the gateway process actually started.

  mark("gateway-reachable", "running");
  process.stderr.write(`[launch] polling gateway port ${GATEWAY_PORT}\n`);
  let gatewayUp = alreadyRunning;

  if (!gatewayUp) {
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise((r) => setTimeout(r, 500));
      gatewayUp = await _probePort(GATEWAY_PORT);
      if (gatewayUp) {
        process.stderr.write(
          `[launch] gateway port ${GATEWAY_PORT} reachable on attempt ${attempt + 1}\n`,
        );
        break;
      }
    }
  } else {
    process.stderr.write(`[launch] gateway port ${GATEWAY_PORT} already confirmed reachable\n`);
  }

  if (!gatewayUp) {
    process.stderr.write(
      `[launch] gateway port ${GATEWAY_PORT} never responded after 30 attempts\n`,
    );
    mark("gateway-reachable", "error", "Gateway did not respond within 15 seconds");
    return {
      ok: false,
      message: "The gateway started but isn't responding yet. Click Retry to try again.",
      steps,
    };
  }
  mark("gateway-reachable", "done");

  // Now fetch the dashboard snapshot for plugin verification below
  const dashboardUrl = `http://127.0.0.1:${DASHBOARD_PORT}/api/dashboard`;
  let dashboardData = await _httpGet(dashboardUrl);

  // ── 4b. Read the gateway's own token from openclaw.json → .env ──────────
  // The gateway generates and owns its auth token. We read it back so the
  // dashboard and chat window can authenticate.
  try {
    const configPath = join(homedir(), ".openclaw", "openclaw.json");
    if (existsSync(configPath)) {
      const cfg = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
      const gw = cfg["gateway"] as Record<string, unknown> | undefined;
      const auth = gw?.["auth"] as Record<string, unknown> | undefined;
      const gatewayToken = typeof auth?.["token"] === "string" ? auth["token"] : "";
      if (gatewayToken) {
        setEnvVar("ARMORCLAW_GATEWAY_TOKEN", gatewayToken);
        process.stderr.write(
          `[launch] read gateway token from openclaw.json: ${gatewayToken.slice(0, 12)}...\n`,
        );

        // Writing the token to .env triggers OpenClaw to detect a config
        // change and restart the gateway (clean exit with code=0). Wait for
        // the port to drop, then re-poll until the gateway is back up.
        process.stderr.write(`[launch] waiting for gateway restart after token write\n`);
        await new Promise((r) => setTimeout(r, 1000));

        let gatewayBack = await _probePort(GATEWAY_PORT);
        if (!gatewayBack) {
          process.stderr.write(
            `[launch] gateway port ${GATEWAY_PORT} dropped — re-polling for restart\n`,
          );
          for (let attempt = 0; attempt < 30; attempt++) {
            await new Promise((r) => setTimeout(r, 500));
            gatewayBack = await _probePort(GATEWAY_PORT);
            if (gatewayBack) {
              process.stderr.write(`[launch] gateway back on attempt ${attempt + 1}\n`);
              break;
            }
          }
          if (!gatewayBack) {
            process.stderr.write(
              `[launch] WARNING: gateway did not come back after token write — continuing anyway\n`,
            );
          }
        } else {
          process.stderr.write(
            `[launch] gateway still up after token write (restart may be delayed)\n`,
          );
        }
      } else {
        process.stderr.write(`[launch] WARNING: no gateway token found in openclaw.json\n`);
      }
    }
  } catch (err) {
    process.stderr.write(
      `[launch] failed to read gateway token: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  // ── 5. Verify ArmorClaw plugin is loaded ────────────────────────────────

  // Re-fetch dashboard data after possible gateway restart so the
  // plugin verification below uses a fresh snapshot.
  dashboardData = await _httpGet(dashboardUrl);

  mark("plugin-loaded", "running");
  let pluginLoaded = false;
  try {
    if (!dashboardData) {
      throw new Error("no dashboard data");
    }
    const snap = JSON.parse(dashboardData) as Record<string, unknown>;
    const skills = snap["skills"] as Array<Record<string, unknown>> | undefined;
    // If the skills registry has any bundled entries, the plugin loaded
    if (Array.isArray(skills) && skills.some((s) => s["author"] === "bundled")) {
      pluginLoaded = true;
    }
    // Also check the feed for gateway-config audit entry
    const feed = snap["feed"] as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(feed) && feed.some((e) => e["skill"] === "gateway-config")) {
      pluginLoaded = true;
    }
  } catch {
    // Parse failure — try once more
  }

  if (!pluginLoaded) {
    // Retry once after a short wait — plugin may still be loading
    await new Promise((r) => setTimeout(r, 2000));
    const retry = await _httpGet(dashboardUrl);
    if (retry) {
      try {
        const snap = JSON.parse(retry) as Record<string, unknown>;
        const skills = snap["skills"] as Array<Record<string, unknown>> | undefined;
        const feed = snap["feed"] as Array<Record<string, unknown>> | undefined;
        if (
          (Array.isArray(skills) && skills.some((s) => s["author"] === "bundled")) ||
          (Array.isArray(feed) && feed.some((e) => e["skill"] === "gateway-config"))
        ) {
          pluginLoaded = true;
        }
      } catch {
        /* ignore */
      }
    }
  }

  if (pluginLoaded) {
    mark("plugin-loaded", "done");
  } else {
    mark(
      "plugin-loaded",
      "warn",
      "ArmorClaw security layer may not be loaded. Please restart the app if issues persist.",
    );
  }

  // ── 6. Check messaging channels ─────────────────────────────────────────

  mark("channel-check", "running");
  const channelState = getState();
  const hasChannel = channelState.connectedChannels.length > 0;

  if (hasChannel) {
    mark("channel-check", "done");
  } else {
    mark(
      "channel-check",
      "warn",
      "No messaging channel connected — you can set this up later in Settings",
    );
  }

  // ── Result ──────────────────────────────────────────────────────────────

  const hasError = steps.some((s) => s.status === "error");
  return {
    ok: !hasError,
    steps,
    message: hasError ? "Setup could not complete. See the checklist for details." : undefined,
  };
}

// ── Express app ───────────────────────────────────────────────────────────────

export function createApp(): express.Application {
  const app = express();
  app.use(express.json());

  // ── Static ────────────────────────────────────────────────────────────────

  app.get("/", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(readFileSync(WIZARD_HTML, "utf8"));
  });

  // ── State ────────────────────────────────────────────────────────────────

  app.get("/api/state", (_req, res) => {
    res.json(getState());
  });

  // ── Server-Sent Events ────────────────────────────────────────────────────

  app.get("/api/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    // Send current state immediately
    res.write(`data: ${JSON.stringify(getState())}\n\n`);

    const unsub = onStateChange((state) => {
      res.write(`data: ${JSON.stringify(state)}\n\n`);
    });

    // Keepalive ping every 15s
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000);

    req.on("close", () => {
      clearInterval(ping);
      unsub();
    });
  });

  // ── Step 1 — Model provider ──────────────────────────────────────────────

  app.post("/api/step/1/validate", async (req, res) => {
    const { provider, apiKey, ollamaUrl, ollamaFallbackUrl } = req.body as {
      provider?: string;
      apiKey?: string;
      ollamaUrl?: string;
      ollamaFallbackUrl?: string;
    };

    // 1. Format validation (pure, no network)
    const check = validateStep1({ provider: provider as never, apiKey, ollamaUrl });
    if (!check.ok) {
      res.status(422).json(check);
      return;
    }

    // 2. Live key test — structured result, never throws
    let testResult: KeyTestResult = {};
    if (provider === "anthropic" && apiKey) {
      testResult = await testAnthropicKey(apiKey);
    } else if (provider === "openai" && apiKey) {
      testResult = await testOpenAIKey(apiKey);
    } else if (provider === "ollama" && ollamaUrl) {
      testResult = await testOllamaUrl(ollamaUrl);
    }

    // Definite auth failure — block and show specific error
    if (testResult.blocking) {
      res.status(422).json({ ok: false, field: "apiKey", message: testResult.message });
      return;
    }

    // 3. Write key to .env (trimmed)
    if (provider === "anthropic" && apiKey) {
      setEnvVar("ANTHROPIC_API_KEY", apiKey.trim());
    }
    if (provider === "openai" && apiKey) {
      setEnvVar("OPENAI_API_KEY", apiKey.trim());
    }
    if (provider === "ollama" && ollamaUrl) {
      setEnvVar("OLLAMA_BASE_URL", ollamaUrl.trim());
    }
    if (provider) {
      setEnvVar("ARMORCLAW_MODEL_PROVIDER", provider);
    }
    // Save Ollama fallback URL if the user configured it alongside a cloud provider
    if (ollamaFallbackUrl && provider !== "ollama") {
      const url = ollamaFallbackUrl.trim() || "http://localhost:11434";
      setEnvVar("OLLAMA_BASE_URL", url);
    }

    updateState({ modelProvider: provider as never, apiKeyMasked: true });

    // Soft warning: key saved, but don't auto-advance — let the user click once more
    if (testResult.warning) {
      res.json({ ok: true, warning: testResult.warning });
      return;
    }

    // All clear — advance
    advanceStep();
    notifyListeners();
    res.json({ ok: true });
  });

  // Called when the user clicks "Continue anyway" after a soft warning
  app.post("/api/step/1/advance", (_req, res) => {
    const state = getState();
    if (!state.modelProvider) {
      res.status(422).json({ ok: false, message: "No model provider has been saved yet." });
      return;
    }
    advanceStep();
    notifyListeners();
    res.json({ ok: true });
  });

  // ── Step 2 — Sandbox directory ───────────────────────────────────────────

  app.post("/api/step/2/validate", (req, res) => {
    const { sandboxDir } = req.body as { sandboxDir?: string };
    const check = validateStep2({ sandboxDir });
    if (!check.ok) {
      res.status(422).json(check);
      return;
    }
    if (sandboxDir) {
      setEnvVar("ARMORCLAW_SANDBOX_DIR", sandboxDir);
    }
    updateState({ sandboxDir });
    advanceStep();
    notifyListeners();
    res.json({ ok: true });
  });

  app.get("/api/step/2/default-dir", (_req, res) => {
    res.json({ dir: join(homedir(), "Documents", "ArmorClaw") });
  });

  /** Skip Step 2 — sandbox can be configured later from Settings. */
  app.post("/api/step/2/skip", (_req, res) => {
    advanceStep();
    notifyListeners();
    res.json({ ok: true });
  });

  // ── Step 3 — Email / calendar OAuth ─────────────────────────────────────

  /**
   * Save OAuth client credentials for a provider and return the auth URL.
   * The user enters their Client ID + Secret from Google Cloud / Azure portal.
   * Credentials are written to .env using the GOOGLE_OAUTH_ / MICROSOFT_OAUTH_
   * prefixed variable names.
   */
  app.post("/api/step/3/credentials", (req, res) => {
    const { provider, clientId, clientSecret } = req.body as {
      provider?: string;
      clientId?: string;
      clientSecret?: string;
    };

    if (provider !== "gmail" && provider !== "outlook") {
      res.status(400).json({ ok: false, message: "Unknown provider." });
      return;
    }

    const id = (clientId ?? "").trim();
    const secret = (clientSecret ?? "").trim();

    if (!id) {
      res
        .status(422)
        .json({ ok: false, field: "clientId", message: "Please enter the Client ID." });
      return;
    }
    if (!secret) {
      res
        .status(422)
        .json({ ok: false, field: "clientSecret", message: "Please enter the Client Secret." });
      return;
    }

    // Persist to .env
    if (provider === "gmail") {
      setEnvVar("GOOGLE_OAUTH_CLIENT_ID", id);
      setEnvVar("GOOGLE_OAUTH_CLIENT_SECRET", secret);
    } else {
      setEnvVar("MICROSOFT_OAUTH_CLIENT_ID", id);
      setEnvVar("MICROSOFT_OAUTH_CLIENT_SECRET", secret);
    }

    // Construct the OAuth authorisation URL.
    // Redirect URIs use the dedicated callback server port (not the wizard UI port)
    // so they remain stable regardless of which port the wizard UI binds to.
    const cbPort = callbackPort ?? 7392;
    const redirectUri =
      provider === "gmail"
        ? `http://localhost:${cbPort}/auth/google/callback`
        : `http://localhost:${cbPort}/auth/microsoft/callback`;

    let authUrl: string;

    if (provider === "gmail") {
      const params = new URLSearchParams({
        client_id: id,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: GOOGLE_SCOPES,
        access_type: "offline",
        prompt: "consent",
      });
      authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
    } else {
      const params = new URLSearchParams({
        client_id: id,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: MICROSOFT_SCOPES,
      });
      authUrl = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params}`;
    }

    process.stderr.write(
      `[oauth] provider=${provider} callbackPort=${cbPort} redirectUri=${redirectUri}\n`,
    );
    process.stderr.write(`[oauth] authUrl=${authUrl.slice(0, 120)}...\n`);

    res.json({ ok: true, authUrl });
  });

  /**
   * Health check: is the OAuth callback server actually listening?
   * The wizard UI calls this before starting the OAuth flow.
   */
  app.get("/api/step/3/callback-health", async (_req, res) => {
    const cbPort = callbackPort;
    if (!cbPort) {
      res.json({
        ok: false,
        message: "Callback server port not set (server may not have started).",
      });
      return;
    }
    try {
      const probe = await fetch(
        `http://localhost:${cbPort}/auth/google/callback?error=health_check`,
        {
          signal: AbortSignal.timeout(3000),
        },
      );
      res.json({ ok: probe.ok, port: cbPort, status: probe.status });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.json({ ok: false, port: cbPort, message: `Callback server not reachable: ${msg}` });
    }
  });

  /**
   * Returns the OAuth callback port and the redirect URIs the user should
   * register in Google Cloud Console / Azure Portal.
   */
  app.get("/api/step/3/callback-info", (_req, res) => {
    const cbPort = callbackPort ?? 7392;
    res.json({
      callbackPort: cbPort,
      google: `http://localhost:${cbPort}/auth/google/callback`,
      microsoft: `http://localhost:${cbPort}/auth/microsoft/callback`,
    });
  });

  /** Skip Step 3 entirely — email can be connected later from Settings. */
  app.post("/api/step/3/skip", (_req, res) => {
    advanceStep();
    notifyListeners();
    res.json({ ok: true });
  });

  app.post("/api/step/3/advance", (_req, res) => {
    // At least one provider must be connected, OR the user skipped (handled by /skip).
    const state = getState();
    if (!state.gmailConnected && !state.outlookConnected) {
      res.status(422).json({
        ok: false,
        message: "Connect at least one email provider to continue, or click 'Skip for now'.",
      });
      return;
    }
    advanceStep();
    notifyListeners();
    res.json({ ok: true });
  });

  // ── Step 4 — Tailscale ────────────────────────────────────────────────────

  app.get("/api/step/4/detect", async (_req, res) => {
    const result = await detectTailscale();
    if (result.authenticated) {
      const serveResult = await serveTailscale(DASHBOARD_PORT);
      updateState({
        tailscaleStatus: "detected",
        tailscaleUrl: serveResult.url ?? result.tsNetUrl,
      });
      notifyListeners();
      res.json({ ok: true, status: "detected", url: serveResult.url ?? result.tsNetUrl });
    } else {
      res.json({ ok: true, status: result.installed ? "installed-not-auth" : "not-installed" });
    }
  });

  app.post("/api/step/4/install", (_req, res) => {
    updateState({ tailscaleStatus: "installing" });
    notifyListeners();
    startTailscalePoll();
    res.json({ ok: true, downloadUrl: tailscaleDownloadUrl() });
  });

  app.post("/api/step/4/defer", (_req, res) => {
    updateState({ tailscaleStatus: "deferred", tailscaleDeferred: true });
    advanceStep();
    notifyListeners();
    res.json({ ok: true });
  });

  app.post("/api/step/4/advance", (_req, res) => {
    const state = getState();
    const check = validateStep4({ status: state.tailscaleStatus });
    if (!check.ok) {
      res.status(422).json(check);
      return;
    }
    advanceStep();
    notifyListeners();
    res.json({ ok: true });
  });

  // ── Step 5 — Mobile channel setup ────────────────────────────────────────

  // Save Telegram bot token and mark channel as connected
  app.post("/api/step/5/telegram", async (req, res) => {
    const { token } = req.body as { token?: string };
    const t = (token ?? "").trim();
    // Telegram bot tokens look like: 1234567890:AAHxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
    if (!t || !/^\d+:[A-Za-z0-9_-]{35,}$/.test(t)) {
      res.status(422).json({
        ok: false,
        field: "token",
        message:
          "That doesn't look like a valid Telegram bot token. It should look like 7123456789:AAHxxxxxx.",
      });
      return;
    }

    // Delegate to OpenClaw's native channel management instead of
    // writing to .env and hoping the gateway picks it up.
    const actualRoot = process.env["ARMORCLAW_REPO_ROOT"] ?? REPO_ROOT;
    const actualMjs = join(actualRoot, "openclaw.mjs");
    const nodeBin = resolveNodePath();
    try {
      _execCommand(
        `"${nodeBin}" "${actualMjs}" channels add --channel telegram --token ${t} --use-env`,
      );
      process.stderr.write(`[wizard] Telegram channel added via openclaw channels add\n`);
    } catch (err) {
      process.stderr.write(
        `[wizard] openclaw channels add failed, falling back to .env: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }

    // Also write to .env as a fallback — the gateway auto-detects TELEGRAM_BOT_TOKEN
    setEnvVar("TELEGRAM_BOT_TOKEN", t);
    registerMobilePing("telegram");
    notifyListeners();
    res.json({ ok: true });
  });

  // Mobile device registers a successful ping via this endpoint
  app.post("/api/step/5/ping", (req, res) => {
    const { channel } = req.body as { channel?: string };
    if (channel === "telegram" || channel === "whatsapp") {
      registerMobilePing(channel);
    }
    res.json({ ok: true });
  });

  app.post("/api/step/5/advance", (_req, res) => {
    const state = getState();
    const check = validateStep5({
      connectedChannels: state.connectedChannels,
      tailscaleDeferred: state.tailscaleDeferred || state.tailscaleStatus === "deferred",
    });
    if (!check.ok) {
      res.status(422).json(check);
      return;
    }
    advanceStep();
    notifyListeners();
    res.json({ ok: true });
  });

  /** Skip Step 5 — mobile channels can be configured later from Settings. */
  app.post("/api/step/5/skip", (_req, res) => {
    advanceStep();
    notifyListeners();
    res.json({ ok: true });
  });

  // ── Step 6 — Review and launch ────────────────────────────────────────────

  // SSE endpoint for launch progress — wizard subscribes before calling /launch
  app.get("/api/step/6/progress", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const unsub = onLaunchProgress((steps) => {
      try {
        res.write(`data: ${JSON.stringify(steps)}\n\n`);
      } catch {
        /* disconnected */
      }
    });
    req.on("close", unsub);
  });

  app.post("/api/step/6/launch", async (_req, res) => {
    try {
      const result = await launchGateway();
      if (!result.ok) {
        res.status(500).json({ ok: false, message: result.message, steps: result.steps });
        return;
      }
      const state = getState();
      updateState({ completedSteps: [...state.completedSteps, 6] });
      notifyListeners();
      res.json({
        ok: true,
        dashboardUrl: `http://localhost:${DASHBOARD_PORT}`,
        steps: result.steps,
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        message: String(err instanceof Error ? err.message : err),
      });
    }
  });

  // ── Navigation helpers ────────────────────────────────────────────────────

  app.post("/api/back", (_req, res) => {
    goBack();
    notifyListeners();
    res.json({ ok: true, currentStep: getState().currentStep });
  });

  return app;
}

// ── OAuth callback app ────────────────────────────────────────────────────────

/**
 * Tiny Express app that handles only the two OAuth callback routes.
 * Runs on a dedicated port (default 7392) separate from the wizard UI so that
 * the redirect URIs registered in Google Cloud Console / Azure stay stable
 * even when the wizard UI port changes.
 */
function createCallbackApp(): express.Application {
  const cbApp = express();

  cbApp.get("/auth/google/callback", (req, res) => {
    const { code, error } = req.query as { code?: string; error?: string };
    process.stderr.write(
      `[oauth] /auth/google/callback hit — code=${code ? "present(" + String(code).length + " chars)" : "MISSING"} error=${error ?? "none"}\n`,
    );
    void handleOAuthCallback("gmail", code, error, res);
  });

  cbApp.get("/auth/microsoft/callback", (req, res) => {
    const { code, error } = req.query as { code?: string; error?: string };
    process.stderr.write(
      `[oauth] /auth/microsoft/callback hit — code=${code ? "present(" + String(code).length + " chars)" : "MISSING"} error=${error ?? "none"}\n`,
    );
    void handleOAuthCallback("outlook", code, error, res);
  });

  return cbApp;
}

// ── Server factory ────────────────────────────────────────────────────────────

export interface StartedServer {
  /** Port the wizard UI is listening on. */
  port: number;
  /** Port the OAuth callback server is listening on. */
  callbackPort: number;
  close: () => Promise<void>;
}

/**
 * Bind a single HTTP server to localhost, retrying sequential ports on conflict.
 * Falls back to port 0 (OS-assigned) after `maxRetries` attempts.
 */
function bindServer(
  app: express.Application,
  preferredPort: number,
  maxRetries: number,
): Promise<{ port: number; close: () => Promise<void> }> {
  function tryListen(
    port: number,
    retriesLeft: number,
  ): Promise<{ port: number; close: () => Promise<void> }> {
    const server = createServer(app);
    return new Promise((resolve, reject) => {
      server.listen(port, "127.0.0.1", () => {
        const addr = server.address();
        const boundPort = typeof addr === "object" && addr ? addr.port : port;
        resolve({
          port: boundPort,
          close: () => new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res()))),
        });
      });
      server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          server.close();
          if (retriesLeft > 0) {
            tryListen(port + 1, retriesLeft - 1).then(resolve, reject);
          } else {
            tryListen(0, -1).then(resolve, reject);
          }
        } else {
          reject(err);
        }
      });
    });
  }

  return tryListen(preferredPort, maxRetries);
}

/**
 * Start both the wizard UI server and the OAuth callback server.
 *
 * The wizard UI uses `preferredPort` (default 7391) with generous fallback.
 * The OAuth callback server uses port 7392 with limited fallback (5 retries)
 * since redirect URIs must be pre-registered with providers.
 *
 * The callback server is started first so that `callbackPort` is known before
 * any wizard route handler runs.
 */
export async function startServer(preferredPort = 7391, maxRetries = 10): Promise<StartedServer> {
  // 1. Start the OAuth callback server first (port 7392, limited fallback)
  const cbApp = createCallbackApp();
  const cbServer = await bindServer(cbApp, 7392, 5);
  callbackPort = cbServer.port;
  process.stderr.write(`[oauth] Callback server listening on port ${callbackPort}\n`);

  // 2. Start the wizard UI server (dynamic port)
  const wizardApp = createApp();
  const uiServer = await bindServer(wizardApp, preferredPort, maxRetries);
  activePort = uiServer.port;
  process.stderr.write(`[wizard] UI server listening on port ${activePort}\n`);

  return {
    port: uiServer.port,
    callbackPort: cbServer.port,
    close: async () => {
      await cbServer.close();
      await uiServer.close();
    },
  };
}
