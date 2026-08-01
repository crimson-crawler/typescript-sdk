/**
 * Artifact Manager API (Artifact Manager) — key-authed access to YOUR stored artifacts.
 *
 * The Artifact Manager API lives at `/artifact-manager/*`, outside the versioned
 * `/v1` enrichment contract, so it is not part of the
 * OpenAPI snapshot or the generated layer. This module is the hand-written
 * client for it, exposed as `client.artifactManager` (mirrors the Python wrapper's
 * `ArtifactManagerAPI`).
 *
 * Same API key, same base URL, same retry/timeout fetch as every other call —
 * but **artifactManager calls never count toward your API usage** (account
 * self-service over your own data, not enrichment compute).
 */

import { UnexpectedStatus } from "./exceptions";
import { pathSegment } from "./url";

/** A fetch-like function — the CrawlerClient hands in its retry/timeout wrapper. */
export type ArtifactManagerFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

function decodeHeader(value: string | null, fallback: string): string {
  if (!value) return fallback;
  try {
    return decodeURIComponent(value);
  } catch {
    return fallback;
  }
}

function downloadFilename(disposition: string, fallback: string): string {
  let candidate: string | undefined;
  const encoded = disposition
    .match(/filename\*\s*=\s*UTF-8''([^;]+)/i)?.[1]
    ?.trim();
  if (encoded) {
    try {
      candidate = decodeURIComponent(encoded);
    } catch {
      candidate = undefined;
    }
  }
  candidate ??= disposition.match(/filename\s*=\s*"([^"]*)"/i)?.[1];
  candidate ??= disposition.match(/filename\s*=\s*([^;\s]+)/i)?.[1];
  const basename = candidate?.replace(/\\/g, "/").split("/").at(-1)?.trim();
  const hasControl =
    basename !== undefined &&
    Array.from(basename).some((ch) => ch < " " || ch === "\u007f");
  if (!basename || basename === "." || basename === ".." || hasControl) {
    return fallback;
  }
  return basename;
}

export interface ArtifactManagerArtifact {
  id: string;
  kind:
    | "input"
    | "artifact_enrichment"
    | "report"
    | "inventory_enrichment"
    | "inventory_asset";
  name: string;
  mime?: string | null;
  format?: string | null;
  content?: string | null;
  byte_size?: number;
  favorite?: boolean;
  folder_id?: string | null;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export interface ArtifactManagerFolder {
  id: string;
  name: string;
  artifact_count?: number;
  [key: string]: unknown;
}

export interface ArtifactManagerRawArtifact {
  content: string;
  id: string;
  kind: string;
  name: string;
  format: string;
  mime: string;
  created_at: string;
}

export interface ArtifactManagerExport {
  /** The export decoded as text. Lossy for the binary XLSX formats (`emass`/`workbook`) — use `bytes`. */
  content: string;
  /** The raw export bytes (authoritative; write to a file for the binary `emass`/`workbook` XLSX). */
  bytes: Uint8Array;
  /** A sanitized basename safe to join beneath a caller-selected output directory. */
  filename: string;
  contentType: string;
}

export interface ArtifactManagerRating {
  rating: "up" | "down" | null;
  counts: { up: number; down: number };
}

/**
 * Client for the key-authed Artifact Manager API (Artifact Manager).
 *
 * Obtained via `client.artifactManager` — never constructed directly.
 * Every method throws `UnexpectedStatus` on a non-2xx response.
 */
export class ArtifactManagerApi {
  private readonly baseUrl: string;
  // True ES2022 private field, not TypeScript `private`: `private` is erased at compile
  // time, leaving an enumerable own property that JSON.stringify and
  // util.inspect (so console.log) print in cleartext. `#` is enforced by the
  // runtime and invisible to both.
  readonly #apiKey: string;
  private readonly doFetch: ArtifactManagerFetch;

