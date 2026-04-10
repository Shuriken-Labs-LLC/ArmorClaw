/**
 * System tray icon and context menu for the ArmorClaw launcher.
 *
 * Icon states:
 *   green  — agent running, ArmorClaw active
 *   amber  — approval waiting (badge count)
 *   red    — agent stopped or error
 *
 * The tray module consumes GatewayManager state changes and
 * updates the icon + menu accordingly.
 */

import { join } from "node:path";
import { app, Menu, nativeImage, Notification, shell, Tray } from "electron";
import { getModelAdapterState, onModelAdapterChange } from "../lib/model-adapter.js";
import {
  checkForUpdates,
  getUpdateStatus,
  getUpdateVersion,
  onUpdateChange,
  restartAndUpdate,
} from "./auto-updater.js";
import type { GatewayManager, GatewayStatus } from "./gateway-manager.js";

// ── Asset paths ───────────────────────────────────────────────────────────────

const ASSETS = join(import.meta.dirname, "..", "assets");

function iconPath(variant: "green" | "amber" | "red"): string {
  return join(ASSETS, `tray-${variant}.png`);
}

// ── Status labels ─────────────────────────────────────────────────────────────

function statusLabel(status: GatewayStatus): string {
  if (status.pendingApprovals > 0) {
    const n = status.pendingApprovals;
    return `${n} approval${n === 1 ? "" : "s"} waiting`;
  }
  switch (status.state) {
    case "running":
      return "ArmorClaw is running";
    case "paused":
      return "Agent paused";
    case "starting":
      return "Starting ArmorClaw...";
    case "error":
      return "Agent error — check dashboard";
    case "stopped":
      return "Agent stopped";
  }
}

function iconVariant(status: GatewayStatus): "green" | "amber" | "red" {
  if (status.pendingApprovals > 0) {
    return "amber";
  }
  if (status.state === "running") {
    return "green";
  }
  if (status.state === "starting") {
    return "green";
  }
  if (status.state === "paused") {
    return "amber";
  }
  return "red";
}

// ── Update menu items ─────────────────────────────────────────────────────────

function buildUpdateMenuItems(): Electron.MenuItemConstructorOptions[] {
  const status = getUpdateStatus();
  const version = getUpdateVersion();

  switch (status) {
    case "ready":
      return [
        {
          label: `Update available — restart to install (v${version})`,
          click: () => restartAndUpdate(),
        },
      ];
    case "downloading":
      return [{ label: "Downloading update...", enabled: false }];
    case "available":
      return [
        {
          label: `Update v${version} available`,
          enabled: false,
        },
        {
          label: "Download and install",
          click: () => {
            void import("electron-updater").then((pkg) => {
              const { autoUpdater: au } = pkg.default ?? pkg;
              au.downloadUpdate().catch(() => {});
            });
          },
        },
      ];
    case "checking":
      return [{ label: "Checking for updates...", enabled: false }];
    default:
      return [{ label: "Check for updates", click: () => checkForUpdates() }];
  }
}

// ── Provider status menu item ─────────────────────────────────────────────────

function buildProviderMenuItems(): Electron.MenuItemConstructorOptions[] {
  const state = getModelAdapterState();
  if (!state.primary) {
    return [];
  }

  const labels: Record<string, string> = {
    anthropic: "Running on Claude",
    openai: "Running on GPT",
    ollama: "Running locally (Ollama)",
  };

  return [{ label: labels[state.primary] ?? `Running on ${state.primary}`, enabled: false }];
}

// ── Tray builder ──────────────────────────────────────────────────────────────

export interface TrayHandle {
  tray: Tray;
  update(status: GatewayStatus): void;
  destroy(): void;
}

/**
 * Create and return the system tray icon with its context menu.
 * Call `handle.update(status)` whenever the gateway state changes.
 */
export function createTray(manager: GatewayManager): TrayHandle {
  const tray = new Tray(nativeImage.createFromPath(iconPath("green")));
  tray.setToolTip("ArmorClaw");

  let currentStatus: GatewayStatus = manager.status;
  let lastNotifiedApprovals = 0;

  function buildMenu(status: GatewayStatus): Menu {
    const isPaused = status.state === "paused";
    const isRunning = status.state === "running" || status.state === "paused";

    return Menu.buildFromTemplate([
      { label: statusLabel(status), enabled: false },
      { type: "separator" },
      {
        label: "Open Dashboard",
        click: () => {
          void import("./dashboard-window.js").then((m) => m.openDashboardWindow());
        },
      },
      {
        label: "Open Dashboard in Browser",
        click: () => shell.openExternal(status.dashboardUrl),
      },
      {
        label: "Open in Telegram",
        click: () => shell.openExternal("tg://resolve?domain=ArmorClawBot"),
      },
      { type: "separator" },
      {
        label: isPaused ? "Resume agent" : "Pause agent",
        enabled: isRunning,
        click: () => {
          if (isPaused) {
            void manager.resume();
          } else {
            void manager.pause();
          }
        },
      },
      {
        label: "Open setup wizard",
        click: () => {
          // Dynamic import to avoid circular dependency at module load time
          void import("./main.js").then((m) => m.openWizard());
        },
      },
      ...buildProviderMenuItems(),
      ...buildUpdateMenuItems(),
      { type: "separator" },
      {
        label: "Quit ArmorClaw",
        click: () => {
          manager.stop();
          app.quit();
        },
      },
    ]);
  }

  function update(status: GatewayStatus): void {
    currentStatus = status;
    const variant = iconVariant(status);
    tray.setImage(nativeImage.createFromPath(iconPath(variant)));
    tray.setToolTip(statusLabel(status));
    tray.setContextMenu(buildMenu(status));

    // macOS badge count for pending approvals
    if (process.platform === "darwin" && app.dock) {
      app.dock.setBadge(status.pendingApprovals > 0 ? String(status.pendingApprovals) : "");
    }

    // Notification for new approvals
    if (status.pendingApprovals > lastNotifiedApprovals && Notification.isSupported()) {
      const n = new Notification({
        title: "ArmorClaw needs your approval",
        body: `${status.pendingApprovals} action${status.pendingApprovals === 1 ? "" : "s"} waiting for your review.`,
      });
      n.on("click", () => shell.openExternal(`${status.dashboardUrl}/#home`));
      n.show();
    }
    lastNotifiedApprovals = status.pendingApprovals;
  }

  // Wire up manager events
  manager.on("state-change", (s: GatewayStatus) => update(s));

  // Rebuild the menu when update status or model provider changes
  onUpdateChange(() => {
    tray.setContextMenu(buildMenu(currentStatus));
  });
  onModelAdapterChange(() => {
    tray.setContextMenu(buildMenu(currentStatus));
  });

  // Initial state
  tray.setContextMenu(buildMenu(currentStatus));

  return {
    tray,
    update,
    destroy: () => tray.destroy(),
  };
}
