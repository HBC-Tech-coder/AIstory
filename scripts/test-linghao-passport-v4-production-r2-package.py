#!/usr/bin/env python3
"""Consume R2 in an isolated source tree and run a real Next production build."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

PACKAGE_ID = "aistory-linghao-passport-v4-production-r2-20261119"
BUILD_ID = "qrRFPJcpVopq0Qg-xmBfy"


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def copy_source_files(repo: Path, stage: Path) -> int:
    inventory = subprocess.run(["rg", "--files", "-0"], cwd=repo, check=True, capture_output=True).stdout
    allowed_directories = {"app", "components", "lib", "public", "content", "types"}
    allowed_root_files = {
        "cloudflare-env.d.ts", "eslint.config.mjs", "middleware.ts", "next-env.d.ts", "next.config.ts",
        "package.json", "pnpm-lock.yaml", "postcss.config.mjs", "tailwind.config.ts", "tsconfig.json",
    }
    copied = 0
    for raw in inventory.split(b"\0"):
        if not raw:
            continue
        logical = raw.decode("utf-8").replace("\\", "/")
        top = logical.split("/", 1)[0]
        if top not in allowed_directories and logical not in allowed_root_files:
            continue
        if logical.startswith(("app/app/", "components/components/", "lib/lib/")):
            continue
        source = repo / Path(*logical.split("/"))
        if source.is_symlink() or not source.is_file():
            continue
        target = stage / Path(*logical.split("/"))
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        copied += 1
    for logical in ("content/featured-stories.manifest.json", "content/case-studies.catalog.json"):
        source = repo / Path(*logical.split("/"))
        target = stage / Path(*logical.split("/"))
        if not source.is_file():
            raise ValueError(f"required generated build input missing: {logical}")
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        copied += 1
    return copied


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", required=True, type=Path)
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    archive = args.archive.resolve(strict=True)
    repo = args.repo.resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix="aistory-passport-v4-r2-build-", dir=repo.parent) as temporary:
        root = Path(temporary)
        package_root = root / "package"
        stage = root / f"{PACKAGE_ID}-synthetic"
        package_root.mkdir()
        with zipfile.ZipFile(archive, "r") as package:
            for info in package.infolist():
                target = (package_root / info.filename).resolve()
                if package_root.resolve() not in target.parents:
                    raise ValueError(f"archive escape: {info.filename}")
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(package.read(info.filename))

        stage.mkdir()
        copied_sources = copy_source_files(repo, stage)
        shutil.copy2(package_root / "authority" / "package.json", stage / "package.json")
        shutil.copy2(package_root / "authority" / "pnpm-lock.yaml", stage / "pnpm-lock.yaml")
        (stage / ".next").mkdir(exist_ok=True)
        (stage / ".next" / "BUILD_ID").write_text(BUILD_ID + "\n", encoding="utf-8")
        subprocess.run([
            sys.executable, str(package_root / "host" / "apply-overlay.py"),
            "--package-root", str(package_root), "--stage-root", str(stage), "--allow-test-root",
        ], check=True)
        manifest = json.loads((package_root / "PACKAGE-MANIFEST.json").read_text(encoding="utf-8"))
        for logical in manifest["overlayPaths"]:
            if sha(stage / logical) != manifest["entries"][f"overlay/{logical}"]:
                raise ValueError(f"apply mismatch: {logical}")

        junction = stage / "node_modules"
        subprocess.run(["cmd", "/c", "mklink", "/J", str(junction), str(repo / "node_modules")], check=True, capture_output=True, text=True)
        try:
            environment = os.environ.copy()
            environment["NEXT_TELEMETRY_DISABLED"] = "1"
            environment["NODE_OPTIONS"] = "--max-old-space-size=6144"
            build = subprocess.run([
                "node", str(repo / "node_modules" / "next" / "dist" / "bin" / "next"), "build", "--webpack",
            ], cwd=stage, env=environment, capture_output=True, timeout=1200)
            stdout = build.stdout.decode("utf-8", errors="replace")
            stderr = build.stderr.decode("utf-8", errors="replace")
            if build.returncode != 0:
                raise RuntimeError(f"Next build failed\nSTDOUT:\n{stdout}\nSTDERR:\n{stderr}")
            new_build_id = (stage / ".next" / "BUILD_ID").read_text(encoding="utf-8").strip()
            if not new_build_id:
                raise ValueError("built candidate has no BUILD_ID")
            print(json.dumps({"ok": True, "copiedSources": copied_sources, "appliedFiles": len(manifest["overlayPaths"]), "nextBuildId": new_build_id, "buildOutputTail": stdout[-1200:]}))
        finally:
            if junction.exists():
                os.rmdir(junction)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
