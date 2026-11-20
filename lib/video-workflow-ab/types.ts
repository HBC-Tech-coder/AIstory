import type { VideoProbeResult } from "@/lib/video-assets/types";

export const VIDEO_WORKFLOW_AB_SCHEMA_VERSION =
  "aistory-video-workflow-ab-v1" as const;

export const VIDEO_WORKFLOW_AB_OPTIMIZATIONS = [
  "model_offload",
  "text_encoder_cpu_offload",
  "vae_tiling",
  "attention_backend",
  "cache_policy",
  "memory_scheduling",
  "latent_chunking",
] as const;

export type VideoWorkflowABOptimization =
  (typeof VIDEO_WORKFLOW_AB_OPTIMIZATIONS)[number];

export type VideoWorkflowABVariantId = "A" | "B";
export type VideoWorkflowABWeightRole =
  | "diffusion"
  | "vae"
  | "text_encoder";
export type VideoWorkflowABRunStatus = "succeeded" | "failed" | "oom";
export type VideoWorkflowABExperimentStatus =
  | "planned"
  | "completed"
  | "reviewed"
  | "approved"
  | "rejected"
  | "offline";

export type VideoWorkflowABInput = {
  imageAssetId: string;
  imageSha256: string;
  promptSha256: string;
  negativePromptSha256?: string;
  seed: number;
  width: number;
  height: number;
  frameCount: number;
  fps: number;
  samplingSemanticsSha256: string;
};

export type VideoWorkflowABEnvironment = {
  comfyuiVersion: string;
  comfyuiCommit: string;
  gpuModel: string;
  gpuVramMiB: number;
  driverVersion: string;
  cudaVersion?: string;
  pytorchVersion?: string;
};

export type VideoWorkflowABWeight = {
  role: VideoWorkflowABWeightRole;
  fileName: string;
  sha256: string;
  sourceUrl: string;
  sourceRevision: string;
  licenseId: string;
  licenseUrl: string;
};

export type VideoWorkflowABVariantManifest = {
  id: VideoWorkflowABVariantId;
  kind: "official_baseline" | "aistory_4090_optimized";
  workflowPath: string;
  workflowSha256: string;
  parentWorkflowSha256?: string;
  workflowSourceUrl: string;
  workflowSourceRevision: string;
  weightSha256ByRole: Record<VideoWorkflowABWeightRole, string>;
  thirdPartyLoras: string[];
  optimizationChanges: VideoWorkflowABOptimization[];
  postprocess: { enabled: false };
};

export type VideoWorkflowABFileReference = {
  path: string;
  sha256: string;
  bytes: number;
  contentType: string;
};

export type VideoWorkflowABOutputReference = VideoWorkflowABFileReference &
  VideoProbeResult & {
    frameCount: number;
    fps: number;
  };

export type VideoWorkflowABRunManifest = {
  id: string;
  variantId: VideoWorkflowABVariantId;
  pairIndex: number;
  executionOrder: number;
  warmup: boolean;
  status: VideoWorkflowABRunStatus;
  queuedMs: number;
  generationMs: number;
  totalMs: number;
  peakVramMiB: number;
  errorCode?: string;
  output?: VideoWorkflowABOutputReference;
  firstFrame?: VideoWorkflowABFileReference;
  lastFrame?: VideoWorkflowABFileReference;
};

export type VideoWorkflowABPostprocessLayer = {
  id: string;
  parentOutputSha256: string;
  operations: string[];
  output: VideoWorkflowABOutputReference;
};

export type VideoWorkflowABPackageManifest = {
  schemaVersion: typeof VIDEO_WORKFLOW_AB_SCHEMA_VERSION;
  experiment: {
    id: string;
    projectId: number;
    title: string;
    synthetic: boolean;
    createdAt: string;
  };
  input: VideoWorkflowABInput;
  environment: VideoWorkflowABEnvironment;
  weights: VideoWorkflowABWeight[];
  variants: [
    VideoWorkflowABVariantManifest,
    VideoWorkflowABVariantManifest,
  ];
  runs: VideoWorkflowABRunManifest[];
  postprocessLayers?: VideoWorkflowABPostprocessLayer[];
};

