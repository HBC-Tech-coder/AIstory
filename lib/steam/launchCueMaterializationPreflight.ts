import "server-only";

import { createHash } from "node:crypto";

import {
  STEAM_LAUNCH_CUE_ASSIGNMENTS_FINGERPRINT,
  STEAM_LAUNCH_CUE_REVIEW_BASE_PACKET_FINGERPRINT,
  STEAM_LAUNCH_CUE_REVIEW_MODE,
  STEAM_LAUNCH_CUE_REVIEW_REMAINING_BLOCKERS,
  STEAM_LAUNCH_CUE_REVIEW_SCHEMA,
  STEAM_LAUNCH_CUE_REVIEW_SCHEMA_VERSION,
} from "@/lib/steam/launchCueReview";
import {
  STEAM_LAUNCH_REVIEW_LOCAL_INTEGRITY_FINGERPRINT,
  STEAM_LAUNCH_REVIEW_TARGETS,
} from "@/lib/steam/launchReviewPacket";
import {
  parseWebVtt,
  validateSubtitleCues,
} from "@/lib/video-assets/validation";
import type { VideoSubtitleCue } from "@/lib/video-assets/types";

export const STEAM_LAUNCH_CUE_MATERIALIZATION_PREFLIGHT_SCHEMA =
  "aistory-steam-launch-cue-materialization-preflight" as const;
export const STEAM_LAUNCH_CUE_MATERIALIZATION_PREFLIGHT_SCHEMA_VERSION = 1 as const;
export const STEAM_LAUNCH_CUE_MATERIALIZATION_PREFLIGHT_MODE =
  "local_materialization_preflight_only" as const;
export const STEAM_LAUNCH_CUE_MATERIALIZATION_PREFLIGHT_STATUS =
  "PASS_LOCAL_MATERIALIZATION_PREFLIGHT_BLOCKED_CONTENT_REVIEW" as const;
export const STEAM_LAUNCH_CUE_MATERIALIZATION_OVERLAY_FINGERPRINT =
  "c2b0ba35e8e4def09e59afa8591dbedc5e7ae2e7249562daca29010f0940fca3" as const;
export const STEAM_LAUNCH_CUE_MAX_SUBTITLE_MILLI_CODEPOINTS_PER_SECOND = 7_000 as const;
export const STEAM_LAUNCH_CUE_WINDOW_END_MS = 30_000 as const;

export const STEAM_LAUNCH_CUE_MATERIALIZATION_SOURCE_BLOCKERS = Object.freeze([
  "source_reference_not_prepared",
  "publishable_workflow_missing",
] as const);
export const STEAM_LAUNCH_CUE_MATERIALIZATION_CONTENT_BLOCKERS = Object.freeze([
  "subtitle_density_exceeded",
  "editorial_marker_present",
] as const);

const EDITORIAL_MARKER = "【彩蛋点】";
const EDITORIAL_MARKER_SHA256 =
  "286fac7809f79b601f9c71ec6be3170c4642faf019365c4fac26ad6a479ad816";
const PERFORMANCE_DIRECTION_SEGMENT_SHA256 =
  "9083745e4f0b98ab090008c49984c319edc7ac2a61860652e3d9fb1da4a6e6cc";

const CONTENT_ROW_PINS = Object.freeze({
  dense: Object.freeze({
    nodeId: "vg11_breakfast_choice",
    shotId: "VG11-SHOT-04",
    rowIndex: 4,
    paragraphId: "P026",
    beatId: "vg11_breakfast_choice_b4",
    rowHash: "cb0f6dedeab5f263756375507e79b05f118a8686b7d34fc51ef07eb7641209e6",
    textHash: "0427e110c656d5b2459c6b191436890e779610a21bce6d49c7aefaed2ce606a4",
    charCount: 88,
    startMs: 10_500,
    endMs: 20_500,
    performanceDirectionStart: 37,
    performanceDirectionEnd: 62,
  }),
  editorial: Object.freeze({
    nodeId: "vg11_wake_pull",
    shotId: "VG11-SHOT-05",
    rowIndex: 4,
    paragraphId: "P034",
    beatId: "vg11_wake_pull_b4",
    rowHash: "20f406c3929945bafa35ee80d630defec08fb54be61c99d98314fc5b9291de85",
    textHash: "04fae9d74cc4a1fed30834365f9adf4983e5614f3ba6a8a14bd7c21963521639",
    charCount: 23,
    startMs: 3_500,
    endMs: 7_500,
    markerStart: 17,
    markerEnd: 22,
  }),
} as const);

export type SteamLaunchCueMaterializationFailureCode =
  | "cue_review_unavailable"
  | "cue_review_mismatch"
  | "content_policy_mismatch"
  | "candidate_round_trip_invalid"
  | "unsafe_gate";

export type SteamLaunchCueMaterializationIssue =
  | {
      code: "subtitle_density_exceeded";
      nodeId: string;
      shotId: string;
      rowIndex: number;
      paragraphId: string;
      beatId: string;
      rowHash: string;
      publicTextHash: string;
      charCount: number;
      durationMs: number;
      observedMilliCodepointsPerSecond: number;
      maxMilliCodepointsPerSecond: typeof STEAM_LAUNCH_CUE_MAX_SUBTITLE_MILLI_CODEPOINTS_PER_SECOND;
      performanceDirectionPresent: true;
      autoSplitAllowed: false;
      autoRewriteAllowed: false;
      subtitleCandidateAllowed: false;
      audioCandidateAllowed: false;
    }
  | {
      code: "editorial_marker_present";
      nodeId: string;
      shotId: string;
      rowIndex: number;
      paragraphId: string;
      beatId: string;
      rowHash: string;
      publicTextHash: string;
      markerOccurrences: 1;
      markerEvidenceSha256: typeof EDITORIAL_MARKER_SHA256;
      subtitleCandidateAllowed: false;
      audioCandidateAllowed: false;
    };

