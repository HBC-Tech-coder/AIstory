import "server-only";

import { STEAM_RELEASE_TARGET_POLICY } from "@/lib/steam/productionSpec";
import {
  STEAM_REFERENCE_PREPARATION_AUTHORITY,
  STEAM_REFERENCE_PREPARATION_MODE,
  STEAM_REFERENCE_PREPARATION_SCHEMA,
  STEAM_REFERENCE_PREPARATION_SCHEMA_VERSION,
} from "@/lib/steam/referencePreparation";

export const STEAM_LAUNCH_REVIEW_PACKET_SCHEMA =
  "aistory-steam-launch-review-packet" as const;
export const STEAM_LAUNCH_REVIEW_PACKET_SCHEMA_VERSION = 1 as const;
export const STEAM_LAUNCH_REVIEW_PACKET_MODE = "local_plan_only" as const;

export const STEAM_LAUNCH_REVIEW_AUTHORITY = Object.freeze({
  caseId: "virtual-girlfriend-20260727",
  storyId: "case:virtual-girlfriend-20260727",
  storyVersion: "author-locked-v1.1",
  projectRef: "case-study:virtual-girlfriend-20260727",
  authorReleaseVersion: "v1.1",
  authorStory: Object.freeze({
    bytes: 134_298,
    rawBytesSha256:
      "c48d1f53f48c2ddb4a62fe89aa7e14ed84a895af68bc49e6323f59aef35f0ab1",
  }),
  publicStory: Object.freeze({
    bytes: 47_895,
    rawBytesSha256:
      "26b54b8532f3a9e6107a4dabc0b34ceabcd3f7709292f243ade96cf661a3a3cc",
  }),
} as const);

export const STEAM_LAUNCH_REVIEW_RELEASE_POLICY_HASH =
  "47aec1252f7c9aba7a9d0ff6358dff152ec15cd5094bd781e80bf257047259a6" as const;
export const STEAM_LAUNCH_REVIEW_LOCAL_INTEGRITY_FINGERPRINT =
  "ac44cd20cf8efa8b9f4305c2fd4ae324c60df8e8a64775b00c8a94dc05c06875" as const;

export const STEAM_LAUNCH_REVIEW_BLOCKERS = Object.freeze([
  "source_reference_not_prepared",
  "publishable_workflow_missing",
  "manual_cue_review_required",
] as const);

export const STEAM_LAUNCH_REVIEW_REFERENCE_ROLES = Object.freeze([
  "source_frame",
  "identity_face",
  "home_outfit",
  "expressions",
] as const);

export const STEAM_LAUNCH_REVIEW_TARGETS = Object.freeze([
  Object.freeze({
    nodeId: "vg11_wake_choice",
    shotId: "VG11-SHOT-02",
    sceneId: "VG11-S01",
    episodeId: "VG11-EP01",
    landingBeatId: "vg11_wake_choice_b2",
    sourceFrameAssetId: "vg11-kf-wake",
    sourceContentHash:
      "5446cc48e998927613e050eb994d8137df6575ed692e8baa375c356976113ed0",
    specId:
      "svgs2-4b99cbdcc987a63687d19e3659b9a1390201428da6b3fde863aaf51dbab55cb9",
    inputFingerprint:
      "760992fa4cc40233c38f5a95a016d745bdaeecc6649712ce7a8a1eb9a3763759",
    taskId:
      "svp1-0858ae144799e79385e1b910-5446cc48e998927613e050eb-original_video",
    outputRef:
      "steam-video:v1:0858ae144799e79385e1b910:5446cc48e998927613e050eb:original_video",
    rows: Object.freeze([
      Object.freeze({ paragraphId: "P009", beatId: "vg11_wake_choice_b1" }),
      Object.freeze({ paragraphId: "P010", beatId: "vg11_wake_choice_b2" }),
    ]),
  }),
  Object.freeze({
    nodeId: "vg11_breakfast_choice",
    shotId: "VG11-SHOT-04",
    sceneId: "VG11-S03",
    episodeId: "VG11-EP01",
    landingBeatId: "vg11_breakfast_choice_b8",
    sourceFrameAssetId: "vg11-kf-breakfast",
    sourceContentHash:
      "c5c6cda991e5f07d2d06a6bfbc42ac6d631588cdde1a60dfa3512075bca1dedc",
    specId:
      "svgs2-a830782fd55aea28814aa71b582cdc702cc0b8170416c7f309bfc6480820f8a8",
    inputFingerprint:
      "38ab3450de53b6c0b5b00d188d50aa2d7f650dc17bd2405c6d36333772b5c758",
    taskId:
      "svp1-0858ae144799e79385e1b910-c5c6cda991e5f07d2d06a6bf-original_video",
    outputRef:
      "steam-video:v1:0858ae144799e79385e1b910:c5c6cda991e5f07d2d06a6bf:original_video",
    rows: Object.freeze(
      Array.from({ length: 8 }, (_, index) =>
        Object.freeze({
          paragraphId: `P${String(index + 23).padStart(3, "0")}`,
          beatId: `vg11_breakfast_choice_b${index + 1}`,
        }),
      ),
    ),
  }),
  Object.freeze({
    nodeId: "vg11_wake_pull",
    shotId: "VG11-SHOT-05",
    sceneId: "VG11-S02B",
    episodeId: "VG11-EP01",
    landingBeatId: "vg11_wake_pull_b13",
    sourceFrameAssetId: "vg11-kf-pull-up",
    sourceContentHash:
      "da32dc9b276815acd795ef896ab98b5789b8da523352004d26a087e6d4b9b886",
    specId:
      "svgs2-8c9fc5cc731eea0c367205f781d90bdf8416394ebd907cd66619f3cfa139c4fd",
    inputFingerprint:
      "214b2c7a83a8fdf03e36308a916f15111323734c00cb53499a66bf54b52819ba",
    taskId:
      "svp1-0858ae144799e79385e1b910-da32dc9b276815acd795ef89-original_video",
    outputRef:
      "steam-video:v1:0858ae144799e79385e1b910:da32dc9b276815acd795ef89:original_video",
    rows: Object.freeze(
      Array.from({ length: 13 }, (_, index) =>
        Object.freeze({
          paragraphId: `P${String(index + 31).padStart(3, "0")}`,
          beatId: `vg11_wake_pull_b${index + 1}`,
        }),
      ),
    ),
  }),
] as const);

