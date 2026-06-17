import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./logger";
import { initDatabase, closeDatabase } from "./db";
import { spawnOpenClaw, setMessageHandler, killOpenClaw } from "./openclaw";
import { registerIpcHandlers } from "./ipc-handlers";
import { getAppState } from "./repositories";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

app.setName("ArmorClaw");

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

  const state = getAppState();
  const wsName = state.activeWorkspaceId ?? "Default Workspace";
  const projName = state.activeProjectId ?? "Default Project";
  spawnOpenClaw(wsName, projName);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  killOpenClaw();
  closeDatabase();
  logger.info("ArmorClaw shutdown complete");
});
