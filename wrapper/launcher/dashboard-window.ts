/**
 * ArmorClaw dashboard window — Electron BrowserWindow with BrowserView
 * for the Advanced tab's embedded OpenClaw control panel.
 *
 * The dashboard is served as an Express app on localhost. This module
 * wraps it in an Electron BrowserWindow so we can overlay a BrowserView
 * (the OpenClaw native control panel at http://127.0.0.1:18789) when
 * the Advanced tab is active and the gateway is running.
 *
 * When the dashboard is accessed via Tailscale on mobile, it falls back
 * to the config viewer + command runner (no BrowserView in a browser).
 */

import { BrowserView, BrowserWindow, ipcMain, screen } from "electron";
import { DASHBOARD_PORT } from "../dashboard/server.js";

let dashboardWindow: BrowserWindow | null = null;
let advancedBrowserView: BrowserView | null = null;
let gatewayPollTimer: ReturnType<typeof setInterval> | null = null;

const GATEWAY_URL = "http://127.0.0.1:18789";
const GATEWAY_CANVAS_URL = "http://127.0.0.1:18789/__openclaw__/canvas/";
const GATEWAY_POLL_INTERVAL_MS = 2000;

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
      preload: undefined, // We use a different IPC strategy below
    },
  });

  void dashboardWindow.loadURL(`http://127.0.0.1:${DASHBOARD_PORT}`);

  // Inject __armorclawIPC into the renderer after page load
  dashboardWindow.webContents.on("did-finish-load", () => {
    dashboardWindow?.webContents
      .executeJavaScript(`
      window.__armorclawIPC = {
        advancedTabVisible: function(visible, gatewayOnline) {
          // Use postMessage to communicate with main process via a polling pattern
          // since we don't have preload. We'll use a custom protocol instead.
          window.__advancedTabState = { visible: visible, gatewayOnline: gatewayOnline };
        }
      };
    `)
      .catch(() => {});
  });

  // Poll for advanced tab state changes from the renderer
  const rendererPollTimer = setInterval(async () => {
    if (!dashboardWindow || dashboardWindow.isDestroyed()) {
      clearInterval(rendererPollTimer);
      return;
    }
    try {
      const state = (await dashboardWindow.webContents.executeJavaScript(
        "window.__advancedTabState || null",
      )) as { visible: boolean; gatewayOnline: boolean } | null;
      if (state) {
        handleAdvancedTabChange(state.visible, state.gatewayOnline);
        // Clear the state so we don't re-process it
        await dashboardWindow.webContents.executeJavaScript("window.__advancedTabState = null");
      }
    } catch {
      // Window may be destroyed
    }
  }, 300);

  dashboardWindow.on("resize", () => {
    repositionBrowserView();
  });

  dashboardWindow.on("closed", () => {
    cleanupBrowserView();
    clearInterval(rendererPollTimer);
    dashboardWindow = null;
  });
}

export function getDashboardWindow(): BrowserWindow | null {
  return dashboardWindow && !dashboardWindow.isDestroyed() ? dashboardWindow : null;
}

// ── BrowserView management ──────────────────────────────────────────────────

function handleAdvancedTabChange(visible: boolean, gatewayOnline: boolean): void {
  if (visible && gatewayOnline) {
    showBrowserView();
    startGatewayDisconnectPolling();
  } else {
    hideBrowserView();
    stopGatewayDisconnectPolling();
  }
}

function showBrowserView(): void {
  if (!dashboardWindow || dashboardWindow.isDestroyed()) {
    return;
  }

  if (!advancedBrowserView) {
    advancedBrowserView = new BrowserView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    });
  }

  dashboardWindow.addBrowserView(advancedBrowserView);
  repositionBrowserView();

  // Load the OpenClaw canvas directly. Fall back to gateway root if the
  // canvas path is unreachable (older gateway versions may not serve it).
  const currentUrl = advancedBrowserView.webContents.getURL();
  if (!currentUrl.startsWith(GATEWAY_URL)) {
    advancedBrowserView.webContents.loadURL(GATEWAY_CANVAS_URL).catch(() => {
      // Canvas path unavailable — try gateway root before giving up
      advancedBrowserView?.webContents.loadURL(GATEWAY_URL).catch(() => {
        notifyRendererGatewayDisconnected();
      });
    });
  }
}

