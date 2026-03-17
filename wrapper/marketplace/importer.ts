/**
 * ArmorClaw skill importer — URL validation, GitHub fetch, and install.
 *
 * URL fetching is restricted to a hardcoded allowlist of GitHub hosts.
 * Install writes to ~/.armorclaw/skills/ only.
 * Never executes skill code.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Hosts from which skill source may be fetched. */
export const ALLOWED_FETCH_HOSTS: ReadonlySet<string> = new Set([
  "raw.githubusercontent.com",
  "gist.githubusercontent.com",
]);

/** Hosts that are valid GitHub URL inputs (some require normalisation before fetch). */
export const ALLOWED_GITHUB_HOSTS: ReadonlySet<string> = new Set([
  "github.com",
  "raw.githubusercontent.com",
  "gist.github.com",
  "gist.githubusercontent.com",
]);

/** Only these file extensions may be installed as skills. */
const ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set([".ts", ".js"]);

// ── URL helpers ───────────────────────────────────────────────────────────────

/**
 * Returns true if `urlStr` is an https URL pointing to a GitHub host.
 * Does not validate that the file actually exists.
 */
export function isValidGitHubUrl(urlStr: string): boolean {
  try {
    const url = new URL(urlStr);
    return url.protocol === "https:" && ALLOWED_GITHUB_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Convert a github.com blob URL to its raw.githubusercontent.com equivalent.
 * Returns the URL unchanged if it is already a raw URL.
 *
 * Accepted input forms:
 *  - https://github.com/user/repo/blob/branch/path/to/skill.ts
 *  - https://raw.githubusercontent.com/user/repo/branch/path/to/skill.ts  (pass-through)
 *  - https://gist.githubusercontent.com/user/hash/raw/...                  (pass-through)
 *
 * Throws a descriptive Error if the URL cannot be converted to a fetchable form.
 */
export function normalizeGitHubUrl(urlStr: string): string {
  const url = new URL(urlStr);

  // Already a fetchable raw URL
  if (ALLOWED_FETCH_HOSTS.has(url.hostname)) {
    return urlStr;
  }

  if (url.hostname === "github.com") {
    // Expect: /user/repo/blob/branch/...path
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length >= 5 && parts[2] === "blob") {
      const [user, repo, , branch, ...rest] = parts;
      return `https://raw.githubusercontent.com/${user}/${repo}/${branch}/${rest.join("/")}`;
    }
    throw new Error(
      "GitHub URL must point to a specific file — e.g. github.com/user/repo/blob/main/skill.ts",
    );
  }

  if (url.hostname === "gist.github.com") {
    // gist.github.com/user/hash → gist.githubusercontent.com/user/hash/raw
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length >= 2) {
      const [user, hash, ...rest] = parts;
      // If user already added /raw/..., keep it; otherwise append /raw
      if (rest[0] === "raw") {
        return `https://gist.githubusercontent.com/${user}/${hash}/${rest.join("/")}`;
      }
      return `https://gist.githubusercontent.com/${user}/${hash}/raw`;
    }
    throw new Error("Gist URL must include both a username and a hash");
  }

  throw new Error(`Fetching from ${url.hostname} is not permitted`);
}

// ── Fetcher ───────────────────────────────────────────────────────────────────

/**
 * Fetch skill source from a (normalised) GitHub URL.
 * Only fetches from hosts in {@link ALLOWED_FETCH_HOSTS}.
 * Times out after 10 seconds.
 */
export async function fetchSkillSource(
  urlStr: string,
): Promise<{ code: string; filename: string }> {
  const rawUrl = normalizeGitHubUrl(urlStr);
  const url = new URL(rawUrl);

  if (!ALLOWED_FETCH_HOSTS.has(url.hostname)) {
    throw new Error(
      `Fetching from ${url.hostname} is not permitted. Only GitHub URLs are supported.`,
    );
  }

  const res = await fetch(rawUrl, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    throw new Error(`Failed to fetch skill: HTTP ${res.status} from ${url.hostname}`);
  }

  const code = await res.text();
  const filename = sanitizeFilename(basename(url.pathname) || "skill.ts");
  return { code, filename };
}

// ── Filename sanitiser ────────────────────────────────────────────────────────

/**
 * Strip directory components and ensure the file has an allowed extension.
 * Returns a safe filename for use in ~/.armorclaw/skills/.
 */
export function sanitizeFilename(raw: string): string {
  const name = basename(raw);
  const ext = extname(name).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(
      `Only .ts and .js files may be installed as skills (got ${ext || "no extension"})`,
    );
  }
  return name;
}

// ── Installer ─────────────────────────────────────────────────────────────────

/**
 * Write skill source to `~/.armorclaw/skills/<filename>`.
 *
 * @param code      Source text to write.
 * @param filename  Must be a sanitised filename (no path components).
 * @returns         Absolute path where the skill was written.
 */
export function installSkill(code: string, filename: string): string {
  const safe = sanitizeFilename(filename); // re-validate at install time
  const dir = join(homedir(), ".armorclaw", "skills");
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, safe);
  writeFileSync(dest, code, "utf-8");
  return dest;
}