  constructor(baseUrl: string, apiKey: string, doFetch: ArtifactManagerFetch) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.#apiKey = apiKey;
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
        apikey: this.#apiKey,
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
        `Artifact Manager API ${resp.status} on ${path}`,
      );
    }
    return resp;
  }

  // -- Discovery ---------------------------------------------------------- //

  /** `GET /artifact-manager` — the self-documenting endpoint map + your account context. */
  async discovery(): Promise<Record<string, unknown>> {
    return (await this.request("GET", "/artifact-manager")).json() as Promise<
      Record<string, unknown>
    >;
  }

  // -- Artifacts ---------------------------------------------------------- //

  /**
   * List your artifacts (newest first, no content).
   *
   * @param options `kind` (input|enrichment|report) · `folder` (UUID or `"__root__"`)
   *   · `since`/`until` (ISO `created_at` window).
   */
  async listArtifacts(
    options: {
      kind?:
        | "input"
        | "artifact_enrichment"
        | "report"
        | "inventory_enrichment"
        | "inventory_asset";
      folder?: string;
      since?: string;
      until?: string;
    } = {},
  ): Promise<ArtifactManagerArtifact[]> {
    const params: Record<string, string> = {};
    if (options.kind) params.kind = options.kind;
    if (options.folder) params.folder = options.folder;
    if (options.since) params.since = options.since;
    if (options.until) params.until = options.until;
    const resp = await this.request("GET", "/artifact-manager/artifacts", {
      params,
    });
    return ((await resp.json()) as { artifacts: ArtifactManagerArtifact[] })
      .artifacts;
  }

  /**
   * Upload input artifacts (max 20/call, ≤10 MB content each).
   *
   * @param artifacts Each `{ name, content, format: "paste"|"file", mime? }`.
   * @param options File into an existing `folderId`, or create one via `newFolderName`.
   * @returns `{ ids, folderId }` — the new artifact ids.
   */
  async uploadArtifacts(
    artifacts: Array<{
      name: string;
      content: string;
      format: "paste" | "file";
      mime?: string;
    }>,
    options: { folderId?: string; newFolderName?: string } = {},
  ): Promise<{ ids: string[]; folderId: string | null }> {
    const body: Record<string, unknown> = { artifacts };
    if (options.folderId !== undefined) body.folderId = options.folderId;
    if (options.newFolderName !== undefined)
      body.newFolderName = options.newFolderName;
    const resp = await this.request("POST", "/artifact-manager/artifacts", {
      json: body,
    });
    return (await resp.json()) as { ids: string[]; folderId: string | null };
  }

  /** One artifact in full, including inline `content`. */
  async getArtifact(artifactId: string): Promise<ArtifactManagerArtifact> {
    const resp = await this.request(
      "GET",
      `/artifact-manager/artifacts/${pathSegment(artifactId)}`,
    );
    return ((await resp.json()) as { artifact: ArtifactManagerArtifact })
      .artifact;
  }

  /**
   * Stream an artifact's content as the raw body — the efficient way to pull a
   * multi-MB enrichment report (no JSON re-wrap). Metadata rides `X-Artifact-*` headers.
   */
  async getArtifactRaw(
    artifactId: string,
  ): Promise<ArtifactManagerRawArtifact> {
    const resp = await this.request(
      "GET",
      `/artifact-manager/artifacts/${pathSegment(artifactId)}`,
      {
        params: { raw: "1" },
      },
    );
    return {
      content: await resp.text(),
      id: resp.headers.get("x-artifact-id") ?? artifactId,
      kind: resp.headers.get("x-artifact-kind") ?? "",
      name: decodeHeader(resp.headers.get("x-artifact-name"), artifactId),
      format: resp.headers.get("x-artifact-format") ?? "",
      mime: resp.headers.get("x-artifact-mime") ?? "",
      created_at: resp.headers.get("x-artifact-created") ?? "",
    };
  }

  /**
   * Partial update: rename, star/unstar, and/or move between folders.
   *
   * `folderId: null` moves the artifact back to root; omit it to leave the
   * folder unchanged.
   */
  async updateArtifact(
    artifactId: string,
    update: { name?: string; favorite?: boolean; folderId?: string | null },
  ): Promise<ArtifactManagerArtifact> {
    const body: Record<string, unknown> = {};
    if (update.name !== undefined) body.name = update.name;
    if (update.favorite !== undefined) body.favorite = update.favorite;
    if ("folderId" in update) body.folderId = update.folderId;
    const resp = await this.request(
      "PATCH",
      `/artifact-manager/artifacts/${pathSegment(artifactId)}`,
      { json: body },
    );
    return ((await resp.json()) as { artifact: ArtifactManagerArtifact })
      .artifact;
  }

  /** Delete one artifact. Resolves `true` on success (404 throws). */
  async deleteArtifact(artifactId: string): Promise<boolean> {
    const resp = await this.request(
      "DELETE",
      `/artifact-manager/artifacts/${pathSegment(artifactId)}`,
    );
    return Boolean(((await resp.json()) as { deleted?: boolean }).deleted);
  }

  /** Duplicate an artifact as "Copy of …". Resolves to the new artifact id. */
  async copyArtifact(artifactId: string): Promise<string> {
    const resp = await this.request(
      "POST",
      `/artifact-manager/artifacts/${pathSegment(artifactId)}/copy`,
    );
    return ((await resp.json()) as { id: string }).id;
  }

  /**
   * Persist a COMPLETED artifact enrichment into your library, by its engine `enrichmentId`.
   *
   * The programmatic equivalent of the portal's "Save enrichment" button. Run `client.enricher.enrich`
   * (`POST /v1/artifact-enrich` → poll), then pass the returned `enrichment_id` here to file the finished
   * report as a `kind=artifact_enrichment` artifact on your account (or use `enrich({ save: true })` to do both in
   * one call). The engine returns the report but never persists it — this is the only way to add it to the
   * Artifact Manager. Idempotent (a repeat returns `{ already_persisted: true }`). Optionally file it into
   * a folder by id (`folderId`) or create one (`newFolderName`). Usage-exempt. Resolves to
   * `{ enrichment_artifact_id }` (or `{ already_persisted: true }`). Save within ~1 h of completion.
   */
  async saveEnrichment(
    enrichmentId: string,
    opts: { folderId?: string | null; newFolderName?: string | null } = {},
  ): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = { enrichment_id: enrichmentId };
    if (opts.folderId || opts.newFolderName) {
      body.folder = {
        folder_id: opts.folderId ?? null,
        new_folder_name: opts.newFolderName ?? null,
      };
    }
    const resp = await this.request(
      "POST",
      "/artifact-manager/artifacts/from-enrichment",
      { json: body },
    );
    return (await resp.json()) as Record<string, unknown>;
  }

  // -- Bulk operations ---------------------------------------------------- //

  /** Delete many artifacts in one call (≤200/call). Resolves to the number removed. */
  async bulkDelete(artifactIds: string[]): Promise<number> {
    const resp = await this.request(
      "POST",
      "/artifact-manager/artifacts/bulk",
      {
        json: { op: "delete", ids: artifactIds },
      },
    );
    return ((await resp.json()) as { count: number }).count;
  }

  /**
   * Move many artifacts into a folder (≤200/call). `folderId: null` un-files them
   * to root. Resolves to the number moved.
   */
  async moveToFolder(
    artifactIds: string[],
    folderId: string | null = null,
  ): Promise<number> {
    const resp = await this.request(
      "POST",
      "/artifact-manager/artifacts/bulk",
      {
        json: { op: "move", ids: artifactIds, folder_id: folderId },
      },
    );
    return ((await resp.json()) as { count: number }).count;
  }

  /**
   * Star (`favorite: true`) or unstar (`false`) many artifacts at once (≤200/call).
   * Resolves to the number updated.
   */
  async bulkSetFavorite(
    artifactIds: string[],
    favorite: boolean,
  ): Promise<number> {
    const resp = await this.request(
      "POST",
      "/artifact-manager/artifacts/bulk",
      {
        json: { op: "favorite", ids: artifactIds, favorite },
      },
    );
    return ((await resp.json()) as { count: number }).count;
  }

  /** Bundle an explicit set of your artifacts into one `.zip` (the bulk "Download .zip"). Enrichments
   *  contribute their machine exports under a per-enrichment subfolder; every other kind contributes its raw
   *  deliverable. Returns the raw `.zip` bytes. See {@link downloadFolder} for the whole-folder twin. */
  async downloadBundle(artifactIds: string[]): Promise<Uint8Array> {
    const resp = await this.request(
      "POST",
      "/artifact-manager/artifacts/bundle",
      { json: { ids: artifactIds } },
    );
    return new Uint8Array(await resp.arrayBuffer());
  }

  // -- Enrichment ratings ------------------------------------------------------- //

  /** Your thumbs rating on an enrichment + the aggregate counts. */
  async getRating(enrichmentId: string): Promise<ArtifactManagerRating> {
    const resp = await this.request(
      "GET",
      `/artifact-manager/artifacts/${pathSegment(enrichmentId)}/rating`,
    );
    return (await resp.json()) as ArtifactManagerRating;
  }

  /** Rate an enrichment `"up"`/`"down"`, or clear your rating with `null`. */
  async setRating(
    enrichmentId: string,
    rating: "up" | "down" | null,
  ): Promise<Record<string, unknown>> {
    const resp = await this.request(
      "POST",
      `/artifact-manager/artifacts/${pathSegment(enrichmentId)}/rating`,
      {
        json: { rating },
      },
    );
    return (await resp.json()) as Record<string, unknown>;
  }

  // -- Enrichment exports ------------------------------------------------------- //

  /** A saved enrichment's machine-export formats (`stix`, `misp`, `csaf`, `vex`, `csv`, …). */
  async listExports(enrichmentId: string): Promise<string[]> {
    const resp = await this.request(
      "GET",
      `/artifact-manager/artifacts/${pathSegment(enrichmentId)}/exports`,
    );
    return ((await resp.json()) as { formats: string[] }).formats;
  }

  /** Download one export. The body is the export file; `filename` is a sanitized basename from
   *  `Content-Disposition`. Text formats land in `content`; binary XLSX formats in `bytes`. */
  async getExport(
    enrichmentId: string,
    format: string,
  ): Promise<ArtifactManagerExport> {
    const resp = await this.request(
      "GET",
      `/artifact-manager/artifacts/${pathSegment(enrichmentId)}/exports/${pathSegment(format)}`,
    );
    const disposition = resp.headers.get("content-disposition") ?? "";
    const filename = downloadFilename(disposition, format);
    // Read the body ONCE as bytes, then derive the text convenience from it (a Response body is
    // single-use, so we can't call both .text() and .arrayBuffer()).
    const bytes = new Uint8Array(await resp.arrayBuffer());
    return {
      content: new TextDecoder().decode(bytes),
      bytes,
      filename,
      contentType: resp.headers.get("content-type") ?? "",
    };
  }

  /** Download EVERY machine export of a saved artifact as one `.zip` (one file per format —
   *  `stix.json`, `vex.json`, `emass.xlsx`, …). The bulk twin of {@link getExport}, matching the export
   *  panel's "Download all (.zip)" button. Works for any saved enrichment / inventory-enrichment /
   *  inventory id. Returns the raw `.zip` bytes. */
  async downloadAllExports(enrichmentId: string): Promise<Uint8Array> {
    const resp = await this.request(
      "GET",
      `/artifact-manager/artifacts/${pathSegment(enrichmentId)}/exports/all`,
    );
    return new Uint8Array(await resp.arrayBuffer());
  }

  // -- Enrichment compare ------------------------------------------------------- //

  /**
   * Difference matrix across 2–12 of your saved enrichments (oldest → newest). Each
   * row is one finding's trajectory: new / resolved / changed / persistent.
   */
  async compareEnrichments(
    enrichmentIds: string[],
  ): Promise<Record<string, unknown>> {
    const resp = await this.request(
      "GET",
      "/artifact-manager/enrichment-compare",
      {
        params: { ids: enrichmentIds.join(",") },
      },
    );
    return ((await resp.json()) as { matrix: Record<string, unknown> }).matrix;
  }

  // -- Folders ------------------------------------------------------------ //

  /** Your folders, each with a live `artifact_count`. */
  async listFolders(): Promise<ArtifactManagerFolder[]> {
    const resp = await this.request("GET", "/artifact-manager/folders");
    return ((await resp.json()) as { folders: ArtifactManagerFolder[] })
      .folders;
  }

  /** Create a folder. Resolves to its id. */
  async createFolder(name: string): Promise<string> {
    const resp = await this.request("POST", "/artifact-manager/folders", {
      json: { name },
    });
    return ((await resp.json()) as { id: string }).id;
  }

  /** Rename a folder. */
  async renameFolder(
    folderId: string,
    name: string,
  ): Promise<Record<string, unknown>> {
    const resp = await this.request(
      "PATCH",
      `/artifact-manager/folders/${pathSegment(folderId)}`,
      { json: { name } },
    );
    return (await resp.json()) as Record<string, unknown>;
  }

  /** Delete a folder — its artifacts move back to root, never deleted with it. */
  async deleteFolder(folderId: string): Promise<boolean> {
    const resp = await this.request(
      "DELETE",
      `/artifact-manager/folders/${pathSegment(folderId)}`,
    );
    return Boolean(((await resp.json()) as { deleted?: boolean }).deleted);
  }

  /** Download every artifact filed under a folder as one `<folder>.zip` (the folder "Download .zip").
   *  Enrichments contribute their machine exports under a per-enrichment subfolder; every other kind
   *  contributes its raw deliverable. Returns the raw `.zip` bytes. */
  async downloadFolder(folderId: string): Promise<Uint8Array> {
    const resp = await this.request(
      "GET",
      `/artifact-manager/folders/${pathSegment(folderId)}/exports/all`,
    );
    return new Uint8Array(await resp.arrayBuffer());
  }
}
