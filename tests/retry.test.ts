/**
 * Unit tests for the retry/backoff helper (src/retry.ts).
 *
 * These exercise the pure functions — backoff math, Retry-After parsing,
 * the retryable-error predicate — with a fixed RNG so jitter is reproducible.
 * The retry *loop* is exercised end-to-end in wrapper.test.ts.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  computeBackoff,
  DEFAULT_MAX_RETRIES,
  isRetryableFetchError,
  parseRetryAfter,
  RETRY_AFTER_MAX,
  RETRY_BASE_DELAY,
  RETRY_JITTER_RATIO,
  RETRY_MAX_DELAY,
  RETRYABLE_STATUS,
  resolveDelay,
  sleepBackoff,
} from "../src/retry";

describe("retry constants", () => {
  it("matches the locked contract", () => {
    expect(RETRY_BASE_DELAY).toBe(0.5);
    expect(RETRY_MAX_DELAY).toBe(8.0);
    expect(RETRY_JITTER_RATIO).toBe(0.25);
    expect(RETRY_AFTER_MAX).toBe(60.0);
    expect(DEFAULT_MAX_RETRIES).toBe(2);
  });

  it("retryable status set is exactly 429/502/503/504", () => {
    expect([...RETRYABLE_STATUS].sort()).toEqual([429, 502, 503, 504]);
    for (const s of [400, 401, 403, 404, 422, 500]) {
      expect(RETRYABLE_STATUS.has(s)).toBe(false);
    }
  });
});

describe("computeBackoff", () => {
  it("is the bare exponential when jitter is zero (rng=0.5)", () => {
    const rng = () => 0.5; // → uniform(-1,1) = 0 → no jitter
    expect(computeBackoff(0, rng)).toBeCloseTo(0.5);
    expect(computeBackoff(1, rng)).toBeCloseTo(1.0);
    expect(computeBackoff(2, rng)).toBeCloseTo(2.0);
    expect(computeBackoff(3, rng)).toBeCloseTo(4.0);
  });

  it("caps at RETRY_MAX_DELAY for high attempt indices", () => {
    const rng = () => 0.5;
    expect(computeBackoff(4, rng)).toBe(8.0); // raw 8.0
    expect(computeBackoff(10, rng)).toBe(8.0); // raw 512 → capped
  });

  it("applies +25% jitter at rng=1", () => {
    const rng = () => 1; // → uniform = +1 → full positive jitter
    // attempt 0: raw 0.5, +0.125 = 0.625
    expect(computeBackoff(0, rng)).toBeCloseTo(0.625);
  });

  it("applies -25% jitter at rng=0 and never goes negative", () => {
    const rng = () => 0; // → uniform = -1 → full negative jitter
    expect(computeBackoff(0, rng)).toBeCloseTo(0.375);
    expect(computeBackoff(0, rng)).toBeGreaterThanOrEqual(0);
  });
});

describe("parseRetryAfter", () => {
  it("returns null for absent/empty", () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter(undefined)).toBeNull();
    expect(parseRetryAfter("   ")).toBeNull();
  });

  it("parses delta-seconds", () => {
    expect(parseRetryAfter("2")).toBe(2);
    expect(parseRetryAfter("0")).toBe(0);
  });

  it("clamps delta-seconds to RETRY_AFTER_MAX", () => {
    expect(parseRetryAfter("600")).toBe(60);
  });

  it("parses an HTTP-date relative to now", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    const future = "Thu, 01 Jan 2026 00:00:05 GMT";
    expect(parseRetryAfter(future, now)).toBeCloseTo(5);
  });

  it("clamps an HTTP-date to RETRY_AFTER_MAX", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    const farFuture = "Thu, 01 Jan 2026 01:00:00 GMT"; // +1h
    expect(parseRetryAfter(farFuture, now)).toBe(60);
  });

  it("floors a past HTTP-date at 0", () => {
    const now = Date.parse("2026-01-01T00:00:10Z");
    const past = "Thu, 01 Jan 2026 00:00:00 GMT";
    expect(parseRetryAfter(past, now)).toBe(0);
  });

  it("returns null for an unparseable header", () => {
    expect(parseRetryAfter("soon-ish")).toBeNull();
  });
});

describe("resolveDelay", () => {
  it("honors Retry-After over the computed backoff", () => {
    expect(resolveDelay(0, "2", () => 0.5)).toBe(2);
  });

  it("falls back to computed backoff when Retry-After is absent/unparseable", () => {
    expect(resolveDelay(0, null, () => 0.5)).toBeCloseTo(0.5);
    expect(resolveDelay(1, "garbage", () => 0.5)).toBeCloseTo(1.0);
  });
});

describe("isRetryableFetchError", () => {
  it("retries a TypeError (network failure) when no user signal", () => {
    expect(
      isRetryableFetchError(new TypeError("fetch failed"), undefined),
    ).toBe(true);
  });

  it("retries the wrapper's own timeout abort (TimeoutError)", () => {
    const err = new DOMException("timed out", "TimeoutError");
    expect(isRetryableFetchError(err, undefined)).toBe(true);
  });

  it("retries a plain object named TimeoutError (runtime variance)", () => {
    expect(isRetryableFetchError({ name: "TimeoutError" }, undefined)).toBe(
      true,
    );
  });

  it("does NOT retry when a caller signal is present (explicit cancellation)", () => {
    const signal = new AbortController().signal;
    expect(isRetryableFetchError(new TypeError("x"), signal)).toBe(false);
    expect(
      isRetryableFetchError(new DOMException("a", "TimeoutError"), signal),
    ).toBe(false);
  });

  it("does NOT retry a non-network, non-timeout error", () => {
    expect(isRetryableFetchError(new Error("boom"), undefined)).toBe(false);
    expect(
      isRetryableFetchError(
        new DOMException("aborted", "AbortError"),
        undefined,
      ),
    ).toBe(false);
  });
});

describe("sleepBackoff", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sleeps the honored Retry-After delay (overrides computed backoff)", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    await sleepBackoff(0, "2", { maxRetries: 2, sleep, rng: () => 0.5 });
    // Retry-After wins: 2s, not the computed 0.5s backoff for attempt 0.
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(2);
  });

  it("sleeps the computed backoff when Retry-After is absent", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    // rng=0.5 → no jitter; attempt 0 → bare exponential 0.5s.
    await sleepBackoff(0, null, { maxRetries: 2, sleep, rng: () => 0.5 });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(0.5);
  });

  it("resolves via the default real-timer sleep when none is injected", async () => {
    vi.useFakeTimers();
    // rng=0.5 → no jitter → attempt 0 = 0.5s = 500ms via defaultSleep.
    const pending = sleepBackoff(0, null, { maxRetries: 2, rng: () => 0.5 });
    await vi.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toBeUndefined();
  });
});
