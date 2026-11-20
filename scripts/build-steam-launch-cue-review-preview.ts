import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { SteamLaunchCueReviewPreviewBuildResult } from "../lib/steam/launchCueReviewPreviewBundleServer";

const CHILD_FLAG = "--p115-steam-launch-cue-review-preview-react-server-child";

type ParsedArguments = { outputDirectory: string };

function isSafeLocalDrivePathSyntax(value: string): boolean {
  if (!/^[A-Za-z]:\\/u.test(value) || /^[\\/]{2}/u.test(value)) return false;
  return value.slice(3).split("\\").every(
    (segment) =>
      segment !== "." &&
      segment !== ".." &&
      !segment.includes(":") &&
      !/[. ]$/u.test(segment) &&
      !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(segment),
  );
}

export function parseSteamLaunchCueReviewPreviewBuildArguments(args: readonly string[]): ParsedArguments {
  if (args.length !== 2 || args[0] !== "--output-dir") {
    throw new Error("preview_cli_arguments_invalid");
  }
  const outputDirectory = args[1];
  if (
    typeof outputDirectory !== "string" ||
    outputDirectory.includes("\0") ||
    !isSafeLocalDrivePathSyntax(outputDirectory) ||
    !path.isAbsolute(outputDirectory) ||
    path.normalize(outputDirectory) !== outputDirectory
  ) {
    throw new Error("preview_cli_arguments_invalid");
  }
  return { outputDirectory };
}

function exactRecord(value: unknown, expectedKeys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
    ? record
    : null;
}

function validSuccessReceipt(value: unknown): boolean {
  const receipt = exactRecord(value, [
    "schema",
    "schemaVersion",
    "status",
    "bundleFingerprint",
    "summary",
    "files",
    "contentReview",
    "candidateSetComplete",
    "releaseMaterializedArtifacts",
    "playbackReady",
    "executionAllowed",
    "publishAllowed",
    "releaseGate",
  ]);
  if (
    !receipt ||
    receipt.schema !== "aistory-steam-launch-cue-review-preview-receipt" ||
    receipt.schemaVersion !== 1 ||
    receipt.status !== "PRIVATE_REVIEW_BUNDLE_WRITTEN" ||
    receipt.bundleFingerprint !== "2401bffdd1f765e22f1ab1c6222e90ebe6b9442e5823060c73cd79cf5f56b857" ||
    receipt.candidateSetComplete !== false ||
    receipt.releaseMaterializedArtifacts !== 0 ||
    receipt.playbackReady !== false ||
    receipt.executionAllowed !== false ||
    receipt.publishAllowed !== false
  ) {
    return false;
  }
  const summary = exactRecord(receipt.summary, [
    "shots",
    "acceptedSubtitleCues",
    "quarantinedRows",
    "privateWebVttFiles",
    "withheldShots",
    "packageFiles",
  ]);
  const contentReview = exactRecord(receipt.contentReview, ["satisfied"]);
  const releaseGate = exactRecord(receipt.releaseGate, ["satisfied"]);
  if (
    !summary ||
    summary.shots !== 3 ||
    summary.acceptedSubtitleCues !== 10 ||
    summary.quarantinedRows !== 2 ||
    summary.privateWebVttFiles !== 2 ||
    summary.withheldShots !== 1 ||
    summary.packageFiles !== 3 ||
    contentReview?.satisfied !== false ||
    releaseGate?.satisfied !== false ||
    !Array.isArray(receipt.files) ||
    receipt.files.length !== 3
  ) {
    return false;
  }
  const expectedFiles = [
    {
      basename: "VG11-SHOT-04.private-review.zh-CN.vtt",
      kind: "webvtt",
      bytes: 667,
      sha256: "f6ba6484974072dafafec50e466b3e27d6cd41a40889551737d1498fc0507e00",
    },
    {
      basename: "VG11-SHOT-05.private-review.zh-CN.vtt",
      kind: "webvtt",
      bytes: 646,
      sha256: "c96635dbc1eddf9be1857228c91be12a8a9bb2f775e3e5fae2f678ded35248f3",
    },
    {
      basename: "steam-launch-subtitle-private-review-manifest.v1.json",
      kind: "manifest",
      bytes: 2_963,
      sha256: "884c3826b7c2c405394d81128171b4f28b528d7146eb661c89abe98df0535d1d",
    },
  ];
  return receipt.files.every((entry, index) => {
    const file = exactRecord(entry, ["basename", "kind", "bytes", "sha256"]);
    const expected = expectedFiles[index]!;
    return Boolean(
      file &&
      file.basename === expected.basename &&
      file.kind === expected.kind &&
      file.bytes === expected.bytes &&
      file.sha256 === expected.sha256,
    );
  });
}

