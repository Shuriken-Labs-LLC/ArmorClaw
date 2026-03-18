import type { Recipe } from "../types.ts";

const weeklySummary: Recipe = {
  id: "weekly-summary",
  name: "Weekly activity summary",
  description:
    "Compiles a summary of the week's agent activity and sends it to your connected channels every Friday.",
  skill: "digest",
  defaultSchedule: "0 17 * * 5",
  scheduleLabel: "Fridays at 5pm",
  inputTemplate: { action: "weekly-summary" },
  undoable: false,
};

export default weeklySummary;
