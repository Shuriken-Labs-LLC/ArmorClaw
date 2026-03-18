import type { Recipe } from "../types.ts";

const dailyBriefing: Recipe = {
  id: "daily-briefing",
  name: "Daily calendar briefing",
  description: "Pulls your first 3 calendar events and delivers a morning briefing every weekday.",
  skill: "email-calendar",
  defaultSchedule: "0 8 * * 1-5",
  scheduleLabel: "Weekdays at 8am",
  inputTemplate: { action: "daily-briefing" },
  undoable: false,
};

export default dailyBriefing;
