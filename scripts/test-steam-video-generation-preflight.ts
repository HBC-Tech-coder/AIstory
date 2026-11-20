import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { handleSteamVideoGenerationPreflightGet } from "../lib/steam/videoGenerationPreflightHandler";
import { readSteamVideoProductionPlan } from "../lib/steam/productionPlanServer";
import {
  deriveSteamVideoGenerationPreflight,
  mapSteamVideoGenerationSpecToCreateRequest,
  serializeSteamVideoGenerationPreflightCsv,
  serializeSteamVideoGenerationPreflightJson,
  STEAM_LAB_PREVIEW_POLICY,
  STEAM_RELEASE_TARGET_POLICY,
  STEAM_VIDEO_GENERATION_PREFLIGHT_NODE_IDS,
  STEAM_VIDEO_GENERATION_REQUIRED_CAPABILITIES,
  type SteamVideoGenerationAuthoritativeInput,
  type SteamVideoGenerationPrivateSpec,
  type SteamVideoGenerationWorkflowCandidate,
} from "../lib/steam/productionSpec";
import { readSteamVideoGenerationPreflight } from "../lib/steam/productionSpecServer";

const ORIGINAL_FETCH = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = (async () => {
  networkCalls += 1;
  throw new Error("network_forbidden_in_steam_preflight_test");
}) as typeof fetch;

const FIXED_NOW = "2026-08-15T00:00:00.000Z";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalForTest(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalForTest).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalForTest(record[key])}`)
    .join(",")}}`;
}

function releaseCompatibility(
  overrides: Partial<
    Extract<
      SteamVideoGenerationWorkflowCandidate["compatibility"],
      { discriminator: "STEAM_RELEASE_TARGET" }
    >
  > = {},
): Extract<
  SteamVideoGenerationWorkflowCandidate["compatibility"],
  { discriminator: "STEAM_RELEASE_TARGET" }
> {
  return {
    discriminator: "STEAM_RELEASE_TARGET",
    orientation: "landscape",
    aspectRatio: "16:9",
    width: 1280,
    height: 720,
    fps: 24,
    durationSeconds: 30,
    audioIntent: "attach",
    subtitleIntent: "attach_webvtt",
    ...overrides,
  };
}

function publishableWorkflow(
  overrides: Partial<SteamVideoGenerationWorkflowCandidate> = {},
): SteamVideoGenerationWorkflowCandidate {
  return {
    source: "comfyui_registry",
    templateId: "reviewed-video-v1",
    modality: "video",
    enabled: true,
    activeVersion: 3,
    activeFingerprint: HASH_B,
    selectedVersion: 3,
    selectedFingerprint: HASH_B,
    exactVersionResolved: true,
    releaseClassification: "publishable",
    capabilities: [...STEAM_VIDEO_GENERATION_REQUIRED_CAPABILITIES],
    compatibility: releaseCompatibility(),
    referenceRoleSlots: {
      source_frame: "sourceFrame",
      identity_face: "identityFace",
      home_outfit: "homeOutfit",
      expressions: "expressions",
    },
    ...overrides,
  };
}

function labWorkflow(
  stage: "original" | "upscale",
  overrides: Partial<SteamVideoGenerationWorkflowCandidate> = {},
): SteamVideoGenerationWorkflowCandidate {
  const profile = STEAM_LAB_PREVIEW_POLICY[stage];
  return {
    source: "gpu_connector_lab",
    templateId: `ubuntu-3090-${stage}-v1`,
    modality: "video",
    enabled: true,
    activeVersion: 1,
    activeFingerprint: stage === "original" ? HASH_C : HASH_D,
    selectedVersion: 1,
    selectedFingerprint: stage === "original" ? HASH_C : HASH_D,
    exactVersionResolved: true,
    releaseClassification: "non_publishable",
    capabilities: ["video_generation", "reference_image_conditioning"],
    compatibility: {
      discriminator: "LAB_NON_PUBLISHABLE",
      stage,
      aspectRatio: profile.aspectRatio,
      width: profile.width,
      height: profile.height,
      frameCount: profile.frameCount,
      fps: profile.fps,
      durationMs: profile.durationMs,
      hasAudio: profile.hasAudio,
    },
    ...overrides,
  };
}

function labCompatibility(
  stage: "original" | "upscale",
  overrides: Partial<
    Extract<
      SteamVideoGenerationWorkflowCandidate["compatibility"],
      { discriminator: "LAB_NON_PUBLISHABLE" }
    >
  > = {},
): Extract<
  SteamVideoGenerationWorkflowCandidate["compatibility"],
  { discriminator: "LAB_NON_PUBLISHABLE" }
> {
  const profile = STEAM_LAB_PREVIEW_POLICY[stage];
  return {
    discriminator: "LAB_NON_PUBLISHABLE",
    stage,
    aspectRatio: profile.aspectRatio,
    width: profile.width,
    height: profile.height,
    frameCount: profile.frameCount,
    fps: profile.fps,
    durationMs: profile.durationMs,
    hasAudio: profile.hasAudio,
    ...overrides,
  };
}

