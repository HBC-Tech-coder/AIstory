import "server-only";

import {
  STEAM_LAUNCH_REVIEW_AUTHORITY,
  STEAM_LAUNCH_REVIEW_BLOCKERS,
  STEAM_LAUNCH_REVIEW_CHOICE_PINS,
  STEAM_LAUNCH_REVIEW_LOCAL_INTEGRITY_FINGERPRINT,
  STEAM_LAUNCH_REVIEW_PACKET_MODE,
  STEAM_LAUNCH_REVIEW_PACKET_SCHEMA,
  STEAM_LAUNCH_REVIEW_PACKET_SCHEMA_VERSION,
  STEAM_LAUNCH_REVIEW_REFERENCE_ROLES,
  STEAM_LAUNCH_REVIEW_RELEASE_POLICY_HASH,
  STEAM_LAUNCH_REVIEW_TARGETS,
  type SteamLaunchReviewPacketResult,
} from "@/lib/steam/launchReviewPacket";

export const STEAM_LAUNCH_CUE_ASSIGNMENTS_SCHEMA =
  "aistory-steam-launch-cue-assignments" as const;
export const STEAM_LAUNCH_CUE_ASSIGNMENTS_SCHEMA_VERSION = 1 as const;
export const STEAM_LAUNCH_CUE_ASSIGNMENTS_MODE = "human_explicit_review" as const;
export const STEAM_LAUNCH_CUE_REVIEW_SCHEMA =
  "aistory-steam-launch-cue-review" as const;
export const STEAM_LAUNCH_CUE_REVIEW_SCHEMA_VERSION = 1 as const;
export const STEAM_LAUNCH_CUE_REVIEW_MODE = "local_review_only" as const;
export const STEAM_LAUNCH_CUE_REVIEW_BASE_PACKET_FINGERPRINT =
  "fda3ec7088d07225d6486afa38471f4cc88f79e67d3a1506caac2fb894d1c397" as const;
export const STEAM_LAUNCH_CUE_ASSIGNMENTS_FINGERPRINT =
  "e5708c15cbf3416808fd5046b462f19c4d98772814b8ec135b78b8da9e23ebf2" as const;
export const STEAM_LAUNCH_CUE_REVIEW_LANGUAGE = "zh-CN" as const;
export const STEAM_LAUNCH_CUE_REVIEW_WINDOW_END_MS = 30_000 as const;
export const STEAM_LAUNCH_CUE_REVIEW_CHARACTER_IDS = Object.freeze([
  "lanjian",
] as const);
export const STEAM_LAUNCH_CUE_REVIEW_REMAINING_BLOCKERS = Object.freeze([
  "source_reference_not_prepared",
  "publishable_workflow_missing",
] as const);
export const STEAM_LAUNCH_CUE_REVIEW_REMOVED_BLOCKERS = Object.freeze([
  "manual_cue_review_required",
] as const);

export const STEAM_LAUNCH_CUE_REVIEW_REASON_CODES = Object.freeze({
  nonSpokenRow: "non_spoken_public_row",
  audioOmitted: "non_spoken_public_row",
  subtitleOmitted: "non_spoken_public_row",
  timingOmitted: "subtitle_omitted",
} as const);

export type SteamLaunchCueReviewFailureCode =
  | "review_packet_unavailable"
  | "review_packet_mismatch"
  | "assignments_unavailable"
  | "assignments_invalid"
  | "assignment_coverage_mismatch"
  | "assignment_row_mismatch"
  | "assignment_speaker_invalid"
  | "assignment_audio_invalid"
  | "assignment_subtitle_invalid"
  | "assignment_timing_invalid"
  | "unsafe_gate";

export type SteamLaunchCueSpeaker =
  | { kind: "narrator" }
  | { kind: "character"; characterId: (typeof STEAM_LAUNCH_CUE_REVIEW_CHARACTER_IDS)[number] }
  | { kind: "none"; reasonCode: typeof STEAM_LAUNCH_CUE_REVIEW_REASON_CODES.nonSpokenRow };

export type SteamLaunchCueAudio =
  | { kind: "logical_slot"; slotId: string }
  | { kind: "none"; reasonCode: typeof STEAM_LAUNCH_CUE_REVIEW_REASON_CODES.audioOmitted };

export type SteamLaunchCueSubtitle =
  | { kind: "include"; cueId: string; text: string; textHash: string }
  | { kind: "omit"; reasonCode: typeof STEAM_LAUNCH_CUE_REVIEW_REASON_CODES.subtitleOmitted };

export type SteamLaunchCueTiming =
  | { kind: "range"; startMs: number; endMs: number }
  | { kind: "none"; reasonCode: typeof STEAM_LAUNCH_CUE_REVIEW_REASON_CODES.timingOmitted };

export type SteamLaunchCueAssignmentRow = {
  rowIndex: number;
  paragraphId: string;
  beatId: string;
  rowHash: string;
  publicTextHash: string;
  speaker: SteamLaunchCueSpeaker;
  audio: SteamLaunchCueAudio;
  subtitle: SteamLaunchCueSubtitle;
  timing: SteamLaunchCueTiming;
};

export type SteamLaunchCueAssignments = {
  schema: typeof STEAM_LAUNCH_CUE_ASSIGNMENTS_SCHEMA;
  schemaVersion: typeof STEAM_LAUNCH_CUE_ASSIGNMENTS_SCHEMA_VERSION;
  mode: typeof STEAM_LAUNCH_CUE_ASSIGNMENTS_MODE;
  reviewPacketFingerprint: typeof STEAM_LAUNCH_CUE_REVIEW_BASE_PACKET_FINGERPRINT;
  language: typeof STEAM_LAUNCH_CUE_REVIEW_LANGUAGE;
  shots: Array<{
    nodeId: string;
    shotId: string;
    rows: SteamLaunchCueAssignmentRow[];
  }>;
};

