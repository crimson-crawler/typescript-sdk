/**
 * Per-request API-key injection for the Crimson Crawler client.
 *
 * The generated Hey API client takes `headers` on its config and turns them
 * into a WHATWG `Headers` instance it keeps for the lifetime of the client.
 * That object is reachable — `client.api.getConfig().headers` — and unlike
 * httpx, `Headers` has no redaction at all: `util.inspect(headers, { depth:
 * null })` prints every value, so a config carrying `apikey` disclosed the live
 * key. `JSON.stringify` happens to hide it (a `Headers` instance serializes to
 * `{}`), which is exactly why the earlier audit of this file came back clean —
 * the probe used `JSON.stringify` and never inspected the container.
 *
 * So the key is not put on the client config at all. `CrawlerClient` closes
 * over it and this helper stamps it onto each outgoing request instead, which
 * keeps it out of every reachable object while every request still carries it.
 *
 * The Python SDK carries the same guarantee through its own
 * `crimson_crawler_client/_auth.py`; the two move together, so a change to how
 * the credential is stored or printed lands on both surfaces or neither.
 */

/**
 * Build the outgoing headers for a request, attaching the API key only when the
 * request targets `origin`.
 *
 * `fetch(request, init)` lets `init` *replace* the request's fields rather than
 * merge them, so the caller's own headers are read off whichever source is
 * authoritative and copied before the key is set.
 *
 * The origin check mirrors `ApiKeyAuth` in the Python SDK. `client.api` is a
 * documented escape hatch and its config exposes this very `fetch`, so a caller
 * can invoke it with an absolute URL for another host — without the check, that
 * request carried the credential.
 *
 * It does **not** cover redirects, and neither does the Python side: the runtime
 * copies headers onto a redirected request and this function does not run again.
 * What protects us there is `redirect: "manual"` in `retryFetch` (the Python
 * equivalent is `follow_redirects=False`). Don't switch either on without
 * stripping the header when the origin changes.
 *
 * A URL that will not parse as absolute is treated as same-origin: the generated
 * client always builds absolute URLs from `baseUrl`, so a relative one can only
 * be resolved against our own origin anyway.
 */
export function withApiKeyHeader(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  headerName: string,
  apiKey: string,
  origin: string,
): Headers {
  const inherited =
    init?.headers ?? (input instanceof Request ? input.headers : undefined);
  const headers = new Headers(inherited);

  const raw =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input instanceof Request
          ? input.url
          : String(input);
  let sameOrigin: boolean;
  try {
    sameOrigin = new URL(raw).origin === origin;
  } catch {
    sameOrigin = true;
  }

  if (sameOrigin) {
    headers.set(headerName, apiKey);
  }
  return headers;
}