export const STEAM_LAUNCH_REVIEW_CHOICE_PINS = Object.freeze([
  Object.freeze({
    sourceNodeId: "vg11_wake_choice",
    sourceBeatId: "vg11_wake_choice_b2",
    choiceId: "vg11_c_wake_sleep",
    targetNodeId: "vg11_wake_sleep",
    targetSceneId: "VG11-S02A",
    targetEntryBeatId: "vg11_wake_sleep_b1",
    provenance: "explicit_choice",
    labelHash: "50a2f47ed1873158e4ba78ef302c64bd2512225c7c84893463d4f7609e05981e",
    labelCharCount: 9,
  }),
  Object.freeze({
    sourceNodeId: "vg11_wake_choice",
    sourceBeatId: "vg11_wake_choice_b2",
    choiceId: "vg11_c_wake_pull",
    targetNodeId: "vg11_wake_pull",
    targetSceneId: "VG11-S02B",
    targetEntryBeatId: "vg11_wake_pull_b1",
    provenance: "explicit_choice",
    labelHash: "5f56f446ebe2d50de1613d11640e1a0544c483c9882057f38118b103f1864dfb",
    labelCharCount: 8,
  }),
  Object.freeze({
    sourceNodeId: "vg11_breakfast_choice",
    sourceBeatId: "vg11_breakfast_choice_b8",
    choiceId: "vg11_c_breakfast_angry",
    targetNodeId: "vg11_breakfast_angry",
    targetSceneId: "VG11-S04A",
    targetEntryBeatId: "vg11_breakfast_angry_b1",
    provenance: "explicit_choice",
    labelHash: "d9ef4cab36d302fe27b7658c386ed353d75c7aaf38e5ed81035bae9bb77242e0",
    labelCharCount: 12,
  }),
  Object.freeze({
    sourceNodeId: "vg11_breakfast_choice",
    sourceBeatId: "vg11_breakfast_choice_b8",
    choiceId: "vg11_c_breakfast_calm",
    targetNodeId: "vg11_breakfast_calm",
    targetSceneId: "VG11-S04B",
    targetEntryBeatId: "vg11_breakfast_calm_b1",
    provenance: "explicit_choice",
    labelHash: "6eb5eab0ce6304b6ca832541f6a136887103fefea3873b7823bf839797aeb4b8",
    labelCharCount: 12,
  }),
  Object.freeze({
    sourceNodeId: "vg11_wake_pull",
    sourceBeatId: "vg11_wake_pull_b13",
    choiceId: "vg11_wake_pull_continue",
    targetNodeId: "vg11_breakfast_choice",
    targetSceneId: "VG11-S03",
    targetEntryBeatId: "vg11_breakfast_choice_b1",
    provenance: "derived_next",
    labelHash: "7c9691192f1b73408bbe4c0cb6d00db94375ca9d8fce0a0d5985e7a5178f083f",
    labelCharCount: 2,
  }),
] as const);

export const STEAM_LAUNCH_REVIEW_ROW_TEXT_PINS = Object.freeze({
  vg11_wake_choice_b1: Object.freeze({
    hash: "2c740098792ef2be3deab670632458ecfcab0ab9e1f1e682a3c25659e6396421",
    charCount: 6,
  }),
  vg11_wake_choice_b2: Object.freeze({
    hash: "72436ee3d4f4460e917b76a2546523e6ff02c40697d5726f09f8982578756d46",
    charCount: 13,
  }),
  vg11_breakfast_choice_b1: Object.freeze({
    hash: "f1c7499d1c2ff7978a42f808cf445b31f980d38d576329f1d158735c721b48ab",
    charCount: 18,
  }),
  vg11_breakfast_choice_b2: Object.freeze({
    hash: "4a997ea7271323a514d3b38371eafdb1e5c85b30e8b3dfeac1ff18818e33a4cc",
    charCount: 25,
  }),
  vg11_breakfast_choice_b3: Object.freeze({
    hash: "2c2c9a60e41944ab45c6b81428ee5c49425deee7f898ba446cdf7eb12b83de2e",
    charCount: 17,
  }),
  vg11_breakfast_choice_b4: Object.freeze({
    hash: "0427e110c656d5b2459c6b191436890e779610a21bce6d49c7aefaed2ce606a4",
    charCount: 88,
  }),
  vg11_breakfast_choice_b5: Object.freeze({
    hash: "740dca38154cf0f0a9687068096390766b22c93df3757dc9b8f5628b13e38a6e",
    charCount: 16,
  }),
  vg11_breakfast_choice_b6: Object.freeze({
    hash: "32d867727962dcfe7fc7003c7fbcd970db924756e93b9a04c601d707bf0d2c0c",
    charCount: 39,
  }),
  vg11_breakfast_choice_b7: Object.freeze({
    hash: "2c740098792ef2be3deab670632458ecfcab0ab9e1f1e682a3c25659e6396421",
    charCount: 6,
  }),
  vg11_breakfast_choice_b8: Object.freeze({
    hash: "83f8c4fc2135bc4264f261326d6cf6ecb8afe8353bfe3051aefb3e0b96bc721b",
    charCount: 20,
  }),
  vg11_wake_pull_b1: Object.freeze({
    hash: "02bc4404fc1c5af5d0020f4f8fbae8c565a7aac4e54121f4dd6058d89208be80",
    charCount: 6,
  }),
  vg11_wake_pull_b2: Object.freeze({
    hash: "3ced2022060997ade5778732b42214df1634b544a76d0f218bff1b8a2fee2b9c",
    charCount: 8,
  }),
  vg11_wake_pull_b3: Object.freeze({
    hash: "1e12e847afe5e831ec2432fd07d396644229644b68ed444110926e2ecae4cc72",
    charCount: 15,
  }),
  vg11_wake_pull_b4: Object.freeze({
    hash: "04fae9d74cc4a1fed30834365f9adf4983e5614f3ba6a8a14bd7c21963521639",
    charCount: 23,
  }),
  vg11_wake_pull_b5: Object.freeze({
    hash: "852c3632dfa0ae713d35d42f8a4c5708a211509e2324ba6dde597984492b322e",
    charCount: 35,
  }),
  vg11_wake_pull_b6: Object.freeze({
    hash: "460940a62602e9374764eef75e64daafe4fad68f0847b5aaf80147e068381378",
    charCount: 4,
  }),
  vg11_wake_pull_b7: Object.freeze({
    hash: "00154df552247b01e0c4a7f657dc18678dcf230904b7357ef615f8869934a39c",
    charCount: 10,
  }),
  vg11_wake_pull_b8: Object.freeze({
    hash: "286fac7809f79b601f9c71ec6be3170c4642faf019365c4fac26ad6a479ad816",
    charCount: 5,
  }),
  vg11_wake_pull_b9: Object.freeze({
    hash: "d807fed927412748798d9de410949cf753655c7862db798546e2f1c74eb68af9",
    charCount: 20,
  }),
  vg11_wake_pull_b10: Object.freeze({
    hash: "52575e38fff21084d0fae8f976120590bf00192f4ade74bdb1457df49a33439a",
    charCount: 19,
  }),
  vg11_wake_pull_b11: Object.freeze({
    hash: "87f3355be165b3b94051a928c02ef3deeb727948c0232b8c0b4409f1db9cb67c",
    charCount: 30,
  }),
  vg11_wake_pull_b12: Object.freeze({
    hash: "16cca60927fbb52a88490e6944e89d630853224f911e53cfcb187d5d50d17e9e",
    charCount: 12,
  }),
  vg11_wake_pull_b13: Object.freeze({
    hash: "f06f0b392dabc7b659b57bb67795f5f30a63a7e0daf5f641d27c1e1d4f072255",
    charCount: 12,
  }),
} as const);

