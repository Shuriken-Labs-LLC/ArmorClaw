/**
 * Cross-platform path resolution for ArmorClaw configuration.
 *
 * Resolves to:
 *  - macOS:   ~/Library/Application Support/armorclaw-launcher/
 *  - Windows: %APPDATA%\armorclaw-launcher\
 *  - Linux:   ~/.config/armorclaw-launcher/
 *
 * Also provides the ArmorClaw user data directory:
 *  - macOS/Linux: ~/.armorclaw/
 *  - Windows:     %APPDATA%\ArmorClaw\
 */

import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Electron-style "userData" path for the launcher. This is where
 * skills.json, channels.json, and other launcher config live.
 */
export function getLauncherDataPath(): string {
  switch (process.platform) {
    case "win32": {
      const appData = process.env["APPDATA"];
      return appData
        ? join(appData, "armorclaw-launcher")
        : join(homedir(), "AppData", "Roaming", "armorclaw-launcher");
    }
    case "darwin":
      return join(homedir(), "Library", "Application Support", "armorclaw-launcher");
    default:
      // Linux and other Unix-like
      return join(homedir(), ".config", "armorclaw-launcher");
  }
}

/**
 * ArmorClaw user-level config directory (audit.log, tokens.ndjson, etc.).
 *  - macOS/Linux: ~/.armorclaw/
 *  - Windows:     %APPDATA%\ArmorClaw\
 */
export function getArmorclawConfigDir(): string {
  if (process.platform === "win32") {
    const appData = process.env["APPDATA"];
    return appData ? join(appData, "ArmorClaw") : join(homedir(), ".armorclaw");
  }
  return join(homedir(), ".armorclaw");
}

/**
 * Parent directory of the launcher data path — used as the backup
 * destination parent so backups sit alongside the config folder.
 */
export function getBackupParentDir(): string {
  return join(getLauncherDataPath(), "..");
}
