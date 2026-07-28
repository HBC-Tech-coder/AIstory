export type AiLoverRuntimeStatusName = "idle" | "starting" | "running" | "stopping" | "offline" | "error";

export interface AiLoverHttpProbe {
  url: string;
  ok: boolean;
  reachable: boolean;
  status?: number;
  elapsed_ms?: number;
  content_type?: string;
  error?: string;
  preview?: string;
}

export interface AiLoverListener {
  protocol?: string;
  local?: string;
  pid?: string;
  process?: string;
  error?: string;
}

export interface AiLoverRuntimeStatus {
  ok: boolean;
  generated_at: string;
  port: number;
  url: string;
  copy_path: string;
  source_path: string;
  listeners: AiLoverListener[];
  frontend: AiLoverHttpProbe;
  agent_server_url: string;
  agent_ws_proxy_url?: string;
  start_script: string;
  stop_script: string;
}

export interface AiLoverActionResult {
  ok: boolean;
  action?: string;
  result?: unknown;
  status?: AiLoverRuntimeStatus;
  error?: string;
}

export interface AiLoverAgentHealth {
  agent_server_url: string;
  ok: boolean;
  reachable: boolean;
  probes: AiLoverHttpProbe[];
}

export interface AiLoverDeviceHealth extends AiLoverHttpProbe {
  name: string;
}

export interface AiLoverDevicesSummary {
  ok: boolean;
  generated_at: string;
  devices: AiLoverDeviceHealth[];
}

export interface AiLoverEnvEntry {
  key: string;
  configured: boolean;
  secret: boolean;
  value?: string;
}

export interface AiLoverEnvFile {
  path: string;
  exists: boolean;
  entries: AiLoverEnvEntry[];
}

export interface AiLoverTenNode {
  name?: string;
  addon?: string;
  type?: string;
  model?: string;
  base_url?: string;
  url?: string;
  voice_id?: string;
  secret_fields?: Array<{ path: string; configured: boolean }>;
}

export interface AiLoverTenGraph {
  name?: string;
  auto_start?: boolean;
  nodes: AiLoverTenNode[];
}

export interface AiLoverRedactedConfig {
  ok: boolean;
  generated_at: string;
  env_files: AiLoverEnvFile[];
  ten_property: {
    path: string;
    exists: boolean;
    error?: string;
    graphs: AiLoverTenGraph[];
  };
}

export interface AiLoverRiskFinding {
  severity: "low" | "medium" | "high";
  kind: string;
  path: string;
  line: number;
  detail: string;
}

export interface AiLoverRiskScan {
  ok: boolean;
  generated_at: string;
  scanned_files: number;
  truncated: boolean;
  findings: AiLoverRiskFinding[];
}

export interface AiLoverLogs {
  ok: boolean;
  service: string;
  path?: string;
  exists?: boolean;
  updated_at?: string;
  lines: string[];
  error?: string;
}

export interface AiLoverControlClientOptions {
  pluginBaseUrl?: string;
  fetcher?: typeof fetch;
}

export interface AiLoverCharacterProfile {
  id: string;
  label: string;
  displayName: string;
  modelUrl?: string;
  voiceId?: string;
  identity?: string;
  intro?: string;
  generated?: boolean;
  hidden?: boolean;
}

export interface AiLoverModelOption {
  id: string;
  label: string;
  vendor: string;
  hint?: string;
  default?: boolean;
}

export interface AiLoverModelsResponse {
  ok: boolean;
  generated_at: string;
  path: string;
  exists: boolean;
  default_model_id: string;
  count: number;
  items: AiLoverModelOption[];
}

export interface AiLoverAvatarRegistryItem extends AiLoverCharacterProfile {
  has_identity?: boolean;
  has_intro?: boolean;
  scaleBoost?: number;
  anchorRatio?: number;
}

export interface AiLoverAvatarRegistryResponse {
  ok: boolean;
  generated_at: string;
  path: string;
  exists: boolean;
  count: number;
  visible_count: number;
  hidden_count: number;
  items: AiLoverAvatarRegistryItem[];
}

export interface AiLoverUserCharacterItem extends AiLoverCharacterProfile {
  thumbnailUrl?: string;
  gender?: string;
  visibility?: string;
  sourceType?: string;
  createdAt?: string;
  updatedAt?: string;
  source: "experiment-copy" | "source" | string;
  has_identity?: boolean;
  has_intro?: boolean;
}

export interface AiLoverCharactersResponse {
  ok: boolean;
  generated_at: string;
  source_files: Array<{ source: string; path: string; exists: boolean }>;
  count: number;
  items: AiLoverUserCharacterItem[];
}

export interface AiLoverLive2DJobResult {
  avatarId?: string;
  label?: string;
  displayName?: string;
  modelUrl?: string;
  sourceImageUrl?: string;
  previewImageUrl?: string;
  assetManifestUrl?: string;
  layerPackageUrl?: string;
  cubismTaskUrl?: string;
  cubismReadmeUrl?: string;
  templatePreview?: boolean;
  scaleBoost?: number;
  anchorRatio?: number;
  providerNote?: string;
}

export interface AiLoverLive2DJob {
  id: string;
  name: string;
  provider: string;
  status: "queued" | "processing" | "waiting_provider" | "ready" | "failed" | string;
  message?: string;
  remoteJobId?: string;
  error?: string;
  createdAt?: string;
  updatedAt?: string;
  sourceImageUrl?: string;
  source: "experiment-copy" | "source" | string;
  path: string;
  result?: AiLoverLive2DJobResult;
  has_preprocess?: boolean;
}

export interface AiLoverLive2DJobsResponse {
  ok: boolean;
  generated_at: string;
  source_dirs: Array<{ source: string; path: string; exists: boolean }>;
  count: number;
  items: AiLoverLive2DJob[];
}
