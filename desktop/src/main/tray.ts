import { Tray, Menu, nativeImage, BrowserWindow, app } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

let tray: Tray | null = null;

export function createTray(getMainWindow: () => BrowserWindow | null): void {
  const iconPath = join(__dirname, "../../build/tray-icon.png");
  let icon: Electron.NativeImage;
  try {
    icon = nativeImage.createFromPath(iconPath);
    icon = icon.resize({ width: 18, height: 18 });
  } catch {
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);
  tray.setToolTip("ArmorClaw");

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Show ArmorClaw",
      click: () => {
        const win = getMainWindow();
        if (win) {
          win.show();
          win.focus();
        }
      },
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => app.quit(),
    },
  ]);

  tray.setContextMenu(contextMenu);

  tray.on("click", () => {
    const win = getMainWindow();
    if (win) {
      if (win.isVisible()) {
        win.focus();
      } else {
        win.show();
      }
    }
  });
}

export function destroyTray(): void {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}
