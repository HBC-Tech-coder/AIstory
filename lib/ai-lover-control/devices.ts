import type {
  AiLoverControlClientOptions,
  AiLoverDeviceHealth,
  AiLoverDevicesSummary,
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

export type AiLoverDeviceName = "head" | "hand" | "live2d-worker" | "local-connector";

export type AiLoverHeadAction =
  | "init"
  | "speak"
  | "stopspeak"
  | "smile"
  | "sad"
  | "kiss"
  | "makeface"
  | "blink"
  | "blink_left"
  | "blink_right"
  | "eyes_rotate"
  | "turn_neck"
  | "servo";

export async function getAiLoverDevicesSummary(
  options?: AiLoverControlClientOptions,
): Promise<AiLoverDevicesSummary> {
  return requestJson<AiLoverDevicesSummary>("/devices/summary", undefined, options);
}

export async function getAiLoverDeviceHealth(
  name: AiLoverDeviceName,
  options?: AiLoverControlClientOptions,
): Promise<AiLoverDeviceHealth> {
  return requestJson<AiLoverDeviceHealth>(`/devices/${encodeURIComponent(name)}/health`, undefined, options);
}

export async function sendAiLoverHeadAction(
  action: AiLoverHeadAction,
  payload: Record<string, unknown> = {},
  options?: AiLoverControlClientOptions,
): Promise<{ ok: boolean; status?: number; response?: string; error?: string }> {
  return requestJson(
    "/devices/head/action",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, payload }),
    },
    options,
  );
}
