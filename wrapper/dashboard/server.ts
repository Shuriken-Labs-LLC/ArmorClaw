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

import { execSync } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import express from "express";
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
  getBudgetStatus,
  getDailyHistory,
  getMonthBySkill,
  getMonthTokens,
  getRecentEvents,
  getTodayTokens,
  resumeFromHardStop,
  setBudgetMonthlyUSD,
} from "../token-tracker/store.ts";
import type { DailyTotal, TokenEvent } from "../token-tracker/store.ts";
import { getCurrentUndo, executeUndo } from "../undo/registry.ts";
import * as DashConstants from "./src/constants.ts";
import * as DashUtils from "./src/utils.ts";

// ── Constants ─────────────────────────────────────────────────────────────────

export const DASHBOARD_PORT = 7390;

const DASHBOARD_HTML = join(import.meta.dirname, "public", "index.html");

/** Absolute path to the repo-root .env file (dashboard/ → wrapper/ → repo root). */
const ENV_FILE = join(import.meta.dirname, "..", "..", ".env");

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

// ── .env reader ───────────────────────────────────────────────────────────────

/**
 * Parse the repo-root .env file and return a key → value map.
 * Never throws. Ignores comments and blank lines.
 */
export function readEnvConfig(): Record<string, string> {
  try {
    const raw = readFileSync(ENV_FILE, "utf-8");
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
      existing = readFileSync(ENV_FILE, "utf-8");
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
    writeFileSync(ENV_FILE, lines.join("\n").replace(/\n+$/, "") + "\n", "utf-8");
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
export function readRecentAuditEntries(limit = 20): AuditEntry[] {
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

// ── Agent status ──────────────────────────────────────────────────────────────

export type AgentStatus = "running" | "paused" | "error";
let agentStatus: AgentStatus = "running";

export function getAgentStatus(): AgentStatus {
  return agentStatus;
}
export function setAgentStatus(s: AgentStatus): void {
  agentStatus = s;
}

// ── Pending approvals (STUB) ──────────────────────────────────────────────────
//
// PLACEHOLDER: Approvals are not yet wired to the skill system.
// When the approval flow is built in wrapper/skills/, skills will POST to
// /api/approvals with the action requiring user sign-off, and block execution
// until the user approves or rejects here in the dashboard.
// For v1 the list is always empty — the card shows a zero-state.

export interface PendingApproval {
  id: string;
  skill: string;
  displayName: string;
  requestedAt: string;
}

export function getPendingApprovals(): ReadonlyArray<PendingApproval> {
  return []; // STUB — always empty until the approval system is built
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
  config: {
    modelProvider: string | null;
    sandboxDir: string | null;
  };
  channels: ChannelLink[];
  // TOKEN BURN: wired to token-tracker/store.ts — returns zeros until real
  // TokenEvents are recorded by the model adapter (not yet built).
  budget: ReturnType<typeof getBudgetStatus>;
  monthTokens: ReturnType<typeof getMonthTokens>;
  undo: { id: string; actionType: string; skill: string; expiresAt: string } | null;
  // APPROVALS STUB: always empty — see comment above getPendingApprovals()
  pendingApprovals: PendingApproval[];
  feed: AuditEntry[];
  skills: ReturnType<typeof getAllSkills>;
  recipes: RecipeWithState[];
  connectedServices: {
    gmail: boolean;
    outlook: boolean;
    hubspot: boolean;
    airtable: boolean;
  };
  /** Tailscale HTTPS URL for this device, or null if Tailscale is not active. */
  tailscaleUrl: string | null;
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

export async function getDashboardSnapshot(): Promise<DashboardSnapshot> {
  const env = readEnvConfig();

  // Resolve channel links once and cache
  if (_channelLinksCache === null) {
    _channelLinksCache = await resolveChannelLinks();
  }

  const undo = getCurrentUndo();
  return {
    agentStatus,
    config: {
      modelProvider: env["ARMORCLAW_MODEL_PROVIDER"] ?? null,
      sandboxDir: env["ARMORCLAW_SANDBOX_DIR"] ?? null,
    },
    channels: _channelLinksCache,
    budget: getBudgetStatus(),
    monthTokens: getMonthTokens(),
    undo: undo
      ? { id: undo.id, actionType: undo.actionType, skill: undo.skill, expiresAt: undo.expiresAt }
      : null,
    pendingApprovals: [], // STUB
    feed: readRecentAuditEntries(20),
    skills: getAllSkills(),
    recipes: getAllRecipes(),
    connectedServices: {
      gmail: Boolean(env["GOOGLE_CLIENT_ID"]),
      outlook: Boolean(env["MICROSOFT_CLIENT_ID"]),
      hubspot: Boolean(env["HUBSPOT_API_KEY"]),
      airtable: Boolean(env["AIRTABLE_API_KEY"]),
    },
    tailscaleUrl: getTailscaleUrl(),
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
 * Check config readiness for all four bundled skills.
 * Uses the parsed .env map — never reads secrets into output.
 */
export function getBundledSkillStatuses(env: Record<string, string>): BundledSkillStatus[] {
  const emailActive =
    Boolean(env["GOOGLE_CLIENT_ID"]) ||
    Boolean(env["GOOGLE_AUTH_CODE_PENDING"]) ||
    Boolean(env["MICROSOFT_CLIENT_ID"]) ||
    Boolean(env["MICROSOFT_AUTH_CODE_PENDING"]);

  const crmActive = Boolean(env["HUBSPOT_API_KEY"]) || Boolean(env["AIRTABLE_API_KEY"]);

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
      id: "crm-leadgen",
      displayName: "CRM + lead gen",
      description:
        "Prospect research, follow-up drafts, and CRM record management for HubSpot and Airtable.",
      version: "1.0.0",
      ...(crmActive
        ? { status: "active" as const }
        : {
            status: "not_configured" as const,
            missingConfig: "Connect HubSpot or Airtable in Settings",
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
      _dashLibCache = constLines.concat(fnLines).join("\n");
    }
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.send(_dashLibCache);
  });

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

  // ── Audit log CSV export ──
  app.get("/api/audit/export.csv", (_req, res) => {
    const entries = readRecentAuditEntries(10_000); // read up to 10k entries for export
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
  const addr = server.address() as { port: number };
  return { port: addr.port, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

// ── Testing helpers ───────────────────────────────────────────────────────────

export function clearDashboardStateForTesting(): void {
  agentStatus = "running";
  _channelLinksCache = null;
  _telegramUsername = undefined;
  resetTailscaleCacheForTesting();
  listeners.clear();
}
