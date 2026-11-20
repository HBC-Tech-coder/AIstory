import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { PUBLISHED_STATIC_MEDIA_PATHS } from "./publishedStaticMedia";
import {
  SharedStoriesError,
  type SharedDocumentV1,
  type SharedMediaValidator,
} from "./types";

const MAX_INLINE_BYTES = 1024 * 1024;
const MAX_CACHED_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_STATIC_IMAGE_BYTES = 16 * 1024 * 1024;

/**
 * Default static allow-list: the frozen, already-public first-scene preset
 * catalog. Callers may still inject their own manifest; an empty set denies
 * every static path.
 */
const DEFAULT_STATIC_PATHS: ReadonlySet<string> = new Set(PUBLISHED_STATIC_MEDIA_PATHS);
const CACHED_MEDIA_PREFIX = "/api/aistory-cache/media/";
const CACHED_MEDIA_PATTERN =
  /^\/api\/aistory-cache\/media\/([a-f0-9]{64})\.(png|jpg|jpeg|webp|avif|gif)$/;
const INLINE_MEDIA_PATTERN = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;
const STATIC_PREFIXES = ["/case-studies/", "/home/"] as const;

type ImageKind = "png" | "jpeg" | "webp" | "gif" | "avif";

export class MediaValidationError extends SharedStoriesError {
  constructor(message: string) {
    super("media_invalid", 400, message);
    this.name = "MediaValidationError";
  }
}

export type MediaValidationOptions = {
  /** Defaults to the server-controlled AISTORY_CACHE_DIR/media location. */
  mediaCacheDir?: string;
  /** Defaults to process.cwd()/public. */
  publicDir?: string;
  /**
   * Explicit manifest of safe static paths. Defaults to the frozen published
   * preset catalog; existence alone is never approval. Inject an empty set to
   * deny every static path.
   */
  staticPaths?: ReadonlySet<string>;
};

function reject(message: string): never {
  throw new MediaValidationError(message);
}

/**
 * Mirrors reference/mediaCache.ts MEDIA_CACHE_DIR: the server-controlled
 * AISTORY_CACHE_DIR plus /media, or <cwd>/.aistory-cache/media when unset.
 * Keeping the resolution local avoids importing engine/network modules into
 * the replay domain; tests may inject mediaCacheDir instead.
 */
export function resolveMediaCacheDir(): string {
  const configured = process.env.AISTORY_CACHE_DIR;
  const cacheRoot =
    configured && configured.trim().length > 0
      ? path.resolve(configured)
      : path.join(process.cwd(), ".aistory-cache");
  return path.join(cacheRoot, "media");
}

