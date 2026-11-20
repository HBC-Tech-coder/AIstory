#!/usr/bin/env python3
"""Synthetic consumption test for the Passport v4 production package."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

PACKAGE_ID = "aistory-linghao-passport-v4-production-r1-20261119"
BASE_BUILD_ID = "qrRFPJcpVopq0Qg-xmBfy"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", required=True, type=Path)
    args = parser.parse_args()
    archive = args.archive.resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix="aistory-passport-v4-package-test-") as temporary:
        root = Path(temporary)
        extracted = root / "package"
        stage = root / f"{PACKAGE_ID}-synthetic"
        extracted.mkdir()
        stage.mkdir()
        with zipfile.ZipFile(archive, "r") as package:
            for info in package.infolist():
                destination = (extracted / info.filename).resolve()
                if extracted.resolve() not in destination.parents:
                    raise ValueError(f"archive path escaped extraction root: {info.filename}")
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(package.read(info.filename))
        (stage / ".next").mkdir()
        (stage / ".next" / "BUILD_ID").write_text(BASE_BUILD_ID + "\n", encoding="utf-8")
        shutil.copy2(extracted / "authority" / "package.json", stage / "package.json")
        shutil.copy2(extracted / "authority" / "pnpm-lock.yaml", stage / "pnpm-lock.yaml")
        command = [
            sys.executable,
            str(extracted / "host" / "apply-overlay.py"),
            "--package-root",
            str(extracted),
            "--stage-root",
            str(stage),
            "--allow-test-root",
        ]
        result = subprocess.run(command, check=True, capture_output=True, text=True)
        manifest = json.loads((extracted / "PACKAGE-MANIFEST.json").read_text(encoding="utf-8"))
        for logical in manifest["overlayPaths"]:
            target = stage / logical
            if sha256(target) != manifest["entries"][f"overlay/{logical}"]:
                raise ValueError(f"synthetic apply mismatch: {logical}")
        receipt = stage / f"{PACKAGE_ID}-overlay-apply-receipt.json"
        receipt_data = json.loads(receipt.read_text(encoding="utf-8"))
        if receipt_data.get("state") != "OVERLAY_APPLIED_NOT_BUILT_NOT_ACTIVATED":
            raise ValueError("wrong synthetic apply receipt state")
        print(json.dumps({"ok": True, "appliedFiles": len(manifest["overlayPaths"]), "applyOutput": result.stdout.strip()}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
