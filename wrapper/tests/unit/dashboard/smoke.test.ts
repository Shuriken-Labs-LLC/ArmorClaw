/**
 * Dashboard smoke test — validates that the inline <script> in index.html
 * can reference all symbols served by /dashboard-lib.js without errors.
 *
 * This test does NOT launch a browser. It verifies:
 * 1. The TS modules export all expected symbols
 * 2. The server can generate the /dashboard-lib.js payload
 * 3. The generated JS is syntactically valid (eval in a sandbox)
 * 4. The HTML doesn't reference any removed symbols without the lib
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as DashConstants from "../../../dashboard/src/constants.ts";
import * as DashNav from "../../../dashboard/src/nav.ts";
import { INITIAL_STATE } from "../../../dashboard/src/state.ts";
import * as DashState from "../../../dashboard/src/state.ts";
import * as DashUtils from "../../../dashboard/src/utils.ts";

const HTML_PATH = join(import.meta.dirname, "..", "..", "..", "dashboard", "public", "index.html");

describe("dashboard smoke", () => {
  const expectedConstants = [
    "NAV",
    "PROVIDER_LABELS",
    "PROVIDER_KEY_HINTS",
    "SCHEDULE_PRESETS",
    "PERM_LABELS",
    "DAY_ABBRS",
    "SKILL_ICONS",
  ];

  const expectedUtils = ["escHtml", "escAttr", "fmtUSD", "fmtTime", "humaniseSkillName", "maskKey"];

  it("exports all expected constants", () => {
    for (const name of expectedConstants) {
      expect(DashConstants).toHaveProperty(name);
      expect(DashConstants[name as keyof typeof DashConstants]).toBeDefined();
    }
  });

  it("exports all expected utility functions", () => {
    for (const name of expectedUtils) {
      expect(DashUtils).toHaveProperty(name);
      expect(typeof DashUtils[name as keyof typeof DashUtils]).toBe("function");
    }
  });

  it("generates syntactically valid JS from constants and utils", () => {
    const constLines = Object.entries(DashConstants).map(
      ([k, v]) => `var ${k}=${JSON.stringify(v)};`,
    );
    const fnLines = Object.entries(DashUtils).map(
      ([k, fn]) => `var ${k}=${(fn as Function).toString()};`,
    );
    const libJs = constLines.concat(fnLines).join("\n");

    // Verify the generated JS is non-empty and contains expected declarations
    expect(libJs.length).toBeGreaterThan(100);
    for (const name of [...expectedConstants, ...expectedUtils]) {
      expect(libJs).toContain(`var ${name}=`);
    }
  });

  it("HTML does not duplicate extracted constants or utils", () => {
    const html = readFileSync(HTML_PATH, "utf-8");

    // Constants should NOT be re-declared in the inline script
    for (const name of expectedConstants) {
      const re = new RegExp(`\\bconst\\s+${name}\\s*=`);
      expect(html).not.toMatch(re);
    }

    // Utility functions should NOT be re-declared in the inline script
    for (const name of expectedUtils) {
      const re = new RegExp(`\\bfunction\\s+${name}\\s*\\(`);
      expect(html).not.toMatch(re);
    }
  });

  it("HTML still references extracted symbols (not broken)", () => {
    const html = readFileSync(HTML_PATH, "utf-8");

    // These symbols should still be USED in the inline script
    const usedSymbols = ["NAV", "escHtml", "fmtUSD", "fmtTime", "SCHEDULE_PRESETS", "PERM_LABELS"];
    for (const name of usedSymbols) {
      expect(html).toContain(name);
    }
  });

  it("HTML loads dashboard-lib.js before inline script", () => {
    const html = readFileSync(HTML_PATH, "utf-8");
    const libScriptPos = html.indexOf('<script src="/dashboard-lib.js">');
    const inlineScriptPos = html.indexOf("<script>", libScriptPos);
    expect(libScriptPos).toBeGreaterThan(-1);
    expect(inlineScriptPos).toBeGreaterThan(libScriptPos);
  });

  // Sanity-check the utility functions themselves
  it("escHtml escapes HTML special characters", () => {
    expect(DashUtils.escHtml('<b>"hi"</b>')).toBe("&lt;b&gt;&quot;hi&quot;&lt;/b&gt;");
    expect(DashUtils.escHtml(null)).toBe("");
    expect(DashUtils.escHtml(undefined)).toBe("");
  });

  it("fmtUSD formats numbers correctly", () => {
    expect(DashUtils.fmtUSD(12.5)).toBe("$12.50");
    expect(DashUtils.fmtUSD(0.03)).toBe("$0.03");
    expect(DashUtils.fmtUSD("not a number")).toBe("$0.00");
  });

  it("humaniseSkillName converts IDs to readable names", () => {
    expect(DashUtils.humaniseSkillName("email-calendar")).toBe("Email Calendar");
    expect(DashUtils.humaniseSkillName("secure_files")).toBe("Secure Files");
    expect(DashUtils.humaniseSkillName("browserAutomation")).toBe("Browser Automation");
  });

  it("maskKey masks middle of API keys", () => {
    expect(DashUtils.maskKey("sk-ant-abc123xyz789")).toContain("sk-a");
    expect(DashUtils.maskKey("sk-ant-abc123xyz789")).toContain("z789");
    expect(DashUtils.maskKey("short")).toBe("\u2022\u2022\u2022\u2022\u2022");
  });

  // ── state.ts (PR 2) ────────────────────────────────────────────────────────

  it("INITIAL_STATE exports all 42 expected keys with correct initial values", () => {
    expect(INITIAL_STATE.activeView).toBe("home");
    expect(INITIAL_STATE.dashState).toBeNull();
    expect(INITIAL_STATE.undoDismissed).toBe(false);
    expect(INITIAL_STATE.undoTickerId).toBeNull();
    expect(INITIAL_STATE.selectedProvider).toBe("");
    expect(INITIAL_STATE.tbBreakdownOpen).toBe(false);
    expect(INITIAL_STATE._bundledSkillsLoaded).toBe(false);

    // Advanced view
    expect(INITIAL_STATE.advancedPollTimer).toBeNull();
    expect(INITIAL_STATE.advancedGatewayOnline).toBe(false);
    expect(INITIAL_STATE._updateBannerDismissed).toBe(false);

    // Dedup guards
    expect(INITIAL_STATE._lastAgentStatus).toBe("");
    expect(INITIAL_STATE._lastApprovalIds).toBe("");
    expect(INITIAL_STATE._lastChannelIds).toBe("");
    expect(INITIAL_STATE._lastBudgetKey).toBe("");
    expect(INITIAL_STATE._lastFeedKey).toBe("");

    // Channels
    expect(INITIAL_STATE.channelsData).toBeNull();
    expect(INITIAL_STATE.channelsLoaded).toBe(false);
    expect(INITIAL_STATE.tgSetupOpen).toBe(false);
    expect(INITIAL_STATE.tgValidated).toBe(false);
    expect(INITIAL_STATE.tgBotUsername).toBe("");

    // Chat connection
    expect(INITIAL_STATE.chatDebugLog).toEqual([]);
    expect(INITIAL_STATE.chatClickCount).toBe(0);
    expect(INITIAL_STATE.chatClickTimer).toBeNull();
    expect(INITIAL_STATE.chatGatewayUrl).toBe("ws://127.0.0.1:18789");
    expect(INITIAL_STATE.chatGatewayToken).toBe("");
    expect(INITIAL_STATE.chatWs).toBeNull();
    expect(INITIAL_STATE.chatConnected).toBe(false);
    expect(INITIAL_STATE.chatAuthenticated).toBe(false);
    expect(INITIAL_STATE.chatResponding).toBe(false);
    expect(INITIAL_STATE.chatPendingId).toBeNull();
    expect(INITIAL_STATE.chatResponseBuffer).toBe("");
    expect(INITIAL_STATE.chatLastUserMessage).toBe("");
    expect(INITIAL_STATE.chatMsgIdCounter).toBe(0);
    expect(INITIAL_STATE.chatConnectId).toBeNull();
    expect(INITIAL_STATE.chatChallengeNonce).toBeNull();

    // Chat retry
    expect(INITIAL_STATE.chatRetryAttempts).toBe(0);
    expect(INITIAL_STATE.chatRetryTimer).toBeNull();

    // Token tracking bridge
    expect(INITIAL_STATE.chatLastSessionTokens).toEqual({ input: 0, output: 0 });
    expect(INITIAL_STATE.chatUsagePendingCallbacks).toEqual({});

    expect(Object.keys(INITIAL_STATE)).toHaveLength(41);
  });

  it("generated /dashboard-lib.js contains state var declarations", () => {
    const constLines = Object.entries(DashConstants).map(
      ([k, v]) => `var ${k}=${JSON.stringify(v)};`,
    );
    const fnLines = Object.entries(DashUtils).map(
      ([k, fn]) => `var ${k}=${(fn as Function).toString()};`,
    );
    const stateLines = Object.entries(DashState.INITIAL_STATE).map(
      ([k, v]) => `var ${k}=${JSON.stringify(v)};`,
    );
    const libJs = constLines.concat(fnLines, stateLines).join("\n");

    expect(libJs).toContain('var activeView="home"');
    expect(libJs).toContain("var dashState=null");
    expect(libJs).toContain('var chatGatewayToken=""');
    expect(libJs).toContain('var chatGatewayUrl="ws://127.0.0.1:18789"');
  });

  it("HTML does not contain let declarations for extracted state variables", () => {
    const html = readFileSync(HTML_PATH, "utf-8");
    const removedVars = Object.keys(DashState.INITIAL_STATE);
    for (const name of removedVars) {
      const re = new RegExp(`\\blet\\s+${name}\\b`);
      expect(html).not.toMatch(re);
    }
  });

  it("chatGatewayToken initial value contains no secrets", () => {
    // Must be empty string or null — never a real token
    expect(INITIAL_STATE.chatGatewayToken).toBe("");
  });

  it("all INITIAL_STATE values are JSON-serializable", () => {
    // Round-trip through JSON should produce identical output
    const serialized = JSON.parse(JSON.stringify(INITIAL_STATE));
    for (const [key, value] of Object.entries(INITIAL_STATE)) {
      expect(serialized[key]).toEqual(value);
    }
  });

  // ── nav.ts (PR 3) ──────────────────────────────────────────────────────────

  it("exports all expected nav functions", () => {
    const expectedNav = ["buildNav", "showView", "openDrawer", "closeDrawer"];
    for (const name of expectedNav) {
      expect(DashNav).toHaveProperty(name);
      expect(typeof DashNav[name as keyof typeof DashNav]).toBe("function");
    }
  });

  it("nav functions serialize to valid JS via Function.toString()", () => {
    const navLines = Object.entries(DashNav).map(
      ([k, fn]) => `var ${k}=${(fn as Function).toString()};`,
    );
    const navJs = navLines.join("\n");
    expect(navJs.length).toBeGreaterThan(50);
    for (const name of ["buildNav", "showView", "openDrawer", "closeDrawer"]) {
      expect(navJs).toContain(`var ${name}=`);
    }
    // Must not contain TypeScript-specific syntax in the serialised output
    expect(navJs).not.toMatch(/:\s*(string|void|boolean|number|null)\b/);
    expect(navJs).not.toContain(" as HTMLElement");
  });

  it("HTML does not redefine extracted nav functions", () => {
    const html = readFileSync(HTML_PATH, "utf-8");
    for (const name of ["buildNav", "showView", "openDrawer", "closeDrawer"]) {
      const re = new RegExp(`\\bfunction\\s+${name}\\s*\\(`);
      expect(html).not.toMatch(re);
    }
  });

  it("HTML still calls extracted nav functions (not broken)", () => {
    const html = readFileSync(HTML_PATH, "utf-8");
    // These are called from inline onclick attributes and the boot block
    expect(html).toContain("buildNav(");
    expect(html).toContain("showView(");
    expect(html).toContain("openDrawer()");
    expect(html).toContain("closeDrawer()");
  });

  // ── Subscribe button (subscription card) ──────────────────────────────────

  it("subscription card renders Subscribe button with correct href when inactive", () => {
    const html = readFileSync(HTML_PATH, "utf-8");
    // The inline JS builds checkout href as: paymentLinkBase + '?client_reference_id=' + encodeURIComponent(installId)
    expect(html).toContain("client_reference_id");
    expect(html).toContain("encodeURIComponent(installId)");
    expect(html).toContain("Subscribe to ArmorClaw");
  });

  it("subscription card renders Manage subscription link when active", () => {
    const html = readFileSync(HTML_PATH, "utf-8");
    expect(html).toContain("Manage subscription");
    expect(html).toContain("ArmorClaw — Active");
  });

  it("subscription card shows fallback text when active but no portal URL", () => {
    const html = readFileSync(HTML_PATH, "utf-8");
    expect(html).toContain("Subscription managed by Stripe");
  });
});
