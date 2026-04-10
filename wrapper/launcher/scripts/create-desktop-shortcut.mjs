/**
 * Post-install script: creates a desktop shortcut that launches ArmorClaw
 * and opens the dashboard in the default browser.
 *
 * macOS: creates ~/Desktop/ArmorClaw.command (executable shell script)
 * Windows: desktop shortcut is handled by electron-builder NSIS config
 */

import { writeFileSync, chmodSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const platform = process.platform;

if (platform === "darwin") {
  const shortcutPath = join(homedir(), "Desktop", "ArmorClaw.command");

  // Don't overwrite if the user already has one
  if (existsSync(shortcutPath)) {
    console.log("Desktop shortcut already exists:", shortcutPath);
    process.exit(0);
  }

  const script = `#!/bin/bash
# ArmorClaw — launches the app and opens the dashboard
# Created by ArmorClaw installer

APP="/Applications/ArmorClaw.app"
DASHBOARD="http://localhost:7390"

# Check if already running
if ! pgrep -f "ArmorClaw" > /dev/null 2>&1; then
  echo "Starting ArmorClaw..."
  open "$APP"

  # Wait up to 10 seconds for the dashboard
  for i in $(seq 1 20); do
    if curl -s -o /dev/null -w "%{http_code}" "$DASHBOARD" 2>/dev/null | grep -q "200"; then
      break
    fi
    sleep 0.5
  done
fi

# Open the dashboard in the default browser
open "$DASHBOARD"
`;

  writeFileSync(shortcutPath, script, "utf-8");
  chmodSync(shortcutPath, 0o755);
  console.log("Created desktop shortcut:", shortcutPath);
}
