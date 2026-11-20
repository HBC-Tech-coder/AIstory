#!/usr/bin/env python3
"""Independent verifier for the Passport v4 production R2 package."""

from __future__ import annotations

import argparse
import hashlib
import json
import zipfile
from pathlib import Path, PurePosixPath

PACKAGE_ID = "aistory-linghao-passport-v4-production-r2-20261119"
STATE = "PACKAGED_NOT_DEPLOYED"
BUILD_ID = "qrRFPJcpVopq0Qg-xmBfy"
BASE_PACKAGE_SHA = "bb9a75ecfbc7acb753ed2bdfa05649125380e73230f426a7236a962ef3ccf754"
LOCK_SHA = "4ccdd8c9998883ca3baa8ce9e53750717d1cc34bbe7808ac68ed524faacbc14c"
OVERLAY_SHA = "3c163c78644b39667567c91221295d09b746cf3b54324629c5c0746dbe05a9ab"
R1_SHA = "7b51e2ac96dbf752c534b570dd2b0d3c6903e956ed6d71e3be927d2f1da07a66"


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def safe(name: str) -> None:
    path = PurePosixPath(name)
    if path.is_absolute() or not path.parts or "\\" in name or any(part in {"", ".", ".."} for part in path.parts):
        raise ValueError(f"unsafe path: {name}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", required=True, type=Path)
    parser.add_argument("--external-manifest", required=True, type=Path)
    parser.add_argument("--sidecar", required=True, type=Path)
    args = parser.parse_args()
    archive = args.archive.resolve(strict=True)
    archive_bytes = archive.read_bytes()
    archive_sha = sha(archive_bytes)
    if args.sidecar.read_text(encoding="ascii") != f"{archive_sha}  {archive.name}\n":
        raise ValueError("sidecar mismatch")
    external = json.loads(args.external_manifest.read_text(encoding="utf-8"))
    expected_external = {
        "schemaVersion": 2, "packageId": PACKAGE_ID, "state": STATE, "archive": archive.name,
        "archiveSha256": archive_sha, "archiveBytes": len(archive_bytes), "overlayAggregateSha256": OVERLAY_SHA,
        "baselineBuildId": BUILD_ID, "baselinePackageJsonSha256": BASE_PACKAGE_SHA, "supersedesArchiveSha256": R1_SHA,
    }
    if external != expected_external:
        raise ValueError("external manifest mismatch")
    with zipfile.ZipFile(archive, "r") as package:
        infos = package.infolist()
        names = [entry.filename for entry in infos]
        if len(names) != len(set(names)) or "PACKAGE-MANIFEST.json" not in names:
            raise ValueError("duplicate or missing manifest")
        for info in infos:
            safe(info.filename)
            if info.is_dir() or info.compress_type != zipfile.ZIP_STORED:
                raise ValueError(f"unexpected entry: {info.filename}")
        manifest = json.loads(package.read("PACKAGE-MANIFEST.json"))
        if manifest.get("packageId") != PACKAGE_ID or manifest.get("state") != STATE:
            raise ValueError("identity mismatch")
        if manifest.get("baseline", {}).get("packageJsonSha256") != BASE_PACKAGE_SHA:
            raise ValueError("baseline package mismatch")
        if manifest.get("supersedes", {}).get("archiveSha256") != R1_SHA:
            raise ValueError("R1 supersession mismatch")
        entries = manifest.get("entries")
        if not isinstance(entries, dict) or set(entries) != set(names) - {"PACKAGE-MANIFEST.json"}:
            raise ValueError("entry set mismatch")
        for name, expected in entries.items():
            if sha(package.read(name)) != expected:
                raise ValueError(f"entry hash mismatch: {name}")
        if sha(package.read("authority/package.json")) != BASE_PACKAGE_SHA or sha(package.read("authority/pnpm-lock.yaml")) != LOCK_SHA:
            raise ValueError("authority bytes mismatch")
        lines = []
        for logical in manifest["overlayPaths"]:
            safe(logical)
            lines.append(f"{logical}\0{sha(package.read(f'overlay/{logical}'))}\n")
        if sha("".join(lines).encode("utf-8")) != OVERLAY_SHA:
            raise ValueError("overlay aggregate mismatch")
        activation = manifest.get("activation", {})
        if any(value is not False for value in activation.values()):
            raise ValueError("false activation claim")
        apply_text = package.read("host/apply-overlay.py").decode("utf-8")
        if PACKAGE_ID not in apply_text or BASE_PACKAGE_SHA not in apply_text or "a268c1cd81cc" in apply_text:
            raise ValueError("applicator not bound exclusively to R2 baseline")
    print(json.dumps({"ok": True, "packageId": PACKAGE_ID, "archiveSha256": archive_sha, "entries": len(names)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
