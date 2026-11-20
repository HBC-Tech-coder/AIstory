import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  SteamLaunchCueReviewPreviewBundleResult,
  SteamLaunchCueReviewPreviewFailureCode,
} from "../lib/steam/launchCueReviewPreviewBundle";
import type {
  SteamLaunchCueReviewPreviewBuildFailureCode,
  SteamLaunchCueReviewPreviewBuildFault,
  SteamLaunchCueReviewPreviewBuildResult,
} from "../lib/steam/launchCueReviewPreviewBundleServer";
import type { SteamLaunchCueMaterializationPreflightResult } from "../lib/steam/launchCueMaterializationPreflight";
import type { SteamLaunchCueReviewResult } from "../lib/steam/launchCueReview";
import type { SteamLaunchReviewPacketResult } from "../lib/steam/launchReviewPacket";
import type { VideoSubtitleCue } from "../lib/video-assets/types";

const CHILD_FLAG = "--p115-steam-launch-cue-review-preview-react-server-child";

if (!process.argv.includes(CHILD_FLAG)) {
  const child = spawnSync(
    process.execPath,
    ["--conditions=react-server", "--import", "tsx", fileURLToPath(import.meta.url), CHILD_FLAG],
    { stdio: "inherit" },
  );
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
} else {
  await run();
}

type ContractModule = typeof import("../lib/steam/launchCueReviewPreviewBundle");

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function ready(result: SteamLaunchCueReviewPreviewBundleResult) {
  assert.equal(result.status, "PRIVATE_REVIEW_ONLY");
  if (result.status !== "PRIVATE_REVIEW_ONLY") throw new Error("preview_not_ready");
  return result.bundle;
}

function assertBlocked(
  result: SteamLaunchCueReviewPreviewBundleResult,
  expected?: SteamLaunchCueReviewPreviewFailureCode,
  label = "hostile source",
): void {
  assert.equal(result.status, "BLOCKED", label);
  if (result.status !== "BLOCKED") throw new Error(`expected_blocked:${label}`);
  if (expected) assert.equal(result.failureCode, expected, label);
  assert.equal(result.bundle, null, label);
  assert.deepEqual(result.sourceBlockerCodes, [
    "source_reference_not_prepared",
    "publishable_workflow_missing",
  ]);
  assert.deepEqual(result.contentBlockerCodes, [
    "subtitle_density_exceeded",
    "editorial_marker_present",
  ]);
  assert.equal(result.contentReview.satisfied, false);
  assert.equal(result.candidateSetComplete, false);
  assert.equal(result.releaseMaterializedArtifacts, 0);
  assert.equal(result.playbackReady, false);
  assert.equal(result.executionAllowed, false);
  assert.equal(result.publishAllowed, false);
  assert.equal(result.releaseGate.satisfied, false);
}

function assertBuildBlocked(
  result: SteamLaunchCueReviewPreviewBuildResult,
  expected: SteamLaunchCueReviewPreviewBuildFailureCode,
  label: string,
): void {
  assert.equal(result.status, "BLOCKED", label);
  if (result.status !== "BLOCKED") throw new Error(`expected_build_blocked:${label}`);
  assert.equal(result.failureCode, expected, label);
  assert.equal(result.receipt, null, label);
  assert.equal(result.privateReviewPackageFilesWritten, 0, label);
  assert.equal(result.releaseMaterializedArtifacts, 0, label);
  assert.equal(result.runtimeWritesPerformed, 0, label);
  assert.equal(result.networkCalls, 0, label);
}

