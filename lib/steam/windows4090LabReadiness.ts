import "server-only";

import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import {
  canonicalSteamLaunchCueReviewPreview,
  deriveSteamLaunchCueReviewPreviewBundle,
  type SteamLaunchCueReviewPreviewBundleResult,
} from "@/lib/steam/launchCueReviewPreviewBundle";
import type { SteamLaunchCueMaterializationPreflightResult } from "@/lib/steam/launchCueMaterializationPreflight";
import type { SteamLaunchCueReviewResult } from "@/lib/steam/launchCueReview";
import type { SteamLaunchReviewPacketResult } from "@/lib/steam/launchReviewPacket";
import type { SteamReferencePreparationManifest } from "@/lib/steam/referencePreparation";

export const STEAM_WINDOWS_4090_LAB_READINESS_SCHEMA =
  "aistory-steam-windows-4090-lab-readiness" as const;
export const STEAM_WINDOWS_4090_LAB_READINESS_SCHEMA_VERSION = 1 as const;
export const STEAM_WINDOWS_4090_LAB_READINESS_MODE =
  "local_readiness_authorization_only" as const;

export const STEAM_WINDOWS_4090_LAB_SOURCE_PINS = Object.freeze({
  referencePreparationFingerprint:
    "ac44cd20cf8efa8b9f4305c2fd4ae324c60df8e8a64775b00c8a94dc05c06875",
  reviewPacketFingerprint:
    "fda3ec7088d07225d6486afa38471f4cc88f79e67d3a1506caac2fb894d1c397",
  cueReviewOverlayFingerprint:
    "c2b0ba35e8e4def09e59afa8591dbedc5e7ae2e7249562daca29010f0940fca3",
  cueAssignmentFingerprint:
    "e5708c15cbf3416808fd5046b462f19c4d98772814b8ec135b78b8da9e23ebf2",
  materializationPreflightFingerprint:
    "ddbe762fc145284ff1681bc5543ecef34786d3df07ef14b52845a5ca7c240ad8",
  privatePreviewBundleFingerprint:
    "2401bffdd1f765e22f1ab1c6222e90ebe6b9442e5823060c73cd79cf5f56b857",
} as const);

export const STEAM_WINDOWS_4090_LAB_AUTHORITY = Object.freeze({
  caseId: "virtual-girlfriend-20260727",
  storyId: "case:virtual-girlfriend-20260727",
  storyVersion: "author-locked-v1.1",
  projectRef: "case-study:virtual-girlfriend-20260727",
  authorReleaseVersion: "v1.1",
} as const);

export const STEAM_WINDOWS_4090_LAB_TARGET = Object.freeze({
  nodeId: "vg11_breakfast_choice",
  shotId: "VG11-SHOT-04",
  sceneId: "VG11-S03",
  episodeId: "VG11-EP01",
  landingBeatId: "vg11_breakfast_choice_b8",
  sourceFrameAssetId: "vg11-kf-breakfast",
  sourceContentHash:
    "c5c6cda991e5f07d2d06a6bfbc42ac6d631588cdde1a60dfa3512075bca1dedc",
} as const);

const RELEASE_SPEC_ID =
  "svgs2-a830782fd55aea28814aa71b582cdc702cc0b8170416c7f309bfc6480820f8a8";
const RELEASE_INPUT_FINGERPRINT =
  "38ab3450de53b6c0b5b00d188d50aa2d7f650dc17bd2405c6d36333772b5c758";
const RELEASE_POLICY_HASH =
  "47aec1252f7c9aba7a9d0ff6358dff152ec15cd5094bd781e80bf257047259a6";

export const STEAM_WINDOWS_4090_LAB_REFERENCES = Object.freeze([
  Object.freeze({
    role: "source_frame",
    referenceId: null,
    assetId: "vg11-kf-breakfast",
    bytes: 1_841_942,
    sha256: "04cc8aadfdd00dd79962bb5062079d09f59e7c173bf3a9419bd56e107d10df15",
  }),
  Object.freeze({
    role: "identity_face",
    referenceId: "R1_FACE",
    assetId: "vg11-char-face-reference",
    bytes: 1_791_749,
    sha256: "390262b5125b6d3b8b0d02996bd1dab15a4d25d9d5d2f79bd2b849ec3f24032a",
  }),
  Object.freeze({
    role: "home_outfit",
    referenceId: "R2_HOME_OUTFIT",
    assetId: "vg11-char-home-outfit-reference",
    bytes: 1_861_662,
    sha256: "102aae24bfdc03608763f153cfeb5a568776549da2c2722a36814911c593310b",
  }),
  Object.freeze({
    role: "expressions",
    referenceId: "R4_EXPRESSIONS",
    assetId: "vg11-char-expression-reference",
    bytes: 2_089_975,
    sha256: "26413e9b8c6a690f3284878d3241d630ba755a5bcc393a1099d835b2caa7597f",
  }),
] as const);

export const STEAM_WINDOWS_4090_LAB_POLICY = Object.freeze({
  discriminator: "LAB_NON_PUBLISHABLE",
  policyVersion: "windows_rtx_4090_lab_original_v1",
  hostProfile: "WINDOWS_X64_RTX_4090",
  stage: "original",
  width: 768,
  height: 480,
  aspectRatio: "8:5",
  frameCount: 81,
  fps: 24,
  durationMs: 3_375,
  hasAudio: true,
  retry: 0,
  upscaleAllowed: false,
  subtitleInput: "NONE",
  privateReviewVttAttached: false,
  attachedSubtitleArtifacts: 0,
} as const);

export const STEAM_WINDOWS_4090_LAB_WORKFLOW_PIN = Object.freeze({
  workflowId: "ltx23-original-av-lab",
  workflowSha256:
    "f3465cacbf88e139a0f4708ed887d875edab72cc5d28c0c6b40c91519362794e",
  parameterBindingSha256:
    "5da94127a97fe313d1c279f8a486a579faf0eedf4ad2d5f84b14940f73e18d15",
} as const);

export const STEAM_WINDOWS_4090_P1_8_CENTRAL_PIN = Object.freeze({
  inputCount: 4,
  centralGoldenBytes: 6_699,
  centralGoldenSha256:
    "e97deff32dbc55f2a4953263289ddbcd3acd75dfd2ca7bca81247d09b3f148b4",
} as const);

export const STEAM_WINDOWS_4090_FORBIDDEN_CONNECTOR_PACKAGE_SHA256 =
  "7812b7938a29dd45b6c91b0675f641bd6cc0fbc0f7ba5e4082cb7cd015a480d1" as const;

export const STEAM_WINDOWS_4090_INHERITED_BLOCKERS = Object.freeze({
  release: Object.freeze([
    "source_reference_not_prepared",
    "publishable_workflow_missing",
  ]),
  targetContent: Object.freeze(["subtitle_density_exceeded"]),
  upstreamPrivatePreviewContent: Object.freeze([
    "subtitle_density_exceeded",
    "editorial_marker_present",
  ]),
} as const);

export const STEAM_WINDOWS_4090_CONTROLLED_EVIDENCE_BLOCKERS = Object.freeze([
  "windows_host_profile_missing",
  "repaired_connector_qualification_missing",
  "protected_runtime_binding_missing",
  "fresh_no_work_receipt_missing",
  "exact_workflow_binding_missing",
  "controlled_reference_handles_missing",
  "windows_model_provenance_license_missing",
  "current_host_health_missing",
] as const);

export type SteamWindows4090LabReadinessFailureCode =
  | "source_unavailable"
  | "source_contract_mismatch"
  | "reference_integrity_mismatch"
  | "evidence_invalid"
  | "evidence_join_mismatch"
  | "freshness_invalid"
  | "windows_profile_mismatch"
  | "ubuntu_profile_forbidden"
  | "workflow_pin_mismatch"
  | "reference_handle_binding_mismatch";

export type SteamWindows4090LabReadinessSources = {
  referencePreparation: SteamReferencePreparationManifest;
  reviewPacket: SteamLaunchReviewPacketResult;
  cueReview: SteamLaunchCueReviewResult;
  materializationPreflight: SteamLaunchCueMaterializationPreflightResult;
  previewBundle: SteamLaunchCueReviewPreviewBundleResult;
};

