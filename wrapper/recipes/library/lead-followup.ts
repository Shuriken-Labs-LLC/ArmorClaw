import type { Recipe } from "../types.ts";

const leadFollowup: Recipe = {
  id: "lead-followup",
  name: "Draft follow-up sequences",
  description:
    "Drafts follow-up email sequences for contacts that haven't been reached recently, weekday evenings.",
  skill: "crm-leadgen",
  defaultSchedule: "0 17 * * 1-5",
  scheduleLabel: "Weekdays at 5pm",
  inputTemplate: { action: "overdue-followups", staleAfterDays: 7 },
  undoable: false,
};

export default leadFollowup;
