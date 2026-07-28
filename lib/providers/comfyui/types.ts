export type ComfyUIModality = "image" | "video";
export type ComfyUIRequestPurpose = "foreground";

export type ComfyUIWorkflowNode = {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: Record<string, unknown>;
};

export type ComfyUIWorkflowDocument = Record<string, ComfyUIWorkflowNode>;

export type ComfyUINodeInputBinding = {
  nodeId: string;
  input: string;
};

export type ComfyUIWorkflowBindings = {
  positivePrompt?: ComfyUINodeInputBinding;
  negativePrompt?: ComfyUINodeInputBinding;
  checkpoint?: ComfyUINodeInputBinding;
  loras?: Array<{
    name: ComfyUINodeInputBinding;
    modelWeight: ComfyUINodeInputBinding;
    clipWeight?: ComfyUINodeInputBinding;
  }>;
  controlNets?: Array<{
    model: ComfyUINodeInputBinding;
    strength: ComfyUINodeInputBinding;
    startPercent?: ComfyUINodeInputBinding;
    endPercent?: ComfyUINodeInputBinding;
    referenceImage?: ComfyUINodeInputBinding;
  }>;
  referenceImages?: Record<string, ComfyUINodeInputBinding>;
  faceReference?: ComfyUINodeInputBinding;
  seed?: ComfyUINodeInputBinding;
  width?: ComfyUINodeInputBinding;
  height?: ComfyUINodeInputBinding;
  videoNodes?: ComfyUINodeInputBinding[];
};

export type ComfyUIWorkflowConfig = {
  workflow: ComfyUIWorkflowDocument;
  outputNodeIds: string[];
  bindings?: ComfyUIWorkflowBindings;
};

export type ComfyUILoRAConfig = {
  name: string;
  modelWeight: number;
  clipWeight?: number;
};

export type ComfyUIControlNetConfig = {
  model: string;
  strength: number;
  startPercent?: number;
  endPercent?: number;
  referenceSlot?: string;
};

export type ComfyUIProviderConfig = {
  enabled: boolean;
  baseUrl: string;
  checkpoint?: string;
  loras?: ComfyUILoRAConfig[];
  controlNets?: ComfyUIControlNetConfig[];
  faceContinuity?: {
    enabled: boolean;
    referenceSlot?: string;
  };
  workflows?: Partial<Record<ComfyUIModality, ComfyUIWorkflowConfig>>;
  timeoutMs?: number;
};

export type ComfyUIProviderStatus = {
  provider: "comfyui";
  enabled: boolean;
  configured: boolean;
  available: boolean;
  state: "disabled" | "not_configured" | "invalid_config" | "offline" | "ready";
  baseUrl: string;
  modalities: Record<ComfyUIModality, boolean>;
  workflowNodeCounts: Partial<Record<ComfyUIModality, number>>;
  activeTemplateCounts?: Record<ComfyUIModality, number>;
  objectTypeCount?: number;
  queueRemaining?: number;
  message: string;
  checkedAt: string;
};

export type ComfyUIValidationIssue = {
  path: string;
  message: string;
};

export type ComfyUIValidationResult = {
  ok: boolean;
  issues: ComfyUIValidationIssue[];
  summary: {
    enabled: boolean;
    loopbackOnly: boolean;
    modalities: ComfyUIModality[];
    workflowNodeCounts: Partial<Record<ComfyUIModality, number>>;
  };
};

export type ComfyUIWorkflowRequest = {
  modality: ComfyUIModality;
  purpose: ComfyUIRequestPurpose;
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
  idempotencyKey: string;
};

export type ComfyUIQueuedJob = {
  provider: "comfyui";
  modality: ComfyUIModality;
  promptId: string;
  requestFingerprint: string;
  workflowId?: string;
  workflowVersion?: number;
  status: "queued";
};
