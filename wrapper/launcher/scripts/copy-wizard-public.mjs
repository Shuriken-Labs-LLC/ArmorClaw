/**
 * Post-tsc build step: copies public/ directories into the compiled output
 * so that static assets are available at the same relative paths the servers
 * expect (import.meta.dirname + "public/").
 */

import { cpSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const launcherDir = resolve(scriptDir, "..");
const wrapperDir = resolve(launcherDir, "..");
const distSrc = resolve(launcherDir, "dist-src");

// Onboarding wizard HTML
const wizardSrc = resolve(wrapperDir, "onboarding", "public");
const wizardDest = resolve(distSrc, "onboarding", "public");
mkdirSync(wizardDest, { recursive: true });
cpSync(wizardSrc, wizardDest, { recursive: true });

// Dashboard HTML
const dashSrc = resolve(wrapperDir, "dashboard", "public");
const dashDest = resolve(distSrc, "dashboard", "public");
mkdirSync(dashDest, { recursive: true });
cpSync(dashSrc, dashDest, { recursive: true });

// Launcher assets (tray icons, app icons) — tray.ts resolves assets
// relative to import.meta.dirname which lands in dist-src/launcher/,
// so assets must also be inside dist-src/ for the path to work.
const assetsSrc = resolve(launcherDir, "assets");
const assetsDest = resolve(distSrc, "assets");
mkdirSync(assetsDest, { recursive: true });
cpSync(assetsSrc, assetsDest, { recursive: true });
