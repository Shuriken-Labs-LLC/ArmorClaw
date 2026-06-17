import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./logger";
import { initDatabase, closeDatabase } from "./db";
import { spawnOpenClaw, setMessageHandler, killOpenClaw } from "./openclaw";
import { registerIpcHandlers } from "./ipc-handlers";
import { getAppState } from "./repositories";
import { handleDeepLink } from "./deep-link";
import { startScheduler, stopScheduler } from "./scheduler";
import { seedMorningBriefing } from "./seed-briefing";
import { createTray, destroyTray } from "./tray";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

app.setName("ArmorClaw");

if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient("armorclaw", process.execPath, [
      process.argv[1]!,
    ]);
  }
} else {
  app.setAsDefaultProtocolClient("armorclaw");
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#0f0f10",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.on("ready-to-show", () => {
    mainWindow?.show();
  });

  if (process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(() => {
  logger.initLogFile();
  logger.info("ArmorClaw starting");

  initDatabase();

  ipcMain.handle("app:version", () => app.getVersion());
  registerIpcHandlers();

  setMessageHandler((message) => {
    mainWindow?.webContents.send("openclaw:message", message);
  });

  createWindow();
  createTray(() => mainWindow);

  const state = getAppState();
  const wsName = state.activeWorkspaceId ?? "Default Workspace";
  const projName = state.activeProjectId ?? "Default Project";
  spawnOpenClaw(wsName, projName);

  if (state.onboardingState === "done") {
    if (state.activeWorkspaceId && state.activeProjectId) {
      seedMorningBriefing(state.activeWorkspaceId, state.activeProjectId);
    }
    startScheduler(() => mainWindow);
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app.on("open-url", (event, url) => {
    event.preventDefault();
    handleDeepLink(url, () => mainWindow);
  });

  app.on("second-instance", (_event, argv) => {
    const deepLink = argv.find((arg) => arg.startsWith("armorclaw://"));
    if (deepLink) {
      handleDeepLink(deepLink, () => mainWindow);
    }
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  destroyTray();
  stopScheduler();
  killOpenClaw();
  closeDatabase();
  logger.info("ArmorClaw shutdown complete");
});
