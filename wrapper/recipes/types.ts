/**
 * Types shared across the recipes module.
 */

/**
 * A recipe definition from the library.
 * Describes what runs, when, and what input to pass.
 * This is the static, author-supplied shape — it never changes at runtime.
 */
export interface Recipe {
  /** Unique kebab-case id — must match the CLAUDE.md table. */
  id: string;
  /** Human-readable name shown in the dashboard. */
  name: string;
  /** One sentence describing what the recipe does. */
  description: string;
  /** Skill id this recipe invokes. */
  skill: string;
  /** Default cron expression (user may override). */
  defaultSchedule: string;
  /** Human-readable schedule label for the default schedule. */
  scheduleLabel: string;
  /** Pre-filled input passed to skill.run() on each execution. */
  inputTemplate: Record<string, unknown>;
  /** Whether the underlying skill actions are undoable. */
  undoable: boolean;
}

/** Per-recipe state stored in ~/.armorclaw/recipes.json. */
export interface RecipeState {
  active: boolean;
  /** User-specified cron override. Absent → use Recipe.defaultSchedule. */
  scheduleOverride?: string;
  /** ISO 8601 timestamp of the most recent run. */
  lastRun?: string;
  lastOutcome?: RecipeRunOutcome;
  /** Resets to 0 on success; increments on error. Triggers deactivation at 3. */
  consecutiveFailures: number;
}

/** Recipe definition merged with live user state. Returned by the store. */
export interface RecipeWithState extends Recipe {
  active: boolean;
  /** Effective cron expression (override or default). */
  schedule: string;
  /** Human-readable label for the effective schedule. */
  scheduleLabel: string;
  lastRun?: string;
  lastOutcome?: RecipeRunOutcome;
  consecutiveFailures: number;
  /** ISO 8601 time of the next scheduled run, computed from the cron expression. */
  nextRun?: string;
}

export type RecipeRunOutcome = "success" | "error";
