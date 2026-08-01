/**
 * Constructor-scoped client tests — S13.
 *
 * Mirrors the multi-tenant + AbortSignal.any coverage from wrapper.test.ts, but
 * focuses on the `createClient` instance scoping that keeps each `CrawlerClient`
 * independent.
 */

import { describe, expect, it, vi } from "vitest";

const { createClientMock, setConfigMock } = vi.hoisted(() => ({
  setConfigMock: vi.fn(),
  createClientMock: vi.fn(() => ({ setConfig: setConfigMock })),
}));

vi.mock("../src/_generated/client", () => ({
  createConfig: (..._args: unknown[]) => ({}),
  createClient: (..._args: unknown[]) => createClientMock(..._args),
  client: { setConfig: (..._args: unknown[]) => setConfigMock(..._args) },
}));

vi.mock("../src/retry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/retry")>();
  return {
    ...actual,
    sleepBackoff: vi.fn(async () => {}),
  };
});

import { CrawlerClient } from "../src/index";

describe("CrawlerClient instance scoping (createClient)", () => {
  // The credential is deliberately absent from the config handed to
  // createClient — it is stamped per request by the instance's own fetch
  // (src/_auth.ts), because a config-level `Headers` object is reachable and
  // util.inspect prints it in full. Instance scoping is therefore asserted
  // through each instance's fetch rather than its config headers.
  // Each instance's key is attached only for its own origin, so the probe URL
  // has to come from the config under test rather than being a fixed literal.
  async function keyStampedBy(cfg: {
    baseUrl: string;
    fetch: typeof fetch;
  }): Promise<string | null> {
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
      await cfg.fetch(`${cfg.baseUrl}/v1/health`);
    } finally {
      spy.mockRestore();
    }
    return sent;
  }

  it("creates a distinct generated client per instance", async () => {
    createClientMock.mockClear();
    new CrawlerClient({ apiKey: "a", baseUrl: "https://a.test" });
    new CrawlerClient({ apiKey: "b", baseUrl: "https://b.test" });

    expect(createClientMock).toHaveBeenCalledTimes(2);
    const aCfg = createClientMock.mock.calls[0][0] as {
      baseUrl: string;
      fetch: typeof fetch;
    };
    const bCfg = createClientMock.mock.calls[1][0] as {
      baseUrl: string;
      fetch: typeof fetch;
    };
    expect(aCfg.baseUrl).toBe("https://a.test");
    expect(bCfg.baseUrl).toBe("https://b.test");
    // Each instance's fetch carries its own key, and neither config carries one.
    expect(await keyStampedBy(aCfg)).toBe("a");
    expect(await keyStampedBy(bCfg)).toBe("b");
    expect(aCfg).not.toHaveProperty("headers");
    expect(bCfg).not.toHaveProperty("headers");
  });

  it("only mutates the generated singleton when explicitly opted in", () => {
    setConfigMock.mockClear();
    new CrawlerClient({
      apiKey: "global-key",
      baseUrl: "https://global.test",
      configureGlobalClient: true,
    });
    new CrawlerClient({ apiKey: "tenant-key", baseUrl: "https://tenant.test" });

    expect(setConfigMock).toHaveBeenCalledTimes(1);
    expect(setConfigMock.mock.calls[0][0]).toMatchObject({
      baseUrl: "https://global.test",
    });
    // The singleton must not receive the credential either.
    expect(setConfigMock.mock.calls[0][0]).not.toHaveProperty("headers");
  });

  it("the per-instance fetch forwards a caller AbortSignal via AbortSignal.any", async () => {
    createClientMock.mockClear();
    new CrawlerClient({ apiKey: "k", baseUrl: "https://x.test" });
    const cfg = createClientMock.mock.calls[0][0] as { fetch: typeof fetch };

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));
    try {
      const controller = new AbortController();
      await cfg.fetch(
        new Request("https://x.test/v1", { signal: controller.signal }),
      );
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      expect(init.signal).toBeDefined();
      expect(init.signal).not.toBe(controller.signal); // combined via AbortSignal.any
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("an init.signal passed the 2-arg way is forwarded unchanged", async () => {
    createClientMock.mockClear();
    new CrawlerClient({ apiKey: "k", baseUrl: "https://x.test" });
    const cfg = createClientMock.mock.calls[0][0] as { fetch: typeof fetch };

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));
    try {
      const controller = new AbortController();
      await cfg.fetch("https://x.test/v1", { signal: controller.signal });
      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      expect(init.signal).toBe(controller.signal);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
