/**
 * Crimson Crawler API client.
 *
 * Typed TypeScript wrapper for the Crimson Crawler v1 API. Built on top of an
 * `@hey-api/openapi-ts` codegen layer; adds API-key authentication, sensible
 * defaults, and convenience methods for the most common enrichment chains.
 */

export {
  BASE_URL,
  CrawlerClient,
  DEFAULT_TIMEOUT_MS,
  ENV_API_KEY,
  ENV_BASE_URL,
  ENV_VERIFY_SSL,
  type CrawlerClientOptions,
} from "./client";
export {
  CrawlerClientError,
  MissingCredentials,
  UnexpectedStatus,
} from "./exceptions";
export * as presets from "./presets";
export {
  ArtifactManagerApi,
  type ArtifactManagerArtifact,
  type ArtifactManagerExport,
  type ArtifactManagerFolder,
  type ArtifactManagerRating,
  type ArtifactManagerRawArtifact,
} from "./artifact-manager";
export {
  InventoryManagerApi,
  type AttachmentOmission,
  type InventoryOptions,
} from "./inventory-manager";
export { assembleBriefing, ingestScan } from "./ingest";
export { EnricherApi } from "./enricher";
export { AiReportsApi } from "./ai-reports";

// Read version from package.json so it stays single-sourced. tsup inlines
// this at build time via `with { type: "json" }`. Source consumers fall back
// to "0.0.0+unknown" if they import outside a packaged install.
import pkg from "../package.json" with { type: "json" };

export const __version__ =
  (pkg as { version?: string }).version ?? "0.0.0+unknown";
