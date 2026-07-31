// Regenerate the TypeScript client from the committed openapi.snapshot.json.
//
// The snapshot ships with the source export, so regeneration never imports the
// private server package.

import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CLIENT_TS_DIR = resolve(SCRIPT_DIR, "..");
// The snapshot sits beside the package in a public source export, and one level up in a
// development checkout. Both are checked because `npm run codegen` runs with this package
// as the working directory in either layout.
const SNAPSHOT_CANDIDATES = [
  resolve(CLIENT_TS_DIR, "openapi.snapshot.json"),
  resolve(CLIENT_TS_DIR, "..", "openapi.snapshot.json"),
];
const SNAPSHOT_PATH = SNAPSHOT_CANDIDATES.find((candidate) => existsSync(candidate));
const GENERATED_DIR = resolve(CLIENT_TS_DIR, "src", "_generated");

function runCodegen(schemaPath) {
  if (existsSync(GENERATED_DIR)) {
    rmSync(GENERATED_DIR, { recursive: true, force: true });
  }
  execFileSync("npx", ["--no-install", "@hey-api/openapi-ts"], {
    cwd: CLIENT_TS_DIR,
    stdio: "inherit",
    env: { ...process.env, OPENAPI_SCHEMA_PATH: schemaPath },
  });
  console.log(`Generated client → ${GENERATED_DIR}`);
}

if (!SNAPSHOT_PATH) {
  console.error(`No openapi.snapshot.json found. Looked in:\n  ${SNAPSHOT_CANDIDATES.join("\n  ")}`);
  process.exit(1);
}

runCodegen(SNAPSHOT_PATH);
