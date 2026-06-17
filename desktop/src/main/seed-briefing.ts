import { listCommitments, createCommitment } from "./repositories";
import { logger } from "./logger";

const BRIEFING_DESCRIPTION = "Morning briefing";
const BRIEFING_ACTION = "Review today's calendar, unread emails, and pending commitments. Summarize what's on my plate in under 200 words.";
const TWENTY_FOUR_HOURS_MS = 24 * 3_600_000;

export function seedMorningBriefing(workspaceId: string, projectId: string): void {
  const existing = listCommitments(projectId);
  if (existing.some((c) => c.description === BRIEFING_DESCRIPTION)) {
    return;
  }

  const now = new Date();
  const tomorrow8am = new Date(now);
  tomorrow8am.setHours(8, 0, 0, 0);
  if (tomorrow8am.getTime() <= now.getTime()) {
    tomorrow8am.setDate(tomorrow8am.getDate() + 1);
  }

  createCommitment(
    workspaceId,
    projectId,
    BRIEFING_DESCRIPTION,
    "interval",
    JSON.stringify({ intervalMs: TWENTY_FOUR_HOURS_MS }),
    BRIEFING_ACTION,
    tomorrow8am.getTime(),
    { autonomy: "autonomous", missedRunPolicy: "next_wake" },
  );

  logger.info(`Seeded morning briefing commitment for project ${projectId}`);
}