export type SteamWindows4090LabControlledEvidence = {
  schema: "aistory-steam-windows-4090-controlled-evidence";
  schemaVersion: 1;
  evaluationContext: null | {
    evaluatedAtEpochMs: number;
    maxNoWorkAgeMs: 300_000;
    maxHostHealthAgeMs: 60_000;
  };
  windowsHostProfile: null | {
    status: "INDEPENDENT_WINDOWS_HOST_PROFILE_VERIFIED";
    profileId: "windows-rtx4090-lab-v1";
    os: "windows";
    architecture: "x64";
    gpuClass: "NVIDIA_RTX_4090";
    profileFingerprint: string;
  };
  connectorQualification: null | {
    schemaVersion: "aistory-gpu-connector-package-qualification-v1";
    status: "OFFLINE_PACKAGE_STATIC_QUALIFIED";
    packageDisposition: "REAL_REPAIRED_CONNECTOR_PACKAGE";
    realPackage: true;
    inputCount: 4;
    centralGoldenBytes: 6699;
    centralGoldenSha256: string;
    packageSha256: string;
    externalManifestSha256: string;
    goldenSidecarSha256: string;
    identity: {
      connectorVersion: string;
      buildSha256: string;
      releaseSha256: string;
      capabilityDigestSha256: string;
      centralContractSha256: string;
    };
    staticSafety: {
      provenanceVerified: false;
      signatureVerified: false;
      runtimeBindingVerified: false;
      noWorkExecuted: false;
      gpuExecuted: false;
      deployable: false;
      networkCalls: 0;
      archiveCodeExecuted: false;
    };
    compatibility: {
      firstHeartbeat: "idle";
      runnerMode: "no_work_only";
      noWorkOnlyFirstGate: true;
      connectorFakeTestsExecuted: false;
    };
    qualificationReceiptSha256: string;
  };
  protectedRuntimeBinding: null | {
    schema: "aistory-steam-windows-4090-protected-runtime-binding-receipt";
    schemaVersion: 1;
    status: "PROTECTED_RUNTIME_BOUND";
    profileFingerprint: string;
    qualificationReceiptSha256: string;
    connectorIdentitySha256: string;
    centralContractSha256: string;
    productionNetworkEnabled: false;
    lanLabNetworkEnabled: true;
    runnerMode: "no_work_only";
    runtimeBindingSha256: string;
  };
  freshNoWorkReceipt: null | {
    status: "PASS_FRESH_NO_WORK_ONLY";
    runnerMode: "no_work_only";
    firstHeartbeatState: "idle";
    profileFingerprint: string;
    runtimeBindingSha256: string;
    qualificationReceiptSha256: string;
    registrationReceiptSha256: string;
    sessionBindingSha256: string;
    sequence: ["fresh_registration", "first_heartbeat_idle", "no_work_only"];
    observedAtEpochMs: number;
    expiresAtEpochMs: number;
    businessTasksClaimed: 0;
    providerCalls: 0;
    gpuAcquisitions: 0;
    controlledConnectorRequests: 3;
    externalProviderNetworkCalls: 0;
    receiptSha256: string;
  };
  exactWorkflowBinding: null | {
    status: "EXACT_WINDOWS_WORKFLOW_BOUND";
    profileFingerprint: string;
    runtimeBindingSha256: string;
    workflowId: typeof STEAM_WINDOWS_4090_LAB_WORKFLOW_PIN.workflowId;
    workflowSha256: typeof STEAM_WINDOWS_4090_LAB_WORKFLOW_PIN.workflowSha256;
    parameterBindingSha256:
      typeof STEAM_WINDOWS_4090_LAB_WORKFLOW_PIN.parameterBindingSha256;
    policyVersion: typeof STEAM_WINDOWS_4090_LAB_POLICY.policyVersion;
    shotId: typeof STEAM_WINDOWS_4090_LAB_TARGET.shotId;
    stage: "original";
    noWorkReceiptSha256: string;
    bindingReceiptSha256: string;
  };
  controlledReferenceHandles: null | {
    status: "CONTROLLED_REFERENCE_HANDLES_BOUND";
    shotId: typeof STEAM_WINDOWS_4090_LAB_TARGET.shotId;
    count: 4;
    workflowBindingReceiptSha256: string;
    handleSetReceiptSha256: string;
    references: Array<{
      role: (typeof STEAM_WINDOWS_4090_LAB_REFERENCES)[number]["role"];
      assetId: string;
      assetSha256: string;
      handleBindingSha256: string;
    }>;
  };
  windowsModelProvenanceLicense: null | {
    status: "WINDOWS_PROVENANCE_LICENSE_VERIFIED";
    workflowSha256: typeof STEAM_WINDOWS_4090_LAB_WORKFLOW_PIN.workflowSha256;
    generationUse: "INTERNAL_GENERATION_CONDITIONAL_PASS";
    weightsDistributionAllowed: false;
    provenanceReceiptSha256: string;
    licenseReceiptSha256: string;
  };
  currentHostHealth: null | {
    status: "CURRENT_WINDOWS_HOST_HEALTHY";
    profileFingerprint: string;
    runtimeBindingSha256: string;
    sessionBindingSha256: string;
    noWorkReceiptSha256: string;
    queueState: "empty";
    observedAtEpochMs: number;
    expiresAtEpochMs: number;
    healthReceiptSha256: string;
  };
};

type EvidenceKey = Exclude<
  keyof SteamWindows4090LabControlledEvidence,
  "schema" | "schemaVersion" | "evaluationContext"
>;

export type SteamWindows4090LabPacket = {
  schema: typeof STEAM_WINDOWS_4090_LAB_READINESS_SCHEMA;
  schemaVersion: typeof STEAM_WINDOWS_4090_LAB_READINESS_SCHEMA_VERSION;
  mode: typeof STEAM_WINDOWS_4090_LAB_READINESS_MODE;
  status: "BLOCKED" | "FOUNDER_AUTHORIZATION_REQUIRED";
  packetId: string;
  packetFingerprint: string;
  authority: typeof STEAM_WINDOWS_4090_LAB_AUTHORITY;
  sourcePins: typeof STEAM_WINDOWS_4090_LAB_SOURCE_PINS;
  target: typeof STEAM_WINDOWS_4090_LAB_TARGET;
  references: Array<{
    role: (typeof STEAM_WINDOWS_4090_LAB_REFERENCES)[number]["role"];
    referenceId: string | null;
    assetId: string;
    bytes: number;
    sha256: string;
    mediaType: "image/png";
    localIntegrity: "verified";
    providerPrepared: false;
  }>;
  policy: typeof STEAM_WINDOWS_4090_LAB_POLICY & {
    audioMaterialized: false;
    audioSyncVerified: false;
  };
  inheritedBlockerCodes: {
    release: Array<(typeof STEAM_WINDOWS_4090_INHERITED_BLOCKERS.release)[number]>;
    targetContent: Array<
      (typeof STEAM_WINDOWS_4090_INHERITED_BLOCKERS.targetContent)[number]
    >;
    upstreamPrivatePreviewContent: Array<
      (typeof STEAM_WINDOWS_4090_INHERITED_BLOCKERS.upstreamPrivatePreviewContent)[number]
    >;
  };
  upstreamPrivatePreview: {
    status: "INCOMPLETE";
    contentReviewSatisfied: false;
    candidateSetComplete: false;
    attachedToLabTask: false;
  };
  controlledEvidence: {
    evidenceSetFingerprint: string | null;
    independentWindowsHostProfile: boolean;
    repairedConnectorQualification: boolean;
    protectedRuntimeBinding: boolean;
    freshNoWorkReceipt: boolean;
    exactWorkflowBinding: boolean;
    controlledReferenceHandles: boolean;
    windowsModelProvenanceLicense: boolean;
    currentHostHealth: boolean;
    allSatisfied: boolean;
  };
  blockerCodes: string[];
  authorization: {
    registrationAndNoWorkOnlyRequiredFirst: true;
    registrationAndNoWorkOnlyPassed: boolean;
    proposedAction: "foreground_once" | null;
    taskCount: 1;
    retry: 0;
    foregroundOnceProposalAllowed: boolean;
    secondExactFounderAuthorizationRequired: true;
    authorizationGranted: false;
    foregroundRunsAuthorized: 0;
  };
  playbackReady: false;
  playbackSyncVerified: false;
  reviewSatisfied: false;
  adopted: false;
  executionAllowed: false;
  jobWriteAllowed: false;
  publishAllowed: false;
  providerPreparation: "NOT_ATTEMPTED";
  providerContacted: false;
  providerReferenceHandlesIssuedByPacket: 0;
  gpuProbed: false;
  networkCalls: 0;
  writesPerformed: 0;
  releaseGate: { satisfied: false };
};

