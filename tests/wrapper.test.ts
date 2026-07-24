/**
 * Wrapper-layer unit tests for @crimson-crawler/crimson-crawler-client.
 *
 * Covers the hand-written code in src/{client,exceptions,presets,index}.ts —
 * the parts the build pipeline doesn't otherwise exercise.
 * Generated _generated/ modules are not tested here (they're regenerated
 * from openapi.snapshot.json on every CI run).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the generated SDK functions before importing client.ts so we can
// observe call args + return synthetic responses.
const mockEnrichCve = vi.fn();
const mockEnrichIoc = vi.fn();
const mockEnrichCwe = vi.fn();
const mockEnrichTechnique = vi.fn();
const mockEnrichProduct = vi.fn();
const mockEnrichPackage = vi.fn();
const mockSearchCti = vi.fn();

vi.mock("../src/_generated/sdk.gen", () => ({
 enrichCve: (...args: unknown[]) => mockEnrichCve(...args),
 enrichIoc: (...args: unknown[]) => mockEnrichIoc(...args),
 enrichCwe: (...args: unknown[]) => mockEnrichCwe(...args),
 enrichTechnique: (...args: unknown[]) => mockEnrichTechnique(...args),
 enrichProduct: (...args: unknown[]) => mockEnrichProduct(...args),
 enrichPackage: (...args: unknown[]) => mockEnrichPackage(...args),
 searchCti: (...args: unknown[]) => mockSearchCti(...args),
}));

// Spy on defaultClient.setConfig so we can verify constructor wiring.
const setConfigSpy = vi.fn();
vi.mock("../src/_generated/client.gen", () => ({
 client: {
  setConfig: (cfg: unknown) => setConfigSpy(cfg),
 },
}));

// Replace the retry helper's sleep with a no-op spy so retry-loop tests never
// actually wait. We keep the real backoff math + Retry-After parsing so we can
// assert the delay the loop *would* have slept (via resolveDelay).
const sleepBackoffSpy = vi.fn(async () => { });
vi.mock("../src/retry", async (importOriginal) => {
 const actual = await importOriginal<typeof import("../src/retry")>();
 return {
  ...actual,
  sleepBackoff: (
   attempt: number,
   retryAfter: string | null | undefined,
   cfg: import("../src/retry").RetryConfig,
  ) => sleepBackoffSpy(attempt, retryAfter, cfg),
 };
});

const { undiciAgentSpy } = vi.hoisted(() => ({
 undiciAgentSpy: vi.fn(function Agent() {
  return { kind: "scoped-dispatcher" };
 }),
}));

vi.mock("undici", () => ({
 Agent: undiciAgentSpy,
}));

// Imports below the vi.mock() block above are intentional — Vitest hoists
// vi.mock() to the top of the module, so the runtime ordering is correct.
import {
 BASE_URL,
 CrawlerClient,
 CrawlerClientError,
 DEFAULT_TIMEOUT_MS,
 ENV_API_KEY,
 ENV_BASE_URL,
 ENV_VERIFY_SSL,
 MissingCredentials,
 UnexpectedStatus,
 __version__,
 presets,
} from "../src/index";

const {
 CVE_FAST,
 CVE_FULL_WALK,
 CVE_NARRATIVE,
 CWE_FULL_WALK,
 IOC_FAST,
 IOC_FULL_WALK,
 PACKAGE_FULL,
 PRODUCT_FULL,
 TECHNIQUE_FULL,
} = presets;

// --------------------------------------------------------------------------- //
// Module-level constants and exports
// --------------------------------------------------------------------------- //

describe("module surface", () => {
 it("exports the default base URL", () => {
  expect(BASE_URL).toBe("https://crimsoncrawler.com");
 });

 it("exports the env var names", () => {
  expect(ENV_API_KEY).toBe("CRIMSON_CRAWLER_API_KEY");
  expect(ENV_BASE_URL).toBe("CRIMSON_CRAWLER_BASE_URL");
 });

 it("exports a positive timeout", () => {
  expect(DEFAULT_TIMEOUT_MS).toBeGreaterThan(0);
 });

 it("exports a semver-shaped version", () => {
  expect(__version__).toMatch(/^\d+\.\d+\.\d+/);
 });

 it("exports non-empty preset arrays", () => {
  for (const preset of [
   CVE_FULL_WALK,
   IOC_FULL_WALK,
   CWE_FULL_WALK,
   TECHNIQUE_FULL,
   PRODUCT_FULL,
   PACKAGE_FULL,
   CVE_FAST,
   CVE_NARRATIVE,
   IOC_FAST,
  ]) {
   expect(preset.length).toBeGreaterThan(0);
   expect(preset.every((s) => typeof s === "string")).toBe(true);
  }
 });
});

// --------------------------------------------------------------------------- //
// Exception hierarchy
// --------------------------------------------------------------------------- //

describe("exceptions", () => {
 it("MissingCredentials extends CrawlerClientError", () => {
  const exc = new MissingCredentials("no key");
  expect(exc).toBeInstanceOf(CrawlerClientError);
  expect(exc).toBeInstanceOf(Error);
  expect(exc.name).toBe("MissingCredentials");
 });

 it("UnexpectedStatus carries status + body", () => {
  const exc = new UnexpectedStatus(503, "upstream down", "boom");
  expect(exc).toBeInstanceOf(CrawlerClientError);
  expect(exc.status).toBe(503);
  expect(exc.body).toBe("upstream down");
  expect(exc.message).toBe("boom");
  expect(exc.name).toBe("UnexpectedStatus");
 });

 it("UnexpectedStatus default message includes status code", () => {
  const exc = new UnexpectedStatus(418, { error: "teapot" });
  expect(exc.message).toContain("418");
 });
});

// --------------------------------------------------------------------------- //
// Constructor
// --------------------------------------------------------------------------- //

describe("CrawlerClient constructor", () => {
 beforeEach(() => {
  setConfigSpy.mockClear();
  delete process.env[ENV_API_KEY];
  delete process.env[ENV_BASE_URL];
  delete process.env[ENV_VERIFY_SSL];
 });

 it("throws MissingCredentials when no api key", () => {
  expect(() => new CrawlerClient()).toThrow(MissingCredentials);
 });

 it("treats empty string api key as missing", () => {
  expect(() => new CrawlerClient({ apiKey: "" })).toThrow(MissingCredentials);
 });

 it("falls back to env var", () => {
  process.env[ENV_API_KEY] = "from-env";
  const client = new CrawlerClient();
  expect(client.baseUrl).toBe(BASE_URL);
  expect(setConfigSpy).toHaveBeenCalledWith(
   expect.objectContaining({ headers: { apikey: "from-env" } }),
  );
 });

 it("constructor api key wins over env", () => {
  process.env[ENV_API_KEY] = "from-env";
  new CrawlerClient({ apiKey: "from-arg" });
  expect(setConfigSpy).toHaveBeenCalledWith(
   expect.objectContaining({ headers: { apikey: "from-arg" } }),
  );
 });

 it("base url precedence: arg > env > default", () => {
  process.env[ENV_BASE_URL] = "https://env.example";
  const client = new CrawlerClient({
   apiKey: "k",
   baseUrl: "https://arg.example",
  });
  expect(client.baseUrl).toBe("https://arg.example");
 });

 it("base url falls back to env", () => {
  process.env[ENV_BASE_URL] = "https://env.example";
  const client = new CrawlerClient({ apiKey: "k" });
  expect(client.baseUrl).toBe("https://env.example");
 });

 it("default verifySsl is true", () => {
  const client = new CrawlerClient({ apiKey: "k" });
  expect(client.verifySsl).toBe(true);
 });

 it("verifySsl constructor false disables verification", () => {
  const client = new CrawlerClient({ apiKey: "k", verifySsl: false });
  expect(client.verifySsl).toBe(false);
 });

 it("verifySsl=false never mutates process-wide TLS state", () => {
  const prior = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "unchanged";
  undiciAgentSpy.mockClear();
  try {
   new CrawlerClient({ apiKey: "k", baseUrl: "https://x", verifySsl: false });
   expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe("unchanged");
   expect(undiciAgentSpy).not.toHaveBeenCalled();
  } finally {
   if (prior === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
   else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prior;
  }
 });

 it("verifySsl=false fails closed outside Node", async () => {
  setConfigSpy.mockClear();
  new CrawlerClient({ apiKey: "k", baseUrl: "https://x", verifySsl: false });
  const clientConfig = setConfigSpy.mock.calls[0]?.[0] as { fetch: typeof fetch };
  const scopedFetch = clientConfig.fetch;
  const globalFetchSpy = vi.spyOn(globalThis, "fetch");

  vi.stubGlobal("process", undefined);
  try {
   await expect(scopedFetch("https://x/v1")).rejects.toThrow(
    "verifySsl=false is only supported in Node.js",
   );
   expect(globalFetchSpy).not.toHaveBeenCalled();
  } finally {
   globalFetchSpy.mockRestore();
   vi.unstubAllGlobals();
  }
 });

 it.each([
  ["false", false], ["0", false], ["no", false],
  ["FALSE", false], [" No ", false],
  ["true", true], ["1", true], ["yes", true], ["garbage", true],
 ])("verifySsl env var parsing %s → %s", (raw: string, expected: boolean) => {
  process.env[ENV_VERIFY_SSL] = raw;
  const client = new CrawlerClient({ apiKey: "k" });
  expect(client.verifySsl).toBe(expected);
 });

 it("verifySsl constructor wins over env", () => {
  process.env[ENV_VERIFY_SSL] = "false";
  const client = new CrawlerClient({ apiKey: "k", verifySsl: true });
  expect(client.verifySsl).toBe(true);
 });

 it("default base url when nothing set", () => {
  const client = new CrawlerClient({ apiKey: "k" });
  expect(client.baseUrl).toBe(BASE_URL);
 });

 it("wires custom fetch with abort timeout", () => {
  new CrawlerClient({ apiKey: "k" });
  const cfg = setConfigSpy.mock.calls[0]?.[0] as { fetch?: typeof fetch };
  expect(typeof cfg.fetch).toBe("function");
 });

 it("custom fetch invokes native fetch with an abort signal", async () => {
  new CrawlerClient({ apiKey: "k" });
  const cfg = setConfigSpy.mock.calls[0]?.[0] as { fetch: typeof fetch };

  const fetchSpy = vi
   .spyOn(globalThis, "fetch")
   .mockResolvedValue(new Response(null, { status: 204 }));
  try {
   await cfg.fetch("https://example.test/v1");
   expect(fetchSpy).toHaveBeenCalledTimes(1);
   const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
   expect(init.signal).toBeInstanceOf(AbortSignal);
   expect(init.redirect).toBe("manual");
  } finally {
   fetchSpy.mockRestore();
  }
 });

 it("custom fetch preserves caller-provided signal", async () => {
  new CrawlerClient({ apiKey: "k" });
  const cfg = setConfigSpy.mock.calls[0]?.[0] as { fetch: typeof fetch };
  const callerSignal = new AbortController().signal;

  const fetchSpy = vi
   .spyOn(globalThis, "fetch")
   .mockResolvedValue(new Response(null, { status: 204 }));
  try {
   await cfg.fetch("https://example.test/v1", { signal: callerSignal });
   const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
   expect(init.signal).toBe(callerSignal);
  } finally {
   fetchSpy.mockRestore();
  }
 });

 it("client.api returns the underlying Hey API client", () => {
  const client = new CrawlerClient({ apiKey: "k" });
  expect(typeof client.api.setConfig).toBe("function");
 });

 it("each instance owns a distinct client — later construction doesn't mutate an earlier instance", () => {
  const a = new CrawlerClient({ apiKey: "key-a", baseUrl: "https://a.test" });
  const b = new CrawlerClient({ apiKey: "key-b", baseUrl: "https://b.test" });

  expect(a.api).not.toBe(b.api);
  // `a`'s client must still carry `a`'s own config after `b` was constructed —
  // this is the regression the shared-singleton-mutation bug would fail.
  expect(a.api.getConfig().headers.get("apikey")).toBe("key-a");
  expect(a.api.getConfig().baseUrl).toBe("https://a.test");
  expect(b.api.getConfig().headers.get("apikey")).toBe("key-b");
  expect(b.api.getConfig().baseUrl).toBe("https://b.test");
 });

 it("default maxRetries is 2", () => {
  const client = new CrawlerClient({ apiKey: "k" });
  expect(client.maxRetries).toBe(2);
 });

 it("maxRetries=0 is valid (disables retries)", () => {
  const client = new CrawlerClient({ apiKey: "k", maxRetries: 0 });
  expect(client.maxRetries).toBe(0);
 });

 it("maxRetries<0 throws RangeError", () => {
  expect(() => new CrawlerClient({ apiKey: "k", maxRetries: -1 })).toThrow(
   RangeError,
  );
 });

 it("non-integer maxRetries throws RangeError", () => {
  expect(() => new CrawlerClient({ apiKey: "k", maxRetries: 1.5 })).toThrow(
   RangeError,
  );
 });
});

// --------------------------------------------------------------------------- //
// Convenience methods: preset + delegation
// --------------------------------------------------------------------------- //

const okData = (data: unknown) => ({ data, error: undefined });
const errData = (status: number, body: unknown) => ({
 data: undefined,
 error: body,
 response: { status, url: "https://test/v1" } as Response,
});

describe("convenience methods", () => {
 beforeEach(() => {
  process.env[ENV_API_KEY] = "test-key";
  [
   mockEnrichCve,
   mockEnrichIoc,
   mockEnrichCwe,
   mockEnrichTechnique,
   mockEnrichProduct,
   mockEnrichPackage,
   mockSearchCti,
  ].forEach((m) => m.mockReset());
 });

 afterEach(() => {
  delete process.env[ENV_API_KEY];
 });

 it("enrichCveFull uses CVE_FULL_WALK by default", async () => {
  mockEnrichCve.mockResolvedValue(okData({ cve: {} }));
  const client = new CrawlerClient();
  const result = await client.enrichCveFull("CVE-2024-3400");
  expect(result).toEqual({ cve: {} });
  expect(mockEnrichCve).toHaveBeenCalledWith({
   client: client.api,
   body: { cve_id: "CVE-2024-3400", include: [...CVE_FULL_WALK] },
  });
 });

 it("enrichCveFull custom include overrides preset", async () => {
  mockEnrichCve.mockResolvedValue(okData({}));
  const client = new CrawlerClient();
  await client.enrichCveFull("CVE-2024-1", ["details"]);
  expect(mockEnrichCve.mock.calls[0]?.[0].body.include).toEqual(["details"]);
 });

 it("enrichCveFull non-2xx raises UnexpectedStatus with status + body", async () => {
  mockEnrichCve.mockResolvedValue(errData(503, "upstream"));
  const client = new CrawlerClient();
  await expect(client.enrichCveFull("CVE-2024-3400")).rejects.toMatchObject({
   name: "UnexpectedStatus",
   status: 503,
   body: "upstream",
  });
 });

 it("enrichIocFull passes value, type, preset", async () => {
  mockEnrichIoc.mockResolvedValue(okData({}));
  const client = new CrawlerClient();
  await client.enrichIocFull("8.8.8.8", "ip-dst");
  expect(mockEnrichIoc).toHaveBeenCalledWith({
   client: client.api,
   body: {
    value: "8.8.8.8",
    type: "ip-dst",
    include: [...IOC_FULL_WALK],
   },
  });
 });

 it("enrichCweFull passes id and preset", async () => {
  mockEnrichCwe.mockResolvedValue(okData({}));
  const client = new CrawlerClient();
  await client.enrichCweFull("CWE-79");
  expect(mockEnrichCwe).toHaveBeenCalledWith({
   client: client.api,
   body: { cwe_id: "CWE-79", include: [...CWE_FULL_WALK] },
  });
 });

 it("enrichTechniqueFull passes framework and preset", async () => {
  mockEnrichTechnique.mockResolvedValue(okData({}));
  const client = new CrawlerClient();
  await client.enrichTechniqueFull(["T1190"], "ics");
  expect(mockEnrichTechnique).toHaveBeenCalledWith({
   client: client.api,
   body: {
    technique_ids: ["T1190"],
    framework: "ics",
    include: [...TECHNIQUE_FULL],
   },
  });
 });

 it("enrichProductFull omits version + vendor by default", async () => {
  mockEnrichProduct.mockResolvedValue(okData({}));
  const client = new CrawlerClient();
  await client.enrichProductFull("nginx");
  const body = mockEnrichProduct.mock.calls[0]?.[0].body;
  expect(body.product).toBe("nginx");
  expect(body.version).toBeUndefined();
  expect(body.vendor).toBeUndefined();
  expect(body.include).toEqual([...PRODUCT_FULL]);
 });

 it("enrichProductFull passes optional version + vendor when provided", async () => {
  mockEnrichProduct.mockResolvedValue(okData({}));
  const client = new CrawlerClient();
  await client.enrichProductFull("nginx", { version: "1.25", vendor: "nginx" });
  const body = mockEnrichProduct.mock.calls[0]?.[0].body;
  expect(body.version).toBe("1.25");
  expect(body.vendor).toBe("nginx");
 });

 it("enrichPackageFull omits version by default + wires the preset", async () => {
  mockEnrichPackage.mockResolvedValue(okData({}));
  const client = new CrawlerClient();
  await client.enrichPackageFull("PyPI", "django");
  const body = mockEnrichPackage.mock.calls[0]?.[0].body;
  expect(body.ecosystem).toBe("PyPI");
  expect(body.package).toBe("django");
  expect(body.version).toBeUndefined();
  expect(body.include).toEqual([...PACKAGE_FULL]);
 });

 it("enrichPackageFull passes version + include override when provided", async () => {
  mockEnrichPackage.mockResolvedValue(okData({}));
  const client = new CrawlerClient();
  await client.enrichPackageFull("npm", "lodash", { version: "4.17.20", include: ["epss"] });
  const body = mockEnrichPackage.mock.calls[0]?.[0].body;
  expect(body.version).toBe("4.17.20");
  expect(body.include).toEqual(["epss"]);
 });

 it("ensureOk uses status 0 when response missing", async () => {
  mockEnrichIoc.mockResolvedValue({ data: undefined, error: "boom" });
  const client = new CrawlerClient();
  await expect(client.enrichIocFull("8.8.8.8")).rejects.toMatchObject({
   status: 0,
  });
 });

 it("searchTechniques wires query + attack scope + limit", async () => {
  mockSearchCti.mockResolvedValue(okData({ results: [] }));
  const client = new CrawlerClient();
  await client.searchTechniques("credential dumping", { limit: 5 });
  const body = mockSearchCti.mock.calls[0]?.[0].body;
  expect(body.query).toBe("credential dumping");
  expect(body.sources).toEqual(["attack"]);
  expect(body.types).toEqual(["attack-pattern"]);
  expect(body.limit).toBe(5);
 });

 it("searchTechniques defaults limit to 20", async () => {
  mockSearchCti.mockResolvedValue(okData({ results: [] }));
  const client = new CrawlerClient();
  await client.searchTechniques("phishing");
  expect(mockSearchCti.mock.calls[0]?.[0].body.limit).toBe(20);
 });

 it("searchTechniques throws UnexpectedStatus on error", async () => {
  mockSearchCti.mockResolvedValue(
   errData(503, "upstream down"),
  );
  const client = new CrawlerClient();
  await expect(client.searchTechniques("phishing")).rejects.toBeInstanceOf(
   UnexpectedStatus,
  );
 });
});

// --------------------------------------------------------------------------- //
// Retry loop (the custom fetch installed in setConfig)
// --------------------------------------------------------------------------- //
//
// The retry logic lives in the custom `fetch` the constructor passes to
// setConfig. We grab that captured fetch and drive it directly against a
// stubbed global.fetch. `sleepBackoff` is mocked to a no-op spy (top of file)
// so the loop never waits; we assert on its call count + the Retry-After arg.
// The generated layer (mocked in the convenience-method block above) only ever
// sees the *final* response/throw from this fetch, then ensureOk maps a final
// non-2xx to UnexpectedStatus — that mapping is covered by the convenience
// tests; here we assert the loop's own behavior.

function captureFetch(opts?: {
 apiKey?: string;
 maxRetries?: number;
}): typeof fetch {
 setConfigSpy.mockClear();
 new CrawlerClient({ apiKey: opts?.apiKey ?? "k", maxRetries: opts?.maxRetries });
 const cfg = setConfigSpy.mock.calls[0]?.[0] as { fetch: typeof fetch };
 return cfg.fetch;
}

const resp = (status: number) => new Response(null, { status });
const respWith = (status: number, headers: Record<string, string>) =>
 new Response(null, { status, headers });

describe("retry loop", () => {
 beforeEach(() => {
  sleepBackoffSpy.mockClear();
 });

 it("retries a retryable status then succeeds", async () => {
  const f = captureFetch();
  const fetchSpy = vi
   .spyOn(globalThis, "fetch")
   .mockResolvedValueOnce(resp(503))
   .mockResolvedValueOnce(resp(200));
  try {
   const out = await f("https://x/v1");
   expect(out.status).toBe(200);
   expect(fetchSpy).toHaveBeenCalledTimes(2);
   expect(sleepBackoffSpy).toHaveBeenCalledTimes(1);
  } finally {
   fetchSpy.mockRestore();
  }
 });

 it("exhausts the budget and returns the final retryable response", async () => {
  const f = captureFetch(); // default maxRetries=2
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(resp(503));
  try {
   const out = await f("https://x/v1");
   expect(out.status).toBe(503);
   expect(fetchSpy).toHaveBeenCalledTimes(3); // 1 + 2 retries
   expect(sleepBackoffSpy).toHaveBeenCalledTimes(2);
  } finally {
   fetchSpy.mockRestore();
  }
 });

 it.each([429, 502, 503, 504])("retries status %i", async (status) => {
  const f = captureFetch();
  const fetchSpy = vi
   .spyOn(globalThis, "fetch")
   .mockResolvedValueOnce(resp(status))
   .mockResolvedValueOnce(resp(200));
  try {
   const out = await f("https://x/v1");
   expect(out.status).toBe(200);
   expect(sleepBackoffSpy).toHaveBeenCalledTimes(1);
  } finally {
   fetchSpy.mockRestore();
  }
 });

 it.each([400, 401, 403, 404, 422, 500])(
  "does NOT retry non-retryable status %i",
  async (status) => {
   const f = captureFetch();
   const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(resp(status));
   try {
    const out = await f("https://x/v1");
    expect(out.status).toBe(status);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(sleepBackoffSpy).not.toHaveBeenCalled();
   } finally {
    fetchSpy.mockRestore();
   }
  },
 );

 it("retries a thrown network TypeError then succeeds", async () => {
  const f = captureFetch();
  const fetchSpy = vi
   .spyOn(globalThis, "fetch")
   .mockRejectedValueOnce(new TypeError("fetch failed"))
   .mockResolvedValueOnce(resp(200));
  try {
   const out = await f("https://x/v1");
   expect(out.status).toBe(200);
   expect(sleepBackoffSpy).toHaveBeenCalledTimes(1);
  } finally {
   fetchSpy.mockRestore();
  }
 });

 it("does not retry a POST response", async () => {
  const f = captureFetch();
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(resp(503));
  try {
   const out = await f("https://x/v1", { method: "POST" });
   expect(out.status).toBe(503);
   expect(fetchSpy).toHaveBeenCalledTimes(1);
   expect(sleepBackoffSpy).not.toHaveBeenCalled();
  } finally {
   fetchSpy.mockRestore();
  }
 });

 it("does not retry a POST network error", async () => {
  const f = captureFetch();
  const err = new TypeError("fetch failed");
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(err);
  try {
   await expect(f("https://x/v1", { method: "POST" })).rejects.toBe(err);
   expect(fetchSpy).toHaveBeenCalledTimes(1);
   expect(sleepBackoffSpy).not.toHaveBeenCalled();
  } finally {
   fetchSpy.mockRestore();
  }
 });

 it("network TypeError exhausts then propagates", async () => {
  const f = captureFetch();
  const err = new TypeError("fetch failed");
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(err);
  try {
   await expect(f("https://x/v1")).rejects.toBe(err);
   expect(fetchSpy).toHaveBeenCalledTimes(3);
   expect(sleepBackoffSpy).toHaveBeenCalledTimes(2);
  } finally {
   fetchSpy.mockRestore();
  }
 });

 it("passes Retry-After through to sleepBackoff (delta-seconds)", async () => {
  const f = captureFetch();
  const fetchSpy = vi
   .spyOn(globalThis, "fetch")
   .mockResolvedValueOnce(respWith(503, { "retry-after": "2" }))
   .mockResolvedValueOnce(resp(200));
  try {
   await f("https://x/v1");
   expect(sleepBackoffSpy).toHaveBeenCalledTimes(1);
   // (attempt, retryAfter, cfg)
   expect(sleepBackoffSpy.mock.calls[0]?.[1]).toBe("2");
  } finally {
   fetchSpy.mockRestore();
  }
 });

 it("passes Retry-After HTTP-date through to sleepBackoff", async () => {
  const f = captureFetch();
  const when = "Thu, 01 Jan 2026 00:00:05 GMT";
  const fetchSpy = vi
   .spyOn(globalThis, "fetch")
   .mockResolvedValueOnce(respWith(503, { "retry-after": when }))
   .mockResolvedValueOnce(resp(200));
  try {
   await f("https://x/v1");
   expect(sleepBackoffSpy.mock.calls[0]?.[1]).toBe(when);
  } finally {
   fetchSpy.mockRestore();
  }
 });

 it("maxRetries=0 disables retries", async () => {
  const f = captureFetch({ maxRetries: 0 });
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(resp(503));
  try {
   const out = await f("https://x/v1");
   expect(out.status).toBe(503);
   expect(fetchSpy).toHaveBeenCalledTimes(1);
   expect(sleepBackoffSpy).not.toHaveBeenCalled();
  } finally {
   fetchSpy.mockRestore();
  }
 });

 it("a caller-supplied abort is not retried", async () => {
  const f = captureFetch();
  const controller = new AbortController();
  controller.abort();
  const abortErr = new DOMException("aborted", "AbortError");
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(abortErr);
  try {
   await expect(
    f("https://x/v1", { signal: controller.signal }),
   ).rejects.toBe(abortErr);
   expect(fetchSpy).toHaveBeenCalledTimes(1);
   expect(sleepBackoffSpy).not.toHaveBeenCalled();
   // The caller's own signal is forwarded unchanged (no fresh timeout).
   const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
   expect(init.signal).toBe(controller.signal);
  } finally {
   fetchSpy.mockRestore();
  }
 });

 // The generated Hey API client's real calling convention: a single Request
 // object (never a 2-arg (url, init) call), with any caller signal baked
 // into `request.signal`. Regression for the caller-signal-is-silently-
 // dropped bug — see the retryFetch closure's comment in client.ts.
 describe("Request-object calling convention (hey-api's real call shape)", () => {
  it("a fired request signal aborts the underlying fetch and is not retried", async () => {
   const f = captureFetch();
   const controller = new AbortController();
   const request = new Request("https://x/v1", { signal: controller.signal });
   controller.abort();
   const abortErr = new DOMException("aborted", "AbortError");
   const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(abortErr);
   try {
    await expect(f(request)).rejects.toBe(abortErr);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(sleepBackoffSpy).not.toHaveBeenCalled();
    const usedSignal = (fetchSpy.mock.calls[0]?.[1] as RequestInit).signal;
    expect(usedSignal?.aborted).toBe(true);
   } finally {
    fetchSpy.mockRestore();
   }
  });

  it("an unfired request signal does NOT disable the internal timeout (combined, not raw-forwarded)", async () => {
   const f = captureFetch();
   const controller = new AbortController(); // never aborted
   const request = new Request("https://x/v1", { signal: controller.signal });
   const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(resp(200));
   try {
    const out = await f(request);
    expect(out.status).toBe(200);
    const usedSignal = (fetchSpy.mock.calls[0]?.[1] as RequestInit).signal;
    // Previously this was `request.signal` verbatim (raw pass-through) —
    // meaning our timeout never applied once ANY request signal existed.
    // It must now be a distinct, combined signal so the timeout still guards.
    expect(usedSignal).toBeInstanceOf(AbortSignal);
    expect(usedSignal).not.toBe(request.signal);
    expect(usedSignal?.aborted).toBe(false);
   } finally {
    fetchSpy.mockRestore();
   }
  });

  it("a retryable status is still retried when the request carries an unfired signal", async () => {
   const f = captureFetch();
   const controller = new AbortController();
   const request = new Request("https://x/v1", { signal: controller.signal });
   const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(resp(503))
    .mockResolvedValueOnce(resp(200));
   try {
    const out = await f(request);
    expect(out.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(sleepBackoffSpy).toHaveBeenCalledTimes(1);
   } finally {
    fetchSpy.mockRestore();
   }
  });
 });

 it("each attempt gets a fresh timeout signal (no caller signal)", async () => {
  const f = captureFetch();
  const fetchSpy = vi
   .spyOn(globalThis, "fetch")
   .mockResolvedValueOnce(resp(503))
   .mockResolvedValueOnce(resp(200));
  try {
   await f("https://x/v1");
   const sig1 = (fetchSpy.mock.calls[0]?.[1] as RequestInit).signal;
   const sig2 = (fetchSpy.mock.calls[1]?.[1] as RequestInit).signal;
   expect(sig1).toBeInstanceOf(AbortSignal);
   expect(sig2).toBeInstanceOf(AbortSignal);
   expect(sig1).not.toBe(sig2); // fresh per attempt
  } finally {
   fetchSpy.mockRestore();
  }
 });

 it("uses one client-scoped undici dispatcher across retries when verifySsl=false", async () => {
  setConfigSpy.mockClear();
  undiciAgentSpy.mockClear();
  const globalFetchSpy = vi
   .spyOn(globalThis, "fetch")
   .mockResolvedValueOnce(resp(503))
   .mockResolvedValueOnce(resp(200));
  const priorTlsState = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "unchanged";

  try {
   new CrawlerClient({ apiKey: "k", baseUrl: "https://x", verifySsl: false });
   const clientConfig = setConfigSpy.mock.calls[0]?.[0] as { fetch: typeof fetch };
   const out = await clientConfig.fetch("https://x/v1");

   expect(out.status).toBe(200);
   expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe("unchanged");
   expect(undiciAgentSpy).toHaveBeenCalledTimes(1);
   expect(undiciAgentSpy).toHaveBeenCalledWith({
    connect: { rejectUnauthorized: false },
   });
   expect(globalFetchSpy).toHaveBeenCalledTimes(2);
   const dispatcher = undiciAgentSpy.mock.results[0]?.value;
   for (const call of globalFetchSpy.mock.calls) {
    const requestInit = call[1] as RequestInit & { dispatcher: unknown };
    expect(requestInit.dispatcher).toBe(dispatcher);
    expect(requestInit.signal).toBeInstanceOf(AbortSignal);
   }
  } finally {
   globalFetchSpy.mockRestore();
   if (priorTlsState === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
   else process.env.NODE_TLS_REJECT_UNAUTHORIZED = priorTlsState;
  }
 });
});
