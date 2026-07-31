// Point the packed README's brand images at absolute URLs, then put the file back.
//
// The README in the repository references the art the tree ships (`assets/...`) so the repository
// renders its own header with nothing deployed. npmjs.com renders that same README standalone with no
// repository to resolve a relative path against, and it does not rewrite them -- so a packed README
// with relative paths shows broken images on the package page.
//
// The Python packages solve this through hatchling metadata, which never touches the file. npm has no
// equivalent: it always packs README.md off disk. So this swaps the file for the duration of the pack
// and restores it afterwards. `--apply` runs from `prepack`, `--restore` from `postpack`.
//
// Both directions are idempotent, and `--apply` restores a leftover backup first, so an interrupted
// pack cannot leave a rewritten README behind.

import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const README = resolve(PACKAGE_ROOT, "README.md");
// Deliberately NOT named README*: npm always packs every README* file regardless of the `files`
// allowlist, so a `README.md.bak` would ship inside the tarball.
const BACKUP = resolve(PACKAGE_ROOT, ".readme-brand.bak");

// relative path in the repository -> absolute URL for the packed copy
const BRAND_URLS = {
  'src="assets/spider.png"': 'src="https://crimsoncrawler.com/logo-icon.png"',
  'src="assets/crimson-crawler-logo.svg"':
    'src="https://crimsoncrawler.com/crimson-crawler-logo-typescript.svg"',
};

export function rewrite(text) {
  return Object.entries(BRAND_URLS).reduce(
    (acc, [relative, absolute]) => acc.replaceAll(relative, absolute),
    text,
  );
}

function restore() {
  if (!existsSync(BACKUP)) return false;
  renameSync(BACKUP, README);
  return true;
}

const mode = process.argv[2];

if (mode === "--apply") {
  // Recover from an interrupted earlier pack before taking a fresh backup.
  if (restore()) console.log("readme-for-pack: restored a leftover backup first");
  const original = readFileSync(README, "utf-8");
  const packed = rewrite(original);
  if (packed === original) {
    console.log("readme-for-pack: no relative brand paths to rewrite");
  } else {
    copyFileSync(README, BACKUP);
    writeFileSync(README, packed, "utf-8");
    console.log("readme-for-pack: brand images rewritten to absolute URLs for packing");
  }
} else if (mode === "--restore") {
  console.log(
    restore()
      ? "readme-for-pack: README.md restored to its shipped-asset paths"
      : "readme-for-pack: nothing to restore",
  );
} else {
  console.error("usage: readme-for-pack.mjs --apply | --restore");
  process.exit(2);
}
