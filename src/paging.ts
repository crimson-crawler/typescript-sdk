import { UnexpectedStatus } from "./exceptions";

type SnapshotPage = {
  snapshot_id?: string | null;
};

function snapshotExpired(error: unknown): boolean {
  if (!(error instanceof UnexpectedStatus) || error.status !== 409)
    return false;
  let body: unknown = error.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body) as unknown;
    } catch {
      return false;
    }
  }
  if (!body || typeof body !== "object") return false;
  const value = body as { error?: unknown; detail?: { error?: unknown } };
  return (
    value.error === "snapshot_expired" ||
    value.detail?.error === "snapshot_expired"
  );
}

export async function collectSnapshotPages<T extends SnapshotPage>(
  fetch: (offset: number, snapshotId: string | undefined) => Promise<T>,
  nextOffset: (page: T) => number | null | undefined,
): Promise<T[]> {
  for (let attempt = 0; ; attempt++) {
    const pages: T[] = [];
    let offset = 0;
    let snapshotId: string | undefined;
    try {
      for (;;) {
        const page = await fetch(offset, snapshotId);
        const current = page.snapshot_id ?? undefined;
        const next = nextOffset(page);
        if (
          (current !== undefined &&
            (typeof current !== "string" || !current)) ||
          (snapshotId !== undefined && current !== snapshotId) ||
          (next != null && current === undefined)
        ) {
          throw new Error("Enrichment returned an invalid snapshot identifier");
        }
        snapshotId = current;
        pages.push(page);
        if (next == null) return pages;
        if (!Number.isInteger(next) || next <= offset) {
          throw new Error("Enrichment returned an invalid next offset");
        }
        offset = next;
      }
    } catch (error) {
      if (attempt === 0 && snapshotExpired(error)) continue;
      throw error;
    }
  }
}

type OsvPage = {
  osv_snapshot_id?: string | null;
  osv_next_offset?: number | null;
  errors?: { service?: string; error?: string }[] | null;
};

/**
 * Stream one OSV advisory walk without an aggregate buffer. A changed or expired snapshot
 * rejects (409 `snapshot_expired` as `UnexpectedStatus`) instead of restarting, because earlier
 * pages were already yielded. Follow `osv_next_offset`; byte limits shorten pages, and page zero
 * may legitimately return `0` when the non-OSV sections used the whole budget.
 */
export async function* iterOsvPages<T extends OsvPage>(
  fetch: (offset: number, snapshotId: string | undefined) => Promise<T>,
): AsyncGenerator<T> {
  let offset = 0;
  let snapshotId: string | undefined;
  for (;;) {
    const page = await fetch(offset, snapshotId);
    if (
      snapshotId !== undefined &&
      page.errors?.some(
        (error) =>
          error.service === "osv" && error.error === "stored_copy_unavailable",
      )
    ) {
      throw new Error("stored_copy_unavailable");
    }
    const current = page.osv_snapshot_id ?? undefined;
    const next = page.osv_next_offset;
    if (
      (current !== undefined && (typeof current !== "string" || !current)) ||
      (current !== undefined &&
        snapshotId !== undefined &&
        current !== snapshotId)
    ) {
      throw new Error("Enrichment returned an invalid OSV snapshot identifier");
    }
    if (next != null) {
      if (
        current === undefined ||
        !Number.isInteger(next) ||
        next < 0 ||
        (snapshotId !== undefined && next <= offset)
      ) {
        throw new Error("Enrichment returned an invalid OSV continuation");
      }
    }
    yield page;
    if (next == null) return;
    offset = next;
    snapshotId = current;
  }
}
