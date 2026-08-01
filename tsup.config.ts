import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/presets.ts",
    "src/_generated/index.ts",
    "src/_generated/sdk.gen.ts",
    "src/_generated/types.gen.ts",
    "src/_generated/client.gen.ts",
  ],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: false,
  target: "es2022",
  // splitting: true is required because three of our entries
  // (src/index.ts, src/_generated/sdk.gen.ts, src/_generated/client.gen.ts)
  // transitively import the same hey-api client singleton. With splitting
  // disabled, tsup inlines a separate copy per bundle — `new CrawlerClient()`
  // then configures one copy while
  //   import { searchKev } from "@crimson-crawler/crimson-crawler-client/_generated/sdk.gen"
  // calls a different, unconfigured copy. Result: silent fetches with no
  // apikey/baseUrl that never reach the server. Splitting hoists the
  // singleton into a shared chunk so all entries share one instance.
  splitting: true,
  treeshake: true,
  // Mark @hey-api/client-fetch external so consumers who depend on it
  // directly don't end up with two copies of the singleton in their bundle
  // (one from us, one from theirs). Same singleton-duplication footgun
  // class as the splitting-false bug above, at a cross-package boundary.
  external: ["@hey-api/client-fetch"],
});
