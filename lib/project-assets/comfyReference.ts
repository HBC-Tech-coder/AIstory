import "server-only";

import { createHash } from "node:crypto";

import { readCachedMedia } from "@/lib/engine/mediaCache";
import {
  discoverComfyUIProviderStatus,
  getComfyUIProviderConfig,
} from "@/lib/providers/comfyui/server";
import { uploadComfyUIImage } from "@/lib/providers/comfyui/transport";

import { getProjectAsset } from "./repository";

const SAFE_IMAGE_URL =
  /^\/api\/aistory-cache\/media\/([a-f0-9]{64}\.(?:avif|jpe?g|png|webp))$/i;
const EXTENSION_BY_TYPE: Record<string, string> = {
  "image/avif": ".avif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

export type ProjectAssetComfyReference = {
  assetId: string;
  name: string;
  subfolder: string;
  type: "input";
  contentHash: string;
  referenceRevision: string;
};

declare global {
  var __aistoryProjectAssetReferences:
    | Map<string, ProjectAssetComfyReference>
    | undefined;
  var __aistoryProjectAssetReferenceFlights:
    | Map<string, Promise<ProjectAssetComfyReference>>
    | undefined;
}

function referenceCache(): Map<string, ProjectAssetComfyReference> {
  globalThis.__aistoryProjectAssetReferences ??= new Map();
  return globalThis.__aistoryProjectAssetReferences;
}

function referenceFlights(): Map<string, Promise<ProjectAssetComfyReference>> {
  globalThis.__aistoryProjectAssetReferenceFlights ??= new Map();
  return globalThis.__aistoryProjectAssetReferenceFlights;
}

function contentType(value: string): string {
  return value.split(";")[0]?.trim().toLowerCase() ?? "";
}

export async function prepareProjectAssetComfyReference(
  projectId: number,
  assetId: string,
  fetcher: typeof fetch = fetch,
): Promise<ProjectAssetComfyReference> {
  if (!Number.isSafeInteger(projectId) || projectId <= 0) {
    throw new Error("Invalid project id.");
  }
  if (!/^[0-9a-f-]{20,80}$/i.test(assetId)) {
    throw new Error("Invalid project asset id.");
  }
  const asset = await getProjectAsset(projectId, assetId);
  if (!asset) throw new Error("Project asset not found in this project.");
  if (asset.modality !== "image") {
    throw new Error("Only image assets can be used as image references.");
  }
  const extension = EXTENSION_BY_TYPE[contentType(asset.contentType)];
  if (!extension) throw new Error("Project asset MIME type is not allowed.");
  const mediaMatch = SAFE_IMAGE_URL.exec(asset.url);
  if (!mediaMatch) throw new Error("Project asset URL is not a safe cached image.");

  const cached = await readCachedMedia(mediaMatch[1]!);
  if (!cached) throw new Error("Project asset cache entry is missing.");
  const actualType = contentType(cached.contentType);
  const actualHash = createHash("sha256").update(cached.body).digest("hex");
  if (
    actualType !== contentType(asset.contentType) ||
    cached.body.byteLength !== asset.bytes ||
    actualHash !== asset.contentHash
  ) {
    throw new Error("Project asset cache integrity check failed.");
  }

  const status = await discoverComfyUIProviderStatus(fetcher);
  if (status.state !== "ready" || !status.modalities.image) {
    throw new Error("ComfyUI image provider is not ready.");
  }

  const key = `${projectId}:${asset.id}:${asset.contentHash}`;
  const existing = referenceCache().get(key);
  if (existing) return structuredClone(existing);
  const running = referenceFlights().get(key);
  if (running) return running;

  const upload = (async () => {
    const uploaded = await uploadComfyUIImage(
      getComfyUIProviderConfig(),
      {
        bytes: cached.body,
        filename: `${asset.id}${extension}`,
        mimeType: actualType,
        subfolder: "aistory",
        overwrite: true,
      },
      fetcher,
      { retryMode: "rate_limit_only" },
    );
    const reference: ProjectAssetComfyReference = {
      assetId: asset.id,
      name: uploaded.name,
      subfolder: uploaded.subfolder,
      type: "input",
      contentHash: asset.contentHash,
      referenceRevision: `project-asset:v1:${asset.id}:${asset.contentHash}`,
    };
    referenceCache().set(key, reference);
    return structuredClone(reference);
  })();
  referenceFlights().set(key, upload);
  try {
    return await upload;
  } finally {
    if (referenceFlights().get(key) === upload) referenceFlights().delete(key);
  }
}