export type SteamLaunchCueReviewRow = SteamLaunchCueAssignmentRow & {
  publicText: string;
  charCount: number;
};

export type SteamLaunchCueReviewShot = {
  nodeId: string;
  shotId: string;
  rows: SteamLaunchCueReviewRow[];
  subtitleCues: Array<{
    id: string;
    startMs: number;
    endMs: number;
    text: string;
    speaker?: string;
    textHash: string;
    rowHash: string;
    beatId: string;
  }>;
};

export type SteamLaunchCueReviewValidated = {
  schema: typeof STEAM_LAUNCH_CUE_REVIEW_SCHEMA;
  schemaVersion: typeof STEAM_LAUNCH_CUE_REVIEW_SCHEMA_VERSION;
  mode: typeof STEAM_LAUNCH_CUE_REVIEW_MODE;
  status: "LOCAL_CUE_ASSIGNMENTS_VALIDATED";
  overlayId: string;
  overlayFingerprint: string;
  assignmentFingerprint: string;
  reviewPacketFingerprint: typeof STEAM_LAUNCH_CUE_REVIEW_BASE_PACKET_FINGERPRINT;
  language: typeof STEAM_LAUNCH_CUE_REVIEW_LANGUAGE;
  summary: {
    shots: 3;
    reviewRows: 23;
    choices: 5;
    referenceBindings: 12;
    uniqueAssets: 6;
    narratorRows: number;
    characterRows: number;
    nonSpokenRows: number;
    logicalAudioSlots: number;
    includedSubtitleCues: number;
    omittedSubtitleRows: number;
    timedRows: number;
  };
  shots: SteamLaunchCueReviewShot[];
  sourceBlockerCodes: [
    "source_reference_not_prepared",
    "publishable_workflow_missing",
    "manual_cue_review_required",
  ];
  blockerCodes: ["source_reference_not_prepared", "publishable_workflow_missing"];
  removedOverlayBlockerCodes: ["manual_cue_review_required"];
  audioAssetsMaterialized: false;
  webVttMaterialized: false;
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

export type SteamLaunchCueReviewBlocked = {
  schema: typeof STEAM_LAUNCH_CUE_REVIEW_SCHEMA;
  schemaVersion: typeof STEAM_LAUNCH_CUE_REVIEW_SCHEMA_VERSION;
  mode: typeof STEAM_LAUNCH_CUE_REVIEW_MODE;
  status: "BLOCKED";
  overlayId: null;
  overlayFingerprint: null;
  assignmentFingerprint: null;
  reviewPacketFingerprint: typeof STEAM_LAUNCH_CUE_REVIEW_BASE_PACKET_FINGERPRINT;
  failureCode: SteamLaunchCueReviewFailureCode;
  language: typeof STEAM_LAUNCH_CUE_REVIEW_LANGUAGE;
  summary: {
    shots: 0;
    reviewRows: 0;
    choices: 0;
    referenceBindings: 0;
    uniqueAssets: 0;
    narratorRows: 0;
    characterRows: 0;
    nonSpokenRows: 0;
    logicalAudioSlots: 0;
    includedSubtitleCues: 0;
    omittedSubtitleRows: 0;
    timedRows: 0;
  };
  shots: [];
  sourceBlockerCodes: [
    "source_reference_not_prepared",
    "publishable_workflow_missing",
    "manual_cue_review_required",
  ];
  blockerCodes: [
    "source_reference_not_prepared",
    "publishable_workflow_missing",
    "manual_cue_review_required",
  ];
  removedOverlayBlockerCodes: [];
  audioAssetsMaterialized: false;
  webVttMaterialized: false;
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

export type SteamLaunchCueReviewResult =
  | { status: "LOCAL_CUE_ASSIGNMENTS_VALIDATED"; review: SteamLaunchCueReviewValidated }
  | { status: "BLOCKED"; review: SteamLaunchCueReviewBlocked };

type DataRecord = Record<string, unknown>;
type HashFunction = (value: string) => string;

class CueReviewFailure extends Error {
  constructor(readonly code: SteamLaunchCueReviewFailureCode) {
    super(code);
  }
}

function fail(code: SteamLaunchCueReviewFailureCode): never {
  throw new CueReviewFailure(code);
}

function asciiCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  code: SteamLaunchCueReviewFailureCode,
): DataRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    fail(code);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail(code);
  }
  return value as DataRecord;
}

function discriminant(
  value: unknown,
  code: SteamLaunchCueReviewFailureCode,
): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) fail(code);
  for (const key of ownKeys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail(code);
  }
  const kind = Object.getOwnPropertyDescriptor(value, "kind")?.value;
  if (typeof kind !== "string") fail(code);
  return kind;
}

function exactArray(
  value: unknown,
  code: SteamLaunchCueReviewFailureCode,
): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail(code);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key === "symbol")) fail(code);
  const stringKeys = ownKeys as string[];
  if (
    stringKeys.length !== value.length + 1 ||
    !stringKeys.includes("length") ||
    Array.from({ length: value.length }, (_, index) => String(index)).some(
      (key) => !stringKeys.includes(key),
    )
  ) {
    fail(code);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail(code);
  }
  return value;
}

function exactString(
  value: unknown,
  expected: string,
  code: SteamLaunchCueReviewFailureCode,
): string {
  if (typeof value !== "string" || value !== expected) fail(code);
  return value;
}

function safeText(value: unknown, code: SteamLaunchCueReviewFailureCode): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 500 ||
    value !== value.trim() ||
    value.includes("-->") ||
    /[<>\r\n\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)
  ) {
    fail(code);
  }
  return value;
}

