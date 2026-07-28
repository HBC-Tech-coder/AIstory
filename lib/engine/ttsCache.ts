import { createHash } from "crypto";
import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";

import { inferTtsProvider } from "@infiplot/tts-client";
import type { BeatAudio, BeatAudioRequest, BeatAudioResponse, CharacterVoice, CharacterVoiceProfile, TtsConfig } from "@infiplot/types";

const CACHE_VERSION = "tts-cache-v2";
const CACHE_ROOT =
  process.env.AISTORY_CACHE_DIR ||
  path.join(process.cwd(), ".aistory-cache");
const TTS_CACHE_DIR = path.join(CACHE_ROOT, "tts");
const DEFAULT_MAX_AUDIO_BYTES = 2 * 1024 * 1024;

type CacheStatus = "hit" | "miss" | "skip" | "write";

export type TtsCacheMeta = {
  status: CacheStatus;
  key?: string;
  reason?: string;
};

type CacheEnvelope = {
  version: string;
  key: string;
  createdAt: string;
  mime: string;
  base64: string;
  byteLength: number;
};

const pending = new Map<string, Promise<BeatAudioResponse>>();

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function shortHash(value: unknown): string {
  return hash(value).slice(0, 16);
}

function normalizeText(value: string | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ");
}

function isCacheEnabled(): boolean {
  return process.env.AISTORY_TTS_CACHE !== "0";
}

function maxAudioBytes(): number {
  const raw = Number(process.env.AISTORY_TTS_CACHE_MAX_BYTES ?? DEFAULT_MAX_AUDIO_BYTES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_AUDIO_BYTES;
}

function ttsConfigFingerprint(cfg: TtsConfig) {
  const provider = inferTtsProvider(cfg);
  return {
    provider,
    // Keep the endpoint in the key because providers can serve region-specific
    // models/voices differently. Never include apiKey.
    baseUrl: normalizeText(cfg.baseUrl),
    speechModel: normalizeText(cfg.speechModel),
    voice: normalizeText(cfg.voice),
  };
}

function voiceFingerprint(voice?: CharacterVoice) {
  if (!voice) return null;
  if (voice.provider === "xiaomi") {
    return {
      provider: voice.provider,
      mimeType: voice.mimeType,
      referenceAudioHash: shortHash(voice.referenceAudioBase64),
    };
  }
  return {
    provider: voice.provider,
    voiceId: voice.voiceId,
    model: voice.model,
    mimeType: voice.mimeType,
  };
}

function voiceProfileFingerprint(profile?: CharacterVoiceProfile) {
  if (!profile) return null;
  return {
    id: normalizeText(profile.id),
    gender: profile.gender,
    ageRange: profile.ageRange,
    style: profile.style,
    stepfunVoiceId: normalizeText(profile.stepfunVoiceId),
    bailianVoiceId: normalizeText(profile.bailianVoiceId),
  };
}

export function beatAudioCacheKey(
  cfg: TtsConfig | undefined,
  req: BeatAudioRequest,
): TtsCacheMeta {
  if (!isCacheEnabled()) return { status: "skip", reason: "disabled" };
  if (!cfg) return { status: "skip", reason: "tts-disabled" };
  const line = normalizeText(req.beat?.line);
  if (!line) return { status: "skip", reason: "empty-line" };
  return {
    status: "miss",
    key: hash({
      version: CACHE_VERSION,
      config: ttsConfigFingerprint(cfg),
      line,
      lineDelivery: normalizeText(req.beat?.lineDelivery),
      voice: voiceFingerprint(req.voice),
      voiceProfile: voiceProfileFingerprint(req.voiceProfile),
      voiceDescriptionHash: req.voiceDescription ? shortHash(req.voiceDescription) : null,
      characterName: normalizeText(req.characterName),
      stepfunVoiceId: normalizeText(req.stepfunVoiceId),
    }),
  };
}

function cacheFile(key: string): string {
  return path.join(TTS_CACHE_DIR, `${key}.json`);
}

async function readCache(key: string): Promise<BeatAudio | null> {
  try {
    const raw = await readFile(cacheFile(key), "utf8");
    const parsed = JSON.parse(raw) as CacheEnvelope;
    if (parsed.version !== CACHE_VERSION || parsed.key !== key) return null;
    if (!parsed.mime || !parsed.base64) return null;
    return { mime: parsed.mime, base64: parsed.base64 };
  } catch {
    return null;
  }
}

export async function peekTtsCache(
  meta: TtsCacheMeta,
): Promise<(BeatAudioResponse & { cache: TtsCacheMeta }) | null> {
  if (!meta.key) return null;
  const audio = await readCache(meta.key);
  return audio
    ? { audio, cache: { ...meta, status: "hit" } }
    : null;
}

async function writeCache(key: string, audio: BeatAudio): Promise<boolean> {
  const byteLength = Buffer.byteLength(audio.base64, "base64");
  if (byteLength <= 0 || byteLength > maxAudioBytes()) return false;
  await mkdir(TTS_CACHE_DIR, { recursive: true });
  const envelope: CacheEnvelope = {
    version: CACHE_VERSION,
    key,
    createdAt: new Date().toISOString(),
    mime: audio.mime,
    base64: audio.base64,
    byteLength,
  };
  await writeFile(cacheFile(key), JSON.stringify(envelope), "utf8");
  return true;
}

export async function withTtsCache(
  meta: TtsCacheMeta,
  label: string,
  compute: () => Promise<BeatAudioResponse>,
): Promise<BeatAudioResponse & { cache: TtsCacheMeta }> {
  if (!meta.key) {
    console.log(`[tts-cache] ${label} skip: ${meta.reason ?? "no-key"}`);
    const value = await compute();
    return { ...value, cache: meta };
  }

  const cached = await readCache(meta.key);
  if (cached) {
    console.log(`[tts-cache] ${label} hit ${meta.key.slice(0, 12)}`);
    return { audio: cached, cache: { ...meta, status: "hit" } };
  }

  const existing = pending.get(meta.key);
  if (existing) {
    console.log(`[tts-cache] ${label} wait ${meta.key.slice(0, 12)}`);
    const value = await existing;
    return { ...value, cache: { ...meta, status: value.audio ? "hit" : "skip", reason: value.audio ? undefined : "coalesced-empty" } };
  }

  const promise = compute();
  pending.set(meta.key, promise);
  try {
    const value = await promise;
    if (!value.audio) {
      return { ...value, cache: { ...meta, status: "skip", reason: "empty-audio" } };
    }
    let wrote = false;
    try {
      wrote = await writeCache(meta.key, value.audio);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[tts-cache] ${label} write failed ${meta.key.slice(0, 12)}: ${message}`);
      return { ...value, cache: { ...meta, status: "skip", reason: "cache-write-failed" } };
    }
    if (!wrote) {
      return { ...value, cache: { ...meta, status: "skip", reason: "audio-too-large" } };
    }
    console.log(`[tts-cache] ${label} write ${meta.key.slice(0, 12)}`);
    return { ...value, cache: { ...meta, status: "write" } };
  } finally {
    pending.delete(meta.key);
  }
}

