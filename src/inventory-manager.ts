/**
 * Inventory Manager API — key-authed access to YOUR monitored inventory context windows.
 *
 * The Inventory Manager API lives at `/inventory-manager/inventories/*` as its own
 * section, split out of the Artifact Manager API so the two do not cross-contaminate. A
 * **inventory** is a continuously-monitored context window: a manual asset inventory + attached
 * reference artifacts + saved enrichment history, re-enrichable on demand and on a daily schedule.
 *
 * Same API key, same base URL, same retry/timeout fetch as every other call — but
 * **inventoryManager calls never count toward your API usage** (account self-service over your own
 * data), EXCEPT the inventory-enrichment submit (`enrichInventory`), which is enrichment compute and rides
 * your key to `/v1/inventory-enrich`. Exposed as `client.inventoryManager` (mirrors the Python `InventoryManagerAPI`).
 */

import { ProgressCallback, pollUntilDone } from "./_poll";
import { UnexpectedStatus } from "./exceptions";
import { ingestScan as runIngestScan } from "./ingest";
import { pathSegment } from "./url";

/** A fetch-like function — the CrawlerClient hands in its retry/timeout wrapper. */
export type InventoryManagerFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/** Wire form of a scan/inventory file's content. Text formats pass through; the BINARY `xlsx` format is
 *  given as bytes and base64-encoded (the server decodes it for `format='xlsx'`). Isomorphic. */
export function wireContent(content: string | Uint8Array): string {
  if (typeof content === "string") return content;
  if (typeof Buffer !== "undefined")
    return Buffer.from(content).toString("base64");
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < content.length; i += chunk)
    bin += String.fromCharCode(...content.subarray(i, i + chunk));
  return btoa(bin);
}

/** Wire form of a multi-source combine: base64 each source's `content` if it's a `Uint8Array` (xlsx). */
function wireSources(
  sources: Array<{
    content: string | Uint8Array;
    format?: string;
    label?: string;
  }>,
): Array<Record<string, unknown>> {
  return sources.map((s) => ({ ...s, content: wireContent(s.content) }));
}

/** The editable Inventory Manager inventory fields (shared by createInventory / updateInventory). */
export interface InventoryOptions {
  description?: string;
  /** Asset inventory — each `{ product, vendor?, versions?, ecosystem?, category?, criticality?,
   *  notes?, exposure?, environment?, owner?, tags? }`. */
  items?: Array<Record<string, unknown>>;
  monitoring?: boolean;
  /** Attached reference-artifact ids (the inventory's context window). */
  linkedArtifactIds?: string[];
}

/** Build the create/update-inventory body — inventory_name required; other fields ride only when provided. */
function inventoryBody(
  inventoryName: string,
  o: InventoryOptions,
): Record<string, unknown> {
  const body: Record<string, unknown> = { inventory_name: inventoryName };
  if (o.description !== undefined) body.description = o.description;
  if (o.items !== undefined) body.items = o.items;
  if (o.monitoring !== undefined) body.monitoring = o.monitoring;
  if (o.linkedArtifactIds !== undefined)
    body.linked_artifact_ids = o.linkedArtifactIds;
  return body;
}

/**
 * Client for the key-authed Inventory Manager API.
 *
 * Obtained via `client.inventoryManager` — never constructed directly.
 * Every method throws `UnexpectedStatus` on a non-2xx response.
 */
export class InventoryManagerApi {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly doFetch: InventoryManagerFetch;

