import "server-only";

import { createHash } from "node:crypto";
import path from "node:path";

import {
  STEAM_LAUNCH_CUE_ASSIGNMENTS_FINGERPRINT,
  STEAM_LAUNCH_CUE_REVIEW_BASE_PACKET_FINGERPRINT,
  STEAM_LAUNCH_CUE_REVIEW_MODE,
  STEAM_LAUNCH_CUE_REVIEW_SCHEMA,
  STEAM_LAUNCH_CUE_REVIEW_SCHEMA_VERSION,
  type SteamLaunchCueReviewResult,
  type SteamLaunchCueReviewValidated,
} from "@/lib/steam/launchCueReview";
import {
  STEAM_LAUNCH_CUE_MATERIALIZATION_OVERLAY_FINGERPRINT,
  STEAM_LAUNCH_CUE_MATERIALIZATION_PREFLIGHT_MODE,
  STEAM_LAUNCH_CUE_MATERIALIZATION_PREFLIGHT_SCHEMA,
  STEAM_LAUNCH_CUE_MATERIALIZATION_PREFLIGHT_SCHEMA_VERSION,
  STEAM_LAUNCH_CUE_MATERIALIZATION_PREFLIGHT_STATUS,
  deriveSteamLaunchCueMaterializationPreflight,
  type SteamLaunchCueMaterializationCandidateShot,
  type SteamLaunchCueMaterializationPreflightResult,
  type SteamLaunchCueMaterializationPreflightValidated,
} from "@/lib/steam/launchCueMaterializationPreflight";
import {
  STEAM_LAUNCH_REVIEW_LOCAL_INTEGRITY_FINGERPRINT,
  STEAM_LAUNCH_REVIEW_PACKET_MODE,
  STEAM_LAUNCH_REVIEW_PACKET_SCHEMA,
  STEAM_LAUNCH_REVIEW_PACKET_SCHEMA_VERSION,
  type SteamLaunchReviewPacket,
  type SteamLaunchReviewPacketResult,
} from "@/lib/steam/launchReviewPacket";
import { parseWebVtt, validateSubtitleCues } from "@/lib/video-assets/validation";
import type { VideoSubtitleCue } from "@/lib/video-assets/types";

export const STEAM_LAUNCH_CUE_REVIEW_PREVIEW_BUNDLE_SCHEMA =
  "aistory-steam-launch-cue-review-preview-bundle" as const;
export const STEAM_LAUNCH_CUE_REVIEW_PREVIEW_BUNDLE_SCHEMA_VERSION = 1 as const;
export const STEAM_LAUNCH_CUE_REVIEW_PREVIEW_BUNDLE_MODE =
  "private_review_only" as const;
export const STEAM_LAUNCH_CUE_REVIEW_PREVIEW_BUNDLE_STATUS =
  "PRIVATE_REVIEW_ONLY" as const;
export const STEAM_LAUNCH_CUE_REVIEW_PREVIEW_BUNDLE_COMPLETENESS =
  "INCOMPLETE" as const;
export const STEAM_LAUNCH_CUE_REVIEW_PREVIEW_BUNDLE_PUBLISHABILITY =
  "NON_PUBLISHABLE" as const;
export const STEAM_LAUNCH_CUE_REVIEW_PREVIEW_PREFLIGHT_FINGERPRINT =
  "ddbe762fc145284ff1681bc5543ecef34786d3df07ef14b52845a5ca7c240ad8" as const;

export const STEAM_LAUNCH_CUE_REVIEW_PREVIEW_FILENAMES = Object.freeze({
  manifest: "steam-launch-subtitle-private-review-manifest.v1.json",
  breakfast: "VG11-SHOT-04.private-review.zh-CN.vtt",
  wakePull: "VG11-SHOT-05.private-review.zh-CN.vtt",
} as const);

export const STEAM_LAUNCH_CUE_REVIEW_PREVIEW_SOURCE_BLOCKERS = Object.freeze([
  "source_reference_not_prepared",
  "publishable_workflow_missing",
] as const);
export const STEAM_LAUNCH_CUE_REVIEW_PREVIEW_CONTENT_BLOCKERS = Object.freeze([
  "subtitle_density_exceeded",
  "editorial_marker_present",
] as const);

