#!/usr/bin/env python3
"""Validate public client artifacts and sanitized source exports."""

from __future__ import annotations

import argparse
import email.parser
import hashlib
import json
import re
import stat
import sys
import tarfile
import tomllib
import unicodedata
import zipfile
from collections.abc import Iterator
from email.message import Message
from pathlib import Path, PurePosixPath
from typing import NoReturn

ROOT = Path(__file__).resolve().parent.parent
PRIVATE_INTERNAL_MARKER_POLICY = ROOT / ".gitlab/security/public-client-internal-markers.txt"
EXPORTED_INTERNAL_MARKER_POLICY = ROOT / "scripts/public-client-internal-markers.hashed"
INTERNAL_MARKER_POLICY = (
    PRIVATE_INTERNAL_MARKER_POLICY if PRIVATE_INTERNAL_MARKER_POLICY.is_file() else EXPORTED_INTERNAL_MARKER_POLICY
)
CANONICAL_DOCUMENTATION_URLS = {
    "python": "https://crimsoncrawler.com/docs/clients/python-client/",
    "typescript": "https://crimsoncrawler.com/docs/clients/typescript-client/",
    "cli": "https://crimsoncrawler.com/docs/clients/cli/",
    "docs": "https://crimsoncrawler.com/docs/introduction/",
    "mcp": "https://crimsoncrawler.com/docs/clients/mcp/",
}
SECRET_PATTERNS = (
    re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    re.compile(rb"(?i)(?:api[_-]?key|token|password|secret)\s*[=:]\s*['\"][A-Za-z0-9_./+=-]{24,}['\"]"),
)
WORKSTATION_PATH_PATTERNS = (
    re.compile(rb"(?:^|[\s\"'(=])/(?:Users|home)/[^/\s]+/"),
    re.compile(rb"(?i)(?:^|[\s\"'(=])[a-z]:\\Users\\[^\\\s]+\\"),
)
FORBIDDEN_PNG_METADATA_CHUNKS = {b"eXIf", b"iTXt", b"tEXt", b"tIME", b"zTXt"}
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
CANONICAL_BRAND_ASSET_SHA256 = {
    "assets/spider.png": "d25864a14deb269490c01832bc7ed92a6d2134bdaa6b779822b6937cc4324e0c",
    "assets/crimson-crawler-logo.svg": "2febe939d654a1b8d0c078df37bacad3038bf7b7249483cb70fb7fce86b819b8",
}
UNICODE_TEXT_BOMS = (b"\xff\xfe", b"\xfe\xff", b"\xff\xfe\x00\x00", b"\x00\x00\xfe\xff")
FORBIDDEN_ARTIFACT_PARTS = {
    ".env",
    ".git",
    ".npmrc",
    "__pycache__",
    "node_modules",
    "tests",
    "examples",
}


class VerificationError(RuntimeError):
    """Artifact failed a release invariant."""


def fail(message: str) -> NoReturn:
    raise VerificationError(message)


POLICY_SALT_PREFIX = b"crimson-crawler-internal-marker-policy-v1"


def hashed_record(marker: bytes) -> tuple[bytes, int, bytes]:
    """Salted, case-insensitive record for one marker: (salt, byte length, digest)."""
    lowered = marker.lower()
    salt = hashlib.sha256(POLICY_SALT_PREFIX + b":" + lowered).digest()[:16]
    return salt, len(lowered), hashlib.sha256(salt + lowered).digest()


def policy_lines(path: Path) -> tuple[bytes, ...]:
    return tuple(
        line for raw_line in path.read_bytes().splitlines() if (line := raw_line.strip()) and not line.startswith(b"#")
    )


def parse_hashed_records(lines: tuple[bytes, ...]) -> tuple[tuple[bytes, int, bytes], ...]:
    records = []
    for line in lines:
        salt_hex, _, rest = line.partition(b":")
        length_text, _, digest_hex = rest.partition(b":")
        try:
            salt = bytes.fromhex(salt_hex.decode("ascii"))
            length = int(length_text)
            digest = bytes.fromhex(digest_hex.decode("ascii"))
        except (UnicodeDecodeError, ValueError):
            fail("internal marker policy is invalid")
        if not salt or length < 1 or len(digest) != hashlib.sha256().digest_size:
            fail("internal marker policy is invalid")
        records.append((salt, length, digest))
    return tuple(records)