function safeId(value: unknown, prefix: string, code: SteamLaunchCueReviewFailureCode): string {
  if (
    typeof value !== "string" ||
    value.length > 160 ||
    !new RegExp(`^${prefix}[a-z0-9._-]+$`, "u").test(value)
  ) {
    fail(code);
  }
  return value;
}

function exactInteger(
  value: unknown,
  expected: number,
  code: SteamLaunchCueReviewFailureCode,
): number {
  if (!Number.isSafeInteger(value) || value !== expected) fail(code);
  return value;
}

function exactBoolean(
  value: unknown,
  expected: boolean,
  code: SteamLaunchCueReviewFailureCode,
): boolean {
  if (value !== expected) fail(code);
  return expected;
}

function hash64(value: unknown, code: SteamLaunchCueReviewFailureCode): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) fail(code);
  return value;
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
      if (Object.getPrototypeOf(value) !== Array.prototype) throw new Error("canonical_invalid");
      return `[${exactArray(value, "assignments_invalid").map((entry) => canonical(entry, seen)).join(",")}]`;
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

function digest(sha256: HashFunction, value: unknown): string {
  const result = sha256(canonical(value));
  if (!/^[a-f0-9]{64}$/u.test(result)) fail("assignments_invalid");
  return result;
}

function exactStringArray(
  value: unknown,
  expected: readonly string[],
  code: SteamLaunchCueReviewFailureCode,
): string[] {
  const array = exactArray(value, code);
  if (array.length !== expected.length) fail(code);
  return array.map((entry, index) => exactString(entry, expected[index]!, code));
}

