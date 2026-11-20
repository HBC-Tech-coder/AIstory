#!/usr/bin/env python3
"""Create the deterministic Passport v4 production R2 overlay for the real 4201 baseline."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import tempfile
import zipfile
from pathlib import Path

PACKAGE_ID = "aistory-linghao-passport-v4-production-r2-20261119"
STATE = "PACKAGED_NOT_DEPLOYED"
BASE_BUILD_ID = "qrRFPJcpVopq0Qg-xmBfy"
BASE_RELEASE = "/data/apps/aistory-build-staging/aistory-phone-verify-session-fix-v1-20261119"
SOURCE_PACKAGE_SHA256 = "a268c1cd81cc479872bfad0b78008b486a835cc986e272f7260649358b40f091"
BASE_PACKAGE_SHA256 = "bb9a75ecfbc7acb753ed2bdfa05649125380e73230f426a7236a962ef3ccf754"
BASE_LOCK_SHA256 = "4ccdd8c9998883ca3baa8ce9e53750717d1cc34bbe7808ac68ed524faacbc14c"
OVERLAY_AGGREGATE = "3c163c78644b39667567c91221295d09b746cf3b54324629c5c0746dbe05a9ab"
SUPERSEDES_ID = "aistory-linghao-passport-v4-production-r1-20261119"
SUPERSEDES_SHA256 = "7b51e2ac96dbf752c534b570dd2b0d3c6903e956ed6d71e3be927d2f1da07a66"
REMOVED_BASELINE_SCRIPTS = (
    "test:account-identity-projection",
    "test:auth-modal-presentation",
    "test:phone-otp-modal",
    "smoke:auth-modal-browser",
)


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def load_r1(repo: Path):
    path = repo / "scripts" / "package-linghao-passport-v4-production.py"
    spec = importlib.util.spec_from_file_location("passport_r1_packager", path)
    if spec is None or spec.loader is None:
        raise ValueError("cannot load R1 package authority")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def real_baseline_package(repo: Path) -> bytes:
    parsed = json.loads((repo / "package.json").read_text(encoding="utf-8"))
    scripts = parsed.get("scripts")
    if not isinstance(scripts, dict):
        raise ValueError("source package scripts missing")
    for key in REMOVED_BASELINE_SCRIPTS:
        if key not in scripts:
            raise ValueError(f"source script missing: {key}")
        del scripts[key]
    return (json.dumps(parsed, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def transform_support(name: str, data: bytes) -> bytes:
    text = data.decode("utf-8")
    text = text.replace("aistory-linghao-passport-v4-production-r1-20261119", PACKAGE_ID)
    if name == "apply-overlay.py":
        text = text.replace(SOURCE_PACKAGE_SHA256, BASE_PACKAGE_SHA256)
    if name == "HOST-HANDOFF.md":
        text = text.replace("production R1", "production R2")
        text += (
            "\n## R1 supersession\n\n"
            f"This R2 supersedes `{SUPERSEDES_ID}` archive SHA-256 `{SUPERSEDES_SHA256}` "
            "because Host readback proved the real gray baseline package.json is "
            f"`{BASE_PACKAGE_SHA256}`. R1 remains audit evidence and must not be applied.\n"
        )
    return text.encode("utf-8")


def add(archive: zipfile.ZipFile, name: str, data: bytes) -> None:
    info = zipfile.ZipInfo(name, date_time=(2026, 11, 19, 13, 0, 0))
    info.compress_type = zipfile.ZIP_STORED
    info.external_attr = 0o100644 << 16
    info.create_system = 3
    archive.writestr(info, data)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args()
    repo = args.repo.resolve(strict=True)
    output = args.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=True)
    r1 = load_r1(repo)
    overlay_paths = tuple(r1.OVERLAY_PATHS)
    support_root = repo / "deploy" / "preparation" / "linghao-passport-v4-production-r1-20261119"

    source_package = (repo / "package.json").read_bytes()
    lock = (repo / "pnpm-lock.yaml").read_bytes()
    baseline_package = real_baseline_package(repo)
    if sha(source_package) != SOURCE_PACKAGE_SHA256:
        raise ValueError("source package.json drift")
    if sha(baseline_package) != BASE_PACKAGE_SHA256 or len(baseline_package) != 11740:
        raise ValueError("reconstructed Host baseline package.json mismatch")
    if sha(lock) != BASE_LOCK_SHA256:
        raise ValueError("lockfile drift")
    lines = [f"{path}\0{sha((repo / path).read_bytes())}\n" for path in overlay_paths]
    if sha("".join(lines).encode("utf-8")) != OVERLAY_AGGREGATE:
        raise ValueError("overlay drift")

    payloads: dict[str, bytes] = {}
    for logical in overlay_paths:
        payloads[f"overlay/{logical}"] = (repo / logical).read_bytes()
    for logical in r1.SUPPORT_PATHS:
        payloads[f"host/{logical}"] = transform_support(logical, (support_root / logical).read_bytes())
    payloads["authority/package.json"] = baseline_package
    payloads["authority/pnpm-lock.yaml"] = lock
    payloads["authority/source-package.json"] = source_package
    payloads["tools/package.py"] = Path(__file__).read_bytes()
    payloads["tools/verify-package.py"] = (repo / "scripts" / "verify-linghao-passport-v4-production-r2-package.py").read_bytes()
    entries = {name: sha(data) for name, data in payloads.items()}
    manifest = {
        "schemaVersion": 2,
        "packageId": PACKAGE_ID,
        "state": STATE,
        "createdAt": "2026-11-19T13:00:00-08:00",
        "supersedes": {"packageId": SUPERSEDES_ID, "archiveSha256": SUPERSEDES_SHA256, "reason": "host_baseline_package_json_readback"},
        "baseline": {"releaseRoot": BASE_RELEASE, "nextBuildId": BASE_BUILD_ID, "packageJsonSha256": BASE_PACKAGE_SHA256, "pnpmLockSha256": BASE_LOCK_SHA256},
        "sourceAuthority": {"packageJsonSha256": SOURCE_PACKAGE_SHA256, "baselineRemovedScripts": list(REMOVED_BASELINE_SCRIPTS)},
        "overlayAggregateSha256": OVERLAY_AGGREGATE,
        "overlayPaths": list(overlay_paths),
        "entries": dict(sorted(entries.items())),
        "activation": {"publicEntryEnabled": False, "hostDeployed": False, "databaseMigrationApplied": False, "realE2eCompleted": False},
    }
    payloads["PACKAGE-MANIFEST.json"] = (json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")

    archive_path = output / f"{PACKAGE_ID}.zip"
    external_path = output / f"{PACKAGE_ID}.external-manifest.json"
    sidecar_path = output / f"{PACKAGE_ID}.zip.sha256"
    for path in (archive_path, external_path, sidecar_path):
        if path.exists():
            raise FileExistsError(f"refusing overwrite: {path}")
    fd, temporary = tempfile.mkstemp(prefix=f".{PACKAGE_ID}.", suffix=".zip", dir=output)
    os.close(fd)
    try:
        with zipfile.ZipFile(temporary, "w", allowZip64=True) as archive:
            for name in sorted(payloads):
                add(archive, name, payloads[name])
        os.replace(temporary, archive_path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    archive_sha = sha(archive_path.read_bytes())
    external = {
        "schemaVersion": 2,
        "packageId": PACKAGE_ID,
        "state": STATE,
        "archive": archive_path.name,
        "archiveSha256": archive_sha,
        "archiveBytes": archive_path.stat().st_size,
        "overlayAggregateSha256": OVERLAY_AGGREGATE,
        "baselineBuildId": BASE_BUILD_ID,
        "baselinePackageJsonSha256": BASE_PACKAGE_SHA256,
        "supersedesArchiveSha256": SUPERSEDES_SHA256,
    }
    external_path.write_text(json.dumps(external, indent=2) + "\n", encoding="utf-8")
    sidecar_path.write_text(f"{archive_sha}  {archive_path.name}\n", encoding="ascii")
    print(json.dumps({"ok": True, "archive": str(archive_path), "sha256": archive_sha, "entries": len(payloads)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

