import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type {
  SteamLaunchCueReviewFailureCode,
  SteamLaunchCueReviewResult,
} from "../lib/steam/launchCueReview";

const CHILD_FLAG = "--p111-launch-cue-review-react-server-child";

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

type ContractModule = typeof import("../lib/steam/launchCueReview");

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}

function assignmentShots(value: unknown): unknown[] {
  return array(record(value).shots);
}

function shotRows(value: unknown, shotIndex: number): unknown[] {
  return array(record(assignmentShots(value)[shotIndex]).rows);
}

function assignmentRow(value: unknown, shotIndex: number, rowIndex: number): Record<string, unknown> {
  return record(shotRows(value, shotIndex)[rowIndex]);
}

function ready(result: SteamLaunchCueReviewResult) {
  assert.equal(result.status, "LOCAL_CUE_ASSIGNMENTS_VALIDATED");
  if (result.status !== "LOCAL_CUE_ASSIGNMENTS_VALIDATED") throw new Error("cue_review_not_ready");
  return result.review;
}

function assertBlocked(
  contract: ContractModule,
  basePacket: unknown,
  assignments: unknown,
  expectedCode?: SteamLaunchCueReviewFailureCode,
  label = "hostile input",
): void {
  const result = contract.deriveSteamLaunchCueReview(basePacket, assignments, (value) => sha256(value));
  assert.equal(result.status, "BLOCKED", label);
  if (result.status !== "BLOCKED") throw new Error(`expected_blocked:${label}`);
  assert.equal(result.review.overlayId, null, label);
  assert.equal(result.review.overlayFingerprint, null, label);
  assert.equal(result.review.assignmentFingerprint, null, label);
  assert.deepEqual(result.review.shots, [], label);
  assert.deepEqual(result.review.summary, {
    shots: 0,
    reviewRows: 0,
    choices: 0,
    referenceBindings: 0,
    uniqueAssets: 0,
    narratorRows: 0,
    characterRows: 0,
    nonSpokenRows: 0,
    logicalAudioSlots: 0,
    includedSubtitleCues: 0,
    omittedSubtitleRows: 0,
    timedRows: 0,
  });
  assert.deepEqual(result.review.sourceBlockerCodes, [
    "source_reference_not_prepared",
    "publishable_workflow_missing",
    "manual_cue_review_required",
  ]);
  assert.deepEqual(result.review.blockerCodes, [
    "source_reference_not_prepared",
    "publishable_workflow_missing",
    "manual_cue_review_required",
  ]);
  assert.deepEqual(result.review.removedOverlayBlockerCodes, []);
  assert.equal(result.review.audioAssetsMaterialized, false);
  assert.equal(result.review.webVttMaterialized, false);
  assert.equal(result.review.playbackReady, false);
  assert.equal(result.review.executionAllowed, false);
  assert.equal(result.review.jobWriteAllowed, false);
  assert.equal(result.review.publishAllowed, false);
  assert.equal(result.review.providerPreparation, "NOT_ATTEMPTED");
  assert.equal(result.review.providerContacted, false);
  assert.equal(result.review.providerReferenceHandlesIssued, 0);
  assert.equal(result.review.gpuProbed, false);
  assert.equal(result.review.networkCalls, 0);
  assert.equal(result.review.writesPerformed, 0);
  assert.equal(result.review.releaseGate.satisfied, false);
  assert.equal(contract.serializeSteamLaunchCueReviewWebVtt(result, "vg11_wake_choice"), null);
  if (expectedCode) assert.equal(result.review.failureCode, expectedCode, label);
}

function hostileAssignments(
  contract: ContractModule,
  basePacket: unknown,
  assignments: unknown,
  label: string,
  mutate: (draft: unknown) => void,
  expectedCode?: SteamLaunchCueReviewFailureCode,
): void {
  const draft = structuredClone(assignments);
  mutate(draft);
  assertBlocked(contract, basePacket, draft, expectedCode, label);
}

