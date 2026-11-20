import type { ComfyUIGenerationJobInput } from "@/lib/generation-jobs/types";
import type { SteamVideoProductionPlanStatus } from "@/lib/steam/productionPlan";

export const STEAM_VIDEO_GENERATION_PREFLIGHT_SCHEMA =
  "aistory-steam-video-generation-preflight";
export const STEAM_VIDEO_GENERATION_PREFLIGHT_SCHEMA_VERSION = 2 as const;
export {
  serializeSteamVideoGenerationPreflightCsv,
  serializeSteamVideoGenerationPreflightJson,
  STEAM_VIDEO_GENERATION_PREFLIGHT_CSV_FILENAME,
  STEAM_VIDEO_GENERATION_PREFLIGHT_JSON_FILENAME,
} from "@/lib/steam/productionSpecPublic";

export const STEAM_VIDEO_GENERATION_PREFLIGHT_NODE_IDS = [
  "vg11_wake_choice",
  "vg11_breakfast_choice",
  "vg11_wake_pull",
] as const;

export const STEAM_VIDEO_GENERATION_REQUIRED_CAPABILITIES = [
  "video_generation",
  "reference_image_conditioning",
  "publishable_output",
] as const;

export const STEAM_RELEASE_TARGET_POLICY = Object.freeze({
  discriminator: "STEAM_RELEASE_TARGET",
  policyVersion: "steam_release_v1",
  orientation: "landscape",
  aspectRatio: "16:9",
  width: 1280,
  height: 720,
  fps: 24,
  durationSeconds: 30,
  audioIntent: "attach",
  subtitleIntent: "attach_webvtt",
} as const);

export const STEAM_LAB_PREVIEW_POLICY = Object.freeze({
  discriminator: "LAB_NON_PUBLISHABLE",
  policyVersion: "ubuntu_3090_lab_preview_v1",
  original: Object.freeze({
    stage: "original",
    width: 768,
    height: 480,
    aspectRatio: "8:5",
    frameCount: 81,
    fps: 24,
    durationMs: 3375,
    hasAudio: true,
  }),
  upscale: Object.freeze({
    stage: "upscale",
    width: 1280,
    height: 800,
    aspectRatio: "8:5",
    frameCount: 81,
    fps: 24,
    durationMs: 3375,
    hasAudio: true,
    overwritesOriginal: false,
  }),
} as const);

export const STEAM_VIDEO_GENERATION_MISSING_FIELDS = [
  "aspect_ratio",
  "width",
  "height",
  "fps",
  "audio_intent",
  "subtitle_intent",
] as const;

export type SteamVideoGenerationPreflightNodeId =
  (typeof STEAM_VIDEO_GENERATION_PREFLIGHT_NODE_IDS)[number];
export type SteamVideoGenerationRequiredCapability =
  (typeof STEAM_VIDEO_GENERATION_REQUIRED_CAPABILITIES)[number];
export type SteamVideoGenerationMissingField =
  (typeof STEAM_VIDEO_GENERATION_MISSING_FIELDS)[number];

export type SteamVideoGenerationPreflightBlocker =
  | "authoritative_spec_invalid"
  | "missing_shot_spec"
  | "plan_task_not_ready"
  | "source_reference_not_prepared"
  | "publishable_workflow_missing"
  | "workflow_ambiguous"
  | "workflow_disabled"
  | "workflow_wrong_modality"
  | "workflow_capability_mismatch"
  | "workflow_pin_stale"
  | "workflow_duration_unsupported"
  | "workflow_release_policy_mismatch"
  | "non_publishable_workflow"
  | "release_target_mismatch"
  | "upscale_adapter_unavailable";

export type SteamVideoGenerationLabBlocker =
  | "lab_candidate_missing"
  | "lab_candidate_ambiguous"
  | "lab_candidate_mismatch";

export type SteamVideoGenerationReferenceRole =
  | "source_frame"
  | "identity_face"
  | "home_outfit"
  | "expressions";

export type SteamVideoGenerationWorkflowPin = {
  source: "comfyui_registry";
  templateId: string;
  version: number;
  fingerprint: string;
  modality: "video";
};

export type SteamVideoGenerationLabCandidateIdentity = {
  source: "gpu_connector_lab";
  templateId: string;
  version: number;
  fingerprint: string;
  stage: "original" | "upscale";
};

export type SteamVideoGenerationWorkflowCompatibility =
  | {
      discriminator: "STEAM_RELEASE_TARGET";
      orientation: "landscape" | "portrait";
      aspectRatio: "16:9" | "9:16" | "8:5";
      width: number;
      height: number;
      fps: number;
      durationSeconds: number;
      audioIntent: "preserve" | "attach" | "silent";
      subtitleIntent: "attach_webvtt" | "none";
    }
  | {
      discriminator: "LAB_NON_PUBLISHABLE";
      stage: "original" | "upscale";
      aspectRatio: "16:9" | "9:16" | "8:5";
      width: number;
      height: number;
      frameCount: number;
      fps: number;
      durationMs: number;
      hasAudio: boolean;
    }
  | { discriminator: "UNCLASSIFIED" };