function hideBrowserView(): void {
  if (!dashboardWindow || dashboardWindow.isDestroyed()) {
    return;
  }

  if (advancedBrowserView) {
    dashboardWindow.removeBrowserView(advancedBrowserView);
  }
}

function cleanupBrowserView(): void {
  stopGatewayDisconnectPolling();
  if (advancedBrowserView) {
    if (dashboardWindow && !dashboardWindow.isDestroyed()) {
      dashboardWindow.removeBrowserView(advancedBrowserView);
    }
    // BrowserView doesn't have a destroy method in newer Electron, but
    // removing it from the window and dropping the reference is sufficient.
    advancedBrowserView = null;
  }
}

/**
 * Position the BrowserView to fill the main content area of the dashboard.
 *
 * The sidebar is 216px on desktop. The warning banner + page top padding
 * takes roughly 76px. We leave space for both.
 */
function repositionBrowserView(): void {
  if (!advancedBrowserView || !dashboardWindow || dashboardWindow.isDestroyed()) {
    return;
  }

  const [winWidth, winHeight] = dashboardWindow.getContentSize();
  // Sidebar width matches the CSS: 216px on desktop
  const sidebarWidth = 216;
  // Top offset for the warning banner + page top padding
  const topOffset = 76;
  const padding = 16;

  const x = sidebarWidth + padding;
  const y = topOffset;
  const w = Math.max(0, winWidth - sidebarWidth - padding * 2);
  const h = Math.max(0, winHeight - topOffset - padding);

  advancedBrowserView.setBounds({ x, y, width: w, height: h });
  advancedBrowserView.setAutoResize({ width: true, height: true });
}

// ── Gateway disconnect detection ────────────────────────────────────────────

function startGatewayDisconnectPolling(): void {
  stopGatewayDisconnectPolling();
  gatewayPollTimer = setInterval(async () => {
    const reachable = await probeGateway();
    if (!reachable) {
      hideBrowserView();
      notifyRendererGatewayDisconnected();
      stopGatewayDisconnectPolling();
    }
  }, GATEWAY_POLL_INTERVAL_MS);
}

function stopGatewayDisconnectPolling(): void {
  if (gatewayPollTimer) {
    clearInterval(gatewayPollTimer);
    gatewayPollTimer = null;
  }
}

async function probeGateway(): Promise<boolean> {
  // Use the dashboard's TCP-level gateway probe instead of an HTTP GET
  // to the WebSocket server root (which may return non-200 even when up).
  try {
    const res = await fetch(`http://127.0.0.1:${DASHBOARD_PORT}/api/advanced/gateway-probe`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      return false;
    }
    const data = (await res.json()) as { reachable?: boolean };
    return data.reachable === true;
  } catch {
    return false;
  }
}

function notifyRendererGatewayDisconnected(): void {
  if (!dashboardWindow || dashboardWindow.isDestroyed()) {
    return;
  }
  dashboardWindow.webContents
    .executeJavaScript(`
    if (typeof pollAdvancedGatewayStatus === 'function') {
      pollAdvancedGatewayStatus();
    }
  `)
    .catch(() => {});
}

// ── IPC setup ───────────────────────────────────────────────────────────────

/** Register IPC handlers — call once at app startup. */
export function registerDashboardIPC(): void {
  ipcMain.on("advanced-tab-visible", (_event, visible: boolean, gatewayOnline: boolean) => {
    handleAdvancedTabChange(visible, gatewayOnline);
  });
}
