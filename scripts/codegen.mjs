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

// `--snapshot-only` was accepted by every caller (both exported workflows,
// build-clients.sh, the README) but never read, so a typo or an unsupported flag
// passed silently and a reader could reasonably assume omitting it selected some
// other mode. There is no other mode: this script only ever reads the committed
// snapshot, which is what keeps public codegen from needing the private server.
// Validate the argument list so the contract is enforced rather than implied.
const SUPPORTED_FLAGS = new Set(["--snapshot-only"]);
const unsupported = process.argv.slice(2).filter((arg) => !SUPPORTED_FLAGS.has(arg));
if (unsupported.length > 0) {
  console.error(
    `codegen: unsupported argument(s): ${unsupported.join(", ")}\n` +
    `Supported: ${[...SUPPORTED_FLAGS].join(", ")} (a no-op -- snapshot-only is the only mode).`,
  );
  process.exit(2);
}

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
