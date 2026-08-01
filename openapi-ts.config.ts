import { defineConfig } from "@hey-api/openapi-ts";

/**
 * Hey API codegen config for the Crimson Crawler API TypeScript client.
 *
 * Run via:  npm run codegen
 *
 * The generated package lands at src/_generated/. That directory is
 * gitignored — it is regenerated on every build. The single source of
 * truth for the API surface is openapi.snapshot.json at the repo root.
 */
export default defineConfig({
  input: process.env.OPENAPI_SCHEMA_PATH || "openapi.snapshot.json",
  output: {
    path: "src/_generated",
  },
  plugins: ["@hey-api/typescript", "@hey-api/sdk", "@hey-api/client-fetch"],
});
