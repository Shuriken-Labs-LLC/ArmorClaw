/**
 * Tailscale detection and setup utilities for the onboarding wizard.
 * All functions are async-safe and never throw — errors are returned as
 * structured results.
 */

import { exec, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

const execAsync = promisify(exec);

// ── CLI binary resolution ────────────────────────────────────────────────────

/**
 * macOS installs Tailscale as an app bundle; the CLI lives at a capital-T path
 * and the /usr/local/bin/tailscale symlink may not exist until the user opens
 * the app once. We probe in order and cache the first hit.
 */
const TAILSCALE_CANDIDATES =
  process.platform === "darwin"
    ? [
        "tailscale", // PATH (symlink if present)
        "/usr/local/bin/tailscale", // common symlink location
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale", // app bundle (capital T)
      ]
    : ["tailscale"]; // Linux / Windows — rely on PATH

let _resolvedBinary: string | null = null;

/**
 * Find the tailscale CLI binary. Caches the result for the process lifetime.
 * Returns null if no working binary is found.
 */
function findTailscaleBinary(): string | null {
  if (_resolvedBinary !== null) {
    return _resolvedBinary;
  }

  for (const candidate of TAILSCALE_CANDIDATES) {
    // For bare names (no slash), check if the command exists via `which`.
    // For absolute paths, check the filesystem directly.
    if (candidate.startsWith("/")) {
      if (!existsSync(candidate)) {
        continue;
      }
    }
    try {
      execSync(`"${candidate}" version`, { stdio: "ignore", timeout: 3000 });
      _resolvedBinary = candidate;
      return _resolvedBinary;
    } catch {
      // Not found or not executable — try next
    }
  }
  return null;
}

/** Reset the cached binary (used in tests). */
export function _resetBinaryCache(): void {
  _resolvedBinary = null;
}

// ── Detection ────────────────────────────────────────────────────────────────

export interface TailscaleDetectResult {
  installed: boolean;
  authenticated: boolean;
  /** e.g. "https://mydevice.tail1234.ts.net" */
  tsNetUrl?: string;
  error?: string;
}

/**
 * Checks whether Tailscale is installed and authenticated on this machine.
 */
export async function detectTailscale(): Promise<TailscaleDetectResult> {
  const binary = findTailscaleBinary();
  if (!binary) {
    return { installed: false, authenticated: false };
  }

  try {
    const { stdout } = await execAsync(`"${binary}" status --json`, { timeout: 5000 });
    const status = JSON.parse(stdout) as Record<string, unknown>;

    // BackendState is "Running" when authenticated and connected
    const running = status["BackendState"] === "Running";
    if (!running) {
      return { installed: true, authenticated: false };
    }

    // Extract the *.ts.net hostname from the Self node
    const self = status["Self"] as Record<string, unknown> | undefined;
    const dnsName = typeof self?.["DNSName"] === "string" ? self["DNSName"] : undefined;
    const tsNetUrl = dnsName ? `https://${dnsName.replace(/\.$/, "")}` : undefined;

    return { installed: true, authenticated: true, tsNetUrl };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // Installed but errored (daemon not running, etc.)
    return { installed: true, authenticated: false, error: message };
  }
}

// ── Polling ──────────────────────────────────────────────────────────────────

/**
 * Polls for Tailscale by repeatedly running `tailscale status`.
 * Also re-probes the binary path on each iteration in case the user
 * just installed Tailscale while the wizard was waiting.
 * Returns when Tailscale is authenticated or the timeout expires.
 */
export async function pollForTailscale(timeoutMs = 120_000): Promise<TailscaleDetectResult> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Clear cache so a fresh install is picked up
    _resetBinaryCache();
    const result = await detectTailscale();
    if (result.authenticated) {
      return result;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 3000));
  }
  return { installed: false, authenticated: false, error: "Timed out waiting for Tailscale." };
}

// ── Serve ────────────────────────────────────────────────────────────────────

/**
 * Attempts to run `tailscale serve` to expose the ArmorClaw dashboard
 * on the Tailscale network. Returns the ts.net URL if successful.
 */
export async function serveTailscale(
  localPort: number,
): Promise<{ ok: boolean; url?: string; error?: string }> {
  const binary = findTailscaleBinary();
  if (!binary) {
    return { ok: false, error: "Tailscale CLI not found." };
  }

  try {
    await execAsync(`"${binary}" serve --bg https / http://localhost:${localPort}`, {
      timeout: 10_000,
    });
    const result = await detectTailscale();
    if (result.tsNetUrl) {
      return { ok: true, url: result.tsNetUrl };
    }
    return { ok: false, error: "Tailscale serve ran but could not determine the ts.net URL." };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** URL to open in a browser to download Tailscale for the current platform. */
export function tailscaleDownloadUrl(): string {
  const platform = process.platform;
  if (platform === "darwin") {
    return "https://tailscale.com/download/mac";
  }
  if (platform === "win32") {
    return "https://tailscale.com/download/windows";
  }
  return "https://tailscale.com/download/linux";
}
