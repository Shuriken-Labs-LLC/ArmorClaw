import type { Recipe } from "../types.ts";

const fileWatcher: Recipe = {
  id: "file-watcher",
  name: "Notify on new files in sandbox",
  description:
    "Checks your sandbox directory for new or changed files every 30 minutes and notifies you.",
  skill: "secure-files",
  defaultSchedule: "*/30 * * * *",
  scheduleLabel: "Every 30 minutes",
  inputTemplate: { action: "watch", path: "." },
  undoable: false,
};

export default fileWatcher;
