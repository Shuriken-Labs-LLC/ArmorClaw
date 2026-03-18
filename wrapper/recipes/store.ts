/**
 * Recipe store — persists user state to ~/.armorclaw/recipes.json.
 *
 * Responsibilities:
 *  - Read/write recipe state (active, schedule override, lastRun, outcome)
 *  - Merge library definitions with user state into RecipeWithState objects
 *  - Expose clean activate/deactivate/updateSchedule/recordRun API
 *
 * File format: JSON object mapping recipeId → RecipeState.
 * In-memory cache is kept in sync; file is written synchronously on every change.
 * All I/O errors are swallowed — the in-memory cache always wins.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Cron } from "croner";
import { BUNDLED_RECIPES } from "./library/index.ts";
import type { Recipe, RecipeRunOutcome, RecipeState, RecipeWithState } from "./types.ts";

// ── File path ─────────────────────────────────────────────────────────────────

let _filePathOverride: string | null = null;

function recipesFilePath(): string {
  return _filePathOverride ?? join(homedir(), ".armorclaw", "recipes.json");
}

/** Override the file path. Pass null to restore the default. Test use only. */
export function setRecipesFilePathForTesting(path: string | null): void {
  _filePathOverride = path;
  _cache = null;
}

// ── In-memory cache ───────────────────────────────────────────────────────────

type StoredState = Record<string, RecipeState>;

let _cache: StoredState | null = null;

function readStore(): StoredState {
  if (_cache !== null) {
    return _cache;
  }
  try {
    const raw = readFileSync(recipesFilePath(), "utf8");
    _cache = JSON.parse(raw) as StoredState;
  } catch {
    _cache = {};
  }
  return _cache;
}

function writeStore(state: StoredState): void {
  _cache = state;
  try {
    const dir = join(homedir(), ".armorclaw");
    mkdirSync(dir, { recursive: true });
    writeFileSync(recipesFilePath(), JSON.stringify(state, null, 2), "utf8");
  } catch {
    // I/O failure — in-memory cache stays updated, write is best-effort
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function defaultState(): RecipeState {
  return { active: false, consecutiveFailures: 0 };
}

/**
 * Compute the ISO timestamp of the next scheduled run for a cron expression.
 * Returns undefined when the expression is invalid.
 */
function computeNextRun(expression: string): string | undefined {
  try {
    const job = new Cron(expression);
    const next = job.nextRun();
    job.stop();
    return next?.toISOString();
  } catch {
    return undefined;
  }
}

function mergeRecipe(recipe: Recipe, state: RecipeState): RecipeWithState {
  const schedule = state.scheduleOverride ?? recipe.defaultSchedule;
  const scheduleLabel = state.scheduleOverride
    ? `Custom: ${state.scheduleOverride}`
    : recipe.scheduleLabel;

  return {
    ...recipe,
    active: state.active,
    schedule,
    scheduleLabel,
    lastRun: state.lastRun,
    lastOutcome: state.lastOutcome,
    consecutiveFailures: state.consecutiveFailures,
    nextRun: computeNextRun(schedule),
  };
}

function getRecipeDefinition(id: string): Recipe | undefined {
  return BUNDLED_RECIPES.find((r) => r.id === id);
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Return a single recipe merged with its user state, or undefined if unknown. */
export function getRecipe(id: string): RecipeWithState | undefined {
  const recipe = getRecipeDefinition(id);
  if (!recipe) {
    return undefined;
  }
  const state = readStore()[id] ?? defaultState();
  return mergeRecipe(recipe, state);
}

/** Return all bundled recipes merged with their user state. */
export function getAllRecipes(): RecipeWithState[] {
  const store = readStore();
  return BUNDLED_RECIPES.map((recipe) => {
    const state = store[recipe.id] ?? defaultState();
    return mergeRecipe(recipe, state);
  });
}

/** Mark a recipe as active. Creates a state entry if none exists. */
export function activateRecipe(id: string): void {
  const store = readStore();
  store[id] = { ...(store[id] ?? defaultState()), active: true };
  writeStore(store);
}

/** Mark a recipe as inactive. */
export function deactivateRecipe(id: string): void {
  const store = readStore();
  store[id] = { ...(store[id] ?? defaultState()), active: false };
  writeStore(store);
}

/** Override the cron schedule for a recipe. Clears any previous override. */
export function updateSchedule(id: string, cronExpression: string): void {
  const store = readStore();
  store[id] = { ...(store[id] ?? defaultState()), scheduleOverride: cronExpression };
  writeStore(store);
}

/**
 * Record the outcome of a recipe run.
 * - success: resets consecutiveFailures to 0.
 * - error:   increments consecutiveFailures.
 *
 * Returns the updated RecipeWithState so callers can check consecutiveFailures.
 * Throws if the recipe id is not in the library.
 */
export function recordRun(id: string, outcome: RecipeRunOutcome): RecipeWithState {
  const recipe = getRecipeDefinition(id);
  if (!recipe) {
    throw new Error(`Recipe "${id}" not found in library.`);
  }

  const store = readStore();
  const prev = store[id] ?? defaultState();

  store[id] = {
    ...prev,
    lastRun: new Date().toISOString(),
    lastOutcome: outcome,
    consecutiveFailures: outcome === "success" ? 0 : (prev.consecutiveFailures ?? 0) + 1,
  };

  writeStore(store);
  return mergeRecipe(recipe, store[id]);
}

/** Clear in-memory cache. Test isolation only. */
export function clearStoreForTesting(): void {
  _cache = null;
}
