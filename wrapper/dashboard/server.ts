/**
 * ArmorClaw Dashboard — Express HTTP server.
 *
 * Binds to 127.0.0.1 only. Accessible remotely via the Tailscale URL
 * configured in onboarding Step 5. Never exposed on 0.0.0.0 or a public IP.
 *
 * DATA SOURCES (read-only from the dashboard layer):
 *   ~/.armorclaw/audit.log       — activity feed, skill run history
 *   ~/.armorclaw/tokens.ndjson   — token burn (wired to token-tracker/store.ts)
 *   <repo-root>/.env             — model provider, sandbox dir, channel tokens
 *   wrapper/lib/skill-registry   — registered skill display names
 *
 * The dashboard never writes application state.
 */

import { execSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import express from "express";
import { loadLicense, pollForActivation } from "../billing/license.ts";
import type { License } from "../billing/license.ts";
import { type AgentStatus, getAgentStatus, setAgentStatus } from "../lib/agent-status.ts";
import { getModelAdapterState } from "../lib/model-adapter.ts";
import { getBackupParentDir, getLauncherDataPath } from "../lib/platform-paths.ts";
import { getAllSkills } from "../lib/skill-registry.ts";
import {
  fetchSkillSource,
  installSkill,
  isValidGitHubUrl,
  sanitizeFilename,
} from "../marketplace/importer.ts";
import { verifySkillSource } from "../marketplace/verifier.ts";
import {
  getAllRecipes,
  activateRecipe,
  deactivateRecipe,
  updateSchedule,
} from "../recipes/store.ts";
import type { RecipeWithState } from "../recipes/types.ts";
import type { AuditEntry } from "../security/audit-logger.ts";
import {
  getPendingApprovals as getPermissionPendingApprovals,
  resolveApproval,
  onApprovalChange,
} from "../security/permissions.ts";
import type { PendingToolApproval } from "../security/permissions.ts";
import { calculateCost } from "../token-tracker/pricing.ts";
import type { Provider } from "../token-tracker/pricing.ts";
import {
  getBudgetStatus,
  getDailyHistory,
  getMonthBySkill,
  getMonthTokens,
  getRecentEvents,
  getTodayTokens,
  recordTokenEvent,
  resumeFromHardStop,
  setBudgetMonthlyUSD,
} from "../token-tracker/store.ts";
import type { DailyTotal, TokenEvent } from "../token-tracker/store.ts";
import { getCurrentUndo, executeUndo } from "../undo/registry.ts";
import { getOpenClawVersionStatus, startVersionCheckInterval } from "./openclaw-version-check.ts";
import * as DashConstants from "./src/constants.ts";
import * as DashNav from "./src/nav.ts";
import * as DashState from "./src/state.ts";
import * as DashUtils from "./src/utils.ts";

// ── Constants ─────────────────────────────────────────────────────────────────

export const DASHBOARD_PORT = 7390;

const DASHBOARD_HTML = join(import.meta.dirname, "public", "index.html");

/**
 * Lazily resolve the repo-root .env path on each call.
 *
 * dashboard/server.ts is imported by dashboard-window.ts at the top level of
 * main.ts, which executes BEFORE app.on("ready") fires and before
 * setSharedEnvVars() sets ARMORCLAW_REPO_ROOT. Evaluating the path at module
 * load time would always fall back to import.meta.dirname (pointing into
 * dist-src/) and miss the actual repo root. Calling getEnvFile() at runtime
 * ensures ARMORCLAW_REPO_ROOT is already set.
 */
function getEnvFile(): string {
  return join(process.env["ARMORCLAW_REPO_ROOT"] ?? join(import.meta.dirname, "..", ".."), ".env");
}

// ── Tailscale URL detection ───────────────────────────────────────────────────

/** Cache so we don't shell out on every SSE push (60 s TTL). */
let _tailscaleUrl: string | null | undefined = undefined;
let _tailscaleCheckedAt = 0;
const TAILSCALE_CACHE_TTL_MS = 60_000;

/**
 * Run `tailscale status --json` and extract the device's Tailscale HTTPS URL.
 * Returns null when Tailscale is absent, not authenticated, or times out.
 * Result is cached for 60 seconds.
 */
export function getTailscaleUrl(): string | null {
  const now = Date.now();
  if (_tailscaleUrl !== undefined && now - _tailscaleCheckedAt < TAILSCALE_CACHE_TTL_MS) {
    return _tailscaleUrl;
  }
  try {
    const out = execSync("tailscale status --json", {
      encoding: "utf-8",
      timeout: 3_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const data = JSON.parse(out) as { Self?: { DNSName?: string } };
    const dns = data?.Self?.DNSName;
    _tailscaleUrl = dns ? `https://${dns.replace(/\.$/, "")}` : null;
  } catch {
    _tailscaleUrl = null;
  }
  _tailscaleCheckedAt = now;
  return _tailscaleUrl;
}

/** Force re-detection on next request (for testing). */
export function resetTailscaleCacheForTesting(): void {
  _tailscaleUrl = undefined;
  _tailscaleCheckedAt = 0;
}

// ── License cache ─────────────────────────────────────────────────────────────
//
// loadLicense() does file I/O and (for pro tier) hits the billing Worker.
// The SSE stream pushes every 5 s — re-running that on each tick is wasteful
// and would tie SSE liveness to network availability. We cache the License
// at server start and refresh it in the background every 60 s.

const LICENSE_REFRESH_INTERVAL_MS = 60_000;
let _cachedLicense: License | null = null;
let _licenseRefreshTimer: NodeJS.Timeout | null = null;

/**
 * Load the license once and start the 60 s refresh loop. Idempotent —
 * second call is a no-op. Also runs pollForActivation() so a trial install
 * gets promoted to pro on the first dashboard launch after checkout.
 */
export async function primeLicenseCache(): Promise<License> {
  if (_cachedLicense) {
    return _cachedLicense;
  }

  const initial = await loadLicense();
  _cachedLicense = await pollForActivation(initial);

  if (!_licenseRefreshTimer) {
    _licenseRefreshTimer = setInterval(() => {
      void (async () => {
        try {
          _cachedLicense = await loadLicense();
        } catch {
          /* keep last-known-good */
        }
      })();
    }, LICENSE_REFRESH_INTERVAL_MS);
    _licenseRefreshTimer.unref?.();
  }

  return _cachedLicense;
}

/** Synchronously read whatever the cache currently holds. */
export function getCachedLicense(): License | null {
  return _cachedLicense;
}

/** Stop the refresh timer and forget the cached license. Test-only. */
export function clearLicenseCacheForTesting(): void {
  if (_licenseRefreshTimer) {
    clearInterval(_licenseRefreshTimer);
    _licenseRefreshTimer = null;
  }
  _cachedLicense = null;
}

// ── .env reader ───────────────────────────────────────────────────────────────

/**
 * Parse the repo-root .env file and return a key → value map.
 * Never throws. Ignores comments and blank lines.
 */
export function readEnvConfig(): Record<string, string> {
  try {
    const raw = readFileSync(getEnvFile(), "utf-8");
    const out: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      const eq = trimmed.indexOf("=");
      if (eq === -1) {
        continue;
      }
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
      if (key) {
        out[key] = val;
      }
    }
    return out;
  } catch {
    return {};
  }
}

// ── .env writer ───────────────────────────────────────────────────────────────

/**
 * Write or update a single key in the repo-root .env file.
 * Preserves all other lines. Creates the file if absent. Never throws.
 * Returns true on success, false on I/O error.
 */
export function writeEnvVar(key: string, value: string): boolean {
  try {
    let existing = "";
    try {
      existing = readFileSync(getEnvFile(), "utf-8");
    } catch {
      /* new file */
    }

    const prefix = `${key}=`;
    let found = false;
    const lines = existing.split("\n").map((line) => {
      if (line.startsWith(prefix)) {
        found = true;
        return `${key}=${value}`;
      }
      return line;
    });
    if (!found) {
      lines.push(`${key}=${value}`);
    }
    writeFileSync(getEnvFile(), lines.join("\n").replace(/\n+$/, "") + "\n", "utf-8");
    return true;
  } catch {
    return false;
  }
}

// ── Telegram bot username (lazy, cached) ──────────────────────────────────────

let _telegramUsername: string | null | undefined = undefined; // undefined = not yet fetched

async function resolveTelegramUsername(token: string): Promise<string | null> {
  if (_telegramUsername !== undefined) {
    return _telegramUsername;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      _telegramUsername = null;
      return null;
    }
    const data = (await res.json()) as { ok: boolean; result?: { username?: string } };
    _telegramUsername = data.ok ? (data.result?.username ?? null) : null;
  } catch {
    _telegramUsername = null;
  }
  return _telegramUsername;
}

/** Force re-fetch on next request (for testing). */
export function resetTelegramCacheForTesting(): void {
  _telegramUsername = undefined;
}

// ── Channel links ─────────────────────────────────────────────────────────────

export interface ChannelLink {
  name: string; // "Telegram" | "WhatsApp" | "Signal"
  url: string; // deep-link URL
  icon: string; // emoji
}

/**
 * Build deep-links for every configured messaging channel.
 * Telegram requires an API call to resolve the bot username; the others are
 * derived directly from .env values.
 *
 * Returns an empty array when no channels are configured.
 */
export async function resolveChannelLinks(): Promise<ChannelLink[]> {
  const env = readEnvConfig();
  const links: ChannelLink[] = [];

  const tgToken = env["TELEGRAM_BOT_TOKEN"];
  if (tgToken) {
    const username = await resolveTelegramUsername(tgToken);
    links.push({
      name: "Telegram",
      url: username ? `https://t.me/${username}` : "https://t.me/",
      icon: "✈️",
    });
  }

  // WhatsApp: stored as WHATSAPP_PHONE (e164 format, no +)
  const waPhone = env["WHATSAPP_PHONE"];
  if (waPhone) {
    links.push({ name: "WhatsApp", url: `https://wa.me/${waPhone}`, icon: "💬" });
  }

  return links;
}

// ── Audit log reader ──────────────────────────────────────────────────────────

function auditLogPath(): string {
  return join(homedir(), ".armorclaw", "audit.log");
}

/**
 * Read the most recent `limit` entries from the audit log, newest-first.
 * Never throws — returns [] on any I/O or parse error.
 */
/** Internal skills/operations that should not appear in the user-facing activity feed. */
const INTERNAL_SKILLS = new Set(["gateway-config", "platform-check", "registry", "token-rotation"]);

export function readRecentAuditEntries(limit = 20, includeInternal = false): AuditEntry[] {
  try {
    const raw = readFileSync(auditLogPath(), "utf-8");
    const entries: AuditEntry[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      try {
        const entry = JSON.parse(line) as AuditEntry;
        // Filter out internal operations from the user-facing feed
        if (!includeInternal && entry.skill && INTERNAL_SKILLS.has(entry.skill)) {
          continue;
        }
        entries.push(entry);
      } catch {
        /* skip malformed lines */
      }
    }
    return entries.slice(-limit).toReversed();
  } catch {
    return [];
  }
}

// ── Security stats ────────────────────────────────────────────────────────────

export interface SecurityStats {
  /** Injection filter is always active in ArmorClaw. */
  injectionFilterActive: boolean;
  /** Rejected entries in the audit log for today (UTC date). */
  rejectionsToday: number;
  /**
   * Rejection counts per day for the last 7 days, oldest→newest.
   * Index 0 = 6 days ago, index 6 = today.
   */
  sparkline7d: number[];
  /** Gateway bind address — always 127.0.0.1 in ArmorClaw. */
  gatewayHost: string;
}

/**
 * Compute security stats from the full audit log.
 * Reads all entries (not capped at 20) to build the 7-day sparkline.
 * Never throws — returns safe defaults on any I/O error.
 */
export function getSecurityStats(): SecurityStats {
  try {
    const raw = readFileSync(auditLogPath(), "utf-8");
    const entries: AuditEntry[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      try {
        entries.push(JSON.parse(line) as AuditEntry);
      } catch {
        /* skip */
      }
    }

    const now = new Date();
    const dayKey = (d: Date) => d.toISOString().slice(0, 10);

    const sparkline7d = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() - (6 - i));
      const key = dayKey(d);
      return entries.filter(
        (e) =>
          e.outcome === "rejected" &&
          typeof e.timestamp === "string" &&
          e.timestamp.slice(0, 10) === key,
      ).length;
    });

    return {
      injectionFilterActive: true,
      rejectionsToday: sparkline7d[6],
      sparkline7d,
      gatewayHost: "127.0.0.1",
    };
  } catch {
    return {
      injectionFilterActive: true,
      rejectionsToday: 0,
      sparkline7d: [0, 0, 0, 0, 0, 0, 0],
      gatewayHost: "127.0.0.1",
    };
  }
}

