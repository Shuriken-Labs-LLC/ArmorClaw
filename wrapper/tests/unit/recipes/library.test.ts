/**
 * Unit tests for the bundled recipe library.
 *
 * Validates that every recipe definition is well-formed and consistent.
 */

import { describe, expect, it } from "vitest";
import { BUNDLED_RECIPES } from "../../../recipes/library/index.ts";
import type { Recipe } from "../../../recipes/types.ts";

// Valid cron expression regex (basic sanity — 5 fields)
const CRON_RE = /^(\S+\s+){4}\S+$/;

describe("BUNDLED_RECIPES", () => {
  it("exports exactly 4 recipes", () => {
    expect(BUNDLED_RECIPES).toHaveLength(4);
  });

  it("includes the expected recipe ids", () => {
    const ids = BUNDLED_RECIPES.map((r) => r.id);
    expect(ids).toContain("morning-inbox");
    expect(ids).toContain("daily-briefing");
    expect(ids).toContain("file-watcher");
    expect(ids).toContain("weekly-summary");
  });

  it("has no duplicate ids", () => {
    const ids = BUNDLED_RECIPES.map((r) => r.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  describe.each(BUNDLED_RECIPES.map((r) => [r.id, r] as [string, Recipe]))(
    "recipe: %s",
    (_id, recipe) => {
      it("has a non-empty id in kebab-case", () => {
        expect(recipe.id).toMatch(/^[a-z][a-z0-9-]+$/);
      });

      it("has a non-empty name", () => {
        expect(typeof recipe.name).toBe("string");
        expect(recipe.name.trim().length).toBeGreaterThan(0);
      });

      it("has a non-empty description", () => {
        expect(typeof recipe.description).toBe("string");
        expect(recipe.description.trim().length).toBeGreaterThan(0);
      });

      it("has a non-empty skill string", () => {
        expect(typeof recipe.skill).toBe("string");
        expect(recipe.skill.trim().length).toBeGreaterThan(0);
      });

      it("has a valid 5-field cron expression as defaultSchedule", () => {
        expect(recipe.defaultSchedule).toMatch(CRON_RE);
      });

      it("has a non-empty scheduleLabel", () => {
        expect(typeof recipe.scheduleLabel).toBe("string");
        expect(recipe.scheduleLabel.trim().length).toBeGreaterThan(0);
      });

      it("has an inputTemplate object", () => {
        expect(typeof recipe.inputTemplate).toBe("object");
        expect(recipe.inputTemplate).not.toBeNull();
      });

      it("has an action field in inputTemplate", () => {
        expect(recipe.inputTemplate).toHaveProperty("action");
      });

      it("has a boolean undoable field", () => {
        expect(typeof recipe.undoable).toBe("boolean");
      });
    },
  );

  it("morning-inbox uses email-calendar skill", () => {
    const r = BUNDLED_RECIPES.find((x) => x.id === "morning-inbox")!;
    expect(r.skill).toBe("email-calendar");
  });

  it("daily-briefing uses email-calendar skill", () => {
    const r = BUNDLED_RECIPES.find((x) => x.id === "daily-briefing")!;
    expect(r.skill).toBe("email-calendar");
  });

  it("file-watcher uses secure-files skill", () => {
    const r = BUNDLED_RECIPES.find((x) => x.id === "file-watcher")!;
    expect(r.skill).toBe("secure-files");
  });

  it("weekly-summary uses digest skill", () => {
    const r = BUNDLED_RECIPES.find((x) => x.id === "weekly-summary")!;
    expect(r.skill).toBe("digest");
  });

  it("file-watcher default schedule is every 30 minutes", () => {
    const r = BUNDLED_RECIPES.find((x) => x.id === "file-watcher")!;
    expect(r.defaultSchedule).toBe("*/30 * * * *");
  });

  it("weekly-summary default schedule is Fridays 5pm", () => {
    const r = BUNDLED_RECIPES.find((x) => x.id === "weekly-summary")!;
    expect(r.defaultSchedule).toBe("0 17 * * 5");
  });
});