function validateBasePacket(
  result: unknown,
  sha256: HashFunction,
): SteamLaunchReviewPacketResult & { status: "LOCAL_REVIEW_PACKET_READY" } {
  const wrapper = exactRecord(result, ["status", "packet"], "review_packet_unavailable");
  exactString(wrapper.status, "LOCAL_REVIEW_PACKET_READY", "review_packet_unavailable");
  const packet = exactRecord(
    wrapper.packet,
    [
      "schema",
      "schemaVersion",
      "mode",
      "status",
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
      "packetId",
      "packetFingerprint",
    ],
    "review_packet_mismatch",
  );
  try {
    canonical(packet);
  } catch {
    fail("review_packet_mismatch");
  }
  exactString(packet.schema, STEAM_LAUNCH_REVIEW_PACKET_SCHEMA, "review_packet_mismatch");
  exactInteger(
    packet.schemaVersion,
    STEAM_LAUNCH_REVIEW_PACKET_SCHEMA_VERSION,
    "review_packet_mismatch",
  );
  exactString(packet.mode, STEAM_LAUNCH_REVIEW_PACKET_MODE, "review_packet_mismatch");
  exactString(packet.status, "LOCAL_REVIEW_PACKET_READY", "review_packet_mismatch");
  exactString(
    packet.packetFingerprint,
    STEAM_LAUNCH_CUE_REVIEW_BASE_PACKET_FINGERPRINT,
    "review_packet_mismatch",
  );
  exactString(
    packet.packetId,
    `slrp1-${STEAM_LAUNCH_CUE_REVIEW_BASE_PACKET_FINGERPRINT}`,
    "review_packet_mismatch",
  );
  const summary = exactRecord(
    packet.summary,
    ["shots", "reviewRows", "choices", "referenceBindings", "uniqueAssets"],
    "review_packet_mismatch",
  );
  exactInteger(summary.shots, 3, "review_packet_mismatch");
  exactInteger(summary.reviewRows, 23, "review_packet_mismatch");
  exactInteger(summary.choices, 5, "review_packet_mismatch");
  exactInteger(summary.referenceBindings, 12, "review_packet_mismatch");
  exactInteger(summary.uniqueAssets, 6, "review_packet_mismatch");
  exactStringArray(packet.blockerCodes, STEAM_LAUNCH_REVIEW_BLOCKERS, "review_packet_mismatch");
  exactBoolean(packet.playbackReady, false, "unsafe_gate");
  exactBoolean(packet.executionAllowed, false, "unsafe_gate");
  exactBoolean(packet.publishAllowed, false, "unsafe_gate");
  exactBoolean(packet.jobWriteAllowed, false, "unsafe_gate");
  exactString(packet.providerPreparation, "NOT_ATTEMPTED", "unsafe_gate");
  exactBoolean(packet.providerContacted, false, "unsafe_gate");
  exactInteger(packet.providerReferenceHandlesIssued, 0, "unsafe_gate");
  exactBoolean(packet.gpuProbed, false, "unsafe_gate");
  exactInteger(packet.networkCalls, 0, "unsafe_gate");
  exactInteger(packet.writesPerformed, 0, "unsafe_gate");
  const releaseGate = exactRecord(packet.releaseGate, ["satisfied"], "unsafe_gate");
  exactBoolean(releaseGate.satisfied, false, "unsafe_gate");
  const subtitleTarget = exactRecord(
    packet.subtitleTarget,
    ["locale", "format", "windowStartMs", "windowEndMs", "cuesAssigned"],
    "review_packet_mismatch",
  );
  exactString(subtitleTarget.locale, STEAM_LAUNCH_CUE_REVIEW_LANGUAGE, "review_packet_mismatch");
  exactString(subtitleTarget.format, "webvtt", "review_packet_mismatch");
  exactInteger(subtitleTarget.windowStartMs, 0, "review_packet_mismatch");
  exactInteger(
    subtitleTarget.windowEndMs,
    STEAM_LAUNCH_CUE_REVIEW_WINDOW_END_MS,
    "review_packet_mismatch",
  );
  exactBoolean(subtitleTarget.cuesAssigned, false, "review_packet_mismatch");
  const localIntegrity = exactRecord(
    packet.localIntegrity,
    ["status", "manifestFingerprint"],
    "review_packet_mismatch",
  );
  exactString(localIntegrity.status, "LOCAL_VERIFIED_ONLY", "review_packet_mismatch");
  exactString(
    localIntegrity.manifestFingerprint,
    STEAM_LAUNCH_REVIEW_LOCAL_INTEGRITY_FINGERPRINT,
    "review_packet_mismatch",
  );
  const authority = exactRecord(
    packet.authority,
    [
      "caseId",
      "storyId",
      "storyVersion",
      "projectRef",
      "authorReleaseVersion",
      "authorStory",
      "publicStory",
      "assetManifest",
      "videoPrompts",
    ],
    "review_packet_mismatch",
  );
  exactString(authority.caseId, STEAM_LAUNCH_REVIEW_AUTHORITY.caseId, "review_packet_mismatch");
  exactString(authority.storyId, STEAM_LAUNCH_REVIEW_AUTHORITY.storyId, "review_packet_mismatch");
  exactString(
    authority.storyVersion,
    STEAM_LAUNCH_REVIEW_AUTHORITY.storyVersion,
    "review_packet_mismatch",
  );
  exactString(authority.projectRef, STEAM_LAUNCH_REVIEW_AUTHORITY.projectRef, "review_packet_mismatch");
  exactString(
    authority.authorReleaseVersion,
    STEAM_LAUNCH_REVIEW_AUTHORITY.authorReleaseVersion,
    "review_packet_mismatch",
  );
  const authorStory = exactRecord(
    authority.authorStory,
    ["bytes", "rawBytesSha256"],
    "review_packet_mismatch",
  );
  exactInteger(authorStory.bytes, STEAM_LAUNCH_REVIEW_AUTHORITY.authorStory.bytes, "review_packet_mismatch");
  exactString(
    authorStory.rawBytesSha256,
    STEAM_LAUNCH_REVIEW_AUTHORITY.authorStory.rawBytesSha256,
    "review_packet_mismatch",
  );
  const publicStory = exactRecord(
    authority.publicStory,
    ["bytes", "rawBytesSha256"],
    "review_packet_mismatch",
  );
  exactInteger(publicStory.bytes, STEAM_LAUNCH_REVIEW_AUTHORITY.publicStory.bytes, "review_packet_mismatch");
  exactString(
    publicStory.rawBytesSha256,
    STEAM_LAUNCH_REVIEW_AUTHORITY.publicStory.rawBytesSha256,
    "review_packet_mismatch",
  );
  const releasePolicy = exactRecord(
    packet.releasePolicy,
    [
      "discriminator",
      "policyVersion",
      "orientation",
      "aspectRatio",
      "width",
      "height",
      "fps",
      "durationSeconds",
      "audioIntent",
      "subtitleIntent",
      "policyHash",
    ],
    "review_packet_mismatch",
  );
  exactString(releasePolicy.discriminator, "STEAM_RELEASE_TARGET", "review_packet_mismatch");
  exactString(releasePolicy.policyVersion, "steam_release_v1", "review_packet_mismatch");
  exactString(releasePolicy.orientation, "landscape", "review_packet_mismatch");
  exactString(releasePolicy.aspectRatio, "16:9", "review_packet_mismatch");
  exactInteger(releasePolicy.width, 1280, "review_packet_mismatch");
  exactInteger(releasePolicy.height, 720, "review_packet_mismatch");
  exactInteger(releasePolicy.fps, 24, "review_packet_mismatch");
  exactInteger(releasePolicy.durationSeconds, 30, "review_packet_mismatch");
  exactString(releasePolicy.audioIntent, "attach", "review_packet_mismatch");
  exactString(releasePolicy.subtitleIntent, "attach_webvtt", "review_packet_mismatch");
  exactString(
    releasePolicy.policyHash,
    STEAM_LAUNCH_REVIEW_RELEASE_POLICY_HASH,
    "review_packet_mismatch",
  );

  const assets = exactArray(packet.assets, "review_packet_mismatch");
  if (assets.length !== 6) fail("review_packet_mismatch");
  const shots = exactArray(packet.shots, "review_packet_mismatch");
  if (shots.length !== STEAM_LAUNCH_REVIEW_TARGETS.length) fail("review_packet_mismatch");
  let choiceCount = 0;
  let bindingCount = 0;
  shots.forEach((rawShot, shotIndex) => {
    const target = STEAM_LAUNCH_REVIEW_TARGETS[shotIndex]!;
    const shot = exactRecord(
      rawShot,
      [
        "nodeId",
        "shotId",
        "sceneId",
        "episodeId",
        "landingBeatId",
        "production",
        "rows",
        "choices",
        "bindings",
      ],
      "review_packet_mismatch",
    );
    exactString(shot.nodeId, target.nodeId, "review_packet_mismatch");
    exactString(shot.shotId, target.shotId, "review_packet_mismatch");
    exactString(shot.sceneId, target.sceneId, "review_packet_mismatch");
    exactString(shot.episodeId, target.episodeId, "review_packet_mismatch");
    exactString(shot.landingBeatId, target.landingBeatId, "review_packet_mismatch");
    const production = exactRecord(
      shot.production,
      [
        "specId",
        "inputFingerprint",
        "sourceContentHash",
        "taskId",
        "outputRef",
        "status",
        "planStatus",
        "releaseCompatible",
        "executionAllowed",
        "referencesPrepared",
        "workflowPin",
        "blockerCodes",
      ],
      "review_packet_mismatch",
    );
    exactString(production.specId, target.specId, "review_packet_mismatch");
    exactString(production.inputFingerprint, target.inputFingerprint, "review_packet_mismatch");
    exactString(production.sourceContentHash, target.sourceContentHash, "review_packet_mismatch");
    exactString(production.taskId, target.taskId, "review_packet_mismatch");
    exactString(production.outputRef, target.outputRef, "review_packet_mismatch");
    exactString(production.status, "blocked", "review_packet_mismatch");
    exactString(production.planStatus, "blocked", "review_packet_mismatch");
    exactBoolean(production.releaseCompatible, false, "unsafe_gate");
    exactBoolean(production.executionAllowed, false, "unsafe_gate");
    exactBoolean(production.referencesPrepared, false, "unsafe_gate");
    if (production.workflowPin !== null) fail("unsafe_gate");
    exactStringArray(
      production.blockerCodes,
      ["publishable_workflow_missing", "source_reference_not_prepared"],
      "review_packet_mismatch",
    );
    const rows = exactArray(shot.rows, "review_packet_mismatch");
    if (rows.length !== target.rows.length) fail("review_packet_mismatch");
    rows.forEach((rawRow, rowOffset) => {
      const expected = target.rows[rowOffset]!;
      const row = exactRecord(
        rawRow,
        [
          "rowIndex",
          "paragraphId",
          "beatId",
          "publicText",
          "publicTextHash",
          "charCount",
          "nextKind",
          "nextBeatId",
          "choiceIds",
          "rowHash",
          "assignment",
        ],
        "review_packet_mismatch",
      );
      exactInteger(row.rowIndex, rowOffset + 1, "review_packet_mismatch");
      exactString(row.paragraphId, expected.paragraphId, "review_packet_mismatch");
      exactString(row.beatId, expected.beatId, "review_packet_mismatch");
      const text = safeText(row.publicText, "review_packet_mismatch");
      const textHash = hash64(row.publicTextHash, "review_packet_mismatch");
      if (sha256(text) !== textHash) fail("review_packet_mismatch");
      hash64(row.rowHash, "review_packet_mismatch");
      const assignment = exactRecord(
        row.assignment,
        ["speaker", "audio", "subtitle", "timing"],
        "review_packet_mismatch",
      );
      const speaker = exactRecord(
        assignment.speaker,
        ["status", "characterId"],
        "review_packet_mismatch",
      );
      exactString(speaker.status, "UNASSIGNED", "review_packet_mismatch");
      if (speaker.characterId !== null) fail("review_packet_mismatch");
      const audio = exactRecord(
        assignment.audio,
        ["status", "assetId"],
        "review_packet_mismatch",
      );
      exactString(audio.status, "UNASSIGNED", "review_packet_mismatch");
      if (audio.assetId !== null) fail("review_packet_mismatch");
      const subtitle = exactRecord(
        assignment.subtitle,
        ["status", "cueId"],
        "review_packet_mismatch",
      );
      exactString(subtitle.status, "UNASSIGNED", "review_packet_mismatch");
      if (subtitle.cueId !== null) fail("review_packet_mismatch");
      const timing = exactRecord(
        assignment.timing,
        ["status", "startMs", "endMs"],
        "review_packet_mismatch",
      );
      exactString(timing.status, "UNASSIGNED", "review_packet_mismatch");
      if (timing.startMs !== null || timing.endMs !== null) fail("review_packet_mismatch");
    });
    const choices = exactArray(shot.choices, "review_packet_mismatch");
    choiceCount += choices.length;
    const expectedChoices = STEAM_LAUNCH_REVIEW_CHOICE_PINS.filter(
      (choice) => choice.sourceNodeId === target.nodeId,
    );
    if (choices.length !== expectedChoices.length) fail("review_packet_mismatch");
    choices.forEach((rawChoice, index) => {
      const choice = exactRecord(
        rawChoice,
        [
          "choiceId",
          "sourceBeatId",
          "label",
          "labelHash",
          "labelCharCount",
          "targetNodeId",
          "targetSceneId",
          "targetEntryBeatId",
          "provenance",
          "choiceHash",
        ],
        "review_packet_mismatch",
      );
      const expected = expectedChoices[index]!;
      exactString(choice.choiceId, expected.choiceId, "review_packet_mismatch");
      exactString(choice.sourceBeatId, expected.sourceBeatId, "review_packet_mismatch");
      exactString(choice.labelHash, expected.labelHash, "review_packet_mismatch");
      exactString(choice.targetNodeId, expected.targetNodeId, "review_packet_mismatch");
      exactString(choice.targetSceneId, expected.targetSceneId, "review_packet_mismatch");
      exactString(choice.targetEntryBeatId, expected.targetEntryBeatId, "review_packet_mismatch");
      exactString(choice.provenance, expected.provenance, "review_packet_mismatch");
      hash64(choice.choiceHash, "review_packet_mismatch");
    });
    const bindings = exactArray(shot.bindings, "review_packet_mismatch");
    if (bindings.length !== STEAM_LAUNCH_REVIEW_REFERENCE_ROLES.length) {
      fail("review_packet_mismatch");
    }
    bindingCount += bindings.length;
  });
  if (choiceCount !== 5 || bindingCount !== 12) fail("review_packet_mismatch");
  const fingerprintBody: DataRecord = { ...packet };
  delete fingerprintBody.packetId;
  delete fingerprintBody.packetFingerprint;
  if (digest(sha256, fingerprintBody) !== STEAM_LAUNCH_CUE_REVIEW_BASE_PACKET_FINGERPRINT) {
    fail("review_packet_mismatch");
  }
  return result as SteamLaunchReviewPacketResult & { status: "LOCAL_REVIEW_PACKET_READY" };
}

