/**
 * Recipe scheduler — drives cron-based skill execution.
 *
 * Each recipe run:
 *  1. Checks input template for injection patterns (same filter as interactive calls)
 *  2. Verifies the skill is recipe-eligible in the registry
 *  3. Runs the skill via the injected runner (defaults to dynamic import)
 *  4. Writes an audit log entry with source:recipe:<id>
 *  5. Records the run outcome in the store
 *  6. After 3 consecutive failures: deactivates the recipe + calls onDisable
 *
 * Concurrency: each skill name has its own promise-chain lock.
 * A second invocation of the same skill queues behind the first — never runs in parallel.
 *
 * Injectable seams for testing:
 *  - getActiveRecipes: supply a custom recipe list
 *  - runSkill: mock the skill execution
 *  - onDisable: capture the 3-strike notification
 *  - cronFn: capture scheduled callbacks without real timers
 */

import { Cron } from "croner";
import { isRecipeEligible } from "../lib/skill-registry.ts";
import { writeAuditEntry } from "../security/audit-logger.ts";
import { checkForInjection } from "../security/injection-filter.ts";
import * as store from "./store.ts";
import type { RecipeWithState } from "./types.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

export type CronFn = (
  expression: string,
  timezone: string,
  callback: () => void | Promise<void>,
) => { stop(): void };

export type RecipeSkillRunner = (
  skillId: string,
  input: Record<string, unknown>,
) => Promise<{ success: boolean; message: string }>;

export interface RecipeSchedulerOptions {
  /** Override active recipe list (default: store.getAllRecipes filtered to active). */
  getActiveRecipes?: () => RecipeWithState[];
  /** Timezone for scheduling (default: system timezone, re-read at start). */
  getTimezone?: () => string;
  /** Skill execution function (default: dynamic import). */
  runSkill?: RecipeSkillRunner;
  /**
   * Called when a recipe is deactivated due to 3 consecutive failures.
   * Default: writes to the audit log.
   */
  onDisable?: (recipeId: string, recipeName: string) => void;
  /** Cron factory (default: croner). */
  cronFn?: CronFn;
}

export interface SchedulerHandle {
  stop(): void;
}

// ── Default implementations ───────────────────────────────────────────────────

/* v8 ignore next 5 — real croner wiring; tested via injectable cronFn */
function defaultCronFn(
  expression: string,
  timezone: string,
  callback: () => void | Promise<void>,
): { stop(): void } {
  return new Cron(expression, { timezone, protect: true }, callback);
}

/* v8 ignore next 6 — real dynamic import; tested via injectable runSkill */
async function defaultRunSkill(
  skillId: string,
  input: Record<string, unknown>,
): Promise<{ success: boolean; message: string }> {
  const mod = (await import(`../skills/${skillId}/index.ts`)) as Record<string, unknown>;
  const runFn = mod["run"] as (i: unknown) => Promise<{ success: boolean; message: string }>;
  return runFn(input);
}

// ── Per-skill concurrency lock ─────────────────────────────────────────────────

/**
 * Module-level promise chains keyed by skill id.
 * Ensures at most one invocation of any given skill runs at a time.
 * A second invocation is appended to the chain and runs when the first completes.
 */
const skillLocks = new Map<string, Promise<void>>();

function runWithLock(skillId: string, fn: () => Promise<void>): void {
  const prev = skillLocks.get(skillId) ?? Promise.resolve();
  // Chain fn after the previous invocation; ignore errors so the lock doesn't jam
  const next = prev.then(fn, fn);
  skillLocks.set(
    skillId,
    next.then(
      () => {},
      () => {},
    ),
  );
}

/** Reset all skill locks. Test isolation only. */
export function clearSkillLocksForTesting(): void {
  skillLocks.clear();
}

/**
 * Returns a promise that resolves when all pending executions of a skill complete.
 * Test isolation only — do not call in production code paths.
 */
export function waitForSkillLockForTesting(skillId: string): Promise<void> {
  return skillLocks.get(skillId) ?? Promise.resolve();
}