export type SteamWindows4090LabReadinessResult =
  | {
      status: "BLOCKED" | "FOUNDER_AUTHORIZATION_REQUIRED";
      packet: SteamWindows4090LabPacket;
      failureCode: null;
    }
  | {
      status: "BLOCKED";
      packet: null;
      failureCode: SteamWindows4090LabReadinessFailureCode;
      executionAllowed: false;
      jobWriteAllowed: false;
      providerContacted: false;
      gpuProbed: false;
      networkCalls: 0;
      writesPerformed: 0;
    };

type DataRecord = Record<string, unknown>;

class LabReadinessFailure extends Error {
  constructor(readonly code: SteamWindows4090LabReadinessFailureCode) {
    super(code);
  }
}

function fail(code: SteamWindows4090LabReadinessFailureCode): never {
  throw new LabReadinessFailure(code);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) fail("source_contract_mismatch");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as DataRecord).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  fail("source_contract_mismatch");
}

function assertDeepDataOnly(
  value: unknown,
  code: SteamWindows4090LabReadinessFailureCode,
  seen = new Set<object>(),
  state = { nodes: 0 },
  depth = 0,
): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0))
  ) {
    return;
  }
  if (!value || typeof value !== "object" || nodeTypes.isProxy(value) || seen.has(value)) fail(code);
  state.nodes += 1;
  if (state.nodes > 20_000 || depth > 64) fail(code);
  seen.add(value);
  const prototype = Object.getPrototypeOf(value);
  const isArray = Array.isArray(value);
  if (prototype !== (isArray ? Array.prototype : Object.prototype) && prototype !== null) {
    fail(code);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === "symbol")) fail(code);
  if (isArray) {
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      !lengthDescriptor ||
      typeof lengthDescriptor.value !== "number" ||
      lengthDescriptor.enumerable
    ) {
      fail(code);
    }
    const expected = new Set(["length", ...Array.from({ length: value.length }, (_, index) => String(index))]);
    if (keys.length !== expected.size || keys.some((key) => !expected.has(String(key)))) fail(code);
  }
  for (const key of keys) {
    if (key === "length" && isArray) continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail(code);
    assertDeepDataOnly(descriptor.value, code, seen, state, depth + 1);
  }
  seen.delete(value);
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  code: SteamWindows4090LabReadinessFailureCode,
): DataRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) fail(code);
  const actual = (ownKeys as string[]).sort();
  const expected = [...keys].sort();
  if (canonical(actual) !== canonical(expected)) fail(code);
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail(code);
  }
  return value as DataRecord;
}

function exactArray(
  value: unknown,
  code: SteamWindows4090LabReadinessFailureCode,
): unknown[] {
  if (!Array.isArray(value)) fail(code);
  return value;
}

function expect(value: unknown, expected: unknown, code: SteamWindows4090LabReadinessFailureCode): void {
  if (canonical(value) !== canonical(expected)) fail(code);
}

function expectSha(value: unknown, code: SteamWindows4090LabReadinessFailureCode): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) fail(code);
  return value;
}

function expectEpochMs(
  value: unknown,
  code: SteamWindows4090LabReadinessFailureCode,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(code);
  return value as number;
}

function windowsParameterBindingBody(): DataRecord {
  return {
    schema: "aistory-steam-windows-4090-parameter-binding",
    schemaVersion: 1,
    workflowId: STEAM_WINDOWS_4090_LAB_WORKFLOW_PIN.workflowId,
    workflowSha256: STEAM_WINDOWS_4090_LAB_WORKFLOW_PIN.workflowSha256,
    target: STEAM_WINDOWS_4090_LAB_TARGET,
    policy: STEAM_WINDOWS_4090_LAB_POLICY,
    references: STEAM_WINDOWS_4090_LAB_REFERENCES.map(({ role, assetId, sha256: assetSha256 }) => ({
      role,
      assetId,
      sha256: assetSha256,
    })),
  };
}

function validateWindowsParameterBindingPin(): void {
  if (
    sha256(canonical(windowsParameterBindingBody())) !==
    STEAM_WINDOWS_4090_LAB_WORKFLOW_PIN.parameterBindingSha256
  ) {
    fail("workflow_pin_mismatch");
  }
}