export type SteamLaunchCueMaterializationCandidateShot = {
  nodeId: string;
  shotId: string;
  sourceIncludedCueCount: number;
  sourceOmittedRowCount: number;
  quarantinedRowCount: number;
  candidateSubtitleCueCount: number;
  candidateAudioSlotCount: number;
  candidateWebVttBytes: number;
  candidateWebVttSha256: string;
  roundTripVerified: true;
  candidateCueRefs: Array<{
    cueId: string;
    rowIndex: number;
    paragraphId: string;
    beatId: string;
    rowHash: string;
    publicTextHash: string;
    startMs: number;
    endMs: number;
  }>;
  candidateAudioSlots: Array<{
    slotId: string;
    rowIndex: number;
    paragraphId: string;
    beatId: string;
    rowHash: string;
    publicTextHash: string;
    startMs: number;
    endMs: number;
  }>;
};

type SteamLaunchCueMaterializationSummary = {
  shots: number;
  reviewRows: number;
  sourceIncludedSubtitleCues: number;
  sourceOmittedSubtitleRows: number;
  contentReviewIssues: number;
  quarantinedRows: number;
  candidateSubtitleCues: number;
  candidateAudioSlots: number;
  materializedArtifacts: number;
};

export type SteamLaunchCueMaterializationPreflightValidated = {
  schema: typeof STEAM_LAUNCH_CUE_MATERIALIZATION_PREFLIGHT_SCHEMA;
  schemaVersion: typeof STEAM_LAUNCH_CUE_MATERIALIZATION_PREFLIGHT_SCHEMA_VERSION;
  mode: typeof STEAM_LAUNCH_CUE_MATERIALIZATION_PREFLIGHT_MODE;
  status: typeof STEAM_LAUNCH_CUE_MATERIALIZATION_PREFLIGHT_STATUS;
  preflightId: string;
  preflightFingerprint: string;
  cueReviewOverlayFingerprint: typeof STEAM_LAUNCH_CUE_MATERIALIZATION_OVERLAY_FINGERPRINT;
  cueAssignmentFingerprint: typeof STEAM_LAUNCH_CUE_ASSIGNMENTS_FINGERPRINT;
  reviewPacketFingerprint: typeof STEAM_LAUNCH_CUE_REVIEW_BASE_PACKET_FINGERPRINT;
  localIntegrityFingerprint: typeof STEAM_LAUNCH_REVIEW_LOCAL_INTEGRITY_FINGERPRINT;
  language: "zh-CN";
  summary: SteamLaunchCueMaterializationSummary;
  issues: SteamLaunchCueMaterializationIssue[];
  candidateShots: SteamLaunchCueMaterializationCandidateShot[];
  sourceBlockerCodes: ["source_reference_not_prepared", "publishable_workflow_missing"];
  contentReviewBlockerCodes: ["subtitle_density_exceeded", "editorial_marker_present"];
  blockerCodes: [
    "source_reference_not_prepared",
    "publishable_workflow_missing",
    "subtitle_density_exceeded",
    "editorial_marker_present",
  ];
  contentReview: { satisfied: false };
  candidateOnly: true;
  candidateSetComplete: false;
  materializationAllowed: false;
  webVttMaterializationAllowed: false;
  audioMaterializationAllowed: false;
  ttsMaterializationAllowed: false;
  webVttMaterialized: false;
  audioAssetsMaterialized: false;
  playbackSyncVerified: false;
  playbackReady: false;
  executionAllowed: false;
  jobWriteAllowed: false;
  publishAllowed: false;
  providerPreparation: "NOT_ATTEMPTED";
  providerContacted: false;
  providerReferenceHandlesIssued: 0;
  gpuProbed: false;
  networkCalls: 0;
  writesPerformed: 0;
  releaseGate: { satisfied: false };
};

export type SteamLaunchCueMaterializationPreflightBlocked = {
  schema: typeof STEAM_LAUNCH_CUE_MATERIALIZATION_PREFLIGHT_SCHEMA;
  schemaVersion: typeof STEAM_LAUNCH_CUE_MATERIALIZATION_PREFLIGHT_SCHEMA_VERSION;
  mode: typeof STEAM_LAUNCH_CUE_MATERIALIZATION_PREFLIGHT_MODE;
  status: "BLOCKED";
  preflightId: null;
  preflightFingerprint: null;
  cueReviewOverlayFingerprint: typeof STEAM_LAUNCH_CUE_MATERIALIZATION_OVERLAY_FINGERPRINT;
  cueAssignmentFingerprint: typeof STEAM_LAUNCH_CUE_ASSIGNMENTS_FINGERPRINT;
  reviewPacketFingerprint: typeof STEAM_LAUNCH_CUE_REVIEW_BASE_PACKET_FINGERPRINT;
  localIntegrityFingerprint: typeof STEAM_LAUNCH_REVIEW_LOCAL_INTEGRITY_FINGERPRINT;
  failureCode: SteamLaunchCueMaterializationFailureCode;
  language: "zh-CN";
  summary: SteamLaunchCueMaterializationSummary;
  issues: [];
  candidateShots: [];
  sourceBlockerCodes: ["source_reference_not_prepared", "publishable_workflow_missing"];
  contentReviewBlockerCodes: [];
  blockerCodes: [
    "source_reference_not_prepared",
    "publishable_workflow_missing",
    "materialization_preflight_unavailable",
  ];
  contentReview: { satisfied: false };
  candidateOnly: true;
  candidateSetComplete: false;
  materializationAllowed: false;
  webVttMaterializationAllowed: false;
  audioMaterializationAllowed: false;
  ttsMaterializationAllowed: false;
  webVttMaterialized: false;
  audioAssetsMaterialized: false;
  playbackSyncVerified: false;
  playbackReady: false;
  executionAllowed: false;
  jobWriteAllowed: false;
  publishAllowed: false;
  providerPreparation: "NOT_ATTEMPTED";
  providerContacted: false;
  providerReferenceHandlesIssued: 0;
  gpuProbed: false;
  networkCalls: 0;
  writesPerformed: 0;
  releaseGate: { satisfied: false };
};

