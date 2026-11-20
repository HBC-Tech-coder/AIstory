import "server-only";

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import JSZip from "jszip";

import {
  validateContainerCodecCombination,
  validateVideoBytes,
} from "@/lib/video-assets/validation";
import type { VideoProbeResult } from "@/lib/video-assets/types";

import { canonicalSha256, parseCanonicalJson } from "./canonical";
import type {
  VideoWorkflowABFileReference,
  VideoWorkflowABOutputReference,
  VideoWorkflowABPackageManifest,
} from "./types";
import {
  assertSafePackagePath,
  validateVideoWorkflowABManifest,
} from "./validation";

const execFileAsync = promisify(execFile);
const ZIP_LOCAL_HEADER = 0x04034b50;
const ZIP_CENTRAL_HEADER = 0x02014b50;
const ZIP_END = 0x06054b50;
const MAX_EOCD_SEARCH = 65_557;
const DEFAULT_MAX_PACKAGE_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_EXPANDED_BYTES = 384 * 1024 * 1024;
export const VIDEO_WORKFLOW_AB_MAX_ENTRIES = 128;

type ZipEntryMetadata = {
  name: string;
  compressedBytes: number;
  uncompressedBytes: number;
  directory: boolean;
};

export type VideoWorkflowABProbeResult = VideoProbeResult & {
  frameCount: number;
  fps: number;
};

export type ValidatedVideoWorkflowABPackage = {
  manifest: VideoWorkflowABPackageManifest;
  files: Map<string, Uint8Array>;
};

export type ValidateVideoWorkflowABPackageOptions = {
  maxPackageBytes?: number;
  maxExpandedBytes?: number;
  maxEntries?: number;
  probeVideo?: (
    bytes: Uint8Array,
    contentType: "video/mp4" | "video/webm",
  ) => Promise<VideoWorkflowABProbeResult>;
};

function boundedBytes(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
}

export function videoWorkflowABMaxPackageBytes(): number {
  return boundedBytes(
    process.env.AISTORY_VIDEO_AB_MAX_PACKAGE_BYTES,
    DEFAULT_MAX_PACKAGE_BYTES,
    1024 * 1024,
    512 * 1024 * 1024,
  );
}

function findEndOfCentralDirectory(bytes: Buffer): number {
  const minimum = Math.max(0, bytes.length - MAX_EOCD_SEARCH);
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (bytes.readUInt32LE(offset) === ZIP_END) return offset;
  }
  throw new Error("A/B return package is not a supported ZIP archive.");
}

export function inspectZipCentralDirectory(
  input: Uint8Array,
  options: { maxEntries?: number; maxExpandedBytes?: number } = {},
): ZipEntryMetadata[] {
  const bytes = Buffer.from(input);
  if (bytes.length < 22 || bytes.readUInt32LE(0) !== ZIP_LOCAL_HEADER) {
    throw new Error("A/B return package is not a supported ZIP archive.");
  }
  const eocd = findEndOfCentralDirectory(bytes);
  const disk = bytes.readUInt16LE(eocd + 4);
  const centralDisk = bytes.readUInt16LE(eocd + 6);
  const diskEntries = bytes.readUInt16LE(eocd + 8);
  const totalEntries = bytes.readUInt16LE(eocd + 10);
  const centralBytes = bytes.readUInt32LE(eocd + 12);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  const maxEntries = options.maxEntries ?? VIDEO_WORKFLOW_AB_MAX_ENTRIES;
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    diskEntries !== totalEntries ||
    totalEntries === 0 ||
    totalEntries === 0xffff ||
    totalEntries > maxEntries ||
    centralOffset === 0xffffffff ||
    centralBytes === 0xffffffff ||
    centralOffset + centralBytes > eocd
  ) {
    throw new Error("A/B return package ZIP structure is unsupported.");
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const entries: ZipEntryMetadata[] = [];
  const names = new Set<string>();
  let expanded = 0;
  let cursor = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (
      cursor + 46 > bytes.length ||
      bytes.readUInt32LE(cursor) !== ZIP_CENTRAL_HEADER
    ) {
      throw new Error("A/B return package ZIP directory is invalid.");
    }
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const compressedBytes = bytes.readUInt32LE(cursor + 20);
    const uncompressedBytes = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const externalAttributes = bytes.readUInt32LE(cursor + 38);
    const nameStart = cursor + 46;
    const next = nameStart + nameLength + extraLength + commentLength;
    if (
      next > bytes.length ||
      nameLength === 0 ||
      compressedBytes === 0xffffffff ||
      uncompressedBytes === 0xffffffff ||
      (flags & 0x1) !== 0 ||
      ![0, 8].includes(method)
    ) {
      throw new Error("A/B return package ZIP entry is unsupported.");
    }
    const rawName = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength));
    const directory = rawName.endsWith("/");
    const name = directory
      ? assertSafePackagePath(rawName.slice(0, -1))
      : assertSafePackagePath(rawName);
    const comparisonName = name.toLowerCase();
    if (names.has(comparisonName)) {
      throw new Error("A/B return package contains a duplicate path.");
    }
    names.add(comparisonName);
    const unixMode = externalAttributes >>> 16;
    if ((unixMode & 0o170000) === 0o120000) {
      throw new Error("A/B return package symbolic links are forbidden.");
    }
    if (!directory) {
      expanded += uncompressedBytes;
      if (
        expanded >
        (options.maxExpandedBytes ?? DEFAULT_MAX_EXPANDED_BYTES)
      ) {
        throw new Error("A/B return package exceeds the expanded size limit.");
      }
    }
    entries.push({
      name,
      compressedBytes,
      uncompressedBytes,
      directory,
    });
    cursor = next;
  }
  if (cursor !== centralOffset + centralBytes) {
    throw new Error("A/B return package ZIP directory length is invalid.");
  }
  return entries;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeFrameContentType(
  bytes: Uint8Array,
  declared: string,
): "image/png" | "image/jpeg" | "image/webp" {
  const isPng =
    bytes.length >= 8 &&
    Buffer.from(bytes.subarray(0, 8)).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  const isJpeg =
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff;
  const isWebp =
    bytes.length >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
    Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP";
  const sniffed = isPng
    ? "image/png"
    : isJpeg
      ? "image/jpeg"
      : isWebp
        ? "image/webp"
        : null;
  if (!sniffed || sniffed !== declared) {
    throw new Error("A/B frame image failed content validation.");
  }
  return sniffed;
}

