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
export type ProgressCallback = (job: Record<string, unknown>) => void | Promise<void>;

async function emit(onProgress: ProgressCallback | undefined, job: Record<string, unknown>): Promise<void> {
  if (!onProgress) return;
  try {
    await onProgress(job);
  } catch {
    // a progress callback must never break the enrichment poll
  }
}

/** Poll a `/v1` async-enrichment job to completion and resolve its final job dict. Calls `onProgress(job)`
 *  on every tick (including the terminal `done` poll, so a UI can show 100%). Throws `UnexpectedStatus`
 *  on an engine error, or `Error` on the deadline. */
export async function pollUntilDone(
  request: (method: string, path: string) => Promise<Response>,
  enrichmentId: string,
  statusPath: string,
  opts: { pollIntervalMs: number; timeoutMs: number; onProgress?: ProgressCallback },
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    const job = (await (await request("GET", statusPath)).json()) as Record<string, unknown>;
    await emit(opts.onProgress, job);
    if (job.status === "done") return job;
    if (job.status === "error") {
      throw new UnexpectedStatus(502, "", `enrichment ${enrichmentId} errored: ${String(job.error)}`);
    }
    await new Promise((r) => setTimeout(r, opts.pollIntervalMs));
  }
  throw new Error(`enrichment ${enrichmentId} did not finish within the timeout`);
}
