/**
 * ArmorClaw Launcher — Electron main process.
 *
 * Lives in the system tray. No visible window. Manages the gateway
 * process lifecycle and provides quick access to the dashboard.
 *
 * First launch: detects missing config, starts the onboarding wizard
 * server in-process and opens it in the default browser.
 * Subsequent launches: connects to the already-running gateway.
 * Login: auto-starts via platform-native login item settings.
 *
 * Both the onboarding wizard and the dashboard are Express servers
 * running in-process — never spawned as external node subprocesses.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { app, dialog, Notification, shell } from "electron";
import { checkForUpdates, initAutoUpdater } from "./auto-updater.js";
import { openDashboardWindow, registerDashboardIPC } from "./dashboard-window.js";
import { findNodePath, GatewayManager, getRepoRoot } from "./gateway-manager.js";
import { createTray } from "./tray.js";

// ── Single instance lock ──────────────────────────────────────────────────────

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

// ── First-launch detection ────────────────────────────────────────────────────

const INSTALL_PATH_FILE = join(
  process.platform === "win32"
    ? join(process.env["APPDATA"] ?? homedir(), "ArmorClaw")
    : join(homedir(), ".armorclaw"),
  "install-path.txt",
);
const OPENCLAW_CONFIG = join(homedir(), ".openclaw", "openclaw.json");
const PREFERRED_WIZARD_PORT = 7391;

function isFirstLaunch(): boolean {
  return !existsSync(INSTALL_PATH_FILE) || !existsSync(OPENCLAW_CONFIG);
}

// ── Shared env setup ──────────────────────────────────────────────────────────

/**
 * Set env vars that the onboarding server and dashboard need:
 * - ARMORCLAW_REPO_ROOT: where openclaw.mjs and wrapper/ live
 * - ARMORCLAW_NODE_PATH: resolved path to the node binary
 *
 * Called once before any server is imported.
 */
function setSharedEnvVars(): void {
  process.env["ARMORCLAW_REPO_ROOT"] = getRepoRoot();
  try {
    process.env["ARMORCLAW_NODE_PATH"] = findNodePath();
  } catch {
    // Node not found — Step 6 gateway launch will fail gracefully
  }

  // Load all vars from the .env file into process.env so child processes
  // (especially the gateway) inherit API keys, tokens, etc.
  // The .env file is at <repo-root>/.env.
  try {
    const nodeFs = require("node:fs") as typeof import("node:fs");
    const nodePath = require("node:path") as typeof import("node:path");
    const envPath = nodePath.join(getRepoRoot(), ".env");
    const raw = nodeFs.readFileSync(envPath, "utf-8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      const eq = trimmed.indexOf("=");
      if (eq === -1) {
        continue;
      }
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
      if (key && !process.env[key]) {
        // Don't overwrite existing env vars (system env takes precedence)
        process.env[key] = val;
      }
    }
  } catch {
    // .env may not exist on first launch — that's fine
  }

  // Clear any stale gateway token loaded from .env — the gateway owns its
  // token and writes it to openclaw.json on startup. The /api/chat/gateway-config
  // fallback path reads openclaw.json directly for the authoritative value.
  delete process.env["ARMORCLAW_GATEWAY_TOKEN"];
}

// ── Dashboard server lifecycle ──────────────────────────────────────────────

/** Tracks the in-process dashboard server. */
let dashboardServer: { port: number; close: () => Promise<void> } | null = null;

/**
 * Start the ArmorClaw dashboard server in-process.
 * The dashboard Express app, its routes, and index.html are all compiled
 * into the app bundle.
 */
async function ensureDashboardRunning(): Promise<void> {
  if (dashboardServer) {
    return;
  }

  try {
    const mod = await import("../dashboard/server.js");
    dashboardServer = await mod.startServer(mod.DASHBOARD_PORT);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    dialog.showErrorBox(
      "Dashboard couldn't start",
      `ArmorClaw's dashboard failed to start.\n\n${detail}`,
    );
  }
}

// ── Wizard server lifecycle ─────────────────────────────────────────────────

/** Tracks the in-process wizard server so we don't start it twice. */
let wizardServer: { port: number; close: () => Promise<void> } | null = null;

/**
 * Start the onboarding wizard server in-process (via dynamic import of
 * the compiled onboarding module) and open it in the default browser.
 *
 * The wizard server, its Express routes, and wizard.html are all compiled
 * into the app bundle — no external source repo or Node binary required.
 */