const SHOT_PLAN = Object.freeze([
  Object.freeze({
    nodeId: "vg11_wake_choice",
    shotId: "VG11-SHOT-02",
    candidateCount: 0,
    quarantineCount: 0,
    sourceIncludedCount: 0,
    sourceOmittedCount: 2,
    bytes: 8,
    sha256: "8eb5aec53542eaedb7502b22fb677161abba1e265b1338f1af1369a1f689837c",
    basename: null,
  }),
  Object.freeze({
    nodeId: "vg11_breakfast_choice",
    shotId: "VG11-SHOT-04",
    candidateCount: 5,
    quarantineCount: 1,
    sourceIncludedCount: 6,
    sourceOmittedCount: 2,
    bytes: 667,
    sha256: "f6ba6484974072dafafec50e466b3e27d6cd41a40889551737d1498fc0507e00",
    basename: STEAM_LAUNCH_CUE_REVIEW_PREVIEW_FILENAMES.breakfast,
  }),
  Object.freeze({
    nodeId: "vg11_wake_pull",
    shotId: "VG11-SHOT-05",
    candidateCount: 5,
    quarantineCount: 1,
    sourceIncludedCount: 6,
    sourceOmittedCount: 7,
    bytes: 646,
    sha256: "c96635dbc1eddf9be1857228c91be12a8a9bb2f775e3e5fae2f678ded35248f3",
    basename: STEAM_LAUNCH_CUE_REVIEW_PREVIEW_FILENAMES.wakePull,
  }),
] as const);

const QUARANTINE_PLAN = Object.freeze([
  Object.freeze({
    code: "subtitle_density_exceeded",
    nodeId: "vg11_breakfast_choice",
    shotId: "VG11-SHOT-04",
    rowIndex: 4,
    paragraphId: "P026",
    beatId: "vg11_breakfast_choice_b4",
    rowHash: "cb0f6dedeab5f263756375507e79b05f118a8686b7d34fc51ef07eb7641209e6",
    publicTextHash: "0427e110c656d5b2459c6b191436890e779610a21bce6d49c7aefaed2ce606a4",
  }),
  Object.freeze({
    code: "editorial_marker_present",
    nodeId: "vg11_wake_pull",
    shotId: "VG11-SHOT-05",
    rowIndex: 4,
    paragraphId: "P034",
    beatId: "vg11_wake_pull_b4",
    rowHash: "20f406c3929945bafa35ee80d630defec08fb54be61c99d98314fc5b9291de85",
    publicTextHash: "04fae9d74cc4a1fed30834365f9adf4983e5614f3ba6a8a14bd7c21963521639",
  }),
] as const);

const PACKET_KEYS = [
  "schema",
  "schemaVersion",
  "mode",
  "status",
  "packetId",
  "packetFingerprint",
  "authority",
  "releasePolicy",
  "localIntegrity",
  "subtitleTarget",
  "summary",
  "shots",
  "assets",
  "blockerCodes",
  "playbackReady",
  "executionAllowed",
  "publishAllowed",
  "jobWriteAllowed",
  "providerPreparation",
  "providerContacted",
  "providerReferenceHandlesIssued",
  "gpuProbed",
  "networkCalls",
  "writesPerformed",
  "releaseGate",
] as const;

const REVIEW_KEYS = [
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
] as const;

const PREFLIGHT_KEYS = [
  "schema",
  "schemaVersion",
  "mode",
  "status",
  "preflightId",
  "preflightFingerprint",
  "cueReviewOverlayFingerprint",
  "cueAssignmentFingerprint",
  "reviewPacketFingerprint",
  "localIntegrityFingerprint",
  "language",
  "summary",
  "issues",
  "candidateShots",
  "sourceBlockerCodes",
  "contentReviewBlockerCodes",
  "blockerCodes",
  "contentReview",
  "candidateOnly",
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
  "providerPreparation",
  "providerContacted",
  "providerReferenceHandlesIssued",
  "gpuProbed",
  "networkCalls",
  "writesPerformed",
  "releaseGate",
] as const;

export type SteamLaunchCueReviewPreviewFailureCode =
  | "review_packet_unavailable"
  | "review_packet_mismatch"
  | "cue_review_unavailable"
  | "cue_review_mismatch"
  | "materialization_preflight_unavailable"
  | "materialization_preflight_mismatch"
  | "candidate_set_mismatch"
  | "candidate_round_trip_invalid"
  | "package_filename_invalid"
  | "unsafe_gate";

export type SteamLaunchCueReviewPreviewFile = {
  basename: string;
  kind: "manifest" | "webvtt";
  bytes: number;
  sha256: string;
  content: string;
};