function webVttTimestamp(milliseconds: number): string {
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1_000);
  const remainder = milliseconds % 1_000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(remainder).padStart(3, "0")}`;
}

function serializeWebVtt(cues: VideoSubtitleCue[]): string {
  const blocks = cues.map(
    (cue) => `${cue.id}\n${webVttTimestamp(cue.startMs)} --> ${webVttTimestamp(cue.endMs)}\n${cue.text}`,
  );
  return blocks.length === 0 ? "WEBVTT\n\n" : `WEBVTT\n\n${blocks.join("\n\n")}\n`;
}

function assertSafeProjection(value: unknown): void {
  const forbiddenKeys = new Set([
    "text",
    "publicText",
    "sourceTextVerbatim",
    "prompt",
    "negativePrompt",
    "workflowJson",
    "model",
    "checkpoint",
    "providerTaskId",
    "referenceHandle",
    "token",
    "secret",
    "path",
    "localPath",
    "absolutePath",
    "url",
    "uri",
    "audioBytes",
    "imageBytes",
  ]);
  const visit = (entry: unknown): void => {
    if (typeof entry === "string") {
      assert.doesNotMatch(entry, /(?:https?:|file:|data:|[A-Za-z]:\\|\\\\)/u);
      assert.notEqual(entry, "【彩蛋点】");
      return;
    }
    if (Array.isArray(entry)) {
      entry.forEach(visit);
      return;
    }
    if (entry && typeof entry === "object") {
      for (const [key, child] of Object.entries(entry)) {
        assert.equal(forbiddenKeys.has(key), false, `forbidden public key: ${key}`);
        visit(child);
      }
    }
  };
  visit(value);
}

function quarantineTexts(reviewResult: SteamLaunchCueReviewResult): string[] {
  assert.equal(reviewResult.status, "LOCAL_CUE_ASSIGNMENTS_VALIDATED");
  if (reviewResult.status !== "LOCAL_CUE_ASSIGNMENTS_VALIDATED") return [];
  return reviewResult.review.shots
    .flatMap((shot) => shot.rows)
    .filter((row) => row.paragraphId === "P026" || row.paragraphId === "P034")
    .map((row) => row.publicText);
}

function mutateSource<T>(source: T, mutate: (draft: Record<string, unknown>) => void): unknown {
  const draft = structuredClone(source) as Record<string, unknown>;
  mutate(draft);
  return draft;
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    return !Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
  }
}

async function assertNoStaging(parent: string, targetBasename: string): Promise<void> {
  const entries = await readdir(parent);
  assert.equal(
    entries.some((entry) => entry.startsWith(`.${targetBasename}.p115-staging-`)),
    false,
    `staging residue for ${targetBasename}`,
  );
}

async function safeRemoveTestRoot(root: string, marker: string, junctions: Set<string>): Promise<void> {
  for (const junction of junctions) {
    if (await pathExists(junction)) {
      const stat = await lstat(junction);
      assert.equal(stat.isSymbolicLink(), true, "known test junction identity");
      await unlink(junction);
      assert.equal(await pathExists(junction), false, "known test junction removed");
    }
  }
  const tempParent = await realpath(os.tmpdir());
  const rootReal = await realpath(root);
  const relative = path.relative(tempParent, rootReal);
  assert.ok(relative.startsWith("aistory-p115-preview-test-"));
  assert.equal(relative.includes(path.sep), false);
  const rootStat = await lstat(rootReal);
  assert.equal(rootStat.isDirectory(), true);
  assert.equal(rootStat.isSymbolicLink(), false);
  assert.equal(await readFile(path.join(rootReal, ".p115-test-owner"), "utf8"), marker);
  const scan = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory)) {
      const candidate = path.join(directory, entry);
      const stat = await lstat(candidate);
      assert.equal(stat.isSymbolicLink(), false, "test cleanup refuses reparse entries");
      if (stat.isDirectory()) await scan(candidate);
      else assert.equal(stat.isFile(), true);
    }
  };
  await scan(rootReal);
  await rm(rootReal, { recursive: true, force: false });
  assert.equal(await pathExists(rootReal), false, "owned OS temp root removed");
}

async function assertPackage(
  directory: string,
  contract: ContractModule,
  parseWebVtt: (source: string, durationMs?: number) => VideoSubtitleCue[],
) {
  const entries = (await readdir(directory)).sort();
  assert.deepEqual(entries, [
    contract.STEAM_LAUNCH_CUE_REVIEW_PREVIEW_FILENAMES.breakfast,
    contract.STEAM_LAUNCH_CUE_REVIEW_PREVIEW_FILENAMES.wakePull,
    contract.STEAM_LAUNCH_CUE_REVIEW_PREVIEW_FILENAMES.manifest,
  ].sort());
  assert.equal(entries.some((entry) => entry.includes("SHOT-02")), false);
  const manifestSource = await readFile(
    path.join(directory, contract.STEAM_LAUNCH_CUE_REVIEW_PREVIEW_FILENAMES.manifest),
    "utf8",
  );
  const manifest = JSON.parse(manifestSource) as unknown;
  assert.equal(`${contract.canonicalSteamLaunchCueReviewPreview(manifest)}\n`, manifestSource);
  assertSafeProjection(manifest);
  const parsedManifest = record(manifest);
  assert.equal(parsedManifest.status, "PRIVATE_REVIEW_ONLY");
  assert.equal(parsedManifest.completeness, "INCOMPLETE");
  assert.equal(parsedManifest.publishability, "NON_PUBLISHABLE");
  assert.deepEqual(record(parsedManifest.summary), {
    shots: 3,
    acceptedSubtitleCues: 10,
    quarantinedRows: 2,
    privateWebVttFiles: 2,
    withheldShots: 1,
    packageFiles: 3,
    releaseMaterializedArtifacts: 0,
  });
  const vttFacts = [];
  for (const [basename, bytes, expectedSha] of [
    [contract.STEAM_LAUNCH_CUE_REVIEW_PREVIEW_FILENAMES.breakfast, 667, "f6ba6484974072dafafec50e466b3e27d6cd41a40889551737d1498fc0507e00"],
    [contract.STEAM_LAUNCH_CUE_REVIEW_PREVIEW_FILENAMES.wakePull, 646, "c96635dbc1eddf9be1857228c91be12a8a9bb2f775e3e5fae2f678ded35248f3"],
  ] as const) {
    const filePath = path.join(directory, basename);
    const stat = await lstat(filePath);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.isSymbolicLink(), false);
    if (process.platform !== "win32") assert.equal(stat.mode & 0o777, 0o600);
    const source = await readFile(filePath, "utf8");
    assert.equal(Buffer.byteLength(source, "utf8"), bytes);
    assert.equal(sha256(source), expectedSha);
    assert.equal(source.includes("\r"), false);
    assert.equal(source.startsWith("WEBVTT\n\n"), true);
    const cues = parseWebVtt(source, 30_000);
    assert.equal(cues.length, 5);
    assert.equal(serializeWebVtt(cues), source);
    vttFacts.push({ basename, bytes, sha256: expectedSha, cueCount: cues.length });
  }
  return { entries, manifestSource, vttFacts };
}

async function run(): Promise<void> {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: () => {
      fetchCalls += 1;
      throw new Error("network_forbidden");
    },
  });

  const tempRoot = await mkdtemp(path.join(await realpath(os.tmpdir()), "aistory-p115-preview-test-"));
  const ownerMarker = randomBytes(16).toString("hex");
  await writeFile(path.join(tempRoot, ".p115-test-owner"), ownerMarker, { flag: "wx" });
  const junctions = new Set<string>();
  try {
    const [contract, server, packetServer, reviewServer, preflightServer, validation, buildCliContract] = await Promise.all([
      import("../lib/steam/launchCueReviewPreviewBundle"),
      import("../lib/steam/launchCueReviewPreviewBundleServer"),
      import("../lib/steam/launchReviewPacketServer"),
      import("../lib/steam/launchCueReviewServer"),
      import("../lib/steam/launchCueMaterializationPreflightServer"),
      import("../lib/video-assets/validation"),
      import("./build-steam-launch-cue-review-preview"),
    ]);
    const [reviewPacketResult, cueReviewResult, preflightResult] = await Promise.all([
      packetServer.readSteamLaunchReviewPacket(),
      reviewServer.readSteamLaunchCueReview(),
      preflightServer.readSteamLaunchCueMaterializationPreflight(),
    ]);
    const packet = reviewPacketResult as SteamLaunchReviewPacketResult;
    const review = cueReviewResult as SteamLaunchCueReviewResult;
    const preflight = preflightResult as SteamLaunchCueMaterializationPreflightResult;
    const sourceBefore = [packet, review, preflight].map((entry) =>
      contract.canonicalSteamLaunchCueReviewPreview(entry),
    );

    const first = ready(contract.deriveSteamLaunchCueReviewPreviewBundle(packet, review, preflight));
    const second = ready(contract.deriveSteamLaunchCueReviewPreviewBundle(packet, review, preflight));
    assert.equal(
      first.manifest.bundleFingerprint,
      "2401bffdd1f765e22f1ab1c6222e90ebe6b9442e5823060c73cd79cf5f56b857",
    );
    assert.equal(first.manifest.bundleFingerprint, second.manifest.bundleFingerprint);
    assert.equal(first.manifestJson, second.manifestJson);
    assert.deepEqual(first.files, second.files);
    assert.equal(first.manifest.source.reviewPacketFingerprint, "fda3ec7088d07225d6486afa38471f4cc88f79e67d3a1506caac2fb894d1c397");
    assert.equal(first.manifest.source.cueReviewOverlayFingerprint, "c2b0ba35e8e4def09e59afa8591dbedc5e7ae2e7249562daca29010f0940fca3");
    assert.equal(first.manifest.source.cueAssignmentFingerprint, "e5708c15cbf3416808fd5046b462f19c4d98772814b8ec135b78b8da9e23ebf2");
    assert.equal(first.manifest.source.materializationPreflightFingerprint, "ddbe762fc145284ff1681bc5543ecef34786d3df07ef14b52845a5ca7c240ad8");
    assert.equal(first.files.length, 3);
    assert.equal(first.files.filter((file) => file.kind === "webvtt").length, 2);
    const manifestFile = first.files.find((file) => file.kind === "manifest");
    assert.deepEqual(
      manifestFile && { bytes: manifestFile.bytes, sha256: manifestFile.sha256 },
      {
        bytes: 2_963,
        sha256: "884c3826b7c2c405394d81128171b4f28b528d7146eb661c89abe98df0535d1d",
      },
    );
    assert.equal(first.files.some((file) => file.basename.includes("SHOT-02")), false);
    assert.equal(first.manifest.withheldShots[0]?.reasonCode, "no_accepted_subtitle_candidates");
    assert.deepEqual(first.manifest.quarantinedRows.map((entry) => entry.paragraphId), ["P026", "P034"]);
    assertSafeProjection(first.manifest);
    const quarantined = quarantineTexts(review);
    assert.equal(quarantined.length, 2);
    for (const privateText of quarantined) {
      for (const file of first.files) assert.equal(file.content.includes(privateText), false);
    }
    for (const file of first.files) assert.equal(file.content.includes("【彩蛋点】"), false);
    assert.equal(
      buildCliContract.validateSteamLaunchCueReviewPreviewChildReceiptForTest(
        `${JSON.stringify({
          schema: "aistory-steam-launch-cue-review-preview-receipt",
          status: "PRIVATE_REVIEW_BUNDLE_WRITTEN",
          message: quarantined[0],
        })}\n`,
        0,
      ),
      null,
      "forged success receipt cannot add private text",
    );
    assert.equal(
      buildCliContract.validateSteamLaunchCueReviewPreviewChildReceiptForTest(
        `${JSON.stringify({
          schema: "aistory-steam-launch-cue-review-preview-build-receipt",
          schemaVersion: 1,
          status: "BLOCKED",
          failureCode: "preview_build_unavailable",
          privateReviewPackageFilesWritten: 0,
          releaseMaterializedArtifacts: 0,
          runtimeWritesPerformed: 0,
          networkCalls: 0,
          sourceTextVerbatim: quarantined[1],
        })}\n`,
        1,
      ),
      null,
      "forged blocked receipt cannot add private text",
    );

    const outputA = path.join(tempRoot, "bundle-a");
    const outputB = path.join(tempRoot, "bundle-b");
    for (const outputDirectory of [outputA, outputB]) {
      const built = await server.buildSteamLaunchCueReviewPreviewBundleForTest({
        outputDirectory,
        reviewPacketResult: packet,
        cueReviewResult: review,
        materializationPreflightResult: preflight,
      });
      assert.equal(built.status, "PRIVATE_REVIEW_BUNDLE_WRITTEN");
      if (built.status !== "PRIVATE_REVIEW_BUNDLE_WRITTEN") throw new Error("build_not_ready");
      assert.equal(built.privateReviewPackageFilesWritten, 3);
      assert.equal(built.releaseMaterializedArtifacts, 0);
      assert.equal(built.runtimeWritesPerformed, 0);
      assert.equal(built.networkCalls, 0);
      assertSafeProjection(built.receipt);
    }
    const factsA = await assertPackage(outputA, contract, validation.parseWebVtt);
    const factsB = await assertPackage(outputB, contract, validation.parseWebVtt);
    assert.deepEqual(factsA.entries, factsB.entries);
    for (const basename of factsA.entries) {
      assert.deepEqual(await readFile(path.join(outputA, basename)), await readFile(path.join(outputB, basename)));
    }

    const hostile = (
      label: string,
      packetInput: unknown,
      reviewInput: unknown,
      preflightInput: unknown,
      expected?: SteamLaunchCueReviewPreviewFailureCode,
    ) => assertBlocked(
      contract.deriveSteamLaunchCueReviewPreviewBundle(packetInput, reviewInput, preflightInput),
      expected,
      label,
    );
    hostile(
      "packet nested drift",
      mutateSource(packet, (draft) => {
        const packetValue = record(draft.packet);
        record(packetValue.summary).shots = 4;
      }),
      review,
      preflight,
      "review_packet_mismatch",
    );
    hostile(
      "review nested cue drift",
      packet,
      mutateSource(review, (draft) => {
        const reviewValue = record(draft.review);
        const shot = record(array(reviewValue.shots)[1]);
        const cue = record(array(shot.subtitleCues)[0]);
        cue.startMs = 1;
      }),
      preflight,
      "cue_review_mismatch",
    );
    hostile(
      "preflight nested candidate drift",
      packet,
      review,
      mutateSource(preflight, (draft) => {
        const preflightValue = record(draft.preflight);
        const shot = record(array(preflightValue.candidateShots)[1]);
        const cue = record(array(shot.candidateCueRefs)[0]);
        cue.rowHash = "0".repeat(64);
      }),
      "materialization_preflight_mismatch",
    );
    const accessorReview: Record<string, unknown> = { review: record(review).review };
    let accessorCalls = 0;
    Object.defineProperty(accessorReview, "status", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return "LOCAL_CUE_ASSIGNMENTS_VALIDATED";
      },
    });
    hostile("accessor", packet, accessorReview, preflight, "cue_review_unavailable");
    assert.equal(accessorCalls, 0);
    const customPrototype = structuredClone(preflight) as Record<string, unknown>;
    Object.setPrototypeOf(customPrototype, { hostile: true });
    hostile("custom prototype", packet, review, customPrototype, "materialization_preflight_unavailable");
    const symbolReview = structuredClone(review) as Record<string | symbol, unknown>;
    symbolReview[Symbol("hostile")] = true;
    hostile("symbol", packet, symbolReview, preflight, "cue_review_unavailable");
    const holePreflight = structuredClone(preflight) as Record<string, unknown>;
    delete array(record(holePreflight.preflight).candidateShots)[1];
    hostile("array hole", packet, review, holePreflight, "materialization_preflight_mismatch");

    const defaultNames = [
      contract.STEAM_LAUNCH_CUE_REVIEW_PREVIEW_FILENAMES.manifest,
      contract.STEAM_LAUNCH_CUE_REVIEW_PREVIEW_FILENAMES.breakfast,
      contract.STEAM_LAUNCH_CUE_REVIEW_PREVIEW_FILENAMES.wakePull,
    ];
    for (const unsafe of ["../x.vtt", "/x.vtt", "C:\\x.vtt", "\\\\host\\x.vtt", "file:x.vtt", "x:y.vtt", "CON", "trail.", "trail "]) {
      assertBlocked(
        contract.deriveSteamLaunchCueReviewPreviewBundle(packet, review, preflight, [defaultNames[0]!, unsafe, defaultNames[2]!]),
        "package_filename_invalid",
        `unsafe filename ${unsafe}`,
      );
    }
    assertBlocked(
      contract.deriveSteamLaunchCueReviewPreviewBundle(packet, review, preflight, ["manifest.json", "same.vtt", "SAME.VTT"]),
      "package_filename_invalid",
      "casefold duplicate filename",
    );
    assertBlocked(
      contract.deriveSteamLaunchCueReviewPreviewBundle(packet, review, preflight, defaultNames.slice(0, 2)),
      "package_filename_invalid",
      "missing filename",
    );
    const hostileNames = [...defaultNames];
    Object.setPrototypeOf(hostileNames, { hostile: true });
    assertBlocked(
      contract.deriveSteamLaunchCueReviewPreviewBundle(packet, review, preflight, hostileNames),
      "package_filename_invalid",
      "filename prototype",
    );

    const existingDirectory = path.join(tempRoot, "existing-directory");
    await mkdir(existingDirectory);
    assertBuildBlocked(
      await server.buildSteamLaunchCueReviewPreviewBundleForTest({
        outputDirectory: existingDirectory,
        reviewPacketResult: packet,
        cueReviewResult: review,
        materializationPreflightResult: preflight,
      }),
      "output_target_exists",
      "existing directory",
    );
    const existingFile = path.join(tempRoot, "existing-file");
    await writeFile(existingFile, "foreign", { flag: "wx" });
    assertBuildBlocked(
      await server.buildSteamLaunchCueReviewPreviewBundleForTest({
        outputDirectory: existingFile,
        reviewPacketResult: packet,
        cueReviewResult: review,
        materializationPreflightResult: preflight,
      }),
      "output_target_exists",
      "existing file",
    );
    assert.equal(await readFile(existingFile, "utf8"), "foreign");

    const junctionTarget = path.join(tempRoot, "junction-target");
    const targetJunction = path.join(tempRoot, "target-junction");
    await mkdir(junctionTarget);
    await writeFile(path.join(junctionTarget, "foreign-sentinel"), "foreign", { flag: "wx" });
    await symlink(junctionTarget, targetJunction, "junction");
    junctions.add(targetJunction);
    assertBuildBlocked(
      await server.buildSteamLaunchCueReviewPreviewBundleForTest({
        outputDirectory: targetJunction,
        reviewPacketResult: packet,
        cueReviewResult: review,
        materializationPreflightResult: preflight,
      }),
      "output_reparse_forbidden",
      "target junction",
    );
    assert.equal(await readFile(path.join(junctionTarget, "foreign-sentinel"), "utf8"), "foreign");
    await unlink(targetJunction);
    junctions.delete(targetJunction);

    const realParent = path.join(tempRoot, "real-parent");
    const parentJunction = path.join(tempRoot, "parent-junction");
    await mkdir(realParent);
    await writeFile(path.join(realParent, "foreign-sentinel"), "foreign", { flag: "wx" });
    await symlink(realParent, parentJunction, "junction");
    junctions.add(parentJunction);
    assertBuildBlocked(
      await server.buildSteamLaunchCueReviewPreviewBundleForTest({
        outputDirectory: path.join(parentJunction, "bundle"),
        reviewPacketResult: packet,
        cueReviewResult: review,
        materializationPreflightResult: preflight,
      }),
      "output_reparse_forbidden",
      "parent junction",
    );
    assert.equal(await readFile(path.join(realParent, "foreign-sentinel"), "utf8"), "foreign");
    await unlink(parentJunction);
    junctions.delete(parentJunction);

    assertBuildBlocked(
      await server.buildSteamLaunchCueReviewPreviewBundleForTest({
        outputDirectory: path.join(tempRoot, "missing-parent", "bundle"),
        reviewPacketResult: packet,
        cueReviewResult: review,
        materializationPreflightResult: preflight,
      }),
      "output_parent_invalid",
      "missing parent",
    );
    assertBuildBlocked(
      await server.buildSteamLaunchCueReviewPreviewBundleForTest({
        outputDirectory: "relative-output",
        reviewPacketResult: packet,
        cueReviewResult: review,
        materializationPreflightResult: preflight,
      }),
      "output_arguments_invalid",
      "relative output",
    );
    for (const unsafeOutput of [
      "\\\\host\\share\\bundle",
      "\\\\?\\C:\\temp\\bundle",
      "\\\\.\\C:\\temp\\bundle",
      "\\root-relative",
      "C:\\temp:stream\\bundle",
      "C:\\CON\\bundle",
      "C:\\trailing.\\bundle",
    ]) {
      assertBuildBlocked(
        await server.buildSteamLaunchCueReviewPreviewBundleForTest({
          outputDirectory: unsafeOutput,
          reviewPacketResult: packet,
          cueReviewResult: review,
          materializationPreflightResult: preflight,
        }),
        "output_arguments_invalid",
        `unsafe output namespace ${unsafeOutput}`,
      );
    }
    assertBuildBlocked(
      await server.buildSteamLaunchCueReviewPreviewBundleForTest({
        outputDirectory: path.join(process.cwd(), ".p115-repo-forbidden"),
        reviewPacketResult: packet,
        cueReviewResult: review,
        materializationPreflightResult: preflight,
      }),
      "output_forbidden",
      "repository output forbidden",
    );
    assertBuildBlocked(
      await server.buildSteamLaunchCueReviewPreviewBundleForTest({
        outputDirectory: path.join(tempRoot, ".aistory-p115-forbidden"),
        reviewPacketResult: packet,
        cueReviewResult: review,
        materializationPreflightResult: preflight,
      }),
      "output_forbidden",
      "aistory output forbidden",
    );

    for (const fault of [
      "after_first_write",
      "after_second_write",
      "after_manifest_write",
      "inject_extra_entry",
      "before_rename",
    ] as SteamLaunchCueReviewPreviewBuildFault[]) {
      const target = path.join(tempRoot, `fault-${fault.replaceAll("_", "-")}`);
      const result = await server.buildSteamLaunchCueReviewPreviewBundleForTest({
        outputDirectory: target,
        reviewPacketResult: packet,
        cueReviewResult: review,
        materializationPreflightResult: preflight,
        fault,
      });
      assertBuildBlocked(
        result,
        fault === "before_rename"
          ? "package_rename_failed"
          : fault === "inject_extra_entry"
            ? "package_verify_failed"
            : "package_write_failed",
        fault,
      );
      assert.equal(await pathExists(target), false, `${fault}: no partial target`);
      await assertNoStaging(tempRoot, path.basename(target));
    }

    const buildScript = fileURLToPath(new URL("./build-steam-launch-cue-review-preview.ts", import.meta.url));
    for (const args of [
      [],
      ["--unknown", "x"],
      ["--output-dir"],
      ["--output-dir", "relative"],
      ["--output-dir", "\\\\host\\share\\bundle"],
      ["--output-dir", "\\\\?\\C:\\temp\\bundle"],
      ["--output-dir", "\\root-relative"],
      ["--output-dir", "C:\\temp:stream\\bundle"],
      ["--output-dir", "C:\\CON\\bundle"],
      ["--output-dir", outputA, "--output-dir", outputB],
    ]) {
      const child = spawnSync(process.execPath, ["--import", "tsx", buildScript, ...args], {
        encoding: "utf8",
      });
      assert.equal(child.status, 1, `CLI hostile args: ${args.join(" ")}`);
      assert.equal(child.stderr, "");
      const receipt = JSON.parse(child.stdout.trim()) as Record<string, unknown>;
      assert.equal(receipt.status, "BLOCKED");
      assert.equal(receipt.failureCode, "output_arguments_invalid");
      assertSafeProjection(receipt);
    }
    const existingCli = spawnSync(
      process.execPath,
      ["--import", "tsx", buildScript, "--output-dir", outputA],
      { encoding: "utf8" },
    );
    assert.equal(existingCli.status, 1);
    assert.equal(existingCli.stderr, "");
    assert.equal(existingCli.stdout.includes(outputA), false);
    assert.equal(record(JSON.parse(existingCli.stdout.trim())).failureCode, "output_target_exists");

    const bootstrapFailure = spawnSync(
      process.execPath,
      ["--no-warnings", buildScript, "--output-dir", path.join(tempRoot, "bootstrap-failure")],
      { cwd: await realpath(os.tmpdir()), encoding: "utf8" },
    );
    assert.equal(bootstrapFailure.status, 1);
    assert.equal(bootstrapFailure.stderr, "");
    const bootstrapReceipt = record(JSON.parse(bootstrapFailure.stdout.trim()));
    assert.equal(bootstrapReceipt.status, "BLOCKED");
    assert.equal(bootstrapReceipt.failureCode, "preview_build_unavailable");
    assert.equal(bootstrapFailure.stdout.includes(tempRoot), false);
    assertSafeProjection(bootstrapReceipt);
    const cliOutput = path.join(tempRoot, "cli-output");
    const cli = spawnSync(process.execPath, ["--import", "tsx", buildScript, "--output-dir", cliOutput], {
      encoding: "utf8",
    });
    assert.equal(cli.status, 0, cli.stdout);
    assert.equal(cli.stderr, "");
    assert.equal(cli.stdout.includes(cliOutput), false);
    assert.equal(
      buildCliContract.validateSteamLaunchCueReviewPreviewChildReceiptForTest(cli.stdout, 0),
      cli.stdout,
    );
    const cliReceipt = JSON.parse(cli.stdout.trim()) as unknown;
    assertSafeProjection(cliReceipt);
    assert.equal(record(cliReceipt).status, "PRIVATE_REVIEW_BUNDLE_WRITTEN");
    await assertPackage(cliOutput, contract, validation.parseWebVtt);

    const sourceAfter = [packet, review, preflight].map((entry) =>
      contract.canonicalSteamLaunchCueReviewPreview(entry),
    );
    assert.deepEqual(sourceAfter, sourceBefore, "source DTOs remain byte-stable");

    const [pureSource, serverSource, cliSource] = await Promise.all([
      readFile(fileURLToPath(new URL("../lib/steam/launchCueReviewPreviewBundle.ts", import.meta.url)), "utf8"),
      readFile(fileURLToPath(new URL("../lib/steam/launchCueReviewPreviewBundleServer.ts", import.meta.url)), "utf8"),
      readFile(buildScript, "utf8"),
    ]);
    for (const [label, source] of [["pure", pureSource], ["server", serverSource]] as const) {
      for (const pattern of [
        /node:(?:http|https|net|tls|dgram|dns)/u,
        /\bundici\b/u,
        /\bfetch\s*\(/u,
        /process\.env/u,
        /generation-jobs/u,
        /gpu-coordinator/u,
        /providers\/comfyui/u,
        /project-assets/u,
        /providerTask/u,
        /\b(?:submit|enqueue|upload|publish)\w*\s*\(/u,
      ]) {
        assert.doesNotMatch(source, pattern, `${label} static zero-side-effect gate`);
      }
    }
    assert.doesNotMatch(cliSource, /process\.env|node:(?:http|https|net|tls)|\bfetch\s*\(/u);
    assert.equal(fetchCalls, 0);
    process.stdout.write(
      `steam launch cue private review preview tests passed (3 shots/10 accepted/2 quarantined; bundle=${first.manifest.bundleFingerprint}; privateFiles=3; releaseArtifacts=0; network=0)\n`,
    );
  } finally {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: originalFetch,
    });
    await safeRemoveTestRoot(tempRoot, ownerMarker, junctions);
  }
}
