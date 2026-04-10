/**
 * Auto-update service for the ArmorClaw launcher.
 *
 * Uses electron-updater to check for, download, and install updates
 * from GitHub Releases. All checks are silent — errors are swallowed
 * so a failed network request never surfaces to the user.
 *
 * Update lifecycle:
 *   1. checkForUpdates() on app ready (silent)
 *   2. "update-available"  → notify tray, begin download
 *   3. "update-downloaded" → notify tray + native notification,
 *                            enable "Restart and update" menu item
 *   4. User clicks "Restart and update" → quitAndInstall()
 */

import { Notification } from "electron";
import pkg from "electron-updater";
const { autoUpdater } = pkg;

// ── Update state ───────────────────────────────────────────────────────────────

export type UpdateStatus = "idle" | "checking" | "available" | "downloading" | "ready";

let _status: UpdateStatus = "idle";
let _version: string | null = null;

const _listeners = new Set<() => void>();

export function getUpdateStatus(): UpdateStatus {
  return _status;
}

export function getUpdateVersion(): string | null {
  return _version;
}

/** Subscribe to update state changes. Returns an unsubscribe function. */
export function onUpdateChange(fn: () => void): () => void {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

function setStatus(status: UpdateStatus): void {
  _status = status;
  for (const fn of _listeners) {
    try {
      fn();
    } catch {
      // Never let a listener crash the updater
    }
  }
}

// ── Updater configuration ──────────────────────────────────────────────────────

/**
 * Initialize the auto-updater. Call once from app.on("ready").
 *
 * - autoDownload: true — download starts immediately when an update is found
 * - autoInstallOnAppQuit: false — we control restart via quitAndInstall()
 * - No dialogs — all feedback is through the tray menu and notifications
 */
export function initAutoUpdater(): void {
  // User-controlled updates: don't auto-download. The tray shows
  // "Update available" and the user clicks to install.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  // Suppress default electron-updater error dialogs
  autoUpdater.logger = null;

  autoUpdater.on("checking-for-update", () => {
    setStatus("checking");
  });

  autoUpdater.on("update-available", (info) => {
    _version = info.version;
    setStatus("available");
  });

  autoUpdater.on("update-not-available", () => {
    setStatus("idle");
  });

  autoUpdater.on("download-progress", () => {
    setStatus("downloading");
  });

  autoUpdater.on("update-downloaded", (info) => {
    _version = info.version;
    setStatus("ready");

    if (Notification.isSupported()) {
      const n = new Notification({
        title: "ArmorClaw update ready",
        body: `Version ${info.version} has been downloaded. Restart to install.`,
      });
      n.on("click", () => restartAndUpdate());
      n.show();
    }
  });

  autoUpdater.on("error", () => {
    // Silently reset — never surface network or signing errors to the user
    // for a background update check.
    setStatus("idle");
  });
}

// ── Public API ─────────────────────────────────────────────────────────────────

/** Silently check for updates. Safe to call at any time. */
export function checkForUpdates(): void {
  autoUpdater.checkForUpdates().catch(() => {
    // Swallow — network errors, missing publish config, etc.
    setStatus("idle");
  });
}

/** Quit the app and install the downloaded update. */
export function restartAndUpdate(): void {
  autoUpdater.quitAndInstall();
}