export type SteamLaunchCueMaterializationPreflightResult =
  | {
      status: typeof STEAM_LAUNCH_CUE_MATERIALIZATION_PREFLIGHT_STATUS;
      preflight: SteamLaunchCueMaterializationPreflightValidated;
    }
  | { status: "BLOCKED"; preflight: SteamLaunchCueMaterializationPreflightBlocked };

type DataRecord = Record<string, unknown>;

type ParsedRow = {
  nodeId: string;
  shotId: string;
  rowIndex: number;
  paragraphId: string;
  beatId: string;
  rowHash: string;
  publicTextHash: string;
  publicText: string;
  charCount: number;
  speakerKind: "narrator" | "none";
  slotId: string | null;
  cueId: string | null;
  startMs: number | null;
  endMs: number | null;
  included: boolean;
};

class MaterializationPreflightFailure extends Error {
  constructor(readonly code: SteamLaunchCueMaterializationFailureCode) {
    super(code);
  }
}

function fail(code: SteamLaunchCueMaterializationFailureCode): never {
  throw new MaterializationPreflightFailure(code);
}

function asciiCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  code: SteamLaunchCueMaterializationFailureCode,
): DataRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) fail(code);
  const actual = (keys as string[]).sort(asciiCompare);
  const expected = [...expectedKeys].sort(asciiCompare);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(code);
  }
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail(code);
  }
  return value as DataRecord;
}

function exactArray(
  value: unknown,
  code: SteamLaunchCueMaterializationFailureCode,
): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail(code);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) fail(code);
  const expected = [
    ...Array.from({ length: value.length }, (_, index) => String(index)),
    "length",
  ].sort(asciiCompare);
  const actual = (keys as string[]).sort(asciiCompare);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(code);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail(code);
  }
  return value;
}

function discriminant(
  value: unknown,
  code: SteamLaunchCueMaterializationFailureCode,
): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string")) fail(code);
  const descriptor = Object.getOwnPropertyDescriptor(value, "kind");
  if (
    !descriptor ||
    !("value" in descriptor) ||
    !descriptor.enumerable ||
    typeof descriptor.value !== "string"
  ) {
    fail(code);
  }
  return descriptor.value;
}

function exactString(
  value: unknown,
  expected: string,
  code: SteamLaunchCueMaterializationFailureCode,
): string {
  if (value !== expected) fail(code);
  return expected;
}

function exactBoolean(
  value: unknown,
  expected: boolean,
  code: SteamLaunchCueMaterializationFailureCode,
): boolean {
  if (value !== expected) fail(code);
  return expected;
}

function exactInteger(
  value: unknown,
  expected: number,
  code: SteamLaunchCueMaterializationFailureCode,
): number {
  if (!Number.isSafeInteger(value) || Object.is(value, -0) || value !== expected) fail(code);
  return expected;
}

function integer(
  value: unknown,
  code: SteamLaunchCueMaterializationFailureCode,
): number {
  if (!Number.isSafeInteger(value) || Object.is(value, -0)) fail(code);
  return value as number;
}

function hash64(value: unknown, code: SteamLaunchCueMaterializationFailureCode): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) fail(code);
  return value;
}

function safeText(value: unknown, code: SteamLaunchCueMaterializationFailureCode): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 500) fail(code);
  if (
    value.trim() !== value ||
    /[<>\r\n]/u.test(value) ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u2028\u2029]/u.test(value) ||
    value.includes("-->")
  ) {
    fail(code);
  }
  return value;
}

function exactStringArray(
  value: unknown,
  expected: readonly string[],
  code: SteamLaunchCueMaterializationFailureCode,
): string[] {
  const entries = exactArray(value, code);
  if (entries.length !== expected.length) fail(code);
  return entries.map((entry, index) => exactString(entry, expected[index]!, code));
}

function canonical(value: unknown, seen = new Set<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw new Error("canonical_invalid");
    return String(value);
  }
  if (typeof value !== "object" || seen.has(value)) throw new Error("canonical_invalid");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${exactArray(value, "cue_review_mismatch")
        .map((entry) => canonical(entry, seen))
        .join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("canonical_invalid");
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) throw new Error("canonical_invalid");
    return `{${(keys as string[])
      .sort(asciiCompare)
      .map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          throw new Error("canonical_invalid");
        }
        return `${JSON.stringify(key)}:${canonical(descriptor.value, seen)}`;
      })
      .join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function digest(value: unknown): string {
  return sha256(canonical(value));
}

function webVttTimestamp(milliseconds: number): string {
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1_000);
  const remainder = milliseconds % 1_000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(remainder).padStart(3, "0")}`;
}

function serializeCandidateWebVtt(cues: VideoSubtitleCue[]): string {
  const blocks = cues.map(
    (cue) =>
      `${cue.id}\n${webVttTimestamp(cue.startMs)} --> ${webVttTimestamp(cue.endMs)}\n${cue.text}`,
  );
  return blocks.length === 0 ? "WEBVTT\n\n" : `WEBVTT\n\n${blocks.join("\n\n")}\n`;
}

