/**
 * Dashboard smoke test — headless Chromium via Playwright.
 *
 * Starts the dashboard server on localhost:7390, loads the page, and asserts:
 *   1. Zero JS console errors (catches TDZ, undeclared vars, etc.)
 *   2. Sidebar nav renders all 8 items
 *
 * Run: npm run test:smoke (from wrapper/launcher/)
 */

import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const launcherDir = join(__dirname, "..", "..", "launcher");

// ── 1. Build TypeScript ─────────────────────────────────────────────────────

console.log("[smoke] Building TypeScript…");
execSync("npm run build:ts", { cwd: launcherDir, stdio: "inherit" });

// ── 2. Start dashboard server ───────────────────────────────────────────────

const { startServer } = await import("../../dashboard/server.ts");

const SMOKE_PORT = 7390;
const { close } = await startServer(SMOKE_PORT);
console.log(`[smoke] Dashboard listening on http://127.0.0.1:${SMOKE_PORT}`);

// ── 3. Launch headless browser ──────────────────────────────────────────────

const { chromium } = await import("playwright-core");
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage();

  // Collect all JS errors thrown in the page context
  const pageErrors: Error[] = [];
  page.on("pageerror", (err) => pageErrors.push(err));

  // Use 'domcontentloaded' — 'networkidle' never fires because the SSE
  // connection stays open permanently.
  await page.goto(`http://127.0.0.1:${SMOKE_PORT}`, {
    waitUntil: "domcontentloaded",
    timeout: 8_000,
  });

  // Give inline <script> time to execute (boot builds nav synchronously,
  // but SSE/chat init may trigger async errors we want to catch).
  await page.waitForTimeout(1_000);

  // ── 4. Assert zero page errors ──────────────────────────────────────────

  if (pageErrors.length > 0) {
    console.error("[smoke] FAIL — JS errors in dashboard:");
    for (const err of pageErrors) {
      console.error(`  • ${err.message}`);
    }
    process.exitCode = 1;
  } else {
    console.log("[smoke] PASS — zero JS page errors");
  }

  // ── 5. Assert sidebar nav item count ────────────────────────────────────

  const navCount = await page.evaluate(
    () => document.querySelectorAll("#sidebar-nav .nav-item").length,
  );

  if (navCount !== 8) {
    console.error(`[smoke] FAIL — expected 8 sidebar nav items, got ${navCount}`);
    process.exitCode = 1;
  } else {
    console.log("[smoke] PASS — 8 sidebar nav items rendered");
  }
} finally {
  // ── 6. Teardown ───────────────────────────────────────────────────────────

  await browser.close();
  await close();
  console.log("[smoke] Server closed.");
}
