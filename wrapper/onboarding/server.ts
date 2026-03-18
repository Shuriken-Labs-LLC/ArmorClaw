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
import { generateAuthToken } from "../config/gateway.ts";
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
import {
  validateStep1,
  validateStep2,
  validateStep4,
  validateStep5,
  validateStep6,
} from "./validators.ts";

const WIZARD_HTML = join(import.meta.dirname, "public", "wizard.html");

/** Dashboard port — will be served via Tailscale serve in Step 5. */
export const DASHBOARD_PORT = 7390;

/** Set by startServer() so route handlers can build the correct callback URL. */
let activePort: number | null = null;

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

type MobileChannel = "telegram" | "whatsapp" | "signal";

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
      updateState({ tailscaleStatus: "deferred" });
    }
    notifyListeners();
  })();
}

// ── OAuth callback handler ────────────────────────────────────────────────────

function handleOAuthCallback(
  provider: "gmail" | "outlook",
  code: string | undefined,
  error: string | undefined,
  res: express.Response,
): void {
  if (error || !code) {
    res.send(`<!DOCTYPE html><html><head><title>Connection failed</title></head><body>
      <p style="font-family:sans-serif;padding:24px;color:#A32D2D">
        Connection failed${error ? `: ${error}` : ""}. You can close this tab and try again.
      </p>
      <script>setTimeout(() => window.close(), 4000);</script>
    </body></html>`);
    return;
  }

  // Store the auth code for the email-calendar skill to exchange at runtime
  if (provider === "gmail") {
    setEnvVar("GOOGLE_AUTH_CODE_PENDING", code);
    updateState({ gmailConnected: true });
  } else {
    setEnvVar("MICROSOFT_AUTH_CODE_PENDING", code);
    updateState({ outlookConnected: true });
  }
  notifyListeners();

  res.send(`<!DOCTYPE html><html><head><title>Connected</title></head><body>
    <p style="font-family:sans-serif;padding:24px;color:#1D9E75;font-size:18px">
      ✓ Connected successfully. You can close this tab.
    </p>
    <script>window.close();</script>
  </body></html>`);
}

// ── Step 7 — Gateway launch sequence ──────────────────────────────────────────

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const OPENCLAW_MJS = join(REPO_ROOT, "openclaw.mjs");
const WRAPPER_DIR = join(REPO_ROOT, "wrapper");
const OPENCLAW_CONFIG = join(homedir(), ".openclaw", "openclaw.json");
const ARMORCLAW_DIR = join(homedir(), ".armorclaw");

/**
 * Injectable seam for `execSync` — used by tests to capture commands
 * without actually spawning processes.
 */
export let _execCommand: (cmd: string) => void = (cmd) =>
  execSync(cmd, { stdio: "ignore", timeout: 15_000, cwd: REPO_ROOT });

