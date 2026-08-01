/** Encode one caller-provided URL path segment. */
export function pathSegment(value: string): string {
  return encodeURIComponent(value);
}
