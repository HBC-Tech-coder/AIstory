import "server-only";

import { randomUUID } from "node:crypto";

import { cacheMediaBytes } from "@/lib/engine/mediaCache";
import type { ComfyUIProviderConfig } from "./types";

const DEFAULT_MAX_OUTPUT_BYTES = 128 * 1024 * 1024;
const ALLOWED_OUTPUT_TYPES = new Set(["output", "temp", "input"]);
const ALLOWED_MEDIA_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/quicktime",
  "video/webm",
]);
const ALLOWED_UPLOAD_TYPES = new Set([
  "image/avif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export type ComfyUIHistoryOutput = {
  filename: string;
  subfolder: string;
  type: "output" | "temp" | "input";
  mediaKind: "image" | "video";
  nodeId: string;
};

export type ComfyUIHistoryResult = {
  promptId: string;
  state: "queued" | "running" | "succeeded" | "failed";
  outputs: ComfyUIHistoryOutput[];
  errorCode?: string;
};

type RetryOptions = {
  attempts?: number;
  maxDelayMs?: number;
  wait?: (delayMs: number) => Promise<void>;
  retryMode?: "rate_limit_and_5xx" | "rate_limit_only" | "none";
};

const defaultWait = (delayMs: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, delayMs));

function retryDelay(response: Response, attempt: number, maxDelayMs: number) {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(maxDelayMs, seconds * 1_000);
    }
    const timestamp = Date.parse(retryAfter);
    if (Number.isFinite(timestamp)) {
      return Math.min(maxDelayMs, Math.max(0, timestamp - Date.now()));
    }
  }
  return Math.min(maxDelayMs, 500 * 2 ** attempt);
}

export async function requestComfyUI(
  config: ComfyUIProviderConfig,
  path: string,
  init: RequestInit,
  fetcher: typeof fetch,
  options: RetryOptions = {},
): Promise<Response> {
  const attempts = Math.max(1, Math.min(4, options.attempts ?? 3));
  const maxDelayMs = Math.max(0, Math.min(30_000, options.maxDelayMs ?? 8_000));
  const wait = options.wait ?? defaultWait;
  let response: Response | undefined;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    response = await fetcher(`${config.baseUrl}${path}`, {
      ...init,
      cache: "no-store",
      redirect: "error",
    });
    const retryMode = options.retryMode ?? "rate_limit_and_5xx";
    const retriable = retryMode !== "none" && (
      response.status === 429 ||
      (retryMode === "rate_limit_and_5xx" && response.status >= 500)
    );
    if (!retriable || attempt === attempts - 1) return response;
    await wait(retryDelay(response, attempt, maxDelayMs));
  }
  return response!;
}

function safeName(value: string, label: string): string {
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed.length > 240 ||
    trimmed === "." ||
    trimmed === ".." ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("\0") ||
    /^[a-z]+:/i.test(trimmed)
  ) {
    throw new Error(`Unsafe ComfyUI ${label}.`);
  }
  return trimmed;
}

function safeSubfolder(value: string | undefined): string {
  const trimmed = (value ?? "").trim().replaceAll("\\", "/");
  if (!trimmed) return "";
  const segments = trimmed.split("/");
  if (
    trimmed.startsWith("/") ||
    /^[a-z]+:/i.test(trimmed) ||
    segments.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        part.includes("\0") ||
        part.length > 100,
    )
  ) {
    throw new Error("Unsafe ComfyUI output subfolder.");
  }
  return segments.join("/");
}

function safeOutput(
  value: unknown,
  nodeId: string,
  mediaKind: "image" | "video",
): ComfyUIHistoryOutput | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as {
    filename?: unknown;
    subfolder?: unknown;
    type?: unknown;
  };
  if (
    typeof item.filename !== "string" ||
    (item.subfolder !== undefined && typeof item.subfolder !== "string") ||
    typeof item.type !== "string" ||
    !ALLOWED_OUTPUT_TYPES.has(item.type)
  ) {
    return undefined;
  }
  try {
    return {
      filename: safeName(item.filename, "output filename"),
      subfolder: safeSubfolder(item.subfolder),
      type: item.type as ComfyUIHistoryOutput["type"],
      mediaKind,
      nodeId,
    };
  } catch {
    return undefined;
  }
}

