/**
 * Unit tests for the hand-written Enricher API client (client.enricher).
 *
 * Mocks the fetch layer (no network) — asserts the enrichment lifecycle hits the right
 * /v1/artifact-enrich paths (submit → poll, no save/discard).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { UnexpectedStatus } from "../src/exceptions";
import { EnricherApi } from "../src/enricher";

const BASE = "https://api.test";

function jsonResp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let mockFetch: ReturnType<typeof vi.fn>;
let ws: EnricherApi;

beforeEach(() => {
  mockFetch = vi.fn();
  ws = new EnricherApi(BASE, "test-key", mockFetch as never);
});

describe("enrich", () => {
  const ID = "a".repeat(32);

  it("submits to /v1, polls until done, then returns the report", async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResp(202, { enrichment_id: ID, status: "queued" }),
      )
      .mockResolvedValueOnce(jsonResp(200, { status: "running" }))
      .mockResolvedValueOnce(
        jsonResp(200, { status: "done", result: { meta: {} } }),
      );

    const out = await ws.enrich({
      text: "CVE-2021-44228",
      include: ["exploits"],
      pollIntervalMs: 0,
    });
    expect(out).toEqual({ enrichment_id: ID, report: { meta: {} } });

    const submit = mockFetch.mock.calls[0];
    expect(new URL(String(submit[0])).pathname).toBe("/v1/artifact-enrich");
    const body = JSON.parse((submit[1] as RequestInit).body as string);
    expect(body.text).toBe("CVE-2021-44228");
    expect(body.include).toEqual(["exploits"]);
    expect(body).not.toHaveProperty("save");
    expect(new URL(String(mockFetch.mock.calls[1][0])).pathname).toBe(
      `/v1/artifact-enrich/${ID}`,
    );
    expect(mockFetch).toHaveBeenCalledTimes(3); // no save POST
  });

  it("calls onProgress with the live job on every poll (incl. terminal done)", async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResp(202, { enrichment_id: ID, status: "queued" }),
      )
      .mockResolvedValueOnce(
        jsonResp(200, {
          status: "running",
          progress: 0.4,
          events: [{ message: "✓ CVE-1", progress: 0.4 }],
        }),
      )
      .mockResolvedValueOnce(
        jsonResp(200, { status: "done", progress: 1, result: {} }),
      );

    const seen: Array<[unknown, unknown]> = [];
    const out = await ws.enrich({
      text: "x",
      pollIntervalMs: 0,
      onProgress: (job) => {
        seen.push([job.status, job.progress]);
      },
    });
    expect(out.report).toEqual({});
    expect(seen).toEqual([
      ["running", 0.4],
      ["done", 1],
    ]);
  });

  it("a throwing onProgress never breaks the poll", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResp(202, { enrichment_id: ID }))
      .mockResolvedValueOnce(
        jsonResp(200, { status: "done", result: { ok: true } }),
      );
    const out = await ws.enrich({
      text: "x",
      pollIntervalMs: 0,
      onProgress: () => {
        throw new Error("render crashed");
      },
    });
    expect(out.report).toEqual({ ok: true }); // enrichment still completes
  });

  it("omits unset body fields", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResp(202, { enrichment_id: ID }))
      .mockResolvedValueOnce(jsonResp(200, { status: "done", result: {} }));
    await ws.enrich({ text: "x", pollIntervalMs: 0 });
    expect(
      JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string),
    ).toEqual({ text: "x" });
  });

  it("carries files + formats", async () => {
    const files = [{ filename: "scan.xml", content_b64: "PG5tYXA+" }];
    mockFetch
      .mockResolvedValueOnce(jsonResp(202, { enrichment_id: ID }))
      .mockResolvedValueOnce(jsonResp(200, { status: "done", result: {} }));
    await ws.enrich({ files, formats: ["markdown"], pollIntervalMs: 0 });
    expect(
      JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string),
    ).toEqual({
      files,
      formats: ["markdown"],
    });
  });

  it("carries the SSVC stakeholder into the submit", async () => {
    const stakeholder = {
      method: "deployer",
      exposure: "open",
      human_impact: "high",
      mission_prevalence: "essential",
      public_wellbeing_impact: "material",
    };
    mockFetch
      .mockResolvedValueOnce(jsonResp(202, { enrichment_id: ID }))
      .mockResolvedValueOnce(jsonResp(200, { status: "done", result: {} }));
    await ws.enrich({
      text: "CVE-2021-44228",
      include: ["ssvc"],
      stakeholder,
      pollIntervalMs: 0,
    });
    const body = JSON.parse(
      (mockFetch.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body.stakeholder).toEqual(stakeholder);
  });

  it("throws on an engine-side enrichment error", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResp(202, { enrichment_id: ID }))
      .mockResolvedValueOnce(jsonResp(200, { status: "error", error: "boom" }));
    await expect(
      ws.enrich({ text: "x", pollIntervalMs: 0 }),
    ).rejects.toBeInstanceOf(UnexpectedStatus);
  });

  it("throws UnexpectedStatus on a non-2xx submit", async () => {
    mockFetch.mockResolvedValue(jsonResp(401, { error: "no key" }));
    await expect(
      ws.enrich({ text: "x", pollIntervalMs: 0 }),
    ).rejects.toBeInstanceOf(UnexpectedStatus);
  });

  it("throws when the enrichment does not finish within the timeout", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResp(202, { enrichment_id: ID }))
      .mockResolvedValue(jsonResp(200, { status: "running" }));
    await expect(
      ws.enrich({ text: "x", pollIntervalMs: 0, timeoutMs: -1 }),
    ).rejects.toThrow(/did not finish/);
  });
});

describe("enrich({ save })", () => {
  const ID = "a".repeat(32);

  it("files the report after completion and carries the save response", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResp(202, { enrichment_id: ID }))
      .mockResolvedValueOnce(
        jsonResp(200, { status: "done", result: { meta: {} } }),
      )
      .mockResolvedValueOnce(
        jsonResp(201, { enrichment_artifact_id: "art-1" }),
      );

    const out = await ws.enrich({
      text: "x",
      pollIntervalMs: 0,
      save: true,
      newFolderName: "inc",
    });
    expect(out.enrichment_id).toBe(ID);
    expect(out.saved).toEqual({ enrichment_artifact_id: "art-1" });

    const save = mockFetch.mock.calls.at(-1)!;
    expect(new URL(String(save[0])).pathname).toBe(
      "/artifact-manager/artifacts/from-enrichment",
    );
    const body = JSON.parse((save[1] as RequestInit).body as string);
    expect(body).toEqual({
      enrichment_id: ID,
      folder: { folder_id: null, new_folder_name: "inc" },
    });
  });

  it("does not save by default", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResp(202, { enrichment_id: ID }))
      .mockResolvedValueOnce(jsonResp(200, { status: "done", result: {} }));
    const out = await ws.enrich({ text: "x", pollIntervalMs: 0 });
    expect(out.saved).toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe("S11: enrich() with onProgress", () => {
  const ID = "s".repeat(32);

  it("streams the live job on every poll and returns the report", async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResp(202, { enrichment_id: ID, status: "queued" }),
      )
      .mockResolvedValueOnce(
        jsonResp(200, { status: "running", progress: 0.6 }),
      )
      .mockResolvedValueOnce(
        jsonResp(200, { status: "done", progress: 1, result: { report: 1 } }),
      )
      .mockResolvedValueOnce(jsonResp(201, { saved: true }));

    const progress: number[] = [];
    const out = await ws.enrich({
      text: "CVE-2024-3400",
      include: ["kev"],
      pollIntervalMs: 0,
      onProgress: (job) => {
        const p = job.progress as number | undefined;
        if (p !== undefined) progress.push(p);
      },
      save: true,
    });

    expect(out.enrichment_id).toBe(ID);
    expect(out.report).toEqual({ report: 1 });
    expect(progress).toEqual([0.6, 1]);

    const submit = mockFetch.mock.calls[0];
    expect(new URL(String(submit[0])).pathname).toBe("/v1/artifact-enrich");
    const body = JSON.parse((submit[1] as RequestInit).body as string);
    expect(body.text).toBe("CVE-2024-3400");
    expect(body.include).toEqual(["kev"]);
  });
});