function validateReferencePreparation(
  source: unknown,
  reviewPacket: SteamLaunchReviewPacketResult,
): void {
  const manifest = exactRecord(
    source,
    [
      "schema",
      "schemaVersion",
      "mode",
      "authority",
      "executionAllowed",
      "providerPreparation",
      "providerContacted",
      "providerReferenceHandlesIssued",
      "gpuProbed",
      "networkCalls",
      "writesPerformed",
      "releaseGate",
      "status",
      "manifestFingerprint",
      "sourceManifests",
      "summary",
      "shots",
      "assets",
      "blockerCodes",
    ],
    "reference_integrity_mismatch",
  );
  expect(manifest.schema, "aistory-steam-reference-local-integrity", "reference_integrity_mismatch");
  expect(manifest.schemaVersion, 1, "reference_integrity_mismatch");
  expect(manifest.mode, "local_verify_only", "reference_integrity_mismatch");
  expect(manifest.status, "LOCAL_VERIFIED_ONLY", "reference_integrity_mismatch");
  expect(
    manifest.manifestFingerprint,
    STEAM_WINDOWS_4090_LAB_SOURCE_PINS.referencePreparationFingerprint,
    "reference_integrity_mismatch",
  );
  expect(
    manifest.authority,
    { caseId: STEAM_WINDOWS_4090_LAB_AUTHORITY.caseId, releaseVersion: "v1.1" },
    "reference_integrity_mismatch",
  );
  expect(
    manifest.sourceManifests,
    {
      assetManifest: {
        schemaVersion: 1,
        bytes: 8_256,
        sha256: "b3232a6a9da08bd103c8005aa0569a2412c558d197c6626f762d60d6c23798c0",
      },
      videoPrompts: {
        schemaVersion: 1,
        bytes: 56_726,
        sha256: "94089ac020424b1b9f425777814820d5626e2d3e514105f9350f82b1ca0f77c6",
      },
    },
    "reference_integrity_mismatch",
  );
  expect(manifest.summary, { shots: 3, bindings: 12, uniqueAssets: 6, localVerifiedAssets: 6 }, "reference_integrity_mismatch");
  expect(manifest.blockerCodes, ["source_reference_not_prepared"], "reference_integrity_mismatch");
  expect(manifest.executionAllowed, false, "reference_integrity_mismatch");
  expect(manifest.providerPreparation, "NOT_ATTEMPTED", "reference_integrity_mismatch");
  expect(manifest.providerContacted, false, "reference_integrity_mismatch");
  expect(manifest.providerReferenceHandlesIssued, 0, "reference_integrity_mismatch");
  expect(manifest.gpuProbed, false, "reference_integrity_mismatch");
  expect(manifest.networkCalls, 0, "reference_integrity_mismatch");
  expect(manifest.writesPerformed, 0, "reference_integrity_mismatch");
  expect(manifest.releaseGate, { satisfied: false }, "reference_integrity_mismatch");
  if (reviewPacket.status !== "LOCAL_REVIEW_PACKET_READY") fail("source_contract_mismatch");
  const packet = reviewPacket.packet;
  const packetShots = new Map(packet.shots.map((shot) => [shot.shotId, shot]));
  const shots = exactArray(manifest.shots, "reference_integrity_mismatch");
  if (shots.length !== 3) fail("reference_integrity_mismatch");
  const seenShots = new Set<string>();
  for (const rawShot of shots) {
    const shot = exactRecord(
      rawShot,
      ["nodeId", "shotId", "sceneId", "episodeId", "bindings"],
      "reference_integrity_mismatch",
    );
    if (typeof shot.shotId !== "string" || seenShots.has(shot.shotId)) fail("reference_integrity_mismatch");
    seenShots.add(shot.shotId);
    const packetShot = packetShots.get(shot.shotId);
    if (
      !packetShot ||
      shot.nodeId !== packetShot.nodeId ||
      shot.sceneId !== packetShot.sceneId ||
      shot.episodeId !== packetShot.episodeId
    ) {
      fail("reference_integrity_mismatch");
    }
    const bindings = exactArray(shot.bindings, "reference_integrity_mismatch");
    if (bindings.length !== 4) fail("reference_integrity_mismatch");
    const packetBindings = new Map(packetShot.bindings.map((binding) => [binding.role, binding]));
    const seenRoles = new Set<string>();
    for (const rawBinding of bindings) {
      const binding = exactRecord(
        rawBinding,
        ["role", "referenceId", "assetId", "sha256", "bytes", "mediaType", "localIntegrity"],
        "reference_integrity_mismatch",
      );
      if (typeof binding.role !== "string" || seenRoles.has(binding.role)) fail("reference_integrity_mismatch");
      seenRoles.add(binding.role);
      const packetBinding = packetBindings.get(binding.role);
      if (
        !packetBinding ||
        packetBinding.prepared !== false ||
        canonical(binding) !==
          canonical({
            role: packetBinding.role,
            referenceId: packetBinding.referenceId,
            assetId: packetBinding.assetId,
            sha256: packetBinding.sha256,
            bytes: packetBinding.bytes,
            mediaType: packetBinding.mediaType,
            localIntegrity: packetBinding.localIntegrity,
          })
      ) {
        fail("reference_integrity_mismatch");
      }
    }
  }
  if (seenShots.size !== packetShots.size) fail("reference_integrity_mismatch");
  const assets = exactArray(manifest.assets, "reference_integrity_mismatch");
  if (assets.length !== 6) fail("reference_integrity_mismatch");
  const packetAssets = new Map(packet.assets.map((asset) => [asset.assetId, asset]));
  const seenAssets = new Set<string>();
  for (const rawAsset of assets) {
    const asset = exactRecord(
      rawAsset,
      ["assetId", "kind", "sha256", "bytes", "mediaType", "media", "localIntegrity"],
      "reference_integrity_mismatch",
    );
    if (typeof asset.assetId !== "string" || seenAssets.has(asset.assetId)) fail("reference_integrity_mismatch");
    seenAssets.add(asset.assetId);
    const packetAsset = packetAssets.get(asset.assetId);
    if (
      !packetAsset ||
      asset.kind !== packetAsset.kind ||
      asset.sha256 !== packetAsset.sha256 ||
      asset.bytes !== packetAsset.bytes ||
      asset.mediaType !== packetAsset.mediaType ||
      asset.localIntegrity !== packetAsset.localIntegrity
    ) {
      fail("reference_integrity_mismatch");
    }
    exactRecord(
      asset.media,
      ["width", "height", "bitDepth", "colorType", "compressionMethod", "filterMethod", "interlaceMethod"],
      "reference_integrity_mismatch",
    );
    expect(
      asset.media,
      {
        width: 1672,
        height: 941,
        bitDepth: 8,
        colorType: 2,
        compressionMethod: 0,
        filterMethod: 0,
        interlaceMethod: 0,
      },
      "reference_integrity_mismatch",
    );
  }
  if (seenAssets.size !== packetAssets.size) fail("reference_integrity_mismatch");
}

function validateSources(sourceValue: unknown): SteamWindows4090LabReadinessSources {
  validateWindowsParameterBindingPin();
  assertDeepDataOnly(sourceValue, "source_contract_mismatch");
  const source = exactRecord(
    sourceValue,
    ["referencePreparation", "reviewPacket", "cueReview", "materializationPreflight", "previewBundle"],
    "source_contract_mismatch",
  ) as SteamWindows4090LabReadinessSources;
  const rederivedPreview = deriveSteamLaunchCueReviewPreviewBundle(
    source.reviewPacket,
    source.cueReview,
    source.materializationPreflight,
  );
  if (
    rederivedPreview.status !== "PRIVATE_REVIEW_ONLY" ||
    source.previewBundle.status !== "PRIVATE_REVIEW_ONLY" ||
    canonicalSteamLaunchCueReviewPreview(rederivedPreview) !==
      canonicalSteamLaunchCueReviewPreview(source.previewBundle)
  ) {
    fail("source_contract_mismatch");
  }
  const preview = rederivedPreview.bundle.manifest;
  if (
    preview.bundleFingerprint !== STEAM_WINDOWS_4090_LAB_SOURCE_PINS.privatePreviewBundleFingerprint ||
    preview.summary.shots !== 3 ||
    preview.summary.acceptedSubtitleCues !== 10 ||
    preview.summary.quarantinedRows !== 2 ||
    preview.status !== "PRIVATE_REVIEW_ONLY" ||
    preview.completeness !== "INCOMPLETE" ||
    preview.publishability !== "NON_PUBLISHABLE" ||
    preview.contentReview.satisfied !== false ||
    preview.candidateSetComplete !== false ||
    preview.releaseMaterializedArtifacts !== 0 ||
    preview.playbackReady !== false ||
    preview.executionAllowed !== false ||
    preview.publishAllowed !== false ||
    preview.releaseGate.satisfied !== false
  ) {
    fail("source_contract_mismatch");
  }
  if (source.reviewPacket.status !== "LOCAL_REVIEW_PACKET_READY") fail("source_contract_mismatch");
  const packet = source.reviewPacket.packet;
  if (
    packet.packetFingerprint !== STEAM_WINDOWS_4090_LAB_SOURCE_PINS.reviewPacketFingerprint ||
    packet.authority.caseId !== STEAM_WINDOWS_4090_LAB_AUTHORITY.caseId ||
    packet.authority.storyId !== STEAM_WINDOWS_4090_LAB_AUTHORITY.storyId ||
    packet.authority.storyVersion !== STEAM_WINDOWS_4090_LAB_AUTHORITY.storyVersion ||
    packet.authority.projectRef !== STEAM_WINDOWS_4090_LAB_AUTHORITY.projectRef ||
    packet.authority.authorReleaseVersion !== STEAM_WINDOWS_4090_LAB_AUTHORITY.authorReleaseVersion ||
    packet.releasePolicy.policyHash !== RELEASE_POLICY_HASH
  ) {
    fail("source_contract_mismatch");
  }
  const target = packet.shots.find((shot) => shot.shotId === STEAM_WINDOWS_4090_LAB_TARGET.shotId);
  if (
    !target ||
    packet.shots.filter((shot) => shot.shotId === STEAM_WINDOWS_4090_LAB_TARGET.shotId).length !== 1 ||
    target.nodeId !== STEAM_WINDOWS_4090_LAB_TARGET.nodeId ||
    target.sceneId !== STEAM_WINDOWS_4090_LAB_TARGET.sceneId ||
    target.episodeId !== STEAM_WINDOWS_4090_LAB_TARGET.episodeId ||
    target.landingBeatId !== STEAM_WINDOWS_4090_LAB_TARGET.landingBeatId ||
    target.production.specId !== RELEASE_SPEC_ID ||
    target.production.inputFingerprint !== RELEASE_INPUT_FINGERPRINT ||
    target.production.sourceContentHash !== STEAM_WINDOWS_4090_LAB_TARGET.sourceContentHash ||
    target.production.releaseCompatible !== false ||
    target.production.executionAllowed !== false ||
    target.production.referencesPrepared !== false ||
    target.production.workflowPin !== null
  ) {
    fail("source_contract_mismatch");
  }
  if (target.bindings.length !== 4) fail("reference_integrity_mismatch");
  for (const expected of STEAM_WINDOWS_4090_LAB_REFERENCES) {
    const binding = target.bindings.find((entry) => entry.role === expected.role);
    if (
      !binding ||
      target.bindings.filter((entry) => entry.role === expected.role).length !== 1 ||
      binding.referenceId !== expected.referenceId ||
      binding.assetId !== expected.assetId ||
      binding.bytes !== expected.bytes ||
      binding.sha256 !== expected.sha256 ||
      binding.mediaType !== "image/png" ||
      binding.localIntegrity !== "verified" ||
      binding.prepared !== false
    ) {
      fail("reference_integrity_mismatch");
    }
  }
  if (
    source.cueReview.status !== "LOCAL_CUE_ASSIGNMENTS_VALIDATED" ||
    source.cueReview.review.overlayFingerprint !==
      STEAM_WINDOWS_4090_LAB_SOURCE_PINS.cueReviewOverlayFingerprint ||
    source.cueReview.review.assignmentFingerprint !==
      STEAM_WINDOWS_4090_LAB_SOURCE_PINS.cueAssignmentFingerprint ||
    source.cueReview.review.executionAllowed !== false ||
    source.cueReview.review.audioAssetsMaterialized !== false ||
    source.cueReview.review.webVttMaterialized !== false
  ) {
    fail("source_contract_mismatch");
  }
  if (
    source.materializationPreflight.status !==
      "PASS_LOCAL_MATERIALIZATION_PREFLIGHT_BLOCKED_CONTENT_REVIEW" ||
    source.materializationPreflight.preflight.preflightFingerprint !==
      STEAM_WINDOWS_4090_LAB_SOURCE_PINS.materializationPreflightFingerprint ||
    source.materializationPreflight.preflight.summary.shots !== 3 ||
    source.materializationPreflight.preflight.summary.candidateSubtitleCues !== 10 ||
    source.materializationPreflight.preflight.summary.quarantinedRows !== 2 ||
    source.materializationPreflight.preflight.executionAllowed !== false ||
    source.materializationPreflight.preflight.webVttMaterialized !== false ||
    source.materializationPreflight.preflight.audioAssetsMaterialized !== false
  ) {
    fail("source_contract_mismatch");
  }
  validateReferencePreparation(source.referencePreparation, source.reviewPacket);
  return source;
}