async function startWizardAndOpen(): Promise<void> {
  if (wizardServer) {
    void shell.openExternal(`http://localhost:${wizardServer.port}`);
    return;
  }

  if (Notification.isSupported()) {
    new Notification({
      title: "ArmorClaw",
      body: "Starting setup wizard...",
    }).show();
  }

  try {
    const { startServer } = await import("../onboarding/server.js");
    wizardServer = await startServer(PREFERRED_WIZARD_PORT);
    void shell.openExternal(`http://localhost:${wizardServer.port}`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    dialog.showErrorBox(
      "Setup couldn't start",
      "ArmorClaw's setup wizard failed to start.\n\n" +
        `${detail}\n\n` +
        "Try restarting ArmorClaw. If the problem continues, reinstall the app.",
    );
  }
}

// ── Exported for tray menu ────────────────────────────────────────────────────

/** Open the dashboard in an Electron window. Exported for tray menu. */
export { openDashboardWindow } from "./dashboard-window.js";

/** Open the wizard — callable from the tray "Open setup wizard" menu item. */
export async function openWizard(): Promise<void> {
  try {
    await startWizardAndOpen();
  } catch {
    const port = wizardServer?.port ?? PREFERRED_WIZARD_PORT;
    void shell.openExternal(`http://localhost:${port}`);
  }
}

// ── Gateway token sync ────────────────────────────────────────────────────────

/**
 * Persist the gateway auth token to ~/armorclaw/.env as ARMORCLAW_GATEWAY_TOKEN.
 *
 * The gateway owns its token — it generates one on startup and writes it to
 * ~/.openclaw/openclaw.json. The GatewayManager reads it back after confirming
 * the gateway is reachable and sets process.env. This function persists that
 * value to .env so other processes (e.g. the onboarding server) can read it.
 *
 * Deduplicates: skips the disk write when the token hasn't changed since the
 * last successful sync (prevents env-writer spam on every health poll).
 */
let _lastSyncedToken = "";

function syncGatewayToken(): void {
  try {
    const token = process.env["ARMORCLAW_GATEWAY_TOKEN"] ?? "";
    if (!token || token === _lastSyncedToken) {
      return;
    }
    _lastSyncedToken = token;
    import("../onboarding/env-writer.js")
      .then((mod) => {
        mod.setEnvVar("ARMORCLAW_GATEWAY_TOKEN", token);
      })
      .catch(() => {});
  } catch {
    // Non-fatal
  }
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

// Hide dock icon on macOS — this is a tray-only app.
if (process.platform === "darwin") {
  app.dock?.hide();
}

app.on("ready", async () => {
  configureLoginItem();
  initAutoUpdater();
  checkForUpdates();
  setSharedEnvVars();
  registerDashboardIPC();

  // Create the memory file if it doesn't exist
  try {
    const { ensureMemoryFile } = await import("../config/system-prompt.js");
    ensureMemoryFile();
  } catch {
    // Non-fatal
  }

  // Initialize model adapter (probes Ollama if configured)
  try {
    const { initModelAdapter } = await import("../lib/model-adapter.js");
    await initModelAdapter();
  } catch {
    // Non-fatal — adapter functions still work, just without initial probe
  }

  // Start the dashboard server in-process — needed for both the tray
  // "Open Dashboard" link and the Step 6 health check in launchGateway().
  await ensureDashboardRunning();

  const manager = new GatewayManager();

  if (manager.nodeNotFoundError) {
    dialog.showErrorBox("Node.js not found", manager.nodeNotFoundError);
  }

  const trayHandle = createTray(manager);

  if (isFirstLaunch()) {
    // First launch → start wizard, gateway starts when Step 6 completes
    await startWizardAndOpen();
  }

  // Start the gateway (returning user: immediately; first launch: polls
  // until the wizard's launchGateway() starts it). This is non-blocking —
  // it spawns the process and polls in the background.
  await manager.start();

  // After the gateway is confirmed running, read its token from
  // openclaw.json and sync to .env so the chat window can authenticate.
  syncGatewayToken();

  manager.on("state-change", () => {
    trayHandle.update(manager.status);
    // Re-sync token on state changes (gateway may have restarted with
    // a new token)
    if (manager.status.state === "running") {
      syncGatewayToken();
    }
  });
});

app.on("window-all-closed", () => {
  // Prevent quit — this is a tray-only app with no windows
});

// ── Login item ────────────────────────────────────────────────────────────────

function configureLoginItem(): void {
  // Default to enabled unless explicitly disabled
  const disabled = process.env["ARMORCLAW_LAUNCH_ON_STARTUP"] === "false";
  try {
    app.setLoginItemSettings({
      openAtLogin: !disabled,
      name: "ArmorClaw",
    });
  } catch {
    // Silently fail — login item is a convenience, not a requirement
  }
}

/** Get current login item state. Used by the dashboard settings API. */
export function getLoginItemEnabled(): boolean {
  try {
    return app.getLoginItemSettings().openAtLogin;
  } catch {
    return false;
  }
}

/** Toggle login item. Used by the dashboard settings API. */
export function setLoginItemEnabled(enabled: boolean): void {
  try {
    app.setLoginItemSettings({ openAtLogin: enabled, name: "ArmorClaw" });
  } catch {
    // Silently fail
  }
}
