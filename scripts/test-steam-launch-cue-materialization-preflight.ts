import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type {
  SteamLaunchCueMaterializationFailureCode,
  SteamLaunchCueMaterializationPreflightResult,
} from "../lib/steam/launchCueMaterializationPreflight";

const CHILD_FLAG = "--p112-launch-cue-materialization-preflight-react-server-child";

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

type ContractModule = typeof import("../lib/steam/launchCueMaterializationPreflight");

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}

function ready(result: SteamLaunchCueMaterializationPreflightResult) {
  assert.equal(
    result.status,
    "PASS_LOCAL_MATERIALIZATION_PREFLIGHT_BLOCKED_CONTENT_REVIEW",
  );
  if (result.status !== "PASS_LOCAL_MATERIALIZATION_PREFLIGHT_BLOCKED_CONTENT_REVIEW") {
    throw new Error("materialization_preflight_not_validated");
  }
  return result.preflight;
}

function assertBlocked(
  result: SteamLaunchCueMaterializationPreflightResult,
  expectedCode?: SteamLaunchCueMaterializationFailureCode,
  label = "hostile input",
): void {
  assert.equal(result.status, "BLOCKED", label);
  if (result.status !== "BLOCKED") throw new Error(`expected_blocked:${label}`);
  if (expectedCode) assert.equal(result.preflight.failureCode, expectedCode, label);
  assert.equal(result.preflight.preflightId, null, label);
  assert.equal(result.preflight.preflightFingerprint, null, label);
  assert.deepEqual(result.preflight.issues, [], label);
  assert.deepEqual(result.preflight.candidateShots, [], label);
  assert.deepEqual(result.preflight.summary, {
    shots: 0,
    reviewRows: 0,
    sourceIncludedSubtitleCues: 0,
    sourceOmittedSubtitleRows: 0,
    contentReviewIssues: 0,
    quarantinedRows: 0,
    candidateSubtitleCues: 0,
    candidateAudioSlots: 0,
    materializedArtifacts: 0,
  });
  assert.deepEqual(result.preflight.sourceBlockerCodes, [
    "source_reference_not_prepared",
    "publishable_workflow_missing",
  ]);
  assert.deepEqual(result.preflight.contentReviewBlockerCodes, []);
  assert.deepEqual(result.preflight.blockerCodes, [
    "source_reference_not_prepared",
    "publishable_workflow_missing",
    "materialization_preflight_unavailable",
  ]);
  for (const key of [
    "materializationAllowed",
    "webVttMaterializationAllowed",
    "audioMaterializationAllowed",
    "ttsMaterializationAllowed",
    "webVttMaterialized",
    "audioAssetsMaterialized",
    "playbackSyncVerified",
    "playbackReady",
    "executionAllowed",
    "jobWriteAllowed",
    "publishAllowed",
    "providerContacted",
    "gpuProbed",
  ] as const) {
    assert.equal(result.preflight[key], false, `${label}:${key}`);
  }
  assert.equal(result.preflight.providerPreparation, "NOT_ATTEMPTED", label);
  assert.equal(result.preflight.providerReferenceHandlesIssued, 0, label);
  assert.equal(result.preflight.networkCalls, 0, label);
  assert.equal(result.preflight.writesPerformed, 0, label);
  assert.equal(result.preflight.releaseGate.satisfied, false, label);
}

function hostile(
  contract: ContractModule,
  source: unknown,
  label: string,
  mutate: (draft: Record<string, unknown>) => void,
  expectedCode?: SteamLaunchCueMaterializationFailureCode,
): void {
  const draft = structuredClone(source) as Record<string, unknown>;
  mutate(draft);
  assertBlocked(contract.deriveSteamLaunchCueMaterializationPreflight(draft), expectedCode, label);
}

function sourceReview(value: Record<string, unknown>): Record<string, unknown> {
  return record(value.review);
}

function sourceShots(value: Record<string, unknown>): unknown[] {
  return array(sourceReview(value).shots);
}

function sourceRows(value: Record<string, unknown>, shotIndex: number): unknown[] {
  return array(record(sourceShots(value)[shotIndex]).rows);
}

function assertNoSensitiveOutput(value: unknown): void {
  const forbiddenKeys = new Set([
    "publicText",
    "text",
    "prompt",
    "negativePrompt",
    "sourceTextVerbatim",
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
      for (const [key, nested] of Object.entries(entry)) {
        assert.equal(forbiddenKeys.has(key), false, `forbidden output key: ${key}`);
        visit(nested);
      }
    }
  };
  visit(value);
}

