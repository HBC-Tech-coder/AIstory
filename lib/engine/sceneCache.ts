import { createHash } from "crypto";
import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";

import { coerceOrientation } from "@infiplot/types";
import type { SceneHistoryEntry, SceneStreamEvent, Session, StartRequest } from "@infiplot/types";
import { isMockImageDataUri } from "./mockImage";

const CACHE_VERSION = "scene-cache-v2-character-continuity";
const CACHE_ROOT =
  process.env.AISTORY_CACHE_DIR ||
  path.join(process.cwd(), ".aistory-cache");
const SCENE_CACHE_DIR = path.join(CACHE_ROOT, "scenes");
const DEFAULT_MAX_SCENES = 5;

type CacheStatus = "hit" | "miss" | "skip" | "write";

export type SceneCacheMeta = {
  status: CacheStatus;
  key?: string;
  reason?: string;
  sceneNumber?: number;
};

type CacheEnvelope<T> = {
  version: string;
  key: string;
  createdAt: string;
  data: T;
};

const pending = new Map<string, Promise<unknown>>();

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

function normalizeText(value: string | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ");
}

function shortHash(value: unknown): string {
  return hash(value).slice(0, 16);
}

function isCacheEnabled(): boolean {
  return process.env.AISTORY_SCENE_CACHE !== "0";
}

