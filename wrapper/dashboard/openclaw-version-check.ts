/**
 * OpenClaw version checker — server-side module.
 *
 * Polls the OpenClaw releases Atom feed every 6 hours and compares against the
 * locally installed version. The cached result is served to the dashboard via
 * GET /api/advanced/openclaw-update.
 *
 * Never auto-updates. Never persists to disk. Never throws.
 */

import { execSync } from "node:child_process";

// ── Types ────────────────────────────────────────────────────────────────────

export interface OpenClawVersionStatus {
  hasUpdate: boolean;
  installedVersion: string;
  latestVersion: string;
  releaseUrl: string;
  lastChecked: string;
  error: string | null;
}

// ── State ────────────────────────────────────────────────────────────────────

const RELEASES_ATOM_URL = "https://github.com/openclaw/openclaw/releases.atom";
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

let cached: OpenClawVersionStatus = {
  hasUpdate: false,
  installedVersion: "",
  latestVersion: "",
  releaseUrl: "",
  lastChecked: "",
  error: null,
};

let intervalHandle: ReturnType<typeof setInterval> | null = null;

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Strip leading "v" and whitespace from a version string. */
function normalizeVersion(raw: string): string {
  return raw.trim().replace(/^v/i, "");
}

/**
 * Simple semver comparison. Returns:
 *   1  if a > b
 *  -1  if a < b
 *   0  if equal
 * Non-numeric parts are treated as 0.
 */
function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na > nb) {
      return 1;
    }
    if (na < nb) {
      return -1;
    }
  }
  return 0;
}

/**
 * Extract the first <entry><title>…</title> from an Atom XML string.
 * Avoids adding an XML parser dependency — the releases feed is simple enough.
 */
function parseLatestVersionFromAtom(xml: string): {
  version: string;
  releaseUrl: string;
} | null {
  // First entry's title contains the version tag name
  const entryMatch = xml.match(/<entry>[\s\S]*?<\/entry>/);
  if (!entryMatch) {
    return null;
  }

  const entry = entryMatch[0];
  const titleMatch = entry.match(/<title[^>]*>([\s\S]*?)<\/title>/);
  if (!titleMatch) {
    return null;
  }

  // Release link — look for the alternate link inside the entry
  let releaseUrl = "";
  const linkMatch = entry.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/);
  if (linkMatch) {
    releaseUrl = linkMatch[1];
  }

  return {
    version: normalizeVersion(titleMatch[1]),
    releaseUrl,
  };
}

/** Get the installed OpenClaw version via CLI. */
function getInstalledVersion(): string | null {
  const repoRoot = process.env["ARMORCLAW_REPO_ROOT"];
  const nodePath = process.env["ARMORCLAW_NODE_PATH"];
  if (!repoRoot || !nodePath) {
    return null;
  }

  try {
    const output = execSync(`"${nodePath}" "${repoRoot}/core/bin/openclaw.mjs" --version`, {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return normalizeVersion(output);
  } catch {
    return null;
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function checkOpenClawVersion(): Promise<void> {
  try {
    // Get installed version
    const installed = getInstalledVersion();
    if (installed === null) {
      cached = {
        ...cached,
        hasUpdate: false,
        lastChecked: new Date().toISOString(),
        error:
          "Could not determine installed OpenClaw version (ARMORCLAW_REPO_ROOT or ARMORCLAW_NODE_PATH not set)",
      };
      return;
    }

    // Fetch releases atom feed
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    let response: Response;
    try {
      response = await fetch(RELEASES_ATOM_URL, {
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      cached = {
        ...cached,
        installedVersion: installed,
        hasUpdate: false,
        lastChecked: new Date().toISOString(),
        error: `Atom feed returned HTTP ${String(response.status)}`,
      };
      return;
    }

    const xml = await response.text();
    const latest = parseLatestVersionFromAtom(xml);
    if (!latest) {
      cached = {
        ...cached,
        installedVersion: installed,
        hasUpdate: false,
        lastChecked: new Date().toISOString(),
        error: "Could not parse version from releases Atom feed",
      };
      return;
    }

    cached = {
      hasUpdate: compareSemver(latest.version, installed) > 0,
      installedVersion: installed,
      latestVersion: latest.version,
      releaseUrl: latest.releaseUrl,
      lastChecked: new Date().toISOString(),
      error: null,
    };
  } catch (err: unknown) {
    cached = {
      ...cached,
      hasUpdate: false,
      lastChecked: new Date().toISOString(),
      error: err instanceof Error ? err.message : "Unknown error during version check",
    };
  }
}

export function getOpenClawVersionStatus(): OpenClawVersionStatus {
  return { ...cached };
}

export function startVersionCheckInterval(): void {
  // Immediate first check
  void checkOpenClawVersion();

  // Periodic re-check
  if (intervalHandle === null) {
    intervalHandle = setInterval(() => {
      void checkOpenClawVersion();
    }, CHECK_INTERVAL_MS);
  }
}

// ── Testing helpers ──────────────────────────────────────────────────────────

export function stopVersionCheckInterval(): void {
  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

export function resetVersionCheckForTesting(): void {
  stopVersionCheckInterval();
  cached = {
    hasUpdate: false,
    installedVersion: "",
    latestVersion: "",
    releaseUrl: "",
    lastChecked: "",
    error: null,
  };
}