async function assertStaticBoundary(): Promise<void> {
  const files = [
    new URL("../lib/steam/launchCueMaterializationPreflight.ts", import.meta.url),
    new URL("../lib/steam/launchCueMaterializationPreflightServer.ts", import.meta.url),
  ];
  const sources = await Promise.all(files.map((file) => readFile(file, "utf8")));
  const combined = sources.join("\n");
  for (const forbidden of [
    "node:child_process",
    "node:http",
    "node:https",
    "node:net",
    "node:tls",
    "undici",
    "process.env",
    "writeFile",
    "appendFile",
    "mkdir",
    "rename",
    "unlink",
    "GenerationJob",
    "generation-jobs",
    "gpu-coordinator",
    "providers/comfyui",
    "project-assets",
    "providerTask",
    "fetch(",
    "serializeSteamLaunchCueReviewWebVtt",
  ]) {
    assert.equal(combined.includes(forbidden), false, `forbidden production dependency: ${forbidden}`);
  }
  assert.match(sources[1]!, /readSteamLaunchCueReview/u);
  assert.doesNotMatch(combined, /(?:submit|enqueue|upload|publish)\s*\(/iu);
}

async function run(): Promise<void> {
  let networkCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    networkCalls += 1;
    throw new Error("network_forbidden");
  }) as typeof fetch;
  try {
    const contract = await import("../lib/steam/launchCueMaterializationPreflight");
    const server = await import("../lib/steam/launchCueMaterializationPreflightServer");
    const cueReviewContract = await import("../lib/steam/launchCueReview");
    const cueReviewServer = await import("../lib/steam/launchCueReviewServer");

    const cueReviewResult = await cueReviewServer.readSteamLaunchCueReview();
    assert.equal(cueReviewResult.status, "LOCAL_CUE_ASSIGNMENTS_VALIDATED");
    if (cueReviewResult.status !== "LOCAL_CUE_ASSIGNMENTS_VALIDATED") {
      throw new Error("p111_baseline_not_validated");
    }
    const sourceBefore = cueReviewContract.serializeSteamLaunchCueReviewJson(cueReviewResult);
    const source = structuredClone(cueReviewResult) as Record<string, unknown>;

    const resultOne = await server.readSteamLaunchCueMaterializationPreflight();
    const resultTwo = await server.readSteamLaunchCueMaterializationPreflight();
    const resultInjected = await server.readSteamLaunchCueMaterializationPreflightForTest({
      cueReviewResult,
    });
    const preflight = ready(resultOne);
    const second = ready(resultTwo);
    const injected = ready(resultInjected);
    const jsonOne = contract.serializeSteamLaunchCueMaterializationPreflightJson(resultOne);
    assert.equal(jsonOne, contract.serializeSteamLaunchCueMaterializationPreflightJson(resultTwo));
    assert.equal(jsonOne, contract.serializeSteamLaunchCueMaterializationPreflightJson(resultInjected));
    assert.equal(preflight.preflightFingerprint, second.preflightFingerprint);
    assert.equal(preflight.preflightFingerprint, injected.preflightFingerprint);
    assert.equal(
      preflight.preflightFingerprint,
      "ddbe762fc145284ff1681bc5543ecef34786d3df07ef14b52845a5ca7c240ad8",
    );
    assert.equal(
      preflight.cueReviewOverlayFingerprint,
      "c2b0ba35e8e4def09e59afa8591dbedc5e7ae2e7249562daca29010f0940fca3",
    );
    assert.equal(
      preflight.cueAssignmentFingerprint,
      "e5708c15cbf3416808fd5046b462f19c4d98772814b8ec135b78b8da9e23ebf2",
    );
    assert.equal(
      preflight.reviewPacketFingerprint,
      "fda3ec7088d07225d6486afa38471f4cc88f79e67d3a1506caac2fb894d1c397",
    );
    assert.equal(
      preflight.localIntegrityFingerprint,
      "ac44cd20cf8efa8b9f4305c2fd4ae324c60df8e8a64775b00c8a94dc05c06875",
    );
    assert.deepEqual(preflight.summary, {
      shots: 3,
      reviewRows: 23,
      sourceIncludedSubtitleCues: 12,
      sourceOmittedSubtitleRows: 11,
      contentReviewIssues: 2,
      quarantinedRows: 2,
      candidateSubtitleCues: 10,
      candidateAudioSlots: 10,
      materializedArtifacts: 0,
    });
    assert.deepEqual(preflight.sourceBlockerCodes, [
      "source_reference_not_prepared",
      "publishable_workflow_missing",
    ]);
    assert.deepEqual(preflight.contentReviewBlockerCodes, [
      "subtitle_density_exceeded",
      "editorial_marker_present",
    ]);
    assert.deepEqual(preflight.blockerCodes, [
      "source_reference_not_prepared",
      "publishable_workflow_missing",
      "subtitle_density_exceeded",
      "editorial_marker_present",
    ]);
    assert.equal(preflight.issues.length, 2);
    const density = preflight.issues[0];
    assert.equal(density?.code, "subtitle_density_exceeded");
    if (density?.code !== "subtitle_density_exceeded") throw new Error("density_issue_missing");
    assert.equal(density.paragraphId, "P026");
    assert.equal(density.beatId, "vg11_breakfast_choice_b4");
    assert.equal(density.charCount, 88);
    assert.equal(density.durationMs, 10_000);
    assert.equal(density.observedMilliCodepointsPerSecond, 8_800);
    assert.equal(density.maxMilliCodepointsPerSecond, 7_000);
    assert.equal(density.performanceDirectionPresent, true);
    assert.equal(density.autoSplitAllowed, false);
    assert.equal(density.autoRewriteAllowed, false);
    assert.equal(density.subtitleCandidateAllowed, false);
    assert.equal(density.audioCandidateAllowed, false);
    const editorial = preflight.issues[1];
    assert.equal(editorial?.code, "editorial_marker_present");
    if (editorial?.code !== "editorial_marker_present") {
      throw new Error("editorial_issue_missing");
    }
    assert.equal(editorial.paragraphId, "P034");
    assert.equal(editorial.beatId, "vg11_wake_pull_b4");
    assert.equal(editorial.markerOccurrences, 1);
    assert.equal(editorial.subtitleCandidateAllowed, false);
    assert.equal(editorial.audioCandidateAllowed, false);

    assert.deepEqual(preflight.candidateShots.map((shot) => shot.candidateSubtitleCueCount), [0, 5, 5]);
    assert.deepEqual(preflight.candidateShots.map((shot) => shot.candidateAudioSlotCount), [0, 5, 5]);
    assert.deepEqual(preflight.candidateShots.map((shot) => shot.sourceIncludedCueCount), [0, 6, 6]);
    assert.deepEqual(preflight.candidateShots.map((shot) => shot.sourceOmittedRowCount), [2, 2, 7]);
    assert.deepEqual(preflight.candidateShots.map((shot) => shot.quarantinedRowCount), [0, 1, 1]);
    assert.deepEqual(preflight.candidateShots.map((shot) => shot.candidateWebVttBytes), [8, 667, 646]);
    assert.ok(preflight.candidateShots.every((shot) => shot.roundTripVerified));
    assert.ok(
      preflight.candidateShots.every((shot) =>
        /^[a-f0-9]{64}$/u.test(shot.candidateWebVttSha256),
      ),
    );
    const cueIds = preflight.candidateShots.flatMap((shot) =>
      shot.candidateCueRefs.map((cue) => cue.cueId),
    );
    const slotIds = preflight.candidateShots.flatMap((shot) =>
      shot.candidateAudioSlots.map((slot) => slot.slotId),
    );
    assert.equal(cueIds.length, 10);
    assert.equal(new Set(cueIds).size, 10);
    assert.equal(slotIds.length, 10);
    assert.equal(new Set(slotIds).size, 10);
    const candidateParagraphs = preflight.candidateShots.flatMap((shot) =>
      shot.candidateCueRefs.map((cue) => cue.paragraphId),
    );
    assert.equal(candidateParagraphs.includes("P026"), false);
    assert.equal(candidateParagraphs.includes("P034"), false);
    const candidateAudioParagraphs = preflight.candidateShots.flatMap((shot) =>
      shot.candidateAudioSlots.map((slot) => slot.paragraphId),
    );
    assert.equal(candidateAudioParagraphs.includes("P026"), false);
    assert.equal(candidateAudioParagraphs.includes("P034"), false);
    assert.deepEqual(candidateAudioParagraphs, candidateParagraphs);
    assert.deepEqual(candidateParagraphs, [
      "P023",
      "P024",
      "P025",
      "P027",
      "P028",
      "P033",
      "P035",
      "P039",
      "P040",
      "P041",
    ]);
    for (const key of [
      "candidateOnly",
    ] as const) {
      assert.equal(preflight[key], true);
    }
    for (const key of [
      "candidateSetComplete",
      "materializationAllowed",
      "webVttMaterializationAllowed",
      "audioMaterializationAllowed",
      "ttsMaterializationAllowed",
      "webVttMaterialized",
      "audioAssetsMaterialized",
      "playbackSyncVerified",
      "playbackReady",
      "executionAllowed",
      "jobWriteAllowed",
      "publishAllowed",
      "providerContacted",
      "gpuProbed",
    ] as const) {
      assert.equal(preflight[key], false, key);
    }
    assert.equal(preflight.contentReview.satisfied, false);
    assert.equal(preflight.providerPreparation, "NOT_ATTEMPTED");
    assert.equal(preflight.providerReferenceHandlesIssued, 0);
    assert.equal(preflight.networkCalls, 0);
    assert.equal(preflight.writesPerformed, 0);
    assert.equal(preflight.releaseGate.satisfied, false);

    const sourceP026 = cueReviewResult.review.shots[1]!.rows[3]!.publicText;
    const sourceP034 = cueReviewResult.review.shots[2]!.rows[3]!.publicText;
    assert.equal(jsonOne.includes(sourceP026), false);
    assert.equal(jsonOne.includes(sourceP034), false);
    assert.equal(jsonOne.includes("【彩蛋点】"), false);
    assertNoSensitiveOutput(preflight);
    assertNoSensitiveOutput(JSON.parse(jsonOne));

    assert.equal(88 * 1_000_000 > 7_000 * 10_000, true);
    assert.equal(70 * 1_000_000 > 7_000 * 10_000, false);
    assert.equal(71 * 1_000_000 > 7_000 * 10_000, true);

    hostile(contract, source, "status drift", (draft) => {
      draft.status = "BLOCKED";
    }, "cue_review_unavailable");
    hostile(contract, source, "overlay fingerprint drift", (draft) => {
      sourceReview(draft).overlayFingerprint = "0".repeat(64);
    }, "cue_review_mismatch");
    hostile(contract, source, "summary drift", (draft) => {
      record(sourceReview(draft).summary).includedSubtitleCues = 11;
    }, "cue_review_mismatch");
    hostile(contract, source, "source blocker drift", (draft) => {
      array(sourceReview(draft).blockerCodes).pop();
    }, "cue_review_mismatch");
    hostile(contract, source, "materialized gate drift", (draft) => {
      sourceReview(draft).webVttMaterialized = true;
    }, "unsafe_gate");
    hostile(contract, source, "execution gate drift", (draft) => {
      sourceReview(draft).executionAllowed = true;
    }, "unsafe_gate");
    hostile(contract, source, "runtime write drift", (draft) => {
      sourceReview(draft).writesPerformed = 1;
    }, "unsafe_gate");
    hostile(contract, source, "P026 timing drift", (draft) => {
      record(record(sourceRows(draft, 1)[3]).timing).endMs = 20_499;
    }, "cue_review_mismatch");
    hostile(contract, source, "P034 text drift", (draft) => {
      record(sourceRows(draft, 2)[3]).publicText = "marker removed";
    }, "cue_review_mismatch");
    hostile(contract, source, "nested cue drift", (draft) => {
      const cues = array(record(sourceShots(draft)[1]).subtitleCues);
      record(cues[3]).textHash = "0".repeat(64);
    }, "cue_review_mismatch");
    hostile(contract, source, "root extra", (draft) => {
      draft.extra = true;
    }, "cue_review_unavailable");
    hostile(contract, source, "review accessor", (draft) => {
      Object.defineProperty(sourceReview(draft), "overlayFingerprint", {
        enumerable: true,
        get: () => contract.STEAM_LAUNCH_CUE_MATERIALIZATION_OVERLAY_FINGERPRINT,
      });
    }, "cue_review_mismatch");
    hostile(contract, source, "shot prototype", (draft) => {
      Object.setPrototypeOf(record(sourceShots(draft)[0]), { hostile: true });
    }, "cue_review_mismatch");
    hostile(contract, source, "review symbol", (draft) => {
      Object.defineProperty(sourceReview(draft), Symbol("hostile"), {
        value: true,
        enumerable: true,
      });
    }, "cue_review_mismatch");
    hostile(contract, source, "row array hole", (draft) => {
      delete sourceRows(draft, 1)[3];
    }, "cue_review_mismatch");

    const blockedSource = cueReviewContract.blockedSteamLaunchCueReview("assignments_invalid");
    assertBlocked(
      contract.deriveSteamLaunchCueMaterializationPreflight(blockedSource),
      "cue_review_unavailable",
      "blocked P1.11 source",
    );
    assertBlocked(
      await server.readSteamLaunchCueMaterializationPreflightForTest({ cueReviewResult: null }),
      "cue_review_unavailable",
      "null injected source",
    );

    assert.equal(
      cueReviewContract.serializeSteamLaunchCueReviewJson(cueReviewResult),
      sourceBefore,
    );
    await assertStaticBoundary();
    assert.equal(networkCalls, 0);
    process.stdout.write(
      `steam launch cue materialization preflight tests passed (3/23; 12 include/11 omit; 10 candidates/2 quarantined; preflight=${preflight.preflightFingerprint}; network=0; writes=0)\n`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}
