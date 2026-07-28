import type {
  AiLoverControlClientOptions,
  AiLoverRedactedConfig,
  AiLoverRiskScan,
} from "./types";

const DEFAULT_PLUGIN_BASE_URL = "/api/plugins/aistory-lab";

function pluginBaseUrl(options?: AiLoverControlClientOptions): string {
  return (options?.pluginBaseUrl ?? DEFAULT_PLUGIN_BASE_URL).replace(/\/$/, "");
}

async function requestJson<T>(
  path: string,
  init?: RequestInit,
  options?: AiLoverControlClientOptions,
): Promise<T> {
  const fetcher = options?.fetcher ?? fetch;
  const response = await fetcher(`${pluginBaseUrl(options)}${path}`, init);
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(data?.error || data?.detail || `Request failed: ${response.status}`);
  }
  return data as T;
}

export async function getAiLoverRedactedConfig(
  options?: AiLoverControlClientOptions,
): Promise<AiLoverRedactedConfig> {
  return requestJson<AiLoverRedactedConfig>("/ai-lover/config/redacted", undefined, options);
}

export async function scanAiLoverConfigRisks(
  options?: AiLoverControlClientOptions,
): Promise<AiLoverRiskScan> {
  return requestJson<AiLoverRiskScan>("/ai-lover/scan", undefined, options);
}

export function countConfiguredSecrets(config: AiLoverRedactedConfig): number {
  const envSecrets = config.env_files.flatMap((file) => file.entries).filter((entry) => entry.secret && entry.configured);
  const tenSecrets = config.ten_property.graphs
    .flatMap((graph) => graph.nodes)
    .flatMap((node) => node.secret_fields ?? [])
    .filter((field) => field.configured);
  return envSecrets.length + tenSecrets.length;
}
