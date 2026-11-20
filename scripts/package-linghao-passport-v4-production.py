#!/usr/bin/env python3
"""Create the deterministic Passport v4 production R1 source overlay package."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path

PACKAGE_ID = "aistory-linghao-passport-v4-production-r1-20261119"
STATE = "PACKAGED_NOT_DEPLOYED"
BASE_RELEASE = "/data/apps/aistory-build-staging/aistory-phone-verify-session-fix-v1-20261119"
BASE_BUILD_ID = "qrRFPJcpVopq0Qg-xmBfy"
BASE_PACKAGE_SHA256 = "a268c1cd81cc479872bfad0b78008b486a835cc986e272f7260649358b40f091"
BASE_LOCK_SHA256 = "4ccdd8c9998883ca3baa8ce9e53750717d1cc34bbe7808ac68ed524faacbc14c"
EXPECTED_OVERLAY_AGGREGATE = "3c163c78644b39667567c91221295d09b746cf3b54324629c5c0746dbe05a9ab"

OVERLAY_PATHS = (
    "app/api/account/me/route.ts",
    "app/api/admin/bootstrap/route.ts",
    "app/api/auth/linghao-passport-v4/callback/route.ts",
    "app/api/auth/linghao-passport-v4/capabilities/route.ts",
    "app/api/auth/linghao-passport-v4/draft/route.ts",
    "app/api/auth/linghao-passport-v4/logged-out/route.ts",
    "app/api/auth/linghao-passport-v4/logout/route.ts",
    "app/api/auth/linghao-passport-v4/renew/route.ts",
    "app/api/auth/linghao-passport-v4/session/route.ts",
    "app/api/auth/linghao-passport-v4/start/route.ts",
    "app/api/credentials/hosted/route.ts",
    "app/auth/linghao-passport-v4/page.tsx",
    "components/AuthModal.tsx",
    "components/CreditBalance.tsx",
    "components/LinghaoPassportV4EntryPanel.tsx",
    "components/LinghaoPassportV4LocalPanel.tsx",
    "components/LinghaoPassportV4LoginButton.tsx",
    "components/UserChip.tsx",
    "lib/admin/security.ts",
    "lib/auth/accountLogoutRoute.ts",
    "lib/auth/linghaoPassportV4Boundary.ts",
    "lib/auth/linghaoPassportV4Config.ts",
    "lib/auth/linghaoPassportV4DurableAuthority.ts",
    "lib/auth/linghaoPassportV4DurableRepository.ts",
    "lib/auth/linghaoPassportV4Oidc.ts",
    "lib/auth/linghaoPassportV4ProductionContract.ts",
    "lib/auth/linghaoPassportV4ProductionCookies.ts",
    "lib/auth/linghaoPassportV4ProductionLoader.ts",
    "lib/auth/linghaoPassportV4ProductionPublic.ts",
    "lib/auth/linghaoPassportV4ProductionServer.ts",
    "lib/auth/linghaoPassportV4ProductionSession.ts",
    "lib/auth/linghaoPassportV4Public.ts",
    "lib/auth/linghaoPassportV4SecretFile.ts",
    "lib/auth/linghaoPassportV4Server.ts",
    "lib/auth/linghaoPassportV4Session.ts",
    "lib/auth/linghaoPassportV4StateSeal.ts",
    "lib/billing/generationGate.ts",
    "lib/creator-studio/online/service.ts",
    "lib/credentials/serverPolicy.ts",
    "lib/supabase/guard.ts",
    "middleware.ts",
    "runbooks/linghao-passport-v4-production-v1.md",
    "scripts/fixtures/auth-modal-browser-harness.tsx",
    "scripts/fixtures/linghao-passport-v4-entry-browser.tsx",
    "scripts/smoke-auth-modal-browser.mjs",
    "scripts/smoke-linghao-passport-v4-entry-browser.mjs",
    "scripts/test-account-identity-projection.ts",
    "scripts/test-auth-modal-presentation.ts",
    "scripts/test-credential-modes.ts",
    "scripts/test-https-locale-routing.mjs",
    "scripts/test-linghao-passport-v4-account-logout.ts",
    "scripts/test-linghao-passport-v4-durable-authority.ts",
    "scripts/test-linghao-passport-v4-durable-db.ts",
    "scripts/test-linghao-passport-v4-production-server.ts",
    "scripts/test-linghao-passport-v4-production.ts",
    "scripts/test-linghao-passport-v4-ui.ts",
    "scripts/test-studio-online-projects.ts",
    "supabase/migrations/20261119120000_linghao_passport_v4_auth_state_gate.sql",
    "tsconfig.linghao-passport-v4-production.json",
)

SUPPORT_PATHS = (
    "HOST-HANDOFF.md",
    "apply-overlay.py",
    "startup-layout.json",
    "templates/host-acceptance-v1.json.template",
    "templates/production-v1.json.template",
    "templates/registry-receipt-v1.json.template",
    "templates/runtime.env.template",
)


def digest_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def digest_file(path: Path) -> str:
    return digest_bytes(path.read_bytes())


def aggregate(root: Path) -> str:
    lines = [f"{path}\0{digest_file(root / path)}\n" for path in OVERLAY_PATHS]
    return digest_bytes("".join(lines).encode("utf-8"))


def add_bytes(archive: zipfile.ZipFile, name: str, data: bytes) -> None:
    info = zipfile.ZipInfo(name, date_time=(2026, 11, 19, 12, 0, 0))
    info.compress_type = zipfile.ZIP_STORED
    info.external_attr = 0o100644 << 16
    info.create_system = 3
    archive.writestr(info, data)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--inspect", action="store_true")
    args = parser.parse_args()
    repo = args.repo.resolve(strict=True)
    support = repo / "deploy" / "preparation" / "linghao-passport-v4-production-r1-20261119"

    missing = [path for path in OVERLAY_PATHS if not (repo / path).is_file()]
    missing += [f"support/{path}" for path in SUPPORT_PATHS if not (support / path).is_file()]
    if missing:
        raise ValueError(f"missing package inputs: {missing}")
    if digest_file(repo / "package.json") != BASE_PACKAGE_SHA256 or digest_file(repo / "pnpm-lock.yaml") != BASE_LOCK_SHA256:
        raise ValueError("package authority bytes do not match the pinned gray baseline")

    current_aggregate = aggregate(repo)
    if args.inspect:
        print(json.dumps({"overlayAggregateSha256": current_aggregate, "overlayFiles": len(OVERLAY_PATHS)}))
        return 0
    if current_aggregate != EXPECTED_OVERLAY_AGGREGATE:
        raise ValueError(f"overlay aggregate drift: {current_aggregate}")
    if args.output_dir is None:
        raise ValueError("--output-dir is required unless --inspect is used")

    output = args.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=True)
    archive_path = output / f"{PACKAGE_ID}.zip"
    external_manifest_path = output / f"{PACKAGE_ID}.external-manifest.json"
    sidecar_path = output / f"{PACKAGE_ID}.zip.sha256"
    for path in (archive_path, external_manifest_path, sidecar_path):
        if path.exists():
            raise FileExistsError(f"refusing to overwrite: {path}")

    entries: dict[str, str] = {}
    payloads: dict[str, bytes] = {}
    for logical in OVERLAY_PATHS:
        payloads[f"overlay/{logical}"] = (repo / logical).read_bytes()
    for logical in SUPPORT_PATHS:
        payloads[f"host/{logical}"] = (support / logical).read_bytes()
    payloads["authority/package.json"] = (repo / "package.json").read_bytes()
    payloads["authority/pnpm-lock.yaml"] = (repo / "pnpm-lock.yaml").read_bytes()
    payloads["tools/package.py"] = Path(__file__).read_bytes()
    verifier_path = repo / "scripts" / "verify-linghao-passport-v4-production-package.py"
    payloads["tools/verify-package.py"] = verifier_path.read_bytes()
    entries.update({name: digest_bytes(data) for name, data in payloads.items()})
    manifest = {
        "schemaVersion": 1,
        "packageId": PACKAGE_ID,
        "state": STATE,
        "createdAt": "2026-11-19T12:00:00-08:00",
        "baseline": {"releaseRoot": BASE_RELEASE, "nextBuildId": BASE_BUILD_ID},
        "authority": {"packageJsonSha256": BASE_PACKAGE_SHA256, "pnpmLockSha256": BASE_LOCK_SHA256},
        "overlayAggregateSha256": current_aggregate,
        "overlayPaths": list(OVERLAY_PATHS),
        "entries": dict(sorted(entries.items())),
        "activation": {
            "publicEntryEnabled": False,
            "remoteRegistrationCompleted": False,
            "credentialDelivered": False,
            "realE2eCompleted": False,
        },
    }
    payloads["PACKAGE-MANIFEST.json"] = (json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")

    fd, temp_name = tempfile.mkstemp(prefix=f".{PACKAGE_ID}.", suffix=".zip", dir=output)
    os.close(fd)
    try:
        with zipfile.ZipFile(temp_name, "w", allowZip64=True) as archive:
            for name in sorted(payloads):
                add_bytes(archive, name, payloads[name])
        os.replace(temp_name, archive_path)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)

    archive_sha = digest_file(archive_path)
    external = {
        "schemaVersion": 1,
        "packageId": PACKAGE_ID,
        "state": STATE,
        "archive": archive_path.name,
        "archiveSha256": archive_sha,
        "archiveBytes": archive_path.stat().st_size,
        "overlayAggregateSha256": current_aggregate,
        "baselineBuildId": BASE_BUILD_ID,
    }
    external_manifest_path.write_text(json.dumps(external, indent=2) + "\n", encoding="utf-8")
    sidecar_path.write_text(f"{archive_sha}  {archive_path.name}\n", encoding="ascii")
    print(json.dumps({"ok": True, "archive": str(archive_path), "sha256": archive_sha, "files": len(payloads)}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)

