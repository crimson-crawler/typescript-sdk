/**
 * High-level wrapper around the generated Crimson Crawler API client.
 *
 * Configures API-key authentication (`apikey` header), reads connection details
 * from environment variables when not supplied, and provides convenience
 * methods that encode the most common `include=[...]` enrichment chains.
 *
 * Every method sends one request to the configured public API. The wrapper adds
 * no caching, proxying, or extra network hops.
 *
 * @example
 * ```ts
 * import { CrawlerClient } from "@crimson-crawler/crimson-crawler-client";
 *
 * const client = new CrawlerClient();
 * const result = await client.enrichCveFull("CVE-2024-3400");
 * console.log(result.cve?.cvss_score);
 * ```
 */

import { client as defaultClient } from "./_generated/client.gen";
import { createClient } from "./_generated/client";
import type { Client } from "./_generated/client";
import {
  artifactEnrich,
  artifactEnrichStatus,
  assessGroupExposure,
  assessIocPortfolio,
  assessTechniqueCoverage,
  assessVulnerabilityExposure,
  enrichAtlas,
  enrichBatch,
  enrichCampaign,
  enrichCapec,
  enrichCve,
  enrichCwe,
  enrichDefend,
  enrichDisarm,
  enrichGroup,
  enrichIoc,
  enrichLocation,
  enrichPackage,
  enrichPocSource,
  enrichProduct,
  enrichSector,
  enrichSoftware,
  enrichTechnique,
  inventoryEnrich,
  inventoryEnrichStatus,
  searchCti,
  searchCve,
  searchD3Fend,
  searchKev,
  searchKnowledgebase,
  searchMisp,
  searchPoc,
  searchVendor,
} from "./_generated/sdk.gen";
import type {
  ArtifactEnrichResponse,
  ArtifactEnrichStatusResponse,
  ArtifactEnrichmentDocRequest,
  ArtifactEnrichmentStakeholder,
  AssessGroupExposureResponse,
  AssessIocPortfolioRequest,
  AssessIocPortfolioResponse,
  AssessTechniqueCoverageResponse,
  AssessVulnerabilityExposureResponse,
  EnrichAtlasResponse,
  EnrichBatchRequest,
  EnrichBatchResponse,
  EnrichCampaignResponse,
  EnrichCapecResponse,
  EnrichCveResponse,
  EnrichCweResponse,
  EnrichDefendResponse,
  EnrichDisarmResponse,
  EnrichGroupResponse,
  EnrichIocResponse,
  EnrichLocationResponse,
  EnrichPackageResponse,
  EnrichPocSourceResponse,
  EnrichProductResponse,
  EnrichSectorResponse,
  EnrichSoftwareResponse,
  EnrichTechniqueResponse,
  InventoryAsset,
  InventoryEnrichResponse,
  InventoryEnrichStatusResponse,
  SearchCtiRequest,
  SearchCtiResponse,
  SearchCveRequest,
  SearchCveResponse,
  SearchD3FendRequest,
  SearchD3FendResponse,
  SearchKevRequest,
  SearchKevResponse,
  SearchKnowledgebaseRequest,
  SearchKnowledgebaseResponse,
  SearchMispResponse,
  SearchPocResponse,
  SearchVendorResponse,
} from "./_generated/types.gen";
import { MissingCredentials, UnexpectedStatus } from "./exceptions";
import { withApiKeyHeader } from "./_auth";
import { AiReportsApi } from "./ai-reports";
import {
  ArtifactManagerApi,
  type ArtifactManagerFetch,
} from "./artifact-manager";
import { InventoryManagerApi } from "./inventory-manager";
import { EnricherApi } from "./enricher";
import {
  ATLAS_FULL,
  CAMPAIGN_FULL,
  CAPEC_FULL,
  CVE_FULL_WALK,
  CWE_FULL_WALK,
  DEFEND_FULL,
  DISARM_FULL,
  GROUP_FULL,
  IOC_FULL_WALK,
  LOCATION_FULL,
  PACKAGE_FULL,
  PRODUCT_FULL,
  SECTOR_FULL,
  SOFTWARE_FULL,
  TECHNIQUE_FULL,
} from "./presets";
import {
  DEFAULT_MAX_RETRIES,
  isRetryableFetchError,
  RETRYABLE_STATUS,
  sleepBackoff,
  type RetryConfig,
} from "./retry";

/**
 * Default Crimson Crawler endpoint. `baseUrl` or
 * `CRIMSON_CRAWLER_BASE_URL` selects a custom, self-hosted, or local
 * deployment.
 */
export const BASE_URL = "https://crimsoncrawler.com";

/** Sized for cold-cache full-chain enrich; reduce for fast-preset workloads. */
export const DEFAULT_TIMEOUT_MS = 90_000;
const RETRYABLE_METHODS: Record<string, true> = {
  GET: true,
  HEAD: true,
  OPTIONS: true,
};

export const ENV_API_KEY = "CRIMSON_CRAWLER_API_KEY";
export const ENV_BASE_URL = "CRIMSON_CRAWLER_BASE_URL";
export const ENV_VERIFY_SSL = "CRIMSON_CRAWLER_VERIFY_SSL";

export interface CrawlerClientOptions {
  /**
   * API key. Sent as `apikey` header on every request. Defaults to the
   * `CRIMSON_CRAWLER_API_KEY` env var. Required.
   */
  apiKey?: string;
  /**
   * API endpoint. Falls back to the `CRIMSON_CRAWLER_BASE_URL` env var,
   * then the hosted `https://crimsoncrawler.com` default. The API key is sent
   * to this origin, so use a local/development key for custom endpoints.
   */
  baseUrl?: string;
  /**
   * TLS certificate verification toggle. Falls back to the
   * `CRIMSON_CRAWLER_VERIFY_SSL` env var (accepts `false`/`0`/`no` to
   * disable), then to `true`. Prefer trusting the deployment's CA. Set to
   * `false` only for local or isolated self-signed development endpoints.
   *
   * In Node, disabling verification uses a client-scoped undici Agent. Other
   * runtimes reject requests because browser fetch does not expose a
   * per-request TLS verification control.
   */
  verifySsl?: boolean;
  /**
   * Maximum number of automatic retries per request, applied to safe HTTP
   * methods (`GET`/`HEAD`/`OPTIONS`) only. Mutating requests — including
   * Platform writes and deletes — always make exactly one attempt
   * regardless of this setting. Retries fire on transient failures only:
   * HTTP `429`/`502`/`503`/`504` and network errors. Deterministic failures
   * (other `4xx`, `500`) are never retried. Backoff is exponential with
   * jitter; a `Retry-After` header (e.g. on `429`) is honored over the
   * computed delay.
   *
   * Defaults to `2` (3 total attempts). Set to `0` to disable retries. Must be a
   * non-negative integer — a negative or non-integer value throws `RangeError`.
   */
  maxRetries?: number;
  /**
   * Also configure Hey API's module-level generated client for direct generated-function calls
   * that omit an explicit `client`. Disabled by default because that singleton is shared across
   * every `CrawlerClient` in the process. Do not enable it in multi-tenant applications.
   */
  configureGlobalClient?: boolean;
}

