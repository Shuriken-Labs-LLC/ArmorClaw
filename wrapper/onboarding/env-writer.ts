/**
 * Safely writes/updates key-value pairs in the project .env file.
 * Keys are written as-is; values are never logged or echoed.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let _loggedEnvPath = false;

/**
 * Absolute path to the .env file at the repository root.
 *
 * When running inside the Electron launcher, ARMORCLAW_REPO_ROOT is set
 * by main.ts before this module is imported. When running standalone
 * (node wrapper/onboarding/index.ts from the repo), falls back to
 * walking up from import.meta.dirname.
 */
function envFilePath(): string {
  const repoRoot = process.env["ARMORCLAW_REPO_ROOT"];
  if (repoRoot) {
    return join(repoRoot, ".env");
  }
  // Standalone dev mode: onboarding/ → wrapper/ → repo root
  return join(import.meta.dirname, "..", "..", ".env");
}

/**
 * Reads the current .env contents as a Map of key → raw line.
 * Lines that aren't key=value pairs are preserved verbatim.
 */
function readEnvLines(path: string): string[] {
  try {
    return readFileSync(path, "utf8").split("\n");
  } catch {
    return [];
  }
}

/**
 * Sets a single key in the .env file, creating the file if it doesn't exist.
 * The value is written exactly as given — callers are responsible for quoting.
 * Never throws; returns false if the write fails.
 */
export function setEnvVar(key: string, value: string): boolean {
  // Also set process.env so in-process reads (e.g. the OAuth token exchange)
  // see the value immediately without needing to re-read the .env file.
  process.env[key] = value;

  try {
    const path = envFilePath();
    // Log on first write so we can see where .env ends up
    if (!_loggedEnvPath) {
      _loggedEnvPath = true;
      process.stderr.write(`[env-writer] .env path: ${path}\n`);
    }
    const lines = readEnvLines(path);
    const keyPrefix = `${key}=`;
    let found = false;
    const updated = lines.map((line) => {
      if (line.startsWith(keyPrefix)) {
        found = true;
        return `${key}=${value}`;
      }
      return line;
    });
    if (!found) {
      updated.push(`${key}=${value}`);
    }
    // Remove trailing empty lines then add one final newline
    const trimmed = updated.join("\n").replace(/\n+$/, "") + "\n";
    writeFileSync(path, trimmed, "utf8");
    process.stderr.write(`[env-writer] wrote ${key} to ${path}\n`);
    return true;
  } catch (err) {
    process.stderr.write(
      `[env-writer] FAILED to write ${key} to .env at ${envFilePath()}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return false;
  }
}

/**
 * Removes a key from the .env file.
 * Never throws; returns false if the operation fails.
 */
export function removeEnvVar(key: string): boolean {
  try {
    const path = envFilePath();
    const lines = readEnvLines(path);
    const keyPrefix = `${key}=`;
    const updated = lines.filter((line) => !line.startsWith(keyPrefix));
    writeFileSync(path, updated.join("\n").replace(/\n+$/, "") + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Masks an API key for safe display: shows the first 8 chars then "•••••••".
 * Never returns the full key.
 */
export function maskApiKey(key: string): string {
  if (key.length <= 8) {
    return "•".repeat(key.length);
  }
  return key.slice(0, 8) + "•".repeat(Math.min(key.length - 8, 24));
}
