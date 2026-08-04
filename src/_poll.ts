/**
 * Shared submit→poll core for the two async-enrichment engines (Enricher + Inventory).
 *
 * Both `client.enricher.enrich` and `client.inventoryManager.enrichInventory` submit a job to a
 * `/v1/*-enrich` engine and poll `GET /v1/*-enrich/{id}` until it finishes. The loop lives here so the
 * two engines can't drift — and so a single place carries the optional `onProgress` callback that
 * surfaces the LIVE job (status, per-stage progress, and the granular `events[]` feed — each event
 * stamped with the overall % it reached) on every tick. Mirrors the Python SDK's `_poll.py`. Status
 * polls are billing-exempt, so calling back frequently costs no usage.
 */

import { UnexpectedStatus } from "./exceptions";

/** Called with the raw job dict each poll: `{ status, progress, stages, events, result? }`. May be sync
 *  or async; any error it throws is swallowed (telemetry must never break the poll). */
export type ProgressCallback = (
  job: Record<string, unknown>,
) => void | Promise<void>;

function timeoutError(enrichmentId: string): Error {
  return new Error(
    `enrichment ${enrichmentId} did not finish within the timeout`,
  );
}

function remainingMs(deadline: number): number {
  return deadline - performance.now();
}

// The deadline arm RESOLVES with this instead of rejecting. A rejecting race loser is
// reported globally the moment the race has already settled — under fake timers both
// arms can fire in one tick, so the late rejection reaches neither `Promise.race` nor
// a `.catch`, and vitest exits non-zero with every test passing. A resolving arm
// cannot be an unhandled rejection, so the timeout is raised by the caller below.
const TIMED_OUT = Symbol("poll-deadline-elapsed");

async function beforeDeadline<T>(
  operation: Promise<T>,
  remaining: number,
  enrichmentId: string,
): Promise<T> {
  if (remaining <= 0) throw timeoutError(enrichmentId);
  let cancelDeadline = () => {};
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    const timer = setTimeout(() => resolve(TIMED_OUT), remaining);
    cancelDeadline = () => clearTimeout(timer);
  });
  // When the deadline wins, `operation` is abandoned; a later rejection from it would
  // otherwise surface globally too.
  void Promise.resolve(operation).catch(() => undefined);
  try {
    const outcome = await Promise.race([operation, deadline]);
    if (outcome === TIMED_OUT) throw timeoutError(enrichmentId);
    return outcome as T;
  } finally {
    cancelDeadline();
  }
}

async function emit(
  onProgress: ProgressCallback | undefined,
  job: Record<string, unknown>,
  remaining: number,
  enrichmentId: string,
): Promise<void> {
  if (!onProgress) return;
  const callback = Promise.resolve()
    .then(() => onProgress(job))
    .then(() => undefined)
    .catch(() => undefined);
  await beforeDeadline(callback, remaining, enrichmentId);
}

export function validatePollOptions(
  pollIntervalMs: number,
  timeoutMs: number,
): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RangeError("timeoutMs must be finite and non-negative");
  }
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) {
    throw new RangeError("pollIntervalMs must be finite and non-negative");
  }
}

/** Poll a `/v1` async-enrichment job to completion and resolve its final job dict. Calls `onProgress(job)`
 *  on every tick (including the terminal `done` poll, so a UI can show 100%). `timeoutMs` is a hard
 *  end-to-end deadline covering status fetches, body reads, callbacks, and sleeps. Throws
 *  `UnexpectedStatus` on an engine error, or `Error` on the deadline. */
export async function pollUntilDone(
  request: (
    method: string,
    path: string,
    timeoutMs: number,
  ) => Promise<Response>,
  enrichmentId: string,
  statusPath: string,
  opts: {
    pollIntervalMs: number;
    timeoutMs: number;
    onProgress?: ProgressCallback;
  },
): Promise<Record<string, unknown>> {
  validatePollOptions(opts.pollIntervalMs, opts.timeoutMs);

  const deadline = performance.now() + opts.timeoutMs;
  for (;;) {
    let remaining = remainingMs(deadline);
    const resp = await beforeDeadline(
      request("GET", statusPath, remaining),
      remaining,
      enrichmentId,
    );

    remaining = remainingMs(deadline);
    const job = (await beforeDeadline(
      resp.json() as Promise<Record<string, unknown>>,
      remaining,
      enrichmentId,
    )) as Record<string, unknown>;

    remaining = remainingMs(deadline);
    await emit(opts.onProgress, job, remaining, enrichmentId);
    if (remainingMs(deadline) <= 0) throw timeoutError(enrichmentId);

    if (job.status === "done") return job;
    if (job.status === "error") {
      throw new UnexpectedStatus(
        502,
        "",
        `enrichment ${enrichmentId} errored: ${String(job.error)}`,
      );
    }

    remaining = remainingMs(deadline);
    await beforeDeadline(
      new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(opts.pollIntervalMs, remaining)),
      ),
      remaining,
      enrichmentId,
    );
    if (remainingMs(deadline) <= 0) throw timeoutError(enrichmentId);
  }
}
