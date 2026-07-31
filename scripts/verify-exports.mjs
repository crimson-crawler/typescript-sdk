import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = resolve(packageRoot, "dist");
const manifestPath = resolve(distRoot, ".package-build.json");
const packageJson = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));

function collectTargets(value, targets = new Set()) {
  if (typeof value === "string") {
    targets.add(value);
  } else if (value && typeof value === "object") {
    for (const child of Object.values(value)) collectTargets(child, targets);
  }
  return targets;
}

async function collectFiles(path) {
  const entries = await readdir(path, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

const exportTargets = [...collectTargets(packageJson.exports)].sort();
if (exportTargets.length === 0) throw new Error("package.json declares no export targets");

for (const target of exportTargets) {
  const absoluteTarget = resolve(packageRoot, target);
  const relativeTarget = relative(distRoot, absoluteTarget);
  if (
    !target.startsWith("./dist/") ||
    relativeTarget === ".." ||
    relativeTarget.startsWith(`..${sep}`) ||
    isAbsolute(relativeTarget)
  ) {
    throw new Error(`export target must stay inside dist: ${target}`);
  }
  try {
    await readFile(absoluteTarget);
  } catch {
    throw new Error(`missing export target ${target}; run npm run build before packing`);
  }
}

const buildInputs = [
  ...await collectFiles(resolve(packageRoot, "src")),
  resolve(packageRoot, "package.json"),
  resolve(packageRoot, "package-lock.json"),
  resolve(packageRoot, "tsconfig.json"),
  resolve(packageRoot, "tsup.config.ts"),
].sort();
const hash = createHash("sha256");
for (const input of buildInputs) {
  hash.update(relative(packageRoot, input));
  hash.update("\0");
  hash.update(await readFile(input));
  hash.update("\0");
}
const fingerprint = hash.digest("hex");

if (process.argv.includes("--record")) {
  await writeFile(manifestPath, `${JSON.stringify({ exportTargets, fingerprint }, null, 2)}\n`);
} else {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    throw new Error("missing dist/.package-build.json; run npm run build before packing");
  }
  if (manifest.fingerprint !== fingerprint) {
    throw new Error("dist is stale for the current package sources; run npm run build before packing");
  }
  if (JSON.stringify(manifest.exportTargets) !== JSON.stringify(exportTargets)) {
    throw new Error("dist was built for a different exports map; run npm run build before packing");
  }
}
