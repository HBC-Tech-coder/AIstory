import type { ComfyUIModality } from "@/lib/providers/comfyui/types";

export type GenerationJobProvider =
  | "comfyui"
  | "gpu-connector-lan"
  | "localminidrama"
  | "volcengine-agent-plan";
export type GenerationJobStatus =
  | "queued"
  | "running"
  | "pending"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

export type GenerationArtifact = {
  url: string;
  contentType: string;
  bytes: number;
};

export type GenerationJob = {
  id: string;
  provider: GenerationJobProvider;
  modality: ComfyUIModality;
  status: GenerationJobStatus;
  progress: number;
  requestFingerprint: string;
  idempotencyKey: string;
  workflowId?: string;
  workflowVersion?: number;
  providerTaskId?: string;
  attempts: number;
  maxAttempts: number;
  retryable: boolean;
  cancelRequested?: boolean;
  errorCode?: string;
  errorMessage?: string;
  notes?: Array<"cancel_requested_but_completed" | "artifact_unavailable">;
  releaseClassification?: "non_publishable";
  artifact?: GenerationArtifact;
  provenance: {
    purpose: "foreground";
    source: "aistory-studio";
    provider: GenerationJobProvider;
  };
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
};

export type ComfyUIGenerationJobInput = {
  workflowId: string;
  modality: ComfyUIModality;
  prompt: string;
  negativePrompt?: string;
  checkpoint?: string;
  referenceImages?: Record<string, string>;
  faceReference?: string;
  seed?: number;
  width?: number;
  height?: number;
  orientation?: "landscape" | "portrait";
  visualStyleRevision?: string;
  characterStateRevision?: string;
  referenceRevision?: string;
  force?: boolean;
  regenerationNonce?: string;
  idempotencyKey: string;
};

export type LocalMiniDramaImageJobInput = {
  dramaId: number;
  storyboardId?: number;
  sceneId?: number;
  prompt: string;
  negativePrompt?: string;
  frameType?: "first" | "last" | "keyframe" | "storyboard";
  size?: "512x512" | "768x1344" | "1024x1024" | "1344x768";
  aspectRatio?: "1:1" | "16:9" | "9:16";
  style?: string;
  seed?: number;
  force?: boolean;
  regenerationNonce?: string;
  idempotencyKey: string;
};

export type LanGpuVideoGenerateJobInput = {
  taskType: "generate";
  workflowId: string;
  workflowSha256: string;
  prompt: string;
  negativePrompt?: string;
  seed: number;
  width: number;
  height: number;
  frames: number;
  fps: number;
  projectId?: number;
  idempotencyKey: string;
};

export type LanGpuVideoUpscaleJobInput = {
  taskType: "upscale";
  workflowId: string;
  workflowSha256: string;
  sourceJobId: string;
  width: number;
  height: number;
  frames: number;
  fps: number;
  preserveAudio: true;
  projectId?: number;
  idempotencyKey: string;
};

export type LanGpuVideoJobInput =
  | LanGpuVideoGenerateJobInput
  | LanGpuVideoUpscaleJobInput;

export type StoredGenerationJob =
  | (GenerationJob & {
      provider: "comfyui";
      input: ComfyUIGenerationJobInput;
      /** Server-only immutable registry selection captured before enqueue. */
      workflowFingerprint?: string;
    })
  | (GenerationJob & {
      provider: "localminidrama";
      modality: "image";
      input: LocalMiniDramaImageJobInput;
    })
  | (GenerationJob & {
      provider: "gpu-connector-lan";
      modality: "video";
      input: LanGpuVideoJobInput;
    });