export const STEAM_LAUNCH_REVIEW_ASSET_PINS = Object.freeze([
  Object.freeze({
    assetId: "vg11-char-expression-reference",
    kind: "expression_sheet",
    bytes: 2_089_975,
    sha256: "26413e9b8c6a690f3284878d3241d630ba755a5bcc393a1099d835b2caa7597f",
  }),
  Object.freeze({
    assetId: "vg11-char-face-reference",
    kind: "character_base",
    bytes: 1_791_749,
    sha256: "390262b5125b6d3b8b0d02996bd1dab15a4d25d9d5d2f79bd2b849ec3f24032a",
  }),
  Object.freeze({
    assetId: "vg11-char-home-outfit-reference",
    kind: "outfit_sheet",
    bytes: 1_861_662,
    sha256: "102aae24bfdc03608763f153cfeb5a568776549da2c2722a36814911c593310b",
  }),
  Object.freeze({
    assetId: "vg11-kf-breakfast",
    kind: "keyframe",
    bytes: 1_841_942,
    sha256: "04cc8aadfdd00dd79962bb5062079d09f59e7c173bf3a9419bd56e107d10df15",
  }),
  Object.freeze({
    assetId: "vg11-kf-pull-up",
    kind: "keyframe",
    bytes: 1_820_066,
    sha256: "14ffb9f340d86916fd2d7a8c7874b14fc7e10044a8cd2052e38732326a2050b4",
  }),
  Object.freeze({
    assetId: "vg11-kf-wake",
    kind: "keyframe",
    bytes: 1_741_510,
    sha256: "dc403b7da99253fadbf7382195941692bdf5b228978e889b571e5d98e7a670ad",
  }),
] as const);

export type SteamLaunchReviewFailureCode =
  | "input_invalid"
  | "authority_mismatch"
  | "release_policy_mismatch"
  | "production_spec_mismatch"
  | "local_integrity_invalid"
  | "local_manifest_mismatch"
  | "coverage_mismatch"
  | "row_mismatch"
  | "choice_mismatch"
  | "binding_mismatch"
  | "asset_mismatch"
  | "blocker_mismatch"
  | "unsafe_gate"
  | "authority_unavailable";

export type SteamLaunchReviewPacketInput = {
  authority: {
    caseId: string;
    storyId: string;
    storyVersion: string;
    projectRef: string;
    authorReleaseVersion: string;
    authorStory: { bytes: number; rawBytesSha256: string };
    publicStory: { bytes: number; rawBytesSha256: string };
  };
  releasePolicy: {
    discriminator: string;
    policyVersion: string;
    policyHash: string;
    orientation: string;
    aspectRatio: string;
    width: number;
    height: number;
    fps: number;
    durationSeconds: number;
    audioIntent: string;
    subtitleIntent: string;
  };
  localIntegrity: {
    schema: string;
    schemaVersion: number;
    mode: string;
    status: string;
    manifestFingerprint: string | null;
    sourceManifests: {
      assetManifest: { schemaVersion: number; bytes: number; sha256: string };
      videoPrompts: { schemaVersion: number; bytes: number; sha256: string };
    } | null;
    summary: {
      shots: number;
      bindings: number;
      uniqueAssets: number;
      localVerifiedAssets: number;
    };
    executionAllowed: boolean;
    providerPreparation: string;
    providerContacted: boolean;
    providerReferenceHandlesIssued: number;
    gpuProbed: boolean;
    networkCalls: number;
    writesPerformed: number;
    releaseGateSatisfied: boolean;
    blockerCodes: string[];
    assets: Array<{
      assetId: string;
      kind: string;
      bytes: number;
      sha256: string;
      mediaType: string;
      localIntegrity: string;
    }>;
  };
  shots: Array<{
    nodeId: string;
    shotId: string;
    sceneId: string;
    episodeId: string;
    landingBeatId: string;
    production: {
      specId: string;
      inputFingerprint: string;
      sourceContentHash: string;
      taskId: string;
      outputRef: string;
      status: string;
      planStatus: string;
      releaseCompatible: boolean;
      executionAllowed: boolean;
      referencesPrepared: boolean;
      workflowPin: unknown;
      blockerCodes: string[];
    };
    rows: Array<{
      rowIndex: number;
      paragraphId: string;
      beatId: string;
      publicText: string;
      publicTextHash: string;
      authorityTextHash: string;
      charCount: number;
      nextKind: string;
      nextBeatId: string | null;
      choiceIds: string[];
    }>;
    choices: Array<{
      choiceId: string;
      sourceBeatId: string;
      label: string;
      labelHash: string;
      labelCharCount: number;
      targetNodeId: string;
      targetSceneId: string;
      targetEntryBeatId: string;
      provenance: string;
    }>;
    bindings: Array<{
      role: string;
      referenceId: string | null;
      assetId: string;
      sha256: string;
      bytes: number;
      mediaType: string;
      localIntegrity: string;
      prepared: boolean;
    }>;
  }>;
};

export type SteamLaunchReviewAssignment = {
  speaker: { status: "UNASSIGNED"; characterId: null };
  audio: { status: "UNASSIGNED"; assetId: null };
  subtitle: { status: "UNASSIGNED"; cueId: null };
  timing: { status: "UNASSIGNED"; startMs: null; endMs: null };
};

export type SteamLaunchReviewRow = Omit<
  SteamLaunchReviewPacketInput["shots"][number]["rows"][number],
  "authorityTextHash"
> & {
  rowHash: string;
  assignment: SteamLaunchReviewAssignment;
};

export type SteamLaunchReviewChoice =
  SteamLaunchReviewPacketInput["shots"][number]["choices"][number] & {
    choiceHash: string;
  };

