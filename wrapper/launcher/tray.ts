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
import type { GatewayManager, GatewayStatus } from "./gateway-manager.ts";

// ── Asset paths ───────────────────────────────────────────────────────────────

const ASSETS = join(import.meta.dirname, "assets");

function iconPath(variant: "green" | "amber" | "red"): string {
  return join(ASSETS, `icon-${variant}.png`);
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
        label: "Check for updates",
        click: () => shell.openExternal("https://armorclaw.ai/update"),
      },
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

  // Initial state
  tray.setContextMenu(buildMenu(currentStatus));

  return {
    tray,
    update,
    destroy: () => tray.destroy(),
  };
}