/** Injectable seam for gateway spawn — returns the ChildProcess. */
export let _spawnGateway: () => ReturnType<typeof spawn> = () =>
  spawn("node", [OPENCLAW_MJS, "gateway"], {
    stdio: "ignore",
    detached: true,
    cwd: REPO_ROOT,
  });

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
  const steps: LaunchStep[] = [
    { id: "backup", label: "Backing up existing config", status: "pending" },
    { id: "config", label: "Writing gateway configuration", status: "pending" },
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

  // ── 2. Write gateway + plugin config ────────────────────────────────────

  mark("config", "running");
  const token = generateAuthToken();
  setEnvVar("ARMORCLAW_GATEWAY_MODE", "local");
  setEnvVar("ARMORCLAW_GATEWAY_TOKEN", token);

  const configCommands = [
    `node ${OPENCLAW_MJS} config set gateway.mode local`,
    `node ${OPENCLAW_MJS} config set gateway.auth.token ${token}`,
    `node ${OPENCLAW_MJS} config set plugins.load.paths '["${WRAPPER_DIR}"]'`,
    `node ${OPENCLAW_MJS} config set plugins.allow '["armorclaw"]'`,
    `node ${OPENCLAW_MJS} config set plugins.entries.armorclaw.path '${WRAPPER_DIR}'`,
  ];

  let configErrors = 0;
  for (const cmd of configCommands) {
    try {
      _execCommand(cmd);
    } catch {
      configErrors++;
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

  // ── 3. Start the gateway ────────────────────────────────────────────────

  mark("gateway-start", "running");
  try {
    const child = _spawnGateway();
    child.unref();
    mark("gateway-start", "done");
  } catch (err) {
    mark(
      "gateway-start",
      "error",
      `Could not start the gateway: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {
      ok: false,
      message: "Could not start the gateway. Please try restarting the app.",
      steps,
    };
  }

  // ── 4. Verify gateway is reachable (up to 15s) ─────────────────────────

  mark("gateway-reachable", "running");
  const dashboardUrl = `http://127.0.0.1:${DASHBOARD_PORT}/api/dashboard`;
  let dashboardData: string | null = null;

  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((r) => setTimeout(r, 500));
    dashboardData = await _httpGet(dashboardUrl);
    if (dashboardData) {
      break;
    }
  }

  if (!dashboardData) {
    mark("gateway-reachable", "error", "Gateway did not respond within 15 seconds");
    return {
      ok: false,
      message: "The gateway started but isn't responding yet. Click Retry to try again.",
      steps,
    };
  }
  mark("gateway-reachable", "done");

  // ── 5. Verify ArmorClaw plugin is loaded ────────────────────────────────

  mark("plugin-loaded", "running");
  let pluginLoaded = false;
  try {
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
  const state = getState();
  const hasChannel = state.telegramConnected || state.whatsappConnected || state.signalConnected;

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
    const { provider, apiKey, ollamaUrl } = req.body as {
      provider?: string;
      apiKey?: string;
      ollamaUrl?: string;
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

  // ── Step 3 — Email / calendar OAuth ─────────────────────────────────────

  /**
   * Save OAuth client credentials for a provider and return the auth URL.
   * The user obtained the Client ID + Secret from Google Cloud / Azure portal.
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
      setEnvVar("GOOGLE_CLIENT_ID", id);
      setEnvVar("GOOGLE_CLIENT_SECRET", secret);
    } else {
      setEnvVar("MICROSOFT_CLIENT_ID", id);
      setEnvVar("MICROSOFT_CLIENT_SECRET", secret);
    }

    // Construct the OAuth authorisation URL.
    // Callback paths must match exactly what is registered in the provider console.
    const wizardPort = activePort ?? 7391;
    const redirectUri =
      provider === "gmail"
        ? `http://localhost:${wizardPort}/auth/google/callback`
        : `http://localhost:${wizardPort}/auth/microsoft/callback`;

    let authUrl: string;

    if (provider === "gmail") {
      const params = new URLSearchParams({
        client_id: id,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "https://mail.google.com/ https://www.googleapis.com/auth/calendar",
        access_type: "offline",
        prompt: "consent",
      });
      authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
    } else {
      const params = new URLSearchParams({
        client_id: id,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "offline_access Mail.Read Mail.Send Calendars.ReadWrite",
      });
      authUrl = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params}`;
    }

    // DEBUG — log the exact redirect_uri and full auth URL so mismatches are visible
    console.log(`[oauth] provider      : ${provider}`);
    console.log(`[oauth] redirect_uri  : ${redirectUri}`);
    console.log(`[oauth] full auth URL : ${authUrl}`);

    res.json({ ok: true, authUrl });
  });

  /**
   * Google OAuth callback — registered in Google Cloud Console as:
   *   http://localhost:<port>/auth/google/callback
   */
  app.get("/auth/google/callback", (req, res) => {
    const { code, error } = req.query as { code?: string; error?: string };
    console.log(
      `[oauth] /auth/google/callback — code=${code ? "present" : "missing"} error=${error ?? "none"}`,
    );
    handleOAuthCallback("gmail", code, error, res);
  });

  /**
   * Microsoft OAuth callback — registered in Azure as:
   *   http://localhost:<port>/auth/microsoft/callback
   */
  app.get("/auth/microsoft/callback", (req, res) => {
    const { code, error } = req.query as { code?: string; error?: string };
    console.log(
      `[oauth] /auth/microsoft/callback — code=${code ? "present" : "missing"} error=${error ?? "none"}`,
    );
    handleOAuthCallback("outlook", code, error, res);
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

  // ── Step 4 — CRM ─────────────────────────────────────────────────────────

  app.post("/api/step/4/validate", async (req, res) => {
    const { provider, apiKey } = req.body as { provider?: string; apiKey?: string };
    const check = validateStep4({ provider: provider as never, apiKey });
    if (!check.ok) {
      res.status(422).json(check);
      return;
    }
    if (provider === "hubspot" && apiKey) {
      setEnvVar("HUBSPOT_API_KEY", apiKey);
    }
    if (provider === "airtable" && apiKey) {
      setEnvVar("AIRTABLE_API_KEY", apiKey);
    }
    updateState({ crmProvider: provider as never, crmKeyMasked: !!apiKey });
    advanceStep();
    notifyListeners();
    res.json({ ok: true });
  });

  // ── Step 5 — Tailscale ────────────────────────────────────────────────────

  app.get("/api/step/5/detect", async (_req, res) => {
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

  app.post("/api/step/5/install", (_req, res) => {
    updateState({ tailscaleStatus: "installing" });
    notifyListeners();
    startTailscalePoll();
    res.json({ ok: true, downloadUrl: tailscaleDownloadUrl() });
  });

  app.post("/api/step/5/defer", (_req, res) => {
    updateState({ tailscaleStatus: "deferred", tailscaleDeferred: true });
    advanceStep();
    notifyListeners();
    res.json({ ok: true });
  });

  app.post("/api/step/5/advance", (_req, res) => {
    const state = getState();
    const check = validateStep5({ status: state.tailscaleStatus });
    if (!check.ok) {
      res.status(422).json(check);
      return;
    }
    advanceStep();
    notifyListeners();
    res.json({ ok: true });
  });

  // ── Step 6 — Mobile channel setup ────────────────────────────────────────

  // Save Telegram bot token and mark channel as connected
  app.post("/api/step/6/telegram", async (req, res) => {
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
    setEnvVar("TELEGRAM_BOT_TOKEN", t);
    registerMobilePing("telegram");
    notifyListeners();
    res.json({ ok: true });
  });

  // Mobile device registers a successful ping via this endpoint
  app.post("/api/step/6/ping", (req, res) => {
    const { channel } = req.body as { channel?: string };
    if (channel === "telegram" || channel === "whatsapp" || channel === "signal") {
      registerMobilePing(channel);
    }
    res.json({ ok: true });
  });

  app.post("/api/step/6/advance", (_req, res) => {
    const state = getState();
    const check = validateStep6({
      connectedChannels: state.connectedChannels,
      tailscaleDeferred: state.tailscaleDeferred,
    });
    if (!check.ok) {
      res.status(422).json(check);
      return;
    }
    advanceStep();
    notifyListeners();
    res.json({ ok: true });
  });

  // ── Step 7 — Review and launch ────────────────────────────────────────────

  // SSE endpoint for launch progress — wizard subscribes before calling /launch
  app.get("/api/step/7/progress", (req, res) => {
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

  app.post("/api/step/7/launch", async (_req, res) => {
    try {
      const result = await launchGateway();
      if (!result.ok) {
        res.status(500).json({ ok: false, message: result.message, steps: result.steps });
        return;
      }
      const state = getState();
      updateState({ completedSteps: [...state.completedSteps, 7] });
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

// ── Server factory ────────────────────────────────────────────────────────────

export interface StartedServer {
  port: number;
  close: () => Promise<void>;
}

export async function startServer(preferredPort = 7391): Promise<StartedServer> {
  const app = createApp();
  const server = createServer(app);

  return new Promise((resolve, reject) => {
    server.listen(preferredPort, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : preferredPort;
      activePort = port;
      resolve({
        port,
        close: () => new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res()))),
      });
    });
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        // Try next port
        server.close();
        startServer(preferredPort + 1).then(resolve, reject);
      } else {
        reject(err);
      }
    });
  });
}
