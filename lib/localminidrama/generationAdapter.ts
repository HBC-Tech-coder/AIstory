import "server-only";

import { isLoopbackServiceUrl } from "@/lib/creator-studio/capabilities";
import type { LocalMiniDramaImageJobInput } from "@/lib/generation-jobs/types";
import { cacheMediaBytes } from "@/lib/engine/mediaCache";
import { getLocalMiniDramaConfig } from "./server";

type LocalMiniDramaEnvelope<T> = {
  success?: boolean;
  data?: T;
  error?: { code?: string };
};

export type LocalMiniDramaGenerationTask = {
  taskId: string;
  status: "queued";
};

export type LocalMiniDramaGenerationTaskStatus = {
  taskId: string;
  status: "queued" | "running" | "succeeded" | "failed";
  progress: number;
  imageUrl?: string;
  errorCode?: string;
};

const SAFE_IMAGE_TYPES = new Set([
  "image/avif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const DEFAULT_MAX_IMAGE_BYTES = 32 * 1024 * 1024;

function positiveId(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

function safeText(
  value: string | undefined,
  label: string,
  max: number,
  required = false,
): string | undefined {
  const normalized = value?.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (required && !normalized) throw new Error(`${label} is required.`);
  if (normalized && normalized.length > max) {
    throw new Error(`${label} is too long.`);
  }
  return normalized || undefined;
}

function safeResultUrl(value: unknown, backendUrl: string): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value, `${backendUrl}/`);
    if (!isLoopbackServiceUrl(url.origin)) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

async function readEnvelope<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as LocalMiniDramaEnvelope<T> | T;
  const envelope = payload as LocalMiniDramaEnvelope<T>;
  if (!response.ok || envelope.success === false) {
    throw new Error(`LocalMiniDrama request failed: HTTP ${response.status}`);
  }
  return envelope && "data" in envelope ? envelope.data as T : payload as T;
}

function checkedBaseUrl(): string {
  const { backendUrl, frontendUrl } = getLocalMiniDramaConfig();
  if (
    !isLoopbackServiceUrl(backendUrl) ||
    !isLoopbackServiceUrl(frontendUrl)
  ) {
    throw new Error("LocalMiniDrama generation is restricted to loopback services.");
  }
  return backendUrl;
}

export async function submitLocalMiniDramaImage(
  input: LocalMiniDramaImageJobInput,
  fetcher: typeof fetch = fetch,
): Promise<LocalMiniDramaGenerationTask> {
  const backendUrl = checkedBaseUrl();
  const dramaId = positiveId(input.dramaId, "dramaId")!;
  const storyboardId = positiveId(input.storyboardId, "storyboardId");
  const sceneId = positiveId(input.sceneId, "sceneId");
  const prompt = safeText(input.prompt, "prompt", 4_000, true)!;
  const negativePrompt = safeText(
    input.negativePrompt,
    "negativePrompt",
    1_000,
  );
  const style = safeText(input.style, "style", 160);
  if (
    input.seed !== undefined &&
    (!Number.isSafeInteger(input.seed) || input.seed < 0)
  ) {
    throw new Error("seed must be a non-negative safe integer.");
  }
  if (
    input.frameType !== undefined &&
    !["first", "last", "keyframe", "storyboard"].includes(input.frameType)
  ) throw new Error("Unsupported frameType.");
  if (
    input.size !== undefined &&
    !["512x512", "768x1344", "1024x1024", "1344x768"].includes(input.size)
  ) throw new Error("Unsupported image size.");
  if (
    input.aspectRatio !== undefined &&
    !["1:1", "16:9", "9:16"].includes(input.aspectRatio)
  ) throw new Error("Unsupported aspect ratio.");
  const response = await fetcher(`${backendUrl}/api/v1/images`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      drama_id: dramaId,
      ...(storyboardId ? { storyboard_id: storyboardId } : {}),
      ...(sceneId ? { scene_id: sceneId } : {}),
      prompt,
      ...(negativePrompt ? { negative_prompt: negativePrompt } : {}),
      ...(input.frameType ? { frame_type: input.frameType } : {}),
      ...(input.size ? { size: input.size } : {}),
      ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio } : {}),
      ...(style ? { style } : {}),
      ...(input.seed !== undefined ? { seed: input.seed } : {}),
    }),
    cache: "no-store",
    redirect: "error",
  });
  // POST is intentionally not retried on 5xx: donor has no idempotency key.
  const created = await readEnvelope<{
    task_id?: string | number;
    status?: string;
  }>(response);
  if (created.task_id === undefined || created.task_id === null) {
    throw new Error("LocalMiniDrama did not return task_id.");
  }
  return { taskId: String(created.task_id), status: "queued" };
}