def internal_marker_policy() -> tuple[tuple[bytes, ...], tuple[tuple[bytes, int, bytes], ...]]:
    """Load the marker policy: (plaintext markers, hashed records) — exactly one is populated."""
    if not INTERNAL_MARKER_POLICY.is_file():
        fail("internal marker policy missing")
    lines = policy_lines(INTERNAL_MARKER_POLICY)
    if not lines:
        fail("internal marker policy contains no markers")
    if INTERNAL_MARKER_POLICY.suffix == ".hashed":
        return (), parse_hashed_records(lines)
    return lines, ()


def verify_exported_policy_sync() -> None:
    """Private-side guard: the exported hashed policy must match the private marker list."""
    if not (PRIVATE_INTERNAL_MARKER_POLICY.is_file() and EXPORTED_INTERNAL_MARKER_POLICY.is_file()):
        return
    expected = sorted(hashed_record(marker) for marker in policy_lines(PRIVATE_INTERNAL_MARKER_POLICY))
    actual = sorted(parse_hashed_records(policy_lines(EXPORTED_INTERNAL_MARKER_POLICY)))
    if expected != actual:
        fail("exported internal marker policy is out of sync; run scripts/generate-public-marker-policy.py")


def python_project(path: Path) -> dict:
    with path.open("rb") as stream:
        return tomllib.load(stream)["project"]


def archive_members(path: Path) -> Iterator[tuple[str, bytes]]:
    seen: dict[str, str] = {}

    def validate_name(name: str, *, is_dir: bool) -> None:
        source_name = name[:-1] if is_dir and name.endswith("/") else name
        member_path = PurePosixPath(source_name)
        if (
            not source_name
            or "\0" in source_name
            or "\\" in source_name
            or member_path.is_absolute()
            or any(part in {"", ".", ".."} for part in source_name.split("/"))
        ):
            fail(f"{path}: unsafe archive member {name}")

        key = unicodedata.normalize("NFC", member_path.as_posix()).casefold()
        if previous := seen.get(key):
            fail(f"{path}: duplicate normalized archive member {name} conflicts with {previous}")
        seen[key] = name

    if path.suffix == ".whl":
        with zipfile.ZipFile(path) as archive:
            members = archive.infolist()
            for info in members:
                validate_name(info.filename, is_dir=info.is_dir())
                mode = info.external_attr >> 16
                if stat.S_ISLNK(mode):
                    fail(f"{path}: symlink member {info.filename}")
            bad = archive.testzip()
            if bad:
                fail(f"{path}: corrupt wheel member {bad}")
            for info in members:
                if not info.is_dir():
                    yield info.filename, archive.read(info)
        return

    with tarfile.open(path, "r:gz") as archive:
        members = archive.getmembers()
        for member in members:
            validate_name(member.name, is_dir=member.isdir())
            if not member.isdir() and not member.isfile():
                fail(f"{path}: non-file member {member.name}")
        for member in members:
            if member.isdir():
                continue
            stream = archive.extractfile(member)
            if stream is None:
                fail(f"{path}: unreadable member {member.name}")
            yield member.name, stream.read()


def scan_hashed_markers(location: str, lowered: bytes, records: tuple[tuple[bytes, int, bytes], ...]) -> None:
    by_length: dict[int, list[tuple[bytes, bytes]]] = {}
    for salt, length, digest in records:
        by_length.setdefault(length, []).append((salt, digest))
    sha256 = hashlib.sha256
    for length, entries in by_length.items():
        for offset in range(len(lowered) - length + 1):
            window = lowered[offset : offset + length]
            for salt, digest in entries:
                if sha256(salt + window).digest() == digest:
                    fail(f"{location}: internal-only text present")


def scan_content(location: str, content: bytes) -> None:
    if content.startswith(UNICODE_TEXT_BOMS):
        fail(f"{location}: UTF-16/UTF-32 content is not allowed")
    lowered = content.lower()
    markers, hashed_records = internal_marker_policy()
    for marker in markers:
        if marker.lower() in lowered:
            fail(f"{location}: internal-only text present")
    if hashed_records:
        scan_hashed_markers(location, lowered, hashed_records)
    for pattern in SECRET_PATTERNS:
        if pattern.search(content):
            fail(f"{location}: credential-like value present")
    for pattern in WORKSTATION_PATH_PATTERNS:
        if pattern.search(content):
            fail(f"{location}: absolute workstation path present")


