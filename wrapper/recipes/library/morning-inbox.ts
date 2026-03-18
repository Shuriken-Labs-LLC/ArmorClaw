import type { Recipe } from "../types.ts";

const morningInbox: Recipe = {
  id: "morning-inbox",
  name: "Morning inbox triage",
  description: "Summarises your unread emails and flags action items every weekday morning.",
  skill: "email-calendar",
  defaultSchedule: "0 8 * * 1-5",
  scheduleLabel: "Weekdays at 8am",
  inputTemplate: { action: "triage" },
  undoable: false,
};

export default morningInbox;
