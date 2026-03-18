import type { Recipe } from "../types.ts";

const overdueLeads: Recipe = {
  id: "overdue-leads",
  name: "Surface overdue leads",
  description:
    "Lists CRM contacts you haven't followed up with in over 14 days, every Monday morning.",
  skill: "crm-leadgen",
  defaultSchedule: "0 9 * * 1",
  scheduleLabel: "Mondays at 9am",
  inputTemplate: { action: "overdue-followups", staleAfterDays: 14 },
  undoable: false,
};

export default overdueLeads;
