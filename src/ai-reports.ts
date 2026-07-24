/**
 * Report Generator API — key-authed access to the Report Generator.
 *
 * Its own section at `/ai-reports/*` generates and manages grounded,
 * cite-or-refuse intelligence reports from saved enrichments, inputs, and prior reports.
 * A report is built by picking a TEMPLATE + source artifacts, creating a DRAFT (the scaffold + a
 * list of AI sections to fill), then filling each AI section (a grounded LLM call). The
 * `generateReport` convenience runs the whole create → fill-all → fetch flow in one call.
 *
 * Same API key, same base URL, same retry/timeout fetch as every other call — **Report Generator calls
 * never count toward your API usage** (including the LLM generation). Reports are stored as
 * `kind=report` artifacts (`format='html_report'`); browser-authored ProseMirror reports export
 * PDF/DOCX/MD only from the editor, but API-generated HTML reports export as `html` or `md` here.
 *
 * Exposed as `client.aiReports` (mirrors the Python `AiReportsAPI`).
 */

import { UnexpectedStatus } from "./exceptions";
import { pathSegment } from "./url";

/** A fetch-like function — the CrawlerClient hands in its retry/timeout wrapper. */
export type AiReportsFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Client for the key-authed Report Generator API.
 *
 * Obtained via `client.aiReports` — never constructed directly.
 * Every method throws `UnexpectedStatus` on a non-2xx response.
 */
export class AiReportsApi {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly doFetch: AiReportsFetch;

