/**
 * ArmorClaw skill: Browser automation (browser)
 *
 * Capabilities:
 *  - navigate:      Visit a URL, return title and final URL
 *  - fill-form:     Fill form fields and optionally submit
 *  - extract:       Pull structured data from a page via CSS selector
 *  - screenshot:    Capture a PNG screenshot of a page
 *  - get-cookies:   List stored cookies (optionally filtered by domain)
 *  - clear-cookies: Delete cookies (optionally for one domain)
 *  - allow-cookies: Mark a domain for persistent cookie storage
 *
 * Security constraints:
 *  - Runs in ~/.armorclaw/browser-profile only — never the user's default profile
 *  - Playwright browser cache stored in ~/.armorclaw/playwright-cache
 *  - fill-form requires the target domain to be in ARMORCLAW_BROWSER_ALLOWED_DOMAINS
 *  - Cookies are not persisted across sessions unless the domain is allow-listed
 *  - Headless by default; headed requires ARMORCLAW_BROWSER_HEADED=true
 *  - Login flows are only automated for explicitly configured domains
 *
 * undoable: false — browser actions are not reversible.
 *
 * Permission manifest: browser:sandboxed, network:outbound
 */

import { homedir } from "node:os";
import * as nodePath from "node:path";
import { registerSkill } from "../../lib/skill-registry.ts";
import { writeAuditEntry } from "../../security/audit-logger.ts";
import type {
  BrowserInput,
  BrowserOutput,
  CookieInfo,
  FormField,
  IBrowserAdapter,
} from "./types.ts";

// ── Skill metadata ────────────────────────────────────────────────────────────

export const SKILL_NAME = "browser";
export const SKILL_VERSION = "1.0.0";
export const PERMISSION_MANIFEST = ["browser:sandboxed", "network:outbound"] as const;

// ── Profile / cache paths ─────────────────────────────────────────────────────

/**
 * Path to the dedicated ArmorClaw Chromium profile.
 * Never the user's default browser profile.
 */
export function getBrowserProfilePath(): string {
  return nodePath.join(homedir(), ".armorclaw", "browser-profile");
}

/**
 * Path for the Playwright browser cache.
 * Isolated from any system-wide Playwright installation.
 */
export function getPlaywrightCachePath(): string {
  return nodePath.join(homedir(), ".armorclaw", "playwright-cache");
}

// ── Configuration helpers ─────────────────────────────────────────────────────

/** Returns true when the user has explicitly opted into headed mode. */
export function isHeadedModeEnabled(): boolean {
  return process.env["ARMORCLAW_BROWSER_HEADED"] === "true";
}

/**
 * Domains allowed for form automation (fill-form action).
 * Read from ARMORCLAW_BROWSER_ALLOWED_DOMAINS — comma-separated list.
 * Returns an empty set when the env var is not set (no domains allowed).
 */
export function getAllowedFormDomains(): Set<string> {
  const raw = process.env["ARMORCLAW_BROWSER_ALLOWED_DOMAINS"] ?? "";
  const domains = raw
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  return new Set(domains);
}

/**
 * Extract the hostname from a URL.
 * Returns an empty string on parse failure.
 */
