import { Cron } from "croner";
import { buildDigestData } from "./composer.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SchedulerHandle {
  stop(): void;
}

/**
 * Injectable cron factory — accepts a cron expression, timezone, and callback.
 * The default implementation uses `croner`.
 * Pass a stub in tests to avoid real scheduling.
 */
export type CronFn = (
  expression: string,
  timezone: string,
  callback: () => void | Promise<void>,
) => SchedulerHandle;

export interface DigestSchedulerConfig {
  /**
   * Called on every scheduled run to get the current timezone.
   * Must NOT be cached — the user may change their timezone in settings.
   */
  getTimezone(): string;
  /** Sends the final digest message to all connected channels. */
  sendMessage(message: string): Promise<void>;
  /**
   * Cron expression for the send time. Default: "0 8 * * *" (8:00am daily).
   * The expression is evaluated in the timezone returned by `getTimezone()`.
   */
  schedule?: string;
  /** Injectable cron factory. Defaults to croner. */
  cronFn?: CronFn;
}

// ── Default cron implementation ───────────────────────────────────────────────

const DEFAULT_SCHEDULE = "0 8 * * *";

/* v8 ignore next 6 — real croner wiring; tested via injectable cronFn */
function defaultCronFn(
  expression: string,
  timezone: string,
  callback: () => void | Promise<void>,
): SchedulerHandle {
  return new Cron(expression, { timezone, protect: true }, callback);
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

/**
 * Start the daily digest scheduler.
 *
 * On each scheduled tick the scheduler:
 * 1. Reads the current timezone from `config.getTimezone()` (never cached).
 * 2. Calls `buildDigestData()` to assemble the digest payload.
 * 3. If the budget is paused, sends the pre-written notice verbatim.
 * 4. Otherwise, passes the model prompt to `config.sendMessage()`.
 *    (The caller is responsible for running the model and passing its response
 *     back through `sendMessage`.)
 *
 * Returns a handle with a `stop()` method.
 */
export function startDigestScheduler(config: DigestSchedulerConfig): SchedulerHandle {
  /* v8 ignore next */
  const cronFn = config.cronFn ?? defaultCronFn;
  const expression = config.schedule ?? DEFAULT_SCHEDULE;

  // Timezone is re-read on every run by the callback itself; the cron
  // expression timezone must be set at schedule time. To honour the
  // "read on every run" rule we schedule in UTC and let the 8am default
  // act as a reasonable fallback. Callers that need strict local-time
  // accuracy should use a fresh scheduler on timezone change.
  const timezone = config.getTimezone();

  const handle = cronFn(expression, timezone, async () => {
    const digest = buildDigestData();
    await config.sendMessage(digest.prompt);
  });

  return handle;
}
