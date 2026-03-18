/**
 * Unit tests for the recipe store.
 *
 * Uses a temp file path for all I/O — no writes to ~/.armorclaw.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUNDLED_RECIPES } from "../../../recipes/library/index.ts";
import {
  activateRecipe,
  clearStoreForTesting,
  deactivateRecipe,
  getAllRecipes,
  getRecipe,
  recordRun,
  setRecipesFilePathForTesting,
  updateSchedule,
} from "../../../recipes/store.ts";

// ── Test setup ────────────────────────────────────────────────────────────────

const TMP_DIR = join(tmpdir(), "armorclaw-store-test-" + Date.now());
const TMP_FILE = join(TMP_DIR, "recipes.json");

beforeEach(() => {
  mkdirSync(TMP_DIR, { recursive: true });
  setRecipesFilePathForTesting(TMP_FILE);
  clearStoreForTesting();
});

afterEach(() => {
  setRecipesFilePathForTesting(null);
  clearStoreForTesting();
  try {
    rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const FIRST_ID = BUNDLED_RECIPES[0].id;
const SECOND_ID = BUNDLED_RECIPES[1].id;

// ── getAllRecipes ─────────────────────────────────────────────────────────────

describe("getAllRecipes", () => {
  it("returns one entry per bundled recipe", () => {
    const recipes = getAllRecipes();
    expect(recipes).toHaveLength(BUNDLED_RECIPES.length);
  });

  it("merges recipe definition with default state (inactive)", () => {
    const recipes = getAllRecipes();
    for (const r of recipes) {
      expect(r.active).toBe(false);
      expect(r.consecutiveFailures).toBe(0);
    }
  });

  it("uses defaultSchedule as effective schedule when no override", () => {
    const recipes = getAllRecipes();
    for (const r of recipes) {
      const def = BUNDLED_RECIPES.find((b) => b.id === r.id)!;
      expect(r.schedule).toBe(def.defaultSchedule);
    }
  });

  it("computes a nextRun ISO string for valid cron expressions", () => {
    const recipes = getAllRecipes();
    for (const r of recipes) {
      // nextRun may be undefined for invalid cron but all bundled have valid ones
      if (r.nextRun !== undefined) {
        expect(r.nextRun).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      }
    }
  });
});

// ── getRecipe ─────────────────────────────────────────────────────────────────

describe("getRecipe", () => {
  it("returns undefined for unknown id", () => {
    expect(getRecipe("not-a-recipe")).toBeUndefined();
  });

  it("returns the merged recipe for a known id", () => {
    const r = getRecipe(FIRST_ID);
    expect(r).toBeDefined();
    expect(r!.id).toBe(FIRST_ID);
  });

  it("inactive by default", () => {
    const r = getRecipe(FIRST_ID)!;
    expect(r.active).toBe(false);
  });
});

// ── activateRecipe / deactivateRecipe ─────────────────────────────────────────

describe("activateRecipe", () => {
  it("sets active to true", () => {
    activateRecipe(FIRST_ID);
    expect(getRecipe(FIRST_ID)!.active).toBe(true);
  });

  it("idempotent — activating twice keeps active true", () => {
    activateRecipe(FIRST_ID);
    activateRecipe(FIRST_ID);
    expect(getRecipe(FIRST_ID)!.active).toBe(true);
  });

  it("does not affect other recipes", () => {
    activateRecipe(FIRST_ID);
    expect(getRecipe(SECOND_ID)!.active).toBe(false);
  });
});

describe("deactivateRecipe", () => {
  it("sets active to false after activation", () => {
    activateRecipe(FIRST_ID);
    deactivateRecipe(FIRST_ID);
    expect(getRecipe(FIRST_ID)!.active).toBe(false);
  });

  it("idempotent — deactivating an already-inactive recipe is fine", () => {
    deactivateRecipe(FIRST_ID);
    expect(getRecipe(FIRST_ID)!.active).toBe(false);
  });
});

// ── updateSchedule ────────────────────────────────────────────────────────────

describe("updateSchedule", () => {
  it("overrides the schedule", () => {
    updateSchedule(FIRST_ID, "0 9 * * 1");
    const r = getRecipe(FIRST_ID)!;
    expect(r.schedule).toBe("0 9 * * 1");
  });

  it("sets scheduleLabel to Custom: <expression>", () => {
    updateSchedule(FIRST_ID, "0 9 * * 1");
    const r = getRecipe(FIRST_ID)!;
    expect(r.scheduleLabel).toBe("Custom: 0 9 * * 1");
  });

  it("can override multiple recipes independently", () => {
    updateSchedule(FIRST_ID, "0 9 * * 1");
    updateSchedule(SECOND_ID, "0 * * * *");
    expect(getRecipe(FIRST_ID)!.schedule).toBe("0 9 * * 1");
    expect(getRecipe(SECOND_ID)!.schedule).toBe("0 * * * *");
  });

  it("persists across cache reset", () => {
    updateSchedule(FIRST_ID, "0 7 * * *");
    clearStoreForTesting();
    const r = getRecipe(FIRST_ID)!;
    expect(r.schedule).toBe("0 7 * * *");
  });
});

// ── recordRun ─────────────────────────────────────────────────────────────────

describe("recordRun", () => {
  it("throws for unknown recipe id", () => {
    expect(() => recordRun("not-a-recipe", "success")).toThrow('Recipe "not-a-recipe" not found');
  });

  it("records lastRun as an ISO timestamp", () => {
    const before = new Date().toISOString();
    recordRun(FIRST_ID, "success");
    const after = new Date().toISOString();
    const r = getRecipe(FIRST_ID)!;
    expect(r.lastRun).toBeDefined();
    expect(r.lastRun! >= before).toBe(true);
    expect(r.lastRun! <= after).toBe(true);
  });

  it("records lastOutcome: success", () => {
    recordRun(FIRST_ID, "success");
    expect(getRecipe(FIRST_ID)!.lastOutcome).toBe("success");
  });

  it("records lastOutcome: error", () => {
    recordRun(FIRST_ID, "error");
    expect(getRecipe(FIRST_ID)!.lastOutcome).toBe("error");
  });

  it("resets consecutiveFailures to 0 on success", () => {
    recordRun(FIRST_ID, "error");
    recordRun(FIRST_ID, "error");
    recordRun(FIRST_ID, "success");
    expect(getRecipe(FIRST_ID)!.consecutiveFailures).toBe(0);
  });

  it("increments consecutiveFailures on each error", () => {
    recordRun(FIRST_ID, "error");
    expect(getRecipe(FIRST_ID)!.consecutiveFailures).toBe(1);
    recordRun(FIRST_ID, "error");
    expect(getRecipe(FIRST_ID)!.consecutiveFailures).toBe(2);
    recordRun(FIRST_ID, "error");
    expect(getRecipe(FIRST_ID)!.consecutiveFailures).toBe(3);
  });

  it("returns the updated RecipeWithState", () => {
    const updated = recordRun(FIRST_ID, "success");
    expect(updated.id).toBe(FIRST_ID);
    expect(updated.consecutiveFailures).toBe(0);
    expect(updated.lastOutcome).toBe("success");
  });

  it("does not reset consecutiveFailures after another error following success", () => {
    recordRun(FIRST_ID, "success");
    recordRun(FIRST_ID, "error");
    expect(getRecipe(FIRST_ID)!.consecutiveFailures).toBe(1);
  });
});

// ── File persistence ──────────────────────────────────────────────────────────

describe("persistence", () => {
  it("persists activate state to file and re-reads after cache clear", () => {
    activateRecipe(FIRST_ID);
    clearStoreForTesting(); // force re-read from disk
    expect(getRecipe(FIRST_ID)!.active).toBe(true);
  });

  it("starts fresh when file does not exist", () => {
    // file was never written — should default gracefully
    try {
      rmSync(TMP_FILE);
    } catch {
      /* absent */
    }
    clearStoreForTesting();
    const r = getRecipe(FIRST_ID)!;
    expect(r.active).toBe(false);
    expect(r.consecutiveFailures).toBe(0);
  });

  it("handles a corrupt file gracefully by starting fresh", () => {
    writeFileSync(TMP_FILE, "not valid json", "utf8");
    clearStoreForTesting();
    expect(() => getAllRecipes()).not.toThrow();
    const r = getRecipe(FIRST_ID)!;
    expect(r.active).toBe(false);
  });
});