const NODE_META = {
  vg11_wake_choice: { sceneId: "VG11-S01", shotId: "VG11-SHOT-02" },
  vg11_breakfast_choice: {
    sceneId: "VG11-S03",
    shotId: "VG11-SHOT-04",
  },
  vg11_wake_pull: { sceneId: "VG11-S02B", shotId: "VG11-SHOT-05" },
} as const;

function shot(
  nodeId: (typeof STEAM_VIDEO_GENERATION_PREFLIGHT_NODE_IDS)[number],
  overrides: Partial<SteamVideoGenerationAuthoritativeInput> = {},
): SteamVideoGenerationAuthoritativeInput {
  const ordinal = STEAM_VIDEO_GENERATION_PREFLIGHT_NODE_IDS.indexOf(nodeId) + 1;
  const meta = NODE_META[nodeId];
  return {
    projectRef: "case-study:virtual-girlfriend-20260727",
    caseId: "virtual-girlfriend-20260727",
    storyId: "case:virtual-girlfriend-20260727",
    storyVersion: "author-locked-v1.1",
    nodeId,
    sceneId: meta.sceneId,
    episodeId: "VG11-EP01",
    shotId: meta.shotId,
    sourceContentHash: sha256(`source:${nodeId}`),
    privatePrompt: `PRIVATE_PROMPT_MARKER_${nodeId}`,
    privateNegativePrompt: `PRIVATE_NEGATIVE_MARKER_${nodeId}`,
    videoPolicy: {
      orientation: "landscape",
      durationSeconds: 30,
      aspectRatio: "16:9",
      width: 1280,
      height: 720,
      fps: 24,
    },
    audioIntent: "attach",
    subtitleIntent: "attach_webvtt",
    references: [
      {
        role: "source_frame",
        assetId: `vg11-kf-${ordinal}`,
        sha256: HASH_A,
        preparedReference: "aistory/00000000-0000-4000-8000-000000000001.png",
      },
      {
        role: "identity_face",
        assetId: "vg11-char-face-reference",
        sha256: HASH_B,
        preparedReference: "aistory/00000000-0000-4000-8000-000000000002.png",
      },
      {
        role: "home_outfit",
        assetId: "vg11-char-home-outfit-reference",
        sha256: HASH_C,
        preparedReference: "aistory/00000000-0000-4000-8000-000000000003.png",
      },
      {
        role: "expressions",
        assetId: "vg11-char-expression-reference",
        sha256: HASH_D,
        preparedReference: "aistory/00000000-0000-4000-8000-000000000004.png",
      },
    ],
    originalPlanTask: {
      taskId: `svp1-original-${ordinal}`,
      outputRef: `steam-video:v1:original:${ordinal}`,
      status: "ready",
      blockerCodes: [],
    },
    upscalePlanTask: {
      taskId: `svp1-upscale-${ordinal}`,
      outputRef: `steam-video:v1:upscale:${ordinal}`,
    },
    workflowCandidates: [
      publishableWorkflow(),
      labWorkflow("original"),
      labWorkflow("upscale"),
    ],
    ...overrides,
  };
}

function derive(
  shots = STEAM_VIDEO_GENERATION_PREFLIGHT_NODE_IDS.map((nodeId) => shot(nodeId)),
  hashProvider: (value: string) => string = sha256,
) {
  return deriveSteamVideoGenerationPreflight({
    observedAt: FIXED_NOW,
    authority: {
      caseId: "virtual-girlfriend-20260727",
      storyId: "case:virtual-girlfriend-20260727",
      storyVersion: "author-locked-v1.1",
      projectRef: "case-study:virtual-girlfriend-20260727",
    },
    shots,
    sha256: hashProvider,
  });
}

function assertPublicValue(value: unknown): void {
  const forbiddenKeys = new Set([
    "prompt",
    "privatePrompt",
    "privateNegativePrompt",
    "negativePrompt",
    "preparedReference",
    "preparedReferences",
    "referenceRoleSlots",
    "workflowJson",
    "providerTaskId",
    "checkpoint",
    "loras",
    "controlNets",
    "localPath",
    "sourceReferences",
  ]);
  function visit(current: unknown): void {
    if (!current || typeof current !== "object") return;
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
      assert.equal(forbiddenKeys.has(key), false, `forbidden public key ${key}`);
      visit(child);
    }
  }
  visit(value);
  const text = JSON.stringify(value);
  for (const marker of [
    "PRIVATE_PROMPT_MARKER",
    "PRIVATE_NEGATIVE_MARKER",
    "provider-task",
    "D:\\\\AIstory",
    "C:\\\\Users",
    "apiKey",
    "accessToken",
  ]) {
    assert.equal(text.includes(marker), false, `forbidden marker ${marker}`);
  }
}