// AgentStatus, getAgentStatus, setAgentStatus — imported from ../lib/agent-status.ts
// Re-export so existing callers of server.ts don't need to change import paths.
export type { AgentStatus };
export { getAgentStatus, setAgentStatus };

// ── Gateway reachability ──────────────────────────────────────────────────────

const GATEWAY_PORT = 18789;

/**
 * Quick probe of the OpenClaw gateway WebSocket port.
 * Returns true if the port accepts a TCP connection within 2 seconds.
 */
async function checkGatewayReachable(): Promise<boolean> {
  const { createConnection } = await import("node:net");
  return new Promise((resolve) => {
    const sock = createConnection({ host: "127.0.0.1", port: GATEWAY_PORT, timeout: 2000 }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.on("error", () => resolve(false));
    sock.on("timeout", () => {
      sock.destroy();
      resolve(false);
    });
  });
}

// ── Pending approvals ─────────────────────────────────────────────────────────
//
// Source: in-process security/permissions.ts approval queue (ArmorClaw's own
// permission engine, runs as an OpenClaw plugin).
//
// Gateway-side exec approvals (exec.approval.request/resolve) are NOT polled
// here. The gateway has no "list pending" RPC — pending approvals arrive as
// exec.approval.requested events pushed to connected operator clients. That
// requires a persistent WebSocket subscription, not a short-lived poll.
// TODO(post-v1): maintain a persistent gateway WS and listen for
//   exec.approval.requested / exec.approval.resolved events; merge with
//   local approvals here.

export interface PendingApproval {
  id: string;
  skill: string;
  displayName: string;
  requestedAt: string;
  /** "local" = in-process permission engine, "gateway" = OpenClaw gateway */
  source: "local" | "gateway";
}

/**
 * Get pending approvals from the in-process permission engine.
 *
 * Gateway-level exec approvals (exec.approval.request/resolve) are not
 * included here — the gateway pushes them as events to persistent operator
 * WebSocket connections; there is no "list pending" query RPC.
 * See TODO in the section comment above for the post-v1 path.
 */
export async function getPendingApprovals(): Promise<ReadonlyArray<PendingApproval>> {
  const skills = getAllSkills();
  const nameMap = new Map(skills.map((s) => [s.skillId, s.displayName]));

  const rawApprovals = getPermissionPendingApprovals();
  return rawApprovals.map((a: PendingToolApproval) => ({
    id: a.id,
    skill: a.toolName,
    displayName: nameMap.get(a.skillId ?? "") ?? humaniseToolName(a.toolName),
    requestedAt: a.timestamp,
    source: "local" as const,
  }));
}

/** Convert a raw tool name to something readable: "read_email" → "Read email" */
function humaniseToolName(raw: string): string {
  return raw
    .replace(/[-_]/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/, (c) => c.toUpperCase());
}

// ── SSE listener registry ─────────────────────────────────────────────────────

type Listener = () => void;
const listeners = new Set<Listener>();

export function onDashboardChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function notifyListeners(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* never crash on listener error */
    }
  }
}