function resolveVerifySsl(verifySsl: boolean | undefined): boolean {
  if (verifySsl !== undefined) return verifySsl;
  const raw =
    globalThis.process?.env?.[ENV_VERIFY_SSL]?.trim().toLowerCase() ?? "true";
  return !(raw === "false" || raw === "0" || raw === "no");
}

function validateBaseUrl(baseUrl: string): void {
  const invalidUrlMessage =
    "baseUrl must be a valid HTTPS URL or an HTTP loopback URL";
  if (
    !baseUrl ||
    baseUrl !== baseUrl.trim() ||
    /\s/u.test(baseUrl) ||
    !/^[A-Za-z][A-Za-z\d+.-]*:\/\//u.test(baseUrl)
  ) {
    throw new RangeError(invalidUrlMessage);
  }

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new RangeError(invalidUrlMessage);
  }

  const authority = baseUrl
    .slice(baseUrl.indexOf("://") + 3)
    .split(/[/?#]/u, 1)[0];
  if (!parsed.hostname || authority.includes("@")) {
    throw new RangeError(invalidUrlMessage);
  }
  if (
    (parsed.pathname !== "" && parsed.pathname !== "/") ||
    parsed.search ||
    parsed.hash
  ) {
    throw new RangeError(
      "baseUrl must contain only an origin, without a path, query, or fragment",
    );
  }

  const hostname = parsed.hostname.toLowerCase();
  const loopback =
    hostname === "localhost" ||
    /^127(?:\.\d{1,3}){3}$/u.test(hostname) ||
    hostname === "[::1]";
  if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && loopback)
  ) {
    throw new RangeError("baseUrl must use HTTPS unless its host is loopback");
  }
}

/**
 * Typed wrapper around the generated Crimson Crawler API client.
 *
 * Each instance owns its own Hey API `Client`, passed explicitly to every generated call, so
 * concurrent clients with different credentials cannot cross-contaminate one another. Direct
 * calls imported from `_generated/sdk.gen` must pass `client: crawler.api`. For single-client
 * scripts only, `configureGlobalClient: true` also configures the generated module singleton.
 */
export class CrawlerClient {
  readonly baseUrl: string;
  readonly verifySsl: boolean;
  readonly maxRetries: number;
  private readonly _client: Client;
  private readonly _artifactManager: ArtifactManagerApi;
  private readonly _inventoryManager: InventoryManagerApi;
  private readonly _enricher: EnricherApi;
  private readonly _aiReports: AiReportsApi;

  constructor(opts: CrawlerClientOptions = {}) {
    const apiKey = opts.apiKey ?? globalThis.process?.env?.[ENV_API_KEY];
    if (!apiKey) {
      throw new MissingCredentials(
        `Set ${ENV_API_KEY} or pass apiKey explicitly.`,
      );
    }

    this.baseUrl =
      opts.baseUrl ?? globalThis.process?.env?.[ENV_BASE_URL] ?? BASE_URL;
    validateBaseUrl(this.baseUrl);
    this.verifySsl = resolveVerifySsl(opts.verifySsl);

    const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    if (!Number.isInteger(maxRetries) || maxRetries < 0) {
      throw new RangeError(
        `maxRetries must be a non-negative integer, got ${maxRetries}.`,
      );
    }
    this.maxRetries = maxRetries;

    let insecureDispatcher: Promise<unknown> | undefined;

    const fetchWithTls: typeof globalThis.fetch = async (input, init) => {
      if (this.verifySsl) {
        return globalThis.fetch(input, init);
      }
      if (typeof globalThis.process?.versions?.node !== "string") {
        throw new Error(
          "verifySsl=false is only supported in Node.js; this runtime cannot disable TLS verification per client.",
        );
      }

      insecureDispatcher ??= import("undici").then(
        ({ Agent }) => new Agent({ connect: { rejectUnauthorized: false } }),
      );
      const dispatcher = await insecureDispatcher;
      const scopedInit = { ...init, dispatcher };
      return globalThis.fetch(input, scopedInit);
    };

    const retryCfg: RetryConfig = { maxRetries };

    // Hey API has no built-in `timeout` or retry, but accepts a custom
    // `fetch`. We wrap native fetch in a retry loop and attach an
    // AbortSignal.timeout() so requests don't hang forever on upstream
    // stalls (matches the Python wrapper's DEFAULT_TIMEOUT_SECONDS and
    // RetryTransport). Safe methods retry on 429/502/503/504 and network
    // errors. Mutations never replay because the Platform APIs do not accept
    // idempotency keys. `Retry-After` overrides backoff. See ./retry.ts.
    // Resolved once: the only origin the credential may be attached to.
    const authOrigin = new URL(this.baseUrl).origin;
    const retryFetch: ArtifactManagerFetch = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      // A caller-supplied signal via `init` (the 2-arg calling convention) is
      // never our retry's business — explicit cancellation is respected as-is
      // (forwarded unchanged, no combining with our timeout), and a caller
      // abort is non-retryable.
      //
      // The generated Hey API client never uses that convention, though — it
      // always invokes us as `_fetch(request)`, a single `Request` object
      // with any caller-supplied `signal` (e.g. `enrichCve({..., signal})`)
      // already baked into `request.signal`. Left unhandled, that signal was
      // silently dropped below (fetch() always got a *replacement* signal),
      // so a caller's AbortController never actually cancelled anything. We
      // recover it here and combine it with our own per-attempt timeout via
      // `AbortSignal.any` — the caller's abort still cancels immediately,
      // and our timeout still guards against a hang if the caller never
      // aborts. `input.signal` is a real (if non-firing) AbortSignal even
      // when the caller passed none, so its mere presence can't gate
      // retry-eligibility — only whether it actually fires does.
      const initSignal = init?.signal;
      const requestSignal =
        !initSignal && input instanceof Request ? input.signal : undefined;
      const method = (
        init?.method ?? (input instanceof Request ? input.method : "GET")
      ).toUpperCase();
      const retryable = RETRYABLE_METHODS[method] === true;
      let attempt = 0;
      for (;;) {
        // Fresh timeout signal per attempt — a consumed AbortSignal.timeout
        // can't be reused, and each retry deserves a full timeout budget.
        const timeoutSignal = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
        const signal =
          initSignal ??
          (requestSignal
            ? AbortSignal.any([requestSignal, timeoutSignal])
            : timeoutSignal);
        try {
          const resp = await fetchWithTls(input, {
            ...init,
            signal,
            redirect: "manual",
            // Stamped per request, and only for our own origin, so the key
            // never lives on the client config nor travels to another host.
            headers: withApiKeyHeader(
              input,
              init,
              "apikey",
              apiKey,
              authOrigin,
            ),
          });
          if (
            retryable &&
            RETRYABLE_STATUS.has(resp.status) &&
            attempt < maxRetries
          ) {
            await sleepBackoff(
              attempt,
              resp.headers.get("retry-after"),
              retryCfg,
            );
            attempt++;
            continue;
          }
          // Success, non-retryable status, or budget exhausted: return the
          // response so the generated layer + ensureOk produce the normal
          // UnexpectedStatus(status, body) on a non-2xx.
          return resp;
        } catch (err) {
          // A fired `requestSignal` means the caller's own AbortController
          // caused this — never retry it, regardless of the error's name.
          const requestSignalAborted = requestSignal?.aborted === true;
          if (
            !requestSignalAborted &&
            retryable &&
            isRetryableFetchError(err, initSignal) &&
            attempt < maxRetries
          ) {
            await sleepBackoff(attempt, null, retryCfg);
            attempt++;
            continue;
          }
          // Exhausted or non-retryable (incl. caller abort) → propagate.
          throw err;
        }
      }
    };

