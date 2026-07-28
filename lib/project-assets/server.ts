import "server-only";

import { createHash, randomUUID } from "node:crypto";

import { readCachedMedia } from "@/lib/engine/mediaCache";
import { getStoredGenerationJob } from "@/lib/generation-jobs/store";
import type {
  GenerationJob,
  StoredGenerationJob,
} from "@/lib/generation-jobs/types";

import { saveProjectAssetIfAbsent } from "./repository";
import type {
  AdoptProjectAssetResult,
  ProjectAsset,
  ProjectAssetOrientation,
} from "./types";

const SAFE_MEDIA_URL =
  /^\/api\/aistory-cache\/media\/([a-f0-9]{64}\.(?:avif|jpe?g|mov|mp4|png|webm|webp))$/i;
const SAFE_CONTENT_TYPES = new Set([
  "image/avif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/quicktime",
  "video/webm",
]);

function normalizeContentType(value: string): string {
  return value.split(";")[0]?.trim().toLowerCase() ?? "";
}

function orientationFromJob(job: StoredGenerationJob): ProjectAssetOrientation {
  if (job.provider === "comfyui") {
    if (job.input.orientation) return job.input.orientation;
    if (job.input.width && job.input.height) {
      if (job.input.width === job.input.height) return "square";
      return job.input.width > job.input.height ? "landscape" : "portrait";
    }
    return "unknown";
  }
  if (job.input.aspectRatio === "16:9" || job.input.size === "1344x768") {
    return "landscape";
  }
  if (job.input.aspectRatio === "9:16" || job.input.size === "768x1344") {
    return "portrait";
  }
  if (
    job.input.aspectRatio === "1:1" ||
    job.input.size === "512x512" ||
    job.input.size === "1024x1024"
  ) {
    return "square";
  }
  return "unknown";
}

function seedFromJob(job: StoredGenerationJob): number | undefined {
  return Number.isSafeInteger(job.input.seed) ? job.input.seed : undefined;
}

function workflowFromJob(
  job: StoredGenerationJob,
): ProjectAsset["workflow"] | undefined {
  if (!job.workflowId || !Number.isSafeInteger(job.workflowVersion)) {
    return undefined;
  }
  return { id: job.workflowId, version: job.workflowVersion! };
}

function safeName(job: GenerationJob, hash: string): string {
  const modality = job.modality === "video" ? "视频" : "图片";
  return `AIstory ${modality} ${hash.slice(0, 8)}`;
}

export async function adoptGenerationJobArtifact(
  projectId: number,
  jobId: string,
): Promise<AdoptProjectAssetResult> {
  if (!Number.isSafeInteger(projectId) || projectId <= 0) {
    throw new Error("Invalid project id.");
  }
  if (!/^[0-9a-f-]{20,80}$/i.test(jobId)) {
    throw new Error("Invalid generation job id.");
  }

  const job = await getStoredGenerationJob(jobId);
  if (!job) throw new Error("Generation job not found.");
  if (job.status !== "succeeded") {
    throw new Error("Only successful generation jobs can become project assets.");
  }
  if (!job.artifact) {
    throw new Error("Generation job has no safe mirrored artifact.");
  }
  if (
    job.provider === "localminidrama" &&
    job.input.dramaId !== projectId
  ) {
    throw new Error("LocalMiniDrama job belongs to a different project.");
  }

  const mediaMatch = SAFE_MEDIA_URL.exec(job.artifact.url);
  if (!mediaMatch) {
    throw new Error("Generation artifact is not an AIstory cached media URL.");
  }
  const artifactType = normalizeContentType(job.artifact.contentType);
  if (!SAFE_CONTENT_TYPES.has(artifactType)) {
    throw new Error("Generation artifact MIME type is not allowed.");
  }
  const cached = await readCachedMedia(mediaMatch[1]!);
  if (!cached) throw new Error("Generation artifact is missing from local cache.");
  const cachedType = normalizeContentType(cached.contentType);
  if (
    cachedType !== artifactType ||
    cached.body.byteLength !== job.artifact.bytes
  ) {
    throw new Error("Generation artifact metadata does not match cached media.");
  }

  const contentHash = createHash("sha256").update(cached.body).digest("hex");
  const now = new Date().toISOString();
  const asset: ProjectAsset = {
    id: randomUUID(),
    projectId,
    jobId: job.id,
    provider: job.provider,
    modality: job.modality,
    status: "ready",
    name: safeName(job, contentHash),
    url: job.artifact.url,
    contentHash,
    contentType: cachedType,
    bytes: cached.body.byteLength,
    orientation: orientationFromJob(job),
    workflow: workflowFromJob(job),
    seed: seedFromJob(job),
    provenance: {
      source: "aistory-generation-job",
      requestFingerprint: job.requestFingerprint,
      generationStatus: "succeeded",
    },
    generatedAt: job.completedAt ?? job.updatedAt,
    createdAt: now,
  };
  return saveProjectAssetIfAbsent(asset);
}