def verify_brand_asset_metadata(directory: Path) -> None:
    png = (directory / "assets/spider.png").read_bytes()
    if not png.startswith(PNG_SIGNATURE):
        fail(f"{directory}: spider.png is not a PNG")
    offset = len(PNG_SIGNATURE)
    saw_end = False
    while offset < len(png):
        if offset + 12 > len(png):
            fail(f"{directory}: spider.png has a malformed chunk")
        length = int.from_bytes(png[offset : offset + 4], "big")
        chunk_type = png[offset + 4 : offset + 8]
        offset += 12 + length
        if offset > len(png):
            fail(f"{directory}: spider.png has a malformed chunk")
        if chunk_type in FORBIDDEN_PNG_METADATA_CHUNKS:
            fail(f"{directory}: forbidden PNG metadata chunk {chunk_type.decode('ascii')}")
        if chunk_type == b"IEND":
            saw_end = True
            break
    if not saw_end or offset != len(png):
        fail(f"{directory}: spider.png has trailing or missing data")

    svg = (directory / "assets/crimson-crawler-logo.svg").read_bytes().lower()
    if b"<metadata" in svg or b"<!--" in svg:
        fail(f"{directory}: forbidden SVG metadata")
    for relative, expected in CANONICAL_BRAND_ASSET_SHA256.items():
        actual = hashlib.sha256((directory / relative).read_bytes()).hexdigest()
        if actual != expected:
            fail(f"{directory}: canonical brand asset content mismatch: {relative}")


def scan_member(artifact: Path, name: str, content: bytes) -> None:
    parts = set(PurePosixPath(name).parts)
    if parts & FORBIDDEN_ARTIFACT_PARTS or name.endswith((".pyc", ".pyo")):
        fail(f"{artifact}: forbidden member {name}")
    if ".gitignore" in parts and not artifact.name.endswith(".tar.gz"):
        fail(f"{artifact}: forbidden member {name}")
    scan_content(f"{artifact}:{name}", content)


def one_artifact(directory: Path, pattern: str) -> Path:
    matches = sorted(directory.glob(pattern))
    if len(matches) != 1:
        fail(f"{directory}: expected one {pattern} artifact, found {len(matches)}")
    return matches[0]


def verify_dist_entries(directory: Path, expected: set[Path]) -> None:
    if directory.is_symlink() or not directory.is_dir():
        fail(f"{directory}: dist must be a real directory")
    entries = set(directory.iterdir())
    if entries != expected:
        names = ", ".join(sorted(path.name for path in entries ^ expected))
        fail(f"{directory}: unexpected or missing dist entries: {names}")
    for path in entries:
        if path.is_symlink() or not path.is_file():
            fail(f"{directory}: dist entry must be a regular file: {path.name}")


def metadata_from_wheel(path: Path) -> Message:
    with zipfile.ZipFile(path) as archive:
        names = [name for name in archive.namelist() if name.endswith(".dist-info/METADATA")]
        if len(names) != 1:
            fail(f"{path}: expected one METADATA file")
        return email.parser.BytesParser().parsebytes(archive.read(names[0]))


def requirement_covers_major(requirement: str, package: str, major: int) -> bool:
    normalized = requirement.replace(" ", "")
    match = re.fullmatch(r"(?P<name>[A-Za-z0-9][A-Za-z0-9._-]*)(?P<specifiers>[<>=!~].*)", normalized)
    if match is None or match.group("name") != package:
        return False
    specifiers = set(match.group("specifiers").split(","))
    return {f">={major}.0", f"<{major + 1}.0"}.issubset(specifiers)