function parseSpeaker(value: unknown): SteamLaunchCueSpeaker {
  const kind = discriminant(value, "assignment_speaker_invalid");
  if (kind === "narrator") {
    exactRecord(value, ["kind"], "assignment_speaker_invalid");
    return { kind: "narrator" };
  }
  if (kind === "character") {
    const record = exactRecord(
      value,
      ["kind", "characterId"],
      "assignment_speaker_invalid",
    );
    if (
      typeof record.characterId !== "string" ||
      !STEAM_LAUNCH_CUE_REVIEW_CHARACTER_IDS.some((entry) => entry === record.characterId)
    ) {
      fail("assignment_speaker_invalid");
    }
    return { kind: "character", characterId: record.characterId as "lanjian" };
  }
  if (kind === "none") {
    const record = exactRecord(value, ["kind", "reasonCode"], "assignment_speaker_invalid");
    exactString(
      record.reasonCode,
      STEAM_LAUNCH_CUE_REVIEW_REASON_CODES.nonSpokenRow,
      "assignment_speaker_invalid",
    );
    return { kind: "none", reasonCode: STEAM_LAUNCH_CUE_REVIEW_REASON_CODES.nonSpokenRow };
  }
  fail("assignment_speaker_invalid");
}

function parseAudio(value: unknown): SteamLaunchCueAudio {
  const kind = discriminant(value, "assignment_audio_invalid");
  if (kind === "logical_slot") {
    const record = exactRecord(value, ["kind", "slotId"], "assignment_audio_invalid");
    return {
      kind: "logical_slot",
      slotId: safeId(record.slotId, "slca1-", "assignment_audio_invalid"),
    };
  }
  if (kind === "none") {
    const record = exactRecord(value, ["kind", "reasonCode"], "assignment_audio_invalid");
    exactString(
      record.reasonCode,
      STEAM_LAUNCH_CUE_REVIEW_REASON_CODES.audioOmitted,
      "assignment_audio_invalid",
    );
    return { kind: "none", reasonCode: STEAM_LAUNCH_CUE_REVIEW_REASON_CODES.audioOmitted };
  }
  fail("assignment_audio_invalid");
}

