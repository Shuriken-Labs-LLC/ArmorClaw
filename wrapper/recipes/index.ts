/**
 * Public API for the recipes module.
 * Called at daemon startup via wrapper/index.ts.
 */

export { initRecipeScheduler } from "./scheduler.ts";
export {
  getAllRecipes,
  getRecipe,
  activateRecipe,
  deactivateRecipe,
  updateSchedule,
  recordRun,
} from "./store.ts";
export type { Recipe, RecipeWithState, RecipeRunOutcome } from "./types.ts";
