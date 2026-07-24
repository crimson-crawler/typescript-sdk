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
 enrichCve,
 enrichCwe,
 enrichIoc,
 enrichPackage,
 enrichProduct,
 enrichTechnique,
 searchCti,
} from "./_generated/sdk.gen";
import type {
 EnrichCveResponse,
 EnrichCweResponse,
 EnrichIocResponse,
 EnrichPackageResponse,
 EnrichProductResponse,
 EnrichTechniqueResponse,
 SearchCtiResponse,
} from "./_generated/types.gen";
import { MissingCredentials, UnexpectedStatus } from "./exceptions";
import { AiReportsApi } from "./ai-reports";
import { ArtifactManagerApi, type ArtifactManagerFetch } from "./artifact-manager";
import { InventoryManagerApi } from "./inventory-manager";
import { EnricherApi } from "./enricher";
import {
 CVE_FULL_WALK,
 CWE_FULL_WALK,
 IOC_FULL_WALK,
 PACKAGE_FULL,
 PRODUCT_FULL,
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
}

function resolveVerifySsl(verifySsl: boolean | undefined): boolean {
 if (verifySsl !== undefined) return verifySsl;
 const raw = globalThis.process?.env?.[ENV_VERIFY_SSL]?.trim().toLowerCase() ?? "true";
 return !(raw === "false" || raw === "0" || raw === "no");
}

/**
 * Typed wrapper around the generated Crimson Crawler API client.
 *
 * Each instance owns its own Hey API `Client` (created fresh in the
 * constructor and passed explicitly to every generated call) so concurrent
 * `CrawlerClient` instances with different credentials — e.g. one per tenant
 * in a multi-tenant Node process — never cross-contaminate each other's
 * `apiKey`/`baseUrl`/`fetch`. The one exception is the documented "power-user"
 * escape hatch: importing a generated function straight from `_generated/sdk.gen`
 * without passing `client:` explicitly still rides the shared module-level
 * singleton, which this constructor also configures — that path is
 * inherently single-instance (last `CrawlerClient` constructed wins) and is
 * intended for simple single-client scripts, not multi-tenant use.
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
  const retryFetch: ArtifactManagerFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
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
   const requestSignal = !initSignal && input instanceof Request ? input.signal : undefined;
   const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
   const retryable = RETRYABLE_METHODS[method] === true;
   let attempt = 0;
   for (; ;) {
    // Fresh timeout signal per attempt — a consumed AbortSignal.timeout
    // can't be reused, and each retry deserves a full timeout budget.
    const timeoutSignal = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
    const signal = initSignal ?? (requestSignal ? AbortSignal.any([requestSignal, timeoutSignal]) : timeoutSignal);
    try {
     const resp = await fetchWithTls(input, {
      ...init,
      signal,
      redirect: "manual",
     });
     if (retryable && RETRYABLE_STATUS.has(resp.status) && attempt < maxRetries) {
      await sleepBackoff(attempt, resp.headers.get("retry-after"), retryCfg);
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
   headers: { apikey: apiKey },
   fetch: retryFetch,
  };
  // Instance-scoped client — passed explicitly to every generated call
  // below (and returned by `.api`), so this instance's requests are
  // immune to any other `CrawlerClient` constructed later.
  this._client = createClient(clientConfig);
  // Also configure the shared generated-module singleton for the
  // documented power-user escape hatch (see class doc comment above).
  defaultClient.setConfig(clientConfig);

  this._artifactManager = new ArtifactManagerApi(this.baseUrl, apiKey, retryFetch);
  this._inventoryManager = new InventoryManagerApi(this.baseUrl, apiKey, retryFetch);
  this._enricher = new EnricherApi(this.baseUrl, apiKey, retryFetch);
  this._aiReports = new AiReportsApi(this.baseUrl, apiKey, retryFetch);
 }

 /** Underlying Hey API client, scoped to this instance. Use to call any of the 29 endpoints directly. */
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
