import type {
  GenerationJobProvider,
  GenerationJobStatus,
} from "@/lib/generation-jobs/types";
import type { ComfyUIModality } from "@/lib/providers/comfyui/types";

export type ProjectAssetOrientation =
  | "landscape"
  | "portrait"
  | "square"
  | "unknown";

export type ProjectAsset = {
  id: string;
  projectId: number;
  jobId: string;
  provider: GenerationJobProvider;
  modality: ComfyUIModality;
  status: "ready";
  releaseClassification?: "non_publishable";
  name: string;
  url: string;
  contentHash: string;
  contentType: string;
  bytes: number;
  orientation: ProjectAssetOrientation;
  workflow?: {
    id: string;
    version: number;
  };
  seed?: number;
  provenance:
    | {
        source: "aistory-generation-job";
        requestFingerprint: string;
        generationStatus: Extract<GenerationJobStatus, "succeeded">;
      }
    | {
        source: "aistory-video-ab-experiment";
        experimentId: string;
        runId: string;
        variantId: "A" | "B";
        workflowSha256: string;
      };
  generatedAt: string;
  createdAt: string;
};

export type ProjectAssetList = {
  projectId: number;
  total: number;
  items: ProjectAsset[];
};

export type AdoptProjectAssetResult = {
  asset: ProjectAsset;
  created: boolean;
};