const EVIDENCE_ROOT_KEYS = [
  "schema",
  "schemaVersion",
  "evaluationContext",
  "windowsHostProfile",
  "connectorQualification",
  "protectedRuntimeBinding",
  "freshNoWorkReceipt",
  "exactWorkflowBinding",
  "controlledReferenceHandles",
  "windowsModelProvenanceLicense",
  "currentHostHealth",
] as const;

function validateEvidence(
  value: unknown | null,
): {
  evidence: SteamWindows4090LabControlledEvidence;
  present: Record<EvidenceKey, boolean>;
  fingerprint: string | null;
} {
  const empty: SteamWindows4090LabControlledEvidence = {
    schema: "aistory-steam-windows-4090-controlled-evidence",
    schemaVersion: 1,
    evaluationContext: null,
    windowsHostProfile: null,
    connectorQualification: null,
    protectedRuntimeBinding: null,
    freshNoWorkReceipt: null,
    exactWorkflowBinding: null,
    controlledReferenceHandles: null,
    windowsModelProvenanceLicense: null,
    currentHostHealth: null,
  };
  const evidence = value === null ? empty : (value as SteamWindows4090LabControlledEvidence);
  assertDeepDataOnly(evidence, "evidence_invalid");
  const root = exactRecord(evidence, EVIDENCE_ROOT_KEYS, "evidence_invalid");
  expect(root.schema, empty.schema, "evidence_invalid");
  expect(root.schemaVersion, 1, "evidence_invalid");
  if (value !== null) {
    if (!evidence.evaluationContext) fail("freshness_invalid");
    const evaluation = exactRecord(
      evidence.evaluationContext,
      ["evaluatedAtEpochMs", "maxNoWorkAgeMs", "maxHostHealthAgeMs"],
      "evidence_invalid",
    );
    expectEpochMs(evaluation.evaluatedAtEpochMs, "freshness_invalid");
    expect(evaluation.maxNoWorkAgeMs, 300_000, "freshness_invalid");
    expect(evaluation.maxHostHealthAgeMs, 60_000, "freshness_invalid");
  } else if (evidence.evaluationContext !== null) {
    fail("evidence_invalid");
  }
  const present = {
    windowsHostProfile: evidence.windowsHostProfile !== null,
    connectorQualification: evidence.connectorQualification !== null,
    protectedRuntimeBinding: evidence.protectedRuntimeBinding !== null,
    freshNoWorkReceipt: evidence.freshNoWorkReceipt !== null,
    exactWorkflowBinding: evidence.exactWorkflowBinding !== null,
    controlledReferenceHandles: evidence.controlledReferenceHandles !== null,
    windowsModelProvenanceLicense: evidence.windowsModelProvenanceLicense !== null,
    currentHostHealth: evidence.currentHostHealth !== null,
  } satisfies Record<EvidenceKey, boolean>;
  if (evidence.windowsHostProfile) {
    const profile = exactRecord(
      evidence.windowsHostProfile,
      ["status", "profileId", "os", "architecture", "gpuClass", "profileFingerprint"],
      "evidence_invalid",
    );
    if (
      String(profile.profileId).toLowerCase().includes("ubuntu") ||
      String(profile.profileId).includes("3090") ||
      String(profile.os).toLowerCase() === "linux"
    ) {
      fail("ubuntu_profile_forbidden");
    }
    expect(profile.status, "INDEPENDENT_WINDOWS_HOST_PROFILE_VERIFIED", "windows_profile_mismatch");
    expect(profile.profileId, "windows-rtx4090-lab-v1", "windows_profile_mismatch");
    expect(profile.os, "windows", "windows_profile_mismatch");
    expect(profile.architecture, "x64", "windows_profile_mismatch");
    expect(profile.gpuClass, "NVIDIA_RTX_4090", "windows_profile_mismatch");
    expectSha(profile.profileFingerprint, "windows_profile_mismatch");
  }
  if (evidence.connectorQualification) {
    const connector = exactRecord(
      evidence.connectorQualification,
      [
        "schemaVersion",
        "status",
        "packageDisposition",
        "realPackage",
        "inputCount",
        "centralGoldenBytes",
        "centralGoldenSha256",
        "packageSha256",
        "externalManifestSha256",
        "goldenSidecarSha256",
        "identity",
        "staticSafety",
        "compatibility",
        "qualificationReceiptSha256",
      ],
      "evidence_invalid",
    );
    expect(
      connector.schemaVersion,
      "aistory-gpu-connector-package-qualification-v1",
      "evidence_join_mismatch",
    );
    expect(connector.status, "OFFLINE_PACKAGE_STATIC_QUALIFIED", "evidence_join_mismatch");
    expect(
      connector.packageDisposition,
      "REAL_REPAIRED_CONNECTOR_PACKAGE",
      "evidence_join_mismatch",
    );
    expect(connector.realPackage, true, "evidence_join_mismatch");
    expect(connector.inputCount, 4, "evidence_join_mismatch");
    expect(connector.centralGoldenBytes, STEAM_WINDOWS_4090_P1_8_CENTRAL_PIN.centralGoldenBytes, "evidence_join_mismatch");
    expect(connector.centralGoldenSha256, STEAM_WINDOWS_4090_P1_8_CENTRAL_PIN.centralGoldenSha256, "evidence_join_mismatch");
    for (const key of [
      "packageSha256",
      "externalManifestSha256",
      "goldenSidecarSha256",
    ]) {
      expectSha(connector[key], "evidence_join_mismatch");
    }
    if (connector.packageSha256 === STEAM_WINDOWS_4090_FORBIDDEN_CONNECTOR_PACKAGE_SHA256) {
      fail("evidence_join_mismatch");
    }
    const identity = exactRecord(
      connector.identity,
      [
        "connectorVersion",
        "buildSha256",
        "releaseSha256",
        "capabilityDigestSha256",
        "centralContractSha256",
      ],
      "evidence_invalid",
    );
    if (
      typeof identity.connectorVersion !== "string" ||
      identity.connectorVersion.length > 32 ||
      !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u.test(
        identity.connectorVersion,
      )
    ) {
      fail("evidence_join_mismatch");
    }
    for (const key of [
      "buildSha256",
      "releaseSha256",
      "capabilityDigestSha256",
      "centralContractSha256",
    ]) {
      expectSha(identity[key], "evidence_join_mismatch");
    }
    expect(
      identity.centralContractSha256,
      STEAM_WINDOWS_4090_P1_8_CENTRAL_PIN.centralGoldenSha256,
      "evidence_join_mismatch",
    );
    expect(identity.releaseSha256, connector.packageSha256, "evidence_join_mismatch");
    const staticSafety = exactRecord(
      connector.staticSafety,
      [
        "provenanceVerified",
        "signatureVerified",
        "runtimeBindingVerified",
        "noWorkExecuted",
        "gpuExecuted",
        "deployable",
        "networkCalls",
        "archiveCodeExecuted",
      ],
      "evidence_invalid",
    );
    expect(
      staticSafety,
      {
        provenanceVerified: false,
        signatureVerified: false,
        runtimeBindingVerified: false,
        noWorkExecuted: false,
        gpuExecuted: false,
        deployable: false,
        networkCalls: 0,
        archiveCodeExecuted: false,
      },
      "evidence_join_mismatch",
    );
    const compatibility = exactRecord(
      connector.compatibility,
      ["firstHeartbeat", "runnerMode", "noWorkOnlyFirstGate", "connectorFakeTestsExecuted"],
      "evidence_invalid",
    );
    expect(
      compatibility,
      {
        firstHeartbeat: "idle",
        runnerMode: "no_work_only",
        noWorkOnlyFirstGate: true,
        connectorFakeTestsExecuted: false,
      },
      "evidence_join_mismatch",
    );
    const qualificationBody = {
      schemaVersion: connector.schemaVersion,
      status: connector.status,
      packageDisposition: connector.packageDisposition,
      realPackage: connector.realPackage,
      inputCount: connector.inputCount,
      centralGoldenBytes: connector.centralGoldenBytes,
      centralGoldenSha256: connector.centralGoldenSha256,
      packageSha256: connector.packageSha256,
      externalManifestSha256: connector.externalManifestSha256,
      goldenSidecarSha256: connector.goldenSidecarSha256,
      identity,
      staticSafety,
      compatibility,
    };
    expect(
      connector.qualificationReceiptSha256,
      sha256(canonical(qualificationBody)),
      "evidence_join_mismatch",
    );
  }
  if (evidence.protectedRuntimeBinding) {
    const runtime = exactRecord(
      evidence.protectedRuntimeBinding,
      [
        "schema",
        "schemaVersion",
        "status",
        "profileFingerprint",
        "qualificationReceiptSha256",
        "connectorIdentitySha256",
        "centralContractSha256",
        "productionNetworkEnabled",
        "lanLabNetworkEnabled",
        "runnerMode",
        "runtimeBindingSha256",
      ],
      "evidence_invalid",
    );
    expect(
      runtime.schema,
      "aistory-steam-windows-4090-protected-runtime-binding-receipt",
      "evidence_join_mismatch",
    );
    expect(runtime.schemaVersion, 1, "evidence_join_mismatch");
    expect(runtime.status, "PROTECTED_RUNTIME_BOUND", "evidence_join_mismatch");
    for (const key of [
      "profileFingerprint",
      "qualificationReceiptSha256",
      "connectorIdentitySha256",
      "centralContractSha256",
    ]) {
      expectSha(runtime[key], "evidence_join_mismatch");
    }
    expect(runtime.productionNetworkEnabled, false, "evidence_join_mismatch");
    expect(runtime.lanLabNetworkEnabled, true, "evidence_join_mismatch");
    expect(runtime.runnerMode, "no_work_only", "evidence_join_mismatch");
    if (
      !evidence.windowsHostProfile ||
      !evidence.connectorQualification ||
      runtime.profileFingerprint !== evidence.windowsHostProfile.profileFingerprint ||
      runtime.qualificationReceiptSha256 !== evidence.connectorQualification.qualificationReceiptSha256 ||
      runtime.connectorIdentitySha256 !== sha256(canonical(evidence.connectorQualification.identity)) ||
      runtime.centralContractSha256 !==
        evidence.connectorQualification.identity.centralContractSha256
    ) {
      fail("evidence_join_mismatch");
    }
    const runtimeBody = {
      schema: runtime.schema,
      schemaVersion: runtime.schemaVersion,
      status: runtime.status,
      profileFingerprint: runtime.profileFingerprint,
      qualificationReceiptSha256: runtime.qualificationReceiptSha256,
      connectorIdentitySha256: runtime.connectorIdentitySha256,
      centralContractSha256: runtime.centralContractSha256,
      productionNetworkEnabled: runtime.productionNetworkEnabled,
      lanLabNetworkEnabled: runtime.lanLabNetworkEnabled,
      runnerMode: runtime.runnerMode,
    };
    expect(
      runtime.runtimeBindingSha256,
      sha256(canonical(runtimeBody)),
      "evidence_join_mismatch",
    );
  }
  if (evidence.freshNoWorkReceipt) {
    const receipt = exactRecord(
      evidence.freshNoWorkReceipt,
      [
        "status",
        "runnerMode",
        "firstHeartbeatState",
        "profileFingerprint",
        "runtimeBindingSha256",
        "qualificationReceiptSha256",
        "registrationReceiptSha256",
        "sessionBindingSha256",
        "sequence",
        "observedAtEpochMs",
        "expiresAtEpochMs",
        "businessTasksClaimed",
        "providerCalls",
        "gpuAcquisitions",
        "controlledConnectorRequests",
        "externalProviderNetworkCalls",
        "receiptSha256",
      ],
      "evidence_invalid",
    );
    expect(receipt.status, "PASS_FRESH_NO_WORK_ONLY", "evidence_join_mismatch");
    expect(receipt.runnerMode, "no_work_only", "evidence_join_mismatch");
    expect(receipt.firstHeartbeatState, "idle", "evidence_join_mismatch");
    expect(
      receipt.sequence,
      ["fresh_registration", "first_heartbeat_idle", "no_work_only"],
      "evidence_join_mismatch",
    );
    expect(receipt.businessTasksClaimed, 0, "evidence_join_mismatch");
    expect(receipt.providerCalls, 0, "evidence_join_mismatch");
    expect(receipt.gpuAcquisitions, 0, "evidence_join_mismatch");
    expect(receipt.controlledConnectorRequests, 3, "evidence_join_mismatch");
    expect(receipt.externalProviderNetworkCalls, 0, "evidence_join_mismatch");
    expectSha(receipt.registrationReceiptSha256, "evidence_join_mismatch");
    expectSha(receipt.sessionBindingSha256, "evidence_join_mismatch");
    const observedAtEpochMs = expectEpochMs(receipt.observedAtEpochMs, "freshness_invalid");
    const expiresAtEpochMs = expectEpochMs(receipt.expiresAtEpochMs, "freshness_invalid");
    const evaluatedAtEpochMs = evidence.evaluationContext
      ? evidence.evaluationContext.evaluatedAtEpochMs
      : fail("freshness_invalid");
    if (
      observedAtEpochMs > evaluatedAtEpochMs ||
      expiresAtEpochMs <= evaluatedAtEpochMs ||
      evaluatedAtEpochMs - observedAtEpochMs > 300_000
    ) {
      fail("freshness_invalid");
    }
    if (
      !evidence.windowsHostProfile ||
      !evidence.connectorQualification ||
      !evidence.protectedRuntimeBinding ||
      receipt.profileFingerprint !== evidence.windowsHostProfile.profileFingerprint ||
      receipt.runtimeBindingSha256 !== evidence.protectedRuntimeBinding.runtimeBindingSha256 ||
      receipt.qualificationReceiptSha256 !== evidence.connectorQualification.qualificationReceiptSha256
    ) {
      fail("evidence_join_mismatch");
    }
    const noWorkBody = {
      status: receipt.status,
      runnerMode: receipt.runnerMode,
      firstHeartbeatState: receipt.firstHeartbeatState,
      profileFingerprint: receipt.profileFingerprint,
      runtimeBindingSha256: receipt.runtimeBindingSha256,
      qualificationReceiptSha256: receipt.qualificationReceiptSha256,
      registrationReceiptSha256: receipt.registrationReceiptSha256,
      sessionBindingSha256: receipt.sessionBindingSha256,
      sequence: receipt.sequence,
      observedAtEpochMs,
      expiresAtEpochMs,
      businessTasksClaimed: receipt.businessTasksClaimed,
      providerCalls: receipt.providerCalls,
      gpuAcquisitions: receipt.gpuAcquisitions,
      controlledConnectorRequests: receipt.controlledConnectorRequests,
      externalProviderNetworkCalls: receipt.externalProviderNetworkCalls,
    };
    expect(receipt.receiptSha256, sha256(canonical(noWorkBody)), "evidence_join_mismatch");
  }
  if (evidence.exactWorkflowBinding) {
    const workflow = exactRecord(
      evidence.exactWorkflowBinding,
      [
        "status",
        "profileFingerprint",
        "runtimeBindingSha256",
        "workflowId",
        "workflowSha256",
        "parameterBindingSha256",
        "policyVersion",
        "shotId",
        "stage",
        "noWorkReceiptSha256",
        "bindingReceiptSha256",
      ],
      "evidence_invalid",
    );
    expect(workflow.status, "EXACT_WINDOWS_WORKFLOW_BOUND", "workflow_pin_mismatch");
    expect(workflow.workflowId, STEAM_WINDOWS_4090_LAB_WORKFLOW_PIN.workflowId, "workflow_pin_mismatch");
    expect(workflow.workflowSha256, STEAM_WINDOWS_4090_LAB_WORKFLOW_PIN.workflowSha256, "workflow_pin_mismatch");
    expect(
      workflow.parameterBindingSha256,
      STEAM_WINDOWS_4090_LAB_WORKFLOW_PIN.parameterBindingSha256,
      "workflow_pin_mismatch",
    );
    expect(workflow.policyVersion, STEAM_WINDOWS_4090_LAB_POLICY.policyVersion, "workflow_pin_mismatch");
    expect(workflow.shotId, STEAM_WINDOWS_4090_LAB_TARGET.shotId, "workflow_pin_mismatch");
    expect(workflow.stage, "original", "workflow_pin_mismatch");
    if (
      !evidence.windowsHostProfile ||
      !evidence.protectedRuntimeBinding ||
      !evidence.freshNoWorkReceipt ||
      workflow.profileFingerprint !== evidence.windowsHostProfile.profileFingerprint ||
      workflow.runtimeBindingSha256 !== evidence.protectedRuntimeBinding.runtimeBindingSha256 ||
      workflow.noWorkReceiptSha256 !== evidence.freshNoWorkReceipt.receiptSha256
    ) {
      fail("evidence_join_mismatch");
    }
    const workflowBindingBody = {
      status: workflow.status,
      profileFingerprint: workflow.profileFingerprint,
      runtimeBindingSha256: workflow.runtimeBindingSha256,
      workflowId: workflow.workflowId,
      workflowSha256: workflow.workflowSha256,
      parameterBindingSha256: workflow.parameterBindingSha256,
      policyVersion: workflow.policyVersion,
      shotId: workflow.shotId,
      stage: workflow.stage,
      noWorkReceiptSha256: workflow.noWorkReceiptSha256,
    };
    expect(
      workflow.bindingReceiptSha256,
      sha256(canonical(workflowBindingBody)),
      "workflow_pin_mismatch",
    );
  }
  if (evidence.controlledReferenceHandles) {
    const handles = exactRecord(
      evidence.controlledReferenceHandles,
      ["status", "shotId", "count", "workflowBindingReceiptSha256", "handleSetReceiptSha256", "references"],
      "evidence_invalid",
    );
    expect(handles.status, "CONTROLLED_REFERENCE_HANDLES_BOUND", "reference_handle_binding_mismatch");
    expect(handles.shotId, STEAM_WINDOWS_4090_LAB_TARGET.shotId, "reference_handle_binding_mismatch");
    expect(handles.count, 4, "reference_handle_binding_mismatch");
    if (
      !evidence.exactWorkflowBinding ||
      handles.workflowBindingReceiptSha256 !== evidence.exactWorkflowBinding.bindingReceiptSha256
    ) {
      fail("evidence_join_mismatch");
    }
    const references = exactArray(handles.references, "reference_handle_binding_mismatch");
    if (references.length !== 4) fail("reference_handle_binding_mismatch");
    const byRole = new Map<string, DataRecord>();
    for (const rawReference of references) {
      const reference = exactRecord(
        rawReference,
        ["role", "assetId", "assetSha256", "handleBindingSha256"],
        "reference_handle_binding_mismatch",
      );
      if (typeof reference.role !== "string" || byRole.has(reference.role)) {
        fail("reference_handle_binding_mismatch");
      }
      expectSha(reference.handleBindingSha256, "reference_handle_binding_mismatch");
      byRole.set(reference.role, reference);
    }
    for (const expected of STEAM_WINDOWS_4090_LAB_REFERENCES) {
      const reference = byRole.get(expected.role);
      if (
        !reference ||
        reference.assetId !== expected.assetId ||
        reference.assetSha256 !== expected.sha256
      ) {
        fail("reference_handle_binding_mismatch");
      }
    }
    const normalizedReferences = STEAM_WINDOWS_4090_LAB_REFERENCES.map((expected) => {
      const reference = byRole.get(expected.role)!;
      return {
        role: reference.role,
        assetId: reference.assetId,
        assetSha256: reference.assetSha256,
        handleBindingSha256: reference.handleBindingSha256,
      };
    });
    const handleSetBody = {
      schema: "aistory-steam-windows-4090-reference-handle-set-receipt",
      schemaVersion: 1,
      status: handles.status,
      shotId: handles.shotId,
      count: handles.count,
      workflowBindingReceiptSha256: handles.workflowBindingReceiptSha256,
      references: normalizedReferences,
    };
    expect(
      handles.handleSetReceiptSha256,
      sha256(canonical(handleSetBody)),
      "reference_handle_binding_mismatch",
    );
  }
  if (evidence.windowsModelProvenanceLicense) {
    const provenance = exactRecord(
      evidence.windowsModelProvenanceLicense,
      [
        "status",
        "workflowSha256",
        "generationUse",
        "weightsDistributionAllowed",
        "provenanceReceiptSha256",
        "licenseReceiptSha256",
      ],
      "evidence_invalid",
    );
    expect(provenance.status, "WINDOWS_PROVENANCE_LICENSE_VERIFIED", "evidence_join_mismatch");
    expect(provenance.workflowSha256, STEAM_WINDOWS_4090_LAB_WORKFLOW_PIN.workflowSha256, "evidence_join_mismatch");
    expect(provenance.generationUse, "INTERNAL_GENERATION_CONDITIONAL_PASS", "evidence_join_mismatch");
    expect(provenance.weightsDistributionAllowed, false, "evidence_join_mismatch");
    expectSha(provenance.provenanceReceiptSha256, "evidence_join_mismatch");
    expectSha(provenance.licenseReceiptSha256, "evidence_join_mismatch");
  }
  if (evidence.currentHostHealth) {
    const health = exactRecord(
      evidence.currentHostHealth,
      [
        "status",
        "profileFingerprint",
        "runtimeBindingSha256",
        "sessionBindingSha256",
        "noWorkReceiptSha256",
        "queueState",
        "observedAtEpochMs",
        "expiresAtEpochMs",
        "healthReceiptSha256",
      ],
      "evidence_invalid",
    );
    expect(health.status, "CURRENT_WINDOWS_HOST_HEALTHY", "evidence_join_mismatch");
    expect(health.queueState, "empty", "evidence_join_mismatch");
    const observedAtEpochMs = expectEpochMs(health.observedAtEpochMs, "freshness_invalid");
    const expiresAtEpochMs = expectEpochMs(health.expiresAtEpochMs, "freshness_invalid");
    const evaluatedAtEpochMs = evidence.evaluationContext
      ? evidence.evaluationContext.evaluatedAtEpochMs
      : fail("freshness_invalid");
    if (
      observedAtEpochMs > evaluatedAtEpochMs ||
      expiresAtEpochMs <= evaluatedAtEpochMs ||
      evaluatedAtEpochMs - observedAtEpochMs > 60_000
    ) {
      fail("freshness_invalid");
    }
    if (
      !evidence.windowsHostProfile ||
      !evidence.protectedRuntimeBinding ||
      !evidence.freshNoWorkReceipt ||
      health.profileFingerprint !== evidence.windowsHostProfile.profileFingerprint ||
      health.runtimeBindingSha256 !== evidence.protectedRuntimeBinding.runtimeBindingSha256 ||
      health.sessionBindingSha256 !== evidence.freshNoWorkReceipt.sessionBindingSha256 ||
      health.noWorkReceiptSha256 !== evidence.freshNoWorkReceipt.receiptSha256
    ) {
      fail("evidence_join_mismatch");
    }
    const healthBody = {
      status: health.status,
      profileFingerprint: health.profileFingerprint,
      runtimeBindingSha256: health.runtimeBindingSha256,
      sessionBindingSha256: health.sessionBindingSha256,
      noWorkReceiptSha256: health.noWorkReceiptSha256,
      queueState: health.queueState,
      observedAtEpochMs,
      expiresAtEpochMs,
    };
    expect(health.healthReceiptSha256, sha256(canonical(healthBody)), "evidence_join_mismatch");
  }
  const normalizedEvidence = evidence.controlledReferenceHandles
    ? {
        ...evidence,
        controlledReferenceHandles: {
          ...evidence.controlledReferenceHandles,
          references: STEAM_WINDOWS_4090_LAB_REFERENCES.map((expected) =>
            evidence.controlledReferenceHandles!.references.find(
              (reference) => reference.role === expected.role,
            )!,
          ),
        },
      }
    : evidence;
  return {
    evidence,
    present,
    fingerprint: value === null ? null : sha256(canonical(normalizedEvidence)),
  };
}