export type SteamVideoGenerationPublicReference = {
  role: SteamVideoGenerationReferenceRole;
  assetId: string;
  sha256: string;
  prepared: boolean;
};

export type SteamVideoGenerationPreflightSpec = {
  schemaVersion: typeof STEAM_VIDEO_GENERATION_PREFLIGHT_SCHEMA_VERSION;
  specId: string;
  status: "blocked" | "ready";
  executionAllowed: false;
  projectRef: string;
  storyId: string;
  storyVersion: string;
  nodeId: SteamVideoGenerationPreflightNodeId;
  sceneId: string;
  episodeId: string;
  shotId: string;
  sourceContentHash: string;
  inputFingerprint: string;
  priority: "launch_p0";
  releaseTarget: {
    discriminator: "STEAM_RELEASE_TARGET";
    policyVersion: "steam_release_v1";
    policyHash: string;
    compatible: boolean;
    orientation: "landscape";
    aspectRatio: "16:9";
    width: 1280;
    height: 720;
    fps: 24;
    durationSeconds: 30;
    audioIntent: "attach";
    subtitleIntent: "attach_webvtt";
  };
  original: {
    taskId: string;
    outputRef: string;
    planStatus: SteamVideoProductionPlanStatus;
  };
  upscale: {
    specId: string;
    taskId: string;
    outputRef: string;
    sourceOutputRef: string;
    optional: true;
    status: "blocked";
    blockerCodes: readonly ["upscale_adapter_unavailable"];
  };
  labPreview: {
    discriminator: "LAB_NON_PUBLISHABLE";
    policyVersion: "ubuntu_3090_lab_preview_v1";
    policyHash: string;
    releaseCompatible: false;
    executionAllowed: false;
    original: {
      stage: "original";
      specId: string;
      outputRef: string;
      compatible: boolean;
      candidate: SteamVideoGenerationLabCandidateIdentity | null;
      blockerCodes: SteamVideoGenerationLabBlocker[];
      width: 768;
      height: 480;
      aspectRatio: "8:5";
      frameCount: 81;
      fps: 24;
      durationMs: 3375;
      hasAudio: true;
    };
    upscale: {
      stage: "upscale";
      specId: string;
      outputRef: string;
      sourceSpecId: string;
      sourceOutputRef: string;
      compatible: boolean;
      candidate: SteamVideoGenerationLabCandidateIdentity | null;
      blockerCodes: SteamVideoGenerationLabBlocker[];
      width: 1280;
      height: 800;
      aspectRatio: "8:5";
      frameCount: 81;
      fps: 24;
      durationMs: 3375;
      hasAudio: true;
      overwritesOriginal: false;
    };
  };
  videoPolicy: {
    source: "steam_release_policy";
    orientation: "landscape";
    durationSeconds: 30;
    aspectRatio: "16:9";
    width: 1280;
    height: 720;
    fps: 24;
    seedPolicy: "derived_from_spec_id";
  };
  audioSubtitleIntent: {
    audio: "attach";
    subtitles: "attach_webvtt";
  };
  references: SteamVideoGenerationPublicReference[];
  workflow: {
    requiredModality: "video";
    requiredCapabilities: SteamVideoGenerationRequiredCapability[];
    pin: SteamVideoGenerationWorkflowPin | null;
  };
  missingFields: SteamVideoGenerationMissingField[];
  blockerCodes: SteamVideoGenerationPreflightBlocker[];
};

export type SteamVideoGenerationPreflightPackage = {
  schema: typeof STEAM_VIDEO_GENERATION_PREFLIGHT_SCHEMA;
  schemaVersion: typeof STEAM_VIDEO_GENERATION_PREFLIGHT_SCHEMA_VERSION;
  mode: "preflight_only";
  executionAllowed: false;
  observedAt: string;
  authority: {
    caseId: string;
    storyId: string;
    storyVersion: string;
    projectRef: string;
    targetNodeIds: SteamVideoGenerationPreflightNodeId[];
  };
  gpu: {
    connected: false;
    probed: false;
    executionAllowed: false;
  };
  summary: {
    total: number;
    ready: number;
    blocked: number;
  };
  specs: SteamVideoGenerationPreflightSpec[];
};

export type SteamVideoGenerationWorkflowCandidate = {
  source: "comfyui_registry" | "gpu_connector_lab" | "video_workflow_ab";
  templateId: string;
  modality: "image" | "video";
  enabled: boolean;
  activeVersion: number;
  activeFingerprint: string;
  selectedVersion: number;
  selectedFingerprint: string;
  exactVersionResolved: boolean;
  releaseClassification: "publishable" | "non_publishable" | "unclassified";
  capabilities: SteamVideoGenerationRequiredCapability[];
  compatibility: SteamVideoGenerationWorkflowCompatibility;
  referenceRoleSlots?: Partial<Record<SteamVideoGenerationReferenceRole, string>>;
};

