import type { AiPartnerRecord } from "../ai-partner/types";
import type { AiLoverControlClientOptions } from "./types";

const DEFAULT_PLUGIN_BASE_URL = "/api/plugins/aistory-lab";

export interface AiPartnerSnapshotResponse {
  ok: boolean;
  generated_at: string;
  partner: AiPartnerRecord;
  source_counts: {
    models: number;
    avatars: number;
    visible_avatars: number;
    user_characters: number;
    live2d_jobs: number;
  };
  sources: Record<string, string>;
}

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

export async function getAiPartnerSnapshot(
  options?: AiLoverControlClientOptions,
): Promise<AiPartnerSnapshotResponse> {
  return requestJson<AiPartnerSnapshotResponse>("/ai-partner/snapshot", undefined, options);
}