export type VideoWorkflowABReviewScores = {
  firstFrameFidelity: number;
  lastFrameIdentityFidelity: number;
  characterConsistency: number;
  motionCoherence: number;
  artifactCleanliness: number;
};

export type VideoWorkflowABReview = {
  scores: VideoWorkflowABReviewScores;
  note: string;
  actorId: string;
  createdAt: string;
};

export type StoredVideoWorkflowABVariant =
  Omit<VideoWorkflowABVariantManifest, "workflowPath"> & {
    workflowFile: string;
  };

export type StoredVideoWorkflowABRun =
  Omit<
    VideoWorkflowABRunManifest,
    "output" | "firstFrame" | "lastFrame" | "variantId"
  > & {
    variantId: VideoWorkflowABVariantId;
    blindId: string;
    blindSlot: "left" | "right";
    output?: Omit<VideoWorkflowABOutputReference, "path"> & {
      artifactFile: string;
    };
    firstFrame?: Omit<VideoWorkflowABFileReference, "path"> & {
      artifactFile: string;
    };
    lastFrame?: Omit<VideoWorkflowABFileReference, "path"> & {
      artifactFile: string;
    };
    review?: VideoWorkflowABReview;
  };

export type StoredVideoWorkflowABExperiment = {
  schemaVersion: 1;
  id: string;
  projectId: number;
  title: string;
  synthetic: boolean;
  status: VideoWorkflowABExperimentStatus;
  input: VideoWorkflowABInput;
  environment: VideoWorkflowABEnvironment;
  weights: VideoWorkflowABWeight[];
  variants: [StoredVideoWorkflowABVariant, StoredVideoWorkflowABVariant];
  runs: StoredVideoWorkflowABRun[];
  postprocessLayers: Array<
    Omit<VideoWorkflowABPostprocessLayer, "output"> & {
      output: Omit<VideoWorkflowABOutputReference, "path"> & {
        artifactFile: string;
      };
    }
  >;
  createdAt: string;
  importedAt: string;
  reviewedAt?: string;
  revealedAt?: string;
  approvedAt?: string;
  rejectedAt?: string;
  offlineAt?: string;
  selectedBlindRunId?: string;
  adoptedProjectAssetId?: string;
};

export type VideoWorkflowABRunDto = {
  blindId: string;
  blindSlot: "left" | "right";
  pairIndex: number;
  executionOrder: number;
  warmup: boolean;
  status: VideoWorkflowABRunStatus;
  queuedMs: number;
  generationMs: number;
  totalMs: number;
  peakVramMiB: number;
  errorCode?: string;
  output?: Omit<VideoWorkflowABOutputReference, "path"> & {
    previewUrl: string;
  };
  review?: Omit<VideoWorkflowABReview, "actorId">;
  variantId?: VideoWorkflowABVariantId;
};

export type VideoWorkflowABExperimentDto = {
  id: string;
  projectId: number;
  title: string;
  synthetic: boolean;
  status: VideoWorkflowABExperimentStatus;
  input: VideoWorkflowABInput;
  environment: VideoWorkflowABEnvironment;
  weights: VideoWorkflowABWeight[];
  variants?: Array<
    Omit<StoredVideoWorkflowABVariant, "workflowFile">
  >;
  runs: VideoWorkflowABRunDto[];
  postprocessLayerCount: number;
  revealed: boolean;
  eligibleForReview: boolean;
  eligibleForApproval: boolean;
  createdAt: string;
  importedAt: string;
  reviewedAt?: string;
  revealedAt?: string;
  approvedAt?: string;
  selectedBlindRunId?: string;
  adoptedProjectAssetId?: string;
  videoAssetReviewRequired: true;
};

export type VideoWorkflowABCapabilityStatus = {
  adapter: "local_development" | "production_repository";
  available: boolean;
  reason?: string;
  maxPackageBytes: number;
  maxEntries: number;
};
