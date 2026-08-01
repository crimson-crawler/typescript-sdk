/**
 * Unit tests for the TypeScript SDK's scan→briefing ingest component.
 *
 * Mocks fetch — no network. Covers parseScan → enrichItems → assembleBriefing,
 * the empty-scan short-circuit, and KEV-first top-N assembly.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import { InventoryManagerApi } from "../src/inventory-manager";
import { assembleBriefing } from "../src/ingest";

const BASE = "https://api.test";

function jsonResp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function lastCall(mock: Mock): { url: URL; init: RequestInit } {
  const [input, init] = mock.mock.calls.at(-1)!;
  return { url: new URL(String(input)), init: init as RequestInit };
}

let mockFetch: Mock;
let inv: InventoryManagerApi;

beforeEach(() => {
  mockFetch = vi.fn();
  inv = new InventoryManagerApi(BASE, "test-key", mockFetch as never);
});

describe("assembleBriefing", () => {
  it("ranks KEV CVEs ahead of non-KEV and de-dupes by cve_id", () => {
    const report = {
      assets: [
        {
          product: "Apache httpd",
          top_cves: [
            { cve_id: "CVE-2021-45046", weaponization_score: 80, kev: false },
            { cve_id: "CVE-2021-44228", weaponization_score: 95, kev: true },
          ],
        },
        {
          product: "log4j-core",
          top_cves: [
            { cve_id: "CVE-2021-44228", weaponization_score: 99, kev: true },
          ],
        },
      ],
    };
    const briefing = assembleBriefing(report, {
      format: "csv",
      parsedCount: 2,
      truncated: false,
      enrichmentId: "e".repeat(32),
    });
    expect(briefing.format).toBe("csv");
    expect(briefing.parsed_count).toBe(2);
    const actions = briefing.recommended_actions as Array<
      Record<string, unknown>
    >;
    expect(actions[0].cve_id).toBe("CVE-2021-44228");
    expect(actions[0].weaponization_score).toBe(99);
  });

  it("returns empty actions when no assets have CVEs", () => {
    const briefing = assembleBriefing(
      {},
      {
        format: "nmap",
        parsedCount: 0,
        truncated: null,
        enrichmentId: null,
      },
    );
    expect((briefing.recommended_actions as unknown[]).length).toBe(0);
  });
});

describe("ingestScan", () => {
  it("runs parse → enrich → assemble and returns a briefing", async () => {
    const enrichmentId = "e".repeat(32);
    mockFetch
      .mockResolvedValueOnce(
        jsonResp(200, {
          format: "csv",
          items: [{ product: "nginx" }],
          count: 1,
        }),
      )
      .mockResolvedValueOnce(jsonResp(202, { enrichment_id: enrichmentId }))
      .mockResolvedValueOnce(
        jsonResp(200, {
          status: "done",
          result: {
            assets: [
              {
                product: "nginx",
                top_cves: [
                  {
                    cve_id: "CVE-2026-26929",
                    weaponization_score: 92,
                    kev: true,
                  },
                ],
              },
            ],
          },
        }),
      );

    const result = await inv.ingestScan("product\nnginx\n", "csv", {
      pollIntervalMs: 0,
    });

    expect(result.format).toBe("csv");
    expect(result.parsed_count).toBe(1);
    expect(result.enrichment_id).toBe(enrichmentId);
    const actions = result.recommended_actions as Array<
      Record<string, unknown>
    >;
    expect(actions[0].cve_id).toBe("CVE-2026-26929");

    const { url } = lastCall(mockFetch);
    expect(url.pathname).toBe(`/v1/inventory-enrich/${enrichmentId}`);
  });

  it("short-circuits when the parse returns no items", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResp(200, { format: "nmap", items: [], count: 0 }),
    );

    const result = await inv.ingestScan("<nmaprun/>", "nmap", {
      pollIntervalMs: 0,
    });

    expect(result.empty).toBe(true);
    expect(result.enrichment_id).toBeNull();
    // fetch called only once: the parse
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const { url } = lastCall(mockFetch);
    expect(url.pathname).toBe("/inventory-manager/inventories/parse");
  });
});
