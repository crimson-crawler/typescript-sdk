/**
 * Unit tests for the shared submit→poll core (`src/_poll.ts`).
 *
 * Mocks fetch — no network. Covers the deadline-based timeout, the progress
 * callback, and callback-error swallowing for the two async engines.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import { UnexpectedStatus } from "../src/exceptions";
import { pollUntilDone } from "../src/_poll";

const ID = "a".repeat(32);
const STATUS_PATH = `/v1/artifact-enrich/${ID}`;

function jsonResp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let mockRequest: Mock;

beforeEach(() => {
  mockRequest = vi.fn();
});

describe("pollUntilDone", () => {
  it("calls onProgress with the live job on every poll (incl. terminal done)", async () => {
    mockRequest
      .mockResolvedValueOnce(jsonResp(200, { status: "running", progress: 0.3 }))
      .mockResolvedValueOnce(jsonResp(200, { status: "done", progress: 1, result: { ok: true } }));

    const seen: Array<[unknown, unknown]> = [];
    const job = await pollUntilDone(mockRequest, ID, STATUS_PATH, {
      pollIntervalMs: 0,
      timeoutMs: 10_000,
      onProgress: (j) => seen.push([j.status, j.progress]),
    });

    expect(job.status).toBe("done");
    expect(seen).toEqual([["running", 0.3], ["done", 1]]);
  });

  it("swallows a throwing onProgress without breaking the poll", async () => {
    mockRequest
      .mockResolvedValueOnce(jsonResp(200, { status: "running" }))
      .mockResolvedValueOnce(jsonResp(200, { status: "done", result: { ok: true } }));

    const job = await pollUntilDone(mockRequest, ID, STATUS_PATH, {
      pollIntervalMs: 0,
      timeoutMs: 10_000,
      onProgress: () => { throw new Error("ui crashed"); },
    });

    expect(job.result).toEqual({ ok: true });
  });

  it("throws when the deadline expires before the job finishes", async () => {
    mockRequest.mockResolvedValue(jsonResp(200, { status: "running" }));

    await expect(
      pollUntilDone(mockRequest, ID, STATUS_PATH, { pollIntervalMs: 0, timeoutMs: -1 }),
    ).rejects.toThrow(/did not finish/);
  });

  it("throws UnexpectedStatus on an engine-side error status", async () => {
    mockRequest.mockResolvedValue(jsonResp(200, { status: "error", error: "oom" }));

    await expect(
      pollUntilDone(mockRequest, ID, STATUS_PATH, { pollIntervalMs: 0, timeoutMs: 10_000 }),
    ).rejects.toBeInstanceOf(UnexpectedStatus);
  });
});