export type SteamVideoGenerationAuthoritativeInput = {
  projectRef: string;
  caseId: string;
  storyId: string;
  storyVersion: string;
  nodeId: SteamVideoGenerationPreflightNodeId;
  sceneId: string;
  episodeId: string;
  shotId: string;
  sourceContentHash: string;
  privatePrompt: string;
  privateNegativePrompt?: string;
  videoPolicy: {
    orientation: "landscape" | "portrait";
    durationSeconds: number;
    aspectRatio: "16:9" | "9:16" | null;
    width: number | null;
    height: number | null;
    fps: number | null;
  };
  audioIntent: "preserve" | "attach" | "silent" | null;
  subtitleIntent: "attach_webvtt" | "none" | null;
  references: Array<{
    role: SteamVideoGenerationReferenceRole;
    assetId: string;
    sha256: string;
    preparedReference?: string;
  }>;
  originalPlanTask: {
    taskId: string;
    outputRef: string;
    status: SteamVideoProductionPlanStatus;
    blockerCodes: string[];
  };
  upscalePlanTask: {
    taskId: string;
    outputRef: string;
  };
  workflowCandidates: SteamVideoGenerationWorkflowCandidate[];
};

export type SteamVideoGenerationPrivateSpec = {
  publicSpec: SteamVideoGenerationPreflightSpec;
  releasePolicyHash: string;
  prompt: string;
  negativePrompt?: string;
  preparedReferences: Partial<Record<SteamVideoGenerationReferenceRole, string>>;
  referenceRoleSlots: Partial<Record<SteamVideoGenerationReferenceRole, string>>;
};

export type DeriveSteamVideoGenerationPreflightInput = {
  observedAt: string;
  authority: {
    caseId: string;
    storyId: string;
    storyVersion: string;
    projectRef: string;
  };
  shots: SteamVideoGenerationAuthoritativeInput[];
  sha256: (canonicalValue: string) => string;
};

export type SteamVideoGenerationCreateRequest = {
  provider: "comfyui";
  sourceSpecId: string;
  expectedWorkflowPin: SteamVideoGenerationWorkflowPin;
  expectedVideoPolicy: {
    discriminator: "STEAM_RELEASE_TARGET";
    durationSeconds: number;
    fps: number;
    aspectRatio: "16:9";
    width: number;
    height: number;
    audioIntent: "attach";
    subtitleIntent: "attach_webvtt";
  };
  input: ComfyUIGenerationJobInput;
};

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const RELEASE_SPEC_ID = /^svgs2-[a-f0-9]{64}$/;
const SAFE_REFERENCE = /^aistory\/[0-9a-f-]{36}\.(?:avif|jpeg|jpg|png|webp)$/;
const SAFE_SLOT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ALLOWED_PLAN_BLOCKERS = new Set([
  "workflow_capability_missing",
  "workflow_pin_missing",
]);

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

