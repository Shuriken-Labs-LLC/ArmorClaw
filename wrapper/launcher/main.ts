/**
 * ArmorClaw Launcher — Electron main process.
 *
 * Lives in the system tray. No visible window. Manages the gateway
 * process lifecycle and provides quick access to the dashboard.
 *
 * First launch: starts the gateway automatically.
 * Subsequent launches: connects to the already-running gateway.
 * Login: auto-starts via platform-native login item settings.
 */

import { app } from "electron";
import { GatewayManager } from "./gateway-manager.ts";
import { createTray } from "./tray.ts";

// ── Single instance lock ──────────────────────────────────────────────────────

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

// Hide dock icon on macOS — this is a tray-only app.
if (process.platform === "darwin") {
  app.dock?.hide();
}

app.on("ready", async () => {
  // Auto-start on login
  configureLoginItem();

  // Create the gateway manager and tray
  const manager = new GatewayManager();
  const trayHandle = createTray(manager);

  // Start the gateway (or connect to existing one)
  await manager.start();

  // If the manager detects the gateway died, update tray
  manager.on("state-change", () => {
    trayHandle.update(manager.status);
  });
});

// Prevent default quit when all windows close (we're a tray app)
app.on("window-all-closed", (e: Event) => {
  e.preventDefault();
});

// ── Login item ────────────────────────────────────────────────────────────────

function configureLoginItem(): void {
  try {
    app.setLoginItemSettings({
      openAtLogin: true,
      name: "ArmorClaw",
    });
  } catch {
    // Silently fail — login item is a convenience, not a requirement
  }
}