export type SteamLaunchReviewPacket = {
  schema: typeof STEAM_LAUNCH_REVIEW_PACKET_SCHEMA;
  schemaVersion: typeof STEAM_LAUNCH_REVIEW_PACKET_SCHEMA_VERSION;
  mode: typeof STEAM_LAUNCH_REVIEW_PACKET_MODE;
  status: "LOCAL_REVIEW_PACKET_READY";
  packetId: string;
  packetFingerprint: string;
  authority: typeof STEAM_LAUNCH_REVIEW_AUTHORITY & {
    assetManifest: typeof STEAM_REFERENCE_PREPARATION_AUTHORITY.assetManifest;
    videoPrompts: typeof STEAM_REFERENCE_PREPARATION_AUTHORITY.videoPrompts;
  };
  releasePolicy: {
    discriminator: "STEAM_RELEASE_TARGET";
    policyVersion: "steam_release_v1";
    policyHash: typeof STEAM_LAUNCH_REVIEW_RELEASE_POLICY_HASH;
    orientation: "landscape";
    aspectRatio: "16:9";
    width: 1280;
    height: 720;
    fps: 24;
    durationSeconds: 30;
    audioIntent: "attach";
    subtitleIntent: "attach_webvtt";
  };
  localIntegrity: {
    status: "LOCAL_VERIFIED_ONLY";
    manifestFingerprint: typeof STEAM_LAUNCH_REVIEW_LOCAL_INTEGRITY_FINGERPRINT;
  };
  subtitleTarget: {
    locale: "zh-CN";
    format: "webvtt";
    windowStartMs: 0;
    windowEndMs: 30_000;
    cuesAssigned: false;
  };
  summary: {
    shots: 3;
    reviewRows: 23;
    choices: 5;
    referenceBindings: 12;
    uniqueAssets: 6;
  };
  shots: Array<{
    nodeId: string;
    shotId: string;
    sceneId: string;
    episodeId: string;
    landingBeatId: string;
    production: SteamLaunchReviewPacketInput["shots"][number]["production"];
    rows: SteamLaunchReviewRow[];
    choices: SteamLaunchReviewChoice[];
    bindings: SteamLaunchReviewPacketInput["shots"][number]["bindings"];
  }>;
  assets: SteamLaunchReviewPacketInput["localIntegrity"]["assets"];
  blockerCodes: [
    "source_reference_not_prepared",
    "publishable_workflow_missing",
    "manual_cue_review_required",
  ];
  playbackReady: false;
  executionAllowed: false;
  publishAllowed: false;
  jobWriteAllowed: false;
  providerPreparation: "NOT_ATTEMPTED";
  providerContacted: false;
  providerReferenceHandlesIssued: 0;
  gpuProbed: false;
  networkCalls: 0;
  writesPerformed: 0;
  releaseGate: { satisfied: false };
};

export type SteamLaunchReviewBlocked = {
  schema: typeof STEAM_LAUNCH_REVIEW_PACKET_SCHEMA;
  schemaVersion: typeof STEAM_LAUNCH_REVIEW_PACKET_SCHEMA_VERSION;
  mode: typeof STEAM_LAUNCH_REVIEW_PACKET_MODE;
  status: "BLOCKED";
  packetId: null;
  packetFingerprint: null;
  failureCode: SteamLaunchReviewFailureCode;
  summary: {
    shots: 0;
    reviewRows: 0;
    choices: 0;
    referenceBindings: 0;
    uniqueAssets: 0;
  };
  blockerCodes: [
    "source_reference_not_prepared",
    "publishable_workflow_missing",
    "manual_cue_review_required",
  ];
  playbackReady: false;
  executionAllowed: false;
  publishAllowed: false;
  jobWriteAllowed: false;
  providerPreparation: "NOT_ATTEMPTED";
  providerContacted: false;
  providerReferenceHandlesIssued: 0;
  gpuProbed: false;
  networkCalls: 0;
  writesPerformed: 0;
  releaseGate: { satisfied: false };
};

export type SteamLaunchReviewPacketResult =
  | { status: "LOCAL_REVIEW_PACKET_READY"; packet: SteamLaunchReviewPacket }
  | { status: "BLOCKED"; packet: null; publicResult: SteamLaunchReviewBlocked };

type DataRecord = Record<string, unknown>;
type HashFunction = (value: string) => string;

const SHA256 = /^[a-f0-9]{64}$/;
const INTEGER_KEY = /^(?:0|[1-9][0-9]*)$/;
const MAX_PUBLIC_TEXT = 4096;
const ROOT_KEYS = ["authority", "releasePolicy", "localIntegrity", "shots"];
const AUTHORITY_KEYS = [
  "caseId",
  "storyId",
  "storyVersion",
  "projectRef",
  "authorReleaseVersion",
  "authorStory",
  "publicStory",
];
const FILE_PIN_KEYS = ["bytes", "rawBytesSha256"];
const POLICY_KEYS = [
  "discriminator",
  "policyVersion",
  "policyHash",
  "orientation",
  "aspectRatio",
  "width",
  "height",
  "fps",
  "durationSeconds",
  "audioIntent",
  "subtitleIntent",
];
const LOCAL_KEYS = [
  "schema",
  "schemaVersion",
  "mode",
  "status",
  "manifestFingerprint",
  "sourceManifests",
  "summary",
  "executionAllowed",
  "providerPreparation",
  "providerContacted",
  "providerReferenceHandlesIssued",
  "gpuProbed",
  "networkCalls",
  "writesPerformed",
  "releaseGateSatisfied",
  "blockerCodes",
  "assets",
];
const SOURCE_MANIFESTS_KEYS = ["assetManifest", "videoPrompts"];
const SOURCE_MANIFEST_KEYS = ["schemaVersion", "bytes", "sha256"];
const LOCAL_SUMMARY_KEYS = ["shots", "bindings", "uniqueAssets", "localVerifiedAssets"];
const ASSET_KEYS = ["assetId", "kind", "bytes", "sha256", "mediaType", "localIntegrity"];
const SHOT_KEYS = [
  "nodeId",
  "shotId",
  "sceneId",
  "episodeId",
  "landingBeatId",
  "production",
  "rows",
  "choices",
  "bindings",
];
const PRODUCTION_KEYS = [
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
];
const ROW_KEYS = [
  "rowIndex",
  "paragraphId",
  "beatId",
  "publicText",
  "publicTextHash",
  "authorityTextHash",
  "charCount",
  "nextKind",
  "nextBeatId",
  "choiceIds",
];
const CHOICE_KEYS = [
  "choiceId",
  "sourceBeatId",
  "label",
  "labelHash",
  "labelCharCount",
  "targetNodeId",
  "targetSceneId",
  "targetEntryBeatId",
  "provenance",
];
const BINDING_KEYS = [
  "role",
  "referenceId",
  "assetId",
  "sha256",
  "bytes",
  "mediaType",
  "localIntegrity",
  "prepared",
];

class ReviewFailure extends Error {
  constructor(readonly code: SteamLaunchReviewFailureCode) {
    super(code);
  }
}

function fail(code: SteamLaunchReviewFailureCode): never {
  throw new ReviewFailure(code);
}

function asciiCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  code: SteamLaunchReviewFailureCode,
): DataRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return fail(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return fail(code);
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.some((key) => typeof key === "symbol") ||
    ownKeys.length !== keys.length ||
    keys.some((key) => !ownKeys.includes(key))
  ) {
    return fail(code);
  }
  const result: DataRecord = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return fail(code);
    result[key] = descriptor.value;
  }
  return result;
}

function exactArray(value: unknown, code: SteamLaunchReviewFailureCode): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return fail(code);
  const keys = Reflect.ownKeys(value);
  if (
    keys.some(
      (key) =>
        typeof key === "symbol" ||
        (key !== "length" && (!INTEGER_KEY.test(key) || Number(key) >= value.length)),
    ) ||
    keys.length !== value.length + 1
  ) {
    return fail(code);
  }
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return fail(code);
    result.push(descriptor.value);
  }
  return result;
}

