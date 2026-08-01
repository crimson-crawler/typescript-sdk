/**
 * Wrapper-layer unit tests for @crimson-crawler/crimson-crawler-client.
 *
 * Covers the hand-written code in src/{client,exceptions,presets,index}.ts —
 * the parts the build pipeline doesn't otherwise exercise.
 * Generated _generated/ modules are not tested here (they're regenerated
 * from openapi.snapshot.json on every CI run).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { inspect } from "node:util";

// Mock the generated SDK functions before importing client.ts so we can
// observe call args + return synthetic responses.
const mockEnrichCve = vi.fn();
const mockEnrichIoc = vi.fn();
const mockEnrichCwe = vi.fn();
const mockEnrichTechnique = vi.fn();
const mockEnrichProduct = vi.fn();
const mockEnrichPackage = vi.fn();
const mockSearchCti = vi.fn();

// The 26 endpoints reached only by the full-surface parity methods. Hoisted as
// one object (like undiciAgentSpy below) so the factory can spread it wholesale
// instead of repeating an arrow indirection 26 more times.
const sdk = vi.hoisted(() => ({
  artifactEnrich: vi.fn(),
  artifactEnrichStatus: vi.fn(),
  assessGroupExposure: vi.fn(),
  assessIocPortfolio: vi.fn(),
  assessTechniqueCoverage: vi.fn(),
  assessVulnerabilityExposure: vi.fn(),
  enrichAtlas: vi.fn(),
  enrichBatch: vi.fn(),
  enrichCampaign: vi.fn(),
  enrichCapec: vi.fn(),
  enrichDefend: vi.fn(),
  enrichDisarm: vi.fn(),
  enrichGroup: vi.fn(),
  enrichLocation: vi.fn(),
  enrichPocSource: vi.fn(),
  enrichSector: vi.fn(),
  enrichSoftware: vi.fn(),
  inventoryEnrich: vi.fn(),
  inventoryEnrichStatus: vi.fn(),
  searchCve: vi.fn(),
  searchD3Fend: vi.fn(),
  searchKev: vi.fn(),
  searchKnowledgebase: vi.fn(),
  searchMisp: vi.fn(),
  searchPoc: vi.fn(),
  searchVendor: vi.fn(),
}));

vi.mock("../src/_generated/sdk.gen", () => ({
  ...sdk,
  enrichCve: (...args: unknown[]) => mockEnrichCve(...args),
  enrichIoc: (...args: unknown[]) => mockEnrichIoc(...args),
  enrichCwe: (...args: unknown[]) => mockEnrichCwe(...args),
  enrichTechnique: (...args: unknown[]) => mockEnrichTechnique(...args),
  enrichProduct: (...args: unknown[]) => mockEnrichProduct(...args),
  enrichPackage: (...args: unknown[]) => mockEnrichPackage(...args),
  searchCti: (...args: unknown[]) => mockSearchCti(...args),
}));

// Spy on the generated module singleton; instance configuration is read from client.api.
const setConfigSpy = vi.fn();
vi.mock("../src/_generated/client.gen", () => ({
  client: {
    setConfig: (cfg: unknown) => setConfigSpy(cfg),
  },
}));

// Replace the retry helper's sleep with a no-op spy so retry-loop tests never
// actually wait. We keep the real backoff math + Retry-After parsing so we can
// assert the delay the loop *would* have slept (via resolveDelay).
const sleepBackoffSpy = vi.fn(async () => {});
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
  ATLAS_FULL,
  CAMPAIGN_FULL,
  CAPEC_FULL,
  CVE_FAST,
  CVE_FULL_WALK,
  CVE_NARRATIVE,
  CWE_FULL_WALK,
  DEFEND_FULL,
  DISARM_FULL,
  GROUP_FULL,
  IOC_FAST,
  IOC_FULL_WALK,
  LOCATION_FULL,
  PACKAGE_FULL,
  PRODUCT_FULL,
  SECTOR_FULL,
  SOFTWARE_FULL,
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
      ATLAS_FULL,
      CAMPAIGN_FULL,
      CAPEC_FULL,
      DEFEND_FULL,
      DISARM_FULL,
      GROUP_FULL,
      LOCATION_FULL,
      SECTOR_FULL,
      SOFTWARE_FULL,
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

  // The key is no longer readable off the client config — it is stamped onto each
  // request instead (src/_auth.ts), because the config's `Headers` object is
  // reachable and util.inspect prints it in full. So these assert the wire.
  // Module-scoped (hoisted) so the instance-isolation test below reuses it.
  async function sentApiKeyVia(client: CrawlerClient): Promise<string | null> {
    const cfg = client.api.getConfig() as { fetch: typeof fetch };
    let sent: string | null = null;
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          sent = new Headers(
            init?.headers ??
              (input instanceof Request ? input.headers : undefined),
          ).get("apikey");
          return new Response(null, { status: 200 });
        },
      );
    try {
      // Must target the client's own origin: the key is deliberately withheld
      // from any other host (src/_auth.ts), so a fixed URL here would assert
      // the scoping rather than the key resolution these tests are about.
      await cfg.fetch(`${client.baseUrl}/v1/health`);
    } finally {
      spy.mockRestore();
    }
    return sent;
  }

  it("falls back to env var", async () => {
    process.env[ENV_API_KEY] = "from-env";
    const client = new CrawlerClient();
    expect(client.baseUrl).toBe(BASE_URL);
    expect(await sentApiKeyVia(client)).toBe("from-env");
    expect(setConfigSpy).not.toHaveBeenCalled();
  });

  it("constructor api key wins over env and configures the singleton when enabled", async () => {
    process.env[ENV_API_KEY] = "from-env";
    const client = new CrawlerClient({
      apiKey: "from-arg",
      configureGlobalClient: true,
    });
    expect(await sentApiKeyVia(client)).toBe("from-arg");
    // The singleton is configured, but deliberately without the credential —
    // it receives baseUrl plus the key-stamping fetch.
    expect(setConfigSpy).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: BASE_URL }),
    );
    expect(setConfigSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ headers: expect.anything() }),
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

  it.each([
    "http://localhost:8000",
    "http://127.0.0.1:8000",
    "http://127.255.255.254",
    "http://[::1]:8000",
  ])("accepts HTTP loopback origin %s", (baseUrl: string) => {
    expect(new CrawlerClient({ apiKey: "k", baseUrl }).baseUrl).toBe(baseUrl);
  });

  it("rejects HTTP for a non-loopback host", () => {
    expect(
      () =>
        new CrawlerClient({
          apiKey: "k",
          baseUrl: "http://api.example.com",
        }),
    ).toThrow(
      new RangeError("baseUrl must use HTTPS unless its host is loopback"),
    );
  });

  it("accepts HTTPS for a non-loopback host", () => {
    const baseUrl = "https://api.example.com";
    expect(new CrawlerClient({ apiKey: "k", baseUrl }).baseUrl).toBe(baseUrl);
  });

  it("rejects embedded URL credentials", () => {
    expect(
      () =>
        new CrawlerClient({
          apiKey: "k",
          baseUrl: "https://user:secret@api.example.com",
        }),
    ).toThrow(
      new RangeError(
        "baseUrl must be a valid HTTPS URL or an HTTP loopback URL",
      ),
    );
  });

  it.each([
    "https://api.example.com/v1",
    "https://api.example.com?debug=true",
    "https://api.example.com#section",
  ])("rejects non-origin base URL %s", (baseUrl: string) => {
    expect(() => new CrawlerClient({ apiKey: "k", baseUrl })).toThrow(
      new RangeError(
        "baseUrl must contain only an origin, without a path, query, or fragment",
      ),
    );
  });

  it.each([
    "",
    " https://api.example.com",
    "https://api.example.com ",
    "https://api.example.com/\n",
  ])("rejects empty or whitespace-bearing base URL %j", (baseUrl: string) => {
    expect(() => new CrawlerClient({ apiKey: "k", baseUrl })).toThrow(
      new RangeError(
        "baseUrl must be a valid HTTPS URL or an HTTP loopback URL",
      ),
    );
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
      new CrawlerClient({
        apiKey: "k",
        baseUrl: "https://x",
        verifySsl: false,
      });
      expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe("unchanged");
      expect(undiciAgentSpy).not.toHaveBeenCalled();
    } finally {
      if (prior === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prior;
    }
  });

  it("verifySsl=false fails closed outside Node", async () => {
    const client = new CrawlerClient({
      apiKey: "k",
      baseUrl: "https://x",
      verifySsl: false,
    });
    const clientConfig = client.api.getConfig() as { fetch: typeof fetch };
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
    ["false", false],
    ["0", false],
    ["no", false],
    ["FALSE", false],
    [" No ", false],
    ["true", true],
    ["1", true],
    ["yes", true],
    ["garbage", true],
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
    const client = new CrawlerClient({ apiKey: "k" });
    const cfg = client.api.getConfig() as { fetch?: typeof fetch };
    expect(typeof cfg.fetch).toBe("function");
  });

  it("custom fetch invokes native fetch with an abort signal", async () => {
    const client = new CrawlerClient({ apiKey: "k" });
    const cfg = client.api.getConfig() as { fetch: typeof fetch };

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
    const client = new CrawlerClient({ apiKey: "k" });
    const cfg = client.api.getConfig() as { fetch: typeof fetch };
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

  it("each instance owns a distinct client — later construction doesn't mutate an earlier instance", async () => {
    const a = new CrawlerClient({ apiKey: "key-a", baseUrl: "https://a.test" });
    const b = new CrawlerClient({ apiKey: "key-b", baseUrl: "https://b.test" });

    expect(a.api).not.toBe(b.api);
    // `a`'s client must still carry `a`'s own config after `b` was constructed —
    // this is the regression the shared-singleton-mutation bug would fail. The
    // key is asserted on the wire because it no longer sits on the config (see
    // the credential-disclosure block).
    expect(a.api.getConfig().baseUrl).toBe("https://a.test");
    expect(b.api.getConfig().baseUrl).toBe("https://b.test");
    expect(await sentApiKeyVia(a)).toBe("key-a");
    expect(await sentApiKeyVia(b)).toBe("key-b");
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
    await client.enrichProductFull("nginx", {
      version: "1.25",
      vendor: "nginx",
    });
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
    await client.enrichPackageFull("npm", "lodash", {
      version: "4.17.20",
      include: ["epss"],
    });
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
    mockSearchCti.mockResolvedValue(errData(503, "upstream down"));
    const client = new CrawlerClient();
    await expect(client.searchTechniques("phishing")).rejects.toBeInstanceOf(
      UnexpectedStatus,
    );
  });
});

// --------------------------------------------------------------------------- //
// Full-surface parity: the 27 methods that complete 33/33 operation coverage
// --------------------------------------------------------------------------- //
//
// One row per method. Each asserts the three things the wrapper alone is
// responsible for: which generated endpoint it routes to, the request it
// builds (camelCase option -> snake_case field), and — where the endpoint takes
// `include` — the full-walk preset it defaults to. The same table drives the
// non-2xx check, so a new method cannot be added without both.

const ENRICHMENT_ID = "0123456789abcdef0123456789abcdef";

type ParityCase = readonly [
  name: string,
  endpoint: Mock,
  invoke: (client: CrawlerClient) => Promise<unknown>,
  expected: Record<string, unknown>,
];

const PARITY_CASES: readonly ParityCase[] = [
  [
    "enrichAtlasFull",
    sdk.enrichAtlas,
    (c) => c.enrichAtlasFull("AML.T0043"),
    { body: { technique_id: "AML.T0043", include: [...ATLAS_FULL] } },
  ],
  [
    "enrichCampaignFull",
    sdk.enrichCampaign,
    (c) => c.enrichCampaignFull("C0011"),
    {
      body: {
        campaign_id: "C0011",
        framework: "enterprise",
        include: [...CAMPAIGN_FULL],
      },
    },
  ],
  [
    "enrichCapecFull",
    sdk.enrichCapec,
    (c) => c.enrichCapecFull("CAPEC-66"),
    { body: { capec_id: "CAPEC-66", include: [...CAPEC_FULL] } },
  ],
  [
    "enrichDefendFull",
    sdk.enrichDefend,
    (c) => c.enrichDefendFull("D3-NTA"),
    { body: { d3fend_id: "D3-NTA", include: [...DEFEND_FULL] } },
  ],
  [
    "enrichDisarmFull",
    sdk.enrichDisarm,
    (c) => c.enrichDisarmFull("T0086"),
    { body: { technique_id: "T0086", include: [...DISARM_FULL] } },
  ],
  [
    "enrichGroupFull",
    sdk.enrichGroup,
    (c) => c.enrichGroupFull("G0016"),
    {
      body: {
        group_id: "G0016",
        framework: "enterprise",
        include: [...GROUP_FULL],
      },
    },
  ],
  [
    "enrichLocationFull",
    sdk.enrichLocation,
    (c) => c.enrichLocationFull("UA"),
    { body: { location_id: "UA", include: [...LOCATION_FULL] } },
  ],
  [
    "enrichSectorFull",
    sdk.enrichSector,
    (c) => c.enrichSectorFull("energy"),
    { body: { sector_id: "energy", include: [...SECTOR_FULL] } },
  ],
  [
    "enrichSoftwareFull",
    sdk.enrichSoftware,
    (c) => c.enrichSoftwareFull("S0002"),
    {
      body: {
        software_id: "S0002",
        framework: "enterprise",
        include: [...SOFTWARE_FULL],
      },
    },
  ],
  [
    "enrichBatch",
    sdk.enrichBatch,
    (c) => c.enrichBatch([{ type: "cve", cve_id: "CVE-2000-0001" }]),
    { body: { items: [{ type: "cve", cve_id: "CVE-2000-0001" }] } },
  ],
  [
    "enrichPocSource",
    sdk.enrichPocSource,
    (c) => c.enrichPocSource("https://github.com/example/poc"),
    { body: { repo_url: "https://github.com/example/poc" } },
  ],
  [
    "assessGroupExposure",
    sdk.assessGroupExposure,
    (c) => c.assessGroupExposure({ groupIds: ["G0016"] }),
    { body: { group_ids: ["G0016"], framework: "enterprise" } },
  ],
  [
    "assessIocPortfolio",
    sdk.assessIocPortfolio,
    (c) => c.assessIocPortfolio([{ value: "8.8.8.8" }]),
    { body: { indicators: [{ value: "8.8.8.8" }] } },
  ],
  [
    "assessTechniqueCoverage",
    sdk.assessTechniqueCoverage,
    (c) => c.assessTechniqueCoverage(["T1190"]),
    { body: { technique_ids: ["T1190"], framework: "enterprise" } },
  ],
  [
    "assessVulnerabilityExposure",
    sdk.assessVulnerabilityExposure,
    (c) => c.assessVulnerabilityExposure(["CVE-2000-0001"]),
    { body: { cve_ids: ["CVE-2000-0001"] } },
  ],
  [
    "searchCti",
    mockSearchCti,
    (c) => c.searchCti("phishing"),
    { body: { query: "phishing", limit: 20, page: 1 } },
  ],
  [
    "searchCve",
    sdk.searchCve,
    (c) => c.searchCve(undefined, { cveId: "CVE-2000-0001" }),
    { body: { cve_id: "CVE-2000-0001", kev_only: false, limit: 50, page: 1 } },
  ],
  [
    "searchD3fend",
    sdk.searchD3Fend,
    (c) => c.searchD3fend("network traffic analysis"),
    { body: { query: "network traffic analysis", limit: 20, page: 1 } },
  ],
  [
    "searchKev",
    sdk.searchKev,
    (c) => c.searchKev({ cveId: "CVE-2000-0001" }),
    { body: { cve_id: "CVE-2000-0001", limit: 50, page: 1 } },
  ],
  [
    "searchKnowledgebase",
    sdk.searchKnowledgebase,
    (c) => c.searchKnowledgebase("lateral movement"),
    { body: { query: "lateral movement", alpha: 0.7, limit: 10 } },
  ],
  [
    "searchMisp",
    sdk.searchMisp,
    (c) => c.searchMisp({ value: "8.8.8.8" }),
    { body: { value: "8.8.8.8", limit: 50, page: 1 } },
  ],
  [
    "searchPoc",
    sdk.searchPoc,
    (c) => c.searchPoc("CVE-2000-0001"),
    { body: { cve_id: "CVE-2000-0001", limit: 25 } },
  ],
  [
    "searchVendor",
    sdk.searchVendor,
    (c) => c.searchVendor("microsoft"),
    { body: { vendor: "microsoft", limit: 50 } },
  ],
  [
    "artifactEnrich",
    sdk.artifactEnrich,
    (c) => c.artifactEnrich({ text: "incident notes" }),
    { body: { text: "incident notes" } },
  ],
  [
    "artifactEnrichStatus",
    sdk.artifactEnrichStatus,
    (c) => c.artifactEnrichStatus(ENRICHMENT_ID),
    { path: { enrichment_id: ENRICHMENT_ID } },
  ],
  [
    "inventoryEnrich",
    sdk.inventoryEnrich,
    (c) => c.inventoryEnrich([{ product: "nginx" }]),
    { body: { items: [{ product: "nginx" }] } },
  ],
  [
    "inventoryEnrichStatus",
    sdk.inventoryEnrichStatus,
    (c) => c.inventoryEnrichStatus(ENRICHMENT_ID),
    { path: { enrichment_id: ENRICHMENT_ID } },
  ],
];

// Every `*_full` method and the preset it must default to, for the override checks.
const PRESET_METHODS = [
  [
    "enrichAtlasFull",
    sdk.enrichAtlas,
    (c: CrawlerClient, i: string[]) =>
      c.enrichAtlasFull("AML.T0043", { include: i }),
  ],
  [
    "enrichCampaignFull",
    sdk.enrichCampaign,
    (c: CrawlerClient, i: string[]) =>
      c.enrichCampaignFull("C0011", { include: i }),
  ],
  [
    "enrichCapecFull",
    sdk.enrichCapec,
    (c: CrawlerClient, i: string[]) =>
      c.enrichCapecFull("CAPEC-66", { include: i }),
  ],
  [
    "enrichDefendFull",
    sdk.enrichDefend,
    (c: CrawlerClient, i: string[]) =>
      c.enrichDefendFull("D3-NTA", { include: i }),
  ],
  [
    "enrichDisarmFull",
    sdk.enrichDisarm,
    (c: CrawlerClient, i: string[]) =>
      c.enrichDisarmFull("T0086", { include: i }),
  ],
  [
    "enrichGroupFull",
    sdk.enrichGroup,
    (c: CrawlerClient, i: string[]) =>
      c.enrichGroupFull("G0016", { include: i }),
  ],
  [
    "enrichLocationFull",
    sdk.enrichLocation,
    (c: CrawlerClient, i: string[]) =>
      c.enrichLocationFull("UA", { include: i }),
  ],
  [
    "enrichSectorFull",
    sdk.enrichSector,
    (c: CrawlerClient, i: string[]) =>
      c.enrichSectorFull("energy", { include: i }),
  ],
  [
    "enrichSoftwareFull",
    sdk.enrichSoftware,
    (c: CrawlerClient, i: string[]) =>
      c.enrichSoftwareFull("S0002", { include: i }),
  ],
] as const;

describe("full-surface parity methods", () => {
  beforeEach(() => {
    process.env[ENV_API_KEY] = "test-key";
    mockSearchCti.mockReset();
    for (const endpoint of Object.values(sdk)) endpoint.mockReset();
  });

  afterEach(() => {
    delete process.env[ENV_API_KEY];
  });

  it.each(PARITY_CASES)(
    "%s routes to its endpoint with the expected request",
    async (_name, endpoint, invoke, expected) => {
      endpoint.mockResolvedValue(okData({ ok: true }));
      const client = new CrawlerClient();
      const result = await invoke(client);
      expect(result).toEqual({ ok: true });
      expect(endpoint).toHaveBeenCalledWith({
        client: client.api,
        ...expected,
      });
    },
  );

  it.each(PARITY_CASES)(
    "%s surfaces a non-2xx as UnexpectedStatus",
    async (_n, endpoint, invoke) => {
      endpoint.mockResolvedValue(errData(503, "upstream down"));
      const client = new CrawlerClient();
      await expect(invoke(client)).rejects.toMatchObject({
        name: "UnexpectedStatus",
        status: 503,
        body: "upstream down",
      });
    },
  );

  it.each(PRESET_METHODS)(
    "%s lets an explicit include replace the preset",
    async (_n, endpoint, invoke) => {
      endpoint.mockResolvedValue(okData({}));
      const client = new CrawlerClient();
      await invoke(client, ["details"]);
      expect(endpoint.mock.calls[0]?.[0].body.include).toEqual(["details"]);
    },
  );

  it("the search form omits the id instead of sending an empty one", async () => {
    sdk.enrichAtlas.mockResolvedValue(okData({}));
    const client = new CrawlerClient();
    await client.enrichAtlasFull(undefined, { search: "prompt injection" });
    const body = sdk.enrichAtlas.mock.calls[0]?.[0].body;
    expect(body).not.toHaveProperty("technique_id");
    expect(body.search).toBe("prompt injection");
    expect(body.include).toEqual([...ATLAS_FULL]);
  });

  it("framework defaults to enterprise and is overridable", async () => {
    sdk.enrichGroup.mockResolvedValue(okData({}));
    const client = new CrawlerClient();
    await client.enrichGroupFull("G0016", { framework: "ics" });
    expect(sdk.enrichGroup.mock.calls[0]?.[0].body.framework).toBe("ics");
  });

  it("searchCve maps every filter to its wire field", async () => {
    sdk.searchCve.mockResolvedValue(okData({}));
    const client = new CrawlerClient();
    await client.searchCve("buffer overflow", {
      cveId: "CVE-2000-0001",
      stixId: "vulnerability--0000",
      cweId: "CWE-79",
      capecId: "CAPEC-66",
      attackId: "T1190",
      cpe: "cpe:2.3:a:vendor:product",
      cpesNotVulnerable: "cpe:2.3:a:vendor:other",
      createdByRef: "identity--0000",
      createdMin: "2020-01-01",
      createdMax: "2020-12-31",
      modifiedMin: "2021-01-01",
      modifiedMax: "2021-12-31",
      cvssMin: 7,
      cvssV2Min: 5,
      cvssV4Min: 8,
      epssMin: 0.5,
      epssPercentileMin: 0.9,
      kevOnly: true,
      vulnStatus: "Analyzed",
      sort: "epss_score_descending",
      include: ["details"],
      limit: 10,
      page: 2,
    });
    expect(sdk.searchCve.mock.calls[0]?.[0].body).toEqual({
      query: "buffer overflow",
      cve_id: "CVE-2000-0001",
      stix_id: "vulnerability--0000",
      cwe_id: "CWE-79",
      capec_id: "CAPEC-66",
      attack_id: "T1190",
      cpe: "cpe:2.3:a:vendor:product",
      cpes_not_vulnerable: "cpe:2.3:a:vendor:other",
      created_by_ref: "identity--0000",
      created_min: "2020-01-01",
      created_max: "2020-12-31",
      modified_min: "2021-01-01",
      modified_max: "2021-12-31",
      cvss_min: 7,
      cvss_v2_min: 5,
      cvss_v4_min: 8,
      epss_min: 0.5,
      epss_percentile_min: 0.9,
      kev_only: true,
      vuln_status: "Analyzed",
      sort: "epss_score_descending",
      include: ["details"],
      limit: 10,
      page: 2,
    });
  });

  it("searchMisp maps every filter to its wire field", async () => {
    sdk.searchMisp.mockResolvedValue(okData({}));
    const client = new CrawlerClient();
    await client.searchMisp({
      value: "8.8.8.8",
      typeAttribute: "ip-dst",
      category: "Network activity",
      toIds: true,
      eventId: "42",
      eventinfo: "campaign",
      tags: ["tlp:white"],
      threatLevelId: "2",
      published: true,
      dateFrom: "2024-01-01",
      dateTo: "2024-02-01",
      limit: 5,
      page: 3,
    });
    expect(sdk.searchMisp.mock.calls[0]?.[0].body).toEqual({
      value: "8.8.8.8",
      type_attribute: "ip-dst",
      category: "Network activity",
      to_ids: true,
      event_id: "42",
      eventinfo: "campaign",
      tags: ["tlp:white"],
      threat_level_id: "2",
      published: true,
      date_from: "2024-01-01",
      date_to: "2024-02-01",
      limit: 5,
      page: 3,
    });
  });

  it("an omitted filter is absent, while paging defaults are materialized", async () => {
    // Paging/scalar defaults are sent explicitly so the two SDKs put the same
    // request on the wire (Python bakes the same values into its signature).
    // Filters are different: an unset filter must not narrow the result set.
    sdk.searchKev.mockResolvedValue(okData({}));
    const client = new CrawlerClient();
    await client.searchKev();
    const body = sdk.searchKev.mock.calls[0]?.[0].body;
    expect(body).toEqual({ limit: 50, page: 1 });
    expect(body).not.toHaveProperty("cve_id");
    expect(body).not.toHaveProperty("ransomware_status");
  });

  it("assess methods pass include through without a preset", async () => {
    sdk.assessTechniqueCoverage.mockResolvedValue(okData({}));
    const client = new CrawlerClient();
    await client.assessTechniqueCoverage(["T1190"]);
    expect(
      sdk.assessTechniqueCoverage.mock.calls[0]?.[0].body,
    ).not.toHaveProperty("include");

    await client.assessTechniqueCoverage(["T1190"], { include: ["tie"] });
    expect(sdk.assessTechniqueCoverage.mock.calls[1]?.[0].body.include).toEqual(
      ["tie"],
    );
  });
});

describe("full-walk preset contents", () => {
  // `summary` costs an LLM generation and `web_scrape` a live external fetch.
  // No full-walk preset opts into either — CVE_NARRATIVE is the one preset that
  // asks for `summary`, and it does so explicitly.
  it.each([
    ["ATLAS_FULL", ATLAS_FULL],
    ["CAMPAIGN_FULL", CAMPAIGN_FULL],
    ["CAPEC_FULL", CAPEC_FULL],
    ["CVE_FULL_WALK", CVE_FULL_WALK],
    ["CWE_FULL_WALK", CWE_FULL_WALK],
    ["DEFEND_FULL", DEFEND_FULL],
    ["DISARM_FULL", DISARM_FULL],
    ["GROUP_FULL", GROUP_FULL],
    ["IOC_FULL_WALK", IOC_FULL_WALK],
    ["LOCATION_FULL", LOCATION_FULL],
    ["PACKAGE_FULL", PACKAGE_FULL],
    ["PRODUCT_FULL", PRODUCT_FULL],
    ["SECTOR_FULL", SECTOR_FULL],
    ["SOFTWARE_FULL", SOFTWARE_FULL],
  ])("%s holds no duplicates and no LLM/scrape layer", (_name, preset) => {
    expect(new Set(preset).size).toBe(preset.length);
    expect(preset).not.toContain("summary");
    expect(preset).not.toContain("web_scrape");
  });

  it("CVE_NARRATIVE is the deliberate exception that opts into summary", () => {
    expect(CVE_NARRATIVE).toContain("summary");
  });
});

// --------------------------------------------------------------------------- //
// Retry loop (the custom fetch installed in setConfig)
// --------------------------------------------------------------------------- //
//
// The retry logic lives in the custom `fetch` supplied to the instance client.
// We read that fetch from `client.api.getConfig()` and drive it directly against
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
  const client = new CrawlerClient({
    apiKey: opts?.apiKey ?? "k",
    maxRetries: opts?.maxRetries,
  });
  const cfg = client.api.getConfig() as { fetch: typeof fetch };
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
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(resp(status));
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
      const request = new Request("https://x/v1", {
        signal: controller.signal,
      });
      controller.abort();
      const abortErr = new DOMException("aborted", "AbortError");
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(abortErr);
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
      const request = new Request("https://x/v1", {
        signal: controller.signal,
      });
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(resp(200));
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
      const request = new Request("https://x/v1", {
        signal: controller.signal,
      });
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
      const client = new CrawlerClient({
        apiKey: "k",
        baseUrl: "https://x",
        verifySsl: false,
      });
      const clientConfig = client.api.getConfig() as { fetch: typeof fetch };
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
      if (priorTlsState === undefined)
        delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = priorTlsState;
    }
  });
});

describe("credential disclosure", () => {
  // Mirrors the Python suite's TestCredentialDisclosure. The four Platform
  // namespaces hold the key in an ES2022 `#apiKey` field rather than a TypeScript
  // `private` one, because `private` is erased at compile time and leaves an
  // enumerable own property that JSON.stringify and util.inspect (so console.log)
  // print in cleartext. These fail if any namespace regresses to `private`.
  const PROBE_KEY = "probe-not-a-real-key";

  function freshClient(): CrawlerClient {
    return new CrawlerClient({
      apiKey: PROBE_KEY,
      baseUrl: "https://example.test",
    });
  }

  it("JSON.stringify of the client does not disclose the api key", () => {
    expect(JSON.stringify(freshClient()) ?? "").not.toContain(PROBE_KEY);
  });

  it("util.inspect of the client does not disclose the api key at full depth", () => {
    expect(inspect(freshClient(), { depth: null })).not.toContain(PROBE_KEY);
  });

  it("no Platform namespace discloses the api key when inspected directly", () => {
    const client = freshClient();
    for (const namespace of [
      client.artifactManager,
      client.inventoryManager,
      client.enricher,
      client.aiReports,
    ]) {
      expect(inspect(namespace, { depth: null })).not.toContain(PROBE_KEY);
      expect(JSON.stringify(namespace) ?? "").not.toContain(PROBE_KEY);
    }
  });

  // The generated client turns config `headers` into a WHATWG `Headers` it keeps
  // for its lifetime, reachable via client.api.getConfig(). `Headers` has no
  // redaction at all, so a config carrying `apikey` disclosed the key under
  // util.inspect. JSON.stringify hides it (a Headers serializes to `{}`), which
  // is why an earlier audit of this file came back clean. The key is now stamped
  // per request by _auth.withApiKeyHeader; these fail if it moves back onto the
  // client config.
  it("util.inspect of the client config does not disclose the api key", () => {
    const cfg = freshClient().api.getConfig();
    expect(inspect(cfg, { depth: null, showHidden: true })).not.toContain(
      PROBE_KEY,
    );
  });

  it("the client config carries no apikey header at all", () => {
    const headers = freshClient().api.getConfig().headers;
    const present =
      headers instanceof Headers
        ? headers.get("apikey")
        : ((headers as Record<string, string> | undefined)?.apikey ?? null);
    expect(present).toBeNull();
  });

  it("still sends the key on the outgoing request, so auth is not broken", async () => {
    const scopedFetch = captureFetch({ apiKey: PROBE_KEY });
    let sent: string | null = null;
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const merged = new Headers(
            init?.headers ??
              (input instanceof Request ? input.headers : undefined),
          );
          sent = merged.get("apikey");
          return new Response(null, { status: 200 });
        },
      );
    try {
      // captureFetch builds a client on the default BASE_URL, and the key is
      // attached only for that origin.
      await scopedFetch(`${BASE_URL}/v1/health`);
    } finally {
      spy.mockRestore();
    }
    expect(sent).toBe(PROBE_KEY);
  });

  // Choosing the header name `apikey` over `Authorization` forfeits two separate
  // runtime protections keyed on that name: redaction when printing, and
  // stripping on a cross-origin redirect. The first is closed by keeping the key
  // off the client entirely; this closes the reachable half of the second — the
  // documented `client.api` escape hatch exposes this very fetch, so a caller can
  // hand it an absolute URL for another host. Mirrors the Python suite's
  // ApiKeyAuth origin check.
  it("withholds the key from a request to any other origin", async () => {
    const scopedFetch = captureFetch({ apiKey: PROBE_KEY });
    const seen: Record<string, string | null> = {};
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(
            typeof input === "string"
              ? input
              : input instanceof Request
                ? input.url
                : String(input),
          );
          seen[url.origin] = new Headers(
            init?.headers ??
              (input instanceof Request ? input.headers : undefined),
          ).get("apikey");
          return new Response(null, { status: 200 });
        },
      );
    try {
      await scopedFetch(`${BASE_URL}/v1/health`);
      await scopedFetch("https://attacker.example/collect");
    } finally {
      spy.mockRestore();
    }
    expect(seen[new URL(BASE_URL).origin]).toBe(PROBE_KEY);
    expect(seen["https://attacker.example"]).toBeNull();
  });
});