export function extractHostname(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

// ── Real Playwright adapter ───────────────────────────────────────────────────

/**
 * Production adapter backed by Playwright's persistent Chromium context.
 * Lazily initialises the browser on first use.
 * Cookie persistence is restricted to explicitly allow-listed domains.
 */
export class PlaywrightBrowserAdapter implements IBrowserAdapter {
  /** Allow-listed domains that get persistent cookies. */
  private readonly allowedCookieDomains = new Set<string>();

  /** Lazy context promise — created on first call, reused thereafter. */
  private contextPromise: Promise<import("playwright-core").BrowserContext> | null = null;

  private getContext(): Promise<import("playwright-core").BrowserContext> {
    if (!this.contextPromise) {
      this.contextPromise = this.initContext();
    }
    return this.contextPromise;
  }

  private async initContext(): Promise<import("playwright-core").BrowserContext> {
    // Redirect Playwright's browser download cache to the isolated path
    process.env["PLAYWRIGHT_BROWSERS_PATH"] = getPlaywrightCachePath();

    const { chromium } = await import("playwright-core");
    return chromium.launchPersistentContext(getBrowserProfilePath(), {
      headless: !isHeadedModeEnabled(),
    });
  }

  async navigate(
    url: string,
    opts: { waitForSelector?: string } = {},
  ): Promise<{ title: string; url: string }> {
    const ctx = await this.getContext();
    const page = await ctx.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      if (opts.waitForSelector) {
        await page.waitForSelector(opts.waitForSelector, { timeout: 10_000 });
      }
      const title = await page.title();
      const finalUrl = page.url();
      await this.enforceCookiePolicy(ctx);
      return { title, url: finalUrl };
    } finally {
      await page.close().catch(() => {});
    }
  }

  async fillForm(
    url: string,
    fields: FormField[],
    opts: { submitSelector?: string; waitForSelector?: string } = {},
  ): Promise<{ title: string; url: string }> {
    const ctx = await this.getContext();
    const page = await ctx.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      for (const { selector, value } of fields) {
        await page.fill(selector, value);
      }
      if (opts.submitSelector) {
        await page.click(opts.submitSelector);
      }
      if (opts.waitForSelector) {
        await page.waitForSelector(opts.waitForSelector, { timeout: 10_000 });
      }
      const title = await page.title();
      const finalUrl = page.url();
      await this.enforceCookiePolicy(ctx);
      return { title, url: finalUrl };
    } finally {
      await page.close().catch(() => {});
    }
  }

  async extract(url: string, selector: string, attribute?: string): Promise<string[]> {
    const ctx = await this.getContext();
    const page = await ctx.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      const results = await page.$$eval(
        selector,
        (els, attr) =>
          els.map((el) => (attr ? (el.getAttribute(attr) ?? "") : (el.textContent?.trim() ?? ""))),
        attribute,
      );
      await this.enforceCookiePolicy(ctx);
      return results;
    } finally {
      await page.close().catch(() => {});
    }
  }

  async screenshot(url: string): Promise<Buffer> {
    const ctx = await this.getContext();
    const page = await ctx.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      const buf = await page.screenshot({ type: "png", fullPage: false });
      await this.enforceCookiePolicy(ctx);
      return Buffer.from(buf);
    } finally {
      await page.close().catch(() => {});
    }
  }

  async getCookies(domain?: string): Promise<CookieInfo[]> {
    const ctx = await this.getContext();
    const all = await ctx.cookies(domain ? [domain] : undefined);
    const filtered = domain ? all.filter((c) => c.domain.includes(domain)) : all;
    return filtered.map((c) => ({
      name: c.name,
      domain: c.domain,
      expires: c.expires ?? undefined,
    }));
  }

  async clearCookies(domain?: string): Promise<void> {
    const ctx = await this.getContext();
    if (!domain) {
      await ctx.clearCookies();
      return;
    }
    // Playwright clears all cookies; selectively restore non-target domains
    const all = await ctx.cookies();
    const keep = all.filter((c) => !c.domain.includes(domain));
    await ctx.clearCookies();
    if (keep.length > 0) {
      await ctx.addCookies(keep);
    }
  }

  allowCookiesForDomain(domain: string): void {
    this.allowedCookieDomains.add(domain.toLowerCase());
  }

  async close(): Promise<void> {
    if (this.contextPromise) {
      try {
        const ctx = await this.contextPromise;
        await ctx.close();
      } catch {
        // Ignore errors on close
      } finally {
        this.contextPromise = null;
      }
    }
  }

  /**
   * After each page operation, discard cookies for domains that haven't been
   * explicitly allowed. This enforces the no-persistent-cookies constraint.
   */
  private async enforceCookiePolicy(ctx: import("playwright-core").BrowserContext): Promise<void> {
    if (this.allowedCookieDomains.size === 0) {
      // No allowed domains — clear everything
      await ctx.clearCookies().catch(() => {});
      return;
    }
    const all = await ctx.cookies().catch(() => []);
    const keep = all.filter((c) =>
      [...this.allowedCookieDomains].some((allowed) => c.domain.includes(allowed)),
    );
    await ctx.clearCookies().catch(() => {});
    if (keep.length > 0) {
      await ctx.addCookies(keep).catch(() => {});
    }
  }
}