function candidateCuesMatch(left: VideoSubtitleCue[], right: VideoSubtitleCue[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (cue, index) =>
        cue.id === right[index]?.id &&
        cue.startMs === right[index]?.startMs &&
        cue.endMs === right[index]?.endMs &&
        cue.text === right[index]?.text &&
        cue.speaker === undefined &&
        right[index]?.speaker === undefined,
    )
  );
}

function parseReview(input: unknown): {
  review: DataRecord;
  shots: Array<{ nodeId: string; shotId: string; rows: ParsedRow[] }>;
} {
  const wrapper = exactRecord(input, ["status", "review"], "cue_review_unavailable");
  exactString(
    wrapper.status,
    "LOCAL_CUE_ASSIGNMENTS_VALIDATED",
    "cue_review_unavailable",
  );
  const review = exactRecord(
    wrapper.review,
    [
      "schema",
      "schemaVersion",
      "mode",
      "status",
      "overlayId",
      "overlayFingerprint",
      "assignmentFingerprint",
      "reviewPacketFingerprint",
      "language",
      "summary",
      "shots",
      "sourceBlockerCodes",
      "blockerCodes",
      "removedOverlayBlockerCodes",
      "audioAssetsMaterialized",
      "webVttMaterialized",
      "playbackReady",
      "executionAllowed",
      "jobWriteAllowed",
      "publishAllowed",
      "providerPreparation",
      "providerContacted",
      "providerReferenceHandlesIssued",
      "gpuProbed",
      "networkCalls",
      "writesPerformed",
      "releaseGate",
    ],
    "cue_review_mismatch",
  );
  exactString(review.schema, STEAM_LAUNCH_CUE_REVIEW_SCHEMA, "cue_review_mismatch");
  exactInteger(
    review.schemaVersion,
    STEAM_LAUNCH_CUE_REVIEW_SCHEMA_VERSION,
    "cue_review_mismatch",
  );
  exactString(review.mode, STEAM_LAUNCH_CUE_REVIEW_MODE, "cue_review_mismatch");
  exactString(review.status, "LOCAL_CUE_ASSIGNMENTS_VALIDATED", "cue_review_mismatch");
  exactString(
    review.overlayId,
    `slcr1-${STEAM_LAUNCH_CUE_MATERIALIZATION_OVERLAY_FINGERPRINT}`,
    "cue_review_mismatch",
  );
  exactString(
    review.overlayFingerprint,
    STEAM_LAUNCH_CUE_MATERIALIZATION_OVERLAY_FINGERPRINT,
    "cue_review_mismatch",
  );
  exactString(
    review.assignmentFingerprint,
    STEAM_LAUNCH_CUE_ASSIGNMENTS_FINGERPRINT,
    "cue_review_mismatch",
  );
  exactString(
    review.reviewPacketFingerprint,
    STEAM_LAUNCH_CUE_REVIEW_BASE_PACKET_FINGERPRINT,
    "cue_review_mismatch",
  );
  exactString(review.language, "zh-CN", "cue_review_mismatch");
  const summary = exactRecord(
    review.summary,
    [
      "shots",
      "reviewRows",
      "choices",
      "referenceBindings",
      "uniqueAssets",
      "narratorRows",
      "characterRows",
      "nonSpokenRows",
      "logicalAudioSlots",
      "includedSubtitleCues",
      "omittedSubtitleRows",
      "timedRows",
    ],
    "cue_review_mismatch",
  );
  for (const [key, expected] of [
    ["shots", 3],
    ["reviewRows", 23],
    ["choices", 5],
    ["referenceBindings", 12],
    ["uniqueAssets", 6],
    ["narratorRows", 12],
    ["characterRows", 0],
    ["nonSpokenRows", 11],
    ["logicalAudioSlots", 12],
    ["includedSubtitleCues", 12],
    ["omittedSubtitleRows", 11],
    ["timedRows", 12],
  ] as const) {
    exactInteger(summary[key], expected, "cue_review_mismatch");
  }
  exactStringArray(
    review.sourceBlockerCodes,
    ["source_reference_not_prepared", "publishable_workflow_missing", "manual_cue_review_required"],
    "cue_review_mismatch",
  );
  exactStringArray(
    review.blockerCodes,
    STEAM_LAUNCH_CUE_REVIEW_REMAINING_BLOCKERS,
    "cue_review_mismatch",
  );
  exactStringArray(
    review.removedOverlayBlockerCodes,
    ["manual_cue_review_required"],
    "cue_review_mismatch",
  );
  for (const key of [
    "audioAssetsMaterialized",
    "webVttMaterialized",
    "playbackReady",
    "executionAllowed",
    "jobWriteAllowed",
    "publishAllowed",
    "providerContacted",
    "gpuProbed",
  ] as const) {
    exactBoolean(review[key], false, "unsafe_gate");
  }
  exactString(review.providerPreparation, "NOT_ATTEMPTED", "unsafe_gate");
  exactInteger(review.providerReferenceHandlesIssued, 0, "unsafe_gate");
  exactInteger(review.networkCalls, 0, "unsafe_gate");
  exactInteger(review.writesPerformed, 0, "unsafe_gate");
  const releaseGate = exactRecord(review.releaseGate, ["satisfied"], "unsafe_gate");
  exactBoolean(releaseGate.satisfied, false, "unsafe_gate");

  const fingerprintBody: DataRecord = { ...review };
  delete fingerprintBody.overlayId;
  delete fingerprintBody.overlayFingerprint;
  let fingerprint: string;
  try {
    fingerprint = digest(fingerprintBody);
  } catch {
    fail("cue_review_mismatch");
  }
  if (fingerprint !== STEAM_LAUNCH_CUE_MATERIALIZATION_OVERLAY_FINGERPRINT) {
    fail("cue_review_mismatch");
  }

  const rawShots = exactArray(review.shots, "cue_review_mismatch");
  if (rawShots.length !== STEAM_LAUNCH_REVIEW_TARGETS.length) fail("cue_review_mismatch");
  let includedCount = 0;
  let omittedCount = 0;
  const shots = rawShots.map((rawShot, shotIndex) => {
    const target = STEAM_LAUNCH_REVIEW_TARGETS[shotIndex]!;
    const shot = exactRecord(rawShot, ["nodeId", "shotId", "rows", "subtitleCues"], "cue_review_mismatch");
    exactString(shot.nodeId, target.nodeId, "cue_review_mismatch");
    exactString(shot.shotId, target.shotId, "cue_review_mismatch");
    const rawRows = exactArray(shot.rows, "cue_review_mismatch");
    if (rawRows.length !== target.rows.length) fail("cue_review_mismatch");
    const rows = rawRows.map((rawRow, rowOffset): ParsedRow => {
      const rowPin = target.rows[rowOffset]!;
      const row = exactRecord(
        rawRow,
        [
          "rowIndex",
          "paragraphId",
          "beatId",
          "rowHash",
          "publicTextHash",
          "speaker",
          "audio",
          "subtitle",
          "timing",
          "publicText",
          "charCount",
        ],
        "cue_review_mismatch",
      );
      const rowIndex = exactInteger(row.rowIndex, rowOffset + 1, "cue_review_mismatch");
      const paragraphId = exactString(row.paragraphId, rowPin.paragraphId, "cue_review_mismatch");
      const beatId = exactString(row.beatId, rowPin.beatId, "cue_review_mismatch");
      const rowHash = hash64(row.rowHash, "cue_review_mismatch");
      const publicTextHash = hash64(row.publicTextHash, "cue_review_mismatch");
      const publicText = safeText(row.publicText, "cue_review_mismatch");
      if (sha256(publicText) !== publicTextHash) fail("cue_review_mismatch");
      const charCount = integer(row.charCount, "cue_review_mismatch");
      if (charCount !== Array.from(publicText).length) fail("cue_review_mismatch");
      const speakerKind = discriminant(row.speaker, "cue_review_mismatch");
      let normalizedSpeaker: "narrator" | "none";
      if (speakerKind === "narrator") {
        exactRecord(row.speaker, ["kind"], "cue_review_mismatch");
        normalizedSpeaker = "narrator";
      } else if (speakerKind === "none") {
        const value = exactRecord(row.speaker, ["kind", "reasonCode"], "cue_review_mismatch");
        exactString(value.reasonCode, "non_spoken_public_row", "cue_review_mismatch");
        normalizedSpeaker = "none";
      } else {
        fail("cue_review_mismatch");
      }
      const audioValue = row.audio as unknown;
      const audioKind = discriminant(audioValue, "cue_review_mismatch");
      let slotId: string | null = null;
      if (audioKind === "logical_slot") {
        const value = exactRecord(audioValue, ["kind", "slotId"], "cue_review_mismatch");
        if (typeof value.slotId !== "string" || !/^slca1-[a-z0-9-]{1,72}$/u.test(value.slotId)) {
          fail("cue_review_mismatch");
        }
        slotId = value.slotId;
      } else if (audioKind === "none") {
        const value = exactRecord(audioValue, ["kind", "reasonCode"], "cue_review_mismatch");
        exactString(value.reasonCode, "non_spoken_public_row", "cue_review_mismatch");
      } else {
        fail("cue_review_mismatch");
      }
      const subtitleValue = row.subtitle as unknown;
      const subtitleKind = discriminant(subtitleValue, "cue_review_mismatch");
      let cueId: string | null = null;
      let included = false;
      if (subtitleKind === "include") {
        const value = exactRecord(
          subtitleValue,
          ["kind", "cueId", "text", "textHash"],
          "cue_review_mismatch",
        );
        if (typeof value.cueId !== "string" || !/^slcc1-[a-z0-9-]{1,72}$/u.test(value.cueId)) {
          fail("cue_review_mismatch");
        }
        cueId = value.cueId;
        exactString(value.text, publicText, "cue_review_mismatch");
        exactString(value.textHash, publicTextHash, "cue_review_mismatch");
        included = true;
        includedCount += 1;
      } else if (subtitleKind === "omit") {
        const value = exactRecord(subtitleValue, ["kind", "reasonCode"], "cue_review_mismatch");
        exactString(value.reasonCode, "non_spoken_public_row", "cue_review_mismatch");
        omittedCount += 1;
      } else {
        fail("cue_review_mismatch");
      }
      const timingValue = row.timing as unknown;
      const timingKind = discriminant(timingValue, "cue_review_mismatch");
      let startMs: number | null = null;
      let endMs: number | null = null;
      if (timingKind === "range") {
        const value = exactRecord(timingValue, ["kind", "startMs", "endMs"], "cue_review_mismatch");
        startMs = integer(value.startMs, "cue_review_mismatch");
        endMs = integer(value.endMs, "cue_review_mismatch");
        if (startMs < 0 || endMs <= startMs || endMs > STEAM_LAUNCH_CUE_WINDOW_END_MS) {
          fail("cue_review_mismatch");
        }
      } else if (timingKind === "none") {
        const value = exactRecord(timingValue, ["kind", "reasonCode"], "cue_review_mismatch");
        exactString(value.reasonCode, "subtitle_omitted", "cue_review_mismatch");
      } else {
        fail("cue_review_mismatch");
      }
      if (
        included !== (normalizedSpeaker === "narrator" && slotId !== null && startMs !== null && endMs !== null)
      ) {
        fail("cue_review_mismatch");
      }
      return {
        nodeId: target.nodeId,
        shotId: target.shotId,
        rowIndex,
        paragraphId,
        beatId,
        rowHash,
        publicTextHash,
        publicText,
        charCount,
        speakerKind: normalizedSpeaker,
        slotId,
        cueId,
        startMs,
        endMs,
        included,
      };
    });
    const rawCues = exactArray(shot.subtitleCues, "cue_review_mismatch");
    const includedRows = rows.filter((row) => row.included);
    if (rawCues.length !== includedRows.length) fail("cue_review_mismatch");
    rawCues.forEach((rawCue, cueIndex) => {
      const row = includedRows[cueIndex]!;
      const cue = exactRecord(
        rawCue,
        ["id", "startMs", "endMs", "text", "textHash", "rowHash", "beatId"],
        "cue_review_mismatch",
      );
      exactString(cue.id, row.cueId!, "cue_review_mismatch");
      exactInteger(cue.startMs, row.startMs!, "cue_review_mismatch");
      exactInteger(cue.endMs, row.endMs!, "cue_review_mismatch");
      exactString(cue.text, row.publicText, "cue_review_mismatch");
      exactString(cue.textHash, row.publicTextHash, "cue_review_mismatch");
      exactString(cue.rowHash, row.rowHash, "cue_review_mismatch");
      exactString(cue.beatId, row.beatId, "cue_review_mismatch");
    });
    return { nodeId: target.nodeId, shotId: target.shotId, rows };
  });
  if (includedCount !== 12 || omittedCount !== 11) fail("cue_review_mismatch");
  return { review, shots };
}

