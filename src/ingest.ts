/**
 * Scan → briefing ingest — the TypeScript SDK's copy of the **ingest component**.
 *
 * One ingest file per client, kept logically IDENTICAL across them so the scan→briefing workflow reads the
 * same everywhere: this TS SDK copy, the Python SDK's `ingest.py`, the CLI's `ingest.py`, and the MCP's
 * `ingest.py` (same logic over its own transport + a bounded poll). `InventoryManagerApi.ingestScan`
 * delegates here, using the SDK's `parseScan` + `enrichItems`.
 *
 *   • `assembleBriefing` — PURE (no I/O): turns a `/v1/inventory-enrich` result into a briefing by attaching a
 *     top-N KEV-first `recommended_actions` list (the engine already ranks per-asset findings).
 *   • `ingestScan` — the orchestration: parse the scan (usage-exempt) → enrich the assets (one billable
 *     `/v1/inventory-enrich` submit) → assemble. Takes the live `InventoryManagerApi` and uses its
 *     `parseScan` + `enrichItems`, so the HTTP/key/retry transport stays in the SDK client.
 */
import type { ProgressCallback } from "./_poll";
import type { InventoryManagerApi } from "./inventory-manager";

/** Turn a `/v1/inventory-enrich` result into a scan **briefing** — the engine already ranks per-asset
 *  findings KEV-first, so this just attaches a top-N `recommended_actions` list (highest-priority CVEs
 *  across all assets, KEV first then weaponization, deduped). Mirrors the Python `assemble_briefing`. Pure. */
export function assembleBriefing(
  report: Record<string, unknown>,
  meta: {
    format: string;
    parsedCount: number;
    truncated: unknown;
    enrichmentId: unknown;
  },
): Record<string, unknown> {
  const seen = new Map<string, Record<string, unknown>>();
  const assets = Array.isArray(report.assets)
    ? (report.assets as Record<string, unknown>[])
    : [];
  for (const asset of assets) {
    const product = (asset.product as string) || (asset.name as string) || "—";
    const cves = Array.isArray(asset.top_cves)
      ? (asset.top_cves as Record<string, unknown>[])
      : [];
    for (const cve of cves) {
      const cid = cve.cve_id as string | undefined;
      if (!cid) continue;
      const weap = (cve.weaponization_score as number) || 0;
      const prev = seen.get(cid);
      if (!prev || weap > ((prev.weaponization_score as number) || 0)) {
        seen.set(cid, {
          cve_id: cid,
          product,
          weaponization_score: weap,
          kev: Boolean(cve.kev),
          reason: cve.kev ? "KEV-listed — patch now" : "High weaponization",
        });
      }
    }
  }
  const actions = [...seen.values()]
    .sort(
      (a, b) =>
        (a.kev ? 0 : 1) - (b.kev ? 0 : 1) ||
        ((b.weaponization_score as number) || 0) -
          ((a.weaponization_score as number) || 0),
    )
    .slice(0, 10);
  const out: Record<string, unknown> = {
    format: meta.format,
    parsed_count: meta.parsedCount,
    enrichment_id: meta.enrichmentId,
    report,
    recommended_actions: actions,
  };
  if (meta.truncated) out.truncated = meta.truncated;
  return out;
}

/** Parse a scan FILE (server-side, all 11 formats) → enrich the assets against `/v1/inventory-enrich` →
 *  assemble a briefing. An empty parse short-circuits. Mirrors the Python `ingest_scan`. */
export async function ingestScan(
  invApi: InventoryManagerApi,
  content: string | Uint8Array,
  format: string,
  options: {
    include?: string[];
    pollIntervalMs?: number;
    timeoutMs?: number;
    onProgress?: ProgressCallback;
  } = {},
): Promise<Record<string, unknown>> {
  const parsed = await invApi.parseScan(content, format);
  const items = Array.isArray(parsed.items) ? (parsed.items as unknown[]) : [];
  const fmt = typeof parsed.format === "string" ? parsed.format : format;
  if (items.length === 0)
    return { format: fmt, parsed_count: 0, enrichment_id: null, empty: true };
  const result = await invApi.enrichItems(items, options);
  return assembleBriefing((result.report as Record<string, unknown>) || {}, {
    format: fmt,
    parsedCount: items.length,
    truncated: parsed.truncated,
    enrichmentId: result.enrichment_id,
  });
}