function hostilePacket(
  contract: ContractModule,
  basePacket: unknown,
  assignments: unknown,
  label: string,
  mutate: (draft: unknown) => void,
  expectedCode?: SteamLaunchCueReviewFailureCode,
): void {
  const draft = structuredClone(basePacket);
  mutate(draft);
  assertBlocked(contract, draft, assignments, expectedCode, label);
}

function assertRedacted(value: unknown): void {
  const forbiddenKeys = new Set([
    "absolutePath",
    "assetId",
    "data",
    "imageBytes",
    "localPath",
    "mediaBytes",
    "mediaUrl",
    "model",
    "negativePrompt",
    "path",
    "preparedReference",
    "preparedReferences",
    "prompt",
    "providerHandle",
    "providerTaskId",
    "referenceHandle",
    "referenceToken",
    "secret",
    "sourceTextVerbatim",
    "token",
    "uri",
    "url",
    "workflowJson",
  ]);
  const visit = (entry: unknown): void => {
    if (typeof entry === "string") {
      assert.doesNotMatch(entry, /(?:file:|https?:\/\/|data:(?:image|audio|video)|[A-Za-z]:\\|\\\\)/iu);
      return;
    }
    if (entry === null || typeof entry !== "object") return;
    if (Array.isArray(entry)) {
      entry.forEach(visit);
      return;
    }
    for (const [key, nested] of Object.entries(entry)) {
      assert.equal(forbiddenKeys.has(key), false, `forbidden output key: ${key}`);
      visit(nested);
    }
  };
  visit(value);
}

function assertTimingAndCoverage(result: ReturnType<typeof ready>): void {
  let rows = 0;
  let cues = 0;
  for (const shot of result.shots) {
    let previousEnd = 0;
    for (const row of shot.rows) {
      rows += 1;
      if (row.subtitle.kind === "include") {
        assert.equal(row.speaker.kind, "narrator");
        assert.equal(row.audio.kind, "logical_slot");
        assert.equal(row.timing.kind, "range");
        if (row.timing.kind !== "range") throw new Error("missing_range");
        assert.ok(row.timing.startMs >= previousEnd);
        assert.ok(row.timing.endMs > row.timing.startMs);
        assert.ok(row.timing.endMs <= 30_000);
        previousEnd = row.timing.endMs;
        cues += 1;
      } else {
        assert.equal(row.speaker.kind, "none");
        assert.equal(row.audio.kind, "none");
        assert.equal(row.timing.kind, "none");
      }
    }
    assert.equal(shot.subtitleCues.length, shot.rows.filter((row) => row.subtitle.kind === "include").length);
    for (const cue of shot.subtitleCues) {
      assert.equal("speaker" in cue, false, "narrator cues must not fabricate a character speaker");
    }
  }
  assert.equal(rows, 23);
  assert.equal(cues, 12);
}