function parseSubtitle(value: unknown): SteamLaunchCueSubtitle {
  const kind = discriminant(value, "assignment_subtitle_invalid");
  if (kind === "include") {
    const record = exactRecord(
      value,
      ["kind", "cueId", "text", "textHash"],
      "assignment_subtitle_invalid",
    );
    return {
      kind: "include",
      cueId: safeId(record.cueId, "slcc1-", "assignment_subtitle_invalid"),
      text: safeText(record.text, "assignment_subtitle_invalid"),
      textHash: hash64(record.textHash, "assignment_subtitle_invalid"),
    };
  }
  if (kind === "omit") {
    const record = exactRecord(value, ["kind", "reasonCode"], "assignment_subtitle_invalid");
    exactString(
      record.reasonCode,
      STEAM_LAUNCH_CUE_REVIEW_REASON_CODES.subtitleOmitted,
      "assignment_subtitle_invalid",
    );
    return { kind: "omit", reasonCode: STEAM_LAUNCH_CUE_REVIEW_REASON_CODES.subtitleOmitted };
  }
  fail("assignment_subtitle_invalid");
}

function parseTiming(value: unknown): SteamLaunchCueTiming {
  const kind = discriminant(value, "assignment_timing_invalid");
  if (kind === "range") {
    const record = exactRecord(value, ["kind", "startMs", "endMs"], "assignment_timing_invalid");
    if (
      !Number.isSafeInteger(record.startMs) ||
      !Number.isSafeInteger(record.endMs) ||
      Object.is(record.startMs, -0) ||
      Object.is(record.endMs, -0) ||
      (record.startMs as number) < 0 ||
      (record.endMs as number) <= (record.startMs as number) ||
      (record.endMs as number) > STEAM_LAUNCH_CUE_REVIEW_WINDOW_END_MS
    ) {
      fail("assignment_timing_invalid");
    }
    return { kind: "range", startMs: record.startMs as number, endMs: record.endMs as number };
  }
  if (kind === "none") {
    const record = exactRecord(value, ["kind", "reasonCode"], "assignment_timing_invalid");
    exactString(
      record.reasonCode,
      STEAM_LAUNCH_CUE_REVIEW_REASON_CODES.timingOmitted,
      "assignment_timing_invalid",
    );
    return { kind: "none", reasonCode: STEAM_LAUNCH_CUE_REVIEW_REASON_CODES.timingOmitted };
  }
  fail("assignment_timing_invalid");
}