function hash(
  sha256: DeriveSteamVideoGenerationPreflightInput["sha256"],
  value: unknown,
): string {
  const result = sha256(canonical(value));
  if (!SHA256.test(result)) throw new Error("invalid_sha256_provider");
  return result;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function safeInput(input: SteamVideoGenerationAuthoritativeInput): boolean {
  const referenceRoles = new Set<SteamVideoGenerationReferenceRole>();
  const { aspectRatio, width, height, fps } = input.videoPolicy;
  const safeDimensions =
    (width === null ||
      (Number.isSafeInteger(width) && width >= 256 && width <= 8192)) &&
    (height === null ||
      (Number.isSafeInteger(height) && height >= 256 && height <= 8192)) &&
    (fps === null ||
      (Number.isSafeInteger(fps) && fps >= 1 && fps <= 120)) &&
    (aspectRatio === null || aspectRatio === "16:9" || aspectRatio === "9:16") &&
    (aspectRatio === null || width === null || height === null ||
      (aspectRatio === "16:9" ? width * 9 === height * 16 : width * 16 === height * 9));
  return (
    STEAM_VIDEO_GENERATION_PREFLIGHT_NODE_IDS.includes(input.nodeId) &&
    [
      input.projectRef,
      input.caseId,
      input.storyId,
      input.storyVersion,
      input.nodeId,
      input.sceneId,
      input.episodeId,
      input.shotId,
      input.originalPlanTask.taskId,
      input.upscalePlanTask.taskId,
      input.originalPlanTask.outputRef,
      input.upscalePlanTask.outputRef,
    ].every((value) => SAFE_ID.test(value)) &&
    SHA256.test(input.sourceContentHash) &&
    input.privatePrompt.trim().length > 0 &&
    input.privatePrompt.length <= 32_000 &&
    !input.privatePrompt.includes("\0") &&
    (!input.privateNegativePrompt ||
      (input.privateNegativePrompt.length <= 16_000 &&
        !input.privateNegativePrompt.includes("\0"))) &&
    Number.isSafeInteger(input.videoPolicy.durationSeconds) &&
    input.videoPolicy.durationSeconds > 0 &&
    input.videoPolicy.durationSeconds <= 600 &&
    safeDimensions &&
    (input.audioIntent === null ||
      input.audioIntent === "preserve" ||
      input.audioIntent === "attach" ||
      input.audioIntent === "silent") &&
    (input.subtitleIntent === null ||
      input.subtitleIntent === "attach_webvtt" ||
      input.subtitleIntent === "none") &&
    input.references.length === 4 &&
    input.references.every((reference) => {
      if (
        referenceRoles.has(reference.role) ||
        !SAFE_ID.test(reference.assetId) ||
        !SHA256.test(reference.sha256) ||
        (reference.preparedReference !== undefined &&
          !SAFE_REFERENCE.test(reference.preparedReference))
      ) {
        return false;
      }
      referenceRoles.add(reference.role);
      return true;
    }) &&
    (["source_frame", "identity_face", "home_outfit", "expressions"] as const).every(
      (role) => referenceRoles.has(role),
    )
  );
}

function authorityMatchesReleaseTarget(
  input: SteamVideoGenerationAuthoritativeInput,
): boolean {
  const policy = STEAM_RELEASE_TARGET_POLICY;
  return (
    input.videoPolicy.orientation === policy.orientation &&
    input.videoPolicy.durationSeconds === policy.durationSeconds &&
    (input.videoPolicy.aspectRatio === null ||
      input.videoPolicy.aspectRatio === policy.aspectRatio) &&
    (input.videoPolicy.width === null || input.videoPolicy.width === policy.width) &&
    (input.videoPolicy.height === null || input.videoPolicy.height === policy.height) &&
    (input.videoPolicy.fps === null || input.videoPolicy.fps === policy.fps) &&
    (input.audioIntent === null || input.audioIntent === policy.audioIntent) &&
    (input.subtitleIntent === null ||
      input.subtitleIntent === policy.subtitleIntent)
  );
}

function releaseCompatibilityMatches(
  compatibility: SteamVideoGenerationWorkflowCompatibility,
): boolean {
  const policy = STEAM_RELEASE_TARGET_POLICY;
  return (
    compatibility.discriminator === policy.discriminator &&
    compatibility.orientation === policy.orientation &&
    compatibility.aspectRatio === policy.aspectRatio &&
    compatibility.width === policy.width &&
    compatibility.height === policy.height &&
    compatibility.fps === policy.fps &&
    compatibility.durationSeconds === policy.durationSeconds &&
    compatibility.audioIntent === policy.audioIntent &&
    compatibility.subtitleIntent === policy.subtitleIntent
  );
}

function labCompatibilityMatches(
  compatibility: SteamVideoGenerationWorkflowCompatibility,
  stage: "original" | "upscale",
): boolean {
  if (
    compatibility.discriminator !== STEAM_LAB_PREVIEW_POLICY.discriminator ||
    compatibility.stage !== stage
  ) {
    return false;
  }
  const policy = STEAM_LAB_PREVIEW_POLICY[stage];
  return (
    compatibility.aspectRatio === policy.aspectRatio &&
    compatibility.width === policy.width &&
    compatibility.height === policy.height &&
    compatibility.frameCount === policy.frameCount &&
    compatibility.fps === policy.fps &&
    compatibility.durationMs === policy.durationMs &&
    compatibility.hasAudio === policy.hasAudio
  );
}

function hasExactCandidatePin(
  candidate: SteamVideoGenerationWorkflowCandidate,
): boolean {
  return (
    candidate.exactVersionResolved &&
    candidate.activeVersion === candidate.selectedVersion &&
    candidate.activeFingerprint === candidate.selectedFingerprint &&
    Number.isSafeInteger(candidate.selectedVersion) &&
    candidate.selectedVersion > 0 &&
    SHA256.test(candidate.selectedFingerprint) &&
    SAFE_ID.test(candidate.templateId)
  );
}

function resolveReleaseWorkflow(
  candidates: SteamVideoGenerationWorkflowCandidate[],
): {
  pin: SteamVideoGenerationWorkflowPin | null;
  blocker?: SteamVideoGenerationPreflightBlocker;
  slots: Partial<Record<SteamVideoGenerationReferenceRole, string>>;
} {
  const registry = candidates.filter(
    (candidate) =>
      candidate.source === "comfyui_registry" &&
      candidate.compatibility.discriminator === "STEAM_RELEASE_TARGET",
  );
  if (registry.length === 0) {
    return { pin: null, blocker: "publishable_workflow_missing", slots: {} };
  }
  const enabled = registry.filter((candidate) => candidate.enabled);
  if (enabled.length === 0) {
    return { pin: null, blocker: "workflow_disabled", slots: {} };
  }
  const video = enabled.filter((candidate) => candidate.modality === "video");
  if (video.length === 0) {
    return { pin: null, blocker: "workflow_wrong_modality", slots: {} };
  }
  const publishable = video.filter(
    (candidate) => candidate.releaseClassification === "publishable",
  );
  if (publishable.length === 0) {
    return {
      pin: null,
      blocker: video.some(
        (candidate) => candidate.releaseClassification === "non_publishable",
      )
        ? "non_publishable_workflow"
        : "publishable_workflow_missing",
      slots: {},
    };
  }
  const capable = publishable.filter(
    (candidate) =>
      STEAM_VIDEO_GENERATION_REQUIRED_CAPABILITIES.every((capability) =>
        candidate.capabilities.includes(capability),
      ) &&
      STEAM_VIDEO_GENERATION_REQUIRED_CAPABILITIES.length ===
        unique(candidate.capabilities).length &&
      STEAM_VIDEO_GENERATION_REQUIRED_CAPABILITIES.every((capability) =>
        unique(candidate.capabilities).includes(capability),
      ) &&
      (["source_frame", "identity_face", "home_outfit", "expressions"] as const).every(
        (role) => SAFE_SLOT.test(candidate.referenceRoleSlots?.[role] ?? ""),
      ),
  );
  if (capable.length === 0) {
    return { pin: null, blocker: "workflow_capability_mismatch", slots: {} };
  }
  const policyCompatible = capable.filter((candidate) =>
    releaseCompatibilityMatches(candidate.compatibility),
  );
  if (policyCompatible.length === 0) {
    return {
      pin: null,
      blocker: capable.some(
        (candidate) =>
          candidate.compatibility.discriminator === "STEAM_RELEASE_TARGET" &&
          candidate.compatibility.durationSeconds !==
            STEAM_RELEASE_TARGET_POLICY.durationSeconds,
      )
        ? "workflow_duration_unsupported"
        : "workflow_release_policy_mismatch",
      slots: {},
    };
  }
  const pinned = policyCompatible.filter(hasExactCandidatePin);
  if (pinned.length === 0) {
    return { pin: null, blocker: "workflow_pin_stale", slots: {} };
  }
  if (pinned.length > 1) {
    return { pin: null, blocker: "workflow_ambiguous", slots: {} };
  }
  const candidate = pinned[0]!;
  return {
    pin: {
      source: "comfyui_registry",
      templateId: candidate.templateId,
      version: candidate.selectedVersion,
      fingerprint: candidate.selectedFingerprint,
      modality: "video",
    },
    slots: { ...candidate.referenceRoleSlots },
  };
}

function resolveLabWorkflow(
  candidates: SteamVideoGenerationWorkflowCandidate[],
  stage: "original" | "upscale",
): {
  compatible: boolean;
  candidate: SteamVideoGenerationLabCandidateIdentity | null;
  blockerCodes: SteamVideoGenerationLabBlocker[];
} {
  const pool = candidates.filter(
    (candidate) =>
      candidate.source === "gpu_connector_lab" &&
      candidate.compatibility.discriminator === "LAB_NON_PUBLISHABLE",
  );
  if (pool.length === 0) {
    return {
      compatible: false,
      candidate: null,
      blockerCodes: ["lab_candidate_missing"],
    };
  }
  const exact = pool.filter(
    (candidate) =>
      candidate.enabled &&
      candidate.modality === "video" &&
      candidate.releaseClassification === "non_publishable" &&
      hasExactCandidatePin(candidate) &&
      labCompatibilityMatches(candidate.compatibility, stage),
  );
  if (exact.length === 0) {
    return {
      compatible: false,
      candidate: null,
      blockerCodes: ["lab_candidate_mismatch"],
    };
  }
  if (exact.length > 1) {
    return {
      compatible: false,
      candidate: null,
      blockerCodes: ["lab_candidate_ambiguous"],
    };
  }
  const candidate = exact[0]!;
  return {
    compatible: true,
    candidate: {
      source: "gpu_connector_lab",
      templateId: candidate.templateId,
      version: candidate.selectedVersion,
      fingerprint: candidate.selectedFingerprint,
      stage,
    },
    blockerCodes: [],
  };
}

function planReady(input: SteamVideoGenerationAuthoritativeInput): boolean {
  return (
    input.originalPlanTask.status === "ready" ||
    (input.originalPlanTask.status === "blocked" &&
      input.originalPlanTask.blockerCodes.length > 0 &&
      input.originalPlanTask.blockerCodes.every((code) =>
        ALLOWED_PLAN_BLOCKERS.has(code),
      ))
  );
}

export function deriveSteamVideoGenerationPreflight(
  input: DeriveSteamVideoGenerationPreflightInput,
): {
  publicPackage: SteamVideoGenerationPreflightPackage;
  privateSpecs: SteamVideoGenerationPrivateSpec[];
} {
  const expectedNodes = [...STEAM_VIDEO_GENERATION_PREFLIGHT_NODE_IDS];
  const byNode = new Map(input.shots.map((shot) => [shot.nodeId, shot]));
  if (
    input.shots.length !== expectedNodes.length ||
    byNode.size !== expectedNodes.length ||
    expectedNodes.some((nodeId) => !byNode.has(nodeId)) ||
    ![input.authority.caseId, input.authority.storyId, input.authority.storyVersion, input.authority.projectRef].every(
      (value) => SAFE_ID.test(value),
    )
  ) {
    throw new Error("authoritative_spec_invalid");
  }

  const releasePolicyHash = hash(input.sha256, STEAM_RELEASE_TARGET_POLICY);
  const labPolicyHash = hash(input.sha256, STEAM_LAB_PREVIEW_POLICY);

  const privateSpecs = expectedNodes.map((nodeId) => {
    const shot = byNode.get(nodeId)!;
    if (
      !safeInput(shot) ||
      shot.caseId !== input.authority.caseId ||
      shot.storyId !== input.authority.storyId ||
      shot.storyVersion !== input.authority.storyVersion ||
      shot.projectRef !== input.authority.projectRef
    ) {
      throw new Error("authoritative_spec_invalid");
    }
    const missing: SteamVideoGenerationMissingField[] = [];
    const releaseTargetMatches = authorityMatchesReleaseTarget(shot);
    const workflow = resolveReleaseWorkflow(shot.workflowCandidates);
    const labOriginal = resolveLabWorkflow(shot.workflowCandidates, "original");
    const labUpscale = resolveLabWorkflow(shot.workflowCandidates, "upscale");
    const unprepared = shot.references.some(
      (reference) => reference.preparedReference === undefined,
    );
    const blockers: SteamVideoGenerationPreflightBlocker[] = [];
    if (!releaseTargetMatches) blockers.push("release_target_mismatch");
    if (!planReady(shot)) blockers.push("plan_task_not_ready");
    if (unprepared) blockers.push("source_reference_not_prepared");
    if (workflow.blocker) blockers.push(workflow.blocker);

    const authorityFingerprint = hash(input.sha256, {
      schema: STEAM_VIDEO_GENERATION_PREFLIGHT_SCHEMA,
      schemaVersion: STEAM_VIDEO_GENERATION_PREFLIGHT_SCHEMA_VERSION,
      projectRef: shot.projectRef,
      caseId: shot.caseId,
      storyId: shot.storyId,
      storyVersion: shot.storyVersion,
      nodeId: shot.nodeId,
      sceneId: shot.sceneId,
      episodeId: shot.episodeId,
      shotId: shot.shotId,
      sourceContentHash: shot.sourceContentHash,
      releasePolicy: {
        discriminator: STEAM_RELEASE_TARGET_POLICY.discriminator,
        policyVersion: STEAM_RELEASE_TARGET_POLICY.policyVersion,
        policyHash: releasePolicyHash,
      },
      labPolicy: {
        discriminator: STEAM_LAB_PREVIEW_POLICY.discriminator,
        policyVersion: STEAM_LAB_PREVIEW_POLICY.policyVersion,
        policyHash: labPolicyHash,
      },
      references: [...shot.references]
        .map(({ role, assetId, sha256 }) => ({ role, assetId, sha256 }))
        .sort((a, b) => a.role.localeCompare(b.role)),
      privateRecipeHash: hash(input.sha256, {
        prompt: shot.privatePrompt,
        negativePrompt: shot.privateNegativePrompt ?? null,
      }),
      originalTaskId: shot.originalPlanTask.taskId,
      originalOutputRef: shot.originalPlanTask.outputRef,
    });
    const specId = `svgs2-${authorityFingerprint}`;
    const labOriginalFingerprint = hash(input.sha256, {
      discriminator: STEAM_LAB_PREVIEW_POLICY.discriminator,
      policyVersion: STEAM_LAB_PREVIEW_POLICY.policyVersion,
      policyHash: labPolicyHash,
      stage: "original",
      projectRef: shot.projectRef,
      storyId: shot.storyId,
      storyVersion: shot.storyVersion,
      nodeId: shot.nodeId,
      sourceContentHash: shot.sourceContentHash,
      profile: STEAM_LAB_PREVIEW_POLICY.original,
    });
    const labOriginalSpecId = `svgl1-${labOriginalFingerprint}`;
    const labOriginalOutputRef = `steam-lab:v1:original:${labOriginalFingerprint}`;
    const labUpscaleFingerprint = hash(input.sha256, {
      discriminator: STEAM_LAB_PREVIEW_POLICY.discriminator,
      policyVersion: STEAM_LAB_PREVIEW_POLICY.policyVersion,
      policyHash: labPolicyHash,
      stage: "upscale",
      projectRef: shot.projectRef,
      storyId: shot.storyId,
      storyVersion: shot.storyVersion,
      nodeId: shot.nodeId,
      sourceContentHash: shot.sourceContentHash,
      sourceSpecId: labOriginalSpecId,
      sourceOutputRef: labOriginalOutputRef,
      profile: STEAM_LAB_PREVIEW_POLICY.upscale,
    });
    const labUpscaleSpecId = `svglu1-${labUpscaleFingerprint}`;
    const labUpscaleOutputRef = `steam-lab:v1:upscale:${labUpscaleFingerprint}`;
    const inputFingerprint = hash(input.sha256, {
      specId,
      releasePolicyHash,
      workflowPin: workflow.pin,
      referenceHashes: shot.references.map((reference) => reference.sha256).sort(),
    });
    const publicSpec: SteamVideoGenerationPreflightSpec = {
      schemaVersion: STEAM_VIDEO_GENERATION_PREFLIGHT_SCHEMA_VERSION,
      specId,
      status: blockers.length === 0 ? "ready" : "blocked",
      executionAllowed: false,
      projectRef: shot.projectRef,
      storyId: shot.storyId,
      storyVersion: shot.storyVersion,
      nodeId: shot.nodeId,
      sceneId: shot.sceneId,
      episodeId: shot.episodeId,
      shotId: shot.shotId,
      sourceContentHash: shot.sourceContentHash,
      inputFingerprint,
      priority: "launch_p0",
      releaseTarget: {
        ...STEAM_RELEASE_TARGET_POLICY,
        policyHash: releasePolicyHash,
        compatible: releaseTargetMatches && workflow.pin !== null,
      },
      original: {
        taskId: shot.originalPlanTask.taskId,
        outputRef: shot.originalPlanTask.outputRef,
        planStatus: shot.originalPlanTask.status,
      },
      upscale: {
        specId: `svgu1-${hash(input.sha256, {
          originalSpecId: specId,
          taskId: shot.upscalePlanTask.taskId,
          outputRef: shot.upscalePlanTask.outputRef,
        })}`,
        taskId: shot.upscalePlanTask.taskId,
        outputRef: shot.upscalePlanTask.outputRef,
        sourceOutputRef: shot.originalPlanTask.outputRef,
        optional: true,
        status: "blocked",
        blockerCodes: ["upscale_adapter_unavailable"],
      },
      labPreview: {
        discriminator: STEAM_LAB_PREVIEW_POLICY.discriminator,
        policyVersion: STEAM_LAB_PREVIEW_POLICY.policyVersion,
        policyHash: labPolicyHash,
        releaseCompatible: false,
        executionAllowed: false,
        original: {
          specId: labOriginalSpecId,
          outputRef: labOriginalOutputRef,
          compatible: labOriginal.compatible,
          candidate: labOriginal.candidate,
          blockerCodes: labOriginal.blockerCodes,
          ...STEAM_LAB_PREVIEW_POLICY.original,
        },
        upscale: {
          specId: labUpscaleSpecId,
          outputRef: labUpscaleOutputRef,
          sourceSpecId: labOriginalSpecId,
          sourceOutputRef: labOriginalOutputRef,
          compatible: labUpscale.compatible,
          candidate: labUpscale.candidate,
          blockerCodes: labUpscale.blockerCodes,
          ...STEAM_LAB_PREVIEW_POLICY.upscale,
        },
      },
      videoPolicy: {
        source: "steam_release_policy",
        orientation: STEAM_RELEASE_TARGET_POLICY.orientation,
        durationSeconds: STEAM_RELEASE_TARGET_POLICY.durationSeconds,
        aspectRatio: STEAM_RELEASE_TARGET_POLICY.aspectRatio,
        width: STEAM_RELEASE_TARGET_POLICY.width,
        height: STEAM_RELEASE_TARGET_POLICY.height,
        fps: STEAM_RELEASE_TARGET_POLICY.fps,
        seedPolicy: "derived_from_spec_id",
      },
      audioSubtitleIntent: {
        audio: STEAM_RELEASE_TARGET_POLICY.audioIntent,
        subtitles: STEAM_RELEASE_TARGET_POLICY.subtitleIntent,
      },
      references: shot.references.map((reference) => ({
        role: reference.role,
        assetId: reference.assetId,
        sha256: reference.sha256,
        prepared: reference.preparedReference !== undefined,
      })),
      workflow: {
        requiredModality: "video",
        requiredCapabilities: [...STEAM_VIDEO_GENERATION_REQUIRED_CAPABILITIES],
        pin: workflow.pin,
      },
      missingFields: missing,
      blockerCodes: unique(blockers),
    };
    return {
      publicSpec,
      releasePolicyHash,
      prompt: shot.privatePrompt,
      ...(shot.privateNegativePrompt
        ? { negativePrompt: shot.privateNegativePrompt }
        : {}),
      preparedReferences: Object.fromEntries(
        shot.references
          .filter((reference) => reference.preparedReference)
          .map((reference) => [reference.role, reference.preparedReference!]),
      ),
      referenceRoleSlots: workflow.slots,
    };
  });

  const specs = privateSpecs.map((entry) => entry.publicSpec);
  return {
    publicPackage: {
      schema: STEAM_VIDEO_GENERATION_PREFLIGHT_SCHEMA,
      schemaVersion: STEAM_VIDEO_GENERATION_PREFLIGHT_SCHEMA_VERSION,
      mode: "preflight_only",
      executionAllowed: false,
      observedAt: input.observedAt,
      authority: {
        ...input.authority,
        targetNodeIds: expectedNodes,
      },
      gpu: { connected: false, probed: false, executionAllowed: false },
      summary: {
        total: specs.length,
        ready: specs.filter((spec) => spec.status === "ready").length,
        blocked: specs.filter((spec) => spec.status === "blocked").length,
      },
      specs,
    },
    privateSpecs,
  };
}

function seedFromSpecId(specId: string): number {
  const hex = specId.slice("svgs2-".length, "svgs2-".length + 12);
  return Number.parseInt(hex, 16) % 2_147_483_647;
}

function publicReleaseTargetIsExact(
  value: SteamVideoGenerationPreflightSpec,
  trustedReleasePolicyHash: string,
): boolean {
  const target = value.releaseTarget;
  const policy = STEAM_RELEASE_TARGET_POLICY;
  return (
    target.discriminator === policy.discriminator &&
    RELEASE_SPEC_ID.test(value.specId) &&
    target.policyVersion === policy.policyVersion &&
    SHA256.test(trustedReleasePolicyHash) &&
    target.policyHash === trustedReleasePolicyHash &&
    target.compatible === true &&
    target.orientation === policy.orientation &&
    target.aspectRatio === policy.aspectRatio &&
    target.width === policy.width &&
    target.height === policy.height &&
    target.fps === policy.fps &&
    target.durationSeconds === policy.durationSeconds &&
    target.audioIntent === policy.audioIntent &&
    target.subtitleIntent === policy.subtitleIntent &&
    value.videoPolicy.source === "steam_release_policy" &&
    value.videoPolicy.orientation === policy.orientation &&
    value.videoPolicy.aspectRatio === policy.aspectRatio &&
    value.videoPolicy.width === policy.width &&
    value.videoPolicy.height === policy.height &&
    value.videoPolicy.fps === policy.fps &&
    value.videoPolicy.durationSeconds === policy.durationSeconds &&
    value.audioSubtitleIntent.audio === policy.audioIntent &&
    value.audioSubtitleIntent.subtitles === policy.subtitleIntent
  );
}

export function mapSteamVideoGenerationSpecToCreateRequest(
  spec: SteamVideoGenerationPrivateSpec,
):
  | { ok: true; request: SteamVideoGenerationCreateRequest }
  | { ok: false; error: "preflight_blocked" | "preflight_mapping_invalid" } {
  const value = spec.publicSpec;
  const pin = value.workflow.pin;
  if (!publicReleaseTargetIsExact(value, spec.releasePolicyHash)) {
    return { ok: false, error: "preflight_mapping_invalid" };
  }
  if (value.status !== "ready" || value.blockerCodes.length > 0 || !pin) {
    return { ok: false, error: "preflight_blocked" };
  }
  if (
    pin.source !== "comfyui_registry" ||
    pin.modality !== "video" ||
    !SAFE_ID.test(pin.templateId) ||
    !Number.isSafeInteger(pin.version) ||
    pin.version < 1 ||
    !SHA256.test(pin.fingerprint) ||
    !SAFE_ID.test(value.original.taskId)
  ) {
    return { ok: false, error: "preflight_mapping_invalid" };
  }
  const { aspectRatio, width, height, fps, durationSeconds, orientation } =
    value.videoPolicy;
  if (
    !aspectRatio ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    !Number.isSafeInteger(fps) ||
    width! < 256 ||
    height! < 256 ||
    fps! < 1 ||
    fps! > 120 ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    !spec.prompt.trim()
  ) {
    return { ok: false, error: "preflight_mapping_invalid" };
  }
  const referenceImages: Record<string, string> = {};
  const referenceRoles = new Set<SteamVideoGenerationReferenceRole>();
  const referenceSlots = new Set<string>();
  if (value.references.length !== 4) {
    return { ok: false, error: "preflight_mapping_invalid" };
  }
  for (const reference of value.references) {
    const slot = spec.referenceRoleSlots[reference.role];
    const prepared = spec.preparedReferences[reference.role];
    if (
      referenceRoles.has(reference.role) ||
      !slot ||
      !SAFE_SLOT.test(slot) ||
      referenceSlots.has(slot) ||
      !prepared ||
      !SAFE_REFERENCE.test(prepared)
    ) {
      return { ok: false, error: "preflight_mapping_invalid" };
    }
    referenceRoles.add(reference.role);
    referenceSlots.add(slot);
    referenceImages[slot] = prepared;
  }
  if (
    !(["source_frame", "identity_face", "home_outfit", "expressions"] as const).every(
      (role) => referenceRoles.has(role),
    )
  ) {
    return { ok: false, error: "preflight_mapping_invalid" };
  }
  return {
    ok: true,
    request: {
      provider: "comfyui",
      sourceSpecId: value.specId,
      expectedWorkflowPin: pin,
      expectedVideoPolicy: {
        discriminator: STEAM_RELEASE_TARGET_POLICY.discriminator,
        durationSeconds,
        fps: fps!,
        aspectRatio,
        width: width!,
        height: height!,
        audioIntent: STEAM_RELEASE_TARGET_POLICY.audioIntent,
        subtitleIntent: STEAM_RELEASE_TARGET_POLICY.subtitleIntent,
      },
      input: {
        workflowId: pin.templateId,
        modality: "video",
        prompt: spec.prompt,
        ...(spec.negativePrompt ? { negativePrompt: spec.negativePrompt } : {}),
        referenceImages,
        seed: seedFromSpecId(value.specId),
        width: width!,
        height: height!,
        orientation,
        idempotencyKey: value.original.taskId,
      },
    },
  };
}
