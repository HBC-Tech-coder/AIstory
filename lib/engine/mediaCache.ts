import { createHash } from "crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "fs/promises";
import path from "path";

import type { Scene } from "@infiplot/types";
import type { SceneResult } from "./director";

const CACHE_ROOT =
  process.env.AISTORY_CACHE_DIR ||
  path.join(
    /* turbopackIgnore: true */
    process.cwd(),
    ".aistory-cache",
  );
export const MEDIA_CACHE_DIR = path.join(CACHE_ROOT, "media");
const MEDIA_ROUTE_PREFIX = "/api/aistory-cache/media/";

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
};

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function isCachedMediaUrl(value: string): boolean {
  return value.startsWith(MEDIA_ROUTE_PREFIX);
}

function extFromContentType(contentType: string | null): string {
  const type = (contentType ?? "").split(";")[0]?.trim().toLowerCase();
  if (type === "image/jpeg") return ".jpg";
  if (type === "image/png") return ".png";
  if (type === "image/webp") return ".webp";
  if (type === "image/gif") return ".gif";
  if (type === "image/avif") return ".avif";
  if (type === "image/svg+xml") return ".svg";
  if (type === "video/mp4") return ".mp4";
  if (type === "video/quicktime") return ".mov";
  if (type === "video/webm") return ".webm";
  return ".img";
}

function contentTypeFromFile(file: string): string {
  return CONTENT_TYPE_BY_EXT[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

function withImageUrl(scene: Scene, imageUrl: string): Scene {
  return { ...scene, imageUrl };
}

export async function readCachedMedia(file: string): Promise<{ body: Buffer; contentType: string } | null> {
  if (!/^[a-f0-9]{64}\.(?:avif|gif|img|jpe?g|mov|mp4|png|svg|webm|webp)$/i.test(file)) {
    return null;
  }
  const full = path.join(MEDIA_CACHE_DIR, file);
  const resolved = path.resolve(full);
  const root = path.resolve(MEDIA_CACHE_DIR);
  if (!resolved.startsWith(root + path.sep)) return null;
  try {
    return {
      body: await readFile(resolved),
      contentType: contentTypeFromFile(file),
    };
  } catch {
    return null;
  }
}

export async function cacheMediaBytes(
  bytes: Uint8Array,
  contentType: string,
  options: { nonce?: string } = {},
): Promise<{ url: string; file: string }> {
  if (bytes.byteLength === 0) throw new Error("Cannot cache empty media.");
  const buffer = Buffer.from(bytes);
  const file = `${hashText(buffer.toString("base64"))}${extFromContentType(contentType)}`;
  await mkdir(MEDIA_CACHE_DIR, { recursive: true });
  const target = path.join(MEDIA_CACHE_DIR, file);
  const temp = path.join(
    MEDIA_CACHE_DIR,
    `.${file}.${options.nonce || `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`}.tmp`,
  );
  try {
    await writeFile(temp, buffer, { flag: "wx" });
    await rename(temp, target).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST" || error.code === "EPERM") {
        // Content-addressed target already contains the same bytes.
        await unlink(temp).catch(() => undefined);
        return;
      }
      throw error;
    });
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
  return { url: `${MEDIA_ROUTE_PREFIX}${file}`, file };
}

export async function cacheSceneImage<T extends SceneResult>(result: T): Promise<T> {
  const imageUrl = result.sceneImageUrl || result.scene.imageUrl;
  if (!imageUrl || !isHttpUrl(imageUrl) || isCachedMediaUrl(imageUrl)) return result;

  try {
    const response = await fetch(imageUrl);
    if (!response.ok) {
      console.warn(`[media-cache] image fetch failed: HTTP ${response.status}`);
      return result;
    }
    const contentType = response.headers.get("content-type");
    if (contentType && !contentType.toLowerCase().startsWith("image/")) {
      console.warn(`[media-cache] skipped non-image content-type: ${contentType}`);
      return result;
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0) return result;

    const cached = await cacheMediaBytes(bytes, contentType || "application/octet-stream");
    const cachedUrl = cached.url;
    return {
      ...result,
      sceneImageUrl: cachedUrl,
      scene: withImageUrl(result.scene, cachedUrl),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[media-cache] image mirror failed: ${message}`);
    return result;
  }
}

export async function cacheApiResponseImage<T extends { scene: Scene; imageUrl: string }>(
  result: T,
): Promise<T> {
  const mirrored = await cacheSceneImage({
    scene: result.scene,
    sceneImageUrl: result.imageUrl,
    characters: [],
    storyState: { logline: "", genreTags: "", protagonist: "", synopsis: "" },
  });
  if (mirrored.sceneImageUrl === result.imageUrl) return result;
  return {
    ...result,
    imageUrl: mirrored.sceneImageUrl,
    scene: withImageUrl(result.scene, mirrored.sceneImageUrl),
  };
}
