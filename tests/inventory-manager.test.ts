/**
 * Unit tests for the hand-written Inventory Manager API client (client.inventoryManager).
 *
 * Mirrors the Python SDK's equivalent suite — mocks the fetch layer (no network),
 * asserts each method hits the right /inventory-manager/inventories path/method/body.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { UnexpectedStatus } from "../src/exceptions";
import { InventoryManagerApi } from "../src/inventory-manager";

const BASE = "https://api.test";

function jsonResp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let mockFetch: ReturnType<typeof vi.fn>;
let ws: InventoryManagerApi;

beforeEach(() => {
  mockFetch = vi.fn();
  ws = new InventoryManagerApi(BASE, "test-key", mockFetch as never);
});

function lastCall(): { url: URL; init: RequestInit } {
  const [input, init] = mockFetch.mock.calls.at(-1)!;
  return { url: new URL(String(input)), init: init as RequestInit };
}

describe("inventories", () => {
  it("lists inventories", async () => {
    mockFetch.mockResolvedValue(
      jsonResp(200, { inventories: [{ id: "p1", name: "Prod" }] }),
    );
    const out = await ws.listInventories();
    expect(out).toEqual([{ id: "p1", name: "Prod" }]);
    expect(lastCall().url.pathname).toBe("/inventory-manager/inventories");
  });

  it("gets an inventory manifest", async () => {
    mockFetch.mockResolvedValue(
      jsonResp(200, { id: "p1", inventory: [], attached: [], scans: [] }),
    );
    const out = await ws.getInventory("p1");
    expect(out.id).toBe("p1");
    expect(lastCall().url.pathname).toBe("/inventory-manager/inventories/p1");
  });

  it("gets the one-shot context bundle", async () => {
    mockFetch.mockResolvedValue(
      jsonResp(200, {
        id: "p1",
        context: "# Inventory: Prod",
        stats: { total_cves: 5 },
      }),
    );
    const out = await ws.getInventoryContext("p1");
    expect(out.context).toBe("# Inventory: Prod");
    expect(lastCall().url.pathname).toBe(
      "/inventory-manager/inventories/p1/context",
    );
  });

  it("lists an inventory's saved enrichment history", async () => {
    const rows = [
      {
        id: "e1",
        name: "Prod — 06-21",
        created_at: "2026-06-21T00:00:00Z",
        meta: { total_cves: 12 },
      },
      {
        id: "e2",
        name: "Prod — 06-20",
        created_at: "2026-06-20T00:00:00Z",
        meta: { total_cves: 9 },
      },
    ];
    mockFetch.mockResolvedValue(jsonResp(200, { enrichments: rows }));
    const out = await ws.listEnrichments("p1");
    expect(out).toEqual(rows);
    expect(lastCall().url.pathname).toBe(
      "/inventory-manager/inventories/p1/enrichments",
    );
  });

  it("returns an empty enrichment list", async () => {
    mockFetch.mockResolvedValue(jsonResp(200, { enrichments: [] }));
    expect(await ws.listEnrichments("p1")).toEqual([]);
  });

  it("compareEnrichments joins ids and unwraps the matrix", async () => {
    mockFetch.mockResolvedValue(
      jsonResp(200, { matrix: { counts: { new: 2 } } }),
    );
    const matrix = await ws.compareEnrichments(["a", "b"]);
    expect((matrix.counts as { new: number }).new).toBe(2);
    expect(lastCall().url.pathname).toBe(
      "/inventory-manager/inventories/compare",
    );
    expect(lastCall().url.searchParams.get("ids")).toBe("a,b");
  });

  it("throws UnexpectedStatus on a non-2xx", async () => {
    mockFetch.mockResolvedValue(jsonResp(404, { error: "not found" }));
    await expect(ws.getInventory("missing")).rejects.toBeInstanceOf(
      UnexpectedStatus,
    );
  });
});

describe("inventory write", () => {
  it("createInventory posts the full body", async () => {
    mockFetch.mockResolvedValue(jsonResp(201, { id: "p1", item_count: 2 }));
    const out = await ws.createInventory("Prod fleet", {
      description: "crown jewels",
      items: [
        { product: "nginx", vendor: "f5" },
        { product: "lodash", ecosystem: "npm" },
      ],
      monitoring: true,
    });
    expect(out).toEqual({ id: "p1", item_count: 2 });
    const { url, init } = lastCall();
    expect(url.pathname).toBe("/inventory-manager/inventories");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      inventory_name: "Prod fleet",
      description: "crown jewels",
      items: [
        { product: "nginx", vendor: "f5" },
        { product: "lodash", ecosystem: "npm" },
      ],
      monitoring: true,
    });
  });

  it("createInventory omits unset fields", async () => {
    mockFetch.mockResolvedValue(jsonResp(201, { id: "p2", item_count: 0 }));
    await ws.createInventory("Bare");
    expect(JSON.parse(String(lastCall().init.body))).toEqual({
      inventory_name: "Bare",
    });
  });

  it("updateInventory PATCHes with the inventory_name + changed fields", async () => {
    mockFetch.mockResolvedValue(jsonResp(200, { id: "p1", item_count: 1 }));
    const out = await ws.updateInventory("p1", {
      inventoryName: "Renamed",
      items: [{ product: "redis" }],
    });
    expect(out.item_count).toBe(1);
    const { url, init } = lastCall();
    expect(url.pathname).toBe("/inventory-manager/inventories/p1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({
      inventory_name: "Renamed",
      items: [{ product: "redis" }],
    });
  });

  it("deleteInventory returns the boolean", async () => {
    mockFetch.mockResolvedValue(jsonResp(200, { deleted: true }));
    expect(await ws.deleteInventory("p1")).toBe(true);
    const { url, init } = lastCall();
    expect(url.pathname).toBe("/inventory-manager/inventories/p1");
    expect(init.method).toBe("DELETE");
  });

  it("createInventory carries linkedArtifactIds", async () => {
    mockFetch.mockResolvedValue(jsonResp(201, { id: "p3", item_count: 1 }));
    await ws.createInventory("Ctx", {
      items: [{ product: "nginx" }],
      linkedArtifactIds: ["a1", "a2"],
    });
    expect(JSON.parse(String(lastCall().init.body))).toEqual({
      inventory_name: "Ctx",
      items: [{ product: "nginx" }],
      linked_artifact_ids: ["a1", "a2"],
    });
  });

  it("attachToInventory posts the artifactId", async () => {
    mockFetch.mockResolvedValue(
      jsonResp(200, { ok: true, linked: true, already: false }),
    );
    const out = await ws.attachToInventory("p1", "art-9");
    expect(out).toEqual({ ok: true, linked: true, already: false });
    const { url, init } = lastCall();
    expect(url.pathname).toBe("/inventory-manager/inventories/p1/attach");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ artifactId: "art-9" });
  });

  it("detachFromInventory posts to the atomic detach endpoint", async () => {
    mockFetch.mockResolvedValue(
      jsonResp(200, { ok: true, linked: 1, removed: true }),
    );
    const out = await ws.detachFromInventory("p1", "a1");
    expect(out).toEqual({ ok: true, linked: 1, removed: true });
    const { url, init } = lastCall();
    expect(url.pathname).toBe("/inventory-manager/inventories/p1/detach");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ artifactId: "a1" });
  });

  it("setMonitoring routes through the automation PUT (only the one field)", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResp(200, { id: "p1", automation: {} }),
    );
    await ws.setMonitoring("p1", true);
    expect(String(mockFetch.mock.calls[0][0])).toContain(
      "/inventory-manager/inventories/p1/automation",
    );
    expect((mockFetch.mock.calls[0][1] as RequestInit).method).toBe("PUT");
    const body = JSON.parse(
      (mockFetch.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body).toEqual({ monitoring: true });
  });

  it("setFavorite PATCHes only { favorite } (favorite-only — content untouched)", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResp(200, { id: "p1", favorite: true }),
    );
    const out = await ws.setFavorite("p1");
    expect(out.favorite).toBe(true);
    expect(String(mockFetch.mock.calls[0][0])).toContain(
      "/inventory-manager/inventories/p1",
    );
    expect((mockFetch.mock.calls[0][1] as RequestInit).method).toBe("PATCH");
    expect(
      JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string),
    ).toEqual({ favorite: true });

    mockFetch.mockResolvedValueOnce(
      jsonResp(200, { id: "p1", favorite: false }),
    );
    await ws.setFavorite("p1", false);
    expect(
      JSON.parse((mockFetch.mock.calls[1][1] as RequestInit).body as string),
    ).toEqual({ favorite: false });
  });

  it("getAutomation GETs the automation endpoint", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResp(200, {
        id: "p1",
        automation: { monitoring: true, daily_report: false },
      }),
    );
    const out = await ws.getAutomation("p1");
    expect((out.automation as Record<string, unknown>).monitoring).toBe(true);
    expect(String(mockFetch.mock.calls[0][0])).toContain(
      "/inventory-manager/inventories/p1/automation",
    );
    expect((mockFetch.mock.calls[0][1] as RequestInit).method).toBe("GET");
  });

  it("setAutomation PUTs only the provided fields", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResp(200, { id: "p1", automation: { daily_report: true } }),
    );
    await ws.setAutomation("p1", {
      dailyReport: true,
      dailyReportTemplate: "project_brief",
    });
    expect((mockFetch.mock.calls[0][1] as RequestInit).method).toBe("PUT");
    const body = JSON.parse(
      (mockFetch.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body).toEqual({
      daily_report: true,
      daily_report_template: "project_brief",
    });
  });
});

describe("scan ingest", () => {
  it("parseScan posts the file to the parse endpoint", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResp(200, {
        format: "nmap",
        items: [{ product: "nginx" }],
        count: 1,
      }),
    );
    const out = await ws.parseScan("<nmaprun/>", "nmap");
    expect(out.count).toBe(1);
    expect(String(mockFetch.mock.calls[0][0])).toContain(
      "/inventory-manager/inventories/parse",
    );
    expect(
      JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string),
    ).toEqual({ format: "nmap", content: "<nmaprun/>" });
  });

  it("ingestScan parses, enriches, and assembles a KEV-first briefing", async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResp(200, {
          format: "nmap",
          items: [{ product: "nginx" }],
          count: 1,
        }),
      )
      .mockResolvedValueOnce(jsonResp(202, { enrichment_id: "f".repeat(32) }))
      .mockResolvedValueOnce(
        jsonResp(200, {
          status: "done",
          result: {
            summary: { asset_count: 1, total_cves: 2, total_kev: 1 },
            assets: [
              {
                product: "nginx",
                top_cves: [
                  { cve_id: "CVE-2024-2", weaponization_score: 50, kev: false },
                  { cve_id: "CVE-2024-1", weaponization_score: 90, kev: true },
                ],
              },
            ],
          },
        }),
      );
    const out = await ws.ingestScan("<nmaprun/>", "nmap", {
      pollIntervalMs: 0,
    });
    expect(out.format).toBe("nmap");
    expect(out.parsed_count).toBe(1);
    expect(
      (out.recommended_actions as Array<Record<string, unknown>>)[0].cve_id,
    ).toBe("CVE-2024-1");
  });

  it("ingestScan short-circuits on an empty parse", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResp(200, { format: "csv", items: [], count: 0 }),
    );
    const out = await ws.ingestScan("", "csv", { pollIntervalMs: 0 });
    expect(out.empty).toBe(true);
    expect(out.enrichment_id).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("parseScan base64-encodes a Uint8Array for the binary xlsx format", async () => {
    // The one BINARY format: bytes in → base64 on the wire (the server decodes it for format='xlsx').
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]); // "PK\x03\x04" + payload
    mockFetch.mockResolvedValueOnce(
      jsonResp(200, {
        format: "xlsx",
        items: [{ product: "nginx" }],
        count: 1,
      }),
    );
    await ws.parseScan(bytes, "xlsx");
    const body = JSON.parse(
      (mockFetch.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body.format).toBe("xlsx");
    expect(body.content).toBe(Buffer.from(bytes).toString("base64"));
  });
});

describe("enrichInventory", () => {
  const ID = "e".repeat(32);

  it("reads the inventory, submits the assets to /v1, polls, then returns the report", async () => {
    const items = [{ product: "nginx", vendor: "f5" }];
    mockFetch
      .mockResolvedValueOnce(
        jsonResp(200, { id: "p1", inventory_name: "Prod", inventory: items }),
      )
      .mockResolvedValueOnce(jsonResp(202, { enrichment_id: ID }))
      .mockResolvedValueOnce(jsonResp(200, { status: "running" }))
      .mockResolvedValueOnce(
        jsonResp(200, {
          status: "done",
          result: { summary: { total_cves: 3 } },
        }),
      );

    const out = await ws.enrichInventory("p1", { pollIntervalMs: 0 });
    expect(out).toEqual({
      enrichment_id: ID,
      report: { summary: { total_cves: 3 } },
    });

    // 1) read the inventory manifest
    expect(new URL(String(mockFetch.mock.calls[0][0])).pathname).toBe(
      "/inventory-manager/inventories/p1",
    );
    // 2) submit the assets to the /v1 inventory engine
    const submit = mockFetch.mock.calls[1];
    expect(new URL(String(submit[0])).pathname).toBe("/v1/inventory-enrich");
    expect(JSON.parse((submit[1] as RequestInit).body as string)).toEqual({
      items,
    });
    // 3) poll the /v1 status endpoint
    expect(new URL(String(mockFetch.mock.calls[2][0])).pathname).toBe(
      `/v1/inventory-enrich/${ID}`,
    );
    expect(mockFetch).toHaveBeenCalledTimes(4); // no save POST
  });

  it("rides include into the submit", async () => {
    const items = [{ product: "nginx" }];
    mockFetch
      .mockResolvedValueOnce(jsonResp(200, { id: "p1", inventory: items }))
      .mockResolvedValueOnce(jsonResp(202, { enrichment_id: ID }))
      .mockResolvedValueOnce(jsonResp(200, { status: "done", result: {} }));
    await ws.enrichInventory("p1", {
      include: ["exploits"],
      pollIntervalMs: 0,
    });
    expect(
      JSON.parse((mockFetch.mock.calls[1][1] as RequestInit).body as string),
    ).toEqual({
      items,
      include: ["exploits"],
    });
  });

  it("short-circuits on an empty inventory (enrichment_id: null)", async () => {
    mockFetch.mockResolvedValueOnce(jsonResp(200, { id: "p1", inventory: [] }));
    const out = await ws.enrichInventory("p1", { pollIntervalMs: 0 });
    expect(out).toEqual({ enrichment_id: null, empty: true });
    expect(mockFetch).toHaveBeenCalledTimes(1); // only the manifest GET
  });

  it("throws on an engine-side enrichment error", async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResp(200, { id: "p1", inventory: [{ product: "nginx" }] }),
      )
      .mockResolvedValueOnce(jsonResp(202, { enrichment_id: ID }))
      .mockResolvedValueOnce(jsonResp(200, { status: "error", error: "boom" }));
    await expect(
      ws.enrichInventory("p1", { pollIntervalMs: 0 }),
    ).rejects.toBeInstanceOf(UnexpectedStatus);
  });

  it("throws when the enrichment does not finish within the timeout", async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResp(200, { id: "p1", inventory: [{ product: "nginx" }] }),
      )
      .mockResolvedValueOnce(jsonResp(202, { enrichment_id: ID }))
      .mockResolvedValue(jsonResp(200, { status: "running" }));
    await expect(
      ws.enrichInventory("p1", { pollIntervalMs: 0, timeoutMs: -1 }),
    ).rejects.toThrow(/did not finish/);
  });
});

describe("attachment resolution", () => {
  it("falls back to the artifact id when X-Artifact-Name is malformed", async () => {
    mockFetch.mockResolvedValue(
      new Response("notes", {
        status: 200,
        headers: {
          "X-Artifact-Name": "bad%ZZname",
          "X-Artifact-Format": "paste",
        },
      }),
    );
    const out = await ws.resolveAttachments(["a1"]);
    expect(out.text).toContain("--- Attached: a1 ---");
  });
});

describe("import/export", () => {
  it("imports an inventory (minimal)", async () => {
    mockFetch.mockResolvedValue(
      jsonResp(201, { id: "p9", item_count: 2, imported: 2, format: "csv" }),
    );
    const out = await ws.importInventory({
      format: "csv",
      content: "product\nnginx\nopenssl\n",
    });
    expect(out).toEqual({
      id: "p9",
      item_count: 2,
      imported: 2,
      format: "csv",
    });
    const { url, init } = lastCall();
    expect(url.pathname).toBe("/inventory-manager/inventories/import");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      format: "csv",
      content: "product\nnginx\nopenssl\n",
    });
  });

  it("imports a binary xlsx as base64", async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 9, 8, 7]);
    mockFetch.mockResolvedValue(
      jsonResp(201, { id: "p9", item_count: 1, imported: 1, format: "xlsx" }),
    );
    await ws.importInventory({ format: "xlsx", content: bytes });
    const body = JSON.parse(String(lastCall().init.body));
    expect(body.format).toBe("xlsx");
    expect(body.content).toBe(Buffer.from(bytes).toString("base64"));
  });

  it("imports with name + description overrides", async () => {
    mockFetch.mockResolvedValue(jsonResp(201, { id: "p9", item_count: 1 }));
    await ws.importInventory({
      format: "nmap",
      content: "<nmaprun/>",
      inventoryName: "DMZ",
      description: "edge",
    });
    expect(JSON.parse(String(lastCall().init.body))).toEqual({
      format: "nmap",
      content: "<nmaprun/>",
      inventory_name: "DMZ",
      description: "edge",
    });
  });

  it("parseMulti combines several sources (and base64s an xlsx source)", async () => {
    mockFetch.mockResolvedValue(
      jsonResp(200, {
        items: [{ product: "nginx" }],
        count: 1,
        asset_groups: [],
        per_source: [],
      }),
    );
    const bytes = new Uint8Array([0x50, 0x4b, 1]);
    const out = await ws.parseMulti([
      { format: "csv", content: "product\nnginx\n" },
      { format: "xlsx", content: bytes },
    ]);
    expect((out as { count: number }).count).toBe(1);
    const { url, init } = lastCall();
    expect(url.pathname).toBe("/inventory-manager/inventories/parse-multi");
    const body = JSON.parse(String(init.body));
    expect(body.sources[0]).toEqual({
      format: "csv",
      content: "product\nnginx\n",
    });
    expect(body.sources[1].content).toBe(Buffer.from(bytes).toString("base64"));
  });

  it("importMulti creates from the combined sources", async () => {
    mockFetch.mockResolvedValue(
      jsonResp(201, {
        id: "p",
        item_count: 2,
        format: "multi",
        multi: true,
        per_source: [],
      }),
    );
    await ws.importMulti({
      sources: [
        { format: "csv", content: "product\nnginx\n" },
        { format: "nmap", content: "<nmaprun/>" },
      ],
      inventoryName: "Combined",
    });
    const { url, init } = lastCall();
    expect(url.pathname).toBe("/inventory-manager/inventories/import");
    expect(JSON.parse(String(init.body))).toEqual({
      sources: [
        { format: "csv", content: "product\nnginx\n" },
        { format: "nmap", content: "<nmaprun/>" },
      ],
      inventory_name: "Combined",
    });
  });

  it("importMulti into an existing inventory (append)", async () => {
    mockFetch.mockResolvedValue(
      jsonResp(200, { id: "p1", replaced: true, mode: "append" }),
    );
    await ws.importMulti({
      sources: [{ format: "csv", content: "product\nx\n" }],
      inventoryId: "p1",
      mode: "append",
    });
    const body = JSON.parse(String(lastCall().init.body));
    expect(body.inventory_id).toBe("p1");
    expect(body.mode).toBe("append");
  });

  it("lists export formats", async () => {
    mockFetch.mockResolvedValue(
      jsonResp(200, { formats: [{ key: "json" }, { key: "csv" }] }),
    );
    const out = await ws.listExportFormats("p1");
    expect(out).toEqual([{ key: "json" }, { key: "csv" }]);
    expect(lastCall().url.pathname).toBe(
      "/inventory-manager/inventories/p1/export",
    );
  });

  it("exports an inventory as raw text", async () => {
    mockFetch.mockResolvedValue(
      new Response("inventory_name,product\nProd,nginx\n", { status: 200 }),
    );
    const out = await ws.exportInventory("p1", "csv");
    expect(out).toBe("inventory_name,product\nProd,nginx\n");
    expect(lastCall().url.pathname).toBe(
      "/inventory-manager/inventories/p1/export/csv",
    );
  });

  it("export defaults to json", async () => {
    mockFetch.mockResolvedValue(new Response("{}", { status: 200 }));
    await ws.exportInventory("p1");
    expect(lastCall().url.pathname).toBe(
      "/inventory-manager/inventories/p1/export/json",
    );
  });

  it("resolves the binary workbook as a Uint8Array (text formats stay strings)", async () => {
    mockFetch.mockResolvedValue(
      new Response(new Uint8Array([0x50, 0x4b, 1, 2]), { status: 200 }),
    );
    const out = await ws.exportInventory("p1", "workbook");
    expect(out).toBeInstanceOf(Uint8Array);
    expect(Array.from(out as Uint8Array).slice(0, 2)).toEqual([0x50, 0x4b]);
    expect(lastCall().url.pathname).toBe(
      "/inventory-manager/inventories/p1/export/workbook",
    );
  });
});

describe("asset edit", () => {
  it("replaces assets (preserving everything else)", async () => {
    mockFetch.mockResolvedValue(
      jsonResp(200, { id: "p1", item_count: 1, mode: "replace" }),
    );
    const out = await ws.replaceAssets("p1", [{ product: "nginx" }]);
    expect(out).toEqual({ id: "p1", item_count: 1, mode: "replace" });
    const { url, init } = lastCall();
    expect(url.pathname).toBe("/inventory-manager/inventories/p1/assets");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({
      items: [{ product: "nginx" }],
      mode: "replace",
    });
  });

  it("appends assets", async () => {
    mockFetch.mockResolvedValue(
      jsonResp(200, { id: "p1", item_count: 3, mode: "append" }),
    );
    await ws.addAssets("p1", [{ product: "redis" }]);
    expect(JSON.parse(String(lastCall().init.body))).toEqual({
      items: [{ product: "redis" }],
      mode: "append",
    });
  });

  it("applies a recommended upgrade (PATCH asset-version)", async () => {
    mockFetch.mockResolvedValue(
      jsonResp(200, {
        id: "p1",
        product: "nginx",
        version: "1.27.4",
        item_count: 2,
      }),
    );
    const out = await ws.applyAssetFix("p1", "nginx", "1.27.4");
    expect(out).toEqual({
      id: "p1",
      product: "nginx",
      version: "1.27.4",
      item_count: 2,
    });
    const { url, init } = lastCall();
    expect(url.pathname).toBe(
      "/inventory-manager/inventories/p1/asset-version",
    );
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({
      product: "nginx",
      version: "1.27.4",
    });
  });

  it("applies a fix with a vendor hint", async () => {
    mockFetch.mockResolvedValue(
      jsonResp(200, {
        id: "p1",
        product: "nginx",
        version: "1.27.4",
        item_count: 2,
      }),
    );
    await ws.applyAssetFix("p1", "nginx", "1.27.4", "f5");
    expect(JSON.parse(String(lastCall().init.body))).toEqual({
      product: "nginx",
      version: "1.27.4",
      vendor: "f5",
    });
  });

  it("imports into an existing inventory (replace by default)", async () => {
    mockFetch.mockResolvedValue(
      jsonResp(200, { id: "p1", replaced: true, mode: "replace" }),
    );
    const out = await ws.importInventory({
      format: "csv",
      content: "product\nnginx\n",
      inventoryId: "p1",
    });
    expect(out.replaced).toBe(true);
    expect(JSON.parse(String(lastCall().init.body))).toEqual({
      format: "csv",
      content: "product\nnginx\n",
      inventory_id: "p1",
      mode: "replace",
    });
  });

  it("imports into an existing inventory with append", async () => {
    mockFetch.mockResolvedValue(
      jsonResp(200, { id: "p1", replaced: true, mode: "append" }),
    );
    await ws.importInventory({
      format: "nmap",
      content: "<nmaprun/>",
      inventoryId: "p1",
      mode: "append",
    });
    expect(JSON.parse(String(lastCall().init.body))).toMatchObject({
      inventory_id: "p1",
      mode: "append",
    });
  });
});

describe("bulk attachments", () => {
  it("sets attachments (replace)", async () => {
    mockFetch.mockResolvedValue(
      jsonResp(200, {
        id: "p1",
        linked_count: 2,
        attached: 2,
        skipped: 0,
        mode: "replace",
      }),
    );
    const out = await ws.setAttachments("p1", ["a1", "a2"]);
    expect(out.attached).toBe(2);
    const { url, init } = lastCall();
    expect(url.pathname).toBe("/inventory-manager/inventories/p1/attachments");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({
      artifact_ids: ["a1", "a2"],
      mode: "replace",
    });
  });

  it("adds attachments (append)", async () => {
    mockFetch.mockResolvedValue(
      jsonResp(200, {
        id: "p1",
        linked_count: 3,
        attached: 1,
        skipped: 0,
        mode: "append",
      }),
    );
    await ws.addAttachments("p1", ["a3"]);
    expect(JSON.parse(String(lastCall().init.body))).toEqual({
      artifact_ids: ["a3"],
      mode: "append",
    });
  });
});

// Every advertised import + export FORMAT must flow through the thin SDK without the client rejecting it.
const IMPORT_FORMATS = [
  "json",
  "sbom",
  "csv",
  "nmap",
  "list",
  "grype",
  "trivy",
  "depcheck",
  "nessus",
  "gvm",
];
const EXPORT_FORMATS = [
  "json",
  "csv",
  "list",
  "cyclonedx",
  "spdx",
  "spdx2",
  "workbook",
];

describe("format parity", () => {
  it.each(IMPORT_FORMATS)("importInventory accepts format %s", async (fmt) => {
    mockFetch.mockResolvedValue(
      jsonResp(201, { id: "p", item_count: 1, imported: 1, format: fmt }),
    );
    const out = await ws.importInventory({ format: fmt, content: "x" });
    expect(out.format).toBe(fmt);
    expect(lastCall().url.pathname).toBe(
      "/inventory-manager/inventories/import",
    );
    expect(JSON.parse(String(lastCall().init.body))).toEqual({
      format: fmt,
      content: "x",
    });
  });

  it.each(IMPORT_FORMATS)("parseScan accepts format %s", async (fmt) => {
    mockFetch.mockResolvedValue(
      jsonResp(200, { format: fmt, items: [], count: 0 }),
    );
    await ws.parseScan("x", fmt);
    expect(lastCall().url.pathname).toBe(
      "/inventory-manager/inventories/parse",
    );
    expect(JSON.parse(String(lastCall().init.body))).toEqual({
      format: fmt,
      content: "x",
    });
  });

  it.each(EXPORT_FORMATS)(
    "exportInventory hits the %s export path",
    async (fmt) => {
      mockFetch.mockResolvedValue(new Response("data", { status: 200 }));
      await ws.exportInventory("p1", fmt);
      expect(lastCall().url.pathname).toBe(
        `/inventory-manager/inventories/p1/export/${fmt}`,
      );
    },
  );
});

describe("saveEnrichment + enrichInventory({ save })", () => {
  const ID = "c".repeat(32);

  it("saveEnrichment POSTs to the inventory's enrichments path", async () => {
    mockFetch.mockResolvedValueOnce(jsonResp(201, { artifact_id: "inv-7" }));
    const out = await ws.saveEnrichment("p1", ID);
    expect(out).toEqual({ artifact_id: "inv-7" });
    const [input, init] = mockFetch.mock.calls.at(-1)!;
    expect(new URL(String(input)).pathname).toBe(
      "/inventory-manager/inventories/p1/enrichments",
    );
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      enrichment_id: ID,
    });
  });

  it("enrichInventory({ save:true }) files the result after completion", async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResp(200, {
          inventory: [{ product: "nginx", versions: ["1.25"] }],
        }),
      )
      .mockResolvedValueOnce(jsonResp(202, { enrichment_id: ID }))
      .mockResolvedValueOnce(
        jsonResp(200, { status: "done", result: { rollup: {} } }),
      )
      .mockResolvedValueOnce(jsonResp(201, { artifact_id: "inv-7" }));
    const out = await ws.enrichInventory("p1", {
      pollIntervalMs: 0,
      save: true,
    });
    expect(out.enrichment_id).toBe(ID);
    expect(out.saved).toEqual({ artifact_id: "inv-7" });
    expect(new URL(String(mockFetch.mock.calls.at(-1)![0])).pathname).toBe(
      "/inventory-manager/inventories/p1/enrichments",
    );
  });

  it("an empty inventory skips submit and save", async () => {
    mockFetch.mockResolvedValueOnce(jsonResp(200, { inventory: [] }));
    const out = await ws.enrichInventory("p1", {
      pollIntervalMs: 0,
      save: true,
    });
    expect(out).toEqual({ enrichment_id: null, empty: true });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe("enrichInventory artifact-scans (attachments)", () => {
  const ID = "d".repeat(32);

  it("resolves attachments when the inventory toggle is on", async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResp(200, {
          inventory: [{ product: "nginx" }],
          enrich_attachments: true,
          attached: [{ id: "att-1" }],
        }),
      )
      .mockResolvedValueOnce(
        new Response("CVE-2024-9999 at 1.2.3.4", { status: 200 }),
      ) // get_artifact raw
      .mockResolvedValueOnce(jsonResp(202, { enrichment_id: ID }))
      .mockResolvedValueOnce(
        jsonResp(200, { status: "done", result: { rollup: {} } }),
      );
    const out = await ws.enrichInventory("p1", { pollIntervalMs: 0 });
    expect(out.enrichment_id).toBe(ID);
    expect(new URL(String(mockFetch.mock.calls[1][0])).pathname).toBe(
      "/artifact-manager/artifacts/att-1",
    );
    const submitBody = JSON.parse(
      (mockFetch.mock.calls[2][1] as RequestInit).body as string,
    );
    expect(submitBody.attachments_text).toContain("CVE-2024-9999");
  });

  it("forwards a binary attachment as a file (X-Artifact-Format: file)", async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResp(200, {
          inventory: [{ product: "nginx" }],
          enrich_attachments: true,
          attached: [{ id: "att-x" }],
        }),
      )
      .mockResolvedValueOnce(
        new Response("UEsDBASE64XLSX", {
          status: 200,
          headers: {
            "X-Artifact-Format": "file",
            "X-Artifact-Name": "scan.xlsx",
          },
        }),
      )
      .mockResolvedValueOnce(jsonResp(202, { enrichment_id: ID }))
      .mockResolvedValueOnce(jsonResp(200, { status: "done", result: {} }));
    const out = await ws.enrichInventory("p1", { pollIntervalMs: 0 });
    expect(out.enrichment_id).toBe(ID);
    const submitBody = JSON.parse(
      (mockFetch.mock.calls[2][1] as RequestInit).body as string,
    );
    expect(submitBody.attachments_text).toBeUndefined();
    expect(submitBody.attachments_files).toEqual([
      { filename: "scan.xlsx", content_b64: "UEsDBASE64XLSX" },
    ]);
  });

  it("toggle off skips the attachment fetch", async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResp(200, {
          inventory: [{ product: "nginx" }],
          enrich_attachments: false,
          attached: [{ id: "att-1" }],
        }),
      )
      .mockResolvedValueOnce(jsonResp(202, { enrichment_id: ID }))
      .mockResolvedValueOnce(jsonResp(200, { status: "done", result: {} }));
    await ws.enrichInventory("p1", { pollIntervalMs: 0 });
    expect(mockFetch).toHaveBeenCalledTimes(3); // no get_artifact
  });
});