function exactString(value: unknown, expected: string, code: SteamLaunchReviewFailureCode): string {
  if (value !== expected) return fail(code);
  return expected;
}

function exactInteger(value: unknown, expected: number, code: SteamLaunchReviewFailureCode): number {
  if (!Number.isSafeInteger(value) || value !== expected) return fail(code);
  return expected;
}

function exactBoolean(value: unknown, expected: boolean, code: SteamLaunchReviewFailureCode): boolean {
  if (value !== expected) return fail(code);
  return expected;
}

function exactStringSet(
  value: unknown,
  expected: readonly string[],
  code: SteamLaunchReviewFailureCode,
): string[] {
  const values = exactArray(value, code).map((entry) => {
    if (typeof entry !== "string") return fail(code);
    return entry;
  });
  if (values.length !== expected.length || new Set(values).size !== values.length) return fail(code);
  const sorted = [...values].sort(asciiCompare);
  const expectedSorted = [...expected].sort(asciiCompare);
  if (sorted.some((entry, index) => entry !== expectedSorted[index])) return fail(code);
  return expectedSorted;
}

function publicText(value: unknown, code: SteamLaunchReviewFailureCode): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_PUBLIC_TEXT ||
    value.includes("\0")
  ) {
    return fail(code);
  }
  return value;
}

