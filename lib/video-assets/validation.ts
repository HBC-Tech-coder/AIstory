import { createHash } from "node:crypto";

import type {
  VideoProbeResult,
  VideoSubtitleCue,
} from "./types";

export const SAFE_VIDEO_MIME_TYPES = [
  "video/mp4",
  "video/webm",
] as const;

const SAFE_VIDEO_CODECS = new Set(["h264", "vp8", "vp9", "av1"]);
const SAFE_AUDIO_CODECS = new Set(["aac", "opus", "vorbis"]);

export function sniffVideoContainer(
  bytes: Uint8Array,
): "video/mp4" | "video/webm" | null {
  if (
    bytes.length >= 12 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  ) {
    return "video/mp4";
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  ) {
    return "video/webm";
  }
  return null;
}

export function validateVideoBytes(
  bytes: Uint8Array,
  declaredType: string,
  maxBytes: number,
): { contentType: "video/mp4" | "video/webm"; contentHash: string } {
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
    throw new Error("视频为空或超过上传大小限制。");
  }
  const sniffed = sniffVideoContainer(bytes);
  if (!sniffed || !SAFE_VIDEO_MIME_TYPES.includes(declaredType as never)) {
    throw new Error("只支持通过内容校验的 MP4 或 WebM 视频。");
  }
  if (sniffed !== declaredType) {
    throw new Error("视频 MIME 与文件内容不一致。");
  }
  return {
    contentType: sniffed,
    contentHash: createHash("sha256").update(bytes).digest("hex"),
  };
}

export function validateVideoProbe(
  probe: VideoProbeResult,
): VideoProbeResult {
  if (
    !Number.isFinite(probe.durationMs) ||
    probe.durationMs < 100 ||
    probe.durationMs > 2 * 60 * 60 * 1000
  ) {
    throw new Error("视频时长不在允许范围内。");
  }
  if (
    !Number.isSafeInteger(probe.width) ||
    !Number.isSafeInteger(probe.height) ||
    probe.width < 64 ||
    probe.height < 64 ||
    probe.width > 7680 ||
    probe.height > 7680
  ) {
    throw new Error("视频分辨率不在允许范围内。");
  }
  const videoCodec = probe.videoCodec.trim().toLowerCase();
  const audioCodec = probe.audioCodec?.trim().toLowerCase();
  if (!SAFE_VIDEO_CODECS.has(videoCodec)) {
    throw new Error("视频编码暂不受支持。");
  }
  if (audioCodec && !SAFE_AUDIO_CODECS.has(audioCodec)) {
    throw new Error("音频编码暂不受支持。");
  }
  return {
    ...probe,
    videoCodec,
    ...(audioCodec ? { audioCodec } : {}),
    hasAudio: !!audioCodec && probe.hasAudio,
  };
}

export function validateContainerCodecCombination(
  contentType: "video/mp4" | "video/webm",
  probe: VideoProbeResult,
): VideoProbeResult {
  const checked = validateVideoProbe(probe);
  if (
    contentType === "video/mp4" &&
    (checked.videoCodec !== "h264" ||
      (checked.audioCodec !== undefined && checked.audioCodec !== "aac"))
  ) {
    throw new Error("MP4 首发仅支持 H.264 视频与可选 AAC 音轨。");
  }
  if (
    contentType === "video/webm" &&
    (!["vp8", "vp9", "av1"].includes(checked.videoCodec) ||
      (checked.audioCodec !== undefined &&
        !["opus", "vorbis"].includes(checked.audioCodec)))
  ) {
    throw new Error("WebM 编码组合暂不受支持。");
  }
  return checked;
}

function safeSubtitleText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") throw new Error("字幕文本格式不合法。");
  const text = value.trim();
  if (
    !text ||
    text.length > maxLength ||
    /[<>]/.test(text) ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)
  ) {
    throw new Error("字幕包含不安全或超长内容。");
  }
  return text;
}

export function validateSubtitleCues(
  value: unknown,
  durationMs?: number,
): VideoSubtitleCue[] {
  if (value === undefined || value === null || value === "") return [];
  if (!Array.isArray(value) || value.length > 5000) {
    throw new Error("字幕 cue 数量不合法。");
  }
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object") {
      throw new Error("字幕 cue 格式不合法。");
    }
    const record = raw as Record<string, unknown>;
    const startMs = Number(record.startMs);
    const endMs = Number(record.endMs);
    if (
      !Number.isFinite(startMs) ||
      !Number.isFinite(endMs) ||
      startMs < 0 ||
      endMs <= startMs ||
      (durationMs !== undefined && endMs > durationMs + 1000)
    ) {
      throw new Error("字幕时间轴不合法。");
    }
    return {
      id:
        typeof record.id === "string" && record.id.trim()
          ? record.id.trim().slice(0, 80)
          : `cue-${index + 1}`,
      startMs: Math.round(startMs),
      endMs: Math.round(endMs),
      text: safeSubtitleText(record.text, 500),
      ...(record.speaker
        ? { speaker: safeSubtitleText(record.speaker, 80) }
        : {}),
    };
  });
}

function parseVttTime(value: string): number {
  const parts = value.trim().split(":").map(Number);
  if (
    (parts.length !== 2 && parts.length !== 3) ||
    parts.some((part) => !Number.isFinite(part))
  ) {
    throw new Error("WebVTT 时间格式不合法。");
  }
  const hours = parts.length === 3 ? parts[0]! : 0;
  const minutes = parts.length === 3 ? parts[1]! : parts[0]!;
  const seconds = parts.length === 3 ? parts[2]! : parts[1]!;
  return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
}

export function parseWebVtt(
  source: string,
  durationMs?: number,
): VideoSubtitleCue[] {
  if (source.length > 512 * 1024 || /<[^>]*>/.test(source)) {
    throw new Error("WebVTT 字幕过大或包含 HTML。");
  }
  const normalized = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!normalized.startsWith("WEBVTT")) {
    throw new Error("WebVTT 缺少 WEBVTT 文件头。");
  }
  const blocks = normalized.split(/\n{2,}/).slice(1);
  const cues: VideoSubtitleCue[] = [];
  for (const block of blocks) {
    const lines = block.split("\n").filter(Boolean);
    if (!lines.length || lines[0]!.startsWith("NOTE")) continue;
    const timeIndex = lines.findIndex((line) => line.includes("-->"));
    if (timeIndex < 0) continue;
    const [startRaw, endWithSettings] = lines[timeIndex]!.split("-->");
    const endRaw = endWithSettings?.trim().split(/\s+/)[0];
    if (!startRaw || !endRaw) throw new Error("WebVTT cue 时间缺失。");
    const text = lines.slice(timeIndex + 1).join("\n");
    cues.push({
      id:
        timeIndex === 1
          ? safeSubtitleText(lines[0]!, 80)
          : `cue-${cues.length + 1}`,
      startMs: parseVttTime(startRaw),
      endMs: parseVttTime(endRaw),
      text: safeSubtitleText(text, 500),
    });
  }
  return validateSubtitleCues(cues, durationMs);
}

export function orientationForVideo(
  width: number,
  height: number,
): "landscape" | "portrait" | "square" {
  const ratio = width / height;
  if (ratio > 1.1) return "landscape";
  if (ratio < 0.9) return "portrait";
  return "square";
}
