#!/usr/bin/env python3
"""Independent verifier for the deterministic Passport v4 production R1 package."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import zipfile
from pathlib import Path, PurePosixPath

PACKAGE_ID = "aistory-linghao-passport-v4-production-r1-20261119"
STATE = "PACKAGED_NOT_DEPLOYED"
BASE_BUILD_ID = "qrRFPJcpVopq0Qg-xmBfy"
EXPECTED_OVERLAY_AGGREGATE = "3c163c78644b39667567c91221295d09b746cf3b54324629c5c0746dbe05a9ab"


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def safe_name(name: str) -> None:
    path = PurePosixPath(name)
    if path.is_absolute() or not path.parts or any(part in {"", ".", ".."} for part in path.parts) or "\\" in name:
        raise ValueError(f"unsafe archive path: {name!r}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--external-manifest", type=Path, required=True)
    parser.add_argument("--sidecar", type=Path, required=True)
    args = parser.parse_args()
    archive = args.archive.resolve(strict=True)
    external = json.loads(args.external_manifest.read_text(encoding="utf-8"))
    archive_sha = sha256_file(archive)
    expected_sidecar = f"{archive_sha}  {archive.name}\n"
    if args.sidecar.read_text(encoding="ascii") != expected_sidecar:
        raise ValueError("sidecar mismatch")
    if external != {
        "schemaVersion": 1,
        "packageId": PACKAGE_ID,
        "state": STATE,
        "archive": archive.name,
        "archiveSha256": archive_sha,
        "archiveBytes": archive.stat().st_size,
        "overlayAggregateSha256": EXPECTED_OVERLAY_AGGREGATE,
        "baselineBuildId": BASE_BUILD_ID,
    }:
        raise ValueError("external manifest mismatch")

    with zipfile.ZipFile(archive, "r") as package:
        infos = package.infolist()
        names = [info.filename for info in infos]
        if len(names) != len(set(names)) or "PACKAGE-MANIFEST.json" not in names:
            raise ValueError("duplicate paths or missing internal manifest")
        for info in infos:
            safe_name(info.filename)
            if info.is_dir() or info.compress_type != zipfile.ZIP_STORED:
                raise ValueError(f"unexpected archive entry type: {info.filename}")
        manifest = json.loads(package.read("PACKAGE-MANIFEST.json"))
        if manifest.get("packageId") != PACKAGE_ID or manifest.get("state") != STATE:
            raise ValueError("internal identity mismatch")
        if manifest.get("overlayAggregateSha256") != EXPECTED_OVERLAY_AGGREGATE:
            raise ValueError("overlay aggregate mismatch")
        if manifest.get("baseline", {}).get("nextBuildId") != BASE_BUILD_ID:
            raise ValueError("baseline build id mismatch")
        entries = manifest.get("entries")
        if not isinstance(entries, dict) or set(entries) != set(names) - {"PACKAGE-MANIFEST.json"}:
            raise ValueError("manifest entry set mismatch")
        for name, expected in entries.items():
            if sha256_bytes(package.read(name)) != expected:
                raise ValueError(f"entry hash mismatch: {name}")
        overlay_paths = manifest.get("overlayPaths")
        if not isinstance(overlay_paths, list) or not overlay_paths:
            raise ValueError("missing overlay paths")
        aggregate_lines = []
        for logical in overlay_paths:
            safe_name(logical)
            entry = f"overlay/{logical}"
            aggregate_lines.append(f"{logical}\0{sha256_bytes(package.read(entry))}\n")
        if sha256_bytes("".join(aggregate_lines).encode("utf-8")) != EXPECTED_OVERLAY_AGGREGATE:
            raise ValueError("recomputed aggregate mismatch")
        activation = manifest.get("activation", {})
        if any(activation.get(key) is not False for key in ("publicEntryEnabled", "remoteRegistrationCompleted", "credentialDelivered", "realE2eCompleted")):
            raise ValueError("package falsely claims activation")

    print(json.dumps({"ok": True, "packageId": PACKAGE_ID, "archiveSha256": archive_sha, "entries": len(names)}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