const BLOCKED_FAILURE_CODES = new Set([
  "source_unavailable",
  "source_mismatch",
  "output_arguments_invalid",
  "output_parent_invalid",
  "output_target_exists",
  "output_reparse_forbidden",
  "output_forbidden",
  "package_filename_invalid",
  "package_write_failed",
  "package_verify_failed",
  "package_rename_failed",
  "package_cleanup_failed",
  "preview_build_unavailable",
]);

function validBlockedReceipt(value: unknown): boolean {
  const receipt = exactRecord(value, [
    "schema",
    "schemaVersion",
    "status",
    "failureCode",
    "privateReviewPackageFilesWritten",
    "releaseMaterializedArtifacts",
    "runtimeWritesPerformed",
    "networkCalls",
  ]);
  return Boolean(
    receipt &&
    receipt.schema === "aistory-steam-launch-cue-review-preview-build-receipt" &&
    receipt.schemaVersion === 1 &&
    receipt.status === "BLOCKED" &&
    typeof receipt.failureCode === "string" &&
    BLOCKED_FAILURE_CODES.has(receipt.failureCode) &&
    receipt.privateReviewPackageFilesWritten === 0 &&
    receipt.releaseMaterializedArtifacts === 0 &&
    receipt.runtimeWritesPerformed === 0 &&
    receipt.networkCalls === 0,
  );
}

export function validateSteamLaunchCueReviewPreviewChildReceiptForTest(
  source: string,
  exitCode: number | null,
): string | null {
  if (source.length < 3 || source.length > 64 * 1024 || !source.endsWith("\n")) return null;
  const body = source.slice(0, -1);
  if (body.includes("\n") || body.includes("\r")) return null;
  let value: unknown;
  try {
    value = JSON.parse(body) as unknown;
  } catch {
    return null;
  }
  return (exitCode === 0 ? validSuccessReceipt(value) : validBlockedReceipt(value))
    ? source
    : null;
}

function blockedReceipt(failureCode: string): string {
  return `${JSON.stringify({
    schema: "aistory-steam-launch-cue-review-preview-build-receipt",
    schemaVersion: 1,
    status: "BLOCKED",
    failureCode,
    privateReviewPackageFilesWritten: 0,
    releaseMaterializedArtifacts: 0,
    runtimeWritesPerformed: 0,
    networkCalls: 0,
  })}\n`;
}

async function runChild(args: readonly string[]): Promise<number> {
  try {
    const parsed = parseSteamLaunchCueReviewPreviewBuildArguments(args);
    const [{ buildSteamLaunchCueReviewPreviewBundle }, { serializeSteamLaunchCueReviewPreviewReceipt }] =
      await Promise.all([
        import("../lib/steam/launchCueReviewPreviewBundleServer"),
        import("../lib/steam/launchCueReviewPreviewBundle"),
      ]);
    const result: SteamLaunchCueReviewPreviewBuildResult =
      await buildSteamLaunchCueReviewPreviewBundle(parsed.outputDirectory);
    if (result.status === "BLOCKED") {
      process.stdout.write(blockedReceipt(result.failureCode));
      return 1;
    }
    process.stdout.write(serializeSteamLaunchCueReviewPreviewReceipt(result.receipt));
    return 0;
  } catch (error) {
    const failureCode =
      error instanceof Error && error.message === "preview_cli_arguments_invalid"
        ? "output_arguments_invalid"
        : "preview_build_unavailable";
    process.stdout.write(blockedReceipt(failureCode));
    return 1;
  }
}

const currentScript = fileURLToPath(import.meta.url);
const isDirectExecution =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]).toLocaleLowerCase("en-US") ===
    path.resolve(currentScript).toLocaleLowerCase("en-US");

if (isDirectExecution) {
  const childIndex = process.argv.indexOf(CHILD_FLAG);
  if (childIndex < 0) {
    const child = spawnSync(
      process.execPath,
      [
        "--conditions=react-server",
        "--import",
        "tsx",
        currentScript,
        CHILD_FLAG,
        ...process.argv.slice(2),
      ],
      { encoding: "utf8", windowsHide: true },
    );
    const forwarded =
      child.error || child.signal
        ? null
        : validateSteamLaunchCueReviewPreviewChildReceiptForTest(child.stdout ?? "", child.status);
    if (forwarded === null) {
      process.stdout.write(blockedReceipt("preview_build_unavailable"));
      process.exitCode = 1;
    } else {
      process.stdout.write(forwarded);
      process.exitCode = child.status === 0 ? 0 : 1;
    }
  } else {
    process.exitCode = await runChild(process.argv.slice(childIndex + 1));
  }
}