function normalizedForCompare(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function pathPrefixes(target: string): string[] {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  const rest = resolved.slice(parsed.root.length);
  const parts = rest.split(path.sep).filter((part) => part.length > 0);
  const result: string[] = [];
  let current = parsed.root;
  for (const part of parts) {
    current = path.join(current, part);
    result.push(current);
  }
  return result;
}

async function assertNoSymlinkChain(target: string, unavailableMessage: string): Promise<void> {
  for (const prefix of pathPrefixes(target)) {
    try {
      const info = await lstat(prefix);
      if (info.isSymbolicLink()) reject(unavailableMessage);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      if (error instanceof SharedStoriesError) throw error;
      reject(unavailableMessage);
    }
  }
}

/**
 * Trusted deployment roots (for example the host's public directory) may be
 * Windows junctions; the root itself is accepted only after realpath resolves
 * it to its canonical directory. Every component strictly below that canonical
 * root must still be a real directory/file — a nested link may not escape.
 */
async function assertNoNestedSymlinkComponents(
  canonicalRoot: string,
  target: string,
  unavailableMessage: string,
): Promise<void> {
  const rootKey = normalizedForCompare(canonicalRoot);
  const rootPrefix = rootKey + path.sep;
  for (const prefix of pathPrefixes(target)) {
    const prefixKey = normalizedForCompare(prefix);
    if (prefixKey === rootKey || !prefixKey.startsWith(rootPrefix)) continue;
    try {
      const info = await lstat(prefix);
      if (info.isSymbolicLink()) reject(unavailableMessage);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      if (error instanceof SharedStoriesError) throw error;
      reject(unavailableMessage);
    }
  }
}

async function resolveTrustedDirectory(
  configuredDir: string,
  unavailableMessage: string,
): Promise<string> {
  try {
    const canonicalRoot = await realpath(configuredDir);
    const info = await lstat(canonicalRoot);
    if (!info.isDirectory()) reject(unavailableMessage);
    return canonicalRoot;
  } catch (error) {
    if (error instanceof SharedStoriesError) throw error;
    reject(unavailableMessage);
  }
}

function isPng(bytes: Buffer): boolean {
  return (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  );
}

function isJpeg(bytes: Buffer): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function isWebp(bytes: Buffer): boolean {
  return (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  );
}

function isGif(bytes: Buffer): boolean {
  const header = bytes.length >= 6 ? bytes.toString("ascii", 0, 6) : "";
  return header === "GIF87a" || header === "GIF89a";
}

function isAvif(bytes: Buffer): boolean {
  if (bytes.length < 12 || bytes.toString("ascii", 4, 8) !== "ftyp") return false;
  const brand = bytes.toString("ascii", 8, 12);
  return brand === "avif" || brand === "avis";
}

function bytesMatchKind(bytes: Buffer, kind: ImageKind): boolean {
  switch (kind) {
    case "png":
      return isPng(bytes);
    case "jpeg":
      return isJpeg(bytes);
    case "webp":
      return isWebp(bytes);
    case "gif":
      return isGif(bytes);
    case "avif":
      return isAvif(bytes);
  }
}

function kindForExtension(ext: string): ImageKind | null {
  switch (ext) {
    case ".png":
      return "png";
    case ".jpg":
    case ".jpeg":
      return "jpeg";
    case ".webp":
      return "webp";
    case ".gif":
      return "gif";
    case ".avif":
      return "avif";
    default:
      return null;
  }
}

function validateInlineImage(url: string): void {
  const match = INLINE_MEDIA_PATTERN.exec(url);
  if (!match) {
    if (/^data:image\/svg\+xml(?:;|,)/i.test(url)) {
      reject("SVG scene images are not allowed.");
    }
    reject("Inline scene images must be PNG, JPEG, or WebP data URLs.");
  }
  const declared = match[1];
  const encoded = match[2];
  if (typeof declared !== "string" || typeof encoded !== "string") {
    reject("Inline scene image data is invalid.");
  }
  const kind: ImageKind = declared === "png" ? "png" : declared === "jpeg" ? "jpeg" : "webp";

  let bytes: Buffer;
  try {
    bytes = Buffer.from(encoded, "base64");
  } catch {
    reject("Inline scene image data is invalid.");
  }
  if (bytes.length === 0 || bytes.length > MAX_INLINE_BYTES) {
    reject("Inline scene image data is too large.");
  }
  // Strict canonical base64: reject whitespace, URL-safe alphabet variants,
  // non-canonical padding, and trailing garbage.
  if (bytes.toString("base64") !== encoded) {
    reject("Inline scene image data is invalid.");
  }
  if (!bytesMatchKind(bytes, kind)) {
    reject("Inline scene image bytes do not match their declared type.");
  }
}

async function validateCachedImage(url: string, options: MediaValidationOptions): Promise<void> {
  const match = CACHED_MEDIA_PATTERN.exec(url);
  if (!match) {
    reject("Cached scene image URL is not allowed.");
  }
  const digest = match[1];
  const extensionToken = match[2];
  if (typeof digest !== "string" || typeof extensionToken !== "string") {
    reject("Cached scene image URL is not allowed.");
  }
  const fileName = `${digest}.${extensionToken}`;
  const extension = path.extname(fileName).toLowerCase();
  const kind = kindForExtension(extension);
  if (!kind) reject("Cached scene image type is not allowed.");

  const cacheDir = options.mediaCacheDir ?? resolveMediaCacheDir();
  const target = path.join(cacheDir, fileName);
  const unavailable = "Cached scene image is not accessible.";

  await assertNoSymlinkChain(target, unavailable);
  let info;
  try {
    info = await lstat(target);
  } catch {
    reject(unavailable);
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size === 0) {
    reject(unavailable);
  }
  if (info.size > MAX_CACHED_IMAGE_BYTES) {
    reject(unavailable);
  }

  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = await realpath(cacheDir);
    realTarget = await realpath(target);
  } catch {
    reject(unavailable);
  }
  const rootPrefix = normalizedForCompare(realRoot) + path.sep;
  if (!normalizedForCompare(realTarget).startsWith(rootPrefix)) {
    reject(unavailable);
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(realTarget);
  } catch {
    reject(unavailable);
  }
  if (!bytesMatchKind(bytes, kind)) {
    reject(unavailable);
  }
}