def verify_python_package(directory: Path, expected_name: str, *, cli: bool = False) -> None:
    project = python_project(directory / "pyproject.toml")
    version = project["version"]
    wheel = one_artifact(directory / "dist", f"{expected_name.replace('-', '_')}-{version}-*.whl")
    sdist = one_artifact(directory / "dist", f"{expected_name.replace('-', '_')}-{version}.tar.gz")
    verify_dist_entries(directory / "dist", {wheel, sdist})

    wheel_names: set[str] = set()
    for artifact in (wheel, sdist):
        for name, content in archive_members(artifact):
            scan_member(artifact, name, content)
            if artifact == wheel:
                wheel_names.add(name)

    metadata = metadata_from_wheel(wheel)
    if metadata["Name"] != expected_name or metadata["Version"] != version:
        fail(f"{wheel}: core metadata does not match {expected_name} {version}")
    if metadata["License-Expression"] != "Apache-2.0":
        fail(f"{wheel}: expected Apache-2.0 license expression")
    repository = "https://github.com/crimson-crawler/ccc" if cli else "https://github.com/crimson-crawler/python-sdk"
    if repository not in "\n".join(metadata.get_all("Project-URL", [])):
        fail(f"{wheel}: public repository URL missing")
    if not any(name.endswith("/py.typed") for name in wheel_names):
        fail(f"{wheel}: py.typed marker missing")
    if not any("licenses/LICENSE" in name or name.endswith("/LICENSE") for name in wheel_names):
        fail(f"{wheel}: Apache license file missing")

    normalized = [item.replace(" ", "") for item in metadata.get_all("Requires-Dist", [])]
    if cli:
        dependency_name = "crimson-crawler-client"
        declared = next(
            (item for item in project.get("dependencies", []) if item.startswith(dependency_name)),
            "",
        ).replace(" ", "")
        built = [item for item in normalized if item.startswith(dependency_name)]
        major = int(version.partition(".")[0])
        if (
            len(built) != 1
            or not requirement_covers_major(declared, dependency_name, major)
            or not requirement_covers_major(built[0], dependency_name, major)
        ):
            fail(f"{wheel}: CLI does not require the co-released {major}.x SDK")


def verify_npm_package(directory: Path) -> None:
    manifest = json.loads((directory / "package.json").read_text())
    version = manifest["version"]
    tarball = one_artifact(directory / "dist", f"crimson-crawler-crimson-crawler-client-{version}.tgz")
    verify_dist_entries(directory / "dist", {tarball})
    members = dict(archive_members(tarball))
    for name, content in members.items():
        scan_member(tarball, name, content)
        if name.endswith(".map"):
            fail(f"{tarball}: source map shipped ({name})")

    package = json.loads(members["package/package.json"])
    if package.get("name") != "@crimson-crawler/crimson-crawler-client" or package.get("version") != version:
        fail(f"{tarball}: npm package identity does not match manifest")
    if package["license"] != "Apache-2.0" or package.get("publishConfig", {}).get("access") != "public":
        fail(f"{tarball}: npm license/access is not public Apache-2.0")
    repository = package.get("repository", {})
    if repository.get("url", "").removeprefix("git+") != "https://github.com/crimson-crawler/typescript-sdk.git":
        fail(f"{tarball}: public repository URL missing")
    for lifecycle in ("preinstall", "install", "postinstall", "prepare"):
        if lifecycle in package.get("scripts", {}):
            fail(f"{tarball}: consumer lifecycle hook {lifecycle} is forbidden")
    for export_name, conditions in package["exports"].items():
        for condition, target in conditions.items():
            member = f"package/{target.removeprefix('./')}"
            if member not in members:
                fail(f"{tarball}: export {export_name} {condition} target missing: {target}")
    if "package/LICENSE" not in members:
        fail(f"{tarball}: Apache license file missing")


def verify_mcp_source(directory: Path) -> None:
    expected_metadata = {
        "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
        "name": "com.crimsoncrawler/mcp-server",
        "title": "Crimson Crawler",
        "description": "Enrich, search, assess, and manage threat intelligence through 86 typed MCP tools.",
        "websiteUrl": "https://crimsoncrawler.com/docs/clients/mcp/",
        "remotes": [
            {
                "type": "streamable-http",
                "url": "https://crimsoncrawler.com/mcp/v1",
                "headers": [
                    {
                        "name": "apikey",
                        "description": "Your Crimson Crawler API key",
                        "isRequired": True,
                        "isSecret": True,
                    }
                ],
            }
        ],
    }
    try:
        metadata = json.loads((directory / "server.json").read_text())
        example = json.loads((directory / "examples/mcp.json").read_text())
    except (json.JSONDecodeError, OSError) as error:
        fail(f"{directory}: invalid MCP public metadata: {error}")

    version = metadata.pop("version", None)
    if not isinstance(version, str) or re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version) is None:
        fail(f"{directory}: server.json must contain a semantic version")
    if metadata != expected_metadata:
        fail(f"{directory}: server.json does not match the public MCP contract")

    expected_example = {
        "mcpServers": {
            "crimson-crawler": {
                "type": "http",
                "url": "https://crimsoncrawler.com/mcp/v1",
                "headers": {"apikey": "your-api-key-here"},
            }
        }
    }
    if example != expected_example:
        fail(f"{directory}: examples/mcp.json does not match the public MCP contract")


