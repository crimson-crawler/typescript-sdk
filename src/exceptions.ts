/**
 * Exception types for the Crimson Crawler client.
 *
 * Callers should catch `CrawlerClientError` to handle any client-raised
 * problem.
 */

export class CrawlerClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CrawlerClientError";
  }
}

export class MissingCredentials extends CrawlerClientError {
  constructor(message: string) {
    super(message);
    this.name = "MissingCredentials";
  }
}

/**
 * Raised when the server returns a non-success status that the wrapper
 * surfaces as an error rather than letting it pass through silently.
 *
 * Wraps the underlying response so callers can inspect status + body.
 */
export class UnexpectedStatus extends CrawlerClientError {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    message?: string,
  ) {
    super(message ?? `Unexpected response status ${status}`);
    this.name = "UnexpectedStatus";
  }
}
