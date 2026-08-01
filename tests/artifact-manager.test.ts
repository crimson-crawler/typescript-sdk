/**
 * Unit tests for the hand-written Artifact Manager API client (client.artifactManager).
 *
 * Mirrors the Python SDK's equivalent suite — mocks the fetch layer (no
 * network), asserts each method hits the right path/method/params/body and
 * unwraps the response envelope, and that non-2xx throws UnexpectedStatus.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import { UnexpectedStatus } from "../src/exceptions";
import { ArtifactManagerApi } from "../src/artifact-manager";

const BASE = "https://api.test";

function jsonResp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let mockFetch: Mock;
let ws: ArtifactManagerApi;

beforeEach(() => {
  mockFetch = vi.fn();
  ws = new ArtifactManagerApi(BASE, "test-key", mockFetch as never);
});

function lastCall(): { url: URL; init: RequestInit } {
  const [input, init] = mockFetch.mock.calls.at(-1)!;
  return { url: new URL(String(input)), init: init as RequestInit };
}

describe("request plumbing", () => {
  it("sends the apikey header on every call", async () => {
    mockFetch.mockResolvedValue(jsonResp(200, { artifacts: [] }));
    await ws.listArtifacts();
    const { init } = lastCall();
    expect((init.headers as Record<string, string>).apikey).toBe("test-key");
  });

  it("throws UnexpectedStatus with status + body on non-2xx", async () => {
    mockFetch.mockResolvedValue(jsonResp(404, { error: "not found" }));
    const err = await ws.getArtifact("x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnexpectedStatus);
    expect((err as UnexpectedStatus).status).toBe(404);
  });

  it("keeps caller ids in one encoded path segment", async () => {
    mockFetch.mockResolvedValue(jsonResp(200, { artifact: { id: "safe" } }));

    await ws.getArtifact("../folders?raw=1#fragment%");

    expect(lastCall().url.pathname).toBe(
      "/artifact-manager/artifacts/..%2Ffolders%3Fraw%3D1%23fragment%25",
    );
  });
});

describe("artifacts", () => {
  it("listArtifacts forwards filters as query params", async () => {
    mockFetch.mockResolvedValue(jsonResp(200, { artifacts: [{ id: "a1" }] }));
    const out = await ws.listArtifacts({
      kind: "enrichment",
      folder: "__root__",
      since: "2026-01-01",
    });
    expect(out).toEqual([{ id: "a1" }]);
    const { url } = lastCall();
    expect(url.pathname).toBe("/artifact-manager/artifacts");
    expect(url.searchParams.get("kind")).toBe("enrichment");
    expect(url.searchParams.get("folder")).toBe("__root__");
    expect(url.searchParams.get("since")).toBe("2026-01-01");
  });

  it("uploadArtifacts posts the body and unwraps ids", async () => {
    mockFetch.mockResolvedValue(jsonResp(201, { ids: ["n1"], folderId: "f1" }));
    const out = await ws.uploadArtifacts(
      [{ name: "n.txt", content: "c", format: "paste" }],
      { newFolderName: "case-1" },
    );
    expect(out.ids).toEqual(["n1"]);
    const { init } = lastCall();
    const body = JSON.parse(String(init.body));
    expect(body.newFolderName).toBe("case-1");
    expect(body.folderId).toBeUndefined();
    expect(init.method).toBe("POST");
  });

  it("getArtifact unwraps the envelope; getArtifactRaw reads body + headers", async () => {
    mockFetch.mockResolvedValue(
      jsonResp(200, { artifact: { id: "a1", content: "x" } }),
    );
    expect((await ws.getArtifact("a1")).content).toBe("x");

    mockFetch.mockResolvedValue(
      new Response('{"report":1}', {
        status: 200,
        headers: {
          "x-artifact-id": "a1",
          "x-artifact-kind": "artifact_enrichment",
          "x-artifact-name": "Scan%20%C2%B7%205",
          "x-artifact-format": "scan_report",
        },
      }),
    );
    const raw = await ws.getArtifactRaw("a1");
    expect(raw.content).toBe('{"report":1}');
    expect(raw.kind).toBe("artifact_enrichment");
    expect(raw.name).toBe("Scan · 5"); // URL-decoded
    expect(lastCall().url.searchParams.get("raw")).toBe("1");
  });

  it("getArtifactRaw falls back to the artifact id for a malformed encoded name", async () => {
    mockFetch.mockResolvedValue(
      new Response("content", {
        status: 200,
        headers: { "x-artifact-name": "bad%ZZname" },
      }),
    );
    await expect(ws.getArtifactRaw("a1")).resolves.toMatchObject({
      name: "a1",
    });
  });

  it("updateArtifact distinguishes omit-folder from move-to-root(null)", async () => {
    // Fresh Response per call — a Response body is single-read.
    mockFetch.mockImplementation(() =>
      Promise.resolve(jsonResp(200, { artifact: { id: "a1" } })),
    );
    await ws.updateArtifact("a1", { name: "new", favorite: true });
    expect(JSON.parse(String(lastCall().init.body))).toEqual({
      name: "new",
      favorite: true,
    });

    await ws.updateArtifact("a1", { folderId: null });
    expect(JSON.parse(String(lastCall().init.body))).toEqual({
      folderId: null,
    });
  });

  it("deleteArtifact and copyArtifact", async () => {
    mockFetch.mockResolvedValue(jsonResp(200, { deleted: true }));
    expect(await ws.deleteArtifact("a1")).toBe(true);
    expect(lastCall().init.method).toBe("DELETE");

    mockFetch.mockResolvedValue(jsonResp(201, { id: "copy-1" }));
    expect(await ws.copyArtifact("a1")).toBe("copy-1");
    expect(lastCall().url.pathname).toBe("/artifact-manager/artifacts/a1/copy");
  });
});

describe("bulk operations", () => {
  it("bulkDelete posts {op:'delete', ids} and unwraps count", async () => {
    mockFetch.mockResolvedValue(jsonResp(200, { op: "delete", count: 2 }));
    expect(await ws.bulkDelete(["a1", "a2"])).toBe(2);
    const { url, init } = lastCall();
    expect(url.pathname).toBe("/artifact-manager/artifacts/bulk");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      op: "delete",
      ids: ["a1", "a2"],
    });
  });

  it("moveToFolder posts {op:'move', folder_id} (folder + default-root)", async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(jsonResp(200, { op: "move", count: 3 })),
    );
    expect(await ws.moveToFolder(["a1", "a2", "a3"], "f1")).toBe(3);
    expect(JSON.parse(String(lastCall().init.body))).toEqual({
      op: "move",
      ids: ["a1", "a2", "a3"],
      folder_id: "f1",
    });

    await ws.moveToFolder(["a1"]);
    expect(JSON.parse(String(lastCall().init.body))).toEqual({
      op: "move",
      ids: ["a1"],
      folder_id: null,
    });
  });

  it("bulkSetFavorite posts {op:'favorite', favorite} and unwraps count", async () => {
    mockFetch.mockResolvedValue(jsonResp(200, { op: "favorite", count: 4 }));
    expect(await ws.bulkSetFavorite(["a1", "a2"], true)).toBe(4);
    expect(JSON.parse(String(lastCall().init.body))).toEqual({
      op: "favorite",
      ids: ["a1", "a2"],
      favorite: true,
    });
  });

  it("throws UnexpectedStatus on a 400 (empty ids)", async () => {
    mockFetch.mockResolvedValue(jsonResp(400, { error: "ids[] is required" }));
    const err = await ws.bulkDelete([]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnexpectedStatus);
    expect((err as UnexpectedStatus).status).toBe(400);
  });
});

describe("scan surface", () => {
  it("rating get/set/clear", async () => {
    mockFetch.mockResolvedValue(
      jsonResp(200, { rating: "up", counts: { up: 1, down: 0 } }),
    );
    expect((await ws.getRating("s1")).rating).toBe("up");

    mockFetch.mockResolvedValue(jsonResp(200, { ok: true, cleared: true }));
    await ws.setRating("s1", null);
    expect(JSON.parse(String(lastCall().init.body))).toEqual({ rating: null });
  });

  it("listExports + getExport (filename from Content-Disposition)", async () => {
    mockFetch.mockResolvedValue(jsonResp(200, { formats: ["csv", "stix"] }));
    expect(await ws.listExports("s1")).toEqual(["csv", "stix"]);

    mockFetch.mockResolvedValue(
      new Response('{"type":"bundle"}', {
        status: 200,
        headers: {
          "content-disposition": 'attachment; filename="stix.json"',
          "content-type": "application/json; charset=utf-8",
        },
      }),
    );
    const exp = await ws.getExport("s1", "stix");
    expect(exp).toMatchObject({
      content: '{"type":"bundle"}',
      filename: "stix.json",
      contentType: "application/json; charset=utf-8",
    });
    expect(new TextDecoder().decode(exp.bytes)).toBe('{"type":"bundle"}');
  });

  it("getExport reduces a traversal-shaped filename to a basename", async () => {
    mockFetch.mockResolvedValue(
      new Response("data", {
        status: 200,
        headers: {
          "content-disposition":
            'attachment; filename="../../home/user/.bashrc"',
        },
      }),
    );
    expect((await ws.getExport("s1", "json")).filename).toBe(".bashrc");
  });

  it("getExport returns binary bytes for an XLSX (emass) export", async () => {
    const xlsxBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]); // PK.. zip magic
    mockFetch.mockResolvedValue(
      new Response(xlsxBytes, {
        status: 200,
        headers: {
          "content-disposition": 'attachment; filename="emass.xlsx"',
          "content-type":
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        },
      }),
    );
    const exp = await ws.getExport("s1", "emass");
    expect(exp.filename).toBe("emass.xlsx");
    expect(exp.contentType).toContain("spreadsheetml");
    expect(Array.from(exp.bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  it("downloadAllExports returns the bundle .zip bytes from /exports/all", async () => {
    const zipBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 9, 9, 9]); // PK.. zip magic
    mockFetch.mockResolvedValue(
      new Response(zipBytes, {
        status: 200,
        headers: {
          "content-disposition": 'attachment; filename="my-exports.zip"',
          "content-type": "application/zip",
        },
      }),
    );
    const out = await ws.downloadAllExports("s1");
    expect(Array.from(out.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(new URL(String(mockFetch.mock.calls[0][0])).pathname).toBe(
      "/artifact-manager/artifacts/s1/exports/all",
    );
  });

  it("downloadBundle POSTs {ids} to /artifacts/bundle and returns the .zip bytes", async () => {
    const zipBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2]);
    mockFetch.mockResolvedValue(
      new Response(zipBytes, {
        status: 200,
        headers: { "content-type": "application/zip" },
      }),
    );
    const out = await ws.downloadBundle(["a1", "a2"]);
    expect(Array.from(out.slice(0, 2))).toEqual([0x50, 0x4b]);
    const { url, init } = lastCall();
    expect(url.pathname).toBe("/artifact-manager/artifacts/bundle");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ ids: ["a1", "a2"] });
  });

  it("compareEnrichments joins ids and unwraps the matrix", async () => {
    mockFetch.mockResolvedValue(
      jsonResp(200, { matrix: { counts: { new: 1 } } }),
    );
    const matrix = await ws.compareEnrichments(["a", "b"]);
    expect((matrix.counts as { new: number }).new).toBe(1);
    expect(lastCall().url.searchParams.get("ids")).toBe("a,b");
  });
});

describe("folders", () => {
  it("full folder CRUD", async () => {
    mockFetch.mockResolvedValue(
      jsonResp(200, { folders: [{ id: "f1", artifact_count: 2 }] }),
    );
    expect((await ws.listFolders())[0].id).toBe("f1");

    mockFetch.mockResolvedValue(jsonResp(201, { id: "f2", name: "evidence" }));
    expect(await ws.createFolder("evidence")).toBe("f2");

    mockFetch.mockResolvedValue(jsonResp(200, { id: "f2", name: "renamed" }));
    expect((await ws.renameFolder("f2", "renamed")).name).toBe("renamed");

    mockFetch.mockResolvedValue(jsonResp(200, { deleted: true }));
    expect(await ws.deleteFolder("f2")).toBe(true);
  });

  it("downloadFolder GETs /folders/{id}/exports/all and returns the .zip bytes", async () => {
    const zipBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 7]);
    mockFetch.mockResolvedValue(
      new Response(zipBytes, {
        status: 200,
        headers: { "content-type": "application/zip" },
      }),
    );
    const out = await ws.downloadFolder("f1");
    expect(Array.from(out.slice(0, 2))).toEqual([0x50, 0x4b]);
    expect(lastCall().url.pathname).toBe(
      "/artifact-manager/folders/f1/exports/all",
    );
  });
});

describe("saveEnrichment", () => {
  const ID = "b".repeat(32);

  it("POSTs the enrichment id (and optional folder) to from-enrichment", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResp(201, { enrichment_artifact_id: "art-9" }),
    );
    const out = await ws.saveEnrichment(ID, { newFolderName: "incident-2026" });
    expect(out).toEqual({ enrichment_artifact_id: "art-9" });
    const [input, init] = mockFetch.mock.calls.at(-1)!;
    expect(new URL(String(input)).pathname).toBe(
      "/artifact-manager/artifacts/from-enrichment",
    );
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      enrichment_id: ID,
      folder: { folder_id: null, new_folder_name: "incident-2026" },
    });
  });

  it("sends id only when no folder is given, and throws on non-2xx", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResp(201, { enrichment_artifact_id: "art-9" }),
    );
    await ws.saveEnrichment(ID);
    expect(
      JSON.parse(
        (mockFetch.mock.calls.at(-1)![1] as RequestInit).body as string,
      ),
    ).toEqual({ enrichment_id: ID });

    mockFetch.mockResolvedValueOnce(
      jsonResp(409, { error: "enrichment not complete" }),
    );
    await expect(ws.saveEnrichment(ID)).rejects.toThrow(UnexpectedStatus);
  });
});
