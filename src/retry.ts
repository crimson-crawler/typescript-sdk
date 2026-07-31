/**
 * Retry/backoff helper for the Crimson Crawler client.
 *
 * Implements the unified retry contract shared by the Python SDK, the TS SDK,
 * and the MCP server: retries for transient failures, exponential backoff with
 * full ±25% jitter, a hard delay cap, and `Retry-After` honouring
 * (delta-seconds + HTTP-date, clamped to 60s). The fetch wrapper applies this
 * policy only to safe HTTP methods; mutations always make one attempt.
 *
 * The loop itself lives in `client.ts` (it has to wrap the existing custom
 * fetch); this module owns the constants, the backoff math, the
 * retry-condition predicate, and the sleep — all injectable for tests.
 */

/** HTTP status codes that warrant a retry. 429 + transient gateway 5xx. */
export const RETRYABLE_STATUS: ReadonlySet<number> = new Set([
  429, 502, 503, 504,
]);

/** Base delay (seconds) for the exponential schedule: 0.5, 1.0, 2.0, ... */
export const RETRY_BASE_DELAY = 0.5;
/** Hard cap (seconds) on any single computed backoff delay. */
export const RETRY_MAX_DELAY = 8.0;
/** Jitter band: ±25% of the computed (pre-cap) delay. */
export const RETRY_JITTER_RATIO = 0.25;
/** Ceiling (seconds) on an honored `Retry-After` so a hostile header can't hang us. */
export const RETRY_AFTER_MAX = 60.0;

/** Default retries (3 total attempts). Matches OpenAI/Anthropic SDK defaults. */
export const DEFAULT_MAX_RETRIES = 2;

/** Injectable RNG seam — returns a value in [0, 1). Defaults to `Math.random`. */
export type Rng = () => number;

/** Injectable sleep seam — resolves after `seconds`. Defaults to `setTimeout`. */
export type Sleep = (seconds: number) => Promise<void>;

const defaultSleep: Sleep = (seconds) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

/**
 * Compute the backoff delay (seconds) for a retry happening before the given
 * 0-based attempt index (`attempt=0` is the first retry).
 *
 * `raw = base * 2**attempt`, jittered by ±`RETRY_JITTER_RATIO`, capped at
 * `RETRY_MAX_DELAY`, floored at 0.
 */
export function computeBackoff(
  attempt: number,
  rng: Rng = Math.random,
): number {
  const raw = RETRY_BASE_DELAY * 2 ** attempt;
  // rng() in [0,1) → uniform(-1, 1).
  const jitter = raw * RETRY_JITTER_RATIO * (rng() * 2 - 1);
  const delay = Math.min(RETRY_MAX_DELAY, raw + jitter);
  return Math.max(0, delay);
}

/**
 * Parse a `Retry-After` header into seconds, or `null` if absent/unparseable.
 *
 * Handles both forms from RFC 7231: delta-seconds (an integer string) and an
 * HTTP-date. The result is clamped to `RETRY_AFTER_MAX`.
 */
export function parseRetryAfter(
  header: string | null | undefined,
  now: number = Date.now(),
): number | null {
  if (header == null) return null;
  const trimmed = header.trim();
  if (trimmed === "") return null;

  // delta-seconds: a bare integer.
  if (/^\d+$/.test(trimmed)) {
    return Math.min(RETRY_AFTER_MAX, Number(trimmed));
  }

  // HTTP-date.
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return null;
  const seconds = Math.max(0, (when - now) / 1000);
  return Math.min(RETRY_AFTER_MAX, seconds);
}

/**
 * Resolve the delay (seconds) to sleep before the next retry: an honored
 * `Retry-After` overrides the computed exponential backoff entirely.
 */
export function resolveDelay(
  attempt: number,
  retryAfter: string | null | undefined,
  rng: Rng = Math.random,
): number {
  const parsed = parseRetryAfter(retryAfter);
  if (parsed !== null) return parsed;
  return computeBackoff(attempt, rng);
}

/**
 * Decide whether a thrown `fetch()` error is retryable.
 *
 * Retryable: a `TypeError` (network failure / DNS / connection reset) or the
 * wrapper's own `AbortSignal.timeout()` abort (`DOMException` named
 * `TimeoutError`). NOT retryable: an abort that came from a caller-supplied
 * signal — explicit cancellation is respected, never retried.
 */
export function isRetryableFetchError(
  err: unknown,
  userSignal: AbortSignal | null | undefined,
): boolean {
  // A caller-supplied signal means any abort is the caller's intent — don't retry.
  if (userSignal) return false;
  if (err instanceof TypeError) return true;
  if (
    typeof DOMException !== "undefined" &&
    err instanceof DOMException &&
    err.name === "TimeoutError"
  ) {
    return true;
  }
  // Some runtimes throw a plain object/Error with name "TimeoutError".
  if (
    err != null &&
    typeof err === "object" &&
    (err as { name?: unknown }).name === "TimeoutError"
  ) {
    return true;
  }
  return false;
}

/**
 * Options controlling a retry loop. `rng`/`sleep` are injectable for tests.
 */
export interface RetryConfig {
  maxRetries: number;
  rng?: Rng;
  sleep?: Sleep;
}

/**
 * Sleep for the resolved backoff/`Retry-After` delay before the next attempt.
 */
export async function sleepBackoff(
  attempt: number,
  retryAfter: string | null | undefined,
  cfg: RetryConfig,
): Promise<void> {
  const delay = resolveDelay(attempt, retryAfter, cfg.rng ?? Math.random);
  await (cfg.sleep ?? defaultSleep)(delay);
}
