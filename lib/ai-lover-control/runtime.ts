import type {
  AiLoverActionResult,
  AiLoverAgentHealth,
  AiLoverControlClientOptions,
  AiLoverLogs,
  AiLoverRuntimeStatus,
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

export async function getAiLoverRuntimeStatus(
  options?: AiLoverControlClientOptions,
): Promise<AiLoverRuntimeStatus> {
  return requestJson<AiLoverRuntimeStatus>("/ai-lover/status", undefined, options);
}

export async function startAiLoverRuntime(
  options?: AiLoverControlClientOptions,
): Promise<AiLoverActionResult> {
  return requestJson<AiLoverActionResult>("/ai-lover/start", { method: "POST" }, options);
}

export async function stopAiLoverRuntime(
  options?: AiLoverControlClientOptions,
): Promise<AiLoverActionResult> {
  return requestJson<AiLoverActionResult>("/ai-lover/stop", { method: "POST" }, options);
}

export async function getAiLoverAgentHealth(
  options?: AiLoverControlClientOptions,
): Promise<AiLoverAgentHealth> {
  return requestJson<AiLoverAgentHealth>("/ai-lover/agent/health", undefined, options);
}

export async function getAiLoverLogs(
  service = "frontend",
  tail = 180,
  options?: AiLoverControlClientOptions,
): Promise<AiLoverLogs> {
  const params = new URLSearchParams({ service, tail: String(tail) });
  return requestJson<AiLoverLogs>(`/ai-lover/logs?${params}`, undefined, options);
}

export function deriveRuntimeStatusName(status: AiLoverRuntimeStatus | null | undefined) {
  if (!status) return "idle";
  if (status.ok) return "running";
  if (status.listeners?.length) return "error";
  return "offline";
}
