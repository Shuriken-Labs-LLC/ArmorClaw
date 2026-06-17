import { BrowserWindow } from "electron";
import { logger } from "./logger";
import { spawnOpenClaw, sendToOpenClaw, isOpenClawRunning } from "./openclaw";
import {
  getDueCommitments,
  updateCommitment,
  createCommitmentRun,
  finishCommitmentRun,
  writeAuditEntry,
  getAppState,
  getWorkspace,
  getProject,
  type Commitment,
} from "./repositories";

const POLL_INTERVAL_MS = 30_000;

let timer: ReturnType<typeof setInterval> | null = null;
let getMainWindow: () => BrowserWindow | null = () => null;

export function startScheduler(windowGetter: () => BrowserWindow | null): void {
  getMainWindow = windowGetter;
  logger.info("Commitment scheduler started");
  timer = setInterval(tick, POLL_INTERVAL_MS);
  tick();
}

export function stopScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  logger.info("Commitment scheduler stopped");
}

function tick(): void {
  try {
    const now = Date.now();
    const due = getDueCommitments(now);
    for (const commitment of due) {
      handleDueCommitment(commitment, now);
    }
  } catch (err) {
    logger.error(`Scheduler tick error: ${String(err)}`);
  }
}

function handleDueCommitment(commitment: Commitment, now: number): void {
  const missedBy = now - (commitment.nextFireAt ?? now);
  const wasMissed = missedBy > POLL_INTERVAL_MS * 2;

  if (wasMissed) {
    handleMissedRun(commitment, now);
    return;
  }

  executeCommitment(commitment, now);
}

function handleMissedRun(commitment: Commitment, now: number): void {
  const appState = getAppState();
  const policy = commitment.missedRunPolicy === "ask"
    ? appState.missedRunDefault
    : commitment.missedRunPolicy;

  switch (policy) {
    case "skip": {
      const run = createCommitmentRun(commitment.id, "skipped", "Missed while device was off");
      finishCommitmentRun(run.id, "skipped", "Missed while device was off");
      writeAuditEntry("commitment.skipped", {
        commitmentId: commitment.id,
        description: commitment.description,
        reason: "missed_run_skip",
      }, commitment.workspaceId, commitment.projectId);
      advanceNextFire(commitment, now);
      notifyRenderer("commitment:skipped", { commitmentId: commitment.id, description: commitment.description });
      logger.info(`Commitment ${commitment.id} skipped (missed run, policy=skip)`);
      break;
    }
    case "next_wake": {
      executeCommitment(commitment, now);
      break;
    }
    default: {
      // "ask" — notify user and wait
      notifyRenderer("commitment:missed", {
        commitmentId: commitment.id,
        description: commitment.description,
        missedAt: commitment.nextFireAt,
      });
      logger.info(`Commitment ${commitment.id} missed, asking user`);
      break;
    }
  }
}

function executeCommitment(commitment: Commitment, now: number): void {
  const run = createCommitmentRun(commitment.id, "completed");

  updateCommitment(commitment.id, { lastRunAt: now });

  writeAuditEntry("commitment.fired", {
    commitmentId: commitment.id,
    runId: run.id,
    description: commitment.description,
    actionTemplate: commitment.actionTemplate,
  }, commitment.workspaceId, commitment.projectId);

  if (!isOpenClawRunning()) {
    const ws = getWorkspace(commitment.workspaceId);
    const proj = getProject(commitment.projectId);
    spawnOpenClaw(
      ws?.name ?? "Workspace",
      proj?.name ?? "Project",
      commitment.workspaceId,
      commitment.projectId,
    );
  }

  const sent = sendToOpenClaw(commitment.actionTemplate);
  if (sent) {
    finishCommitmentRun(run.id, "completed", "Sent to OpenClaw");
  } else {
    finishCommitmentRun(run.id, "failed", "OpenClaw not available");
  }

  notifyRenderer("commitment:fired", {
    commitmentId: commitment.id,
    runId: run.id,
    description: commitment.description,
  });

  advanceNextFire(commitment, now);

  logger.info(`Commitment ${commitment.id} fired: ${commitment.description}`);
}

function advanceNextFire(commitment: Commitment, now: number): void {
  if (commitment.triggerType === "time") {
    // One-shot: mark done
    updateCommitment(commitment.id, { status: "done", nextFireAt: undefined });
    return;
  }

  if (commitment.triggerType === "interval") {
    try {
      const spec = JSON.parse(commitment.triggerSpec) as { intervalMs: number };
      const next = now + spec.intervalMs;
      updateCommitment(commitment.id, { nextFireAt: next });
    } catch {
      logger.error(`Invalid interval spec for commitment ${commitment.id}: ${commitment.triggerSpec}`);
      updateCommitment(commitment.id, { status: "failed" });
    }
  }
}

function notifyRenderer(channel: string, data: Record<string, unknown>): void {
  const win = getMainWindow();
  if (win) {
    win.webContents.send(channel, data);
  }
}
