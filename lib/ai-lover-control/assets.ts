import type {
  AiLoverAvatarRegistryResponse,
  AiLoverCharactersResponse,
  AiLoverControlClientOptions,
  AiLoverLive2DJobsResponse,
  AiLoverModelsResponse,
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

export async function getAiLoverModels(
  options?: AiLoverControlClientOptions,
): Promise<AiLoverModelsResponse> {
  return requestJson<AiLoverModelsResponse>("/ai-lover/models", undefined, options);
}

export async function getAiLoverAvatarRegistry(
  options?: AiLoverControlClientOptions,
): Promise<AiLoverAvatarRegistryResponse> {
  return requestJson<AiLoverAvatarRegistryResponse>("/ai-lover/avatars", undefined, options);
}

export async function getAiLoverCharacters(
  options?: AiLoverControlClientOptions,
): Promise<AiLoverCharactersResponse> {
  return requestJson<AiLoverCharactersResponse>("/ai-lover/characters", undefined, options);
}

export async function getAiLoverLive2DJobs(
  options?: AiLoverControlClientOptions,
): Promise<AiLoverLive2DJobsResponse> {
  return requestJson<AiLoverLive2DJobsResponse>("/ai-lover/live2d/jobs", undefined, options);
}
