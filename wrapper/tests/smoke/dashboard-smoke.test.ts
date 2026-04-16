/**
 * Dashboard smoke test — headless Chromium via Playwright.
 *
 * Starts the dashboard server on localhost:7390, loads the page, and asserts:
 *   1. Zero JS console errors (catches TDZ, undeclared vars, etc.)
 *   2. Sidebar nav renders all 8 items
 *
 * Run: npx vitest run tests/smoke/dashboard-smoke.test.ts (from wrapper/)
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clearDashboardStateForTesting, startServer } from "../../dashboard/server.ts";

const SMOKE_PORT = 7390;

describe("dashboard smoke", () => {
  let close: () => Promise<void>;
  let browser: import("playwright-core").Browser | null = null;
  const pageErrors: Error[] = [];
  let navCount = 0;

  beforeAll(async () => {
    ({ close } = await startServer(SMOKE_PORT));

    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({ headless: true });

    const page = await browser.newPage();
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

    navCount = await page.evaluate(
      () => document.querySelectorAll("#sidebar-nav .nav-item").length,
    );
  }, 60_000);

  afterAll(async () => {
    if (browser) {
      await browser.close();
    }
    if (close) {
      await close();
    }
    // Stop the license cache refresh timer so the worker process can exit
    // cleanly. unref() on the interval handle is not enough under vitest's
    // forced-teardown path.
    clearDashboardStateForTesting();
  });

  it("has zero JS page errors on load", () => {
    expect(pageErrors).toEqual([]);
  });

  it("renders 8 sidebar nav items", () => {
    expect(navCount).toBe(8);
  });
});
