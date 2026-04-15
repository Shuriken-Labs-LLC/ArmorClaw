/**
 * Dashboard constants — static data arrays and label maps.
 *
 * Zero dependencies: no DOM, no state, no imports.
 * Canonical source for PR 1 of the dashboard JS extraction.
 */

/** Navigation items for the sidebar and mobile drawer. */
export const NAV: ReadonlyArray<{ id: string; label: string; icon: string }> = [
  { id: "home", label: "Home", icon: "\u2295" },
  { id: "skills", label: "Skills", icon: "\u26A1" },
  { id: "recipes", label: "Recipes", icon: "\uD83D\uDDD3" },
  { id: "security", label: "Security", icon: "\uD83D\uDD12" },
  { id: "token-burn", label: "Token Burn", icon: "\uD83D\uDCCA" },
  { id: "settings", label: "Settings", icon: "\u2699" },
];

/** Human-readable labels for model providers. */
export const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI (GPT)",
  ollama: "Ollama (local)",
};

/** Placeholder / hint text for provider API key inputs. */
export const PROVIDER_KEY_HINTS: Readonly<Record<string, string>> = {
  anthropic: "Enter your Anthropic API key (sk-ant-...)",
  openai: "Enter your OpenAI API key (sk-...)",
  ollama: "Enter your Ollama base URL (http://localhost:11434)",
};

/** Preset cron schedules for the recipe editor. */
export const SCHEDULE_PRESETS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "0 8 * * *", label: "Every morning (8am)" },
  { value: "0 8 * * 1-5", label: "Weekdays only (8am Mon\u2013Fri)" },
  { value: "0 9 * * 1", label: "Every Monday (9am)" },
  { value: "0 * * * *", label: "Every hour" },
  { value: "custom", label: "Custom\u2026" },
];

/** Permission level to plain-English label. */
export const PERM_LABELS: Readonly<Record<string, string>> = {
  "read:files": "Read files in sandbox",
  "write:files": "Write files in sandbox",
  "read:email": "Read email",
  "send:email": "Send email",
  "read:calendar": "Read calendar",
  "write:calendar": "Edit calendar",
  "read:crm": "Read CRM records",
  "write:crm": "Update CRM records",
  "browser:sandboxed": "Control browser (sandboxed)",
  "network:outbound": "Make network requests",
};

/** Abbreviated day-of-week names, Sunday-first. */
export const DAY_ABBRS: ReadonlyArray<string> = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Skill ID to emoji icon for display in skill cards. */
export const SKILL_ICONS: Readonly<Record<string, string>> = {
  "email-calendar": "\uD83D\uDCE7",
  "crm-leadgen": "\uD83D\uDCCA",
  "secure-files": "\uD83D\uDCC1",
  browser: "\uD83C\uDF10",
};