// ── Recipe execution ──────────────────────────────────────────────────────────

async function executeRecipe(
  recipe: RecipeWithState,
  runSkill: RecipeSkillRunner,
  onDisable: (id: string, name: string) => void,
): Promise<void> {
  const start = Date.now();

  // 1. Injection filter — treat recipe inputTemplate like interactive input
  const injection = checkForInjection({
    toolName: `recipe:${recipe.id}`,
    params: recipe.inputTemplate,
  });

  if (injection) {
    writeAuditEntry({
      timestamp: new Date().toISOString(),
      skill: recipe.skill,
      permissionsUsed: [],
      inputSummary: `source:recipe:${recipe.id}:injection-blocked`.slice(0, 80),
      outcome: "rejected",
      durationMs: Date.now() - start,
    });
    return;
  }

  // 2. Permission check — skill must declare recipeEligible: true
  if (!isRecipeEligible(recipe.skill)) {
    writeAuditEntry({
      timestamp: new Date().toISOString(),
      skill: recipe.skill,
      permissionsUsed: [],
      inputSummary: `source:recipe:${recipe.id}:not-eligible`.slice(0, 80),
      outcome: "rejected",
      durationMs: Date.now() - start,
    });
    return;
  }

  // 3. Execute skill
  let outcome: "success" | "error" = "error";
  try {
    const result = await runSkill(recipe.skill, recipe.inputTemplate);
    outcome = result.success ? "success" : "error";
  } catch {
    outcome = "error";
  }

  // 4. Audit log entry with recipe context
  writeAuditEntry({
    timestamp: new Date().toISOString(),
    skill: recipe.skill,
    permissionsUsed: [],
    inputSummary: `source:recipe:${recipe.id}:${outcome}`.slice(0, 80),
    outcome,
    durationMs: Date.now() - start,
  });

  // 5. Record run and check 3-strike rule
  const updated = store.recordRun(recipe.id, outcome);
  if (updated.consecutiveFailures >= 3) {
    store.deactivateRecipe(recipe.id);
    onDisable(recipe.id, recipe.name);
  }
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Start the recipe scheduler.
 *
 * Loads all currently active recipes, schedules each one with the cron factory,
 * and returns a handle to stop all jobs.
 *
 * Call once at daemon startup, after security hooks are registered.
 */
export function initRecipeScheduler(options: RecipeSchedulerOptions = {}): SchedulerHandle {
  const getTimezone =
    options.getTimezone ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const runSkill = options.runSkill ?? defaultRunSkill;
  const onDisable =
    options.onDisable ??
    ((id: string, name: string) => {
      writeAuditEntry({
        timestamp: new Date().toISOString(),
        skill: "recipe-scheduler",
        permissionsUsed: [],
        inputSummary: `recipe-disabled:${id}:3-consecutive-failures`.slice(0, 80),
        outcome: "error",
        durationMs: 0,
      });
      // Log human-readable notice — in production this would also message channels
      writeAuditEntry({
        timestamp: new Date().toISOString(),
        skill: "recipe-scheduler",
        permissionsUsed: [],
        inputSummary: `notice:Your "${name}" recipe has stopped after 3 failures`.slice(0, 80),
        outcome: "error",
        durationMs: 0,
      });
    });
  const cronFn = options.cronFn ?? defaultCronFn;

  const getActiveRecipes =
    options.getActiveRecipes ?? (() => store.getAllRecipes().filter((r) => r.active));

  const timezone = getTimezone();
  const activeRecipes = getActiveRecipes();
  const handles: Array<{ stop(): void }> = [];

  for (const recipe of activeRecipes) {
    const capturedRecipe = recipe;
    const handle = cronFn(capturedRecipe.schedule, timezone, () => {
      runWithLock(capturedRecipe.skill, () => executeRecipe(capturedRecipe, runSkill, onDisable));
    });
    handles.push(handle);
  }

  return {
    stop(): void {
      for (const h of handles) {
        try {
          h.stop();
        } catch {
          // ignore
        }
      }
    },
  };
}
