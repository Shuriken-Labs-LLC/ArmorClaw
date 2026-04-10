import type { Recipe } from "../types.ts";
import dailyBriefing from "./daily-briefing.ts";
import fileWatcher from "./file-watcher.ts";
import morningInbox from "./morning-inbox.ts";
import weeklySummary from "./weekly-summary.ts";

export const BUNDLED_RECIPES: readonly Recipe[] = [
  morningInbox,
  dailyBriefing,
  fileWatcher,
  weeklySummary,
];