function findPinnedRow(
  shots: Array<{ nodeId: string; shotId: string; rows: ParsedRow[] }>,
  pin: (typeof CONTENT_ROW_PINS)[keyof typeof CONTENT_ROW_PINS],
): ParsedRow {
  const shot = shots.find((entry) => entry.nodeId === pin.nodeId && entry.shotId === pin.shotId);
  const row = shot?.rows.find((entry) => entry.rowIndex === pin.rowIndex);
  if (!row) fail("content_policy_mismatch");
  for (const [key, expected] of [
    ["paragraphId", pin.paragraphId],
    ["beatId", pin.beatId],
    ["rowHash", pin.rowHash],
    ["publicTextHash", pin.textHash],
  ] as const) {
    if (row[key] !== expected) fail("content_policy_mismatch");
  }
  if (
    row.charCount !== pin.charCount ||
    row.startMs !== pin.startMs ||
    row.endMs !== pin.endMs ||
    !row.included ||
    row.speakerKind !== "narrator" ||
    row.slotId === null ||
    row.cueId === null
  ) {
    fail("content_policy_mismatch");
  }
  return row;
}

function buildValidated(
  shots: Array<{ nodeId: string; shotId: string; rows: ParsedRow[] }>,
): SteamLaunchCueMaterializationPreflightResult {
  const denseRow = findPinnedRow(shots, CONTENT_ROW_PINS.dense);
  const editorialRow = findPinnedRow(shots, CONTENT_ROW_PINS.editorial);
  const denseDuration = denseRow.endMs! - denseRow.startMs!;
  const observedDensity = Math.trunc((denseRow.charCount * 1_000_000) / denseDuration);
  if (
    denseRow.charCount * 1_000_000 <=
      STEAM_LAUNCH_CUE_MAX_SUBTITLE_MILLI_CODEPOINTS_PER_SECOND * denseDuration ||
    observedDensity !== 8_800
  ) {
    fail("content_policy_mismatch");
  }
  const denseCodepoints = Array.from(denseRow.publicText);
  const directionSegment = denseCodepoints
    .slice(
      CONTENT_ROW_PINS.dense.performanceDirectionStart,
      CONTENT_ROW_PINS.dense.performanceDirectionEnd,
    )
    .join("");
  if (sha256(directionSegment) !== PERFORMANCE_DIRECTION_SEGMENT_SHA256) {
    fail("content_policy_mismatch");
  }
  const editorialCodepoints = Array.from(editorialRow.publicText);
  const marker = editorialCodepoints
    .slice(CONTENT_ROW_PINS.editorial.markerStart, CONTENT_ROW_PINS.editorial.markerEnd)
    .join("");
  if (marker !== EDITORIAL_MARKER || sha256(marker) !== EDITORIAL_MARKER_SHA256) {
    fail("content_policy_mismatch");
  }
  if (editorialRow.publicText.split(EDITORIAL_MARKER).length - 1 !== 1) {
    fail("content_policy_mismatch");
  }

  const exceededRows = shots
    .flatMap((shot) => shot.rows)
    .filter(
      (row) =>
        row.included &&
        row.startMs !== null &&
        row.endMs !== null &&
        row.charCount * 1_000_000 >
          STEAM_LAUNCH_CUE_MAX_SUBTITLE_MILLI_CODEPOINTS_PER_SECOND *
            (row.endMs - row.startMs),
    );
  if (exceededRows.length !== 1 || exceededRows[0]?.paragraphId !== CONTENT_ROW_PINS.dense.paragraphId) {
    fail("content_policy_mismatch");
  }

  const issues: SteamLaunchCueMaterializationIssue[] = [
    {
      code: "subtitle_density_exceeded",
      nodeId: denseRow.nodeId,
      shotId: denseRow.shotId,
      rowIndex: denseRow.rowIndex,
      paragraphId: denseRow.paragraphId,
      beatId: denseRow.beatId,
      rowHash: denseRow.rowHash,
      publicTextHash: denseRow.publicTextHash,
      charCount: denseRow.charCount,
      durationMs: denseDuration,
      observedMilliCodepointsPerSecond: observedDensity,
      maxMilliCodepointsPerSecond:
        STEAM_LAUNCH_CUE_MAX_SUBTITLE_MILLI_CODEPOINTS_PER_SECOND,
      performanceDirectionPresent: true,
      autoSplitAllowed: false,
      autoRewriteAllowed: false,
      subtitleCandidateAllowed: false,
      audioCandidateAllowed: false,
    },
    {
      code: "editorial_marker_present",
      nodeId: editorialRow.nodeId,
      shotId: editorialRow.shotId,
      rowIndex: editorialRow.rowIndex,
      paragraphId: editorialRow.paragraphId,
      beatId: editorialRow.beatId,
      rowHash: editorialRow.rowHash,
      publicTextHash: editorialRow.publicTextHash,
      markerOccurrences: 1,
      markerEvidenceSha256: EDITORIAL_MARKER_SHA256,
      subtitleCandidateAllowed: false,
      audioCandidateAllowed: false,
    },
  ];
  const quarantined = new Set([denseRow.rowHash, editorialRow.rowHash]);
  let candidateSubtitleCueCount = 0;
  let candidateAudioSlotCount = 0;
  const candidateShots: SteamLaunchCueMaterializationCandidateShot[] = shots.map((shot) => {
    const includedRows = shot.rows.filter((row) => row.included);
    const omittedRows = shot.rows.filter((row) => !row.included);
    const quarantinedRows = includedRows.filter((row) => quarantined.has(row.rowHash));
    const candidateRows = includedRows.filter((row) => !quarantined.has(row.rowHash));
    const rawCues: VideoSubtitleCue[] = candidateRows.map((row) => ({
      id: row.cueId!,
      startMs: row.startMs!,
      endMs: row.endMs!,
      text: row.publicText,
    }));
    const validatedCues = validateSubtitleCues(rawCues, STEAM_LAUNCH_CUE_WINDOW_END_MS);
    if (!candidateCuesMatch(rawCues, validatedCues)) fail("candidate_round_trip_invalid");
    const webVtt = serializeCandidateWebVtt(validatedCues);
    const parsed = parseWebVtt(webVtt, STEAM_LAUNCH_CUE_WINDOW_END_MS);
    if (!candidateCuesMatch(validatedCues, parsed)) fail("candidate_round_trip_invalid");
    if (serializeCandidateWebVtt(parsed) !== webVtt) fail("candidate_round_trip_invalid");
    const candidateCueRefs = candidateRows.map((row) => ({
      cueId: row.cueId!,
      rowIndex: row.rowIndex,
      paragraphId: row.paragraphId,
      beatId: row.beatId,
      rowHash: row.rowHash,
      publicTextHash: row.publicTextHash,
      startMs: row.startMs!,
      endMs: row.endMs!,
    }));
    const candidateAudioSlots = candidateRows.map((row) => ({
      slotId: row.slotId!,
      rowIndex: row.rowIndex,
      paragraphId: row.paragraphId,
      beatId: row.beatId,
      rowHash: row.rowHash,
      publicTextHash: row.publicTextHash,
      startMs: row.startMs!,
      endMs: row.endMs!,
    }));
    candidateSubtitleCueCount += candidateCueRefs.length;
    candidateAudioSlotCount += candidateAudioSlots.length;
    return {
      nodeId: shot.nodeId,
      shotId: shot.shotId,
      sourceIncludedCueCount: includedRows.length,
      sourceOmittedRowCount: omittedRows.length,
      quarantinedRowCount: quarantinedRows.length,
      candidateSubtitleCueCount: candidateCueRefs.length,
      candidateAudioSlotCount: candidateAudioSlots.length,
      candidateWebVttBytes: new TextEncoder().encode(webVtt).byteLength,
      candidateWebVttSha256: sha256(webVtt),
      roundTripVerified: true as const,
      candidateCueRefs,
      candidateAudioSlots,
    };
  });
  if (candidateSubtitleCueCount !== 10 || candidateAudioSlotCount !== 10) {
    fail("content_policy_mismatch");
  }
  const body = {
    schema: STEAM_LAUNCH_CUE_MATERIALIZATION_PREFLIGHT_SCHEMA,
    schemaVersion: STEAM_LAUNCH_CUE_MATERIALIZATION_PREFLIGHT_SCHEMA_VERSION,
    mode: STEAM_LAUNCH_CUE_MATERIALIZATION_PREFLIGHT_MODE,
    status: STEAM_LAUNCH_CUE_MATERIALIZATION_PREFLIGHT_STATUS,
    cueReviewOverlayFingerprint: STEAM_LAUNCH_CUE_MATERIALIZATION_OVERLAY_FINGERPRINT,
    cueAssignmentFingerprint: STEAM_LAUNCH_CUE_ASSIGNMENTS_FINGERPRINT,
    reviewPacketFingerprint: STEAM_LAUNCH_CUE_REVIEW_BASE_PACKET_FINGERPRINT,
    localIntegrityFingerprint: STEAM_LAUNCH_REVIEW_LOCAL_INTEGRITY_FINGERPRINT,
    language: "zh-CN" as const,
    summary: {
      shots: 3,
      reviewRows: 23,
      sourceIncludedSubtitleCues: 12,
      sourceOmittedSubtitleRows: 11,
      contentReviewIssues: 2,
      quarantinedRows: 2,
      candidateSubtitleCues: candidateSubtitleCueCount,
      candidateAudioSlots: candidateAudioSlotCount,
      materializedArtifacts: 0,
    },
    issues,
    candidateShots,
    sourceBlockerCodes: [...STEAM_LAUNCH_CUE_MATERIALIZATION_SOURCE_BLOCKERS] as SteamLaunchCueMaterializationPreflightValidated["sourceBlockerCodes"],
    contentReviewBlockerCodes: [...STEAM_LAUNCH_CUE_MATERIALIZATION_CONTENT_BLOCKERS] as SteamLaunchCueMaterializationPreflightValidated["contentReviewBlockerCodes"],
    blockerCodes: [
      ...STEAM_LAUNCH_CUE_MATERIALIZATION_SOURCE_BLOCKERS,
      ...STEAM_LAUNCH_CUE_MATERIALIZATION_CONTENT_BLOCKERS,
    ] as SteamLaunchCueMaterializationPreflightValidated["blockerCodes"],
    contentReview: { satisfied: false as const },
    candidateOnly: true as const,
    candidateSetComplete: false as const,
    materializationAllowed: false as const,
    webVttMaterializationAllowed: false as const,
    audioMaterializationAllowed: false as const,
    ttsMaterializationAllowed: false as const,
    webVttMaterialized: false as const,
    audioAssetsMaterialized: false as const,
    playbackSyncVerified: false as const,
    playbackReady: false as const,
    executionAllowed: false as const,
    jobWriteAllowed: false as const,
    publishAllowed: false as const,
    providerPreparation: "NOT_ATTEMPTED" as const,
    providerContacted: false as const,
    providerReferenceHandlesIssued: 0 as const,
    gpuProbed: false as const,
    networkCalls: 0 as const,
    writesPerformed: 0 as const,
    releaseGate: { satisfied: false as const },
  };
  const preflightFingerprint = digest(body);
  const preflight: SteamLaunchCueMaterializationPreflightValidated = {
    ...body,
    preflightId: `slcmp1-${preflightFingerprint}`,
    preflightFingerprint,
  };
  return { status: STEAM_LAUNCH_CUE_MATERIALIZATION_PREFLIGHT_STATUS, preflight };
}