function parseRate(value: string | undefined): number {
  if (!value) return 0;
  const [left, right] = value.split("/").map(Number);
  if (!Number.isFinite(left) || !Number.isFinite(right) || !right) return 0;
  return left! / right!;
}

export async function probeVideoForABPackage(
  bytes: Uint8Array,
  contentType: "video/mp4" | "video/webm",
): Promise<VideoWorkflowABProbeResult> {
  const executable = process.env.AISTORY_VIDEO_FFPROBE_PATH?.trim();
  if (!executable || !path.isAbsolute(executable)) {
    throw new Error("A/B video probe is not configured.");
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), "aistory-ab-probe-"));
  const file = path.join(
    directory,
    contentType === "video/mp4" ? "input.mp4" : "input.webm",
  );
  try {
    await writeFile(file, bytes, { flag: "wx" });
    const result = await execFileAsync(
      executable,
      [
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_streams",
        "-show_format",
        file,
      ],
      { timeout: 20_000, maxBuffer: 1024 * 1024, windowsHide: true },
    );
    const parsed = JSON.parse(result.stdout) as {
      streams?: Array<{
        codec_type?: string;
        codec_name?: string;
        width?: number;
        height?: number;
        duration?: string;
        nb_frames?: string;
        avg_frame_rate?: string;
      }>;
      format?: { duration?: string };
    };
    const video = parsed.streams?.find((stream) => stream.codec_type === "video");
    const audio = parsed.streams?.find((stream) => stream.codec_type === "audio");
    if (!video?.codec_name) throw new Error("A/B video probe found no video track.");
    const durationMs = Math.round(
      Number(video.duration ?? parsed.format?.duration ?? 0) * 1000,
    );
    const fps = parseRate(video.avg_frame_rate);
    const frameCount = Number(video.nb_frames) || Math.round((durationMs / 1000) * fps);
    const checked = validateContainerCodecCombination(contentType, {
      durationMs,
      width: Number(video.width),
      height: Number(video.height),
      videoCodec: video.codec_name,
      ...(audio?.codec_name ? { audioCodec: audio.codec_name } : {}),
      hasAudio: !!audio,
    });
    return { ...checked, frameCount, fps };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function compareProbe(
  actual: VideoWorkflowABProbeResult,
  declared: VideoWorkflowABOutputReference,
): void {
  if (
    actual.width !== declared.width ||
    actual.height !== declared.height ||
    actual.frameCount !== declared.frameCount ||
    Math.abs(actual.fps - declared.fps) > 0.001 ||
    Math.abs(actual.durationMs - declared.durationMs) >
      Math.max(50, Math.ceil(1000 / declared.fps)) ||
    actual.videoCodec !== declared.videoCodec ||
    (actual.audioCodec ?? "") !== (declared.audioCodec ?? "") ||
    actual.hasAudio !== declared.hasAudio
  ) {
    throw new Error("A/B video probe metadata does not match the manifest.");
  }
}

function assertReference(
  reference: VideoWorkflowABFileReference,
  files: Map<string, Uint8Array>,
): Uint8Array {
  const bytes = files.get(reference.path);
  if (
    !bytes ||
    bytes.byteLength !== reference.bytes ||
    sha256(bytes) !== reference.sha256
  ) {
    throw new Error("A/B package file failed integrity validation.");
  }
  return bytes;
}

function declaredPackageFiles(
  manifest: VideoWorkflowABPackageManifest,
): Set<string> {
  const paths = new Set<string>(["ab-manifest.json"]);
  for (const variant of manifest.variants) paths.add(variant.workflowPath);
  for (const run of manifest.runs) {
    if (run.output) paths.add(run.output.path);
    if (run.firstFrame) paths.add(run.firstFrame.path);
    if (run.lastFrame) paths.add(run.lastFrame.path);
  }
  for (const layer of manifest.postprocessLayers ?? []) {
    paths.add(layer.output.path);
  }
  return paths;
}

export async function validateVideoWorkflowABPackage(
  input: Uint8Array,
  options: ValidateVideoWorkflowABPackageOptions = {},
): Promise<ValidatedVideoWorkflowABPackage> {
  const maxPackageBytes =
    options.maxPackageBytes ?? videoWorkflowABMaxPackageBytes();
  if (input.byteLength === 0 || input.byteLength > maxPackageBytes) {
    throw new Error("A/B return package exceeds the upload size limit.");
  }
  const metadata = inspectZipCentralDirectory(input, {
    maxEntries: options.maxEntries,
    maxExpandedBytes: options.maxExpandedBytes,
  });
  const archive = await JSZip.loadAsync(input, {
    checkCRC32: true,
    createFolders: false,
  });
  const files = new Map<string, Uint8Array>();
  for (const entry of metadata) {
    if (entry.directory) continue;
    const archived = archive.file(entry.name);
    if (!archived) throw new Error("A/B return package ZIP entry is missing.");
    const bytes = await archived.async("uint8array");
    if (bytes.byteLength !== entry.uncompressedBytes) {
      throw new Error("A/B return package ZIP size is inconsistent.");
    }
    files.set(entry.name, bytes);
  }
  const manifestBytes = files.get("ab-manifest.json");
  if (!manifestBytes) throw new Error("A/B return package manifest is missing.");
  const manifest = validateVideoWorkflowABManifest(
    parseCanonicalJson(manifestBytes),
  );
  const declared = declaredPackageFiles(manifest);
  const actual = new Set(files.keys());
  if (
    declared.size !== actual.size ||
    [...actual].some((file) => !declared.has(file))
  ) {
    throw new Error("A/B return package contains undeclared files.");
  }

  for (const variant of manifest.variants) {
    const workflowBytes = files.get(variant.workflowPath);
    if (!workflowBytes) throw new Error("A/B workflow file is missing.");
    const workflow = parseCanonicalJson(workflowBytes);
    if (canonicalSha256(workflow) !== variant.workflowSha256) {
      throw new Error("A/B workflow canonical hash does not match.");
    }
  }
  const probeVideo = options.probeVideo ?? probeVideoForABPackage;
  for (const run of manifest.runs) {
    if (!run.output || !run.firstFrame || !run.lastFrame) continue;
    const output = assertReference(run.output, files);
    if (run.output.contentType !== "video/mp4" && run.output.contentType !== "video/webm") {
      throw new Error("A/B output video MIME is unsupported.");
    }
    const checked = validateVideoBytes(
      output,
      run.output.contentType,
      Math.min(maxPackageBytes, 512 * 1024 * 1024),
    );
    if (checked.contentHash !== run.output.sha256) {
      throw new Error("A/B output video hash does not match.");
    }
    compareProbe(await probeVideo(output, checked.contentType), run.output);
    safeFrameContentType(
      assertReference(run.firstFrame, files),
      run.firstFrame.contentType,
    );
    safeFrameContentType(
      assertReference(run.lastFrame, files),
      run.lastFrame.contentType,
    );
  }
  for (const layer of manifest.postprocessLayers ?? []) {
    const output = assertReference(layer.output, files);
    if (
      layer.output.contentType !== "video/mp4" &&
      layer.output.contentType !== "video/webm"
    ) {
      throw new Error("A/B postprocess video MIME is unsupported.");
    }
    const checked = validateVideoBytes(
      output,
      layer.output.contentType,
      Math.min(maxPackageBytes, 512 * 1024 * 1024),
    );
    compareProbe(await probeVideo(output, checked.contentType), layer.output);
  }
  return { manifest, files };
}