def source_contract(kind: str) -> tuple[set[str], set[str]]:
    contracts = {
        "python": (
            {
                ".github/workflows/release.yml",
                "CONTRIBUTING.md",
                "LICENSE",
                "README.md",
                "SECURITY.md",
                "assets/crimson-crawler-logo.svg",
                "assets/spider.png",
                "hatch_build.py",
                "openapi.snapshot.json",
                "openapi_python_client_config.yaml",
                "pyproject.toml",
                "scripts/check-public-client-registry.py",
                "scripts/normalize-public-sbom.py",
                "scripts/codegen.py",
                "scripts/verify-client-artifacts.py",
                "scripts/public-client-internal-markers.hashed",
                "src/crimson_crawler_client/_generated",
                "src",
                "tests",
                "uv.lock",
            },
            {
                ".gitignore",
                ".github",
                "CONTRIBUTING.md",
                "LICENSE",
                "README.md",
                "SECURITY.md",
                "assets",
                "hatch_build.py",
                "openapi.snapshot.json",
                "openapi_python_client_config.yaml",
                "pyproject.toml",
                "scripts",
                "src",
                "tests",
                "uv.lock",
            },
        ),
        "typescript": (
            {
                ".github/workflows/release.yml",
                "CONTRIBUTING.md",
                "LICENSE",
                "README.md",
                "SECURITY.md",
                "assets/crimson-crawler-logo.svg",
                "assets/spider.png",
                "openapi-ts.config.ts",
                "openapi.snapshot.json",
                "package-lock.json",
                "package.json",
                "scripts/check-public-client-registry.py",
                "scripts/normalize-public-sbom.py",
                "scripts/codegen.mjs",
                "scripts/verify-client-artifacts.py",
                "scripts/public-client-internal-markers.hashed",
                "src",
                "tests",
                "tsconfig.json",
                "tsconfig.test.json",
                "tsup.config.ts",
                "vitest.config.ts",
            },
            {
                ".gitignore",
                ".github",
                "CONTRIBUTING.md",
                "LICENSE",
                "README.md",
                "SECURITY.md",
                "assets",
                "eslint.config.js",
                "openapi-ts.config.ts",
                "openapi.snapshot.json",
                "package-lock.json",
                "package.json",
                "scripts",
                "src",
                "tests",
                "tsconfig.json",
                "tsconfig.test.json",
                "tsup.config.ts",
                "vitest.config.ts",
            },
        ),
        "cli": (
            {
                ".github/workflows/release.yml",
                "CONTRIBUTING.md",
                "LICENSE",
                "README.md",
                "SECURITY.md",
                "assets/crimson-crawler-logo.svg",
                "assets/spider.png",
                "pyproject.toml",
                "scripts/check-public-client-registry.py",
                "scripts/normalize-public-sbom.py",
                "scripts/verify-client-artifacts.py",
                "scripts/public-client-internal-markers.hashed",
                "src",
                "tests",
                "uv.lock",
            },
            {
                ".gitignore",
                "CONTRIBUTING.md",
                ".github",
                "LICENSE",
                "README.md",
                "SECURITY.md",
                "assets",
                "examples",
                "pyproject.toml",
                "scripts",
                "src",
                "tests",
                "uv.lock",
            },
        ),
        "docs": (
            {
                ".github/workflows/release.yml",
                "CONTRIBUTING.md",
                "LICENSE",
                "README.md",
                "SECURITY.md",
                "assets/crimson-crawler-logo.svg",
                "assets/spider.png",
                "docs",
            },
            {".gitignore", ".github", "CONTRIBUTING.md", "LICENSE", "README.md", "SECURITY.md", "assets", "docs"},
        ),
        "mcp": (
            {
                ".github/workflows/release.yml",
                "CONTRIBUTING.md",
                "LICENSE",
                "README.md",
                "SECURITY.md",
                "assets/crimson-crawler-logo.svg",
                "assets/spider.png",
                "examples/mcp.json",
                "server.json",
            },
            {
                ".gitignore",
                ".github",
                "CONTRIBUTING.md",
                "LICENSE",
                "README.md",
                "SECURITY.md",
                "assets",
                "examples",
                "server.json",
            },
        ),
    }
    try:
        return contracts[kind]
    except KeyError:
        fail(f"unknown public source kind: {kind}")


