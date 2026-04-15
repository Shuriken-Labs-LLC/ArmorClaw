/**
 * Dashboard utility helpers — pure formatting and escaping functions.
 *
 * Zero dependencies: no DOM, no state, no imports.
 * Canonical source for PR 1 of the dashboard JS extraction.
 */

/** Escape HTML special characters for safe interpolation. */
export function escHtml(s: string | null | undefined): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Escape a value for use in an HTML attribute (delegates to escHtml). */
export function escAttr(s: string | null | undefined): string {
  return escHtml(s);
}

/** Format a number as a USD string, with extra precision for sub-cent amounts. */
export function fmtUSD(n: unknown): string {
  if (typeof n !== "number" || n === 0) {
    return "$0.00";
  }
  if (n >= 0.01) {
    return "$" + n.toFixed(2);
  }
  // Sub-cent: show enough decimals to display a non-zero digit
  if (n >= 0.001) {
    return "$" + n.toFixed(3);
  }
  return "$" + n.toFixed(4);
}

/** Format an ISO timestamp as a relative or short-date string. */
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) {
    return "";
  }
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = Number(now) - Number(d);
    if (diffMs < 60_000) {
      return "just now";
    }
    if (diffMs < 3_600_000) {
      return Math.floor(diffMs / 60_000) + "m ago";
    }
    if (diffMs < 86_400_000) {
      return Math.floor(diffMs / 3_600_000) + "h ago";
    }
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
    }).format(d);
  } catch {
    return "";
  }
}

/** Convert a raw skill ID (kebab/snake/camel) to a human-readable name. */
export function humaniseSkillName(raw: string): string {
  return raw
    .replace(/[-_]/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Mask an API key, showing only the first and last 4 characters. */
export function maskKey(key: string): string {
  if (key.length <= 8) {
    return "\u2022".repeat(key.length);
  }
  return key.slice(0, 4) + "\u2022".repeat(Math.min(key.length - 8, 20)) + key.slice(-4);
}