function canonical(value: unknown, stack = new Set<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw new Error("canonical_invalid");
    return String(value);
  }
  if (typeof value !== "object" || stack.has(value)) throw new Error("canonical_invalid");
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) throw new Error("canonical_invalid");
      return `[${exactArray(value, "input_invalid").map((entry) => canonical(entry, stack)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("canonical_invalid");
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key === "symbol")) throw new Error("canonical_invalid");
    return `{${(keys as string[])
      .sort(asciiCompare)
      .map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          throw new Error("canonical_invalid");
        }
        return `${JSON.stringify(key)}:${canonical(descriptor.value, stack)}`;
      })
      .join(",")}}`;
  } finally {
    stack.delete(value);
  }
}

function digest(sha256: HashFunction, value: unknown): string {
  const result = sha256(typeof value === "string" ? value : canonical(value));
  if (!SHA256.test(result)) return fail("input_invalid");
  return result;
}

function assignment(): SteamLaunchReviewAssignment {
  return {
    speaker: { status: "UNASSIGNED", characterId: null },
    audio: { status: "UNASSIGNED", assetId: null },
    subtitle: { status: "UNASSIGNED", cueId: null },
    timing: { status: "UNASSIGNED", startMs: null, endMs: null },
  };
}

function blocked(code: SteamLaunchReviewFailureCode): SteamLaunchReviewPacketResult {
  return {
    status: "BLOCKED",
    packet: null,
    publicResult: {
      schema: STEAM_LAUNCH_REVIEW_PACKET_SCHEMA,
      schemaVersion: STEAM_LAUNCH_REVIEW_PACKET_SCHEMA_VERSION,
      mode: STEAM_LAUNCH_REVIEW_PACKET_MODE,
      status: "BLOCKED",
      packetId: null,
      packetFingerprint: null,
      failureCode: code,
      summary: { shots: 0, reviewRows: 0, choices: 0, referenceBindings: 0, uniqueAssets: 0 },
      blockerCodes: [...STEAM_LAUNCH_REVIEW_BLOCKERS],
      playbackReady: false,
      executionAllowed: false,
      publishAllowed: false,
      jobWriteAllowed: false,
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

export function deriveSteamLaunchReviewPacket(
  input: SteamLaunchReviewPacketInput,
  sha256: HashFunction,
): SteamLaunchReviewPacketResult {
  try {
    const root = exactRecord(input, ROOT_KEYS, "input_invalid");
    const authority = exactRecord(root.authority, AUTHORITY_KEYS, "authority_mismatch");
    for (const key of ["caseId", "storyId", "storyVersion", "projectRef", "authorReleaseVersion"] as const) {
      exactString(authority[key], STEAM_LAUNCH_REVIEW_AUTHORITY[key], "authority_mismatch");
    }
    for (const key of ["authorStory", "publicStory"] as const) {
      const pin = exactRecord(authority[key], FILE_PIN_KEYS, "authority_mismatch");
      exactInteger(pin.bytes, STEAM_LAUNCH_REVIEW_AUTHORITY[key].bytes, "authority_mismatch");
      exactString(
        pin.rawBytesSha256,
        STEAM_LAUNCH_REVIEW_AUTHORITY[key].rawBytesSha256,
        "authority_mismatch",
      );
    }

    const policy = exactRecord(root.releasePolicy, POLICY_KEYS, "release_policy_mismatch");
    const expectedPolicy = {
      ...STEAM_RELEASE_TARGET_POLICY,
      policyHash: STEAM_LAUNCH_REVIEW_RELEASE_POLICY_HASH,
    } as const;
    for (const [key, expected] of Object.entries(expectedPolicy)) {
      if (typeof expected === "number") exactInteger(policy[key], expected, "release_policy_mismatch");
      else exactString(policy[key], expected, "release_policy_mismatch");
    }
    if (digest(sha256, STEAM_RELEASE_TARGET_POLICY) !== STEAM_LAUNCH_REVIEW_RELEASE_POLICY_HASH) {
      return fail("release_policy_mismatch");
    }

    const local = exactRecord(root.localIntegrity, LOCAL_KEYS, "local_integrity_invalid");
    exactString(local.schema, STEAM_REFERENCE_PREPARATION_SCHEMA, "local_integrity_invalid");
    exactInteger(
      local.schemaVersion,
      STEAM_REFERENCE_PREPARATION_SCHEMA_VERSION,
      "local_integrity_invalid",
    );
    exactString(local.mode, STEAM_REFERENCE_PREPARATION_MODE, "local_integrity_invalid");
    exactString(local.status, "LOCAL_VERIFIED_ONLY", "local_integrity_invalid");
    exactString(
      local.manifestFingerprint,
      STEAM_LAUNCH_REVIEW_LOCAL_INTEGRITY_FINGERPRINT,
      "local_manifest_mismatch",
    );
    exactBoolean(local.executionAllowed, false, "unsafe_gate");
    exactString(local.providerPreparation, "NOT_ATTEMPTED", "unsafe_gate");
    exactBoolean(local.providerContacted, false, "unsafe_gate");
    exactInteger(local.providerReferenceHandlesIssued, 0, "unsafe_gate");
    exactBoolean(local.gpuProbed, false, "unsafe_gate");
    exactInteger(local.networkCalls, 0, "unsafe_gate");
    exactInteger(local.writesPerformed, 0, "unsafe_gate");
    exactBoolean(local.releaseGateSatisfied, false, "unsafe_gate");
    exactStringSet(local.blockerCodes, ["source_reference_not_prepared"], "blocker_mismatch");
    const sourcePins = exactRecord(
      local.sourceManifests,
      SOURCE_MANIFESTS_KEYS,
      "local_manifest_mismatch",
    );
    for (const [key, expected] of Object.entries({
      assetManifest: STEAM_REFERENCE_PREPARATION_AUTHORITY.assetManifest,
      videoPrompts: STEAM_REFERENCE_PREPARATION_AUTHORITY.videoPrompts,
    })) {
      const pin = exactRecord(sourcePins[key], SOURCE_MANIFEST_KEYS, "local_manifest_mismatch");
      exactInteger(pin.schemaVersion, expected.schemaVersion, "local_manifest_mismatch");
      exactInteger(pin.bytes, expected.bytes, "local_manifest_mismatch");
      exactString(pin.sha256, expected.sha256, "local_manifest_mismatch");
    }
    const localSummary = exactRecord(local.summary, LOCAL_SUMMARY_KEYS, "coverage_mismatch");
    exactInteger(localSummary.shots, 3, "coverage_mismatch");
    exactInteger(localSummary.bindings, 12, "coverage_mismatch");
    exactInteger(localSummary.uniqueAssets, 6, "coverage_mismatch");
    exactInteger(localSummary.localVerifiedAssets, 6, "coverage_mismatch");

    const rawAssets = exactArray(local.assets, "asset_mismatch");
    const assetsById = new Map<string, SteamLaunchReviewPacketInput["localIntegrity"]["assets"][number]>();
    for (const rawAsset of rawAssets) {
      const asset = exactRecord(rawAsset, ASSET_KEYS, "asset_mismatch");
      if (typeof asset.assetId !== "string" || assetsById.has(asset.assetId)) return fail("asset_mismatch");
      const pin = STEAM_LAUNCH_REVIEW_ASSET_PINS.find((candidate) => candidate.assetId === asset.assetId);
      if (!pin) return fail("asset_mismatch");
      exactString(asset.kind, pin.kind, "asset_mismatch");
      exactInteger(asset.bytes, pin.bytes, "asset_mismatch");
      exactString(asset.sha256, pin.sha256, "asset_mismatch");
      exactString(asset.mediaType, "image/png", "asset_mismatch");
      exactString(asset.localIntegrity, "verified", "asset_mismatch");
      assetsById.set(pin.assetId, {
        assetId: pin.assetId,
        kind: pin.kind,
        bytes: pin.bytes,
        sha256: pin.sha256,
        mediaType: "image/png",
        localIntegrity: "verified",
      });
    }
    if (
      assetsById.size !== 6 ||
      STEAM_LAUNCH_REVIEW_ASSET_PINS.some((pin) => !assetsById.has(pin.assetId))
    ) {
      return fail("asset_mismatch");
    }

    const rawShots = exactArray(root.shots, "coverage_mismatch");
    const shotsByNode = new Map<string, DataRecord>();
    for (const rawShot of rawShots) {
      const shot = exactRecord(rawShot, SHOT_KEYS, "coverage_mismatch");
      if (typeof shot.nodeId !== "string" || shotsByNode.has(shot.nodeId)) return fail("coverage_mismatch");
      shotsByNode.set(shot.nodeId, shot);
    }
    if (shotsByNode.size !== 3) return fail("coverage_mismatch");

    const normalizedShots: SteamLaunchReviewPacket["shots"] = [];
    for (const target of STEAM_LAUNCH_REVIEW_TARGETS) {
      const shot = shotsByNode.get(target.nodeId);
      if (!shot) return fail("coverage_mismatch");
      exactString(shot.nodeId, target.nodeId, "coverage_mismatch");
      exactString(shot.shotId, target.shotId, "coverage_mismatch");
      exactString(shot.sceneId, target.sceneId, "coverage_mismatch");
      exactString(shot.episodeId, target.episodeId, "coverage_mismatch");
      exactString(shot.landingBeatId, target.landingBeatId, "coverage_mismatch");

      const production = exactRecord(shot.production, PRODUCTION_KEYS, "production_spec_mismatch");
      for (const key of [
        "specId",
        "inputFingerprint",
        "sourceContentHash",
        "taskId",
        "outputRef",
      ] as const) {
        exactString(production[key], target[key], "production_spec_mismatch");
      }
      exactString(production.status, "blocked", "production_spec_mismatch");
      exactString(production.planStatus, "blocked", "production_spec_mismatch");
      exactBoolean(production.releaseCompatible, false, "production_spec_mismatch");
      exactBoolean(production.executionAllowed, false, "unsafe_gate");
      exactBoolean(production.referencesPrepared, false, "unsafe_gate");
      if (production.workflowPin !== null) return fail("unsafe_gate");
      exactStringSet(
        production.blockerCodes,
        ["source_reference_not_prepared", "publishable_workflow_missing"],
        "blocker_mismatch",
      );
      const normalizedProduction = {
        specId: target.specId,
        inputFingerprint: target.inputFingerprint,
        sourceContentHash: target.sourceContentHash,
        taskId: target.taskId,
        outputRef: target.outputRef,
        status: "blocked",
        planStatus: "blocked",
        releaseCompatible: false,
        executionAllowed: false,
        referencesPrepared: false,
        workflowPin: null,
        blockerCodes: ["publishable_workflow_missing", "source_reference_not_prepared"],
      };

      const rawRows = exactArray(shot.rows, "row_mismatch");
      if (rawRows.length !== target.rows.length) return fail("row_mismatch");
      const rowsByIndex = new Map<number, DataRecord>();
      for (const rawRow of rawRows) {
        const row = exactRecord(rawRow, ROW_KEYS, "row_mismatch");
        if (!Number.isSafeInteger(row.rowIndex) || rowsByIndex.has(Number(row.rowIndex))) {
          return fail("row_mismatch");
        }
        rowsByIndex.set(Number(row.rowIndex), row);
      }
      const normalizedRows: SteamLaunchReviewRow[] = [];
      for (let index = 0; index < target.rows.length; index += 1) {
        const row = rowsByIndex.get(index + 1);
        if (!row) return fail("row_mismatch");
        const rowPin = target.rows[index]!;
        exactInteger(row.rowIndex, index + 1, "row_mismatch");
        exactString(row.paragraphId, rowPin.paragraphId, "row_mismatch");
        exactString(row.beatId, rowPin.beatId, "row_mismatch");
        const text = publicText(row.publicText, "row_mismatch");
        const textHash = digest(sha256, text);
        const textPin = STEAM_LAUNCH_REVIEW_ROW_TEXT_PINS[
          rowPin.beatId as keyof typeof STEAM_LAUNCH_REVIEW_ROW_TEXT_PINS
        ];
        if (!textPin) return fail("row_mismatch");
        exactString(textHash, textPin.hash, "row_mismatch");
        exactString(row.publicTextHash, textHash, "row_mismatch");
        exactString(row.authorityTextHash, textHash, "row_mismatch");
        exactInteger(row.charCount, textPin.charCount, "row_mismatch");
        exactInteger(Array.from(text).length, textPin.charCount, "row_mismatch");
        const isLast = index === target.rows.length - 1;
        exactString(row.nextKind, isLast ? "choice" : "continue", "row_mismatch");
        if (isLast) {
          if (row.nextBeatId !== null) return fail("row_mismatch");
        } else {
          exactString(row.nextBeatId, target.rows[index + 1]!.beatId, "row_mismatch");
        }
        const expectedChoiceIds = STEAM_LAUNCH_REVIEW_CHOICE_PINS.filter(
          (choice) => choice.sourceNodeId === target.nodeId,
        ).map((choice) => choice.choiceId);
        exactStringSet(row.choiceIds, isLast ? expectedChoiceIds : [], "row_mismatch");
        const rowHash = digest(sha256, {
          nodeId: target.nodeId,
          sceneId: target.sceneId,
          shotId: target.shotId,
          rowIndex: index + 1,
          paragraphId: rowPin.paragraphId,
          beatId: rowPin.beatId,
          textHash,
          nextKind: isLast ? "choice" : "continue",
          nextBeatId: isLast ? null : target.rows[index + 1]!.beatId,
          choiceIds: isLast ? expectedChoiceIds : [],
        });
        normalizedRows.push({
          rowIndex: index + 1,
          paragraphId: rowPin.paragraphId,
          beatId: rowPin.beatId,
          publicText: text,
          publicTextHash: textHash,
          charCount: textPin.charCount,
          nextKind: isLast ? "choice" : "continue",
          nextBeatId: isLast ? null : target.rows[index + 1]!.beatId,
          choiceIds: isLast ? expectedChoiceIds : [],
          rowHash,
          assignment: assignment(),
        });
      }

      const expectedChoices = STEAM_LAUNCH_REVIEW_CHOICE_PINS.filter(
        (choice) => choice.sourceNodeId === target.nodeId,
      );
      const rawChoices = exactArray(shot.choices, "choice_mismatch");
      const choiceById = new Map<string, DataRecord>();
      for (const rawChoice of rawChoices) {
        const choice = exactRecord(rawChoice, CHOICE_KEYS, "choice_mismatch");
        if (typeof choice.choiceId !== "string" || choiceById.has(choice.choiceId)) {
          return fail("choice_mismatch");
        }
        choiceById.set(choice.choiceId, choice);
      }
      if (choiceById.size !== expectedChoices.length) return fail("choice_mismatch");
      const normalizedChoices: SteamLaunchReviewChoice[] = [];
      for (const choicePin of expectedChoices) {
        const choice = choiceById.get(choicePin.choiceId);
        if (!choice) return fail("choice_mismatch");
        for (const key of [
          "choiceId",
          "sourceBeatId",
          "targetNodeId",
          "targetSceneId",
          "targetEntryBeatId",
          "provenance",
        ] as const) {
          exactString(choice[key], choicePin[key], "choice_mismatch");
        }
        const label = publicText(choice.label, "choice_mismatch");
        const labelHash = digest(sha256, label);
        exactString(labelHash, choicePin.labelHash, "choice_mismatch");
        exactString(choice.labelHash, labelHash, "choice_mismatch");
        exactInteger(choice.labelCharCount, choicePin.labelCharCount, "choice_mismatch");
        exactInteger(Array.from(label).length, choicePin.labelCharCount, "choice_mismatch");
        const choiceHash = digest(sha256, {
          sourceNodeId: choicePin.sourceNodeId,
          sourceBeatId: choicePin.sourceBeatId,
          choiceId: choicePin.choiceId,
          provenance: choicePin.provenance,
          labelHash,
          targetNodeId: choicePin.targetNodeId,
          targetSceneId: choicePin.targetSceneId,
          targetEntryBeatId: choicePin.targetEntryBeatId,
        });
        normalizedChoices.push({
          choiceId: choicePin.choiceId,
          sourceBeatId: choicePin.sourceBeatId,
          label,
          labelHash,
          labelCharCount: choicePin.labelCharCount,
          targetNodeId: choicePin.targetNodeId,
          targetSceneId: choicePin.targetSceneId,
          targetEntryBeatId: choicePin.targetEntryBeatId,
          provenance: choicePin.provenance,
          choiceHash,
        });
      }

      const rawBindings = exactArray(shot.bindings, "binding_mismatch");
      const bindingByRole = new Map<string, DataRecord>();
      for (const rawBinding of rawBindings) {
        const binding = exactRecord(rawBinding, BINDING_KEYS, "binding_mismatch");
        if (typeof binding.role !== "string" || bindingByRole.has(binding.role)) {
          return fail("binding_mismatch");
        }
        bindingByRole.set(binding.role, binding);
      }
      if (bindingByRole.size !== 4) return fail("binding_mismatch");
      const normalizedBindings: SteamLaunchReviewPacketInput["shots"][number]["bindings"] = [];
      for (const role of STEAM_LAUNCH_REVIEW_REFERENCE_ROLES) {
        const binding = bindingByRole.get(role);
        if (!binding) return fail("binding_mismatch");
        const expectedAssetId =
          role === "source_frame"
            ? target.sourceFrameAssetId
            : role === "identity_face"
              ? "vg11-char-face-reference"
              : role === "home_outfit"
                ? "vg11-char-home-outfit-reference"
                : "vg11-char-expression-reference";
        const expectedReferenceId =
          role === "source_frame"
            ? null
            : role === "identity_face"
              ? "R1_FACE"
              : role === "home_outfit"
                ? "R2_HOME_OUTFIT"
                : "R4_EXPRESSIONS";
        if (binding.referenceId !== expectedReferenceId) return fail("binding_mismatch");
        exactString(binding.assetId, expectedAssetId, "binding_mismatch");
        const asset = assetsById.get(expectedAssetId);
        if (!asset) return fail("binding_mismatch");
        exactString(binding.sha256, asset.sha256, "binding_mismatch");
        exactInteger(binding.bytes, asset.bytes, "binding_mismatch");
        exactString(binding.mediaType, "image/png", "binding_mismatch");
        exactString(binding.localIntegrity, "verified", "binding_mismatch");
        exactBoolean(binding.prepared, false, "unsafe_gate");
        normalizedBindings.push({
          role,
          referenceId: expectedReferenceId,
          assetId: expectedAssetId,
          sha256: asset.sha256,
          bytes: asset.bytes,
          mediaType: "image/png",
          localIntegrity: "verified",
          prepared: false,
        });
      }

      normalizedShots.push({
        nodeId: target.nodeId,
        shotId: target.shotId,
        sceneId: target.sceneId,
        episodeId: target.episodeId,
        landingBeatId: target.landingBeatId,
        production: normalizedProduction,
        rows: normalizedRows,
        choices: normalizedChoices,
        bindings: normalizedBindings,
      });
    }

    const reviewRows = normalizedShots.reduce((total, shot) => total + shot.rows.length, 0);
    const choices = normalizedShots.reduce((total, shot) => total + shot.choices.length, 0);
    const bindings = normalizedShots.reduce((total, shot) => total + shot.bindings.length, 0);
    if (reviewRows !== 23 || choices !== 5 || bindings !== 12) return fail("coverage_mismatch");
    const assets = STEAM_LAUNCH_REVIEW_ASSET_PINS.map((pin) => {
      const asset = assetsById.get(pin.assetId);
      if (!asset) return fail("asset_mismatch");
      return { ...asset };
    });
    const body = {
      schema: STEAM_LAUNCH_REVIEW_PACKET_SCHEMA,
      schemaVersion: STEAM_LAUNCH_REVIEW_PACKET_SCHEMA_VERSION,
      mode: STEAM_LAUNCH_REVIEW_PACKET_MODE,
      status: "LOCAL_REVIEW_PACKET_READY" as const,
      authority: {
        ...STEAM_LAUNCH_REVIEW_AUTHORITY,
        assetManifest: { ...STEAM_REFERENCE_PREPARATION_AUTHORITY.assetManifest },
        videoPrompts: { ...STEAM_REFERENCE_PREPARATION_AUTHORITY.videoPrompts },
      },
      releasePolicy: {
        ...STEAM_RELEASE_TARGET_POLICY,
        policyHash: STEAM_LAUNCH_REVIEW_RELEASE_POLICY_HASH,
      },
      localIntegrity: {
        status: "LOCAL_VERIFIED_ONLY" as const,
        manifestFingerprint: STEAM_LAUNCH_REVIEW_LOCAL_INTEGRITY_FINGERPRINT,
      },
      subtitleTarget: {
        locale: "zh-CN" as const,
        format: "webvtt" as const,
        windowStartMs: 0 as const,
        windowEndMs: 30_000 as const,
        cuesAssigned: false as const,
      },
      summary: {
        shots: 3 as const,
        reviewRows: 23 as const,
        choices: 5 as const,
        referenceBindings: 12 as const,
        uniqueAssets: 6 as const,
      },
      shots: normalizedShots,
      assets,
      blockerCodes: [...STEAM_LAUNCH_REVIEW_BLOCKERS] as SteamLaunchReviewPacket["blockerCodes"],
      playbackReady: false as const,
      executionAllowed: false as const,
      publishAllowed: false as const,
      jobWriteAllowed: false as const,
      providerPreparation: "NOT_ATTEMPTED" as const,
      providerContacted: false as const,
      providerReferenceHandlesIssued: 0 as const,
      gpuProbed: false as const,
      networkCalls: 0 as const,
      writesPerformed: 0 as const,
      releaseGate: { satisfied: false as const },
    };
    const packetFingerprint = digest(sha256, body);
    const packet: SteamLaunchReviewPacket = {
      ...body,
      packetId: `slrp1-${packetFingerprint}`,
      packetFingerprint,
    };
    return { status: "LOCAL_REVIEW_PACKET_READY", packet };
  } catch (error) {
    return blocked(error instanceof ReviewFailure ? error.code : "input_invalid");
  }
}

export function blockedSteamLaunchReviewPacket(
  code: SteamLaunchReviewFailureCode,
): SteamLaunchReviewPacketResult {
  return blocked(code);
}

export function redactSteamLaunchReviewPacket(
  result: SteamLaunchReviewPacketResult,
): SteamLaunchReviewPacket | SteamLaunchReviewBlocked {
  if (result.status === "BLOCKED") {
    return {
      ...result.publicResult,
      summary: { ...result.publicResult.summary },
      blockerCodes: [...result.publicResult.blockerCodes],
      releaseGate: { satisfied: false },
    };
  }
  const packet = result.packet;
  return {
    ...packet,
    authority: {
      ...packet.authority,
      authorStory: { ...packet.authority.authorStory },
      publicStory: { ...packet.authority.publicStory },
      assetManifest: { ...packet.authority.assetManifest },
      videoPrompts: { ...packet.authority.videoPrompts },
    },
    releasePolicy: { ...packet.releasePolicy },
    localIntegrity: { ...packet.localIntegrity },
    subtitleTarget: { ...packet.subtitleTarget },
    summary: { ...packet.summary },
    shots: packet.shots.map((shot) => ({
      ...shot,
      production: { ...shot.production, blockerCodes: [...shot.production.blockerCodes] },
      rows: shot.rows.map((row) => ({
        ...row,
        choiceIds: [...row.choiceIds],
        assignment: {
          speaker: { ...row.assignment.speaker },
          audio: { ...row.assignment.audio },
          subtitle: { ...row.assignment.subtitle },
          timing: { ...row.assignment.timing },
        },
      })),
      choices: shot.choices.map((choice) => ({ ...choice })),
      bindings: shot.bindings.map((binding) => ({ ...binding })),
    })),
    assets: packet.assets.map((asset) => ({ ...asset })),
    blockerCodes: [...packet.blockerCodes],
    releaseGate: { satisfied: false },
  };
}

export function serializeSteamLaunchReviewPacketJson(
  result: SteamLaunchReviewPacketResult,
): string {
  return `${canonical(redactSteamLaunchReviewPacket(result))}\n`;
}

function csvCell(value: string | number | null): string {
  const raw = value === null ? "" : String(value);
  const guarded = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${guarded.replace(/"/g, '""')}"`;
}

