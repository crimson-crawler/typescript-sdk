/**
 * Unit tests for the hand-written Report Generator (AI Reports) API client (client.aiReports).
 *
 * Mocks the fetch layer (no network) — mirrors the Python test_ai_reports.py suite. Asserts each
 * method hits the right /ai-reports path/method/body and that generateReport runs the full flow.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { AiReportsApi } from "../src/ai-reports";
import { UnexpectedStatus } from "../src/exceptions";

const BASE = "https://api.test";

function jsonResp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function rawResp(text: string, headers: Record<string, string>): Response {
  return new Response(text, { status: 200, headers });
}

let mockFetch: ReturnType<typeof vi.fn>;
let ws: AiReportsApi;

beforeEach(() => {
  mockFetch = vi.fn();
  ws = new AiReportsApi(BASE, "test-key", mockFetch as never);
});

function lastCall(): { url: URL; init: RequestInit } {
  const [input, init] = mockFetch.mock.calls.at(-1)!;
  return { url: new URL(String(input)), init: init as RequestInit };
}

describe("request plumbing", () => {
  it("throws UnexpectedStatus on a non-2xx", async () => {
    mockFetch.mockResolvedValue(jsonResp(404, { error: "not found" }));
    await expect(ws.getReport("missing")).rejects.toBeInstanceOf(UnexpectedStatus);
  });

  it("sends the apikey header", async () => {
    mockFetch.mockResolvedValue(jsonResp(200, { templates: [] }));
    await ws.listTemplates();
    expect((lastCall().init.headers as Record<string, string>).apikey).toBe("test-key");
  });
});

describe("read + manage", () => {
  it("listTemplates unwraps templates[]", async () => {
    mockFetch.mockResolvedValue(jsonResp(200, { templates: [{ id: "exec" }] }));
    expect(await ws.listTemplates()).toEqual([{ id: "exec" }]);
    expect(lastCall().url.pathname).toBe("/ai-reports/templates");
  });

  it("listReports unwraps reports[]", async () => {
    mockFetch.mockResolvedValue(jsonResp(200, { reports: [{ id: "r1" }] }));
    expect(await ws.listReports()).toEqual([{ id: "r1" }]);
    expect(lastCall().url.pathname).toBe("/ai-reports/reports");
  });

  it("getReport unwraps report", async () => {
    mockFetch.mockResolvedValue(jsonResp(200, { report: { id: "r1" } }));
    expect((await ws.getReport("r1")).id).toBe("r1");
    expect(lastCall().url.pathname).toBe("/ai-reports/reports/r1");
  });

  it("getReportRaw streams body + headers", async () => {
    mockFetch.mockResolvedValue(rawResp("<h1>R</h1>", { "x-artifact-id": "r1", "x-artifact-format": "html_report" }));
    const out = await ws.getReportRaw("r1");
    expect(out.content).toBe("<h1>R</h1>");
    expect(out.format).toBe("html_report");
    expect(lastCall().url.searchParams.get("raw")).toBe("1");
  });

  it("renameReport PATCHes name + unwraps report", async () => {
    mockFetch.mockResolvedValue(jsonResp(200, { report: { id: "r1", name: "New" } }));
    expect((await ws.renameReport("r1", "New")).name).toBe("New");
    const { url, init } = lastCall();
    expect(init.method).toBe("PATCH");
    expect(url.pathname).toBe("/ai-reports/reports/r1");
    expect(JSON.parse(String(init.body))).toEqual({ name: "New" });
  });

  it("deleteReport returns the deleted flag", async () => {
    mockFetch.mockResolvedValue(jsonResp(200, { deleted: true }));
    expect(await ws.deleteReport("r1")).toBe(true);
    expect(lastCall().init.method).toBe("DELETE");
  });

  it("discovery GETs the root", async () => {
    mockFetch.mockResolvedValue(jsonResp(200, { endpoints: [] }));
    await ws.discovery();
    expect(lastCall().url.pathname).toBe("/ai-reports");
  });
});

describe("create + fill", () => {
  it("createDraft sends the full body", async () => {
    mockFetch.mockResolvedValue(jsonResp(201, { id: "r1", ai_sections: [], skipped: [] }));
    await ws.createDraft("exec", { sourceIds: ["s1"], name: "Brief" });
    const { url, init } = lastCall();
    expect(url.pathname).toBe("/ai-reports/reports");
    expect(JSON.parse(String(init.body))).toEqual({ template: "exec", source_ids: ["s1"], name: "Brief" });
  });

  it("createDraft minimal sends only template", async () => {
    mockFetch.mockResolvedValue(jsonResp(201, { id: "r2", ai_sections: [], skipped: [] }));
    await ws.createDraft("technical");
    expect(JSON.parse(String(lastCall().init.body))).toEqual({ template: "technical" });
  });

  it("fillSection (next pending) posts an empty body", async () => {
    mockFetch.mockResolvedValue(jsonResp(200, { section_type: "bluf", complete: true }));
    await ws.fillSection("r1");
    const { url, init } = lastCall();
    expect(url.pathname).toBe("/ai-reports/reports/r1/sections");
    expect(JSON.parse(String(init.body))).toEqual({});
  });

  it("fillSection (specific) posts section_type", async () => {
    mockFetch.mockResolvedValue(jsonResp(200, { section_type: "bluf", complete: false }));
    await ws.fillSection("r1", "bluf");
    expect(JSON.parse(String(lastCall().init.body))).toEqual({ section_type: "bluf" });
  });

  it("section posts the ad-hoc grounded request", async () => {
    mockFetch.mockResolvedValue(jsonResp(200, { text: "…", grounded: true, unsupported_ids: [] }));
    const out = await ws.section(["s1"], { sectionType: "key_judgments", verbosity: "detailed" });
    expect(out.grounded).toBe(true);
    const { url, init } = lastCall();
    expect(url.pathname).toBe("/ai-reports/section");
    expect(JSON.parse(String(init.body))).toEqual({ source_ids: ["s1"], section_type: "key_judgments", verbosity: "detailed" });
  });
});

describe("export", () => {
  it("exportReport md returns content + filename", async () => {
    mockFetch.mockResolvedValue(rawResp("# Report\n", {
      "content-disposition": 'attachment; filename="exec-brief.md"',
      "content-type": "text/markdown; charset=utf-8",
    }));
    const out = await ws.exportReport("r1", "md");
    expect(out.content).toBe("# Report\n");
    expect(out.filename).toBe("exec-brief.md");
    expect(out.contentType).toBe("text/markdown; charset=utf-8");
    expect(lastCall().url.pathname).toBe("/ai-reports/reports/r1/export/md");
  });

  it("exportReport defaults to html", async () => {
    mockFetch.mockResolvedValue(rawResp("<h1>R</h1>", { "content-type": "text/html" }));
    const out = await ws.exportReport("r1");
    expect(out.content).toBe("<h1>R</h1>");
    expect(out.filename).toBe("r1.html");
    expect(lastCall().url.pathname).toBe("/ai-reports/reports/r1/export/html");
  });
});

describe("generateReport", () => {
  it("creates, fills each section, then fetches", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResp(201, { id: "r9", ai_sections: [{ section_type: "a" }, { section_type: "b" }], skipped: ["bad"] }))
      .mockResolvedValueOnce(jsonResp(200, { section_type: "a", complete: false }))
      .mockResolvedValueOnce(jsonResp(200, { section_type: "b", complete: true }))
      .mockResolvedValueOnce(jsonResp(200, { report: { id: "r9" } }));
    const out = await ws.generateReport("technical", { sourceIds: ["s1"], name: "T" });
    expect((out.report as Record<string, unknown>).id).toBe("r9");
    expect((out.sections as unknown[]).length).toBe(2);
    expect(out.skipped).toEqual(["bad"]);
    expect(new URL(String(mockFetch.mock.calls[0][0])).pathname).toBe("/ai-reports/reports");
    expect(new URL(String(mockFetch.mock.calls[3][0])).pathname).toBe("/ai-reports/reports/r9");
  });

  it("no ai sections skips fill", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResp(201, { id: "r1", ai_sections: [], skipped: [] }))
      .mockResolvedValueOnce(jsonResp(200, { report: { id: "r1" } }));
    const out = await ws.generateReport("exec");
    expect((out.sections as unknown[]).length).toBe(0);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("records a copilot 502 and stops", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResp(201, { id: "r1", ai_sections: [{ section_type: "a" }], skipped: [] }))
      .mockResolvedValueOnce(jsonResp(502, { error: "copilot down" }))
      .mockResolvedValueOnce(jsonResp(200, { report: { id: "r1" } }));
    const out = await ws.generateReport("exec");
    expect(out.sections).toEqual([{ error: "generation failed", status: 502 }]);
  });
});

describe("S14: generateReport() one-shot", () => {
  it("creates, fills all sections, then fetches the report in one call", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResp(201, { id: "r10", ai_sections: [{ section_type: "bluf" }], skipped: [] }))
      .mockResolvedValueOnce(jsonResp(200, { section_type: "bluf", filled: true, remaining: [], complete: true }))
      .mockResolvedValueOnce(jsonResp(200, { report: { id: "r10", name: "Exec brief" } }));

    const out = await ws.generateReport("exec", { sourceIds: ["s1"], name: "Exec brief" });

    expect((out.report as Record<string, unknown>).id).toBe("r10");
    expect((out.report as Record<string, unknown>).name).toBe("Exec brief");
    expect((out.sections as unknown[]).length).toBe(1);
    expect(new URL(String(mockFetch.mock.calls[0][0])).pathname).toBe("/ai-reports/reports");
    expect(JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      template: "exec", source_ids: ["s1"], name: "Exec brief",
    });
    expect(new URL(String(mockFetch.mock.calls[2][0])).pathname).toBe("/ai-reports/reports/r10");
  });
});