// ── Dashboard snapshot ────────────────────────────────────────────────────────

export interface DashboardSnapshot {
  agentStatus: AgentStatus;
  /** Whether the OpenClaw gateway WebSocket on port 18789 is reachable. */
  gatewayReachable: boolean;
  config: {
    modelProvider: string | null;
    isLocal: boolean;
    activeProvider: string | null;
    ollamaReachable: boolean;
    ollamaModels: string[];
    sandboxDir: string | null;
  };
  channels: ChannelLink[];
  // TOKEN BURN: wired to token-tracker/store.ts — returns zeros until real
  // TokenEvents are recorded by the model adapter (not yet built).
  budget: ReturnType<typeof getBudgetStatus>;
  monthTokens: ReturnType<typeof getMonthTokens>;
  undo: { id: string; actionType: string; skill: string; expiresAt: string } | null;
  pendingApprovals: PendingApproval[];
  feed: AuditEntry[];
  skills: ReturnType<typeof getAllSkills>;
  recipes: RecipeWithState[];
  connectedServices: {
    gmail: boolean;
    outlook: boolean;
  };
  /** Tailscale HTTPS URL for this device, or null if Tailscale is not active. */
  tailscaleUrl: string | null;
  /**
   * Stripe Customer Portal URL for subscription management.
   * Null when STRIPE_CUSTOMER_PORTAL_URL is not set — hides the subscription
   * card in Settings so customers aren't shown a broken link.
   */
  stripeCustomerPortalUrl: string | null;
  /**
   * License snapshot used by the trial banner and expired overlay.
   * Read from the in-process cache — refreshed every 60 s, never awaited
   * on the SSE hot path.
   */
  license: {
    tier: string;
    installId: string;
    valid: boolean;
  };
  security: SecurityStats;
  tokenBurn: {
    todayTokens: ReturnType<typeof getTodayTokens>;
    monthBySkill: Record<string, number>;
    /** 30-day daily history, oldest→newest. */
    dailyHistory30: DailyTotal[];
    /** Last 50 token events, newest-first. */
    recentEvents: TokenEvent[];
  };
  serverTime: string;
}

/** Cached channel links — resolved once per server lifetime to avoid API spam. */
let _channelLinksCache: ChannelLink[] | null = null;

/**
 * Build the license sub-snapshot from the cached License. Returns a safe
 * default when the cache hasn't been primed yet.
 */
function licenseSnapshot(): DashboardSnapshot["license"] {
  const lic = getCachedLicense();
  if (!lic) {
    return { tier: "inactive", installId: "", valid: false };
  }
  return {
    tier: lic.tier,
    installId: lic.installId,
    valid: lic.valid,
  };
}

export async function getDashboardSnapshot(): Promise<DashboardSnapshot> {
  const env = readEnvConfig();

  // Resolve channel links once and cache
  if (_channelLinksCache === null) {
    _channelLinksCache = await resolveChannelLinks();
  }

  const undo = getCurrentUndo();
  const gatewayReachable = await checkGatewayReachable();
  return {
    agentStatus: getAgentStatus(),
    gatewayReachable,
    config: {
      modelProvider: env["ARMORCLAW_MODEL_PROVIDER"] ?? null,
      ...(() => {
        const ms = getModelAdapterState();
        return {
          isLocal: ms.isLocal,
          activeProvider: ms.active,
          ollamaReachable: ms.ollamaReachable,
          ollamaModels: ms.ollamaModels,
        };
      })(),
      sandboxDir: env["ARMORCLAW_SANDBOX_DIR"] ?? null,
    },
    channels: _channelLinksCache,
    budget: getBudgetStatus(),
    monthTokens: getMonthTokens(),
    undo: undo
      ? { id: undo.id, actionType: undo.actionType, skill: undo.skill, expiresAt: undo.expiresAt }
      : null,
    pendingApprovals: (await getPendingApprovals()) as PendingApproval[],
    feed: readRecentAuditEntries(20),
    skills: getAllSkills(),
    recipes: getAllRecipes(),
    connectedServices: {
      gmail: Boolean(env["ARMORCLAW_GMAIL_CONNECTED"]),
      outlook: false,
    },
    tailscaleUrl: getTailscaleUrl(),
    stripeCustomerPortalUrl: env["STRIPE_CUSTOMER_PORTAL_URL"] ?? null,
    license: licenseSnapshot(),
    security: getSecurityStats(),
    tokenBurn: {
      todayTokens: getTodayTokens(),
      monthBySkill: getMonthBySkill(),
      dailyHistory30: getDailyHistory(30),
      recentEvents: getRecentEvents(50),
    },
    serverTime: new Date().toISOString(),
  };
}

// ── Bundled skill status ──────────────────────────────────────────────────────

export interface BundledSkillStatus {
  id: string;
  displayName: string;
  description: string;
  version: string;
  status: "active" | "not_configured";
  missingConfig?: string;
}

/**
 * Check config readiness for all three bundled skills.
 * Uses the parsed .env map — never reads secrets into output.
 */
export function getBundledSkillStatuses(env: Record<string, string>): BundledSkillStatus[] {
  const emailActive = Boolean(env["ARMORCLAW_GMAIL_CONNECTED"]);

  return [
    {
      id: "email-calendar",
      displayName: "Email + calendar",
      description: "Inbox triage, draft replies, and calendar management for Gmail and Outlook.",
      version: "1.0.0",
      ...(emailActive
        ? { status: "active" as const }
        : {
            status: "not_configured" as const,
            missingConfig: "Connect Gmail or Outlook in Settings to activate",
          }),
    },
    {
      id: "secure-files",
      displayName: "Secure file access",
      description: "Read, write, and watch files within your sandbox directory — never outside it.",
      version: "1.0.0",
      status: "active",
    },
    {
      id: "browser",
      displayName: "Browser automation",
      description:
        "Fill forms, extract data, and capture screenshots in a dedicated, sandboxed browser profile.",
      version: "1.0.0",
      status: "active",
    },
  ];
}