try {
  const first = derive();
  const second = derive();
  assert.deepEqual(
    first.publicPackage.specs.map((item) => item.specId),
    second.publicPackage.specs.map((item) => item.specId),
    "spec ids must be deterministic",
  );
  assert.equal(first.publicPackage.summary.total, 3);
  assert.equal(first.publicPackage.summary.ready, 3);
  assert.equal(first.publicPackage.executionAllowed, false);
  assert.equal(first.publicPackage.schemaVersion, 2);
  assertPublicValue(first.publicPackage);
  assert.equal(
    serializeSteamVideoGenerationPreflightJson(first.publicPackage).includes(
      "PRIVATE_PROMPT_MARKER",
    ),
    false,
  );
  assert.deepEqual(
    first.publicPackage.specs.map((item) => item.nodeId),
    STEAM_VIDEO_GENERATION_PREFLIGHT_NODE_IDS,
  );
  const releasePolicyHashes = new Set<string>();
  const labPolicyHashes = new Set<string>();
  for (const item of first.publicPackage.specs) {
    assert.deepEqual(item.missingFields, []);
    assert.equal(item.releaseTarget.discriminator, "STEAM_RELEASE_TARGET");
    assert.equal(item.releaseTarget.policyVersion, "steam_release_v1");
    assert.equal(item.releaseTarget.orientation, "landscape");
    assert.equal(item.releaseTarget.aspectRatio, "16:9");
    assert.equal(item.releaseTarget.width, 1280);
    assert.equal(item.releaseTarget.height, 720);
    assert.equal(item.releaseTarget.fps, 24);
    assert.equal(item.releaseTarget.durationSeconds, 30);
    assert.equal(item.releaseTarget.audioIntent, "attach");
    assert.equal(item.releaseTarget.subtitleIntent, "attach_webvtt");
    assert.equal(item.releaseTarget.compatible, true);
    assert.match(item.releaseTarget.policyHash, /^[a-f0-9]{64}$/);
    releasePolicyHashes.add(item.releaseTarget.policyHash);
    assert.equal(item.labPreview.discriminator, "LAB_NON_PUBLISHABLE");
    assert.equal(item.labPreview.policyVersion, "ubuntu_3090_lab_preview_v1");
    assert.equal(item.labPreview.releaseCompatible, false);
    assert.equal(item.labPreview.executionAllowed, false);
    assert.match(item.labPreview.policyHash, /^[a-f0-9]{64}$/);
    labPolicyHashes.add(item.labPreview.policyHash);
    assert.equal(item.labPreview.original.width, 768);
    assert.equal(item.labPreview.original.height, 480);
    assert.equal(item.labPreview.original.aspectRatio, "8:5");
    assert.equal(item.labPreview.original.frameCount, 81);
    assert.equal(item.labPreview.original.fps, 24);
    assert.equal(item.labPreview.original.durationMs, 3375);
    assert.equal(item.labPreview.original.hasAudio, true);
    assert.equal(item.labPreview.original.compatible, true);
    assert.equal(item.labPreview.upscale.width, 1280);
    assert.equal(item.labPreview.upscale.height, 800);
    assert.equal(item.labPreview.upscale.aspectRatio, "8:5");
    assert.equal(item.labPreview.upscale.overwritesOriginal, false);
    assert.equal(item.labPreview.upscale.compatible, true);
    assert.notEqual(item.labPreview.original.specId, item.labPreview.upscale.specId);
    assert.notEqual(item.labPreview.original.outputRef, item.labPreview.upscale.outputRef);
    assert.notEqual(item.labPreview.original.outputRef, item.original.outputRef);
    assert.notEqual(item.labPreview.upscale.outputRef, item.upscale.outputRef);
    assert.equal(
      item.labPreview.upscale.sourceSpecId,
      item.labPreview.original.specId,
    );
    assert.equal(
      item.labPreview.upscale.sourceOutputRef,
      item.labPreview.original.outputRef,
    );
    assert.notEqual(item.specId, item.upscale.specId);
    assert.notEqual(item.original.taskId, item.upscale.taskId);
    assert.notEqual(item.original.outputRef, item.upscale.outputRef);
    assert.equal(item.upscale.sourceOutputRef, item.original.outputRef);
    assert.deepEqual(item.upscale.blockerCodes, ["upscale_adapter_unavailable"]);
    assert.equal(item.workflow.pin?.fingerprint, HASH_B);
  }
  assert.equal(releasePolicyHashes.size, 1);
  assert.equal(labPolicyHashes.size, 1);
  const releasePolicyCanonical = canonicalForTest(STEAM_RELEASE_TARGET_POLICY);
  const changedPolicyHash = derive(undefined, (value) =>
    value === releasePolicyCanonical ? HASH_D : sha256(value),
  );
  assert.notEqual(
    changedPolicyHash.publicPackage.specs[0]!.releaseTarget.policyHash,
    first.publicPackage.specs[0]!.releaseTarget.policyHash,
  );
  assert.notEqual(
    changedPolicyHash.publicPackage.specs[0]!.specId,
    first.publicPackage.specs[0]!.specId,
    "release policy hash must participate in spec id",
  );
  const labPolicyCanonical = canonicalForTest(STEAM_LAB_PREVIEW_POLICY);
  const changedLabPolicyHash = derive(undefined, (value) =>
    value === labPolicyCanonical ? HASH_C : sha256(value),
  );
  assert.notEqual(
    changedLabPolicyHash.publicPackage.specs[0]!.labPreview.policyHash,
    first.publicPackage.specs[0]!.labPreview.policyHash,
  );
  assert.notEqual(
    changedLabPolicyHash.publicPackage.specs[0]!.specId,
    first.publicPackage.specs[0]!.specId,
    "LAB policy hash must participate in release preflight spec id",
  );

  const mapped = mapSteamVideoGenerationSpecToCreateRequest(
    first.privateSpecs[0]!,
  );
  assert.equal(mapped.ok, true);
  if (mapped.ok) {
    assert.equal(mapped.request.input.idempotencyKey, first.publicPackage.specs[0]!.original.taskId);
    assert.equal(mapped.request.input.workflowId, "reviewed-video-v1");
    assert.equal(mapped.request.expectedWorkflowPin.version, 3);
    assert.equal(
      mapped.request.expectedVideoPolicy.discriminator,
      "STEAM_RELEASE_TARGET",
    );
    assert.equal(mapped.request.expectedVideoPolicy.durationSeconds, 30);
    assert.equal(mapped.request.expectedVideoPolicy.fps, 24);
    assert.equal(mapped.request.expectedVideoPolicy.audioIntent, "attach");
    assert.equal(
      mapped.request.expectedVideoPolicy.subtitleIntent,
      "attach_webvtt",
    );
    assert.deepEqual(Object.keys(mapped.request.input.referenceImages ?? {}).sort(), [
      "expressions",
      "homeOutfit",
      "identityFace",
      "sourceFrame",
    ]);
  }

  const changedPrompt = derive([
    shot("vg11_wake_choice", { privatePrompt: "CHANGED_PRIVATE_PROMPT" }),
    shot("vg11_breakfast_choice"),
    shot("vg11_wake_pull"),
  ]);
  assert.notEqual(
    changedPrompt.publicPackage.specs[0]!.specId,
    first.publicPackage.specs[0]!.specId,
  );

  const changedPin = derive([
    shot("vg11_wake_choice", {
      workflowCandidates: [
        publishableWorkflow({
          activeVersion: 4,
          selectedVersion: 4,
          activeFingerprint: HASH_C,
          selectedFingerprint: HASH_C,
        }),
      ],
    }),
    shot("vg11_breakfast_choice"),
    shot("vg11_wake_pull"),
  ]);
  assert.equal(
    changedPin.publicPackage.specs[0]!.specId,
    first.publicPackage.specs[0]!.specId,
    "authority spec id must not drift with registry selection",
  );
  assert.notEqual(
    changedPin.publicPackage.specs[0]!.inputFingerprint,
    first.publicPackage.specs[0]!.inputFingerprint,
  );

  const workflowCases: Array<{
    candidate: SteamVideoGenerationWorkflowCandidate[];
    code: string;
  }> = [
    { candidate: [], code: "publishable_workflow_missing" },
    {
      candidate: [publishableWorkflow({ enabled: false })],
      code: "workflow_disabled",
    },
    {
      candidate: [publishableWorkflow({ modality: "image" })],
      code: "workflow_wrong_modality",
    },
    {
      candidate: [
        publishableWorkflow(),
        publishableWorkflow({ templateId: "reviewed-video-v2" }),
      ],
      code: "workflow_ambiguous",
    },
    {
      candidate: [publishableWorkflow({ exactVersionResolved: false })],
      code: "workflow_pin_stale",
    },
    {
      candidate: [publishableWorkflow({ capabilities: ["video_generation"] })],
      code: "workflow_capability_mismatch",
    },
    {
      candidate: [
        publishableWorkflow({ releaseClassification: "non_publishable" }),
      ],
      code: "non_publishable_workflow",
    },
    {
      candidate: [
        publishableWorkflow({
          compatibility: releaseCompatibility({ durationSeconds: 4 }),
        }),
      ],
      code: "workflow_duration_unsupported",
    },
    {
      candidate: [
        publishableWorkflow({
          compatibility: releaseCompatibility({ width: 768, aspectRatio: "8:5" }),
        }),
      ],
      code: "workflow_release_policy_mismatch",
    },
  ];
  for (const entry of workflowCases) {
    const result = derive([
      shot("vg11_wake_choice", { workflowCandidates: entry.candidate }),
      shot("vg11_breakfast_choice"),
      shot("vg11_wake_pull"),
    ]);
    assert.equal(
      result.publicPackage.specs[0]!.blockerCodes.includes(
        entry.code as never,
      ),
      true,
      entry.code,
    );
    assert.equal(
      mapSteamVideoGenerationSpecToCreateRequest(result.privateSpecs[0]!).ok,
      false,
    );
  }

  const releaseCandidateDrifts: Array<
    Partial<
      Extract<
        SteamVideoGenerationWorkflowCandidate["compatibility"],
        { discriminator: "STEAM_RELEASE_TARGET" }
      >
    >
  > = [
    { orientation: "portrait" },
    { aspectRatio: "8:5" },
    { width: 768 },
    { height: 800 },
    { fps: 30 },
    { audioIntent: "preserve" },
    { subtitleIntent: "none" },
  ];
  for (const drift of releaseCandidateDrifts) {
    const result = derive([
      shot("vg11_wake_choice", {
        workflowCandidates: [
          publishableWorkflow({ compatibility: releaseCompatibility(drift) }),
        ],
      }),
      shot("vg11_breakfast_choice"),
      shot("vg11_wake_pull"),
    ]);
    assert.equal(
      result.publicPackage.specs[0]!.blockerCodes.includes(
        "workflow_release_policy_mismatch",
      ),
      true,
    );
    assert.equal(
      mapSteamVideoGenerationSpecToCreateRequest(result.privateSpecs[0]!).ok,
      false,
    );
  }

  const catalogPolicyFallback = derive([
    shot("vg11_wake_choice", {
      videoPolicy: {
        orientation: "landscape",
        durationSeconds: 30,
        aspectRatio: null,
        width: null,
        height: null,
        fps: null,
      },
      audioIntent: null,
      subtitleIntent: null,
    }),
    shot("vg11_breakfast_choice"),
    shot("vg11_wake_pull"),
  ]);
  assert.deepEqual(
    catalogPolicyFallback.publicPackage.specs[0]!.missingFields,
    [],
  );
  assert.equal(
    catalogPolicyFallback.publicPackage.specs[0]!.releaseTarget.compatible,
    true,
  );

  const authoritativeDrifts: Array<
    Partial<SteamVideoGenerationAuthoritativeInput>
  > = [
    { videoPolicy: { orientation: "portrait", durationSeconds: 30, aspectRatio: "16:9", width: 1280, height: 720, fps: 24 } },
    { videoPolicy: { orientation: "landscape", durationSeconds: 29, aspectRatio: "16:9", width: 1280, height: 720, fps: 24 } },
    { videoPolicy: { orientation: "landscape", durationSeconds: 30, aspectRatio: "9:16", width: 720, height: 1280, fps: 24 } },
    { videoPolicy: { orientation: "landscape", durationSeconds: 30, aspectRatio: "16:9", width: 1920, height: 1080, fps: 24 } },
    { videoPolicy: { orientation: "landscape", durationSeconds: 30, aspectRatio: "16:9", width: 1280, height: 720, fps: 30 } },
    { audioIntent: "preserve" },
    { subtitleIntent: "none" },
  ];
  for (const drift of authoritativeDrifts) {
    const result = derive([
      shot("vg11_wake_choice", drift),
      shot("vg11_breakfast_choice"),
      shot("vg11_wake_pull"),
    ]);
    assert.equal(
      result.publicPackage.specs[0]!.blockerCodes.includes(
        "release_target_mismatch",
      ),
      true,
    );
    assert.equal(
      mapSteamVideoGenerationSpecToCreateRequest(result.privateSpecs[0]!).ok,
      false,
    );
  }

  const mixedPools = derive([
    shot("vg11_wake_choice", {
      workflowCandidates: [
        labWorkflow("original"),
        publishableWorkflow(),
        labWorkflow("upscale"),
      ],
    }),
    shot("vg11_breakfast_choice"),
    shot("vg11_wake_pull"),
  ]);
  assert.equal(mixedPools.publicPackage.specs[0]!.workflow.pin?.templateId, "reviewed-video-v1");
  assert.equal(mixedPools.publicPackage.specs[0]!.labPreview.original.compatible, true);
  assert.equal(mixedPools.publicPackage.specs[0]!.labPreview.upscale.compatible, true);

  for (const stage of ["original", "upscale"] as const) {
    const profile = STEAM_LAB_PREVIEW_POLICY[stage];
    const drifts: Array<
      Partial<
        Extract<
          SteamVideoGenerationWorkflowCandidate["compatibility"],
          { discriminator: "LAB_NON_PUBLISHABLE" }
        >
      >
    > = [
      { aspectRatio: "16:9" },
      { width: profile.width + 1 },
      { height: profile.height + 1 },
      { frameCount: profile.frameCount - 1 },
      { fps: profile.fps + 1 },
      { durationMs: profile.durationMs + 1 },
      { hasAudio: false },
    ];
    for (const drift of drifts) {
      const result = derive([
        shot("vg11_wake_choice", {
          workflowCandidates: [
            publishableWorkflow(),
            labWorkflow(stage, {
              compatibility: labCompatibility(stage, drift),
            }),
          ],
        }),
        shot("vg11_breakfast_choice"),
        shot("vg11_wake_pull"),
      ]);
      const labStage = result.publicPackage.specs[0]!.labPreview[stage];
      assert.equal(labStage.compatible, false);
      assert.deepEqual(labStage.blockerCodes, ["lab_candidate_mismatch"]);
      assert.equal(
        result.publicPackage.specs[0]!.workflow.pin?.templateId,
        "reviewed-video-v1",
        `malformed LAB ${stage} must not block the release pool`,
      );
    }
    for (const overrides of [
      { enabled: false },
      { modality: "image" as const },
      { releaseClassification: "publishable" as const },
      { exactVersionResolved: false },
    ]) {
      const result = derive([
        shot("vg11_wake_choice", {
          workflowCandidates: [publishableWorkflow(), labWorkflow(stage, overrides)],
        }),
        shot("vg11_breakfast_choice"),
        shot("vg11_wake_pull"),
      ]);
      const labStage = result.publicPackage.specs[0]!.labPreview[stage];
      assert.equal(labStage.compatible, false);
      assert.deepEqual(labStage.blockerCodes, ["lab_candidate_mismatch"]);
      assert.equal(result.publicPackage.specs[0]!.workflow.pin?.templateId, "reviewed-video-v1");
    }
    const ambiguous = derive([
      shot("vg11_wake_choice", {
        workflowCandidates: [
          publishableWorkflow(),
          labWorkflow(stage),
          labWorkflow(stage, { templateId: `ubuntu-3090-${stage}-v2` }),
        ],
      }),
      shot("vg11_breakfast_choice"),
      shot("vg11_wake_pull"),
    ]);
    assert.equal(ambiguous.publicPackage.specs[0]!.labPreview[stage].compatible, false);
    assert.deepEqual(
      ambiguous.publicPackage.specs[0]!.labPreview[stage].blockerCodes,
      ["lab_candidate_ambiguous"],
    );
    assert.equal(ambiguous.publicPackage.specs[0]!.workflow.pin?.templateId, "reviewed-video-v1");
  }

  const labOnly = derive([
    shot("vg11_wake_choice", {
      workflowCandidates: [labWorkflow("original"), labWorkflow("upscale")],
    }),
    shot("vg11_breakfast_choice"),
    shot("vg11_wake_pull"),
  ]);
  assert.equal(
    labOnly.publicPackage.specs[0]!.blockerCodes.includes(
      "publishable_workflow_missing",
    ),
    true,
  );
  assert.equal(labOnly.publicPackage.specs[0]!.labPreview.original.compatible, true);
  assert.equal(labOnly.publicPackage.specs[0]!.releaseTarget.compatible, false);
  assert.equal(
    mapSteamVideoGenerationSpecToCreateRequest(labOnly.privateSpecs[0]!).ok,
    false,
  );

  const tamperedLayer = structuredClone(
    first.privateSpecs[0],
  ) as SteamVideoGenerationPrivateSpec;
  (tamperedLayer.publicSpec.releaseTarget as { discriminator: string }).discriminator =
    "LAB_NON_PUBLISHABLE";
  assert.deepEqual(mapSteamVideoGenerationSpecToCreateRequest(tamperedLayer), {
    ok: false,
    error: "preflight_mapping_invalid",
  });

  const tamperedWidth = structuredClone(
    first.privateSpecs[0],
  ) as SteamVideoGenerationPrivateSpec;
  (tamperedWidth.publicSpec.releaseTarget as { width: number }).width = 768;
  assert.deepEqual(mapSteamVideoGenerationSpecToCreateRequest(tamperedWidth), {
    ok: false,
    error: "preflight_mapping_invalid",
  });

  const tamperedPolicyVersion = structuredClone(
    first.privateSpecs[0],
  ) as SteamVideoGenerationPrivateSpec;
  (tamperedPolicyVersion.publicSpec.releaseTarget as { policyVersion: string }).policyVersion =
    "steam_release_v2";
  assert.deepEqual(mapSteamVideoGenerationSpecToCreateRequest(tamperedPolicyVersion), {
    ok: false,
    error: "preflight_mapping_invalid",
  });

  const tamperedPolicyHash = structuredClone(
    first.privateSpecs[0],
  ) as SteamVideoGenerationPrivateSpec;
  (tamperedPolicyHash.publicSpec.releaseTarget as { policyHash: string }).policyHash = HASH_A;
  assert.deepEqual(mapSteamVideoGenerationSpecToCreateRequest(tamperedPolicyHash), {
    ok: false,
    error: "preflight_mapping_invalid",
  });

  const tamperedSpecId = structuredClone(
    first.privateSpecs[0],
  ) as SteamVideoGenerationPrivateSpec;
  (tamperedSpecId.publicSpec as { specId: string }).specId = `svgl1-${HASH_A}`;
  assert.deepEqual(mapSteamVideoGenerationSpecToCreateRequest(tamperedSpecId), {
    ok: false,
    error: "preflight_mapping_invalid",
  });

  const tamperedPin = structuredClone(
    first.privateSpecs[0],
  ) as SteamVideoGenerationPrivateSpec;
  (tamperedPin.publicSpec.workflow.pin as { fingerprint: string }).fingerprint = "invalid";
  assert.deepEqual(mapSteamVideoGenerationSpecToCreateRequest(tamperedPin), {
    ok: false,
    error: "preflight_mapping_invalid",
  });

  const missingReferences = structuredClone(
    first.privateSpecs[0],
  ) as SteamVideoGenerationPrivateSpec;
  missingReferences.publicSpec.references = [];
  assert.deepEqual(mapSteamVideoGenerationSpecToCreateRequest(missingReferences), {
    ok: false,
    error: "preflight_mapping_invalid",
  });

  const duplicateReferenceSlot = structuredClone(
    first.privateSpecs[0],
  ) as SteamVideoGenerationPrivateSpec;
  duplicateReferenceSlot.referenceRoleSlots.identity_face =
    duplicateReferenceSlot.referenceRoleSlots.source_frame;
  assert.deepEqual(mapSteamVideoGenerationSpecToCreateRequest(duplicateReferenceSlot), {
    ok: false,
    error: "preflight_mapping_invalid",
  });

  const unprepared = derive([
    shot("vg11_wake_choice", {
      references: shot("vg11_wake_choice").references.map((reference) => ({
        role: reference.role,
        assetId: reference.assetId,
        sha256: reference.sha256,
      })),
    }),
    shot("vg11_breakfast_choice"),
    shot("vg11_wake_pull"),
  ]);
  assert.equal(
    unprepared.publicPackage.specs[0]!.blockerCodes.includes(
      "source_reference_not_prepared",
    ),
    true,
  );

  const publicStory = JSON.parse(
    await readFile(
      path.join(
        process.cwd(),
        "public",
        "case-studies",
        "virtual-girlfriend-20260727",
        "story.json",
      ),
      "utf8",
    ),
  ) as unknown;
  const realPlan = await readSteamVideoProductionPlan({
    readPublicStory: async () => publicStory,
    sourceExists: async (url) => !url.endsWith("pending.svg"),
    listJobs: async () => [],
    listAssets: async () => [],
    listWorkflows: async () => [],
    now: () => FIXED_NOW,
  });
  const authoritative = await readSteamVideoGenerationPreflight({
    readPlan: async () => realPlan,
    listWorkflowCandidates: async () => [],
    now: () => FIXED_NOW,
  });
  const rawShotCatalog = JSON.parse(
    await readFile(
      path.join(
        process.cwd(),
        "content",
        "case-studies",
        "virtual-girlfriend-20260727",
        "author-locked-v1.1",
        "video-prompts.v1.1.json",
      ),
      "utf8",
    ),
  ) as { shots: Array<Record<string, unknown>> };
  const conflictingCatalog = structuredClone(rawShotCatalog);
  const conflictingShot = conflictingCatalog.shots.find(
    (entry) => entry.nodeId === "vg11_wake_choice",
  );
  assert.ok(conflictingShot);
  conflictingShot.fps = 30;
  await assert.rejects(
    readSteamVideoGenerationPreflight({
      readPlan: async () => realPlan,
      readShotCatalog: async () => conflictingCatalog,
      listWorkflowCandidates: async () => [],
      now: () => FIXED_NOW,
    }),
    /authoritative_spec_invalid/,
  );
  assert.deepEqual(
    authoritative.specs.map((item) => item.nodeId),
    STEAM_VIDEO_GENERATION_PREFLIGHT_NODE_IDS,
  );
  assert.deepEqual(authoritative.summary, { total: 3, ready: 0, blocked: 3 });
  assert.equal(authoritative.executionAllowed, false);
  assert.deepEqual(authoritative.gpu, {
    connected: false,
    probed: false,
    executionAllowed: false,
  });
  for (const spec of authoritative.specs) {
    assert.deepEqual(spec.missingFields, []);
    assert.deepEqual(
      spec.blockerCodes,
      [
        "source_reference_not_prepared",
        "publishable_workflow_missing",
      ],
    );
    assert.equal(spec.releaseTarget.discriminator, "STEAM_RELEASE_TARGET");
    assert.equal(spec.releaseTarget.compatible, false);
    assert.equal(spec.releaseTarget.aspectRatio, "16:9");
    assert.equal(spec.releaseTarget.width, 1280);
    assert.equal(spec.releaseTarget.height, 720);
    assert.equal(spec.releaseTarget.fps, 24);
    assert.equal(spec.releaseTarget.durationSeconds, 30);
    assert.equal(spec.labPreview.discriminator, "LAB_NON_PUBLISHABLE");
    assert.equal(spec.labPreview.releaseCompatible, false);
    assert.deepEqual(spec.labPreview.original.blockerCodes, [
      "lab_candidate_missing",
    ]);
    assert.deepEqual(spec.labPreview.upscale.blockerCodes, [
      "lab_candidate_missing",
    ]);
    assert.notEqual(spec.labPreview.original.outputRef, spec.original.outputRef);
    assert.notEqual(spec.labPreview.upscale.outputRef, spec.upscale.outputRef);
    assert.equal(
      spec.labPreview.upscale.sourceOutputRef,
      spec.labPreview.original.outputRef,
    );
    assert.equal(spec.references.length, 4);
    assert.equal(spec.references.every((reference) => !reference.prepared), true);
    assert.equal(spec.workflow.pin, null);
  }

  const remoteResponse = await handleSteamVideoGenerationPreflightGet(
    new Request("http://example.com/api/steam/video-generation-preflight", {
      headers: { host: "example.com" },
    }),
    { read: async () => authoritative },
  );
  assert.equal(remoteResponse.status, 404);
  const localRequest = new Request(
    "http://127.0.0.1:4215/api/steam/video-generation-preflight",
    { headers: { host: "127.0.0.1:4215" } },
  );
  const localResponse = await handleSteamVideoGenerationPreflightGet(
    localRequest,
    { read: async () => authoritative },
  );
  assert.equal(localResponse.status, 200);
  assert.equal(localResponse.headers.get("cache-control"), "no-store");
  assert.deepEqual(await localResponse.json(), authoritative);
  const unavailableResponse = await handleSteamVideoGenerationPreflightGet(
    localRequest,
    {
      read: async () => {
        throw new Error("PRIVATE_PROMPT_MARKER_MUST_NOT_ESCAPE");
      },
    },
  );
  assert.equal(unavailableResponse.status, 503);
  assert.equal(unavailableResponse.headers.get("cache-control"), "no-store");
  assert.deepEqual(await unavailableResponse.json(), {
    error: "generation_preflight_unavailable",
  });

  assertPublicValue(authoritative);
  const exportedJson = serializeSteamVideoGenerationPreflightJson(authoritative);
  const exportedCsv = serializeSteamVideoGenerationPreflightCsv(authoritative);
  assertPublicValue(JSON.parse(exportedJson));
  assert.equal(exportedCsv.includes("PRIVATE_PROMPT_MARKER"), false);
  assert.equal(exportedCsv.includes("localPath"), false);
  assert.equal(exportedCsv.includes("providerTaskId"), false);
  assert.equal(exportedCsv.includes("STEAM_RELEASE_TARGET"), true);
  assert.equal(exportedCsv.includes("LAB_NON_PUBLISHABLE"), true);
  assert.equal(exportedCsv.includes("releasePolicyHash"), true);
  assert.equal(exportedCsv.includes("labUpscaleOverwritesOriginal"), true);
  assert.equal(exportedCsv.split("\r\n").filter(Boolean).length, 4);

  assert.throws(
    () => derive([shot("vg11_wake_choice"), shot("vg11_breakfast_choice")]),
    /authoritative_spec_invalid/,
  );

  const domainSource = await readFile(
    path.join(process.cwd(), "lib", "steam", "productionSpec.ts"),
    "utf8",
  );
  const serverSource = await readFile(
    path.join(process.cwd(), "lib", "steam", "productionSpecServer.ts"),
    "utf8",
  );
  const panelSource = await readFile(
    path.join(process.cwd(), "components", "SteamVideoGenerationPreflightPanel.tsx"),
    "utf8",
  );
  const routeSource = await readFile(
    path.join(
      process.cwd(),
      "app",
      "api",
      "steam",
      "video-generation-preflight",
      "route.ts",
    ),
    "utf8",
  );
  assert.match(routeSource, /export async function GET/);
  assert.match(routeSource, /handleSteamVideoGenerationPreflightGet\s*\(/);
  const routeExports = [
    ...routeSource.matchAll(
      /^\s*export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/gm,
    ),
  ].map((match) => match[1]);
  assert.deepEqual(
    routeExports.sort(),
    ["GET", "runtime"],
    "the route module may only export the runtime segment and GET",
  );
  for (const forbiddenImport of [
    "generation-jobs/server",
    "generation-jobs/store",
    "providers/comfyui/server",
    "providers/comfyui/transport",
    "gpu-coordinator/service",
  ]) {
    assert.equal(domainSource.includes(forbiddenImport), false, forbiddenImport);
    assert.equal(serverSource.includes(forbiddenImport), false, forbiddenImport);
  }
  for (const forbiddenSideEffect of [
    "writeFile(",
    "appendFile(",
    "mkdir(",
    "unlink(",
    "submitLanGpuVideoJob",
    "requestComfyUI",
    "GenerationJobScheduler",
  ]) {
    assert.equal(domainSource.includes(forbiddenSideEffect), false, forbiddenSideEffect);
    assert.equal(serverSource.includes(forbiddenSideEffect), false, forbiddenSideEffect);
  }
  assert.equal(panelSource.includes("/api/generation-jobs"), false);
  assert.equal(panelSource.includes('method: "POST"'), false);
  assert.equal(panelSource.includes("submit"), false);
  assert.equal(panelSource.includes("enqueue"), false);
  assert.equal(panelSource.includes("8188"), false);
  assert.equal(panelSource.includes("Steam 发布目标 vs 3090 内测 LAB"), true);
  assert.equal(panelSource.includes("LAB 试片不等于 Steam 发布成片"), true);
  assert.equal(panelSource.includes("data-preflight-release-target"), true);
  assert.equal(panelSource.includes("data-preflight-lab-original"), true);
  assert.equal(panelSource.includes("data-preflight-lab-upscale"), true);
  assert.equal(networkCalls, 0);

  console.log(
    `steam video generation preflight tests passed: nodes=${authoritative.summary.total}, blocked=${authoritative.summary.blocked}, network=${networkCalls}`,
  );
} finally {
  globalThis.fetch = ORIGINAL_FETCH;
}