async function assertStaticBoundary(): Promise<void> {
  const files = [
    "lib/steam/launchCueAssignments.v1.json",
    "lib/steam/launchCueReview.ts",
    "lib/steam/launchCueReviewServer.ts",
  ];
  const sources = await Promise.all(files.map((file) => readFile(file, "utf8")));
  const productionSource = sources.slice(1).join("\n");
  const forbiddenProduction = [
    /node:(?:http|https|net|tls|child_process)/u,
    /\bundici\b/u,
    /\bfetch\s*\(/u,
    /process\.env/u,
    /mapSteamVideoGenerationSpecToCreateRequest/u,
    /generation-jobs/u,
    /project-assets/u,
    /video-assets/u,
    /gpu-coordinator/u,
    /providers\/comfyui/u,
    /(?:Connector|ComfyUI)/u,
    /\b(?:writeFile|appendFile|mkdir|rm|rename|unlink)\s*\(/u,
    /\b(?:submit|enqueue|upload|publish)\w*\s*\(/u,
  ];
  for (const pattern of forbiddenProduction) assert.doesNotMatch(productionSource, pattern);
  const assignmentSource = sources[0]!;
  for (const marker of [
    "UNASSIGNED",
    "assetId",
    "providerHandle",
    "providerTaskId",
    "referenceToken",
    "workflowJson",
    "prompt",
    "secret",
    "http://",
    "https://",
    "file:",
    "data:image",
  ]) {
    assert.equal(assignmentSource.includes(marker), false, `assignment redline marker: ${marker}`);
  }
}

async function run(): Promise<void> {
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = (async () => {
    networkCalls += 1;
    throw new Error("network_forbidden_in_launch_cue_review_test");
  }) as typeof fetch;
  try {
    const [contract, server, baseServer] = await Promise.all([
      import("../lib/steam/launchCueReview"),
      import("../lib/steam/launchCueReviewServer"),
      import("../lib/steam/launchReviewPacketServer"),
    ]);
    const assignmentBytes = await readFile("lib/steam/launchCueAssignments.v1.json");
    assert.equal(assignmentBytes.byteLength, server.STEAM_LAUNCH_CUE_ASSIGNMENTS_FILE.bytes);
    assert.equal(sha256(assignmentBytes), server.STEAM_LAUNCH_CUE_ASSIGNMENTS_FILE.sha256);
    const assignments = await server.readSteamLaunchCueAssignmentsForTest();
    assert.ok(assignments);
    const basePacket = await baseServer.readSteamLaunchReviewPacket();
    assert.equal(basePacket.status, "LOCAL_REVIEW_PACKET_READY");
    if (basePacket.status !== "LOCAL_REVIEW_PACKET_READY") throw new Error("base_packet_blocked");
    assert.equal(
      basePacket.packet.packetFingerprint,
      contract.STEAM_LAUNCH_CUE_REVIEW_BASE_PACKET_FINGERPRINT,
    );
    assert.deepEqual(basePacket.packet.summary, {
      shots: 3,
      reviewRows: 23,
      choices: 5,
      referenceBindings: 12,
      uniqueAssets: 6,
    });
    assert.deepEqual(basePacket.packet.blockerCodes, [
      "source_reference_not_prepared",
      "publishable_workflow_missing",
      "manual_cue_review_required",
    ]);
    const baseBefore = JSON.stringify(basePacket);
    const first = await server.readSteamLaunchCueReview();
    const second = await server.readSteamLaunchCueReview();
    const review = ready(first);
    assert.deepEqual(second, first);
    assert.equal(review.assignmentFingerprint, contract.STEAM_LAUNCH_CUE_ASSIGNMENTS_FINGERPRINT);
    assert.equal(
      review.overlayFingerprint,
      "c2b0ba35e8e4def09e59afa8591dbedc5e7ae2e7249562daca29010f0940fca3",
    );
    assert.deepEqual(review.summary, {
      shots: 3,
      reviewRows: 23,
      choices: 5,
      referenceBindings: 12,
      uniqueAssets: 6,
      narratorRows: 12,
      characterRows: 0,
      nonSpokenRows: 11,
      logicalAudioSlots: 12,
      includedSubtitleCues: 12,
      omittedSubtitleRows: 11,
      timedRows: 12,
    });
    assert.deepEqual(review.sourceBlockerCodes, [
      "source_reference_not_prepared",
      "publishable_workflow_missing",
      "manual_cue_review_required",
    ]);
    assert.deepEqual(review.blockerCodes, [
      "source_reference_not_prepared",
      "publishable_workflow_missing",
    ]);
    assert.deepEqual(review.removedOverlayBlockerCodes, ["manual_cue_review_required"]);
    assert.equal(review.audioAssetsMaterialized, false);
    assert.equal(review.webVttMaterialized, false);
    assert.equal(review.playbackReady, false);
    assert.equal(review.executionAllowed, false);
    assert.equal(review.jobWriteAllowed, false);
    assert.equal(review.publishAllowed, false);
    assert.equal(review.providerPreparation, "NOT_ATTEMPTED");
    assert.equal(review.providerContacted, false);
    assert.equal(review.providerReferenceHandlesIssued, 0);
    assert.equal(review.gpuProbed, false);
    assert.equal(review.networkCalls, 0);
    assert.equal(review.writesPerformed, 0);
    assert.equal(review.releaseGate.satisfied, false);
    assertTimingAndCoverage(review);
    assert.equal(JSON.stringify(basePacket), baseBefore, "overlay must not mutate P1.10");
    for (const shot of basePacket.packet.shots) {
      for (const row of shot.rows) {
        assert.equal(row.assignment.speaker.status, "UNASSIGNED");
        assert.equal(row.assignment.audio.status, "UNASSIGNED");
        assert.equal(row.assignment.subtitle.status, "UNASSIGNED");
        assert.equal(row.assignment.timing.status, "UNASSIGNED");
      }
    }

    const jsonOne = contract.serializeSteamLaunchCueReviewJson(first);
    const jsonTwo = contract.serializeSteamLaunchCueReviewJson(second);
    assert.equal(jsonOne, jsonTwo);
    assert.equal(jsonOne.endsWith("\n"), true);
    assertRedacted(JSON.parse(jsonOne));
    const wakeVtt = contract.serializeSteamLaunchCueReviewWebVtt(first, "vg11_wake_choice");
    const breakfastVtt = contract.serializeSteamLaunchCueReviewWebVtt(
      first,
      "vg11_breakfast_choice",
    );
    const pullVtt = contract.serializeSteamLaunchCueReviewWebVtt(first, "vg11_wake_pull");
    assert.equal(wakeVtt, "WEBVTT\n\n");
    assert.ok(breakfastVtt);
    assert.ok(pullVtt);
    assert.equal((breakfastVtt!.match(/ --> /gu) ?? []).length, 6);
    assert.equal((pullVtt!.match(/ --> /gu) ?? []).length, 6);
    assert.match(breakfastVtt!, /00:00:00\.000 --> 00:00:03\.500/u);
    assert.match(breakfastVtt!, /00:00:23\.500 --> 00:00:30\.000/u);
    assert.match(pullVtt!, /00:00:22\.000 --> 00:00:30\.000/u);
    assert.doesNotMatch(`${wakeVtt}${breakfastVtt}${pullVtt}`, /(?:UNASSIGNED|provider|token|secret|workflow|https?:\/\/|file:)/iu);
    assert.equal(
      contract.serializeSteamLaunchCueReviewWebVtt(first, "unknown-node"),
      null,
    );
    assert.equal(
      contract.serializeSteamLaunchCueReviewWebVtt(first, "vg11_breakfast_choice"),
      breakfastVtt,
    );

    hostileAssignments(contract, basePacket, assignments, "wrong base fingerprint", (draft) => {
      record(draft).reviewPacketFingerprint = "0".repeat(64);
    }, "assignments_invalid");
    hostileAssignments(contract, basePacket, assignments, "missing shot", (draft) => {
      assignmentShots(draft).pop();
    }, "assignment_coverage_mismatch");
    hostileAssignments(contract, basePacket, assignments, "extra shot", (draft) => {
      assignmentShots(draft).push(structuredClone(assignmentShots(draft)[0]));
    }, "assignment_coverage_mismatch");
    hostileAssignments(contract, basePacket, assignments, "reordered shots", (draft) => {
      assignmentShots(draft).reverse();
    }, "assignment_row_mismatch");
    hostileAssignments(contract, basePacket, assignments, "missing row", (draft) => {
      shotRows(draft, 1).pop();
    }, "assignment_coverage_mismatch");
    hostileAssignments(contract, basePacket, assignments, "duplicate row", (draft) => {
      shotRows(draft, 1)[1] = structuredClone(shotRows(draft, 1)[0]);
    }, "assignment_row_mismatch");
    hostileAssignments(contract, basePacket, assignments, "extra row", (draft) => {
      shotRows(draft, 1).push(structuredClone(shotRows(draft, 1)[0]));
    }, "assignment_coverage_mismatch");
    for (const [field, value] of [
      ["rowIndex", 99],
      ["paragraphId", "P999"],
      ["beatId", "wrong-beat"],
      ["rowHash", "0".repeat(64)],
      ["publicTextHash", "0".repeat(64)],
    ] as const) {
      hostileAssignments(contract, basePacket, assignments, `row ${field} drift`, (draft) => {
        assignmentRow(draft, 1, 0)[field] = value;
      }, "assignment_row_mismatch");
    }
    hostileAssignments(contract, basePacket, assignments, "unknown speaker", (draft) => {
      assignmentRow(draft, 1, 0).speaker = { kind: "character", characterId: "guessed-person" };
    }, "assignment_speaker_invalid");
    hostileAssignments(contract, basePacket, assignments, "speaker extra", (draft) => {
      record(assignmentRow(draft, 1, 0).speaker).displayName = "private";
    }, "assignment_speaker_invalid");
    hostileAssignments(contract, basePacket, assignments, "audio asset injection", (draft) => {
      record(assignmentRow(draft, 1, 0).audio).assetId = "forbidden";
    }, "assignment_audio_invalid");
    hostileAssignments(contract, basePacket, assignments, "duplicate slot", (draft) => {
      const firstAudio = record(assignmentRow(draft, 1, 0).audio);
      record(assignmentRow(draft, 1, 1).audio).slotId = firstAudio.slotId;
    }, "assignment_audio_invalid");
    hostileAssignments(contract, basePacket, assignments, "subtitle text drift", (draft) => {
      record(assignmentRow(draft, 1, 0).subtitle).text = "tampered public cue";
    }, "assignment_subtitle_invalid");
    hostileAssignments(contract, basePacket, assignments, "subtitle self-consistent drift", (draft) => {
      const subtitle = record(assignmentRow(draft, 1, 0).subtitle);
      subtitle.text = "tampered public cue";
      subtitle.textHash = sha256("tampered public cue");
    }, "assignment_subtitle_invalid");
    hostileAssignments(contract, basePacket, assignments, "duplicate cue", (draft) => {
      const firstSubtitle = record(assignmentRow(draft, 1, 0).subtitle);
      record(assignmentRow(draft, 1, 1).subtitle).cueId = firstSubtitle.cueId;
    }, "assignment_subtitle_invalid");
    hostileAssignments(contract, basePacket, assignments, "include without timing", (draft) => {
      assignmentRow(draft, 1, 0).timing = { kind: "none", reasonCode: "subtitle_omitted" };
    }, "assignment_subtitle_invalid");
    hostileAssignments(contract, basePacket, assignments, "omit with logical audio", (draft) => {
      assignmentRow(draft, 0, 0).audio = {
        kind: "logical_slot",
        slotId: "slca1-hostile-omit",
      };
    }, "assignment_subtitle_invalid");
    for (const [label, mutate] of [
      ["negative timing", (timing: Record<string, unknown>) => { timing.startMs = -1; }],
      ["negative zero timing", (timing: Record<string, unknown>) => { timing.startMs = -0; }],
      ["fractional timing", (timing: Record<string, unknown>) => { timing.startMs = 0.5; }],
      ["empty timing", (timing: Record<string, unknown>) => { timing.endMs = timing.startMs; }],
      ["oversize timing", (timing: Record<string, unknown>) => { timing.endMs = 30_001; }],
    ] as const) {
      hostileAssignments(contract, basePacket, assignments, label, (draft) => {
        mutate(record(assignmentRow(draft, 1, 0).timing));
      }, "assignment_timing_invalid");
    }
    hostileAssignments(contract, basePacket, assignments, "overlap", (draft) => {
      record(assignmentRow(draft, 1, 1).timing).startMs = 3000;
    }, "assignment_timing_invalid");
    hostileAssignments(contract, basePacket, assignments, "root extra", (draft) => {
      record(draft).extra = true;
    }, "assignments_invalid");
    hostileAssignments(contract, basePacket, assignments, "row accessor", (draft) => {
      Object.defineProperty(assignmentRow(draft, 1, 0), "rowHash", {
        enumerable: true,
        get: () => "0".repeat(64),
      });
    }, "assignment_row_mismatch");
    hostileAssignments(contract, basePacket, assignments, "row prototype", (draft) => {
      Object.setPrototypeOf(assignmentRow(draft, 1, 0), { hostile: true });
    }, "assignment_row_mismatch");
    hostileAssignments(contract, basePacket, assignments, "root symbol", (draft) => {
      Object.defineProperty(record(draft), Symbol("hostile"), { value: true, enumerable: true });
    }, "assignments_invalid");
    hostileAssignments(contract, basePacket, assignments, "array hole", (draft) => {
      delete shotRows(draft, 1)[0];
    }, "assignment_coverage_mismatch");
    hostileAssignments(contract, basePacket, assignments, "array prototype", (draft) => {
      Object.setPrototypeOf(shotRows(draft, 1), Object.create(Array.prototype));
    }, "assignment_coverage_mismatch");

    hostilePacket(contract, basePacket, assignments, "packet fingerprint drift", (draft) => {
      record(record(draft).packet).packetFingerprint = "0".repeat(64);
    }, "review_packet_mismatch");
    hostilePacket(contract, basePacket, assignments, "packet count drift", (draft) => {
      record(record(record(draft).packet).summary).reviewRows = 22;
    }, "review_packet_mismatch");
    hostilePacket(contract, basePacket, assignments, "packet row hash drift", (draft) => {
      const packet = record(draft).packet;
      const shots = array(record(packet).shots);
      const rows = array(record(shots[1]).rows);
      record(rows[0]).rowHash = "0".repeat(64);
    }, "review_packet_mismatch");
    hostilePacket(contract, basePacket, assignments, "packet nested cue drift", (draft) => {
      const packet = record(draft).packet;
      const shots = array(record(packet).shots);
      const rows = array(record(shots[0]).rows);
      record(rows[0]).nextKind = "choice";
    }, "review_packet_mismatch");
    hostilePacket(contract, basePacket, assignments, "packet nested asset drift", (draft) => {
      const packet = record(draft).packet;
      const assets = array(record(packet).assets);
      record(assets[0]).bytes = 1;
    }, "review_packet_mismatch");
    hostilePacket(contract, basePacket, assignments, "packet blocker drift", (draft) => {
      array(record(record(draft).packet).blockerCodes).pop();
    }, "review_packet_mismatch");
    hostilePacket(contract, basePacket, assignments, "packet execution gate", (draft) => {
      record(record(draft).packet).executionAllowed = true;
    }, "unsafe_gate");
    hostilePacket(contract, basePacket, assignments, "packet local status", (draft) => {
      record(record(record(draft).packet).localIntegrity).status = "BLOCKED";
    }, "review_packet_mismatch");

    const corruptedBytes = Uint8Array.from(assignmentBytes);
    const corruptedIndex = corruptedBytes.length - 2;
    corruptedBytes[corruptedIndex] = corruptedBytes[corruptedIndex]! ^ 1;
    const corrupted = await server.readSteamLaunchCueReviewForTest({
      assignmentBytes: corruptedBytes,
      reviewPacketResult: basePacket,
    });
    assert.equal(corrupted.status, "BLOCKED");
    if (corrupted.status !== "BLOCKED") throw new Error("corrupted_assignment_accepted");
    assert.equal(corrupted.review.failureCode, "assignments_unavailable");
    assertRedacted(corrupted.review);

    assertRedacted(review);
    assertRedacted(JSON.parse(jsonOne));
    await assertStaticBoundary();
    assert.equal(networkCalls, 0);
    process.stdout.write(
      `steam launch cue review tests passed (3/23/5; 12 include/11 omit; assignment=${review.assignmentFingerprint}; overlay=${review.overlayFingerprint}; network=0; writes=0)\n`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}
