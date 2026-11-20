"""Secretless, exact-baseline HTTPS locale handoff; no install/deploy commands.

Python 3.11+ standard library only. The consumer verifies a pinned predecessor
ZIP and composes a NEW source archive. It never edits a checkout or a service.
"""

import argparse
import difflib
import hashlib
import json
from pathlib import Path, PurePosixPath
import stat
import sys
import zipfile

ID = "aistory-https-locale-origin-current1400-20260903"
FROZEN_AT = "2026-09-03T04:08:24Z"
ALGORITHM = "ordinal UTF8 path ACTUAL_NUL decimal_bytes ACTUAL_NUL lowercase_sha256 ACTUAL_LF including final LF"
BASE = {
    "archiveFileName": "aistory-p05-admin-password-policy-v2-current1311-composition-production-source-20260901-1346.zip",
    "archiveBytes": 299357132,
    "archiveSha256": "dfc328688919b2c6cc45c5bd8c54ae868874f7e7f14fdbdbe7fecac6f5392a89",
    "sourceFiles": 1268,
    "sourceAggregateSha256": "419192051b70a4992a27500bc4db4b43640d23fa360b0cfe2347827bc465902a",
    "sourceManifestSha256": "15a3deacae5e28fbbffa29cd81662daa897b24d91b7d4d93faf8baf2b98fbc6e",
    "qualificationSha256": "d23e0b461d3565da5c5180ae15024aee03c6b7d0f9b486970e1e18a97f2fa308",
    "currentRelease": "/opt/aistory/releases/20260901-1400-admin-password-policy-v2-current1311",
    "currentBuildId": "MH7801PYcR5DNBqSZZGKT",
    "currentBuildAggregateSha256": "7f1234092581e6798102d48fc10d7fdee333a4375fcd833504bb7e112951bae7",
    "previousRollbackRelease": "/opt/aistory/releases/20260901-1311-aiuser-product-logout-cookie-clear-order",
    "authority": "Host v2 current binding plus CODEX-ALIYUN-AISTORY-ADMIN-PASSWORD-POLICY-V2-PRODUCTION-20260901-1432.md",
}
PINS = {
    "middleware.ts": "213f5cc66c8479f1155f872f3a9ed8d599e07580609d173996e187c5aa1be9e5",
    "next.config.ts": "7f5b793b898bf72ef92b2749c6fcd888e5863db0b9980386261ca127a02e445b",
    "scripts/test-https-locale-routing.mjs": "83a655fad64b549c20422f62126fabedcfd8c2eec22aaac6aa0488e5bcc45495",
}
BEFORE = {
    "middleware.ts": "af35476560eb1933f5a93420acd071f0dc708aa8a9276058581d61570b912c00",
    "next.config.ts": "9a45995ae7da53a1cc950ca7ab5e2f4873386ddbf4b164c24dec70b82b859d8e",
}
META = {".release/SOURCE-MANIFEST.json", ".release/QUALIFICATION.json"}


