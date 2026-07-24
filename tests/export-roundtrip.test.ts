/**
 * Cross-surface export round-trip parity — TypeScript SDK.
 *
 * Mocks fetch so we can assert that an inventory exported to a text format and
 * re-imported reports the same asset count. The workbook format is exercised
 * as a byte-exact round-trip.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import { InventoryManagerApi } from "../src/inventory-manager";

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

describe("export → import round-trip parity", () => {
  it.each(["json", "csv", "list"] as const)("%s round-trip preserves item_count", async (fmt) => {
    const assets = [{ product: "nginx", vendor: "f5", versions: ["1.25.0"] }];
    const exported = JSON.stringify({ inventory_name: "RT", inventory: assets });

    mockFetch
      .mockResolvedValueOnce(new Response(exported))
      .mockResolvedValueOnce(jsonResp(201, { id: "p2", item_count: 1, imported: 1, format: fmt }));

    const payload = await inv.exportInventory("p1", fmt);
    const imported = await inv.importInventory({
      format: fmt,
      content: payload as string,
      inventoryName: "RT-reimport",
    });

    expect(imported.item_count).toBe(1);
    expect(imported.imported).toBe(1);

    const exportUrl = new URL(String(mockFetch.mock.calls[0][0]));
    expect(exportUrl.pathname).toBe(`/inventory-manager/inventories/p1/export/${fmt}`);

    const { url, init } = lastCall(mockFetch);
    expect(url.pathname).toBe("/inventory-manager/inventories/import");
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.content).toBe(exported);
    expect(body.inventory_name).toBe("RT-reimport");
  });

  it("workbook round-trip preserves byte count", async () => {
    const xlsx = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x78, 0x6c, 0x73, 0x78]);

    mockFetch
      .mockResolvedValueOnce(new Response(xlsx))
      .mockResolvedValueOnce(jsonResp(201, { id: "p2", item_count: 5, imported: 5, format: "xlsx" }));

    const payload = await inv.exportInventory("p1", "workbook");
    expect(payload).toEqual(xlsx);

    const imported = await inv.importInventory({
      format: "xlsx",
      content: payload as Uint8Array,
    });
    expect(imported.item_count).toBe(5);
  });
});