// ── Skills config (~/Library/Application Support/armorclaw-launcher/skills.json) ──

export interface InstalledSkillEntry {
  id: string;
  name: string;
  description: string;
  capabilities: string[];
  source: "clawhub" | "github";
  sourceUrl: string;
  enabled: boolean;
  installedAt: string;
}

export interface SkillsConfig {
  installed: InstalledSkillEntry[];
}

function skillsConfigPath(): string {
  return join(getLauncherDataPath(), "skills.json");
}

export function readSkillsConfig(): SkillsConfig {
  try {
    const raw = readFileSync(skillsConfigPath(), "utf-8");
    const parsed = JSON.parse(raw) as SkillsConfig;
    if (!Array.isArray(parsed.installed)) {
      return { installed: [] };
    }
    return parsed;
  } catch {
    return { installed: [] };
  }
}

export function writeSkillsConfig(config: SkillsConfig): void {
  mkdirSync(getLauncherDataPath(), { recursive: true });
  writeFileSync(skillsConfigPath(), JSON.stringify(config, null, 2) + "\n", "utf-8");
}

// ── Channels config (~/Library/Application Support/armorclaw-launcher/channels.json) ──

export interface ChannelsConfig {
  channels: Record<
    string,
    {
      enabled: boolean;
      token?: string;
      allowFrom?: string[];
    }
  >;
}

function channelsConfigPath(): string {
  return join(getLauncherDataPath(), "channels.json");
}

export function readChannelsConfig(): ChannelsConfig {
  try {
    const raw = readFileSync(channelsConfigPath(), "utf-8");
    const parsed = JSON.parse(raw) as ChannelsConfig;
    if (!parsed.channels || typeof parsed.channels !== "object") {
      return { channels: {} };
    }
    return parsed;
  } catch {
    return { channels: {} };
  }
}

export function writeChannelsConfig(config: ChannelsConfig): void {
  mkdirSync(getLauncherDataPath(), { recursive: true });
  writeFileSync(channelsConfigPath(), JSON.stringify(config, null, 2) + "\n", "utf-8");
}

/**
 * Validate a Telegram bot token by calling the getMe API endpoint.
 * Returns the bot username on success, or null on failure.
 */