export type SteamLaunchCueReviewPreviewManifest = {
  schema: typeof STEAM_LAUNCH_CUE_REVIEW_PREVIEW_BUNDLE_SCHEMA;
  schemaVersion: typeof STEAM_LAUNCH_CUE_REVIEW_PREVIEW_BUNDLE_SCHEMA_VERSION;
  mode: typeof STEAM_LAUNCH_CUE_REVIEW_PREVIEW_BUNDLE_MODE;
  status: typeof STEAM_LAUNCH_CUE_REVIEW_PREVIEW_BUNDLE_STATUS;
  completeness: typeof STEAM_LAUNCH_CUE_REVIEW_PREVIEW_BUNDLE_COMPLETENESS;
  publishability: typeof STEAM_LAUNCH_CUE_REVIEW_PREVIEW_BUNDLE_PUBLISHABILITY;
  bundleId: string;
  bundleFingerprint: string;
  language: "zh-CN";
  source: {
    reviewPacketFingerprint: typeof STEAM_LAUNCH_CUE_REVIEW_BASE_PACKET_FINGERPRINT;
    cueReviewOverlayFingerprint: typeof STEAM_LAUNCH_CUE_MATERIALIZATION_OVERLAY_FINGERPRINT;
    cueAssignmentFingerprint: typeof STEAM_LAUNCH_CUE_ASSIGNMENTS_FINGERPRINT;
    materializationPreflightFingerprint: typeof STEAM_LAUNCH_CUE_REVIEW_PREVIEW_PREFLIGHT_FINGERPRINT;
    localIntegrityFingerprint: typeof STEAM_LAUNCH_REVIEW_LOCAL_INTEGRITY_FINGERPRINT;
  };
  summary: {
    shots: 3;
    acceptedSubtitleCues: 10;
    quarantinedRows: 2;
    privateWebVttFiles: 2;
    withheldShots: 1;
    packageFiles: 3;
    releaseMaterializedArtifacts: 0;
  };
  withheldShots: Array<{
    nodeId: "vg11_wake_choice";
    shotId: "VG11-SHOT-02";
    reasonCode: "no_accepted_subtitle_candidates";
    candidateCueCount: 0;
  }>;
  quarantinedRows: Array<{
    code: "subtitle_density_exceeded" | "editorial_marker_present";
    nodeId: string;
    shotId: string;
    rowIndex: number;
    paragraphId: string;
    beatId: string;
    rowHash: string;
    publicTextHash: string;
  }>;
  webVttFiles: Array<{
    basename: string;
    nodeId: string;
    shotId: string;
    cueCount: 5;
    bytes: number;
    sha256: string;
    candidateOnly: true;
  }>;
  sourceBlockerCodes: ["source_reference_not_prepared", "publishable_workflow_missing"];
  contentBlockerCodes: ["subtitle_density_exceeded", "editorial_marker_present"];
  contentReview: { satisfied: false };
  candidateSetComplete: false;
  releaseMaterializedArtifacts: 0;
  releaseWebVttMaterialized: false;
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
  runtimeWritesPerformed: 0;
  releaseGate: { satisfied: false };
};

export type SteamLaunchCueReviewPreviewReceipt = {
  schema: "aistory-steam-launch-cue-review-preview-receipt";
  schemaVersion: 1;
  status: "PRIVATE_REVIEW_BUNDLE_WRITTEN";
  bundleFingerprint: string;
  summary: {
    shots: 3;
    acceptedSubtitleCues: 10;
    quarantinedRows: 2;
    privateWebVttFiles: 2;
    withheldShots: 1;
    packageFiles: 3;
  };
  files: Array<{ basename: string; kind: "manifest" | "webvtt"; bytes: number; sha256: string }>;
  contentReview: { satisfied: false };
  candidateSetComplete: false;
  releaseMaterializedArtifacts: 0;
  playbackReady: false;
  executionAllowed: false;
  publishAllowed: false;
  releaseGate: { satisfied: false };
};

export type SteamLaunchCueReviewPreviewBundle = {
  manifest: SteamLaunchCueReviewPreviewManifest;
  manifestJson: string;
  files: SteamLaunchCueReviewPreviewFile[];
};

export type SteamLaunchCueReviewPreviewBundleResult =
  | { status: typeof STEAM_LAUNCH_CUE_REVIEW_PREVIEW_BUNDLE_STATUS; bundle: SteamLaunchCueReviewPreviewBundle }
  | {
      status: "BLOCKED";
      failureCode: SteamLaunchCueReviewPreviewFailureCode;
      bundle: null;
      sourceBlockerCodes: ["source_reference_not_prepared", "publishable_workflow_missing"];
      contentBlockerCodes: ["subtitle_density_exceeded", "editorial_marker_present"];
      contentReview: { satisfied: false };
      candidateSetComplete: false;
      releaseMaterializedArtifacts: 0;
      playbackReady: false;
      executionAllowed: false;
      publishAllowed: false;
      releaseGate: { satisfied: false };
    };

type DataRecord = Record<string, unknown>;

class PreviewBundleFailure extends Error {
  constructor(readonly code: SteamLaunchCueReviewPreviewFailureCode) {
    super(code);
  }
}

function fail(code: SteamLaunchCueReviewPreviewFailureCode): never {
  throw new PreviewBundleFailure(code);
}

function asciiCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  code: SteamLaunchCueReviewPreviewFailureCode,
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