def verify_source_export(directory: Path, kind: str) -> None:
    required, allowed_roots = source_contract(kind)
    missing = sorted(item for item in required if not (directory / item).exists())
    if missing:
        fail(f"{directory}: {kind} source export is incomplete: {', '.join(missing)}")

    documentation_url = CANONICAL_DOCUMENTATION_URLS[kind]
    if documentation_url not in (directory / "README.md").read_text():
        fail(f"{directory}: {kind} README must link to canonical documentation: {documentation_url}")

    unexpected = sorted(item.name for item in directory.iterdir() if item.name not in allowed_roots)
    if unexpected:
        fail(f"{directory}: unexpected {kind} source roots: {', '.join(unexpected)}")

    forbidden_source_parts = {".env", ".git", ".npmrc", "__pycache__", "dist", "node_modules"}
    for path in directory.rglob("*"):
        if path.is_symlink():
            fail(f"{directory}: symlink is not allowed: {path.relative_to(directory)}")
        if not path.is_file():
            continue
        relative = path.relative_to(directory)
        if set(relative.parts) & forbidden_source_parts:
            fail(f"{directory}: forbidden source export path: {relative}")
        if relative.suffix == ".map":
            fail(f"{directory}: source map is not allowed: {relative}")
        scan_content(str(relative), path.read_bytes())
    verify_brand_asset_metadata(directory)

    workflow_files = {
        path.relative_to(directory).as_posix() for path in (directory / ".github").rglob("*") if path.is_file()
    }
    if workflow_files != {".github/workflows/release.yml"}:
        fail(f"{directory}: .github must contain only workflows/release.yml")

    if kind == "mcp":
        verify_mcp_source(directory)
        return

    if kind != "docs":
        return
    docs = [path for path in (directory / "docs").rglob("*") if path.is_file()]
    if not docs:
        fail(f"{directory}: docs must contain at least one Markdown file")
    for path in docs:
        relative = path.relative_to(directory)
        if path.suffix != ".md":
            fail(f"{directory}: docs may contain only Markdown files: {relative}")
        if not path.read_bytes().strip():
            fail(f"{directory}: empty documentation file: {relative}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--py-only", action="store_true")
    parser.add_argument("--ts-only", action="store_true")
    parser.add_argument("--cli-only", action="store_true")
    parser.add_argument("--source", type=Path)
    parser.add_argument("--source-kind", choices=("python", "typescript", "cli", "docs", "mcp"))
    return parser.parse_args()


def package_directory(name: str) -> Path:
    candidate = ROOT / name
    return candidate if candidate.is_dir() else ROOT


def main() -> int:
    args = parse_args()
    verify_exported_policy_sync()
    selected = sum((args.py_only, args.ts_only, args.cli_only, args.source is not None))
    if selected > 1:
        fail("artifact filters and --source are mutually exclusive")
    if args.source is not None:
        if args.source_kind is None:
            fail("--source-kind is required with --source")
        verify_source_export(args.source.resolve(), args.source_kind)
    elif args.source_kind is not None:
        fail("--source-kind requires --source")
    else:
        if args.py_only or selected == 0:
            verify_python_package(package_directory("client-py"), "crimson-crawler-client")
        if args.ts_only or selected == 0:
            verify_npm_package(package_directory("client-ts"))
        if args.cli_only or selected == 0:
            verify_python_package(package_directory("client-cli"), "crimson-crawler-cli", cli=True)
    print("Client release input verified.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except VerificationError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
