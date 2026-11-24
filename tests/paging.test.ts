import { describe, expect, it, vi } from "vitest";

import { UnexpectedStatus } from "../src/exceptions";
import { collectSnapshotPages } from "../src/paging";

type Row = { snapshot_id?: string | null; next: number | null; id?: string };

describe("snapshot paging", () => {
  it("restarts an expired walk without returning its old pages", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ snapshot_id: "old", next: 1, id: "old-only" })
      .mockRejectedValueOnce(
        new UnexpectedStatus(409, { detail: { error: "snapshot_expired" } }),
      )
      .mockResolvedValueOnce({ snapshot_id: "new", next: 1, id: "new-first" })
      .mockResolvedValueOnce({
        snapshot_id: "new",
        next: null,
        id: "new-second",
      });
    const pages = await collectSnapshotPages<Row>(fetch, (page) => page.next);
    expect(pages.map((page) => page.id)).toEqual(["new-first", "new-second"]);
    expect(fetch.mock.calls).toEqual([
      [0, undefined],
      [1, "old"],
      [0, undefined],
      [1, "new"],
    ]);
  });

  it("fails after a second expiry without returning partial pages", async () => {
    const expired = new UnexpectedStatus(409, {
      detail: { error: "snapshot_expired" },
    });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ snapshot_id: "old", next: 1 })
      .mockRejectedValueOnce(expired)
      .mockResolvedValueOnce({ snapshot_id: "new", next: 1 })
      .mockRejectedValueOnce(expired);
    await expect(
      collectSnapshotPages<Row>(fetch, (page) => page.next),
    ).rejects.toBe(expired);
  });

  it("returns a single page without a snapshot", async () => {
    const fetch = vi.fn().mockResolvedValue({ next: null, id: "only" });
    const pages = await collectSnapshotPages<Row>(fetch, (page) => page.next);
    expect(pages.map((page) => page.id)).toEqual(["only"]);
  });

  it("rejects a next page without a snapshot", async () => {
    const fetch = vi.fn().mockResolvedValue({ next: 1 });
    await expect(
      collectSnapshotPages<Row>(fetch, (page) => page.next),
    ).rejects.toThrow("invalid snapshot identifier");
  });

  it("rejects a non-string snapshot identifier", async () => {
    const fetch = vi.fn().mockResolvedValue({ snapshot_id: 123, next: null });
    await expect(
      collectSnapshotPages<Row>(fetch, (page) => page.next),
    ).rejects.toThrow("invalid snapshot identifier");
  });
});