export function serializeSteamLaunchReviewPacketCsv(
  result: SteamLaunchReviewPacketResult,
): string {
  const header = [
    "schemaVersion",
    "packetId",
    "nodeId",
    "shotId",
    "sceneId",
    "episodeId",
    "paragraphId",
    "beatId",
    "publicText",
    "publicTextHash",
    "charCount",
    "rowHash",
    "speakerStatus",
    "speakerId",
    "audioStatus",
    "audioAssetId",
    "subtitleStatus",
    "subtitleCueId",
    "timingStatus",
    "startMs",
    "endMs",
    "subtitleLocale",
    "subtitleFormat",
    "windowStartMs",
    "windowEndMs",
  ];
  if (result.status === "BLOCKED") return `${header.map(csvCell).join(",")}\n`;
  const packet = result.packet;
  const rows = packet.shots.flatMap((shot) =>
    shot.rows.map((row) => [
      packet.schemaVersion,
      packet.packetId,
      shot.nodeId,
      shot.shotId,
      shot.sceneId,
      shot.episodeId,
      row.paragraphId,
      row.beatId,
      row.publicText,
      row.publicTextHash,
      row.charCount,
      row.rowHash,
      row.assignment.speaker.status,
      row.assignment.speaker.characterId,
      row.assignment.audio.status,
      row.assignment.audio.assetId,
      row.assignment.subtitle.status,
      row.assignment.subtitle.cueId,
      row.assignment.timing.status,
      row.assignment.timing.startMs,
      row.assignment.timing.endMs,
      packet.subtitleTarget.locale,
      packet.subtitleTarget.format,
      packet.subtitleTarget.windowStartMs,
      packet.subtitleTarget.windowEndMs,
    ]),
  );
  return `${header.map(csvCell).join(",")}\n${rows
    .map((row) => row.map((value) => csvCell(value)).join(","))
    .join("\n")}\n`;
}
