import type { GenerationJobStatus } from "@/lib/generation-jobs/types";
import type {
  AIstoryProviderModality,
  ProviderCapabilityLevel,
} from "@/lib/providers/registry";

export const VOLCENGINE_VIDEO_PENDING_MESSAGE = "视频生成中，故事继续";

export type VolcengineAgentPlanConfig = {
  enabled: boolean;
  baseUrl: string;
  videoModel: string;
  apiKeyEnvName: "VOLCENGINE_AGENT_PLAN_API_KEY";
  credentialConfigured: boolean;
  networkEnabled: false;
  timeoutMs: number;
};

export type VolcengineAgentPlanStatus = {
  provider: "volcengine-agent-plan";
  enabled: boolean;
  configured: boolean;
  available: false;
  state:
    | "disabled"
    | "not_configured"
    | "invalid_config"
    | "contract_ready";
  credential: {
    configured: boolean;
    secretRef: "VOLCENGINE_AGENT_PLAN_API_KEY";
  };
  baseUrl: string;
  videoModelConfigured: boolean;
  networkEnabled: false;
  capabilities: Record<AIstoryProviderModality, ProviderCapabilityLevel>;
  routing: {
    text: "bailian" | "volcengine-agent-plan";
    image: "bailian" | "volcengine-agent-plan";
    tts: "bailian" | "volcengine-agent-plan";
    video: "volcengine-agent-plan";
    automaticFallback: false;
  };
  message: string;
  checkedAt: string;
};

export type VolcengineVideoTextContent = {
  type: "text";
  text: string;
};

export type VolcengineVideoImageContent = {
  type: "image_url";
  image_url: { url: string };
};

export type VolcengineVideoSubmitInput = {
  model: string;
  prompt: string;
  imageUrl?: string;
  returnLastFrame?: boolean;
  idempotencyKey: string;
};

export type VolcengineVideoSubmitBody = {
  model: string;
  content: Array<VolcengineVideoTextContent | VolcengineVideoImageContent>;
  return_last_frame?: boolean;
};

export type VolcengineVideoRawTask = {
  id: string;
  model?: string;
  status: "queued" | "running" | "cancelled" | "succeeded" | "failed";
  created_at?: number;
  updated_at?: number;
  content?: {
    video_url?: string;
    last_frame_url?: string;
  };
  error?: {
    code?: string;
    message?: string;
  };
  seed?: number;
  resolution?: string;
  ratio?: string;
  duration?: string;
  frames?: number;
  framespersecond?: number;
  usage?: {
    completion_tokens?: number;
    total_tokens?: number;
  };
};

export type VolcengineVideoTask = {
  provider: "volcengine-agent-plan";
  providerTaskId: string;
  status: GenerationJobStatus;
  progress: number;
  requestFingerprint: string;
  resultUrl?: string;
  errorCode?: string;
  usageTokens?: number;
  updatedAt?: string;
};

export type VolcengineVideoTransport = {
  submit(body: VolcengineVideoSubmitBody): Promise<{ id: string }>;
  get(providerTaskId: string): Promise<VolcengineVideoRawTask>;
  cancel(providerTaskId: string): Promise<void>;
};