  constructor(baseUrl: string, apiKey: string, doFetch: InventoryManagerFetch) {
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
        `Inventory Manager API ${resp.status} on ${path}`,
      );
    }
    return resp;
  }

  /**
   * List your Inventory Manager inventories — each a continuously-monitored context window
   * (asset inventory + attached artifacts + saved enrichment history). Newest first, no content.
   */
  async listInventories(): Promise<Record<string, unknown>[]> {
    const resp = await this.request("GET", "/inventory-manager/inventories");
    return ((await resp.json()) as { inventories: Record<string, unknown>[] })
      .inventories;
  }

  /**
   * One inventory as a manifest: `{ inventory_name, description, monitoring, inventory[], attached[],
   * enrichments[] }`. Pull specific artifacts/enrichments via the Artifact Manager API.
   */
  async getInventory(inventoryId: string): Promise<Record<string, unknown>> {
    const resp = await this.request(
      "GET",
      `/inventory-manager/inventories/${pathSegment(inventoryId)}`,
    );
    return (await resp.json()) as Record<string, unknown>;
  }

  /**
   * An inventory as a **one-shot, LLM-ready context window** — a single bounded text bundle
   * (inventory + latest-enrichment findings + what changed + attached excerpts). Returns
   * `{ id, name, inventory_name, description, monitoring, stats, context }` where `context` is
   * the ready-to-use text.
   */
  async getInventoryContext(
    inventoryId: string,
  ): Promise<Record<string, unknown>> {
    const resp = await this.request(
      "GET",
      `/inventory-manager/inventories/${pathSegment(inventoryId)}/context`,
    );
    return (await resp.json()) as Record<string, unknown>;
  }

  /**
   * List an inventory's saved enrichment history — the inventory's `inventory_enrichment` artifacts (newest first,
   * no content; each row's `meta` carries the card stats: asset/CVE/KEV counts, scanned-at, monitoring
   * delta). The data behind the UI's "Previous enrichments" strip.
   */
  async listEnrichments(
    inventoryId: string,
  ): Promise<Record<string, unknown>[]> {
    const resp = await this.request(
      "GET",
      `/inventory-manager/inventories/${pathSegment(inventoryId)}/enrichments`,
    );
    return ((await resp.json()) as { enrichments: Record<string, unknown>[] })
      .enrichments;
  }

  /**
   * CVE-matched difference matrix across 2–12 of your saved INVENTORY enrichments (oldest → newest). The
   * inventory counterpart of `client.artifactManager.compareEnrichments`: each row is one CVE's trajectory —
   * new / resolved / changed / persistent — across the selected inventory enrichments. Returns the `matrix`
   * object (`columns`, `rows`, `counts`).
   */
  async compareEnrichments(
    enrichmentIds: string[],
  ): Promise<Record<string, unknown>> {
    const resp = await this.request(
      "GET",
      "/inventory-manager/inventories/compare",
      {
        params: { ids: enrichmentIds.join(",") },
      },
    );
    return ((await resp.json()) as { matrix: Record<string, unknown> }).matrix;
  }

  /**
   * Create an Inventory Manager inventory (a continuously-monitored context window).
   *
   * @param inventoryName The inventory's display name.
   * @param options `description`, `items` (asset inventory — each `{ product, vendor?, versions?,
   *   ecosystem?, category?, criticality?, notes? }`), `monitoring` (always full depth — no fast/lite
   *   mode), `linkedArtifactIds`.
   * @returns `{ id, item_count }`.
   */
  async createInventory(
    inventoryName: string,
    options: InventoryOptions = {},
  ): Promise<Record<string, unknown>> {
    const resp = await this.request("POST", "/inventory-manager/inventories", {
      json: inventoryBody(inventoryName, options),
    });
    return (await resp.json()) as Record<string, unknown>;
  }

  /**
   * Update an inventory's definition (name, description, inventory, monitoring, attachments).
   * This is a **partial merge** (PATCH): only the fields you pass change — omitted fields are PRESERVED,
   * including the asset-group metadata and daily-report config this method doesn't expose. `inventoryName`
   * is still required by the API. Resolves `{ id, item_count }`.
   */
  async updateInventory(
    inventoryId: string,
    options: InventoryOptions & { inventoryName: string },
  ): Promise<Record<string, unknown>> {
    const resp = await this.request(
      "PATCH",
      `/inventory-manager/inventories/${pathSegment(inventoryId)}`,
      { json: inventoryBody(options.inventoryName, options) },
    );
    return (await resp.json()) as Record<string, unknown>;
  }

  /**
   * Create an inventory by IMPORTING an asset-inventory file (you PICK the format — no auto-detect).
   *
   * @param options `format` — one of `json` (asset JSON), `sbom` (CycloneDX / SPDX SBOM), `csv`,
   *   `nmap` (nmap `-sV` XML), `list` (CPE / purl list), `grype`, `trivy` (SCA JSON), `depcheck`
   *   (OWASP Dependency-Check JSON), `nessus` (`.nessus` XML), `gvm` (OpenVAS / Greenbone XML);
   *   `content` — the file's text; optional `inventoryName` / `description` (override
   *   anything the file carries).
   * @returns `{ id, item_count, imported, format, truncated? }`.
   */
  async importInventory(options: {
    format: string;
    /** The file's text — or a `Uint8Array` for the binary `xlsx` format (base64-encoded for you on the wire). */
    content: string | Uint8Array;
    inventoryName?: string;
    description?: string;
    inventoryId?: string;
    mode?: "replace" | "append";
  }): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {
      format: options.format,
      content: wireContent(options.content),
    };
    if (options.inventoryName !== undefined)
      body.inventory_name = options.inventoryName;
    if (options.description !== undefined)
      body.description = options.description;
    if (options.inventoryId !== undefined) {
      body.inventory_id = options.inventoryId;
      body.mode = options.mode ?? "replace";
    }
    const resp = await this.request(
      "POST",
      "/inventory-manager/inventories/import",
      { json: body },
    );
    return (await resp.json()) as Record<string, unknown>;
  }

  /**
   * Parse + COMBINE several scan / inventory files into ONE deduped asset set WITHOUT saving (the
   * multi-source twin of {@link parseScan}). Stage a CSV + an nmap scan + an SBOM and merge them; duplicate
   * assets are deduped across sources, versions + named groups unioned, the set capped at 200.
   *
   * @param sources A list of `{ content, format?, label? }`. The `format` is **optional** — omit it and the
   *   file's format is auto-detected from its content (+ `label` as a filename hint); pin a `format` only to
   *   override. A binary `xlsx` source can't be sniffed, so it needs `format: "xlsx"` + `Uint8Array` content
   *   (base64-encoded on the wire). A source that fails to parse is ISOLATED (it appears in `per_source` with
   *   its `error`, contributing nothing — never failing the whole call).
   * @returns `{ items, count, asset_groups, truncated?, per_source: [{ label, contributed, truncated?, error? }] }`.
   */
  async parseMulti(
    sources: Array<{
      content: string | Uint8Array;
      format?: string;
      label?: string;
    }>,
  ): Promise<Record<string, unknown>> {
    const resp = await this.request(
      "POST",
      "/inventory-manager/inventories/parse-multi",
      { json: { sources: wireSources(sources) } },
    );
    return (await resp.json()) as Record<string, unknown>;
  }

  /**
   * Import + COMBINE several files into ONE inventory in a single call (the multi-source twin of
   * {@link importInventory}). Each source parses in isolation then merges via the same dedup brain as
   * {@link parseMulti}. No `inventoryId` CREATES a new inventory; with `inventoryId` the combined assets go
   * INTO it (`mode` replace / append), preserving attachments / monitoring.
   */
  async importMulti(options: {
    sources: Array<{
      content: string | Uint8Array;
      format?: string;
      label?: string;
    }>;
    inventoryName?: string;
    description?: string;
    inventoryId?: string;
    mode?: "replace" | "append";
  }): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {
      sources: wireSources(options.sources),
    };
    if (options.inventoryName !== undefined)
      body.inventory_name = options.inventoryName;
    if (options.description !== undefined)
      body.description = options.description;
    if (options.inventoryId !== undefined) {
      body.inventory_id = options.inventoryId;
      body.mode = options.mode ?? "replace";
    }
    const resp = await this.request(
      "POST",
      "/inventory-manager/inventories/import",
      { json: body },
    );
    return (await resp.json()) as Record<string, unknown>;
  }

  /**
   * REPLACE an inventory's asset inventory, PRESERVING its name / description / attached artifacts /
   * monitoring / alert-prefs (the safe alternative to {@link updateInventory}, which resets omitted
   * fields). To edit one field of one asset: {@link getInventory}, change the item in `inventory`, and
   * replace it back. Resolves `{ id, item_count, mode }`.
   */
  async replaceAssets(
    inventoryId: string,
    items: Record<string, unknown>[],
  ): Promise<Record<string, unknown>> {
    const resp = await this.request(
      "PATCH",
      `/inventory-manager/inventories/${pathSegment(inventoryId)}/assets`,
      {
        json: { items, mode: "replace" },
      },
    );
    return (await resp.json()) as Record<string, unknown>;
  }

  /** APPEND assets to an inventory's inventory, preserving everything else. Resolves `{ id, item_count, mode }`. */
  async addAssets(
    inventoryId: string,
    items: Record<string, unknown>[],
  ): Promise<Record<string, unknown>> {
    const resp = await this.request(
      "PATCH",
      `/inventory-manager/inventories/${pathSegment(inventoryId)}/assets`,
      {
        json: { items, mode: "append" },
      },
    );
    return (await resp.json()) as Record<string, unknown>;
  }

  /**
   * Apply a recommended upgrade — set the matched asset's version to the published fix the Inventory
   * Enricher surfaced (`recommended_fix_version` / `recommended_fix_version_kev`), PRESERVING everything
   * else on the inventory. Match is by `product` (case-insensitive; `vendor` disambiguates duplicate
   * product names). Writes the inventory only — it does NOT re-enrich (the next enrichment / daily monitor
   * confirms the CVEs cleared). Resolves `{ id, product, version, item_count }` (404 when no asset matches).
   */
  async applyAssetFix(
    inventoryId: string,
    product: string,
    version: string,
    vendor?: string,
  ): Promise<Record<string, unknown>> {
    const json: Record<string, unknown> = { product, version };
    if (vendor !== undefined) json.vendor = vendor;
    const resp = await this.request(
      "PATCH",
      `/inventory-manager/inventories/${pathSegment(inventoryId)}/asset-version`,
      { json },
    );
    return (await resp.json()) as Record<string, unknown>;
  }

  /** List an inventory's asset-inventory export formats (`json` / `csv` / `cyclonedx` / `spdx`). */
  async listExportFormats(
    inventoryId: string,
  ): Promise<Record<string, unknown>[]> {
    const resp = await this.request(
      "GET",
      `/inventory-manager/inventories/${pathSegment(inventoryId)}/export`,
    );
    return ((await resp.json()) as { formats: Record<string, unknown>[] })
      .formats;
  }

  /**
   * Export an inventory's asset inventory as a file — the resolved value IS the file. Resolves a
   * `string` for the text formats and a `Uint8Array` for the binary `workbook` (write it straight to
   * a `.xlsx` file).
   *
   * @param inventoryId The inventory id.
   * @param format `json` / `csv` / `list` (CPE/purl) / `cyclonedx` / `spdx` (3.0.1) / `spdx2` (SPDX 2.3)
   *   / `workbook` (binary Excel .xlsx). `json` / `csv` / `list` round-trip back through
   *   {@link importInventory}. Defaults to `json`.
   */
  async exportInventory(
    inventoryId: string,
    format = "json",
  ): Promise<string | Uint8Array> {
    const resp = await this.request(
      "GET",
      `/inventory-manager/inventories/${pathSegment(inventoryId)}/export/${pathSegment(format)}`,
    );
    return format === "workbook"
      ? new Uint8Array(await resp.arrayBuffer())
      : await resp.text();
  }

  /** Delete an inventory. Resolves `true` on success (404 throws). */
  async deleteInventory(inventoryId: string): Promise<boolean> {
    const resp = await this.request(
      "DELETE",
      `/inventory-manager/inventories/${pathSegment(inventoryId)}`,
    );
    return Boolean(((await resp.json()) as { deleted?: boolean }).deleted);
  }

  /** Link an existing artifact to an inventory. Resolves to `{ ok, linked, already }`. */
  async attachToInventory(
    inventoryId: string,
    artifactId: string,
  ): Promise<Record<string, unknown>> {
    const resp = await this.request(
      "POST",
      `/inventory-manager/inventories/${pathSegment(inventoryId)}/attach`,
      {
        json: { artifactId },
      },
    );
    return (await resp.json()) as Record<string, unknown>;
  }

  /** Remove one attached artifact from an inventory (the inverse of {@link attachToInventory}).
   *  Atomic server-side operation that preserves every other field; idempotent. Resolves
   *  `{ ok, linked, removed }`. */
  async detachFromInventory(
    inventoryId: string,
    artifactId: string,
  ): Promise<Record<string, unknown>> {
    const resp = await this.request(
      "POST",
      `/inventory-manager/inventories/${pathSegment(inventoryId)}/detach`,
      { json: { artifactId } },
    );
    return (await resp.json()) as Record<string, unknown>;
  }

  /**
   * REPLACE an inventory's attached reference artifacts in one call (the bulk twin of
   * {@link attachToInventory}), PRESERVING its inventory / monitoring / alert-prefs. Only attachable
   * kinds (`input` / `enrichment` / `report`) are kept; inventories and inventory enrichments are skipped. Deduped +
   * capped at 100. Resolves `{ id, linked_count, attached, skipped, mode }`.
   */
  async setAttachments(
    inventoryId: string,
    artifactIds: string[],
  ): Promise<Record<string, unknown>> {
    const resp = await this.request(
      "PATCH",
      `/inventory-manager/inventories/${pathSegment(inventoryId)}/attachments`,
      {
        json: { artifact_ids: artifactIds, mode: "replace" },
      },
    );
    return (await resp.json()) as Record<string, unknown>;
  }

  /** APPEND several artifacts to an inventory's attachments in one call (bulk {@link attachToInventory});
   *  same filtering/cap/return as {@link setAttachments}. */
  async addAttachments(
    inventoryId: string,
    artifactIds: string[],
  ): Promise<Record<string, unknown>> {
    const resp = await this.request(
      "PATCH",
      `/inventory-manager/inventories/${pathSegment(inventoryId)}/attachments`,
      {
        json: { artifact_ids: artifactIds, mode: "append" },
      },
    );
    return (await resp.json()) as Record<string, unknown>;
  }

  /** Toggle an inventory's daily monitoring (= daily enrichment). Routes through the automation endpoint
   *  (partial read-modify-write) so assets, attachments, asset groups, AND the daily-report config are
   *  all preserved. Enrichments always run at full depth. Resolves `{ id, automation }`. */
  async setMonitoring(
    inventoryId: string,
    monitoring: boolean,
  ): Promise<Record<string, unknown>> {
    return this.setAutomation(inventoryId, { monitoring });
  }

  /** Star (`favorite: true`) or unstar (`false`) an inventory — the same ★ the inventory cards show. A
   *  favorite-only PATCH that leaves the asset inventory / attachments / monitoring / automation untouched.
   *  `listInventories` + `getInventory` echo `favorite` back. Usage-exempt. Resolves `{ id, favorite }`. */
  async setFavorite(
    inventoryId: string,
    favorite = true,
  ): Promise<Record<string, unknown>> {
    const resp = await this.request(
      "PATCH",
      `/inventory-manager/inventories/${pathSegment(inventoryId)}`,
      { json: { favorite } },
    );
    return (await resp.json()) as Record<string, unknown>;
  }

  /** Read an inventory's DAILY-AUTOMATION config (the programmatic twin of the Automation modal):
   *  `{ monitoring, daily_enrichment_email, daily_report, daily_report_email,
   *  daily_report_template, daily_enrichment_next_run_at, custom_template_pinned }`. ONE pipeline on ONE
   *  timer: `daily_enrichment_next_run_at` is the epoch-ms countdown (null when monitoring is off); the
   *  daily report rides the same pipeline (right after the enrichment), no timer of its own. Usage-exempt. */
  async getAutomation(inventoryId: string): Promise<Record<string, unknown>> {
    const resp = await this.request(
      "GET",
      `/inventory-manager/inventories/${pathSegment(inventoryId)}/automation`,
    );
    return (await resp.json()) as Record<string, unknown>;
  }

  /** Manage an inventory's daily automation — set ONLY the fields you pass (partial read-modify-write,
   *  preserving assets/attachments). `monitoring` = the daily enrichment; `dailyReport` = ALSO generate a
   *  Report-Generator report from `dailyReportTemplate` (a built-in template id, e.g. `project_brief`) right
   *  after each daily enrichment, off its fresh findings. ONE pipeline: `dailyReport` REQUIRES `monitoring` —
   *  enabling it while monitoring is off rejects with a 400 (`UnexpectedStatus`); turning monitoring off
   *  cascades the report off. Each job's `*Email` toggle controls whether it emails the owner. The pipeline
   *  runs on the owner's key when the daily cron fires (the enrichment counts toward usage then). Resolves
   *  `{ id, automation }`. */
  async setAutomation(
    inventoryId: string,
    options: {
      monitoring?: boolean;
      dailyEnrichmentEmail?: boolean;
      dailyReport?: boolean;
      dailyReportEmail?: boolean;
      dailyReportTemplate?: string;
    },
  ): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {};
    if (options.monitoring !== undefined) body.monitoring = options.monitoring;
    if (options.dailyEnrichmentEmail !== undefined)
      body.daily_enrichment_email = options.dailyEnrichmentEmail;
    if (options.dailyReport !== undefined)
      body.daily_report = options.dailyReport;
    if (options.dailyReportEmail !== undefined)
      body.daily_report_email = options.dailyReportEmail;
    if (options.dailyReportTemplate !== undefined)
      body.daily_report_template = options.dailyReportTemplate;
    const resp = await this.request(
      "PUT",
      `/inventory-manager/inventories/${pathSegment(inventoryId)}/automation`,
      { json: body },
    );
    return (await resp.json()) as Record<string, unknown>;
  }

  /**
   * Enrich an inventory's inventory end-to-end against the /v1 engine: submit → poll → return the report.
   *
   * Reads the inventory's asset inventory (`GET /inventory-manager/inventories/{id}`), submits those assets
   * to the Threat Inventory Enricher (`POST /v1/inventory-enrich`, always full depth — there is no fast/lite
   * mode), polls until done, and resolves to the enrichment report.
   *
   * The enrichment submit is enrichment compute and **counts toward your usage** (it rides your key to
   * `/v1/inventory-enrich`); reading the inventory and polling do not.
   *
   * Resolves to `{ enrichment_id, report }`. If the inventory's inventory is empty this short-circuits and
   * resolves to `{ enrichment_id: null, empty: true }` without submitting. Throws `UnexpectedStatus` on a
   * non-2xx (or enrichment error), or `Error` if the enrichment doesn't finish within `timeoutMs`.
   */
  async enrichInventory(
    inventoryId: string,
    options: {
      include?: string[];
      pollIntervalMs?: number;
      timeoutMs?: number;
      /** Called with the live job each poll (`{ status, progress, events }`, each event carrying the %
       *  it reached — a `✓ {CVE}` line per CVE) so you can render a live bar / feed. Polls are exempt. */
      onProgress?: ProgressCallback;
      /** Save the finished enrichment into this inventory's history after it completes (the `/v1` engine
       *  returns the report but never persists it) — the one-call equivalent of `enrichInventory` then
       *  `saveEnrichment`. When saved, the result also carries `saved`. Usage-exempt. */
      save?: boolean;
      /** The inventory's "artifact scans" — when on, its attached artifacts are resolved + sent so the
       *  engine ALSO runs a mini Artifact Enrichment over them (references surface on the report's
       *  `attachment_enrichment`). `undefined` (default) honors the inventory's saved toggle; `true`/`false`
       *  forces it for this run. */
      enrichAttachments?: boolean;
    } = {},
  ): Promise<Record<string, unknown>> {
    const manifest = await this.getInventory(inventoryId);
    const items = Array.isArray(manifest.inventory)
      ? (manifest.inventory as unknown[])
      : [];
    if (items.length === 0) return { enrichment_id: null, empty: true };
    const doAttach =
      options.enrichAttachments ?? manifest.enrich_attachments === true;
    let attachmentsText: string | undefined;
    let attachmentsFiles:
      Array<{ filename: string; content_b64: string }> | undefined;
    if (doAttach) {
      const ids = (
        Array.isArray(manifest.attached)
          ? (manifest.attached as Array<Record<string, unknown>>)
          : []
      )
        .map((a) => a?.id)
        .filter((x): x is string => typeof x === "string");
      const resolved = await this.resolveAttachments(ids);
      attachmentsText = resolved.text;
      if (resolved.files.length) attachmentsFiles = resolved.files;
    }
    const result = await this.enrichItems(items, {
      ...options,
      attachmentsText,
      attachmentsFiles,
    });
    if (options.save && result.enrichment_id) {
      result.saved = await this.saveEnrichment(
        inventoryId,
        result.enrichment_id as string,
      );
    }
    return result;
  }

  /** Fetch the inventory's attached artifacts (≤20) and split them for the engine: TEXT artifacts are
   *  concatenated into `text`; BINARY ones (`X-Artifact-Format: file` — spreadsheets, PDF, scan XML) are
   *  forwarded RAW (their stored base64) as `files` so the engine's parsers mine them. Best-effort —
   *  per-text-attachment ≤80 KB, combined text ≤500 KB, files ≤20. */
  async resolveAttachments(attachmentIds: string[]): Promise<{
    text?: string;
    files: Array<{ filename: string; content_b64: string }>;
  }> {
    const parts: string[] = [];
    const files: Array<{ filename: string; content_b64: string }> = [];
    let total = 0;
    for (const aid of attachmentIds.slice(0, 20)) {
      try {
        const resp = await this.request(
          "GET",
          `/artifact-manager/artifacts/${pathSegment(aid)}`,
          { params: { raw: "1" } },
        );
        const content = await resp.text();
        if (!content) continue;
        let name = aid;
        const encodedName = resp.headers.get("X-Artifact-Name");
        if (encodedName) {
          try {
            name = decodeURIComponent(encodedName);
          } catch {
            name = aid;
          }
        }
        if (resp.headers.get("X-Artifact-Format") === "file") {
          // binary → forward to the engine's parsers
          if (files.length < 20)
            files.push({ filename: name, content_b64: content });
          continue;
        }
        const chunk = content.slice(0, 80_000);
        parts.push(`--- Attached: ${name} ---\n${chunk}`);
        total += chunk.length;
        if (total >= 500_000) break;
      } catch {
        continue;
      }
    }
    const text = parts.join("\n\n");
    return { text: text.trim() ? text.slice(0, 500_000) : undefined, files };
  }

  /**
   * Persist a COMPLETED inventory enrichment into this inventory's saved history, by its engine
   * `enrichmentId`.
   *
   * The programmatic equivalent of the workbench's "Save enrichment" button. Run `enrichInventory`
   * (`POST /v1/inventory-enrich` → poll), then pass the returned `enrichment_id` here to file the finished
   * findings as a `kind=inventory_enrichment` artifact linked to the inventory (or use
   * `enrichInventory({ save: true })` to do both in one call). The engine returns the report but never
   * persists it — this is the only way to add it to the inventory's history. Idempotent (a repeat returns
   * `{ ok: true, deduped: true }`). Usage-exempt. Resolves to `{ artifact_id }`. Save within ~1 h of completion.
   */
  async saveEnrichment(
    inventoryId: string,
    enrichmentId: string,
  ): Promise<Record<string, unknown>> {
    const resp = await this.request(
      "POST",
      `/inventory-manager/inventories/${pathSegment(inventoryId)}/enrichments`,
      { json: { enrichment_id: enrichmentId } },
    );
    return (await resp.json()) as Record<string, unknown>;
  }

  /** Submit a raw asset list to the `/v1/inventory-enrich` engine, poll until done, resolve
   *  `{ enrichment_id, report }`. The shared submit→poll core behind `enrichInventory` and the `ingest`
   *  component. Throws `UnexpectedStatus` on an engine error, or `Error` on timeout. (Internal — used by
   *  `ingest.ts`; not part of the documented public surface.) */
  async enrichItems(
    items: unknown[],
    options: {
      include?: string[];
      pollIntervalMs?: number;
      timeoutMs?: number;
      onProgress?: ProgressCallback;
      attachmentsText?: string;
      attachmentsFiles?: Array<{ filename: string; content_b64: string }>;
    } = {},
  ): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = { items };
    if (options.include) body.include = options.include;
    if (options.attachmentsText)
      body.attachments_text = options.attachmentsText;
    if (options.attachmentsFiles?.length)
      body.attachments_files = options.attachmentsFiles;
    const submit = (await (
      await this.request("POST", "/v1/inventory-enrich", { json: body })
    ).json()) as { enrichment_id: string };
    const enrichmentId = submit.enrichment_id;
    const job = await pollUntilDone(
      (m, p) => this.request(m, p),
      enrichmentId,
      `/v1/inventory-enrich/${pathSegment(enrichmentId)}`,
      {
        pollIntervalMs: options.pollIntervalMs ?? 3000,
        timeoutMs: options.timeoutMs ?? 300_000,
        onProgress: options.onProgress,
      },
    );
    // snake_case `enrichment_id` — matches the Python SDK and the empty-path passthrough above.
    return { enrichment_id: enrichmentId, report: job.result };
  }

  /** Parse a scan / inventory FILE into canonical asset items WITHOUT saving anything (the parse-only twin
   *  of `importInventory`). You PICK the `format` — one of json/sbom/csv/nmap/list/grype/trivy/depcheck/nessus/gvm/xlsx
   *  (no auto-detect; pass a `Uint8Array` for the binary `xlsx`). Resolves
   *  `{ format, items, count, inventory_name?, truncated? }`. Usage-exempt — the building block for `ingestScan`. */
  async parseScan(
    content: string | Uint8Array,
    format: string,
  ): Promise<Record<string, unknown>> {
    const resp = await this.request(
      "POST",
      "/inventory-manager/inventories/parse",
      { json: { format, content: wireContent(content) } },
    );
    return (await resp.json()) as Record<string, unknown>;
  }

  /** Scan → briefing in one call: parse the scan FILE (`parseScan`), enrich the discovered assets against
   *  the `/v1/inventory-enrich` ranking engine, and assemble a structured briefing. `format` is one of
   *  json/sbom/csv/nmap/list/grype/trivy/depcheck/nessus/gvm/xlsx. The parse is usage-exempt; the enrichment **submit counts
   *  toward usage** (one `/v1/inventory-enrich` request). Resolves
   *  `{ format, parsed_count, truncated?, enrichment_id, report, recommended_actions }` (report = the
   *  engine's KEV-first-ranked findings + rollup). An empty parse short-circuits to
   *  `{ format, parsed_count: 0, enrichment_id: null, empty: true }`. */
  async ingestScan(
    content: string | Uint8Array,
    format: string,
    options: {
      include?: string[];
      pollIntervalMs?: number;
      timeoutMs?: number;
      onProgress?: ProgressCallback;
    } = {},
  ): Promise<Record<string, unknown>> {
    return runIngestScan(this, content, format, options);
  }
}