export async function uploadComfyUIImage(
  config: ComfyUIProviderConfig,
  input: {
    bytes: Uint8Array;
    filename: string;
    mimeType: string;
    subfolder?: string;
    overwrite?: boolean;
  },
  fetcher: typeof fetch = fetch,
  retry: RetryOptions = {},
): Promise<{ name: string; subfolder: string; type: string }> {
  if (!ALLOWED_UPLOAD_TYPES.has(input.mimeType.toLowerCase())) {
    throw new Error("ComfyUI reference upload only accepts safe raster images.");
  }
  if (input.bytes.byteLength === 0 || input.bytes.byteLength > 20 * 1024 * 1024) {
    throw new Error("ComfyUI reference image must be between 1 byte and 20 MB.");
  }
  const filename = safeName(input.filename, "upload filename");
  const subfolder = safeSubfolder(input.subfolder);
  const uploadBuffer = new ArrayBuffer(input.bytes.byteLength);
  new Uint8Array(uploadBuffer).set(input.bytes);
  const form = new FormData();
  form.set(
    "image",
    new File([uploadBuffer], filename, { type: input.mimeType }),
  );
  if (subfolder) form.set("subfolder", subfolder);
  form.set("type", "input");
  form.set("overwrite", input.overwrite ? "true" : "false");
  const response = await requestComfyUI(
    config,
    "/upload/image",
    { method: "POST", body: form },
    fetcher,
    retry,
  );
  if (!response.ok) {
    throw new Error(`ComfyUI image upload rejected: HTTP ${response.status}`);
  }
  const payload = (await response.json()) as {
    name?: string;
    subfolder?: string;
    type?: string;
  };
  return {
    name: safeName(payload.name || filename, "uploaded filename"),
    subfolder: safeSubfolder(payload.subfolder),
    type: payload.type === "input" ? "input" : "input",
  };
}

export async function getComfyUIHistory(
  config: ComfyUIProviderConfig,
  promptId: string,
  fetcher: typeof fetch = fetch,
): Promise<ComfyUIHistoryResult> {
  const id = encodeURIComponent(safeName(promptId, "prompt id"));
  const response = await requestComfyUI(
    config,
    `/history/${id}`,
    { method: "GET" },
    fetcher,
    { attempts: 2 },
  );
  if (!response.ok) {
    throw new Error(`ComfyUI history unavailable: HTTP ${response.status}`);
  }
  const payload = (await response.json()) as Record<
    string,
    {
      outputs?: Record<
        string,
        { images?: unknown[]; gifs?: unknown[]; videos?: unknown[] }
      >;
      status?: {
        completed?: boolean;
        status_str?: string;
        messages?: unknown[];
      };
    }
  >;
  const record = payload[promptId];
  if (!record) {
    return { promptId, state: "queued", outputs: [] };
  }
  const outputs: ComfyUIHistoryOutput[] = [];
  for (const [nodeId, node] of Object.entries(record.outputs ?? {})) {
    for (const value of node.images ?? []) {
      const output = safeOutput(value, nodeId, "image");
      if (output) outputs.push(output);
    }
    for (const value of [...(node.gifs ?? []), ...(node.videos ?? [])]) {
      const output = safeOutput(value, nodeId, "video");
      if (output) outputs.push(output);
    }
  }
  const status = record.status?.status_str?.toLowerCase();
  const failed = status === "error" || status === "failed";
  return {
    promptId,
    state: failed
      ? "failed"
      : record.status?.completed || outputs.length > 0
        ? "succeeded"
        : "running",
    outputs,
    errorCode: failed ? "comfyui_execution_failed" : undefined,
  };
}