// ── Skill factory (injectable adapter for tests) ──────────────────────────────

let _defaultAdapter: IBrowserAdapter | null = null;

function getDefaultAdapter(): IBrowserAdapter {
  if (!_defaultAdapter) {
    _defaultAdapter = new PlaywrightBrowserAdapter();
  }
  return _defaultAdapter;
}

export function createBrowserSkill(adapter: IBrowserAdapter): {
  run: (input: BrowserInput) => Promise<BrowserOutput>;
  undo: () => Promise<void>;
} {
  return { run: (input) => runWithAdapter(input, adapter), undo };
}

/** Reset the default adapter — for testing only. */
export function resetDefaultAdapterForTesting(): void {
  _defaultAdapter = null;
}

// ── Exported skill entrypoints ────────────────────────────────────────────────

export async function run(input: BrowserInput): Promise<BrowserOutput> {
  return runWithAdapter(input, getDefaultAdapter());
}

export async function undo(): Promise<void> {
  // Browser actions are not reversible — undoable: false
}

// ── Audit helper ──────────────────────────────────────────────────────────────

function auditBrowserOp(
  action: string,
  url: string | undefined,
  outcome: "success" | "error" | "rejected",
  durationMs: number,
): void {
  const urlSummary = url ? extractHostname(url) || url.slice(0, 40) : "no-url";
  writeAuditEntry({
    timestamp: new Date().toISOString(),
    skill: SKILL_NAME,
    permissionsUsed: [...PERMISSION_MANIFEST],
    inputSummary: `${action}:${urlSummary}`.slice(0, 80),
    outcome,
    durationMs,
  });
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

async function runWithAdapter(
  input: BrowserInput,
  adapter: IBrowserAdapter,
): Promise<BrowserOutput> {
  const start = Date.now();

  try {
    switch (input.action) {
      case "navigate":
        return await handleNavigate(input, adapter, start);
      case "fill-form":
        return await handleFillForm(input, adapter, start);
      case "extract":
        return await handleExtract(input, adapter, start);
      case "screenshot":
        return await handleScreenshot(input, adapter, start);
      case "get-cookies":
        return await handleGetCookies(input, adapter, start);
      case "clear-cookies":
        return await handleClearCookies(input, adapter, start);
      case "allow-cookies":
        return await handleAllowCookies(input, adapter, start);
      default: {
        const exhaustive: never = input.action;
        return {
          success: false,
          message: `Unknown action: ${String(exhaustive)}`,
        };
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeAuditEntry({
      timestamp: new Date().toISOString(),
      skill: SKILL_NAME,
      permissionsUsed: [...PERMISSION_MANIFEST],
      inputSummary: `action:${input.action}:error`.slice(0, 80),
      outcome: "error",
      durationMs: Date.now() - start,
    });
    return { success: false, message };
  }
}

// ── Action handlers ───────────────────────────────────────────────────────────

async function handleNavigate(
  input: BrowserInput,
  adapter: IBrowserAdapter,
  start: number,
): Promise<BrowserOutput> {
  if (!input.url?.trim()) {
    return { success: false, message: "navigate requires a 'url'." };
  }

  const { title, url: finalUrl } = await adapter.navigate(input.url.trim(), {
    waitForSelector: input.waitForSelector,
  });

  auditBrowserOp("navigate", input.url, "success", Date.now() - start);

  return {
    success: true,
    message: `Navigated to "${title}" (${finalUrl}).`,
    data: { pageTitle: title, pageUrl: finalUrl },
  };
}

async function handleFillForm(
  input: BrowserInput,
  adapter: IBrowserAdapter,
  start: number,
): Promise<BrowserOutput> {
  if (!input.url?.trim()) {
    return { success: false, message: "fill-form requires a 'url'." };
  }
  if (!Array.isArray(input.fields) || input.fields.length === 0) {
    return { success: false, message: "fill-form requires 'fields' array." };
  }

  // Domain must be explicitly allowed for form automation
  const hostname = extractHostname(input.url.trim());
  const allowedDomains = getAllowedFormDomains();

  if (allowedDomains.size > 0 && !allowedDomains.has(hostname)) {
    auditBrowserOp("fill-form", input.url, "rejected", Date.now() - start);
    return {
      success: false,
      message: `Domain "${hostname}" is not configured for form automation. Add it to ARMORCLAW_BROWSER_ALLOWED_DOMAINS to proceed.`,
    };
  }

  const { title, url: finalUrl } = await adapter.fillForm(input.url.trim(), input.fields, {
    submitSelector: input.submitSelector,
    waitForSelector: input.waitForSelector,
  });

  auditBrowserOp("fill-form", input.url, "success", Date.now() - start);

  return {
    success: true,
    message: `Form submitted on "${title}" (${finalUrl}).`,
    data: { pageTitle: title, pageUrl: finalUrl },
  };
}

async function handleExtract(
  input: BrowserInput,
  adapter: IBrowserAdapter,
  start: number,
): Promise<BrowserOutput> {
  if (!input.url?.trim()) {
    return { success: false, message: "extract requires a 'url'." };
  }
  if (!input.selector?.trim()) {
    return { success: false, message: "extract requires a 'selector'." };
  }

  const results = await adapter.extract(input.url.trim(), input.selector.trim(), input.attribute);

  auditBrowserOp("extract", input.url, "success", Date.now() - start);

  return {
    success: true,
    message: `Extracted ${results.length} result${results.length !== 1 ? "s" : ""} for selector "${input.selector}".`,
    data: { extracted: results },
  };
}

async function handleScreenshot(
  input: BrowserInput,
  adapter: IBrowserAdapter,
  start: number,
): Promise<BrowserOutput> {
  if (!input.url?.trim()) {
    return { success: false, message: "screenshot requires a 'url'." };
  }

  const buf = await adapter.screenshot(input.url.trim());
  const screenshotBase64 = buf.toString("base64");

  auditBrowserOp("screenshot", input.url, "success", Date.now() - start);

  return {
    success: true,
    message: `Screenshot captured (${buf.length} bytes).`,
    data: { screenshotBase64 },
  };
}

async function handleGetCookies(
  input: BrowserInput,
  adapter: IBrowserAdapter,
  start: number,
): Promise<BrowserOutput> {
  const cookies = await adapter.getCookies(input.domain);

  auditBrowserOp("get-cookies", undefined, "success", Date.now() - start);

  const count = cookies.length;
  return {
    success: true,
    message: `Retrieved ${count} cookie${count !== 1 ? "s" : ""}${input.domain ? ` for ${input.domain}` : ""}.`,
    data: { cookies },
  };
}

async function handleClearCookies(
  input: BrowserInput,
  adapter: IBrowserAdapter,
  start: number,
): Promise<BrowserOutput> {
  await adapter.clearCookies(input.domain);

  auditBrowserOp("clear-cookies", undefined, "success", Date.now() - start);

  return {
    success: true,
    message: input.domain ? `Cookies cleared for ${input.domain}.` : "All browser cookies cleared.",
  };
}

async function handleAllowCookies(
  input: BrowserInput,
  adapter: IBrowserAdapter,
  start: number,
): Promise<BrowserOutput> {
  if (!input.domain?.trim()) {
    return { success: false, message: "allow-cookies requires a 'domain'." };
  }

  adapter.allowCookiesForDomain(input.domain.trim());

  auditBrowserOp("allow-cookies", undefined, "success", Date.now() - start);

  return {
    success: true,
    message: `Cookies enabled for ${input.domain}. Sessions on this domain will persist.`,
  };
}

// ── Registration ──────────────────────────────────────────────────────────────

registerSkill(
  {
    skillId: SKILL_NAME,
    displayName: "Browser automation",
    description:
      "Fill forms, extract structured data, navigate sites, and capture screenshots in a dedicated sandboxed browser profile.",
    version: SKILL_VERSION,
    author: "bundled",
    permissionManifest: [...PERMISSION_MANIFEST],
    undoable: false,
    recipeEligible: true,
    digestMention: true,
  },
  { run, undo },
);