export async function getLocalMiniDramaGenerationTask(
  taskId: string,
  fetcher: typeof fetch = fetch,
): Promise<LocalMiniDramaGenerationTaskStatus> {
  const backendUrl = checkedBaseUrl();
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(taskId)) {
    throw new Error("Invalid LocalMiniDrama task id.");
  }
  const response = await fetcher(
    `${backendUrl}/api/v1/tasks/${encodeURIComponent(taskId)}`,
    { method: "GET", cache: "no-store", redirect: "error" },
  );
  const task = await readEnvelope<{
    id?: string | number;
    status?: string;
    progress?: number;
    error?: { code?: string } | string;
    result?: {
      image_url?: unknown;
      status?: string;
    };
  }>(response);
  const rawStatus = String(task.status || task.result?.status || "").toLowerCase();
  const status =
    rawStatus === "completed" || rawStatus === "succeeded" || rawStatus === "success"
      ? "succeeded"
      : rawStatus === "failed" || rawStatus === "error"
        ? "failed"
        : rawStatus === "processing" || rawStatus === "running"
          ? "running"
          : "queued";
  return {
    taskId,
    status,
    progress: Math.max(0, Math.min(100, Number(task.progress) || 0)),
    imageUrl:
      status === "succeeded"
        ? safeResultUrl(task.result?.image_url, backendUrl)
        : undefined,
    errorCode: status === "failed" ? "localminidrama_generation_failed" : undefined,
  };
}

export async function mirrorLocalMiniDramaImage(
  imageUrl: string,
  fetcher: typeof fetch = fetch,
): Promise<{ url: string; contentType: string; bytes: number }> {
  const backendUrl = checkedBaseUrl();
  const safeUrl = safeResultUrl(imageUrl, backendUrl);
  if (!safeUrl) throw new Error("LocalMiniDrama artifact URL is not a safe loopback URL.");
  const response = await fetcher(safeUrl, {
    method: "GET",
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`LocalMiniDrama artifact fetch failed: HTTP ${response.status}`);
  }
  const contentType = (response.headers.get("content-type") || "")
    .split(";")[0]!
    .trim()
    .toLowerCase();
  if (!SAFE_IMAGE_TYPES.has(contentType)) {
    throw new Error("LocalMiniDrama artifact MIME type is not allowed.");
  }
  const maxBytes = Math.max(
    1,
    Number(process.env.LOCAL_MINIDRAMA_MAX_IMAGE_BYTES) ||
      DEFAULT_MAX_IMAGE_BYTES,
  );
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error("LocalMiniDrama artifact exceeds the size limit.");
  }
  if (!response.body) throw new Error("LocalMiniDrama artifact body is missing.");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel("media-size-limit").catch(() => undefined);
      throw new Error("LocalMiniDrama artifact exceeds the size limit.");
    }
    chunks.push(Buffer.from(value));
  }
  if (total === 0) throw new Error("LocalMiniDrama artifact is empty.");
  const bytes = Buffer.concat(chunks, total);
  const cached = await cacheMediaBytes(bytes, contentType);
  return { url: cached.url, contentType, bytes: total };
}