function parseAssignments(
  value: unknown,
  packetResult: SteamLaunchReviewPacketResult & { status: "LOCAL_REVIEW_PACKET_READY" },
  sha256: HashFunction,
): SteamLaunchCueAssignments {
  const document = exactRecord(
    value,
    ["schema", "schemaVersion", "mode", "reviewPacketFingerprint", "language", "shots"],
    "assignments_invalid",
  );
  exactString(document.schema, STEAM_LAUNCH_CUE_ASSIGNMENTS_SCHEMA, "assignments_invalid");
  exactInteger(
    document.schemaVersion,
    STEAM_LAUNCH_CUE_ASSIGNMENTS_SCHEMA_VERSION,
    "assignments_invalid",
  );
  exactString(document.mode, STEAM_LAUNCH_CUE_ASSIGNMENTS_MODE, "assignments_invalid");
  exactString(
    document.reviewPacketFingerprint,
    STEAM_LAUNCH_CUE_REVIEW_BASE_PACKET_FINGERPRINT,
    "assignments_invalid",
  );
  exactString(document.language, STEAM_LAUNCH_CUE_REVIEW_LANGUAGE, "assignments_invalid");
  const shots = exactArray(document.shots, "assignment_coverage_mismatch");
  if (shots.length !== 3) fail("assignment_coverage_mismatch");
  const cueIds = new Set<string>();
  const slotIds = new Set<string>();
  let rowCount = 0;
  const normalizedShots = shots.map((rawShot, shotIndex) => {
    const packetShot = packetResult.packet.shots[shotIndex]!;
    const shot = exactRecord(rawShot, ["nodeId", "shotId", "rows"], "assignment_row_mismatch");
    exactString(shot.nodeId, packetShot.nodeId, "assignment_row_mismatch");
    exactString(shot.shotId, packetShot.shotId, "assignment_row_mismatch");
    const rows = exactArray(shot.rows, "assignment_coverage_mismatch");
    if (rows.length !== packetShot.rows.length) fail("assignment_coverage_mismatch");
    let previousEnd = 0;
    const normalizedRows = rows.map((rawRow, rowOffset) => {
      const packetRow = packetShot.rows[rowOffset]!;
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
        ],
        "assignment_row_mismatch",
      );
      exactInteger(row.rowIndex, packetRow.rowIndex, "assignment_row_mismatch");
      exactString(row.paragraphId, packetRow.paragraphId, "assignment_row_mismatch");
      exactString(row.beatId, packetRow.beatId, "assignment_row_mismatch");
      exactString(row.rowHash, packetRow.rowHash, "assignment_row_mismatch");
      exactString(row.publicTextHash, packetRow.publicTextHash, "assignment_row_mismatch");
      const speaker = parseSpeaker(row.speaker);
      const audio = parseAudio(row.audio);
      const subtitle = parseSubtitle(row.subtitle);
      const timing = parseTiming(row.timing);
      if (subtitle.kind === "include") {
        if (speaker.kind === "none" || audio.kind !== "logical_slot" || timing.kind !== "range") {
          fail("assignment_subtitle_invalid");
        }
        if (subtitle.text !== packetRow.publicText || subtitle.textHash !== packetRow.publicTextHash) {
          fail("assignment_subtitle_invalid");
        }
        if (sha256(subtitle.text) !== subtitle.textHash) fail("assignment_subtitle_invalid");
        if (cueIds.has(subtitle.cueId)) fail("assignment_subtitle_invalid");
        if (slotIds.has(audio.slotId)) fail("assignment_audio_invalid");
        if (timing.startMs < previousEnd) fail("assignment_timing_invalid");
        previousEnd = timing.endMs;
        cueIds.add(subtitle.cueId);
        slotIds.add(audio.slotId);
      } else if (
        speaker.kind !== "none" ||
        audio.kind !== "none" ||
        timing.kind !== "none"
      ) {
        fail("assignment_subtitle_invalid");
      }
      rowCount += 1;
      return {
        rowIndex: packetRow.rowIndex,
        paragraphId: packetRow.paragraphId,
        beatId: packetRow.beatId,
        rowHash: packetRow.rowHash,
        publicTextHash: packetRow.publicTextHash,
        speaker,
        audio,
        subtitle,
        timing,
      };
    });
    return { nodeId: packetShot.nodeId, shotId: packetShot.shotId, rows: normalizedRows };
  });
  if (rowCount !== 23) fail("assignment_coverage_mismatch");
  const normalized: SteamLaunchCueAssignments = {
    schema: STEAM_LAUNCH_CUE_ASSIGNMENTS_SCHEMA,
    schemaVersion: STEAM_LAUNCH_CUE_ASSIGNMENTS_SCHEMA_VERSION,
    mode: STEAM_LAUNCH_CUE_ASSIGNMENTS_MODE,
    reviewPacketFingerprint: STEAM_LAUNCH_CUE_REVIEW_BASE_PACKET_FINGERPRINT,
    language: STEAM_LAUNCH_CUE_REVIEW_LANGUAGE,
    shots: normalizedShots,
  };
  if (digest(sha256, normalized) !== STEAM_LAUNCH_CUE_ASSIGNMENTS_FINGERPRINT) {
    fail("assignments_invalid");
  }
  return normalized;
}

