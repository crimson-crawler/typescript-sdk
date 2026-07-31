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
  it("creates a distinct generated client per instance", () => {
    createClientMock.mockClear();
    new CrawlerClient({ apiKey: "a", baseUrl: "https://a.test" });
    new CrawlerClient({ apiKey: "b", baseUrl: "https://b.test" });

    expect(createClientMock).toHaveBeenCalledTimes(2);
    const aCfg = createClientMock.mock.calls[0][0] as {
      baseUrl: string;
      headers: Record<string, string>;
    };
    const bCfg = createClientMock.mock.calls[1][0] as {
      baseUrl: string;
      headers: Record<string, string>;
    };
    expect(aCfg.baseUrl).toBe("https://a.test");
    expect(aCfg.headers.apikey).toBe("a");
    expect(bCfg.baseUrl).toBe("https://b.test");
    expect(bCfg.headers.apikey).toBe("b");
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
      headers: { apikey: "global-key" },
    });
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