function exactArray(value: unknown, code: SteamLaunchCueReviewPreviewFailureCode): unknown[] {
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

export function canonicalSteamLaunchCueReviewPreview(value: unknown, seen = new Set<object>()): string {
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
      return `[${exactArray(value, "candidate_set_mismatch")
        .map((entry) => canonicalSteamLaunchCueReviewPreview(entry, seen))
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
        return `${JSON.stringify(key)}:${canonicalSteamLaunchCueReviewPreview(descriptor.value, seen)}`;
      })
      .join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function digest(value: unknown): string {
  return sha256(canonicalSteamLaunchCueReviewPreview(value));
}

function bodyWithout(record: DataRecord, omitted: readonly string[]): DataRecord {
  const body: DataRecord = Object.create(null) as DataRecord;
  for (const key of Object.keys(record)) {
    if (!omitted.includes(key)) {
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new Error("canonical_invalid");
      }
      body[key] = descriptor.value;
    }
  }
  return body;
}

function exactString(value: unknown, expected: string, code: SteamLaunchCueReviewPreviewFailureCode): string {
  if (value !== expected) fail(code);
  return expected;
}

function exactInteger(value: unknown, expected: number, code: SteamLaunchCueReviewPreviewFailureCode): number {
  if (!Number.isSafeInteger(value) || Object.is(value, -0) || value !== expected) fail(code);
  return expected;
}

function validateBodyFingerprint(
  record: DataRecord,
  omitted: readonly string[],
  expected: string,
  code: SteamLaunchCueReviewPreviewFailureCode,
): void {
  try {
    canonicalSteamLaunchCueReviewPreview(record);
    if (digest(bodyWithout(record, omitted)) !== expected) fail(code);
  } catch {
    fail(code);
  }
}

function validateReviewPacket(input: unknown): SteamLaunchReviewPacket {
  const wrapper = exactRecord(input, ["status", "packet"], "review_packet_unavailable");
  exactString(wrapper.status, "LOCAL_REVIEW_PACKET_READY", "review_packet_unavailable");
  const packet = exactRecord(wrapper.packet, PACKET_KEYS, "review_packet_mismatch");
  exactString(packet.schema, STEAM_LAUNCH_REVIEW_PACKET_SCHEMA, "review_packet_mismatch");
  exactInteger(packet.schemaVersion, STEAM_LAUNCH_REVIEW_PACKET_SCHEMA_VERSION, "review_packet_mismatch");
  exactString(packet.mode, STEAM_LAUNCH_REVIEW_PACKET_MODE, "review_packet_mismatch");
  exactString(packet.status, "LOCAL_REVIEW_PACKET_READY", "review_packet_mismatch");
  exactString(packet.packetId, `slrp1-${STEAM_LAUNCH_CUE_REVIEW_BASE_PACKET_FINGERPRINT}`, "review_packet_mismatch");
  exactString(packet.packetFingerprint, STEAM_LAUNCH_CUE_REVIEW_BASE_PACKET_FINGERPRINT, "review_packet_mismatch");
  validateBodyFingerprint(
    packet,
    ["packetId", "packetFingerprint"],
    STEAM_LAUNCH_CUE_REVIEW_BASE_PACKET_FINGERPRINT,
    "review_packet_mismatch",
  );
  return packet as unknown as SteamLaunchReviewPacket;
}

function validateCueReview(input: unknown): SteamLaunchCueReviewValidated {
  const wrapper = exactRecord(input, ["status", "review"], "cue_review_unavailable");
  exactString(wrapper.status, "LOCAL_CUE_ASSIGNMENTS_VALIDATED", "cue_review_unavailable");
  const review = exactRecord(wrapper.review, REVIEW_KEYS, "cue_review_mismatch");
  exactString(review.schema, STEAM_LAUNCH_CUE_REVIEW_SCHEMA, "cue_review_mismatch");
  exactInteger(review.schemaVersion, STEAM_LAUNCH_CUE_REVIEW_SCHEMA_VERSION, "cue_review_mismatch");
  exactString(review.mode, STEAM_LAUNCH_CUE_REVIEW_MODE, "cue_review_mismatch");
  exactString(review.status, "LOCAL_CUE_ASSIGNMENTS_VALIDATED", "cue_review_mismatch");
  exactString(review.overlayId, `slcr1-${STEAM_LAUNCH_CUE_MATERIALIZATION_OVERLAY_FINGERPRINT}`, "cue_review_mismatch");
  exactString(review.overlayFingerprint, STEAM_LAUNCH_CUE_MATERIALIZATION_OVERLAY_FINGERPRINT, "cue_review_mismatch");
  exactString(review.assignmentFingerprint, STEAM_LAUNCH_CUE_ASSIGNMENTS_FINGERPRINT, "cue_review_mismatch");
  exactString(review.reviewPacketFingerprint, STEAM_LAUNCH_CUE_REVIEW_BASE_PACKET_FINGERPRINT, "cue_review_mismatch");
  validateBodyFingerprint(
    review,
    ["overlayId", "overlayFingerprint"],
    STEAM_LAUNCH_CUE_MATERIALIZATION_OVERLAY_FINGERPRINT,
    "cue_review_mismatch",
  );
  return review as unknown as SteamLaunchCueReviewValidated;
}

function validatePreflight(input: unknown): SteamLaunchCueMaterializationPreflightValidated {
  const wrapper = exactRecord(input, ["status", "preflight"], "materialization_preflight_unavailable");
  exactString(
    wrapper.status,
    STEAM_LAUNCH_CUE_MATERIALIZATION_PREFLIGHT_STATUS,
    "materialization_preflight_unavailable",
  );
  const preflight = exactRecord(wrapper.preflight, PREFLIGHT_KEYS, "materialization_preflight_mismatch");
  exactString(preflight.schema, STEAM_LAUNCH_CUE_MATERIALIZATION_PREFLIGHT_SCHEMA, "materialization_preflight_mismatch");
  exactInteger(preflight.schemaVersion, STEAM_LAUNCH_CUE_MATERIALIZATION_PREFLIGHT_SCHEMA_VERSION, "materialization_preflight_mismatch");
  exactString(preflight.mode, STEAM_LAUNCH_CUE_MATERIALIZATION_PREFLIGHT_MODE, "materialization_preflight_mismatch");
  exactString(preflight.status, STEAM_LAUNCH_CUE_MATERIALIZATION_PREFLIGHT_STATUS, "materialization_preflight_mismatch");
  exactString(preflight.preflightId, `slcmp1-${STEAM_LAUNCH_CUE_REVIEW_PREVIEW_PREFLIGHT_FINGERPRINT}`, "materialization_preflight_mismatch");
  exactString(preflight.preflightFingerprint, STEAM_LAUNCH_CUE_REVIEW_PREVIEW_PREFLIGHT_FINGERPRINT, "materialization_preflight_mismatch");
  exactString(preflight.cueReviewOverlayFingerprint, STEAM_LAUNCH_CUE_MATERIALIZATION_OVERLAY_FINGERPRINT, "materialization_preflight_mismatch");
  exactString(preflight.cueAssignmentFingerprint, STEAM_LAUNCH_CUE_ASSIGNMENTS_FINGERPRINT, "materialization_preflight_mismatch");
  exactString(preflight.reviewPacketFingerprint, STEAM_LAUNCH_CUE_REVIEW_BASE_PACKET_FINGERPRINT, "materialization_preflight_mismatch");
  exactString(preflight.localIntegrityFingerprint, STEAM_LAUNCH_REVIEW_LOCAL_INTEGRITY_FINGERPRINT, "materialization_preflight_mismatch");
  validateBodyFingerprint(
    preflight,
    ["preflightId", "preflightFingerprint"],
    STEAM_LAUNCH_CUE_REVIEW_PREVIEW_PREFLIGHT_FINGERPRINT,
    "materialization_preflight_mismatch",
  );
  return preflight as unknown as SteamLaunchCueMaterializationPreflightValidated;
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

function cuesEqual(left: VideoSubtitleCue[], right: VideoSubtitleCue[]): boolean {
  return left.length === right.length && left.every((cue, index) => {
    const other = right[index];
    return Boolean(
      other &&
      cue.id === other.id &&
      cue.startMs === other.startMs &&
      cue.endMs === other.endMs &&
      cue.text === other.text &&
      cue.speaker === undefined &&
      other.speaker === undefined,
    );
  });
}

function safePackageBasename(value: string): string {
  if (
    value.length < 1 ||
    value.length > 120 ||
    value !== value.normalize("NFC") ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value) ||
    value === "." ||
    value === ".." ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    /[\\/:\u0000]/u.test(value) ||
    /[. ]$/u.test(value) ||
    /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(value)
  ) {
    fail("package_filename_invalid");
  }
  return value;
}

export function validateSteamLaunchCueReviewPreviewFilenames(
  names: readonly string[],
): string[] {
  const normalized = names.map((name) => safePackageBasename(name));
  const seen = new Set<string>();
  for (const name of normalized) {
    const key = name.normalize("NFC").toLocaleLowerCase("en-US");
    if (seen.has(key)) fail("package_filename_invalid");
    seen.add(key);
  }
  return normalized;
}

function findReviewShot(review: SteamLaunchCueReviewValidated, candidate: SteamLaunchCueMaterializationCandidateShot) {
  const matches = review.shots.filter(
    (shot) => shot.nodeId === candidate.nodeId && shot.shotId === candidate.shotId,
  );
  if (matches.length !== 1) fail("candidate_set_mismatch");
  return matches[0]!;
}

function buildCandidateVtt(
  review: SteamLaunchCueReviewValidated,
  candidate: SteamLaunchCueMaterializationCandidateShot,
  plan: (typeof SHOT_PLAN)[number],
): string {
  if (
    candidate.nodeId !== plan.nodeId ||
    candidate.shotId !== plan.shotId ||
    candidate.sourceIncludedCueCount !== plan.sourceIncludedCount ||
    candidate.sourceOmittedRowCount !== plan.sourceOmittedCount ||
    candidate.quarantinedRowCount !== plan.quarantineCount ||
    candidate.candidateSubtitleCueCount !== plan.candidateCount ||
    candidate.candidateAudioSlotCount !== plan.candidateCount ||
    candidate.candidateWebVttBytes !== plan.bytes ||
    candidate.candidateWebVttSha256 !== plan.sha256 ||
    candidate.roundTripVerified !== true ||
    candidate.candidateCueRefs.length !== plan.candidateCount ||
    candidate.candidateAudioSlots.length !== plan.candidateCount
  ) {
    fail("candidate_set_mismatch");
  }
  const reviewShot = findReviewShot(review, candidate);
  const seenCueIds = new Set<string>();
  const seenRowHashes = new Set<string>();
  const cues: VideoSubtitleCue[] = candidate.candidateCueRefs.map((ref, index) => {
    if (seenCueIds.has(ref.cueId) || seenRowHashes.has(ref.rowHash)) fail("candidate_set_mismatch");
    seenCueIds.add(ref.cueId);
    seenRowHashes.add(ref.rowHash);
    if (QUARANTINE_PLAN.some((entry) => entry.rowHash === ref.rowHash)) fail("candidate_set_mismatch");
    const rows = reviewShot.rows.filter((row) => row.rowIndex === ref.rowIndex);
    const cueMatches = reviewShot.subtitleCues.filter((cue) => cue.id === ref.cueId);
    if (rows.length !== 1 || cueMatches.length !== 1) fail("candidate_set_mismatch");
    const row = rows[0]!;
    const cue = cueMatches[0]!;
    const slot = candidate.candidateAudioSlots[index];
    if (
      row.paragraphId !== ref.paragraphId ||
      row.beatId !== ref.beatId ||
      row.rowHash !== ref.rowHash ||
      row.publicTextHash !== ref.publicTextHash ||
      row.subtitle.kind !== "include" ||
      row.subtitle.cueId !== ref.cueId ||
      row.subtitle.text !== row.publicText ||
      row.subtitle.textHash !== ref.publicTextHash ||
      row.timing.kind !== "range" ||
      row.timing.startMs !== ref.startMs ||
      row.timing.endMs !== ref.endMs ||
      cue.text !== row.publicText ||
      cue.textHash !== ref.publicTextHash ||
      cue.rowHash !== ref.rowHash ||
      cue.beatId !== ref.beatId ||
      cue.startMs !== ref.startMs ||
      cue.endMs !== ref.endMs ||
      Object.prototype.hasOwnProperty.call(cue, "speaker") ||
      !slot ||
      slot.rowIndex !== ref.rowIndex ||
      slot.paragraphId !== ref.paragraphId ||
      slot.beatId !== ref.beatId ||
      slot.rowHash !== ref.rowHash ||
      slot.publicTextHash !== ref.publicTextHash ||
      slot.startMs !== ref.startMs ||
      slot.endMs !== ref.endMs ||
      sha256(row.publicText) !== ref.publicTextHash
    ) {
      fail("candidate_set_mismatch");
    }
    return { id: cue.id, startMs: cue.startMs, endMs: cue.endMs, text: cue.text };
  });
  const validated = validateSubtitleCues(cues, 30_000);
  if (!cuesEqual(cues, validated)) fail("candidate_round_trip_invalid");
  const webVtt = serializeWebVtt(validated);
  const parsed = parseWebVtt(webVtt, 30_000);
  if (!cuesEqual(validated, parsed) || serializeWebVtt(parsed) !== webVtt) {
    fail("candidate_round_trip_invalid");
  }
  if (new TextEncoder().encode(webVtt).byteLength !== plan.bytes || sha256(webVtt) !== plan.sha256) {
    fail("candidate_round_trip_invalid");
  }
  return webVtt;
}

function manifestBody(webVttFiles: SteamLaunchCueReviewPreviewManifest["webVttFiles"]) {
  return {
    schema: STEAM_LAUNCH_CUE_REVIEW_PREVIEW_BUNDLE_SCHEMA,
    schemaVersion: STEAM_LAUNCH_CUE_REVIEW_PREVIEW_BUNDLE_SCHEMA_VERSION,
    mode: STEAM_LAUNCH_CUE_REVIEW_PREVIEW_BUNDLE_MODE,
    status: STEAM_LAUNCH_CUE_REVIEW_PREVIEW_BUNDLE_STATUS,
    completeness: STEAM_LAUNCH_CUE_REVIEW_PREVIEW_BUNDLE_COMPLETENESS,
    publishability: STEAM_LAUNCH_CUE_REVIEW_PREVIEW_BUNDLE_PUBLISHABILITY,
    language: "zh-CN" as const,
    source: {
      reviewPacketFingerprint: STEAM_LAUNCH_CUE_REVIEW_BASE_PACKET_FINGERPRINT,
      cueReviewOverlayFingerprint: STEAM_LAUNCH_CUE_MATERIALIZATION_OVERLAY_FINGERPRINT,
      cueAssignmentFingerprint: STEAM_LAUNCH_CUE_ASSIGNMENTS_FINGERPRINT,
      materializationPreflightFingerprint: STEAM_LAUNCH_CUE_REVIEW_PREVIEW_PREFLIGHT_FINGERPRINT,
      localIntegrityFingerprint: STEAM_LAUNCH_REVIEW_LOCAL_INTEGRITY_FINGERPRINT,
    },
    summary: {
      shots: 3 as const,
      acceptedSubtitleCues: 10 as const,
      quarantinedRows: 2 as const,
      privateWebVttFiles: 2 as const,
      withheldShots: 1 as const,
      packageFiles: 3 as const,
      releaseMaterializedArtifacts: 0 as const,
    },
    withheldShots: [{
      nodeId: "vg11_wake_choice" as const,
      shotId: "VG11-SHOT-02" as const,
      reasonCode: "no_accepted_subtitle_candidates" as const,
      candidateCueCount: 0 as const,
    }],
    quarantinedRows: QUARANTINE_PLAN.map((entry) => ({ ...entry })),
    webVttFiles,
    sourceBlockerCodes: [...STEAM_LAUNCH_CUE_REVIEW_PREVIEW_SOURCE_BLOCKERS] as SteamLaunchCueReviewPreviewManifest["sourceBlockerCodes"],
    contentBlockerCodes: [...STEAM_LAUNCH_CUE_REVIEW_PREVIEW_CONTENT_BLOCKERS] as SteamLaunchCueReviewPreviewManifest["contentBlockerCodes"],
    contentReview: { satisfied: false as const },
    candidateSetComplete: false as const,
    releaseMaterializedArtifacts: 0 as const,
    releaseWebVttMaterialized: false as const,
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
    runtimeWritesPerformed: 0 as const,
    releaseGate: { satisfied: false as const },
  };
}

function blocked(code: SteamLaunchCueReviewPreviewFailureCode): SteamLaunchCueReviewPreviewBundleResult {
  return {
    status: "BLOCKED",
    failureCode: code,
    bundle: null,
    sourceBlockerCodes: [...STEAM_LAUNCH_CUE_REVIEW_PREVIEW_SOURCE_BLOCKERS],
    contentBlockerCodes: [...STEAM_LAUNCH_CUE_REVIEW_PREVIEW_CONTENT_BLOCKERS],
    contentReview: { satisfied: false },
    candidateSetComplete: false,
    releaseMaterializedArtifacts: 0,
    playbackReady: false,
    executionAllowed: false,
    publishAllowed: false,
    releaseGate: { satisfied: false },
  };
}

export function blockedSteamLaunchCueReviewPreviewBundle(
  code: SteamLaunchCueReviewPreviewFailureCode,
): SteamLaunchCueReviewPreviewBundleResult {
  return blocked(code);
}

export function deriveSteamLaunchCueReviewPreviewBundle(
  reviewPacketResult: unknown,
  cueReviewResult: unknown,
  materializationPreflightResult: unknown,
  filenames: readonly string[] = [
    STEAM_LAUNCH_CUE_REVIEW_PREVIEW_FILENAMES.manifest,
    STEAM_LAUNCH_CUE_REVIEW_PREVIEW_FILENAMES.breakfast,
    STEAM_LAUNCH_CUE_REVIEW_PREVIEW_FILENAMES.wakePull,
  ],
): SteamLaunchCueReviewPreviewBundleResult {
  try {
    const filenameEntries = exactArray(filenames, "package_filename_invalid");
    if (filenameEntries.length !== 3 || filenameEntries.some((entry) => typeof entry !== "string")) {
      fail("package_filename_invalid");
    }
    validateSteamLaunchCueReviewPreviewFilenames(filenameEntries as string[]);
    const packet = validateReviewPacket(reviewPacketResult);
    const review = validateCueReview(cueReviewResult);
    const preflight = validatePreflight(materializationPreflightResult);
    if (
      packet.packetFingerprint !== review.reviewPacketFingerprint ||
      review.overlayFingerprint !== preflight.cueReviewOverlayFingerprint
    ) {
      fail("candidate_set_mismatch");
    }
    const rederived = deriveSteamLaunchCueMaterializationPreflight(cueReviewResult);
    if (
      rederived.status !== STEAM_LAUNCH_CUE_MATERIALIZATION_PREFLIGHT_STATUS ||
      canonicalSteamLaunchCueReviewPreview(rederived.preflight) !==
        canonicalSteamLaunchCueReviewPreview(preflight)
    ) {
      fail("materialization_preflight_mismatch");
    }
    if (preflight.candidateShots.length !== SHOT_PLAN.length || preflight.issues.length !== 2) {
      fail("candidate_set_mismatch");
    }
    for (let index = 0; index < QUARANTINE_PLAN.length; index += 1) {
      const expected = QUARANTINE_PLAN[index]!;
      const issue = preflight.issues[index];
      if (
        !issue || issue.code !== expected.code || issue.nodeId !== expected.nodeId ||
        issue.shotId !== expected.shotId || issue.rowIndex !== expected.rowIndex ||
        issue.paragraphId !== expected.paragraphId || issue.beatId !== expected.beatId ||
        issue.rowHash !== expected.rowHash || issue.publicTextHash !== expected.publicTextHash
      ) {
        fail("candidate_set_mismatch");
      }
    }
    const vttContents: Array<{ plan: (typeof SHOT_PLAN)[number]; content: string }> = [];
    preflight.candidateShots.forEach((candidate, index) => {
      const plan = SHOT_PLAN[index]!;
      const content = buildCandidateVtt(review, candidate, plan);
      if (plan.basename === null) {
        if (content !== "WEBVTT\n\n") fail("candidate_set_mismatch");
      } else {
        vttContents.push({ plan, content });
      }
    });
    if (vttContents.length !== 2) fail("candidate_set_mismatch");
    const webVttFiles: SteamLaunchCueReviewPreviewManifest["webVttFiles"] = vttContents.map(
      ({ plan }) => ({
        basename: filenames[plan.shotId === "VG11-SHOT-04" ? 1 : 2]!,
        nodeId: plan.nodeId,
        shotId: plan.shotId,
        cueCount: 5,
        bytes: plan.bytes,
        sha256: plan.sha256,
        candidateOnly: true,
      }),
    );
    const body = manifestBody(webVttFiles);
    const bundleFingerprint = digest(body);
    const manifest: SteamLaunchCueReviewPreviewManifest = {
      ...body,
      bundleId: `slcrpb1-${bundleFingerprint}`,
      bundleFingerprint,
    };
    const manifestJson = `${canonicalSteamLaunchCueReviewPreview(manifest)}\n`;
    const files: SteamLaunchCueReviewPreviewFile[] = [
      ...vttContents.map(({ content }, index) => ({
        basename: webVttFiles[index]!.basename,
        kind: "webvtt" as const,
        bytes: new TextEncoder().encode(content).byteLength,
        sha256: sha256(content),
        content,
      })),
      {
        basename: filenames[0]!,
        kind: "manifest" as const,
        bytes: new TextEncoder().encode(manifestJson).byteLength,
        sha256: sha256(manifestJson),
        content: manifestJson,
      },
    ];
    validateSteamLaunchCueReviewPreviewFilenames(files.map((file) => file.basename));
    return { status: STEAM_LAUNCH_CUE_REVIEW_PREVIEW_BUNDLE_STATUS, bundle: { manifest, manifestJson, files } };
  } catch (error) {
    return blocked(error instanceof PreviewBundleFailure ? error.code : "candidate_set_mismatch");
  }
}

export function createSteamLaunchCueReviewPreviewWrittenReceipt(
  bundle: SteamLaunchCueReviewPreviewBundle,
): SteamLaunchCueReviewPreviewReceipt {
  return {
    schema: "aistory-steam-launch-cue-review-preview-receipt",
    schemaVersion: 1,
    status: "PRIVATE_REVIEW_BUNDLE_WRITTEN",
    bundleFingerprint: bundle.manifest.bundleFingerprint,
    summary: {
      shots: 3,
      acceptedSubtitleCues: 10,
      quarantinedRows: 2,
      privateWebVttFiles: 2,
      withheldShots: 1,
      packageFiles: 3,
    },
    files: bundle.files.map(({ basename, kind, bytes, sha256: fileSha256 }) => ({
      basename,
      kind,
      bytes,
      sha256: fileSha256,
    })),
    contentReview: { satisfied: false },
    candidateSetComplete: false,
    releaseMaterializedArtifacts: 0,
    playbackReady: false,
    executionAllowed: false,
    publishAllowed: false,
    releaseGate: { satisfied: false },
  };
}

export function serializeSteamLaunchCueReviewPreviewManifest(
  result: SteamLaunchCueReviewPreviewBundleResult,
): string | null {
  return result.status === "PRIVATE_REVIEW_ONLY" ? result.bundle.manifestJson : null;
}

export function serializeSteamLaunchCueReviewPreviewReceipt(
  receipt: SteamLaunchCueReviewPreviewReceipt,
): string {
  return `${canonicalSteamLaunchCueReviewPreview(receipt)}\n`;
}

export function cloneSteamLaunchCueReviewPreviewSourceForTest(
  packet: SteamLaunchReviewPacketResult,
  review: SteamLaunchCueReviewResult,
  preflight: SteamLaunchCueMaterializationPreflightResult,
): [SteamLaunchReviewPacketResult, SteamLaunchCueReviewResult, SteamLaunchCueMaterializationPreflightResult] {
  return [structuredClone(packet), structuredClone(review), structuredClone(preflight)];
}