def check(condition, message):
    if not condition:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def json_bytes(value):
    return (json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n").encode("utf-8")


def stream_identity(stream):
    digest = hashlib.sha256()
    size = 0
    while chunk := stream.read(1024 * 1024):
        size += len(chunk)
        digest.update(chunk)
    return size, digest.hexdigest()


def file_identity(file):
    with Path(file).open("rb") as stream:
        return stream_identity(stream)


def row(name, data):
    return {"path": name, "bytes": len(data), "sha256": sha(data)}


def aggregate(rows):
    ordered = sorted(rows, key=lambda item: item["path"].encode("utf-8"))
    return sha("".join(f'{item["path"]}\0{item["bytes"]}\0{item["sha256"]}\n' for item in ordered).encode("utf-8"))


def safe_path(name):
    parts = name.split("/")
    check(name and not PurePosixPath(name).is_absolute(), "absolute/empty archive path")
    check(all(part not in ("", ".", "..") for part in parts), "noncanonical archive path")
    check(not any(char in name for char in "\\:\0\r\n"), "unsafe archive path")


def zip_entries(archive):
    infos = archive.infolist()
    names = [info.filename for info in infos]
    check(len(names) == len(set(names)), "duplicate archive entry")
    for info in infos:
        safe_path(info.filename)
        check(not info.is_dir() and not info.flag_bits & 1, "directory/encrypted entry forbidden")
        kind = stat.S_IFMT(info.external_attr >> 16)
        check(kind in (0, stat.S_IFREG), "link/special archive entry forbidden")
    return set(names)


def verify_sources(archive, manifest):
    rows = manifest["files"]
    check(manifest["aggregateAlgorithm"] == ALGORITHM, "aggregate algorithm drift")
    check(len(rows) == manifest["fileCount"], "source count drift")
    check(len({item["path"] for item in rows}) == len(rows), "duplicate source row")
    check(aggregate(rows) == manifest["aggregateSha256"], "source aggregate drift")
    check(zip_entries(archive) == {item["path"] for item in rows} | META, "archive file-set drift")
    for item in rows:
        name = item["path"]
        safe_path(name)
        check(not any(part in {"node_modules", ".git", ".next"} for part in name.split("/")), "runtime/cache content forbidden")
        check(not Path(name).name.startswith(".env") or Path(name).name == ".env.example", "runtime env content forbidden")
        with archive.open(name) as stream:
            check(stream_identity(stream) == (item["bytes"], item["sha256"]), f"source bytes drift: {name}")


def baseline_manifest(file):
    check(file_identity(file) == (BASE["archiveBytes"], BASE["archiveSha256"]), "predecessor archive identity mismatch")
    with zipfile.ZipFile(file) as archive:
        raw = archive.read(".release/SOURCE-MANIFEST.json")
        check(sha(raw) == BASE["sourceManifestSha256"], "predecessor manifest mismatch")
        check(sha(archive.read(".release/QUALIFICATION.json")) == BASE["qualificationSha256"], "predecessor qualification mismatch")
        manifest = json.loads(raw)
        check(manifest["fileCount"] == BASE["sourceFiles"] and manifest["aggregateSha256"] == BASE["sourceAggregateSha256"], "predecessor source identity mismatch")
        verify_sources(archive, manifest)
        for name, expected in BEFORE.items():
            check(sha(archive.read(name)) == expected, f"predecessor leaf mismatch: {name}")
    return manifest, raw


def metadata(name, size):
    info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
    info.create_system = 3
    info.external_attr = (stat.S_IFREG | 0o644) << 16
    info.compress_type = zipfile.ZIP_STORED
    info.file_size = size
    return info


def write_zip(file, blobs):
    check(Path(file).suffix == ".zip", "output must be an explicitly named ZIP")
    with zipfile.ZipFile(file, "x", compression=zipfile.ZIP_STORED) as archive:
        for name in sorted(blobs, key=lambda value: value.encode("utf-8")):
            safe_path(name)
            archive.writestr(metadata(name, len(blobs[name])), blobs[name])


def minimal_delta(before, candidate):
    old = b"      // No locale prefix \xe2\x80\x94 rewrite to /zh-CN/... internally (URL stays clean).\n      const url = request.nextUrl.clone();"
    new = b"\n".join([
        b"      // Preserve Next's original origin so this stays an internal rewrite.",
        b"      // nextUrl.clone() normalizes 127.0.0.1 to localhost, which can turn an",
        b"      // HTTPS-forwarded request into a TLS proxy call to an HTTP-only listener.",
        b"      // Paired with skipProxyUrlNormalize in next.config; never derive an origin",
        b"      // from Host/forwarded headers or downgrade the external HTTPS protocol.",
        b"      const url = new URL(request.url);",
    ])
    check(before["middleware.ts"].count(old) == 1, "middleware anchor drift")
    check(before["middleware.ts"].replace(old, new) == candidate["middleware.ts"], "middleware includes unrelated changes")
    old = b"  typedRoutes: false,\n"
    new = old + b"  // Keep the original request origin for middleware's same-origin locale rewrite.\n  // Otherwise NextURL's loopback normalization can cause HTTPS self-proxying.\n  skipProxyUrlNormalize: true,\n"
    check(before["next.config.ts"].count(old) == 1, "config anchor drift")
    check(before["next.config.ts"].replace(old, new) == candidate["next.config.ts"], "config includes unrelated changes")


def validation_record():
    return {
        "status": "LOCAL_ROUTING_SLICE_PASS_CANONICAL_BUILD_PENDING",
        "candidatePins": PINS,
        "localRuntime": {"node": "24.13.0", "next": "16.2.7", "baselineLockNext": "16.2.7", "packageManager": "pnpm@9.12.0"},
        "routingRegression": {"command": "node scripts/test-https-locale-routing.mjs", "exitCode": 0, "unitCases": 512, "fakeAuthCases": 11, "realNextRouteCases": 131, "encodedMarkerParityCases": 36, "htmlRscCases": 9, "postCases": 1, "legacy500Reproduced": True, "fixtureBuildAndTypecheck": "PASS", "providerCalls": 0},
        "targetedLint": {"exitCode": 0, "command": "node node_modules/eslint/bin/eslint.js middleware.ts next.config.ts scripts/test-https-locale-routing.mjs"},
        "targetedTypeScript": {"exitCode": 0, "command": "node node_modules/typescript/bin/tsc --noEmit --skipLibCheck --strict --esModuleInterop --moduleResolution bundler --module esnext --target ES2022 middleware.ts next.config.ts"},
        "fullTreeTypeScript": {"status": "UNRESOLVED_OOM_NOT_PASS", "exitCode": 134, "command": "node node_modules/typescript/bin/tsc --noEmit --incremental false", "scope": "local dirty tree; approximately 4 GiB default heap exhausted", "notReplacedBy": "targeted/fixture checks or predecessor release PASS"},
        "canonicalProductionBuild": "NOT_RUN_FOR_THIS_CANDIDATE; Host must clean-build exact composed source",
        "productionDeployment": "NOT_PERFORMED_BY_WRITER",
        "knownLimitations": ["skipProxyUrlNormalize exposes raw data URLs and Flight headers; not all historical URL semantics were proven equivalent", "malformed /bad% returns 500 in fixture; no-rewrite /en/bad% control also returns 500; not repaired here", "video tests select controlled destinations, not real production bytes/Range authorization", "no actual account, Server Action, provider, SMS, GPU, or database flow executed", "existing middleware deprecation and Supabase Edge process.version build warnings remain"],
    }


def handoff_text():
    return f"""# {ID}

This is a secretless, exact-baseline SOURCE DELTA, not a production build.
Writer owns local packaging only. Host v2 owns independent build, verification,
atomic release switch and rollback under its existing authorization.

## Exact consumption

1. Compare this ZIP's SHA256 with the out-of-band writer handoff. Extract into a
   NEW empty directory. Hash binding is not a digital signature.
2. Run `python3 -I tools/handoff.py verify --bundle HANDOFF.zip --expected-sha256
   HANDOFF_SHA --baseline-zip BASELINE.zip` (one command on one line).
3. Run the same command with `compose` and `--output NEW_SOURCE.zip`. It reads only
   the exact pinned predecessor and verified package, never a checkout, env file
   or deployed directory. Existing output files are rejected. All 1268 predecessor
   source leaves are validated; only 2 change and the routing test is added.
4. Independently rehash and extract NEW_SOURCE.zip in a NEW release/build root.
   `.release/SOURCE-MANIFEST.json` is the complete 1269-file source authority.
   The new `.release/QUALIFICATION.json` replaces, NOT inherits, predecessor PASS.

`CHANGE.patch` is review evidence only; do not apply with fuzzy matching or copy
the local dirty tree. Both production changes must ship in the SAME build.
No Host/XFP rewriting, trustHostHeader relaxation, new marker or new middleware
matcher is included. Raw data URL/Flight-header behavior is an intentional Next
flag contract and is covered only to the extent stated in VALIDATION.json.

## Host build and acceptance

Use the established source-manifest release chain: Node >=22, pnpm 9.12.0,
clean frozen offline install from the existing accepted store, package-present
typecheck/lint, canonical `pnpm build` (font precheck -> next build -> font artifact
verification), then `node scripts/test-https-locale-routing.mjs` against this source.
Do not silently add packages, lifecycle actions or excluded local files.

Full-tree TypeScript on the writer's dirty tree FAILED with OOM/exit 134 and is
UNRESOLVED. Focused checks and predecessor full TSC PASS do not replace that fact.
Host must report its independent result; do not label this package fully qualified.

Before switch, Host rechecks its actual current source/build/selector bindings,
keeps protected env/config/DB state outside the artifact, and tests a private
HTTP listener with true Host=iy.vxmeng.com and X-Forwarded-Proto=https (with/without
X-Forwarded-Host). Root/locale/public/cache/API/admin/auth and actual HTTP/RSC/cookie
boundaries must remain correct; no provider or account mutations are implied.
Do not use XFP=http to hide the fault. Preserve normal host/origin checks.

After a successful private build/read-only acceptance, Host may use its established
atomic release switch and aistory-iy-only service procedure, then verify public
trusted-TLS root and relevant read-only endpoints, ingress logs and other services.
Writer did NOT deploy, restart, access a live account or read secret values.

## Rollback

The first rollback target after this candidate is the PRE-SWITCH CURRENT release:
`{BASE['currentRelease']}` (Build ID `{BASE['currentBuildId']}`).
Its 1268-source aggregate is `{BASE['sourceAggregateSha256']}`;
its server build aggregate is `{BASE['currentBuildAggregateSha256']}`.
Host must freshness-check and retain that complete installed build before switch.
The previously configured older rollback `{BASE['previousRollbackRelease']}` is
historical context, not an automatic rollback target for this change.

Returning to the pre-switch current restores its known HTTPS500 behavior; it is a
functional safety rollback, not a claim to restore public availability. No DB,
seed, account, audit, OIDC or admin-selector rollback is part of this source patch.
`baseline/` files are audit/source reversal material, not a runnable service backup.

## Reproducibility and exclusions

`tools/handoff.py package --source-root REVIEWED_SOURCE --baseline-zip BASELINE.zip
--output NEW_HANDOFF.zip` recreates this package from exactly three pinned source
files and the exact baseline. ZIP entries use sorted UTF8 paths, fixed 1980 times,
regular 0644 modes and ZIP_STORED (no compressor/version variability).
`compose` produces the same full-source ZIP bytes from the same inputs.
No runtime env files, credentials, node_modules, .next, local state, frozen launcher
or unrelated dirty files are sourced. The unchanged released .env.example template
stays in the predecessor source set; no values are printed or loaded as config.
""".encode("utf-8")


def package(args):
    manifest, raw = baseline_manifest(args.baseline_zip)
    source = Path(args.source_root).resolve(strict=True)
    candidate = {name: (source / name).read_bytes() for name in PINS}
    for name, data in candidate.items():
        check(sha(data) == PINS[name], f"reviewed candidate drift: {name}")
    with zipfile.ZipFile(args.baseline_zip) as archive:
        before = {name: archive.read(name) for name in BEFORE}
    minimal_delta(before, candidate)
    rows = {item["path"]: item for item in manifest["files"]}
    check("scripts/test-https-locale-routing.mjs" not in rows, "new test already exists in baseline")
    changes = [{"path": name, "action": "changed" if name in BEFORE else "added", "before": rows.get(name), "after": row(name, data)} for name, data in candidate.items()]
    rows.update({name: row(name, data) for name, data in candidate.items()})
    target = {"schemaVersion": 1, "candidate": ID, "createdAt": FROZEN_AT, "aggregateAlgorithm": ALGORITHM, "fileCount": len(rows), "aggregateSha256": aggregate(rows.values()), "files": sorted(rows.values(), key=lambda item: item["path"].encode("utf-8"))}
    evidence = validation_record()
    qualification = {"schemaVersion": 1, "candidate": ID, "createdAt": FROZEN_AT, "baseline": BASE, "sourceAggregateSha256": target["aggregateSha256"], "sourceFiles": target["fileCount"], "validation": evidence, "secretValuesAccessed": False, "writerProductionActions": 0}
    patch = "".join("".join(difflib.unified_diff(before[name].decode().splitlines(keepends=True), candidate[name].decode().splitlines(keepends=True), fromfile="a/" + name, tofile="b/" + name)) for name in BEFORE)
    blobs = {"BASELINE.json": json_bytes(BASE), "baseline/SOURCE-MANIFEST.json": raw, "DELTA.json": json_bytes({"changes": changes, "targetSourceFiles": target["fileCount"], "targetSourceAggregateSha256": target["aggregateSha256"]}), "CHANGE.patch": patch.encode(), "HANDOFF.md": handoff_text(), "VALIDATION.json": json_bytes(evidence), "target/SOURCE-MANIFEST.json": json_bytes(target), "target/QUALIFICATION.json": json_bytes(qualification), "tools/handoff.py": Path(__file__).read_bytes()}
    blobs.update({"baseline/" + name: data for name, data in before.items()})
    blobs.update({"candidate/" + name: data for name, data in candidate.items()})
    package_rows = [row(name, data) for name, data in blobs.items()]
    blobs["PACKAGE.json"] = json_bytes({"schemaVersion": 1, "candidate": ID, "baselineArchiveSha256": BASE["archiveSha256"], "aggregateAlgorithm": ALGORITHM, "payloadAggregateSha256": aggregate(package_rows), "files": sorted(package_rows, key=lambda item: item["path"].encode("utf-8"))})
    output = Path(args.output).resolve()
    for name in (output, Path(str(output) + ".sha256"), Path(str(output) + ".manifest.json")):
        check(not name.exists(), "output/sidecar already exists; never overwrite")
    write_zip(output, blobs)
    size, digest = file_identity(output)
    external = {"schemaVersion": 1, "candidate": ID, "archiveBytes": size, "archiveSha256": digest, "archiveEntryCount": len(blobs), "archiveAggregateSha256": aggregate([row(name, data) for name, data in blobs.items()]), "targetSourceFiles": target["fileCount"], "targetSourceAggregateSha256": target["aggregateSha256"], "files": sorted([row(name, data) for name, data in blobs.items()], key=lambda item: item["path"].encode("utf-8"))}
    with Path(str(output) + ".sha256").open("x", encoding="ascii", newline="\n") as stream:
        stream.write(f"{digest}  {output.name}\n")
    with Path(str(output) + ".manifest.json").open("xb") as stream:
        stream.write(json_bytes(external))
    print(json.dumps({"status": "HANDOFF_PACKAGED_NOT_DEPLOYED", "bytes": size, "sha256": digest, "sourceFiles": target["fileCount"], "sourceAggregateSha256": target["aggregateSha256"]}))


def bundle(args):
    check(file_identity(args.bundle)[1] == args.expected_sha256.lower(), "handoff out-of-band SHA mismatch")
    with zipfile.ZipFile(args.bundle) as archive:
        names = zip_entries(archive)
        blobs = {name: archive.read(name) for name in names}
    package_manifest = json.loads(blobs["PACKAGE.json"])
    check(package_manifest["candidate"] == ID and package_manifest["baselineArchiveSha256"] == BASE["archiveSha256"], "handoff identity mismatch")
    package_rows = package_manifest["files"]
    check(names == {item["path"] for item in package_rows} | {"PACKAGE.json"}, "handoff file-set mismatch")
    check(len(package_rows) == len(names) - 1, "duplicate handoff manifest row")
    check(aggregate(package_rows) == package_manifest["payloadAggregateSha256"], "handoff aggregate mismatch")
    for item in package_rows:
        check(row(item["path"], blobs[item["path"]]) == item, "handoff payload hash mismatch")
    check(json.loads(blobs["BASELINE.json"]) == BASE, "handoff baseline mismatch")
    check(sha(blobs["baseline/SOURCE-MANIFEST.json"]) == BASE["sourceManifestSha256"], "handoff predecessor manifest mismatch")
    candidate = {name: blobs["candidate/" + name] for name in PINS}
    before = {name: blobs["baseline/" + name] for name in BEFORE}
    for name in PINS:
        check(sha(candidate[name]) == PINS[name], "candidate pin mismatch")
    for name in BEFORE:
        check(sha(before[name]) == BEFORE[name], "rollback leaf pin mismatch")
    minimal_delta(before, candidate)
    old_rows = {item["path"]: item for item in json.loads(blobs["baseline/SOURCE-MANIFEST.json"])["files"]}
    check("scripts/test-https-locale-routing.mjs" not in old_rows, "added leaf collision")
    target = json.loads(blobs["target/SOURCE-MANIFEST.json"])
    old_rows.update({name: row(name, data) for name, data in candidate.items()})
    check(target["files"] == sorted(old_rows.values(), key=lambda item: item["path"].encode("utf-8")), "target contains unrelated source changes")
    check(target["fileCount"] == 1269 and target["aggregateSha256"] == aggregate(target["files"]), "target source identity mismatch")
    check(json.loads(blobs["VALIDATION.json"]) == validation_record(), "validation/OOM evidence drift")
    return blobs, target


def verify(args):
    blobs, target = bundle(args)
    baseline_manifest(args.baseline_zip)
    print(json.dumps({"status": "HANDOFF_AND_EXACT_PREDECESSOR_VERIFIED", "sourceFiles": target["fileCount"], "sourceAggregateSha256": target["aggregateSha256"], "fullTreeTypeScript": "UNRESOLVED_OOM_134"}))
    return blobs, target


def compose(args):
    blobs, target = verify(args)
    output = Path(args.output).resolve()
    check(output.suffix == ".zip" and not output.exists(), "compose requires a NEW explicitly named ZIP")
    source_rows = {item["path"]: item for item in target["files"]}
    meta = {".release/SOURCE-MANIFEST.json": blobs["target/SOURCE-MANIFEST.json"], ".release/QUALIFICATION.json": blobs["target/QUALIFICATION.json"]}
    with zipfile.ZipFile(args.baseline_zip) as predecessor, zipfile.ZipFile(output, "x", compression=zipfile.ZIP_STORED) as result:
        for name in sorted(set(source_rows) | META, key=lambda value: value.encode("utf-8")):
            data = meta.get(name) if name in META else blobs.get("candidate/" + name)
            if data is not None:
                result.writestr(metadata(name, len(data)), data)
            else:
                with predecessor.open(name) as incoming, result.open(metadata(name, source_rows[name]["bytes"]), "w") as outgoing:
                    while chunk := incoming.read(1024 * 1024):
                        outgoing.write(chunk)
    with zipfile.ZipFile(output) as result:
        verify_sources(result, target)
        for name, data in meta.items():
            check(result.read(name) == data, "composed release evidence mismatch")
    size, digest = file_identity(output)
    print(json.dumps({"status": "EXACT_SOURCE_COMPOSED_NOT_BUILT_NOT_DEPLOYED", "bytes": size, "sha256": digest, "sourceFiles": target["fileCount"], "sourceAggregateSha256": target["aggregateSha256"], "fullTreeTypeScript": "UNRESOLVED_OOM_134"}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("package", "verify", "compose"):
        command = commands.add_parser(name)
        command.add_argument("--baseline-zip", required=True)
        if name == "package":
            command.add_argument("--source-root", required=True)
        else:
            command.add_argument("--bundle", required=True)
            command.add_argument("--expected-sha256", required=True)
        if name != "verify":
            command.add_argument("--output", required=True)
    args = parser.parse_args()
    {"package": package, "verify": verify, "compose": compose}[args.command](args)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, zipfile.BadZipFile) as error:
        print(f"HANDOFF_FAIL_CLOSED: {error}", file=sys.stderr)
        sys.exit(1)