function staticKindForUrl(url: string): { relative: string; kind: ImageKind } {
  const prefix = STATIC_PREFIXES.find((candidate) => url.startsWith(candidate));
  if (!prefix) reject("Static scene image path is not allowed.");
  if (url.includes("%") || url.includes("?") || url.includes("#") || url.includes("\\")) {
    reject("Scene image URL is not allowed.");
  }
  const relative = url.slice(1);
  const parts = relative.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    reject("Scene image URL is not allowed.");
  }
  const extension = path.extname(relative).toLowerCase();
  const kind = kindForExtension(extension);
  if (!kind) {
    if (extension === ".svg") reject("SVG scene images are not allowed.");
    reject("Static scene image type is not allowed.");
  }
  return { relative, kind };
}

async function validateStaticImage(url: string, options: MediaValidationOptions): Promise<void> {
  const allowed = options.staticPaths ?? DEFAULT_STATIC_PATHS;
  if (!allowed.has(url)) {
    reject("Static scene image is not available.");
  }
  const { relative, kind } = staticKindForUrl(url);
  const configuredDir = options.publicDir ?? path.join(process.cwd(), "public");
  const unavailable = "Static scene image is not accessible.";

  // The configured public directory is a trusted deployment root. Resolve it
  // once to its canonical directory so a Windows junction at the root itself is
  // accepted, then require every component below it to be a real entry.
  const canonicalRoot = await resolveTrustedDirectory(configuredDir, unavailable);
  const target = path.join(canonicalRoot, ...relative.split("/"));

  await assertNoNestedSymlinkComponents(canonicalRoot, target, unavailable);
  let info;
  try {
    info = await lstat(target);
  } catch {
    reject(unavailable);
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size === 0) {
    reject(unavailable);
  }
  // Bound memory before reading: never read an oversized candidate.
  if (info.size > MAX_STATIC_IMAGE_BYTES) {
    reject(unavailable);
  }

  let realTarget: string;
  try {
    realTarget = await realpath(target);
  } catch {
    reject(unavailable);
  }
  const rootPrefix = normalizedForCompare(canonicalRoot) + path.sep;
  if (!normalizedForCompare(realTarget).startsWith(rootPrefix)) {
    reject(unavailable);
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(realTarget);
  } catch {
    reject(unavailable);
  }
  if (!bytesMatchKind(bytes, kind)) {
    reject(unavailable);
  }
}

/**
 * Validate a scene image without any network access. Only:
 *  - canonical inline PNG/JPEG/WebP data URLs (<= 1 MiB decoded),
 *  - exact local cache URLs whose bytes exist on disk,
 *  - explicitly allow-listed static raster files under public/.
 */
export async function validateMediaUrl(
  url: string,
  options: MediaValidationOptions = {},
): Promise<void> {
  if (typeof url !== "string" || url.length === 0) {
    reject("Every scene must have an image.");
  }
  if (/^data:/i.test(url)) {
    if (/^data:image\/svg\+xml(?:;|,)/i.test(url)) {
      reject("SVG scene images are not allowed.");
    }
    if (!/^data:image\/(?:png|jpeg|webp);base64,/i.test(url)) {
      reject("Inline scene images must be PNG, JPEG, or WebP.");
    }
    validateInlineImage(url);
    return;
  }
  if (url.startsWith(CACHED_MEDIA_PREFIX)) {
    await validateCachedImage(url, options);
    return;
  }
  if (STATIC_PREFIXES.some((prefix) => url.startsWith(prefix))) {
    await validateStaticImage(url, options);
    return;
  }
  if (/^https?:\/\//i.test(url) || url.startsWith("//")) {
    reject("External scene images are not allowed; cache images locally first.");
  }
  if (/^blob:/i.test(url) || /^file:/i.test(url)) {
    reject("Only cached, inline, or approved local scene images are allowed.");
  }
  if (/\.svg(?:[?#]|$)/i.test(url)) {
    reject("SVG scene images are not allowed.");
  }
  reject("Scene image URL is not allowed.");
}

export function createMediaValidator(
  options: MediaValidationOptions = {},
): SharedMediaValidator {
  return (url: string) => validateMediaUrl(url, options);
}

export async function validateDocumentMedia(
  document: SharedDocumentV1,
  validateMedia: SharedMediaValidator,
): Promise<void> {
  for (const scene of document.scenes) {
    await validateMedia(scene.imageUrl);
  }
}