export async function getComfyUIQueue(
  config: ComfyUIProviderConfig,
  fetcher: typeof fetch = fetch,
): Promise<{ running: string[]; pending: string[] }> {
  const response = await requestComfyUI(
    config,
    "/queue",
    { method: "GET" },
    fetcher,
    { attempts: 2 },
  );
  if (!response.ok) {
    throw new Error(`ComfyUI queue unavailable: HTTP ${response.status}`);
  }
  const payload = (await response.json()) as {
    queue_running?: unknown[][];
    queue_pending?: unknown[][];
  };
  const ids = (rows: unknown[][] | undefined) =>
    (rows ?? [])
      .map((row) => (Array.isArray(row) ? row[1] : undefined))
      .filter((value): value is string => typeof value === "string");
  return {
    running: ids(payload.queue_running),
    pending: ids(payload.queue_pending),
  };
}

export async function cancelComfyUIJob(
  config: ComfyUIProviderConfig,
  promptId: string,
  ownership: { runningPromptId?: string },
  fetcher: typeof fetch = fetch,
): Promise<"deleted" | "interrupted" | "not_found"> {
  const id = safeName(promptId, "prompt id");
  const queue = await getComfyUIQueue(config, fetcher);
  if (queue.pending.includes(id)) {
    const response = await requestComfyUI(
      config,
      "/queue",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ delete: [id] }),
      },
      fetcher,
      { attempts: 2 },
    );
    if (!response.ok) {
      throw new Error(`ComfyUI queue cancellation failed: HTTP ${response.status}`);
    }
    return "deleted";
  }
  if (queue.running.includes(id) && ownership.runningPromptId === id) {
    const response = await requestComfyUI(
      config,
      "/interrupt",
      { method: "POST" },
      fetcher,
      { attempts: 1 },
    );
    if (!response.ok) {
      throw new Error(`ComfyUI interrupt failed: HTTP ${response.status}`);
    }
    return "interrupted";
  }
  return "not_found";
}

export async function mirrorComfyUIHistoryOutput(
  config: ComfyUIProviderConfig,
  output: ComfyUIHistoryOutput,
  fetcher: typeof fetch = fetch,
): Promise<{ url: string; contentType: string; bytes: number }> {
  const search = new URLSearchParams({
    filename: safeName(output.filename, "output filename"),
    subfolder: safeSubfolder(output.subfolder),
    type: output.type,
  });
  const response = await requestComfyUI(
    config,
    `/view?${search.toString()}`,
    { method: "GET" },
    fetcher,
    { attempts: 3 },
  );
  if (!response.ok) {
    throw new Error(`ComfyUI output unavailable: HTTP ${response.status}`);
  }
  const contentType = (response.headers.get("content-type") || "")
    .split(";")[0]!
    .trim()
    .toLowerCase();
  if (!ALLOWED_MEDIA_TYPES.has(contentType)) {
    throw new Error("ComfyUI output MIME type is not allowed.");
  }
  const maxBytes = Math.max(
    1,
    Number(process.env.COMFYUI_MAX_OUTPUT_BYTES) || DEFAULT_MAX_OUTPUT_BYTES,
  );
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error("ComfyUI output exceeds the configured size limit.");
  }
  if (!response.body) throw new Error("ComfyUI output body is missing.");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel("media-size-limit").catch(() => undefined);
      throw new Error("ComfyUI output exceeds the configured size limit.");
    }
    chunks.push(Buffer.from(value));
  }
  const bytes = Buffer.concat(chunks, total);
  if (bytes.length === 0) {
    throw new Error("ComfyUI output is empty or exceeds the configured size limit.");
  }
  const cached = await cacheMediaBytes(bytes, contentType, {
    nonce: randomUUID(),
  });
  return { url: cached.url, contentType, bytes: bytes.length };
}