function maxCachedScenes(): number {
  const raw = Number(process.env.AISTORY_SCENE_CACHE_MAX_SCENES ?? DEFAULT_MAX_SCENES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_SCENES;
}

function hasByoKeys(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const byo = (value as { byo?: unknown }).byo;
  return !!byo && typeof byo === "object" && Object.keys(byo as Record<string, unknown>).length > 0;
}

function canShareCache(opts: {
  hasByo: boolean;
  styleReferenceImage?: string;
  sceneNumber: number;
}): { ok: true } | { ok: false; reason: string } {
  if (!isCacheEnabled()) return { ok: false, reason: "disabled" };
  if (opts.sceneNumber > maxCachedScenes()) {
    return { ok: false, reason: `scene>${maxCachedScenes()}` };
  }
  if (opts.hasByo && process.env.AISTORY_SCENE_CACHE_BYO !== "1") {
    return { ok: false, reason: "byo-disabled" };
  }
  if (opts.styleReferenceImage && process.env.AISTORY_SCENE_CACHE_STYLE_REF !== "1") {
    return { ok: false, reason: "style-ref-disabled" };
  }
  return { ok: true };
}

function pathSignature(history: SceneHistoryEntry[]): unknown[] {
  return history
    .filter((entry) => entry.exit)
    .map((entry, index) => {
      const exit = entry.exit!;
      if (exit.kind === "freeform") {
        return {
          index,
          kind: "freeform",
          action: normalizeText(exit.action),
        };
      }
      return {
        index,
        kind: "choice",
        choiceId: exit.choiceId,
        label: normalizeText(exit.label),
        nextSceneSeed: normalizeText(exit.nextSceneSeed),
      };
    });
}

function styleFingerprint(styleGuide: string, styleReferenceImage?: string): string {
  return shortHash({
    styleGuide: normalizeText(styleGuide),
    styleReferenceImageHash: styleReferenceImage ? shortHash(styleReferenceImage) : null,
  });
}

function commonFingerprint(session: Pick<Session, "worldSetting" | "styleGuide" | "styleReferenceImage" | "orientation" | "language">) {
  return {
    version: CACHE_VERSION,
    worldSetting: normalizeText(session.worldSetting),
    // MVP note: whole-scene cache includes style so text and image cannot drift.
    // The later Canon/Media split will remove style from the narrative key.
    style: styleFingerprint(session.styleGuide, session.styleReferenceImage),
    language: normalizeText(session.language) || "zh-CN",
    orientation: coerceOrientation(session.orientation),
  };
}

export function startSceneCacheKey(req: StartRequest): SceneCacheMeta {
  const sceneNumber = 1;
  const gate = canShareCache({
    hasByo: hasByoKeys(req),
    styleReferenceImage: req.styleReferenceImage,
    sceneNumber,
  });
  if (!gate.ok) return { status: "skip", reason: gate.reason, sceneNumber };
  const base = commonFingerprint({
    worldSetting: req.worldSetting,
    styleGuide: req.styleGuide,
    styleReferenceImage: req.styleReferenceImage,
    orientation: coerceOrientation(req.orientation),
    language: req.language,
  });
  return {
    status: "miss",
    key: hash({ ...base, kind: "start", path: [] }),
    sceneNumber,
  };
}

export function nextSceneCacheKey(session: Session, reqHasByo = false): SceneCacheMeta {
  const sceneNumber = session.history.length + 1;
  const gate = canShareCache({
    hasByo: reqHasByo,
    styleReferenceImage: session.styleReferenceImage,
    sceneNumber,
  });
  if (!gate.ok) return { status: "skip", reason: gate.reason, sceneNumber };
  return {
    status: "miss",
    key: hash({
      ...commonFingerprint(session),
      kind: "scene",
      path: pathSignature(session.history),
      sceneNumber,
    }),
    sceneNumber,
  };
}

function cacheFile(key: string): string {
  return path.join(SCENE_CACHE_DIR, `${key}.json`);
}

async function readCache<T>(key: string): Promise<T | null> {
  try {
    const raw = await readFile(cacheFile(key), "utf8");
    const parsed = JSON.parse(raw) as CacheEnvelope<T>;
    if (parsed.version !== CACHE_VERSION || parsed.key !== key) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

export async function peekSceneCache<T extends object>(
  meta: SceneCacheMeta,
): Promise<(T & { cache: SceneCacheMeta }) | null> {
  if (!meta.key) return null;
  const cached = await readCache<T>(meta.key);
  return cached
    ? { ...cached, cache: { ...meta, status: "hit" } }
    : null;
}

async function writeCache<T>(key: string, data: T): Promise<void> {
  await mkdir(SCENE_CACHE_DIR, { recursive: true });
  const envelope: CacheEnvelope<T> = {
    version: CACHE_VERSION,
    key,
    createdAt: new Date().toISOString(),
    data,
  };
  await writeFile(cacheFile(key), JSON.stringify(envelope), "utf8");
}

function resultImageUrl(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as {
    imageUrl?: unknown;
    sceneImageUrl?: unknown;
    scene?: { imageUrl?: unknown };
  };
  if (typeof record.imageUrl === "string") return record.imageUrl;
  if (typeof record.sceneImageUrl === "string") return record.sceneImageUrl;
  if (typeof record.scene?.imageUrl === "string") return record.scene.imageUrl;
  return undefined;
}

export async function withSceneCache<T extends object>(
  meta: SceneCacheMeta,
  label: string,
  compute: () => Promise<T>,
  emit?: (event: SceneStreamEvent) => void,
): Promise<T & { cache: SceneCacheMeta }> {
  if (!meta.key) {
    console.log(`[scene-cache] ${label} skip: ${meta.reason ?? "no-key"}`);
    const value = await compute();
    return { ...value, cache: meta };
  }

  const cached = await readCache<T>(meta.key);
  if (cached) {
    console.log(`[scene-cache] ${label} hit ${meta.key.slice(0, 12)}`);
    emit?.({ type: "cache", status: "hit", key: meta.key.slice(0, 12) });
    return { ...cached, cache: { ...meta, status: "hit" } };
  }

  const existing = pending.get(meta.key) as Promise<T> | undefined;
  if (existing) {
    console.log(`[scene-cache] ${label} wait ${meta.key.slice(0, 12)}`);
    const value = await existing;
    return { ...value, cache: { ...meta, status: "hit" } };
  }

  const promise = compute();
  pending.set(meta.key, promise);
  try {
    const value = await promise;
    if (isMockImageDataUri(resultImageUrl(value))) {
      const cache = {
        ...meta,
        status: "skip" as const,
        reason: "placeholder-image",
      };
      console.log(`[scene-cache] ${label} skip-write placeholder ${meta.key.slice(0, 12)}`);
      emit?.({
        type: "cache",
        status: "skip",
        key: meta.key.slice(0, 12),
        reason: "placeholder-image",
      });
      return { ...value, cache };
    }
    const valueWithMeta = { ...value, cache: { ...meta, status: "write" as const } };
    await writeCache(meta.key, valueWithMeta);
    console.log(`[scene-cache] ${label} write ${meta.key.slice(0, 12)}`);
    return valueWithMeta;
  } finally {
    pending.delete(meta.key);
  }
}