function blocked(
  failureCode: SteamLaunchCueMaterializationFailureCode,
): SteamLaunchCueMaterializationPreflightResult {
  return {
    status: "BLOCKED",
    preflight: {
      schema: STEAM_LAUNCH_CUE_MATERIALIZATION_PREFLIGHT_SCHEMA,
      schemaVersion: STEAM_LAUNCH_CUE_MATERIALIZATION_PREFLIGHT_SCHEMA_VERSION,
      mode: STEAM_LAUNCH_CUE_MATERIALIZATION_PREFLIGHT_MODE,
      status: "BLOCKED",
      preflightId: null,
      preflightFingerprint: null,
      cueReviewOverlayFingerprint: STEAM_LAUNCH_CUE_MATERIALIZATION_OVERLAY_FINGERPRINT,
      cueAssignmentFingerprint: STEAM_LAUNCH_CUE_ASSIGNMENTS_FINGERPRINT,
      reviewPacketFingerprint: STEAM_LAUNCH_CUE_REVIEW_BASE_PACKET_FINGERPRINT,
      localIntegrityFingerprint: STEAM_LAUNCH_REVIEW_LOCAL_INTEGRITY_FINGERPRINT,
      failureCode,
      language: "zh-CN",
      summary: {
        shots: 0,
        reviewRows: 0,
        sourceIncludedSubtitleCues: 0,
        sourceOmittedSubtitleRows: 0,
        contentReviewIssues: 0,
        quarantinedRows: 0,
        candidateSubtitleCues: 0,
        candidateAudioSlots: 0,
        materializedArtifacts: 0,
      },
      issues: [],
      candidateShots: [],
      sourceBlockerCodes: [...STEAM_LAUNCH_CUE_MATERIALIZATION_SOURCE_BLOCKERS],
      contentReviewBlockerCodes: [],
      blockerCodes: [
        "source_reference_not_prepared",
        "publishable_workflow_missing",
        "materialization_preflight_unavailable",
      ],
      contentReview: { satisfied: false },
      candidateOnly: true,
      candidateSetComplete: false,
      materializationAllowed: false,
      webVttMaterializationAllowed: false,
      audioMaterializationAllowed: false,
      ttsMaterializationAllowed: false,
      webVttMaterialized: false,
      audioAssetsMaterialized: false,
      playbackSyncVerified: false,
      playbackReady: false,
      executionAllowed: false,
      jobWriteAllowed: false,
      publishAllowed: false,
      providerPreparation: "NOT_ATTEMPTED",
      providerContacted: false,
      providerReferenceHandlesIssued: 0,
      gpuProbed: false,
      networkCalls: 0,
      writesPerformed: 0,
      releaseGate: { satisfied: false },
    },
  };
}

export function blockedSteamLaunchCueMaterializationPreflight(
  code: SteamLaunchCueMaterializationFailureCode,
): SteamLaunchCueMaterializationPreflightResult {
  return blocked(code);
}

export function deriveSteamLaunchCueMaterializationPreflight(
  cueReviewResult: unknown,
): SteamLaunchCueMaterializationPreflightResult {
  try {
    const { shots } = parseReview(cueReviewResult);
    return buildValidated(shots);
  } catch (error) {
    return blocked(
      error instanceof MaterializationPreflightFailure
        ? error.code
        : "content_policy_mismatch",
    );
  }
}

export function serializeSteamLaunchCueMaterializationPreflightJson(
  result: SteamLaunchCueMaterializationPreflightResult,
): string {
  return `${canonical(result.preflight)}\n`;
}