function invalidResult(
  failureCode: SteamWindows4090LabReadinessFailureCode,
): SteamWindows4090LabReadinessResult {
  return {
    status: "BLOCKED",
    packet: null,
    failureCode,
    executionAllowed: false,
    jobWriteAllowed: false,
    providerContacted: false,
    gpuProbed: false,
    networkCalls: 0,
    writesPerformed: 0,
  };
}

export function blockedSteamWindows4090LabReadiness(
  failureCode: SteamWindows4090LabReadinessFailureCode,
): SteamWindows4090LabReadinessResult {
  return invalidResult(failureCode);
}

export function deriveSteamWindows4090LabReadiness(
  sourceValue: unknown,
  evidenceValue: unknown | null,
): SteamWindows4090LabReadinessResult {
  try {
    validateSources(sourceValue);
    const { present, fingerprint: evidenceSetFingerprint } = validateEvidence(evidenceValue);
    const allSatisfied =
      present.windowsHostProfile &&
      present.connectorQualification &&
      present.protectedRuntimeBinding &&
      present.freshNoWorkReceipt &&
      present.exactWorkflowBinding &&
      present.controlledReferenceHandles &&
      present.windowsModelProvenanceLicense &&
      present.currentHostHealth;
    const status: SteamWindows4090LabPacket["status"] = allSatisfied
      ? "FOUNDER_AUTHORIZATION_REQUIRED"
      : "BLOCKED";
    const missing = [
      [present.windowsHostProfile, "windows_host_profile_missing"],
      [present.connectorQualification, "repaired_connector_qualification_missing"],
      [present.protectedRuntimeBinding, "protected_runtime_binding_missing"],
      [present.freshNoWorkReceipt, "fresh_no_work_receipt_missing"],
      [present.exactWorkflowBinding, "exact_workflow_binding_missing"],
      [present.controlledReferenceHandles, "controlled_reference_handles_missing"],
      [present.windowsModelProvenanceLicense, "windows_model_provenance_license_missing"],
      [present.currentHostHealth, "current_host_health_missing"],
    ]
      .filter(([satisfied]) => !satisfied)
      .map(([, blocker]) => blocker as string);
    const body = {
      schema: STEAM_WINDOWS_4090_LAB_READINESS_SCHEMA,
      schemaVersion: STEAM_WINDOWS_4090_LAB_READINESS_SCHEMA_VERSION,
      mode: STEAM_WINDOWS_4090_LAB_READINESS_MODE,
      status,
      authority: STEAM_WINDOWS_4090_LAB_AUTHORITY,
      sourcePins: STEAM_WINDOWS_4090_LAB_SOURCE_PINS,
      target: STEAM_WINDOWS_4090_LAB_TARGET,
      references: STEAM_WINDOWS_4090_LAB_REFERENCES.map((reference) => ({
        ...reference,
        mediaType: "image/png" as const,
        localIntegrity: "verified" as const,
        providerPrepared: false as const,
      })),
      policy: {
        ...STEAM_WINDOWS_4090_LAB_POLICY,
        audioMaterialized: false as const,
        audioSyncVerified: false as const,
      },
      inheritedBlockerCodes: {
        release: [...STEAM_WINDOWS_4090_INHERITED_BLOCKERS.release],
        targetContent: [...STEAM_WINDOWS_4090_INHERITED_BLOCKERS.targetContent],
        upstreamPrivatePreviewContent: [
          ...STEAM_WINDOWS_4090_INHERITED_BLOCKERS.upstreamPrivatePreviewContent,
        ],
      },
      upstreamPrivatePreview: {
        status: "INCOMPLETE" as const,
        contentReviewSatisfied: false as const,
        candidateSetComplete: false as const,
        attachedToLabTask: false as const,
      },
      controlledEvidence: {
        evidenceSetFingerprint,
        independentWindowsHostProfile: present.windowsHostProfile,
        repairedConnectorQualification: present.connectorQualification,
        protectedRuntimeBinding: present.protectedRuntimeBinding,
        freshNoWorkReceipt: present.freshNoWorkReceipt,
        exactWorkflowBinding: present.exactWorkflowBinding,
        controlledReferenceHandles: present.controlledReferenceHandles,
        windowsModelProvenanceLicense: present.windowsModelProvenanceLicense,
        currentHostHealth: present.currentHostHealth,
        allSatisfied,
      },
      blockerCodes: [
        ...STEAM_WINDOWS_4090_INHERITED_BLOCKERS.release,
        ...STEAM_WINDOWS_4090_INHERITED_BLOCKERS.targetContent,
        "upstream_private_preview_incomplete",
        "lab_non_publishable",
        ...missing,
        "founder_authorization_required",
      ],
      authorization: {
        registrationAndNoWorkOnlyRequiredFirst: true as const,
        registrationAndNoWorkOnlyPassed: present.freshNoWorkReceipt,
        proposedAction: allSatisfied ? ("foreground_once" as const) : null,
        taskCount: 1 as const,
        retry: 0 as const,
        foregroundOnceProposalAllowed: allSatisfied,
        secondExactFounderAuthorizationRequired: true as const,
        authorizationGranted: false as const,
        foregroundRunsAuthorized: 0 as const,
      },
      playbackReady: false as const,
      playbackSyncVerified: false as const,
      reviewSatisfied: false as const,
      adopted: false as const,
      executionAllowed: false as const,
      jobWriteAllowed: false as const,
      publishAllowed: false as const,
      providerPreparation: "NOT_ATTEMPTED" as const,
      providerContacted: false as const,
      providerReferenceHandlesIssuedByPacket: 0 as const,
      gpuProbed: false as const,
      networkCalls: 0 as const,
      writesPerformed: 0 as const,
      releaseGate: { satisfied: false as const },
    };
    const packetFingerprint = sha256(canonical(body));
    const packet: SteamWindows4090LabPacket = {
      ...body,
      packetId: `sw4090lr1-${packetFingerprint}`,
      packetFingerprint,
    };
    return { status, packet, failureCode: null };
  } catch (error) {
    return invalidResult(
      error instanceof LabReadinessFailure ? error.code : "source_contract_mismatch",
    );
  }
}

export function serializeSteamWindows4090LabReadiness(
  result: SteamWindows4090LabReadinessResult,
): string {
  try {
    assertDeepDataOnly(result, "source_contract_mismatch");
    return `${canonical(result)}\n`;
  } catch {
    return `${canonical(invalidResult("source_contract_mismatch"))}\n`;
  }
}
