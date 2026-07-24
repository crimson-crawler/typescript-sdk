// Regenerate the TypeScript client from openapi.snapshot.json.
//
// Monorepo builds compare the committed snapshot with the live FastAPI schema
// before generation. Public source exports pass --snapshot-only because v1_api
// is intentionally absent.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CLIENT_TS_DIR = resolve(SCRIPT_DIR, "..");
const MONOREPO_ROOT = resolve(CLIENT_TS_DIR, "..");
const REPO_ROOT = existsSync(resolve(MONOREPO_ROOT, "openapi.snapshot.json"))
  ? MONOREPO_ROOT
  : CLIENT_TS_DIR;
const SCHEMA_PATH = resolve("/tmp", "crimson-crawler-openapi.json");
const SNAPSHOT_PATH = resolve(REPO_ROOT, "openapi.snapshot.json");
const GENERATED_DIR = resolve(CLIENT_TS_DIR, "src", "_generated");

function parseArgs(args) {
  if (args.length === 0) {
    return { snapshotOnly: false };
  }
  if (args.length === 1 && args[0] === "--snapshot-only") {
    return { snapshotOnly: true };
  }
  console.error(`Usage: node scripts/codegen.mjs [--snapshot-only]`);
  process.exit(2);
}

function dumpLiveSchema() {
  const out = execFileSync(
    "uv",
    [
      "run",
      "python",
      "-c",
      "import json, sys; sys.path.insert(0, '.'); from v1_api.main import app; " +
      "print(json.dumps(app.openapi(), indent=2, sort_keys=True))",
    ],
    { cwd: REPO_ROOT, encoding: "utf-8" },
  );
  mkdirSync(dirname(SCHEMA_PATH), { recursive: true });
  writeFileSync(SCHEMA_PATH, out);
}

function checkSnapshotMatches() {
  if (!existsSync(SNAPSHOT_PATH)) {
    console.error(
      `Snapshot ${SNAPSHOT_PATH} is missing. ` +
      "Regenerate it from the live server schema.",
    );
    process.exit(1);
  }
  // Parse-then-compare so drift only fires on real schema differences,
  // not formatting drift (key ordering, indent, trailing newline). Uses
  // Node's deep-equal for structural comparison.
  const snap = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf-8"));
  const live = JSON.parse(readFileSync(SCHEMA_PATH, "utf-8"));
  if (!isDeepStrictEqual(snap, live)) {
    console.error(
      "API surface drift: openapi.snapshot.json does not match the live FastAPI app.\n" +
      "Refresh the snapshot AND both generated clients from the live schema,\n" +
      "then commit the snapshot diff.",
    );
    process.exit(1);
  }
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

const { snapshotOnly } = parseArgs(process.argv.slice(2));
if (!existsSync(SNAPSHOT_PATH)) {
  console.error(`Snapshot ${SNAPSHOT_PATH} is missing.`);
  process.exit(1);
}

if (snapshotOnly) {
  runCodegen(SNAPSHOT_PATH);
} else {
  dumpLiveSchema();
  checkSnapshotMatches();
  runCodegen(SCHEMA_PATH);
}
