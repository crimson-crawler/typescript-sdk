/**
 * Unit tests for the shared submit→poll core (`src/_poll.ts`).
 *
 * Mocks fetch — no network. Covers the deadline-based timeout, the progress
 * callback, and callback-error swallowing for the two async engines.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

afterEach(() => {
  vi.useRealTimers();
});

describe("pollUntilDone", () => {
  it("calls onProgress with the live job on every poll (incl. terminal done)", async () => {
    mockRequest
      .mockResolvedValueOnce(
        jsonResp(200, { status: "running", progress: 0.3 }),
      )
      .mockResolvedValueOnce(
        jsonResp(200, { status: "done", progress: 1, result: { ok: true } }),
      );

    const seen: Array<[unknown, unknown]> = [];
    const job = await pollUntilDone(mockRequest, ID, STATUS_PATH, {
      pollIntervalMs: 0,
      timeoutMs: 10_000,
      onProgress: (j) => seen.push([j.status, j.progress]),
    });

    expect(job.status).toBe("done");
    expect(seen).toEqual([
      ["running", 0.3],
      ["done", 1],
    ]);
  });

  it("swallows a throwing onProgress without breaking the poll", async () => {
    mockRequest
      .mockResolvedValueOnce(jsonResp(200, { status: "running" }))
      .mockResolvedValueOnce(
        jsonResp(200, { status: "done", result: { ok: true } }),
      );

    const job = await pollUntilDone(mockRequest, ID, STATUS_PATH, {
      pollIntervalMs: 0,
      timeoutMs: 10_000,
      onProgress: () => {
        throw new Error("ui crashed");
      },
    });

    expect(job.result).toEqual({ ok: true });
  });

  it("rejects invalid deadline and interval values", async () => {
    mockRequest.mockResolvedValue(jsonResp(200, { status: "running" }));
    await expect(
      pollUntilDone(mockRequest, ID, STATUS_PATH, {
        pollIntervalMs: 0,
        timeoutMs: -1,
      }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      pollUntilDone(mockRequest, ID, STATUS_PATH, {
        pollIntervalMs: Number.POSITIVE_INFINITY,
        timeoutMs: 100,
      }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  // These three attach the rejection expectation BEFORE advancing the clock. The poll
  // rejects *during* `advanceTimersByTimeAsync`, so asserting afterwards leaves the
  // rejection unhandled for a turn and Node reports it globally — vitest then exits
  // non-zero with every test still passing.
  it("enforces the deadline when a status request never settles", async () => {
    vi.useFakeTimers();
    mockRequest.mockReturnValue(new Promise<Response>(() => undefined));
    const settled = expect(
      pollUntilDone(mockRequest, ID, STATUS_PATH, {
        pollIntervalMs: 1,
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/did not finish/);
    await vi.advanceTimersByTimeAsync(50);
    await settled;
    expect(mockRequest.mock.calls[0]?.[2]).toBeLessThanOrEqual(50);
  });

  it("enforces the deadline when onProgress never settles", async () => {
    vi.useFakeTimers();
    mockRequest.mockResolvedValue(jsonResp(200, { status: "running" }));
    const settled = expect(
      pollUntilDone(mockRequest, ID, STATUS_PATH, {
        pollIntervalMs: 1,
        timeoutMs: 50,
        onProgress: () => new Promise<void>(() => undefined),
      }),
    ).rejects.toThrow(/did not finish/);
    await vi.advanceTimersByTimeAsync(50);
    await settled;
  });

  it("clamps a long poll sleep to the remaining deadline", async () => {
    vi.useFakeTimers();
    const timerSpy = vi.spyOn(globalThis, "setTimeout");
    mockRequest.mockResolvedValue(jsonResp(200, { status: "running" }));
    const settled = expect(
      pollUntilDone(mockRequest, ID, STATUS_PATH, {
        pollIntervalMs: 60_000,
        timeoutMs: 75,
      }),
    ).rejects.toThrow(/did not finish/);
    await vi.advanceTimersByTimeAsync(75);
    await settled;
    const delays = timerSpy.mock.calls.map((call) => Number(call[1]));
    expect(delays.length).toBeGreaterThan(0);
    expect(Math.max(...delays)).toBeLessThanOrEqual(75);
  });

  it("throws UnexpectedStatus on an engine-side error status", async () => {
    mockRequest.mockResolvedValue(
      jsonResp(200, { status: "error", error: "oom" }),
    );

    await expect(
      pollUntilDone(mockRequest, ID, STATUS_PATH, {
        pollIntervalMs: 0,
        timeoutMs: 10_000,
      }),
    ).rejects.toBeInstanceOf(UnexpectedStatus);
  });
});
