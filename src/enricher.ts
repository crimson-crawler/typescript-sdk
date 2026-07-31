/**
 * Enricher API — key-authed access to the async artifact-enrichment engine (submit → poll).
 *
 * A thin wrapper over the `/v1/artifact-enrich` engine endpoints: `client.enricher.enrich` stages
 * artifacts, submits to the engine, polls until done, and returns the report. There is no save/discard —
 * the engine pair is submit→poll only; persistence is the portal's job, not the API's.
 *
 * Same API key, same base URL, same retry/timeout fetch as every other call. The enrichment submit is
 * enrichment compute and **counts toward your API usage** (it's a `/v1/artifact-enrich` request); polling
 * is the engine's own status read. Exposed as `client.enricher` (mirrors the Python `EnricherAPI`).
 */

import { ProgressCallback, pollUntilDone } from "./_poll";
import { UnexpectedStatus } from "./exceptions";
import { pathSegment } from "./url";

/** A fetch-like function — the CrawlerClient hands in its retry/timeout wrapper. */
export type EnricherFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Client for the artifact-enrichment engine (the async submit→poll lifecycle).
 *
 * Obtained via `client.enricher` — never constructed directly.
 * Every method throws `UnexpectedStatus` on a non-2xx response.
 */
export class EnricherApi {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly doFetch: EnricherFetch;

  constructor(baseUrl: string, apiKey: string, doFetch: EnricherFetch) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.doFetch = doFetch;
  }

  private async request(
    method: string,
    path: string,
    opts: { params?: Record<string, string>; json?: unknown } = {},
  ): Promise<Response> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(opts.params ?? {}))
      url.searchParams.set(k, v);
    const resp = await this.doFetch(url, {
      method,
      headers: {
        apikey: this.apiKey,
        ...(opts.json !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
      },
      ...(opts.json !== undefined ? { body: JSON.stringify(opts.json) } : {}),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new UnexpectedStatus(
        resp.status,
        body,
        `Enricher API ${resp.status} on ${path}`,
      );
    }
    return resp;
  }

  /**
   * Run an artifact enrichment end-to-end against the /v1 engine: submit → poll → return the report.
   *
   * Stages pasted `text` + base64 `files` (`[{ filename, content_b64 }]`), submits to
   * `/v1/artifact-enrich`, polls the job until done, and resolves to the enrichment report.
   *
   * `stakeholder` is the optional SSVC stakeholder context applied to every reference when `include`
   * contains `"ssvc"` (`{ method, exposure, human_impact, mission_prevalence, public_wellbeing_impact }`;
   * omit to use the engine's CISA-coordinator defaults).
   *
   * Counts toward your API usage (it's `/v1/artifact-enrich` compute). Throws `UnexpectedStatus` on a
   * non-2xx (or enrichment error), or `Error` if the enrichment doesn't finish within `timeoutMs`.
   * Resolves to `{ enrichment_id, report }`.
   */
  async enrich(
    options: {
      text?: string;
      files?: Array<{ filename: string; content_b64: string }>;
      formats?: string[];
      include?: string[];
      stakeholder?: Record<string, unknown>;
      pollIntervalMs?: number;
      timeoutMs?: number;
      /** Called with the live job (`{ status, progress, events }`, each event carrying the % it reached)
       *  on every poll — render a live bar / stream the per-reference feed. Polls are billing-exempt. */
      onProgress?: ProgressCallback;
      /** Save the finished report into your Artifact Manager library after it completes (the `/v1` engine
       *  returns the report but never persists it) — the one-call equivalent of `enrich` then
       *  `artifactManager.saveEnrichment`. When saved, the result also carries `saved`. Usage-exempt. */
      save?: boolean;
      /** File the saved report into this folder id (with `save`). */
      folderId?: string | null;
      /** File the saved report into a NEW folder of this name (with `save`). */
      newFolderName?: string | null;
    } = {},
  ): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {};
    if (options.text) body.text = options.text;
    if (options.files) body.files = options.files;
    if (options.formats) body.formats = options.formats;
    if (options.include) body.include = options.include;
    if (options.stakeholder) body.stakeholder = options.stakeholder;

    const submit = (await (
      await this.request("POST", "/v1/artifact-enrich", { json: body })
    ).json()) as { enrichment_id: string };
    const enrichmentId = submit.enrichment_id;
    const job = await pollUntilDone(
      (m, p) => this.request(m, p),
      enrichmentId,
      `/v1/artifact-enrich/${pathSegment(enrichmentId)}`,
      {
        pollIntervalMs: options.pollIntervalMs ?? 3000,
        timeoutMs: options.timeoutMs ?? 300_000,
        onProgress: options.onProgress,
      },
    );
    // snake_case `enrichment_id` to match the Python SDK.
    const result: Record<string, unknown> = {
      enrichment_id: enrichmentId,
      report: job.result,
    };
    if (options.save) {
      const saveBody: Record<string, unknown> = { enrichment_id: enrichmentId };
      if (options.folderId || options.newFolderName) {
        saveBody.folder = {
          folder_id: options.folderId ?? null,
          new_folder_name: options.newFolderName ?? null,
        };
      }
      result.saved = await (
        await this.request(
          "POST",
          "/artifact-manager/artifacts/from-enrichment",
          { json: saveBody },
        )
      ).json();
    }
    return result;
  }
}
