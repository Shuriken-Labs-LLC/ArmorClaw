/**
 * ArmorClaw dashboard window — Electron BrowserWindow.
 *
 * The dashboard is served as an Express app on localhost. This module
 * wraps it in an Electron BrowserWindow.
 *
 * The OpenClaw canvas BrowserView has been removed. The Advanced tab uses
 * the fallback tools (gateway health, command runner, config viewer) directly.
 */

import { BrowserWindow, ipcMain, screen } from "electron";
import { DASHBOARD_PORT } from "../dashboard/server.js";

let dashboardWindow: BrowserWindow | null = null;

// ── Dashboard window lifecycle ───────────────────────────────────────────────

export function openDashboardWindow(): void {
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.show();
    dashboardWindow.focus();
    return;
  }

  const display = screen.getPrimaryDisplay();
  const width = Math.min(1200, display.workArea.width - 100);
  const height = Math.min(800, display.workArea.height - 100);

  dashboardWindow = new BrowserWindow({
    width,
    height,
    minWidth: 390,
    minHeight: 500,
    title: "ArmorClaw Dashboard",
    backgroundColor: "#0D0F14",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: undefined,
    },
  });

  void dashboardWindow.loadURL(`http://127.0.0.1:${DASHBOARD_PORT}`);

  dashboardWindow.on("closed", () => {
    dashboardWindow = null;
  });
}

export function getDashboardWindow(): BrowserWindow | null {
  return dashboardWindow && !dashboardWindow.isDestroyed() ? dashboardWindow : null;
}

// ── IPC setup ───────────────────────────────────────────────────────────────

/** Register IPC handlers — call once at app startup. */
export function registerDashboardIPC(): void {
  // No BrowserView IPC — Advanced view uses fallback tools directly.
  // Handler registered here to keep the call site in main.ts unchanged.
  ipcMain.removeAllListeners("advanced-tab-visible");
}