  constructor(baseUrl: string, apiKey: string, doFetch: AiReportsFetch) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.doFetch = doFetch;
  }

  private async request(
    method: string,
    path: string,
    opts: { params?: Record<string, string>; json?: unknown } = {},
  ): Promise<Response> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(opts.params ?? {})) url.searchParams.set(k, v);
    const resp = await this.doFetch(url, {
      method,
      headers: {
        apikey: this.apiKey,
        ...(opts.json !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(opts.json !== undefined ? { body: JSON.stringify(opts.json) } : {}),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new UnexpectedStatus(resp.status, body, `Report Generator API ${resp.status} on ${path}`);
    }
    return resp;
  }

  // -- Discovery + templates --------------------------------------------- //

  /** `GET /ai-reports` — the self-documenting endpoint map + your account context. */
  async discovery(): Promise<Record<string, unknown>> {
    return (await (await this.request("GET", "/ai-reports")).json()) as Record<string, unknown>;
  }

  /** The built-in report templates — each `{id, name, description?, ai_sections:[{section_type, label}], needs?}`. */
  async listTemplates(): Promise<Record<string, unknown>[]> {
    const data = (await (await this.request("GET", "/ai-reports/templates")).json()) as { templates: Record<string, unknown>[] };
    return data.templates;
  }

  // -- Reports ----------------------------------------------------------- //

  /** Your saved reports (newest first, no content) — `kind=report` artifacts. */
  async listReports(): Promise<Record<string, unknown>[]> {
    const data = (await (await this.request("GET", "/ai-reports/reports")).json()) as { reports: Record<string, unknown>[] };
    return data.reports;
  }

  /** One report in full, including inline `content` (the report HTML). */
  async getReport(reportId: string): Promise<Record<string, unknown>> {
    const data = (await (await this.request("GET", `/ai-reports/reports/${pathSegment(reportId)}`)).json()) as { report: Record<string, unknown> };
    return data.report;
  }

  /** Stream a report's HTML as the raw body. Resolves `{ content, id, kind, name, format, createdAt }`. */
  async getReportRaw(reportId: string): Promise<Record<string, unknown>> {
    const resp = await this.request("GET", `/ai-reports/reports/${pathSegment(reportId)}`, { params: { raw: "1" } });
    return {
      content: await resp.text(),
      id: resp.headers.get("x-artifact-id") ?? reportId,
      kind: resp.headers.get("x-artifact-kind") ?? "",
      name: resp.headers.get("x-artifact-name") ?? "",
      format: resp.headers.get("x-artifact-format") ?? "",
      createdAt: resp.headers.get("x-artifact-created") ?? "",
    };
  }

  /**
   * Create a DRAFT report from a template + source artifacts. Renders the scaffold (static +
   * deterministic data sections) and returns the list of AI sections still to fill.
   *
   * Resolves `{ id, name, html, ai_sections: [{section_type, label, ...}], skipped: [...] }`.
   */
  async createDraft(
    template: string,
    options: { sourceIds?: string[]; name?: string } = {},
  ): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = { template };
    if (options.sourceIds !== undefined) body.source_ids = options.sourceIds;
    if (options.name !== undefined) body.name = options.name;
    return (await (await this.request("POST", "/ai-reports/reports", { json: body })).json()) as Record<string, unknown>;
  }

  /**
   * Generate ONE grounded AI section of a draft (omit `sectionType` to fill the next pending one).
   * Resolves `{ section_type, filled, truncated, remaining: [...], complete }`. Throws
   * `UnexpectedStatus` (409) when no sections remain or (502) on a copilot failure.
   */
  async fillSection(reportId: string, sectionType?: string): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {};
    if (sectionType !== undefined) body.section_type = sectionType;
    return (await (await this.request("POST", `/ai-reports/reports/${pathSegment(reportId)}/sections`, { json: body })).json()) as Record<string, unknown>;
  }

  /** Rename a report. Resolves the updated report. */
  async renameReport(reportId: string, name: string): Promise<Record<string, unknown>> {
    const data = (await (await this.request("PATCH", `/ai-reports/reports/${pathSegment(reportId)}`, { json: { name } })).json()) as { report: Record<string, unknown> };
    return data.report;
  }

  /** Delete a report. Resolves `true` on success (404 throws). */
  async deleteReport(reportId: string): Promise<boolean> {
    const resp = await this.request("DELETE", `/ai-reports/reports/${pathSegment(reportId)}`);
    const data = (await resp.json()) as { deleted?: boolean };
    return Boolean(data.deleted);
  }

  /**
   * Generate a single grounded section ad-hoc (NOT tied to a stored report) from `sourceIds`.
   * Provide `sectionType` (a template section) and/or a free-text `instruction`. Resolves
   * `{ text, truncated, grounded, unsupported_ids }`.
   */
  async section(
    sourceIds: string[],
    options: {
      sectionType?: string;
      instruction?: string;
      selection?: string;
      verbosity?: "concise" | "standard" | "detailed";
    } = {},
  ): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = { source_ids: sourceIds };
    if (options.sectionType !== undefined) body.section_type = options.sectionType;
    if (options.instruction !== undefined) body.instruction = options.instruction;
    if (options.selection !== undefined) body.selection = options.selection;
    if (options.verbosity !== undefined) body.verbosity = options.verbosity;
    return (await (await this.request("POST", "/ai-reports/section", { json: body })).json()) as Record<string, unknown>;
  }

  /**
   * Export a report as `html` or `md`. The body IS the export file.
   *
   * Resolves `{ content, bytes, filename, contentType }` — filename comes from `Content-Disposition`.
   * (PDF/DOCX are browser-editor-only; ProseMirror reports authored in the browser throw 422 here.)
   */
  async exportReport(reportId: string, fmt: "html" | "md" = "html"): Promise<Record<string, unknown>> {
    const resp = await this.request("GET", `/ai-reports/reports/${pathSegment(reportId)}/export/${pathSegment(fmt)}`);
    const disposition = resp.headers.get("content-disposition") ?? "";
    const match = disposition.match(/filename="([^"]+)"/);
    const filename = match ? match[1] : `${reportId}.${fmt}`;
    const bytes = new Uint8Array(await resp.arrayBuffer());
    return {
      content: new TextDecoder().decode(bytes),
      bytes,
      filename,
      contentType: resp.headers.get("content-type") ?? "",
    };
  }

  /**
   * Generate a report end-to-end: create the draft, fill every AI section, return the finished
   * report. The convenience over `createDraft` + `fillSection`.
   *
   * If a section's copilot call fails (502), generation stops there and returns what filled so far:
   * the report keeps the sections completed before the failure, the failed section is recorded in
   * `sections` as `{ error: "generation failed", status: 502 }`, and that section plus any after it
   * stay unfilled cards. Re-run `generateReport` or fill the rest individually with `fillSection`.
   *
   * Resolves `{ report, sections: [<fill result per section>], skipped: [...] }`.
   */
  async generateReport(
    template: string,
    options: { sourceIds?: string[]; name?: string } = {},
  ): Promise<Record<string, unknown>> {
    const draft = await this.createDraft(template, options);
    const reportId = String(draft.id);
    const pending = Array.isArray(draft.ai_sections) ? draft.ai_sections : [];
    const sections: Record<string, unknown>[] = [];
    // One fill per pending AI section (each call fills the next pending one); zero sections → no
    // fills, straight to the finished report. The complete/409/502 checks below stop early.
    for (let i = 0; i < pending.length; i++) {
      let result: Record<string, unknown>;
      try {
        result = await this.fillSection(reportId);
      } catch (err) {
        if (err instanceof UnexpectedStatus && err.status === 409) break; // nothing left to fill
        if (err instanceof UnexpectedStatus && err.status === 502) {
          sections.push({ error: "generation failed", status: 502 });
          break;
        }
        throw err;
      }
      sections.push(result);
      if (result.complete) break;
    }
    const report = await this.getReport(reportId);
    return { report, sections, skipped: draft.skipped ?? [] };
  }
}