export async function validateTelegramToken(
  token: string,
): Promise<{ ok: boolean; username?: string; error?: string }> {
  if (!token || typeof token !== "string" || !token.trim()) {
    return { ok: false, error: "Token is required" };
  }
  const trimmed = token.trim();
  // Basic format check: Telegram tokens look like 123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(trimmed)) {
    return {
      ok: false,
      error: "Token format is invalid. It should look like 123456789:ABCdefGHIjklMNOpqrsTUVwxyz",
    };
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${trimmed}/getMe`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return {
        ok: false,
        error:
          "Telegram rejected this token. Double-check you copied the whole thing from BotFather.",
      };
    }
    const data = (await res.json()) as { ok: boolean; result?: { username?: string } };
    if (data.ok && data.result?.username) {
      return { ok: true, username: data.result.username };
    }
    return { ok: false, error: "Token was accepted but no bot username was returned." };
  } catch {
    return {
      ok: false,
      error: "Could not reach Telegram servers. Check your internet connection.",
    };
  }
}

/** Channel type definition for the Channels view. */
export interface ChannelType {
  id: string;
  name: string;
  description: string;
  icon: string;
  status: "active" | "not_configured" | "error";
  configurable: boolean;
}

/**
 * Build the list of supported channel types with their current status.
 */
export function getChannelTypes(): ChannelType[] {
  const config = readChannelsConfig();
  const tg = config.channels["telegram"];
  let tgStatus: ChannelType["status"] = "not_configured";
  if (tg?.enabled && tg.token) {
    tgStatus = "active";
  }

  return [
    {
      id: "telegram",
      name: "Telegram",
      description:
        "Message your agent from Telegram. Create a bot via BotFather and connect it here.",
      icon: "✈️",
      status: tgStatus,
      configurable: true,
    },
  ];
}

// ── Express app ───────────────────────────────────────────────────────────────

export function createApp(): express.Application {
  const app = express();
  app.use(express.json());

  // ── Client-side module shim ──
  // Serves constants and utils from the canonical TS modules as a single JS
  // file. Uses JSON.stringify for data and Function.toString() for helpers,
  // so the TS source remains the single source of truth (no build step).
  let _dashLibCache: string | null = null;
  app.get("/dashboard-lib.js", (_req, res) => {
    if (!_dashLibCache) {
      const constLines = Object.entries(DashConstants).map(
        ([k, v]) => `var ${k}=${JSON.stringify(v)};`,
      );
      const fnLines = Object.entries(DashUtils).map(
        ([k, fn]) => `var ${k}=${(fn as Function).toString()};`,
      );
      const stateLines = Object.entries(DashState.INITIAL_STATE).map(
        ([k, v]) => `var ${k}=${JSON.stringify(v)};`,
      );
      const navLines = Object.entries(DashNav).map(
        ([k, fn]) => `var ${k}=${(fn as Function).toString()};`,
      );
      _dashLibCache = constLines.concat(fnLines, stateLines, navLines).join("\n");
    }
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.send(_dashLibCache);
  });

  // Push SSE updates when the permission engine queues a new approval
  onApprovalChange(() => notifyListeners());

  // Start background OpenClaw version polling (every 6 hours)
  startVersionCheckInterval();

  // Serve static files from public/ (favicon, etc.)
  const publicDir = join(import.meta.dirname, "public");
  app.use(express.static(publicDir));

  app.get("/", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(readFileSync(DASHBOARD_HTML, "utf8"));
  });

  app.get("/api/dashboard", async (_req, res) => {
    res.json(await getDashboardSnapshot());
  });

  // SSE — pushes on state change and every 5 s
  app.get("/api/events", async (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const send = async (): Promise<void> => {
      try {
        res.write(`data: ${JSON.stringify(await getDashboardSnapshot())}\n\n`);
      } catch {
        /* client disconnected */
      }
    };

    await send();
    const poll = setInterval(() => void send(), 5_000);
    const keepalive = setInterval(() => res.write(": ping\n\n"), 15_000);
    const unsub = onDashboardChange(() => void send());

    req.on("close", () => {
      clearInterval(poll);
      clearInterval(keepalive);
      unsub();
    });
  });

  app.post("/api/undo", async (_req, res) => {
    const executed = await executeUndo();
    if (executed) {
      notifyListeners();
    }
    res.json({ ok: executed });
  });

  // ── Approval endpoints ──
  app.post("/api/approvals/:id/approve", (req, res) => {
    const resolved = resolveApproval(req.params["id"], true);
    if (resolved) {
      notifyListeners();
    }
    res.json({ ok: resolved });
  });

  app.post("/api/approvals/:id/reject", (req, res) => {
    const resolved = resolveApproval(req.params["id"], false);
    if (resolved) {
      notifyListeners();
    }
    res.json({ ok: resolved });
  });

  app.post("/api/agent/pause", (_req, res) => {
    setAgentStatus("paused");
    notifyListeners();
    res.json({ ok: true });
  });

  app.post("/api/agent/resume", (_req, res) => {
    setAgentStatus("running");
    notifyListeners();
    res.json({ ok: true });
  });

  app.post("/api/budget", (req, res) => {
    const { monthlyBudgetUSD } = req.body as { monthlyBudgetUSD?: unknown };
    if (typeof monthlyBudgetUSD !== "number" || monthlyBudgetUSD <= 0) {
      res.status(422).json({ ok: false, message: "Budget must be a positive number" });
      return;
    }
    try {
      setBudgetMonthlyUSD(monthlyBudgetUSD);
    } catch (err) {
      res.status(422).json({ ok: false, message: String(err) });
      return;
    }
    notifyListeners();
    res.json({ ok: true });
  });

  app.post("/api/budget/resume", (_req, res) => {
    resumeFromHardStop();
    notifyListeners();
    res.json({ ok: true });
  });

  // ── Token tracking: record usage from gateway chat ──
  // The gateway handles model calls directly; this endpoint lets the chat UI
  // report token usage after each chat.final so ArmorClaw's budget tracker
  // and cost display stay accurate.
  app.post("/api/tokens/record", (req, res) => {
    const body = req.body as {
      provider?: string;
      model?: string;
      skill?: string;
      inputTokens?: number;
      outputTokens?: number;
    };
    const provider = (body.provider ?? "anthropic") as Provider;
    const model = body.model ?? "unknown";
    const skill = body.skill ?? "chat";
    const inputTokens = typeof body.inputTokens === "number" ? body.inputTokens : 0;
    const outputTokens = typeof body.outputTokens === "number" ? body.outputTokens : 0;

    if (inputTokens === 0 && outputTokens === 0) {
      res.json({ ok: true, recorded: false });
      return;
    }

    const estimatedCostUSD = calculateCost(provider, model, inputTokens, outputTokens);

    const event: TokenEvent = {
      timestamp: new Date().toISOString(),
      provider,
      model,
      skill,
      inputTokens,
      outputTokens,
      estimatedCostUSD,
    };

    // Fire-and-forget — never block the response on token tracking
    void recordTokenEvent(event);
    notifyListeners();
    res.json({ ok: true, recorded: true, estimatedCostUSD });
  });

  // ── Settings: model provider ──
  app.post("/api/settings/provider", (req, res) => {
    const { provider, apiKey } = req.body as { provider?: string; apiKey?: string };
    const validProviders = new Set(["anthropic", "openai", "ollama"]);
    if (!provider || !validProviders.has(provider)) {
      res.status(422).json({ ok: false, message: "provider must be anthropic, openai, or ollama" });
      return;
    }
    writeEnvVar("ARMORCLAW_MODEL_PROVIDER", provider);
    if (apiKey && apiKey.trim()) {
      const keyName =
        provider === "anthropic"
          ? "ANTHROPIC_API_KEY"
          : provider === "openai"
            ? "OPENAI_API_KEY"
            : "OLLAMA_BASE_URL";
      writeEnvVar(keyName, apiKey.trim());
    }
    notifyListeners();
    res.json({ ok: true });
  });

  // ── Settings: Ollama status ──
  app.get("/api/settings/ollama-status", async (_req, res) => {
    const state = getModelAdapterState();
    res.json({
      reachable: state.ollamaReachable,
      models: state.ollamaModels,
      isActive: state.active === "ollama",
      isLocal: state.isLocal,
    });
  });

  // ── Settings: sandbox directory ──
  app.post("/api/settings/sandbox", (req, res) => {
    const { path: sandboxPath } = req.body as { path?: string };
    if (!sandboxPath || !sandboxPath.trim().startsWith("/")) {
      res.status(422).json({ ok: false, message: "path must be an absolute path" });
      return;
    }
    writeEnvVar("ARMORCLAW_SANDBOX_DIR", sandboxPath.trim());
    notifyListeners();
    res.json({ ok: true });
  });

  // ── Settings: launch on startup ──
  app.get("/api/settings/launch-on-startup", (_req, res) => {
    const env = readEnvConfig();
    // Default is enabled unless explicitly set to "false"
    const enabled = env["ARMORCLAW_LAUNCH_ON_STARTUP"] !== "false";
    res.json({ enabled });
  });

  app.post("/api/settings/launch-on-startup", (req, res) => {
    const { enabled } = req.body as { enabled?: boolean };
    if (typeof enabled !== "boolean") {
      res.status(422).json({ ok: false, message: "enabled must be a boolean" });
      return;
    }
    writeEnvVar("ARMORCLAW_LAUNCH_ON_STARTUP", enabled ? "true" : "false");
    // The Electron app reads this on next launch via configureLoginItem()
    notifyListeners();
    res.json({ ok: true, enabled });
  });

  // ── Memory ──
  app.get("/api/memory", (_req, res) => {
    const memPath = join(homedir(), ".armorclaw", "memory.md");
    try {
      const content = existsSync(memPath) ? readFileSync(memPath, "utf-8") : "";
      res.json({ ok: true, content, path: memPath });
    } catch {
      res.json({ ok: true, content: "", path: memPath });
    }
  });

  app.post("/api/memory/clear", (_req, res) => {
    const memPath = join(homedir(), ".armorclaw", "memory.md");
    try {
      const header =
        "# ArmorClaw Memory\n\nThings I know about you. You can edit this file directly.\n\n";
      writeFileSync(memPath, header, "utf-8");
      res.json({ ok: true });
    } catch (err) {
      res
        .status(500)
        .json({ ok: false, message: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/memory/open", (_req, res) => {
    const memPath = join(homedir(), ".armorclaw", "memory.md");
    try {
      const cmd =
        process.platform === "darwin"
          ? `open "${memPath}"`
          : process.platform === "win32"
            ? `start "" "${memPath}"`
            : `xdg-open "${memPath}"`;
      execSync(cmd, { stdio: "ignore", timeout: 5000 });
      res.json({ ok: true });
    } catch {
      res.status(500).json({ ok: false, message: "Could not open the memory file." });
    }
  });

  // ── Vector memory status ──
  app.get("/api/memory/vector-status", async (_req, res) => {
    const repoRoot = process.env["ARMORCLAW_REPO_ROOT"];
    const nodeBin = process.env["ARMORCLAW_NODE_PATH"];
    if (!repoRoot || !nodeBin) {
      res.json({ ok: true, available: false, status: "Not configured" });
      return;
    }
    try {
      const output = execSync(`"${nodeBin}" "${join(repoRoot, "openclaw.mjs")}" memory status`, {
        encoding: "utf-8",
        timeout: 10_000,
        cwd: repoRoot,
      });
      res.json({ ok: true, available: true, status: output.trim() });
    } catch (err) {
      const msg =
        err instanceof Error
          ? ((err as { stderr?: string }).stderr?.trim() ?? err.message)
          : String(err);
      res.json({ ok: true, available: false, status: msg });
    }
  });

  app.post("/api/memory/reindex", async (_req, res) => {
    const repoRoot = process.env["ARMORCLAW_REPO_ROOT"];
    const nodeBin = process.env["ARMORCLAW_NODE_PATH"];
    if (!repoRoot || !nodeBin) {
      res.status(500).json({ ok: false, message: "Not configured" });
      return;
    }
    try {
      const output = execSync(`"${nodeBin}" "${join(repoRoot, "openclaw.mjs")}" memory index`, {
        encoding: "utf-8",
        timeout: 60_000,
        cwd: repoRoot,
      });
      res.json({ ok: true, output: output.trim() });
    } catch (err) {
      const msg =
        err instanceof Error
          ? ((err as { stderr?: string }).stderr?.trim() ?? err.message)
          : String(err);
      res.status(500).json({ ok: false, message: msg });
    }
  });

  // ── Audit log CSV export ──
  app.get("/api/audit/export.csv", (_req, res) => {
    const entries = readRecentAuditEntries(10_000, true); // include internal entries in export
    const header = "timestamp,skill,outcome,durationMs,permissionsUsed\n";
    const rows = entries
      .map((e) =>
        [
          e.timestamp ?? "",
          (e.skill ?? "").replace(/,/g, " "),
          e.outcome ?? "",
          String(e.durationMs ?? 0),
          (e.permissionsUsed ?? []).join("|"),
        ].join(","),
      )
      .join("\n");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="armorclaw-audit-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    res.send(header + rows);
  });

  // ── Skills: analyze from GitHub URL ──
  app.post("/api/skills/analyze-url", async (req, res) => {
    const { url } = req.body as { url?: unknown };
    if (typeof url !== "string" || !url.trim()) {
      res.status(422).json({ ok: false, message: "url is required" });
      return;
    }
    if (!isValidGitHubUrl(url.trim())) {
      res.status(422).json({ ok: false, message: "URL must be a GitHub or GitHub Gist HTTPS URL" });
      return;
    }
    try {
      const { code, filename } = await fetchSkillSource(url.trim());
      const report = verifySkillSource(code);
      res.json({ ok: true, report, code, filename });
    } catch (err) {
      res
        .status(422)
        .json({ ok: false, message: String(err instanceof Error ? err.message : err) });
    }
  });

  // ── Skills: analyze from uploaded file ──
  app.post("/api/skills/analyze-file", (req, res) => {
    const { content, filename } = req.body as { content?: unknown; filename?: unknown };
    if (typeof content !== "string" || !content.trim()) {
      res.status(422).json({ ok: false, message: "content (base64) is required" });
      return;
    }
    if (typeof filename !== "string" || !filename.trim()) {
      res.status(422).json({ ok: false, message: "filename is required" });
      return;
    }
    try {
      const safe = sanitizeFilename(filename.trim());
      const code = Buffer.from(content.trim(), "base64").toString("utf-8");
      const report = verifySkillSource(code);
      res.json({ ok: true, report, code, filename: safe });
    } catch (err) {
      res
        .status(422)
        .json({ ok: false, message: String(err instanceof Error ? err.message : err) });
    }
  });

  // ── Skills: install (re-verifies server-side) ──
  app.post("/api/skills/install", (req, res) => {
    const { code, filename } = req.body as { code?: unknown; filename?: unknown };
    if (typeof code !== "string" || !code) {
      res.status(422).json({ ok: false, message: "code is required" });
      return;
    }
    if (typeof filename !== "string" || !filename) {
      res.status(422).json({ ok: false, message: "filename is required" });
      return;
    }
    const report = verifySkillSource(code);
    if (!report.safe) {
      res.status(403).json({
        ok: false,
        message: "Skill contains dangerous patterns and cannot be installed without override",
        report,
      });
      return;
    }
    try {
      const dest = installSkill(code, filename);
      notifyListeners();
      res.json({ ok: true, dest });
    } catch (err) {
      res
        .status(422)
        .json({ ok: false, message: String(err instanceof Error ? err.message : err) });
    }
  });

  // ── Skills: bundled skill status ──
  app.get("/api/skills/bundled", (_req, res) => {
    const env = readEnvConfig();
    res.json(getBundledSkillStatuses(env));
  });

  // ── Skills: installed skills (from skills.json) ──
  app.get("/api/skills/installed", (_req, res) => {
    const config = readSkillsConfig();
    res.json({ ok: true, skills: config.installed });
  });

  // ── Skills: install from GitHub URL (with CONFIRM gate) ──
  app.post("/api/skills/github/install", async (req, res) => {
    const { url, confirm } = req.body as { url?: unknown; confirm?: unknown };
    if (typeof url !== "string" || !url.trim()) {
      res.status(422).json({ ok: false, message: "url is required" });
      return;
    }
    if (confirm !== "CONFIRM") {
      res.status(422).json({ ok: false, message: "You must type CONFIRM to install from GitHub" });
      return;
    }
    if (!isValidGitHubUrl(url.trim())) {
      res.status(422).json({ ok: false, message: "URL must be a GitHub HTTPS URL" });
      return;
    }
    try {
      const { code, filename } = await fetchSkillSource(url.trim());
      const report = verifySkillSource(code);
      if (!report.safe) {
        res.status(403).json({ ok: false, message: "Skill contains dangerous patterns", report });
        return;
      }
      const dest = installSkill(code, filename);
      // Also track in skills.json
      const config = readSkillsConfig();
      const id = filename.replace(/\.(ts|js)$/, "");
      if (!config.installed.some((i) => i.id === id)) {
        config.installed.push({
          id,
          name: filename,
          description: `Installed from GitHub: ${url.trim()}`,
          capabilities: report.permissionsFound,
          source: "github",
          sourceUrl: url.trim(),
          enabled: true,
          installedAt: new Date().toISOString(),
        });
        writeSkillsConfig(config);
      }
      notifyListeners();
      res.json({ ok: true, dest, report });
    } catch (err) {
      res
        .status(422)
        .json({ ok: false, message: String(err instanceof Error ? err.message : err) });
    }
  });

  // ── Skills: toggle enable/disable ──
  app.post("/api/skills/installed/:id/toggle", (req, res) => {
    const { id } = req.params;
    const config = readSkillsConfig();
    const skill = config.installed.find((s) => s.id === id);
    if (!skill) {
      res.status(404).json({ ok: false, message: "Skill not found" });
      return;
    }
    skill.enabled = !skill.enabled;
    try {
      writeSkillsConfig(config);
      notifyListeners();
      res.json({ ok: true, enabled: skill.enabled });
    } catch (err) {
      res
        .status(500)
        .json({ ok: false, message: String(err instanceof Error ? err.message : err) });
    }
  });

  // ── Skills: remove installed skill ──
  app.post("/api/skills/installed/:id/remove", (req, res) => {
    const { id } = req.params;
    const config = readSkillsConfig();
    const idx = config.installed.findIndex((s) => s.id === id);
    if (idx === -1) {
      res.status(404).json({ ok: false, message: "Skill not found" });
      return;
    }
    config.installed.splice(idx, 1);
    try {
      writeSkillsConfig(config);
      notifyListeners();
      res.json({ ok: true });
    } catch (err) {
      res
        .status(500)
        .json({ ok: false, message: String(err instanceof Error ? err.message : err) });
    }
  });

  // ── Recipes ──
  app.post("/api/recipes/:id/activate", (req, res) => {
    const { id } = req.params;
    try {
      activateRecipe(id);
      notifyListeners();
      res.json({ ok: true });
    } catch (err) {
      res
        .status(422)
        .json({ ok: false, message: String(err instanceof Error ? err.message : err) });
    }
  });

  app.post("/api/recipes/:id/deactivate", (req, res) => {
    const { id } = req.params;
    try {
      deactivateRecipe(id);
      notifyListeners();
      res.json({ ok: true });
    } catch (err) {
      res
        .status(422)
        .json({ ok: false, message: String(err instanceof Error ? err.message : err) });
    }
  });

  app.post("/api/recipes/:id/schedule", (req, res) => {
    const { id } = req.params;
    const { cron } = req.body as { cron?: unknown };
    if (typeof cron !== "string" || !cron.trim()) {
      res.status(422).json({ ok: false, message: "cron expression is required" });
      return;
    }
    try {
      updateSchedule(id, cron.trim());
      notifyListeners();
      res.json({ ok: true });
    } catch (err) {
      res
        .status(422)
        .json({ ok: false, message: String(err instanceof Error ? err.message : err) });
    }
  });

  // ── Danger zone: reset ArmorClaw data ──
  app.post("/api/reset", (req, res) => {
    const { confirm } = req.body as { confirm?: string };
    if (confirm !== "reset") {
      res.status(422).json({ ok: false, message: 'Type "reset" to confirm' });
      return;
    }
    const dir = join(homedir(), ".armorclaw");
    let deleted = 0;
    for (const file of ["audit.log", "tokens.ndjson"]) {
      try {
        unlinkSync(join(dir, file));
        deleted++;
      } catch {
        /* absent — ok */
      }
    }
    res.json({ ok: true, deleted });
  });

  // ── Advanced settings: read-only OpenClaw config ──
  app.get("/api/advanced/config", (_req, res) => {
    try {
      const configPath = join(homedir(), ".openclaw", "openclaw.json");
      const raw = readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      // Strip sensitive fields before sending to the dashboard
      const safe = { ...parsed };
      if (safe["gateway"] && typeof safe["gateway"] === "object") {
        const gw = { ...(safe["gateway"] as Record<string, unknown>) };
        if (gw["auth"] && typeof gw["auth"] === "object") {
          const auth = { ...(gw["auth"] as Record<string, unknown>) };
          if (auth["token"]) {
            auth["token"] = "••••••••";
          }
          if (auth["password"]) {
            auth["password"] = "••••••••";
          }
          gw["auth"] = auth;
        }
        safe["gateway"] = gw;
      }
      res.json({ ok: true, config: safe, path: configPath });
    } catch {
      res.json({ ok: true, config: {}, path: join(homedir(), ".openclaw", "openclaw.json") });
    }
  });

  // ── Chat: gateway config for WebSocket connection ──
  //
  // Returns the gateway WebSocket URL and auth token so the desktop chat
  // window and inline chat panel can connect. The GatewayManager reads
  // the token from openclaw.json after confirming the gateway is reachable,
  // then sets process.env. Fallback polls openclaw.json directly.
  app.get("/api/chat/gateway-config", async (_req, res) => {
    // Prefer process.env — the gateway manager reads the token from
    // openclaw.json after the gateway is confirmed reachable and sets
    // process.env to match.
    let token = process.env["ARMORCLAW_GATEWAY_TOKEN"] ?? "";
    let tokenSource = token ? "process.env" : "";

    // Fallback: read from openclaw.json (external gateway or legacy path)
    if (!token) {
      const configPath = join(homedir(), ".openclaw", "openclaw.json");
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          const raw = readFileSync(configPath, "utf-8");
          const config = JSON.parse(raw) as Record<string, unknown>;
          const gw = config["gateway"] as Record<string, unknown> | undefined;
          const auth = gw?.["auth"] as Record<string, unknown> | undefined;
          const t = typeof auth?.["token"] === "string" ? auth["token"] : "";
          if (t) {
            token = t;
            tokenSource = `openclaw.json (attempt ${attempt + 1})`;
            break;
          }
        } catch {
          // File doesn't exist yet — keep polling
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    process.stderr.write(
      `[dashboard] /api/chat/gateway-config → source=${tokenSource || "NONE"} token=${token ? token.slice(0, 8) + "..." : "EMPTY"}\n`,
    );

    if (!token) {
      res.status(503).json({
        wsUrl: "ws://127.0.0.1:18789",
        token: "",
        error: "Gateway token not available yet. Retry shortly.",
      });
      return;
    }

    res.json({
      wsUrl: "ws://127.0.0.1:18789",
      token,
    });
  });

  // ── Advanced: OpenClaw Control UI URL ──
  //
  // The gateway serves a Canvas UI at http://127.0.0.1:18789/__openclaw__/canvas/
  // This endpoint returns that URL and probes whether it's reachable.
  // ── Advanced: start the gateway (non-blocking spawn) ──
  app.post("/api/advanced/start-gateway", (_req, res) => {
    const repoRoot = process.env["ARMORCLAW_REPO_ROOT"];
    const nodeBin = process.env["ARMORCLAW_NODE_PATH"];
    if (!repoRoot || !nodeBin) {
      res.status(500).json({
        ok: false,
        message: "ArmorClaw paths not configured. Restart the app.",
      });
      return;
    }
    const openclawMjs = join(repoRoot, "openclaw.mjs");
    // Gateway owns its token — no --token flag. It generates a new token on
    // startup and writes it to openclaw.json. The next poll cycle reads it back.
    const gwArgs = [openclawMjs, "gateway"];
    try {
      const child = spawn(nodeBin, gwArgs, {
        stdio: "ignore",
        detached: true,
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env["PATH"] ?? ""}`,
        },
      });
      child.unref();
      res.json({ ok: true, pid: child.pid });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, message: msg });
    }
  });

  // ── Advanced: run any OpenClaw command ──
  //
  // No restrictions beyond hard-banned permission levels. The ArmorClaw
  // security layer (injection filter, permission engine) continues to run
  // on all tool calls even when commands are issued from this view.
  app.post("/api/advanced/run-command", (req, res) => {
    const { command } = req.body as { command?: string };
    if (!command || typeof command !== "string") {
      res.status(422).json({ ok: false, message: "command is required" });
      return;
    }
    const trimmed = command.trim();
    if (!trimmed) {
      res.status(422).json({ ok: false, message: "command is empty" });
      return;
    }
    const repoRoot = process.env["ARMORCLAW_REPO_ROOT"];
    const nodeBin = process.env["ARMORCLAW_NODE_PATH"];
    if (!repoRoot || !nodeBin) {
      res.status(500).json({
        ok: false,
        message:
          "ArmorClaw paths not configured. ARMORCLAW_REPO_ROOT or ARMORCLAW_NODE_PATH is missing. Restart the app.",
      });
      return;
    }
    const openclawMjs = join(repoRoot, "openclaw.mjs");
    try {
      const output = execSync(`"${nodeBin}" "${openclawMjs}" ${trimmed}`, {
        encoding: "utf-8",
        timeout: 30_000,
        cwd: repoRoot,
      });
      notifyListeners();
      res.json({ ok: true, output: output.trim() });
    } catch (err) {
      const errObj = err as { stderr?: string; stdout?: string };
      const msg =
        errObj.stderr?.trim() ||
        errObj.stdout?.trim() ||
        (err instanceof Error ? err.message : String(err));
      res.status(500).json({ ok: false, message: msg });
    }
  });

  // ── Channels ──────────────────────────────────────────────────────────────

  /** List all channel types with current status. */
  app.get("/api/channels", (_req, res) => {
    res.json({ ok: true, channels: getChannelTypes() });
  });

  /** Validate a Telegram bot token by calling getMe. */
  app.post("/api/channels/telegram/validate", async (req, res) => {
    const { token } = req.body as { token?: unknown };
    if (typeof token !== "string" || !token.trim()) {
      res.status(422).json({ ok: false, error: "token is required" });
      return;
    }
    const result = await validateTelegramToken(token.trim());
    if (result.ok) {
      res.json({ ok: true, username: result.username });
    } else {
      res.status(422).json({ ok: false, error: result.error });
    }
  });

  /** Save Telegram channel config to channels.json. */
  app.post("/api/channels/telegram/save", (req, res) => {
    const { token, username: ownerUsername } = req.body as { token?: unknown; username?: unknown };
    if (typeof token !== "string" || !token.trim()) {
      res.status(422).json({ ok: false, message: "token is required" });
      return;
    }
    if (typeof ownerUsername !== "string" || !ownerUsername.trim()) {
      res.status(422).json({ ok: false, message: "username is required" });
      return;
    }
    const cleanUsername = ownerUsername.trim().replace(/^@/, "");
    if (!cleanUsername) {
      res.status(422).json({ ok: false, message: "username cannot be empty" });
      return;
    }
    try {
      const config = readChannelsConfig();
      config.channels["telegram"] = {
        enabled: true,
        token: token.trim(),
        allowFrom: [cleanUsername],
      };
      writeChannelsConfig(config);
      // Also write TELEGRAM_BOT_TOKEN to .env for existing channel link resolution
      writeEnvVar("TELEGRAM_BOT_TOKEN", token.trim());
      // Reset telegram username cache so channel links pick up the new token
      resetTelegramCacheForTesting();
      _channelLinksCache = null;
      notifyListeners();
      res.json({ ok: true });
    } catch (err) {
      res
        .status(500)
        .json({ ok: false, message: err instanceof Error ? err.message : String(err) });
    }
  });

  /** Restart the gateway so channel config changes take effect. */
  app.post("/api/channels/gateway/restart", (_req, res) => {
    const repoRoot = process.env["ARMORCLAW_REPO_ROOT"];
    const nodeBin = process.env["ARMORCLAW_NODE_PATH"];
    if (!repoRoot || !nodeBin) {
      res.status(500).json({
        ok: false,
        message: "ArmorClaw paths not configured. Restart the app.",
      });
      return;
    }
    // Kill existing gateway, then start a new one
    try {
      execSync("pkill -f 'openclaw.mjs gateway'", {
        stdio: "ignore",
        timeout: 5_000,
      });
    } catch {
      // No existing process — that's fine
    }
    const openclawMjs = join(repoRoot, "openclaw.mjs");
    // Gateway owns its token — no --token flag. It generates a new token on
    // startup and writes it to openclaw.json. The next poll cycle reads it back.
    const gwArgs = [openclawMjs, "gateway"];
    try {
      const child = spawn(nodeBin, gwArgs, {
        stdio: "ignore",
        detached: true,
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env["PATH"] ?? ""}`,
        },
      });
      child.unref();
      notifyListeners();
      res.json({ ok: true, pid: child.pid });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, message: msg });
    }
  });

  // ── Advanced: open config file in editor ──
  app.post("/api/advanced/open-config", (_req, res) => {
    const configPath = join(homedir(), ".openclaw", "openclaw.json");
    try {
      const platform = process.platform;
      const cmd =
        platform === "darwin"
          ? `open "${configPath}"`
          : platform === "win32"
            ? `start "" "${configPath}"`
            : `xdg-open "${configPath}"`;
      execSync(cmd, { stdio: "ignore", timeout: 5000 });
      res.json({ ok: true });
    } catch {
      res.status(500).json({ ok: false, message: "Could not open the config file." });
    }
  });

  // ── Advanced: back up launcher config ──
  app.post("/api/advanced/backup-config", (_req, res) => {
    const srcDir = getLauncherDataPath();
    if (!existsSync(srcDir)) {
      res.status(404).json({ ok: false, message: "No config directory found to back up." });
      return;
    }
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const destDir = join(getBackupParentDir(), `armorclaw-backup-${ts}`);
    try {
      cpSync(srcDir, destDir, { recursive: true });
      res.json({ ok: true, path: destDir });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, message: msg });
    }
  });

  // ── Advanced: gateway port probe (lightweight TCP check) ──
  // The gateway is a WebSocket server on 18789, not an HTTP server.
  // A plain HTTP GET to "/" may fail even when the gateway is running.
  // Use a raw TCP connect check instead (same approach as gateway-manager.ts).
  app.get("/api/advanced/gateway-probe", async (_req, res) => {
    const net = await import("node:net");
    const reachable = await new Promise<boolean>((resolve) => {
      const sock = net.createConnection(
        { host: "127.0.0.1", port: GATEWAY_PORT, timeout: 2000 },
        () => {
          sock.destroy();
          resolve(true);
        },
      );
      sock.on("error", () => resolve(false));
      sock.on("timeout", () => {
        sock.destroy();
        resolve(false);
      });
    });
    res.json({ ok: true, reachable });
  });

  // ── OpenClaw update check ──
  app.get("/api/advanced/openclaw-update", (_req, res) => {
    const status = getOpenClawVersionStatus();
    res.json({ ok: true, ...status });
  });

  return app;
}

// ── Server lifecycle ──────────────────────────────────────────────────────────

export async function startServer(
  port = DASHBOARD_PORT,
): Promise<{ port: number; close: () => Promise<void> }> {
  const app = createApp();
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.listen(port, "127.0.0.1", resolve);
    server.once("error", reject);
  });
  // Prime the license cache + start the 60 s refresh loop. Fire-and-forget so
  // a slow billing Worker can't delay server startup; the SSE snapshot uses a
  // safe fallback until the first load resolves.
  void primeLicenseCache().catch(() => {
    /* loadLicense never throws, but defensively swallow anyway */
  });
  const addr = server.address() as { port: number };
  return { port: addr.port, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

// ── Testing helpers ───────────────────────────────────────────────────────────

export function clearDashboardStateForTesting(): void {
  setAgentStatus("running");
  _channelLinksCache = null;
  _telegramUsername = undefined;
  resetTailscaleCacheForTesting();
  clearLicenseCacheForTesting();
  listeners.clear();
}