function blocked(code: SteamLaunchCueReviewFailureCode): SteamLaunchCueReviewResult {
  return {
    status: "BLOCKED",
    review: {
      schema: STEAM_LAUNCH_CUE_REVIEW_SCHEMA,
      schemaVersion: STEAM_LAUNCH_CUE_REVIEW_SCHEMA_VERSION,
      mode: STEAM_LAUNCH_CUE_REVIEW_MODE,
      status: "BLOCKED",
      overlayId: null,
      overlayFingerprint: null,
      assignmentFingerprint: null,
      reviewPacketFingerprint: STEAM_LAUNCH_CUE_REVIEW_BASE_PACKET_FINGERPRINT,
      failureCode: code,
      language: STEAM_LAUNCH_CUE_REVIEW_LANGUAGE,
      summary: {
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
      },
      shots: [],
      sourceBlockerCodes: [...STEAM_LAUNCH_REVIEW_BLOCKERS] as SteamLaunchCueReviewBlocked["sourceBlockerCodes"],
      blockerCodes: [...STEAM_LAUNCH_REVIEW_BLOCKERS] as SteamLaunchCueReviewBlocked["blockerCodes"],
      removedOverlayBlockerCodes: [],
      audioAssetsMaterialized: false,
      webVttMaterialized: false,
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

export function blockedSteamLaunchCueReview(
  code: SteamLaunchCueReviewFailureCode,
): SteamLaunchCueReviewResult {
  return blocked(code);
}

export function deriveSteamLaunchCueReview(
  basePacketResult: unknown,
  assignmentsInput: unknown,
  sha256: HashFunction,
): SteamLaunchCueReviewResult {
  try {
    const packetResult = validateBasePacket(basePacketResult, sha256);
    const assignments = parseAssignments(assignmentsInput, packetResult, sha256);
    const assignmentFingerprint = digest(sha256, assignments);
    let narratorRows = 0;
    let characterRows = 0;
    let nonSpokenRows = 0;
    let logicalAudioSlots = 0;
    let includedSubtitleCues = 0;
    let omittedSubtitleRows = 0;
    let timedRows = 0;
    const shots: SteamLaunchCueReviewShot[] = assignments.shots.map((assignmentShot, shotIndex) => {
      const packetShot = packetResult.packet.shots[shotIndex]!;
      const rows: SteamLaunchCueReviewRow[] = assignmentShot.rows.map((assignment, rowOffset) => {
        const packetRow = packetShot.rows[rowOffset]!;
        if (assignment.speaker.kind === "narrator") narratorRows += 1;
        else if (assignment.speaker.kind === "character") characterRows += 1;
        else nonSpokenRows += 1;
        if (assignment.audio.kind === "logical_slot") logicalAudioSlots += 1;
        if (assignment.subtitle.kind === "include") includedSubtitleCues += 1;
        else omittedSubtitleRows += 1;
        if (assignment.timing.kind === "range") timedRows += 1;
        return {
          ...assignment,
          publicText: packetRow.publicText,
          charCount: packetRow.charCount,
        };
      });
      const subtitleCues = rows.flatMap((row) => {
        if (row.subtitle.kind !== "include" || row.timing.kind !== "range") return [];
        return [
          {
            id: row.subtitle.cueId,
            startMs: row.timing.startMs,
            endMs: row.timing.endMs,
            text: row.subtitle.text,
            ...(row.speaker.kind === "character" ? { speaker: row.speaker.characterId } : {}),
            textHash: row.subtitle.textHash,
            rowHash: row.rowHash,
            beatId: row.beatId,
          },
        ];
      });
      return {
        nodeId: assignmentShot.nodeId,
        shotId: assignmentShot.shotId,
        rows,
        subtitleCues,
      };
    });
    const body = {
      schema: STEAM_LAUNCH_CUE_REVIEW_SCHEMA,
      schemaVersion: STEAM_LAUNCH_CUE_REVIEW_SCHEMA_VERSION,
      mode: STEAM_LAUNCH_CUE_REVIEW_MODE,
      status: "LOCAL_CUE_ASSIGNMENTS_VALIDATED" as const,
      assignmentFingerprint,
      reviewPacketFingerprint: STEAM_LAUNCH_CUE_REVIEW_BASE_PACKET_FINGERPRINT,
      language: STEAM_LAUNCH_CUE_REVIEW_LANGUAGE,
      summary: {
        shots: 3 as const,
        reviewRows: 23 as const,
        choices: 5 as const,
        referenceBindings: 12 as const,
        uniqueAssets: 6 as const,
        narratorRows,
        characterRows,
        nonSpokenRows,
        logicalAudioSlots,
        includedSubtitleCues,
        omittedSubtitleRows,
        timedRows,
      },
      shots,
      sourceBlockerCodes: [...STEAM_LAUNCH_REVIEW_BLOCKERS] as SteamLaunchCueReviewValidated["sourceBlockerCodes"],
      blockerCodes: [...STEAM_LAUNCH_CUE_REVIEW_REMAINING_BLOCKERS] as SteamLaunchCueReviewValidated["blockerCodes"],
      removedOverlayBlockerCodes: [...STEAM_LAUNCH_CUE_REVIEW_REMOVED_BLOCKERS] as SteamLaunchCueReviewValidated["removedOverlayBlockerCodes"],
      audioAssetsMaterialized: false as const,
      webVttMaterialized: false as const,
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
    const overlayFingerprint = digest(sha256, body);
    const review: SteamLaunchCueReviewValidated = {
      ...body,
      overlayId: `slcr1-${overlayFingerprint}`,
      overlayFingerprint,
    };
    return { status: "LOCAL_CUE_ASSIGNMENTS_VALIDATED", review };
  } catch (error) {
    return blocked(error instanceof CueReviewFailure ? error.code : "assignments_invalid");
  }
}

function cloneReview(
  result: SteamLaunchCueReviewResult,
): SteamLaunchCueReviewValidated | SteamLaunchCueReviewBlocked {
  if (result.status === "BLOCKED") {
    return {
      ...result.review,
      summary: { ...result.review.summary },
      shots: [],
      sourceBlockerCodes: [...result.review.sourceBlockerCodes],
      blockerCodes: [...result.review.blockerCodes],
      removedOverlayBlockerCodes: [],
      releaseGate: { satisfied: false },
    };
  }
  return {
    ...result.review,
    summary: { ...result.review.summary },
    shots: result.review.shots.map((shot) => ({
      ...shot,
      rows: shot.rows.map((row) => ({
        ...row,
        speaker: { ...row.speaker },
        audio: { ...row.audio },
        subtitle: { ...row.subtitle },
        timing: { ...row.timing },
      })),
      subtitleCues: shot.subtitleCues.map((cue) => ({ ...cue })),
    })),
    sourceBlockerCodes: [...result.review.sourceBlockerCodes],
    blockerCodes: [...result.review.blockerCodes],
    removedOverlayBlockerCodes: [...result.review.removedOverlayBlockerCodes],
    releaseGate: { satisfied: false },
  };
}

export function serializeSteamLaunchCueReviewJson(result: SteamLaunchCueReviewResult): string {
  return `${canonical(cloneReview(result))}\n`;
}

function webVttTimestamp(milliseconds: number): string {
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1_000);
  const remainder = milliseconds % 1_000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(remainder).padStart(3, "0")}`;
}

export function serializeSteamLaunchCueReviewWebVtt(
  result: SteamLaunchCueReviewResult,
  nodeId: string,
): string | null {
  if (result.status === "BLOCKED") return null;
  const shot = result.review.shots.find((entry) => entry.nodeId === nodeId);
  if (!shot || !STEAM_LAUNCH_REVIEW_TARGETS.some((target) => target.nodeId === nodeId)) {
    return null;
  }
  const blocks = shot.subtitleCues.map(
    (cue) =>
      `${cue.id}\n${webVttTimestamp(cue.startMs)} --> ${webVttTimestamp(cue.endMs)}\n${cue.text}`,
  );
  return blocks.length === 0 ? "WEBVTT\n\n" : `WEBVTT\n\n${blocks.join("\n\n")}\n`;
}
