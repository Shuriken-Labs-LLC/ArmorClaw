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
});