    const clientConfig = {
      baseUrl: this.baseUrl,
      // Deliberately no `headers: { apikey }` — the generated client would keep
      // it in a reachable `Headers` object that `util.inspect` prints in full.
      // `retryFetch` stamps it onto each request instead (see ./_auth.ts).
      fetch: retryFetch,
    };
    // Instance-scoped client — passed explicitly to every generated call
    // below (and returned by `.api`), so this instance's requests are
    // immune to any other `CrawlerClient` constructed later.
    this._client = createClient(clientConfig);
    if (opts.configureGlobalClient) {
      defaultClient.setConfig(clientConfig);
    }

    this._artifactManager = new ArtifactManagerApi(
      this.baseUrl,
      apiKey,
      retryFetch,
    );
    this._inventoryManager = new InventoryManagerApi(
      this.baseUrl,
      apiKey,
      retryFetch,
    );
    this._enricher = new EnricherApi(this.baseUrl, apiKey, retryFetch);
    this._aiReports = new AiReportsApi(this.baseUrl, apiKey, retryFetch);
  }

  /** Underlying Hey API client, scoped to this instance. Use to call any of the 33 endpoints directly. */
  get api(): Client {
    return this._client;
  }

  /**
   * The Artifact Manager API (Artifact Manager) — your stored artifacts, enrichment exports,
   * ratings, enrichment-compare, and folders over the same key. Hand-written (the
   * `/artifact-manager/*` surface lives outside the `/v1` OpenAPI contract) and
   * **usage-exempt** — artifactManager calls never count toward your API usage.
   */
  get artifactManager(): ArtifactManagerApi {
    return this._artifactManager;
  }

  /**
   * The Inventory Manager API — your monitored inventory context windows (asset inventory + attached
   * artifacts + saved enrichment history) over the same key. Its own section at
   * `/inventory-manager/inventories/*` (outside the `/v1` OpenAPI contract). **Usage-exempt** except
   * `enrichInventory`'s submit, which is enrichment compute and counts toward your usage.
   */
  get inventoryManager(): InventoryManagerApi {
    return this._inventoryManager;
  }

  /**
   * The Enricher API — the async artifact-enrichment lifecycle (submit → poll → report) over the same
   * key, straight against the `/v1/artifact-enrich` engine. The enrichment submit counts toward usage;
   * polling is the engine's own status read.
   */
  get enricher(): EnricherApi {
    return this._enricher;
  }

  /**
   * The Report Generator API — generate + manage grounded intelligence reports from
   * your saved artifacts, at `/ai-reports/*` (its own section, outside the `/v1` OpenAPI contract).
   * **Usage-exempt**, including the LLM generation.
   */
  get aiReports(): AiReportsApi {
    return this._aiReports;
  }

  // -- Convenience methods for the most common enrichment chains --------- //

  /**
   * Walk the full CVE → CWE → CAPEC → ATT&CK → TIE chain plus MISP/knowledge base/web.
   *
   * @param cveId CVE identifier (e.g. `CVE-2024-3400`).
   * @param include Override the default `CVE_FULL_WALK` chain.
   */
  async enrichCveFull(
    cveId: string,
    include: readonly string[] = CVE_FULL_WALK,
  ): Promise<EnrichCveResponse> {
    const result = await enrichCve({
      client: this._client,
      body: { cve_id: cveId, include: [...include] },
    });
    return ensureOk<EnrichCveResponse>(result);
  }

  /**
   * Enrich an IOC against MISP, link to ATT&CK, and add knowledge base/web context.
   *
   * @param value Indicator value (hash, IP, domain, URL).
   * @param iocType MISP-style attribute type — `ip-dst`, `ip-src`, `domain`,
   *   `hostname`, `md5`, `sha1`, `sha256`, `url`, etc. Defaults to `ip-dst`.
   * @param include Override the default `IOC_FULL_WALK` chain.
   */
  async enrichIocFull(
    value: string,
    iocType = "ip-dst",
    include: readonly string[] = IOC_FULL_WALK,
  ): Promise<EnrichIocResponse> {
    const result = await enrichIoc({
      client: this._client,
      body: { value, type: iocType, include: [...include] },
    });
    return ensureOk<EnrichIocResponse>(result);
  }

  /**
   * Walk CWE → CAPEC → ATT&CK with TIE predictions.
   *
   * @param cweId CWE identifier (e.g. `CWE-79`).
   * @param include Override the default `CWE_FULL_WALK` chain.
   */
  async enrichCweFull(
    cweId: string,
    include: readonly string[] = CWE_FULL_WALK,
  ): Promise<EnrichCweResponse> {
    const result = await enrichCwe({
      client: this._client,
      body: { cwe_id: cweId, include: [...include] },
    });
    return ensureOk<EnrichCweResponse>(result);
  }

  /**
   * Enrich one or more ATT&CK techniques with TIE, adversary attribution,
   * and Navigator JSON.
   *
   * @param techniqueIds ATT&CK technique IDs (e.g. `["T1190", "T1059.001"]`).
   * @param framework ATT&CK matrix variant — `enterprise`, `ics`, or `mobile`.
   * @param include Override the default `TECHNIQUE_FULL` chain.
   */
  async enrichTechniqueFull(
    techniqueIds: string[],
    framework: "enterprise" | "ics" | "mobile" = "enterprise",
    include: readonly string[] = TECHNIQUE_FULL,
  ): Promise<EnrichTechniqueResponse> {
    const result = await enrichTechnique({
      client: this._client,
      body: {
        technique_ids: techniqueIds,
        framework,
        include: [...include],
      },
    });
    return ensureOk<EnrichTechniqueResponse>(result);
  }

  /**
   * Find vulnerabilities affecting a product/version and enrich each matched CVE.
   *
   * @param product Product name (e.g. `"Apache HTTP Server"`, `"nginx"`).
   * @param options Optional `version`, `vendor`, and `include` overrides.
   */
  async enrichProductFull(
    product: string,
    options: {
      version?: string;
      vendor?: string;
      include?: readonly string[];
    } = {},
  ): Promise<EnrichProductResponse> {
    const result = await enrichProduct({
      client: this._client,
      body: {
        product,
        ...(options.version !== undefined && { version: options.version }),
        ...(options.vendor !== undefined && { vendor: options.vendor }),
        include: [...(options.include ?? PRODUCT_FULL)],
      },
    });
    return ensureOk<EnrichProductResponse>(result);
  }

  /**
   * Enrich an open-source package — OSV.dev advisories + full CVE enrichment.
   *
   * The package-ecosystem sibling of {@link enrichProductFull}: OSV.dev supplies the
   * package's advisories, and the CVEs they alias are enriched through the same
   * CWE→CAPEC→ATT&CK + EPSS/KEV chain. Covers the dependency-vuln surface (npm /
   * PyPI / Go / Maven / crates.io / …) the CPE-keyed product endpoint can't reach.
   *
   * @param ecosystem Package ecosystem (e.g. `"PyPI"`, `"npm"`, `"Go"`).
   * @param packageName Package name as published in its registry (e.g. `"django"`).
   * @param options Optional `version` and `include` overrides.
   */
  async enrichPackageFull(
    ecosystem: string,
    packageName: string,
    options: {
      version?: string;
      include?: readonly string[];
    } = {},
  ): Promise<EnrichPackageResponse> {
    const result = await enrichPackage({
      client: this._client,
      body: {
        ecosystem,
        package: packageName,
        ...(options.version !== undefined && { version: options.version }),
        include: [...(options.include ?? PACKAGE_FULL)],
      },
    });
    return ensureOk<EnrichPackageResponse>(result);
  }

  /**
   * Keyword-search the ATT&CK knowledge base for matching techniques.
   *
   * A convenience wrapper over the generated `search_cti` endpoint, scoped to
   * ATT&CK attack-patterns. Replaces the raw escape hatch callers previously
   * used to hand-build the request.
   *
   * @param keyword Free-text query (e.g. `"phishing"`, `"credential dumping"`).
   * @param options Optional `limit` (1-100, default 20).
   */
  async searchTechniques(
    keyword: string,
    options: { limit?: number } = {},
  ): Promise<SearchCtiResponse> {
    const result = await searchCti({
      client: this._client,
      body: {
        query: keyword,
        sources: ["attack"],
        types: ["attack-pattern"],
        limit: options.limit ?? 20,
      },
    });
    return ensureOk<SearchCtiResponse>(result);
  }

  // -- Entity enrichment: full-walk chains ------------------------------- //
  //
  // Each endpoint accepts either its own ID or a `search` keyword, both
  // optional. Neither is enforced client-side: the server's validator answers
  // a request carrying neither with `422`, which surfaces as UnexpectedStatus
  // like every other rejection.

  /**
   * Walk an ATLAS adversarial-ML technique to its ATT&CK mappings and adversary graph.
   *
   * @param techniqueId ATLAS technique ID (e.g. `AML.T0043`).
   * @param options Optional `search` keyword and `include` override (default `ATLAS_FULL`).
   */
  async enrichAtlasFull(
    techniqueId?: string,
    options: {
      search?: string;
      include?: readonly string[];
    } = {},
  ): Promise<EnrichAtlasResponse> {
    const result = await enrichAtlas({
      client: this._client,
      body: {
        ...(techniqueId !== undefined && { technique_id: techniqueId }),
        ...(options.search !== undefined && { search: options.search }),
        include: [...(options.include ?? ATLAS_FULL)],
      },
    });
    return ensureOk<EnrichAtlasResponse>(result);
  }

  /**
   * Walk a threat campaign to its techniques, the groups behind it, and the CVEs it exploited.
   *
   * @param campaignId ATT&CK campaign ID (e.g. `C0011`).
   * @param options Optional `search` keyword, `framework` matrix, and `include`
   *   override (default `CAMPAIGN_FULL`).
   */
  async enrichCampaignFull(
    campaignId?: string,
    options: {
      search?: string;
      framework?: "enterprise" | "ics" | "mobile";
      include?: readonly string[];
    } = {},
  ): Promise<EnrichCampaignResponse> {
    const result = await enrichCampaign({
      client: this._client,
      body: {
        ...(campaignId !== undefined && { campaign_id: campaignId }),
        ...(options.search !== undefined && { search: options.search }),
        framework: options.framework ?? "enterprise",
        include: [...(options.include ?? CAMPAIGN_FULL)],
      },
    });
    return ensureOk<EnrichCampaignResponse>(result);
  }

  /**
   * Walk a CAPEC attack pattern to its ATT&CK techniques, exploitable CVEs, and adversaries.
   *
   * @param capecId CAPEC identifier (e.g. `CAPEC-66`).
   * @param options Optional `search` keyword and `include` override (default `CAPEC_FULL`).
   */
  async enrichCapecFull(
    capecId?: string,
    options: {
      search?: string;
      include?: readonly string[];
    } = {},
  ): Promise<EnrichCapecResponse> {
    const result = await enrichCapec({
      client: this._client,
      body: {
        ...(capecId !== undefined && { capec_id: capecId }),
        ...(options.search !== undefined && { search: options.search }),
        include: [...(options.include ?? CAPEC_FULL)],
      },
    });
    return ensureOk<EnrichCapecResponse>(result);
  }

  /**
   * Resolve a D3FEND defensive technique and the offensive techniques it counters.
   *
   * @param d3fendId D3FEND identifier (e.g. `D3-NTA`).
   * @param options Optional `search` keyword and `include` override (default `DEFEND_FULL`).
   */
  async enrichDefendFull(
    d3fendId?: string,
    options: {
      search?: string;
      include?: readonly string[];
    } = {},
  ): Promise<EnrichDefendResponse> {
    const result = await enrichDefend({
      client: this._client,
      body: {
        ...(d3fendId !== undefined && { d3fend_id: d3fendId }),
        ...(options.search !== undefined && { search: options.search }),
        include: [...(options.include ?? DEFEND_FULL)],
      },
    });
    return ensureOk<EnrichDefendResponse>(result);
  }

  /**
   * Walk a DISARM disinformation technique to its countermeasures and ATT&CK mappings.
   *
   * @param techniqueId DISARM technique ID (e.g. `T0086`).
   * @param options Optional `search` keyword and `include` override (default `DISARM_FULL`).
   */
  async enrichDisarmFull(
    techniqueId?: string,
    options: {
      search?: string;
      include?: readonly string[];
    } = {},
  ): Promise<EnrichDisarmResponse> {
    const result = await enrichDisarm({
      client: this._client,
      body: {
        ...(techniqueId !== undefined && { technique_id: techniqueId }),
        ...(options.search !== undefined && { search: options.search }),
        include: [...(options.include ?? DISARM_FULL)],
      },
    });
    return ensureOk<EnrichDisarmResponse>(result);
  }

  /**
   * Profile a threat actor: techniques, tooling, campaigns, exploited CVEs, and targeting.
   *
   * @param groupId ATT&CK group ID (e.g. `G0016`).
   * @param options Optional `search` keyword, `framework` matrix, and `include`
   *   override (default `GROUP_FULL`).
   */
  async enrichGroupFull(
    groupId?: string,
    options: {
      search?: string;
      framework?: "enterprise" | "ics" | "mobile";
      include?: readonly string[];
    } = {},
  ): Promise<EnrichGroupResponse> {
    const result = await enrichGroup({
      client: this._client,
      body: {
        ...(groupId !== undefined && { group_id: groupId }),
        ...(options.search !== undefined && { search: options.search }),
        framework: options.framework ?? "enterprise",
        include: [...(options.include ?? GROUP_FULL)],
      },
    });
    return ensureOk<EnrichGroupResponse>(result);
  }

  /**
   * Map a region's threat landscape — active groups, their techniques, and affected sectors.
   *
   * @param locationId Region identifier (e.g. `UA`, or an ATT&CK location STIX ID).
   * @param options Optional `search` keyword and `include` override (default `LOCATION_FULL`).
   */
  async enrichLocationFull(
    locationId?: string,
    options: {
      search?: string;
      include?: readonly string[];
    } = {},
  ): Promise<EnrichLocationResponse> {
    const result = await enrichLocation({
      client: this._client,
      body: {
        ...(locationId !== undefined && { location_id: locationId }),
        ...(options.search !== undefined && { search: options.search }),
        include: [...(options.include ?? LOCATION_FULL)],
      },
    });
    return ensureOk<EnrichLocationResponse>(result);
  }

  /**
   * Map an industry sector's threat landscape — who targets it, how, and from where.
   *
   * @param sectorId Sector identifier (e.g. `energy`, or an ATT&CK sector STIX ID).
   * @param options Optional `search` keyword and `include` override (default `SECTOR_FULL`).
   */
  async enrichSectorFull(
    sectorId?: string,
    options: {
      search?: string;
      include?: readonly string[];
    } = {},
  ): Promise<EnrichSectorResponse> {
    const result = await enrichSector({
      client: this._client,
      body: {
        ...(sectorId !== undefined && { sector_id: sectorId }),
        ...(options.search !== undefined && { search: options.search }),
        include: [...(options.include ?? SECTOR_FULL)],
      },
    });
    return ensureOk<EnrichSectorResponse>(result);
  }

  /**
   * Profile malware or a tool: the techniques it implements, who uses it, what it exploits.
   *
   * @param softwareId ATT&CK software ID (e.g. `S0002`).
   * @param options Optional `search` keyword, `framework` matrix, and `include`
   *   override (default `SOFTWARE_FULL`).
   */
  async enrichSoftwareFull(
    softwareId?: string,
    options: {
      search?: string;
      framework?: "enterprise" | "ics" | "mobile";
      include?: readonly string[];
    } = {},
  ): Promise<EnrichSoftwareResponse> {
    const result = await enrichSoftware({
      client: this._client,
      body: {
        ...(softwareId !== undefined && { software_id: softwareId }),
        ...(options.search !== undefined && { search: options.search }),
        framework: options.framework ?? "enterprise",
        include: [...(options.include ?? SOFTWARE_FULL)],
      },
    });
    return ensureOk<EnrichSoftwareResponse>(result);
  }

  // -- Enrichment: batch and PoC source ---------------------------------- //

  /**
   * Enrich a heterogeneous list of artifacts in one round trip.
   *
   * Each item carries its own `type` discriminator and per-item `include`, so a
   * single call can mix CVEs, products, packages, techniques, IOCs, and more.
   * Prefer this over N single-artifact calls: the server fans out internally and
   * shares upstream lookups across the batch.
   *
   * @param items Discriminated batch items (`{ type: "cve", cve_id: "..." }`, …).
   */
  async enrichBatch(
    items: EnrichBatchRequest["items"],
  ): Promise<EnrichBatchResponse> {
    const result = await enrichBatch({
      client: this._client,
      body: { items },
    });
    return ensureOk<EnrichBatchResponse>(result);
  }

  /**
   * Fetch the source of a public proof-of-concept exploit repository.
   *
   * Retrieves the code behind a PoC reference (as surfaced by the `poc` enrichment
   * layer) so it can be reviewed without leaving the API.
   *
   * @param repoUrl Public repository URL of the PoC.
   */
  async enrichPocSource(repoUrl: string): Promise<EnrichPocSourceResponse> {
    const result = await enrichPocSource({
      client: this._client,
      body: { repo_url: repoUrl },
    });
    return ensureOk<EnrichPocSourceResponse>(result);
  }

  // -- Assessments ------------------------------------------------------- //
  //
  // Assessment endpoints score a portfolio rather than enrich one artifact.
  // `include` has no full-walk preset here — omit it to take the server's
  // per-endpoint default, or pass an explicit layer list.

  /**
   * Score your exposure to specific threat actors.
   *
   * Supply `groupIds`, `search` terms, or both; the server rejects a request
   * carrying neither with `422`.
   *
   * @param options `groupIds`, `search` terms, `framework` matrix, and `include` layers.
   */
  async assessGroupExposure(
    options: {
      groupIds?: readonly string[];
      search?: readonly string[];
      framework?: "enterprise" | "ics" | "mobile";
      include?: readonly string[];
    } = {},
  ): Promise<AssessGroupExposureResponse> {
    const result = await assessGroupExposure({
      client: this._client,
      body: {
        ...(options.groupIds !== undefined && {
          group_ids: [...options.groupIds],
        }),
        ...(options.search !== undefined && { search: [...options.search] }),
        framework: options.framework ?? "enterprise",
        ...(options.include !== undefined && { include: [...options.include] }),
      },
    });
    return ensureOk<AssessGroupExposureResponse>(result);
  }

  /**
   * Assess a portfolio of indicators — MISP corroboration, linked techniques, attribution.
   *
   * @param indicators Indicator objects, each `{ value, type? }` (`type` defaults to `ip-dst`).
   * @param options Optional `include` layers.
   */
  async assessIocPortfolio(
    indicators: AssessIocPortfolioRequest["indicators"],
    options: { include?: readonly string[] } = {},
  ): Promise<AssessIocPortfolioResponse> {
    const result = await assessIocPortfolio({
      client: this._client,
      body: {
        indicators,
        ...(options.include !== undefined && { include: [...options.include] }),
      },
    });
    return ensureOk<AssessIocPortfolioResponse>(result);
  }

  /**
   * Score detection and mitigation coverage across a set of ATT&CK techniques.
   *
   * @param techniqueIds ATT&CK technique IDs (e.g. `["T1190", "T1059.001"]`).
   * @param options Optional `framework` matrix and `include` layers.
   */
  async assessTechniqueCoverage(
    techniqueIds: readonly string[],
    options: {
      framework?: "enterprise" | "ics" | "mobile";
      include?: readonly string[];
    } = {},
  ): Promise<AssessTechniqueCoverageResponse> {
    const result = await assessTechniqueCoverage({
      client: this._client,
      body: {
        technique_ids: [...techniqueIds],
        framework: options.framework ?? "enterprise",
        ...(options.include !== undefined && { include: [...options.include] }),
      },
    });
    return ensureOk<AssessTechniqueCoverageResponse>(result);
  }

  /**
   * Prioritize a set of CVEs — weaponization, exploit chains, and remediation order.
   *
   * @param cveIds CVE identifiers to assess.
   * @param options Optional `include` layers and an SSVC `stakeholder` profile that
   *   tunes the decision to your deployment.
   */
  async assessVulnerabilityExposure(
    cveIds: readonly string[],
    options: {
      include?: readonly string[];
      stakeholder?: ArtifactEnrichmentStakeholder;
    } = {},
  ): Promise<AssessVulnerabilityExposureResponse> {
    const result = await assessVulnerabilityExposure({
      client: this._client,
      body: {
        cve_ids: [...cveIds],
        ...(options.include !== undefined && { include: [...options.include] }),
        ...(options.stakeholder !== undefined && {
          stakeholder: options.stakeholder,
        }),
      },
    });
    return ensureOk<AssessVulnerabilityExposureResponse>(result);
  }

  // -- Search ------------------------------------------------------------ //
  //
  // Search endpoints query a corpus and return matches; they never walk an
  // enrichment chain, so none of them takes a full-walk preset. `include` (where
  // the corpus offers it) is a plain passthrough.

  /**
   * Search the CTI knowledge bases — ATT&CK, CWE, CAPEC, ATLAS, DISARM, and more.
   *
   * The unscoped sibling of {@link searchTechniques}: use this to reach any object
   * type across any source, and `searchTechniques` for the common ATT&CK-only case.
   *
   * @param query Free-text query.
   * @param options `sources`, `types`, `limit`, `page`, and the `deprecated`/`revoked` filters.
   */
  async searchCti(
    query: string,
    options: {
      sources?: readonly string[];
      types?: NonNullable<SearchCtiRequest["types"]>;
      limit?: number;
      page?: number;
      deprecated?: boolean;
      revoked?: boolean;
    } = {},
  ): Promise<SearchCtiResponse> {
    const result = await searchCti({
      client: this._client,
      body: {
        query,
        ...(options.sources !== undefined && { sources: [...options.sources] }),
        ...(options.types !== undefined && { types: options.types }),
        limit: options.limit ?? 20,
        page: options.page ?? 1,
        ...(options.deprecated !== undefined && {
          deprecated: options.deprecated,
        }),
        ...(options.revoked !== undefined && { revoked: options.revoked }),
      },
    });
    return ensureOk<SearchCtiResponse>(result);
  }

  /**
   * Search the vulnerability corpus by identifier, mapping, score, or date window.
   *
   * Every filter is optional and they compose: a bare call returns the newest
   * CVEs, while `{ kevOnly: true, epssMin: 0.5 }` narrows to actively exploited,
   * high-probability ones.
   *
   * @param query Free-text query. Omit it to filter purely on the structured fields.
   * @param options Any combination of the corpus filters, plus `sort`, `limit`, `page`.
   */
  async searchCve(
    query?: string,
    options: {
      cveId?: string;
      stixId?: string;
      cweId?: string;
      capecId?: string;
      attackId?: string;
      cpe?: string;
      cpesNotVulnerable?: string;
      createdByRef?: string;
      createdMin?: string;
      createdMax?: string;
      modifiedMin?: string;
      modifiedMax?: string;
      cvssMin?: number;
      cvssV2Min?: number;
      cvssV4Min?: number;
      epssMin?: number;
      epssPercentileMin?: number;
      kevOnly?: boolean;
      vulnStatus?: NonNullable<SearchCveRequest["vuln_status"]>;
      sort?: NonNullable<SearchCveRequest["sort"]>;
      include?: readonly string[];
      limit?: number;
      page?: number;
    } = {},
  ): Promise<SearchCveResponse> {
    const result = await searchCve({
      client: this._client,
      body: {
        ...(query !== undefined && { query }),
        ...(options.cveId !== undefined && { cve_id: options.cveId }),
        ...(options.stixId !== undefined && { stix_id: options.stixId }),
        ...(options.cweId !== undefined && { cwe_id: options.cweId }),
        ...(options.capecId !== undefined && { capec_id: options.capecId }),
        ...(options.attackId !== undefined && { attack_id: options.attackId }),
        ...(options.cpe !== undefined && { cpe: options.cpe }),
        ...(options.cpesNotVulnerable !== undefined && {
          cpes_not_vulnerable: options.cpesNotVulnerable,
        }),
        ...(options.createdByRef !== undefined && {
          created_by_ref: options.createdByRef,
        }),
        ...(options.createdMin !== undefined && {
          created_min: options.createdMin,
        }),
        ...(options.createdMax !== undefined && {
          created_max: options.createdMax,
        }),
        ...(options.modifiedMin !== undefined && {
          modified_min: options.modifiedMin,
        }),
        ...(options.modifiedMax !== undefined && {
          modified_max: options.modifiedMax,
        }),
        ...(options.cvssMin !== undefined && { cvss_min: options.cvssMin }),
        ...(options.cvssV2Min !== undefined && {
          cvss_v2_min: options.cvssV2Min,
        }),
        ...(options.cvssV4Min !== undefined && {
          cvss_v4_min: options.cvssV4Min,
        }),
        ...(options.epssMin !== undefined && { epss_min: options.epssMin }),
        ...(options.epssPercentileMin !== undefined && {
          epss_percentile_min: options.epssPercentileMin,
        }),
        kev_only: options.kevOnly ?? false,
        ...(options.vulnStatus !== undefined && {
          vuln_status: options.vulnStatus,
        }),
        ...(options.sort !== undefined && { sort: options.sort }),
        ...(options.include !== undefined && { include: [...options.include] }),
        limit: options.limit ?? 50,
        page: options.page ?? 1,
      },
    });
    return ensureOk<SearchCveResponse>(result);
  }

  /**
   * Search the D3FEND defensive-countermeasure ontology.
   *
   * @param query Free-text query (e.g. `"network traffic analysis"`).
   * @param options `d3fendForm` to scope to a tactic/mitigation/artifact, plus `limit`, `page`.
   */
  async searchD3fend(
    query: string,
    options: {
      d3fendForm?: NonNullable<SearchD3FendRequest["d3fend_form"]>;
      limit?: number;
      page?: number;
    } = {},
  ): Promise<SearchD3FendResponse> {
    const result = await searchD3Fend({
      client: this._client,
      body: {
        query,
        ...(options.d3fendForm !== undefined && {
          d3fend_form: options.d3fendForm,
        }),
        limit: options.limit ?? 20,
        page: options.page ?? 1,
      },
    });
    return ensureOk<SearchD3FendResponse>(result);
  }

  /**
   * Search CISA's Known Exploited Vulnerabilities catalog.
   *
   * An empty call pages the whole catalog; `cveId` checks one CVE's KEV status.
   *
   * @param options `cveId`, `ransomwareStatus`, `limit`, `page`.
   */
  async searchKev(
    options: {
      cveId?: string;
      ransomwareStatus?: NonNullable<SearchKevRequest["ransomware_status"]>;
      limit?: number;
      page?: number;
    } = {},
  ): Promise<SearchKevResponse> {
    const result = await searchKev({
      client: this._client,
      body: {
        ...(options.cveId !== undefined && { cve_id: options.cveId }),
        ...(options.ransomwareStatus !== undefined && {
          ransomware_status: options.ransomwareStatus,
        }),
        limit: options.limit ?? 50,
        page: options.page ?? 1,
      },
    });
    return ensureOk<SearchKevResponse>(result);
  }

  /**
   * Hybrid-search the curated security knowledge base.
   *
   * @param query Natural-language question or keyword set.
   * @param options `collections` to search, `alpha` to trade keyword vs. vector
   *   weighting (0 = pure vector, 1 = pure keyword), and `limit`.
   */
  async searchKnowledgebase(
    query: string,
    options: {
      collections?: SearchKnowledgebaseRequest["collections"];
      alpha?: number;
      limit?: number;
    } = {},
  ): Promise<SearchKnowledgebaseResponse> {
    const result = await searchKnowledgebase({
      client: this._client,
      body: {
        query,
        ...(options.collections !== undefined && {
          collections: options.collections,
        }),
        alpha: options.alpha ?? 0.7,
        limit: options.limit ?? 10,
      },
    });
    return ensureOk<SearchKnowledgebaseResponse>(result);
  }

  /**
   * Search MISP events and attributes.
   *
   * @param options Attribute filters (`value`, `typeAttribute`, `category`, `toIds`),
   *   event filters (`eventId`, `eventinfo`, `tags`, `threatLevelId`, `published`),
   *   a `dateFrom`/`dateTo` window, plus `limit` and `page`.
   */
  async searchMisp(
    options: {
      value?: string;
      typeAttribute?: string;
      category?: string;
      toIds?: boolean;
      eventId?: string;
      eventinfo?: string;
      tags?: readonly string[];
      threatLevelId?: string;
      published?: boolean;
      dateFrom?: string;
      dateTo?: string;
      limit?: number;
      page?: number;
    } = {},
  ): Promise<SearchMispResponse> {
    const result = await searchMisp({
      client: this._client,
      body: {
        ...(options.value !== undefined && { value: options.value }),
        ...(options.typeAttribute !== undefined && {
          type_attribute: options.typeAttribute,
        }),
        ...(options.category !== undefined && { category: options.category }),
        ...(options.toIds !== undefined && { to_ids: options.toIds }),
        ...(options.eventId !== undefined && { event_id: options.eventId }),
        ...(options.eventinfo !== undefined && {
          eventinfo: options.eventinfo,
        }),
        ...(options.tags !== undefined && { tags: [...options.tags] }),
        ...(options.threatLevelId !== undefined && {
          threat_level_id: options.threatLevelId,
        }),
        ...(options.published !== undefined && {
          published: options.published,
        }),
        ...(options.dateFrom !== undefined && { date_from: options.dateFrom }),
        ...(options.dateTo !== undefined && { date_to: options.dateTo }),
        limit: options.limit ?? 50,
        page: options.page ?? 1,
      },
    });
    return ensureOk<SearchMispResponse>(result);
  }

  /**
   * Find public proof-of-concept exploits for a CVE.
   *
   * Pair with {@link enrichPocSource} to pull the code behind a match.
   *
   * @param cveId CVE identifier (e.g. `CVE-2024-3400`).
   * @param options Optional `limit` (default 25).
   */
  async searchPoc(
    cveId: string,
    options: { limit?: number } = {},
  ): Promise<SearchPocResponse> {
    const result = await searchPoc({
      client: this._client,
      body: {
        cve_id: cveId,
        limit: options.limit ?? 25,
      },
    });
    return ensureOk<SearchPocResponse>(result);
  }

  /**
   * List the products a vendor ships, as known to the CPE dictionary.
   *
   * Use it to resolve the exact product string {@link enrichProductFull} expects.
   *
   * @param vendor Vendor name (e.g. `"microsoft"`).
   * @param options Optional `limit` (default 50).
   */
  async searchVendor(
    vendor: string,
    options: { limit?: number } = {},
  ): Promise<SearchVendorResponse> {
    const result = await searchVendor({
      client: this._client,
      body: {
        vendor,
        limit: options.limit ?? 50,
      },
    });
    return ensureOk<SearchVendorResponse>(result);
  }

  // -- Async enrichment engines ------------------------------------------ //
  //
  // Both engines are submit-then-poll: the submit returns an `enrichment_id`,
  // and the matching `*Status` read reports progress until the report is ready.
  // `client.enricher` wraps the artifact engine's full lifecycle (submit, poll,
  // fetch) for callers who want the loop written for them; these two pairs are
  // the raw operations.

  /**
   * Submit documents and/or text to the async artifact-enrichment engine.
   *
   * Returns immediately with an `enrichment_id` — poll {@link artifactEnrichStatus}
   * for the result, or use {@link enricher} to run the whole lifecycle.
   *
   * @param options `text` and/or base64 `files` to analyze, output `formats`,
   *   report `include` sections, and an SSVC `stakeholder` profile.
   */
  async artifactEnrich(
    options: {
      text?: string;
      files?: ArtifactEnrichmentDocRequest["files"];
      formats?: ArtifactEnrichmentDocRequest["formats"];
      include?: readonly string[];
      stakeholder?: ArtifactEnrichmentStakeholder;
    } = {},
  ): Promise<ArtifactEnrichResponse> {
    const result = await artifactEnrich({
      client: this._client,
      body: {
        ...(options.text !== undefined && { text: options.text }),
        ...(options.files !== undefined && { files: options.files }),
        ...(options.formats !== undefined && { formats: options.formats }),
        ...(options.include !== undefined && { include: [...options.include] }),
        ...(options.stakeholder !== undefined && {
          stakeholder: options.stakeholder,
        }),
      },
    });
    return ensureOk<ArtifactEnrichResponse>(result);
  }

  /**
   * Read the progress or result of an artifact enrichment.
   *
   * @param enrichmentId The `enrichment_id` returned by {@link artifactEnrich}.
   */
  async artifactEnrichStatus(
    enrichmentId: string,
  ): Promise<ArtifactEnrichStatusResponse> {
    const result = await artifactEnrichStatus({
      client: this._client,
      path: { enrichment_id: enrichmentId },
    });
    return ensureOk<ArtifactEnrichStatusResponse>(result);
  }

  /**
   * Submit an asset inventory to the async inventory-enrichment engine.
   *
   * Returns immediately with an `enrichment_id` — poll {@link inventoryEnrichStatus}
   * for the result. Enriches each asset's CVEs and rolls the findings up to a
   * fleet-level risk picture.
   *
   * @param items Assets to enrich, each at minimum `{ product }`.
   * @param options Optional `attachmentsText`/`attachmentsFiles` for extra context
   *   and per-asset CVE `include` layers.
   */
  async inventoryEnrich(
    items: readonly InventoryAsset[],
    options: {
      attachmentsText?: string;
      attachmentsFiles?: ArtifactEnrichmentDocRequest["files"];
      include?: readonly string[];
    } = {},
  ): Promise<InventoryEnrichResponse> {
    const result = await inventoryEnrich({
      client: this._client,
      body: {
        items: [...items],
        ...(options.attachmentsText !== undefined && {
          attachments_text: options.attachmentsText,
        }),
        ...(options.attachmentsFiles !== undefined && {
          attachments_files: options.attachmentsFiles,
        }),
        ...(options.include !== undefined && { include: [...options.include] }),
      },
    });
    return ensureOk<InventoryEnrichResponse>(result);
  }

  /**
   * Read the progress or result of an inventory enrichment.
   *
   * @param enrichmentId The `enrichment_id` returned by {@link inventoryEnrich}.
   */
  async inventoryEnrichStatus(
    enrichmentId: string,
  ): Promise<InventoryEnrichStatusResponse> {
    const result = await inventoryEnrichStatus({
      client: this._client,
      path: { enrichment_id: enrichmentId },
    });
    return ensureOk<InventoryEnrichStatusResponse>(result);
  }
}

interface HeyApiResult {
  data?: unknown;
  error?: unknown;
  response?: Response;
}

function ensureOk<T>(result: HeyApiResult): T {
  if (result.data !== undefined && result.error === undefined) {
    return result.data as T;
  }
  const status = result.response?.status ?? 0;
  const url = result.response?.url ?? "(no url)";
  throw new UnexpectedStatus(
    status,
    result.error ?? result.data,
    `Crimson Crawler API ${status} on ${url}`,
  );
}
