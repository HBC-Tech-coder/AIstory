import type { Session } from "@infiplot/types";

import { isPublishedStaticMediaUrl } from "./publishedStaticMedia";

/**
 * Browser-safe projection of a local `Session` into the frozen online-share
 * contract (`reference/CONTRACT.md`).
 *
 * This module is an explicit ALLOWLIST: only generated scene ids, safe media
 * URLs and generated beat text leave the browser. The full session, prompts,
 * story state, world books, timeline, characters/voices, style guides and
 * owner ids are never copied into the document or the POST body.
 *
 * It performs no network / provider / AI / TTS work.
 */

export type SharedStoryVisibility = "public" | "hidden";

export type SharedChoiceTarget = {
  sceneId: string;
  beatId: string;
};

export type SharedChoice = {
  id: string;
  label: string;
  /** Missing target = the continuation was never generated / is unavailable. */
  target?: SharedChoiceTarget;
};

export type SharedBeatNext =
  | { type: "continue"; nextBeatId: string }
  | { type: "choice"; choices: SharedChoice[] };

export type SharedSceneBeat = {
  id: string;
  narration?: string;
  speaker?: string;
  line?: string;
  next: SharedBeatNext;
};

export type SharedScene = {
  id: string;
  imageUrl: string;
  entryBeatId: string;
  beats: SharedSceneBeat[];
};

export type SharedDocument = {
  v: 1;
  scenes: SharedScene[];
};

export type SharedSummary = {
  id: string;
  title: string;
  visibility: SharedStoryVisibility;
  revision: number;
  createdAt: string;
  updatedAt: string;
  sceneCount: number;
  /** Backend final shape: a controls URL or `null` when no cover exists. */
  coverUrl: string | null;
  /** Only ever present on the owner's own (`?mine=1`) results. */
  sourceId?: string;
};

export type SharedStoryDetail = SharedSummary & {
  document: SharedDocument;
};

export type SharedListResponse = {
  items: SharedSummary[];
  nextCursor: string | null;
};

export type SharedStoryPostBody = {
  /** Server-owner-scoped dedupe key. Never part of the public projection. */
  sourceId: string;
  title: string;
  visibility?: SharedStoryVisibility;
  expectedRevision?: number;
  document: SharedDocument;
};

export const DEFAULT_SHARED_TITLE = "我的故事";
export const DEFAULT_SHARED_VISIBILITY: SharedStoryVisibility = "public";
/** Contract: base64 scene image must be PNG/JPEG/WebP and <= 1 MiB. */
export const MAX_SHARED_IMAGE_BYTES = 1_048_576;

const MEDIA_PATH_PREFIX = "/api/aistory-cache/media/";
/**
 * Frozen contract: same-origin controlled media only, exactly 64 lowercase hex
 * characters and a raster extension. No query string, no traversal, no
 * uppercase hex, no external host.
 */
export const SHARED_MEDIA_PATH_PATTERN =
  /^\/api\/aistory-cache\/media\/[0-9a-f]{64}\.(?:png|jpg|jpeg|webp)$/;
const DATA_URI_PATTERN = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;

/**
 * Safe-to-display projection failure. The message is always user-facing
 * Chinese; the publish panel shows it before it ever issues a POST.
 */
export class SharedStoryProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SharedStoryProjectionError";
  }
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as JsonRecord;
}

function readString(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readNonNegativeInteger(record: JsonRecord, key: string): number | undefined {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return undefined;
  }
  return value;
}

function base64DecodedBytes(base64: string): number | null {
  if (base64.length === 0 || base64.length % 4 !== 0) return null;
  let padding = 0;
  if (base64.endsWith("==")) padding = 2;
  else if (base64.endsWith("=")) padding = 1;
  const bytes = (base64.length / 4) * 3 - padding;
  return bytes > 0 ? bytes : null;
}

export function isSharedStoryVisibility(value: unknown): value is SharedStoryVisibility {
  return value === "public" || value === "hidden";
}

/**
 * True only for contract-approved image references:
 *   - exact published static preset paths (`publishedStaticMedia.ts`)
 *   - `/api/aistory-cache/media/<64 lowercase hex>.(png|jpg|jpeg|webp)`
 *   - `data:image/(png|jpeg|webp);base64,...` whose decoded bytes are <= 1 MiB
 */
export function isAllowedMediaUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (isPublishedStaticMediaUrl(value)) return true;
  if (value.startsWith(MEDIA_PATH_PREFIX)) {
    return SHARED_MEDIA_PATH_PATTERN.test(value);
  }
  if (!value.startsWith("data:image/")) return false;
  const match = DATA_URI_PATTERN.exec(value);
  if (!match) return false;
  const base64 = match[2];
  if (base64 === undefined) return false;
  const bytes = base64DecodedBytes(base64);
  return bytes !== null && bytes <= MAX_SHARED_IMAGE_BYTES;
}

/**
 * Defensive helper for display-only fields (`coverUrl`). Unsupported values
 * become `null`; scene images never use this — they must throw.
 */
export function safeMediaUrl(value: unknown): string | null {
  return isAllowedMediaUrl(value) ? value : null;
}

function containsAuthorLock(value: unknown, seen: WeakSet<object>): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((item) => containsAuthorLock(item, seen));
  }
  const record = value as JsonRecord;
  if (record.authorLocked === true) return true;
  for (const key of Object.keys(record)) {
    if (containsAuthorLock(record[key], seen)) return true;
  }
  return false;
}

/**
 * Authored/author-locked sessions are not generated snapshots and must never be
 * published. Checked once, before any projection work or network request.
 */
function assertProjectionSupported(session: Session | null): void {
  if (!session) return;
  const record = session as unknown as JsonRecord;
  if (record.authoredStory !== undefined && record.authoredStory !== null) {
    throw new SharedStoryProjectionError(
      "该故事包含作者出版内容，当前版本暂不支持在线分享。",
    );
  }
  if (containsAuthorLock(session, new WeakSet<object>())) {
    throw new SharedStoryProjectionError(
      "该故事已被作者锁定，当前版本暂不支持在线分享。",
    );
  }
}

export function normalizeSharedTitle(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_SHARED_TITLE;
}

/**
 * v1 is an image-snapshot contract. Video is explicitly unsupported and must
 * throw — never downgrade to the poster/legacy image. Missing or invalid image
 * URLs also throw instead of publishing a scene with a blank image.
 */
function resolveSceneImageUrl(scene: JsonRecord, sceneNumber: number): string {
  const media = asRecord(scene.media);
  if (media) {
    const kind = readString(media, "kind");
    if (kind === "video") {
      throw new SharedStoryProjectionError(
        `第 ${sceneNumber} 幕包含视频内容，当前版本仅支持静态图片快照分享。`,
      );
    }
    if (kind !== "image") {
      throw new SharedStoryProjectionError(
        `第 ${sceneNumber} 幕的媒体类型暂不支持分享。`,
      );
    }
    if (media.url !== undefined) {
      const mediaUrl = media.url;
      if (!isAllowedMediaUrl(mediaUrl)) {
        throw new SharedStoryProjectionError(
          `第 ${sceneNumber} 幕的图片地址不受支持，暂时无法分享。`,
        );
      }
      return mediaUrl;
    }
  }

  const legacyImage = scene.imageUrl;
  if (!isAllowedMediaUrl(legacyImage)) {
    throw new SharedStoryProjectionError(
      `第 ${sceneNumber} 幕缺少可分享的图片，暂时无法分享。`,
    );
  }
  return legacyImage;
}

type RawChoice = {
  id: string;
  label: string;
  effect: JsonRecord | null;
};

type BaseBeat = {
  id: string;
  narration?: string;
  speaker?: string;
  line?: string;
  next:
    | { type: "continue"; nextBeatId: string }
    | { type: "choice"; choices: RawChoice[] };
};

type BaseScene = {
  originalIndex: number;
  id: string;
  imageUrl: string;
  entryBeatId: string;
  exitChoiceId: string | null;
  beats: BaseBeat[];
};

function copyBeatText(record: JsonRecord, beat: SharedSceneBeat): void {
  const narration = readString(record, "narration");
  if (narration !== undefined) beat.narration = narration;
  const speaker = readString(record, "speaker");
  if (speaker !== undefined) beat.speaker = speaker;
  const line = readString(record, "line");
  if (line !== undefined) beat.line = line;
}

function buildBaseBeats(rawBeats: unknown): BaseBeat[] {
  if (!Array.isArray(rawBeats)) return [];
  const beats: BaseBeat[] = [];
  for (const rawBeat of rawBeats) {
    const record = asRecord(rawBeat);
    if (!record) continue;
    const id = readString(record, "id");
    if (!id) continue;

    const nextRecord = asRecord(record.next);
    if (!nextRecord) continue;
    const nextType = readString(nextRecord, "type");

    let next: BaseBeat["next"] | null = null;
    if (nextType === "continue") {
      const nextBeatId = readString(nextRecord, "nextBeatId");
      if (nextBeatId) next = { type: "continue", nextBeatId };
    } else if (nextType === "choice" && Array.isArray(nextRecord.choices)) {
      const choices: RawChoice[] = [];
      for (const rawChoice of nextRecord.choices) {
        const choice = asRecord(rawChoice);
        if (!choice) continue;
        const choiceId = readString(choice, "id");
        const label = readString(choice, "label");
        if (!choiceId || label === undefined) continue;
        choices.push({
          id: choiceId,
          label,
          effect: asRecord(choice.effect),
        });
      }
      next = { type: "choice", choices };
    }
    if (!next) continue;

    const beat: BaseBeat = { id, ...copyTextFields(record), next };
    beats.push(beat);
  }
  return beats;
}

function copyTextFields(record: JsonRecord): {
  narration?: string;
  speaker?: string;
  line?: string;
} {
  const text: { narration?: string; speaker?: string; line?: string } = {};
  const narration = readString(record, "narration");
  if (narration !== undefined) text.narration = narration;
  const speaker = readString(record, "speaker");
  if (speaker !== undefined) text.speaker = speaker;
  const line = readString(record, "line");
  if (line !== undefined) text.line = line;
  return text;
}

function buildBaseScenes(session: Session | null): BaseScene[] {
  const history: unknown = session ? session.history : [];
  if (!Array.isArray(history)) return [];

  const scenes: BaseScene[] = [];
  for (let index = 0; index < history.length; index += 1) {
    const sceneNumber = index + 1;
    const entry = asRecord(history[index]);
    if (!entry) {
      throw new SharedStoryProjectionError(
        `第 ${sceneNumber} 幕剧情数据不完整，暂时无法分享。`,
      );
    }
    const sceneRecord = asRecord(entry.scene);
    if (!sceneRecord) {
      throw new SharedStoryProjectionError(
        `第 ${sceneNumber} 幕剧情数据不完整，暂时无法分享。`,
      );
    }
    const sceneId = readString(sceneRecord, "id");
    if (!sceneId) {
      throw new SharedStoryProjectionError(
        `第 ${sceneNumber} 幕缺少场景标识，暂时无法分享。`,
      );
    }

    const beats = buildBaseBeats(sceneRecord.beats);
    if (beats.length === 0) {
      throw new SharedStoryProjectionError(
        `第 ${sceneNumber} 幕没有可分享的剧情内容，暂时无法分享。`,
      );
    }

    const firstBeat = beats[0];
    if (!firstBeat) {
      throw new SharedStoryProjectionError(
        `第 ${sceneNumber} 幕没有可分享的剧情内容，暂时无法分享。`,
      );
    }

    const preferredEntry = readString(sceneRecord, "entryBeatId");
    const entryBeatId =
      preferredEntry !== undefined && beats.some((beat) => beat.id === preferredEntry)
        ? preferredEntry
        : firstBeat.id;

    const exit = asRecord(entry.exit);
    const exitChoiceId =
      exit && exit.kind === "choice" ? readString(exit, "choiceId") ?? null : null;

    scenes.push({
      originalIndex: index,
      id: sceneId,
      imageUrl: resolveSceneImageUrl(sceneRecord, sceneNumber),
      entryBeatId,
      exitChoiceId,
      beats,
    });
  }
  return scenes;
}

function resolveChoiceTarget(
  choice: RawChoice,
  scene: BaseScene,
  beatIds: ReadonlySet<string>,
  sceneByIndex: ReadonlyMap<number, BaseScene>,
): SharedChoiceTarget | undefined {
  if (!choice.effect) return undefined;
  const kind = readString(choice.effect, "kind");

  if (kind === "advance-beat") {
    const targetBeatId = readString(choice.effect, "targetBeatId");
    if (targetBeatId && beatIds.has(targetBeatId)) {
      return { sceneId: scene.id, beatId: targetBeatId };
    }
    return undefined;
  }

  if (kind === "change-scene") {
    // Only map a scene change when the persisted history exit matches this
    // choice id AND the next generated history entry exists. `nextSceneSeed`
    // and prompts are never read.
    if (scene.exitChoiceId !== choice.id) return undefined;
    const nextScene = sceneByIndex.get(scene.originalIndex + 1);
    if (!nextScene) return undefined;
    return { sceneId: nextScene.id, beatId: nextScene.entryBeatId };
  }

  return undefined;
}

/**
 * Build the strict public share document from `session.history`, preserving the
 * generated scene order and each scene's generated beat order.
 */
export function buildSharedStoryDocument(session: Session | null): SharedDocument {
  assertProjectionSupported(session);
  const baseScenes = buildBaseScenes(session);
  const sceneByIndex = new Map<number, BaseScene>();
  for (const scene of baseScenes) sceneByIndex.set(scene.originalIndex, scene);

  const scenes: SharedScene[] = baseScenes.map((scene) => {
    const beatIds = new Set(scene.beats.map((beat) => beat.id));
    const beats: SharedSceneBeat[] = scene.beats.map((beat) => {
      if (beat.next.type === "continue") {
        const output: SharedSceneBeat = {
          id: beat.id,
          next: { type: "continue", nextBeatId: beat.next.nextBeatId },
        };
        applyTextFields(output, beat);
        return output;
      }

      const choices: SharedChoice[] = beat.next.choices.map((choice) => {
        const target = resolveChoiceTarget(choice, scene, beatIds, sceneByIndex);
        const output: SharedChoice = { id: choice.id, label: choice.label };
        if (target) output.target = target;
        return output;
      });
      const output: SharedSceneBeat = {
        id: beat.id,
        next: { type: "choice", choices },
      };
      applyTextFields(output, beat);
      return output;
    });

    return {
      id: scene.id,
      imageUrl: scene.imageUrl,
      entryBeatId: scene.entryBeatId,
      beats,
    };
  });

  return { v: 1, scenes };
}

function applyTextFields(
  output: SharedSceneBeat,
  beat: { narration?: string; speaker?: string; line?: string },
): void {
  if (beat.narration !== undefined) output.narration = beat.narration;
  if (beat.speaker !== undefined) output.speaker = beat.speaker;
  if (beat.line !== undefined) output.line = beat.line;
}

/**
 * Exact POST body shape from the contract. `sourceId` is the server-owner-scoped
 * dedupe key; it is never added to the public document.
 */
export function buildSharedStoryPostBody(
  session: Session,
  title: string,
  visibility: SharedStoryVisibility = DEFAULT_SHARED_VISIBILITY,
): SharedStoryPostBody {
  return {
    sourceId: session.id,
    title: normalizeSharedTitle(title),
    visibility,
    document: buildSharedStoryDocument(session),
  };
}

export function parseSharedSummary(value: unknown): SharedSummary | null {
  const record = asRecord(value);
  if (!record) return null;

  const id = readString(record, "id");
  const title = readString(record, "title");
  const createdAt = readString(record, "createdAt");
  const updatedAt = readString(record, "updatedAt");
  const revision = readNonNegativeInteger(record, "revision");
  const sceneCount = readNonNegativeInteger(record, "sceneCount");
  const visibility = record.visibility;

  // Backend final type is `coverUrl: string | null`. A missing field or a
  // non-null value that is not a contract media URL invalidates the summary.
  const coverUrlValue = record.coverUrl;
  let coverUrl: string | null;
  if (coverUrlValue === null) {
    coverUrl = null;
  } else if (isAllowedMediaUrl(coverUrlValue)) {
    coverUrl = coverUrlValue;
  } else {
    return null;
  }

  if (
    !id ||
    title === undefined ||
    createdAt === undefined ||
    updatedAt === undefined ||
    revision === undefined ||
    sceneCount === undefined ||
    !isSharedStoryVisibility(visibility)
  ) {
    return null;
  }

  const summary: SharedSummary = {
    id,
    title,
    visibility,
    revision,
    createdAt,
    updatedAt,
    sceneCount,
    coverUrl,
  };
  const sourceId = readString(record, "sourceId");
  if (sourceId !== undefined) summary.sourceId = sourceId;
  return summary;
}

export function parseSharedList(value: unknown): SharedListResponse | null {
  const record = asRecord(value);
  if (!record || !Array.isArray(record.items)) return null;

  const items: SharedSummary[] = [];
  for (const rawItem of record.items) {
    const item = parseSharedSummary(rawItem);
    if (item) items.push(item);
  }

  const nextCursorValue = record.nextCursor;
  if (
    nextCursorValue !== undefined &&
    nextCursorValue !== null &&
    typeof nextCursorValue !== "string"
  ) {
    return null;
  }

  return { items, nextCursor: nextCursorValue ?? null };
}

function parseChoiceTarget(value: unknown): SharedChoiceTarget | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const sceneId = readString(record, "sceneId");
  const beatId = readString(record, "beatId");
  if (!sceneId || !beatId) return undefined;
  return { sceneId, beatId };
}

function parseBeatNext(value: unknown): SharedBeatNext | null {
  const record = asRecord(value);
  if (!record) return null;
  const type = readString(record, "type");

  if (type === "continue") {
    const nextBeatId = readString(record, "nextBeatId");
    return nextBeatId ? { type: "continue", nextBeatId } : null;
  }

  if (type !== "choice" || !Array.isArray(record.choices)) return null;
  const choices: SharedChoice[] = [];
  for (const rawChoice of record.choices) {
    const choice = asRecord(rawChoice);
    if (!choice) continue;
    const id = readString(choice, "id");
    const label = readString(choice, "label");
    if (!id || label === undefined) continue;
    const output: SharedChoice = { id, label };
    const target = parseChoiceTarget(choice.target);
    if (target) output.target = target;
    choices.push(output);
  }
  return { type: "choice", choices };
}

/**
 * Re-validate an untrusted shared document and strip any unknown / injected
 * fields. A scene with a missing/invalid `imageUrl` rejects the whole response
 * (the contract makes it mandatory); targets that do not resolve inside this
 * document are dropped.
 */
export function parseSharedDocument(value: unknown): SharedDocument | null {
  const record = asRecord(value);
  if (!record || record.v !== 1 || !Array.isArray(record.scenes)) return null;

  const scenes: SharedScene[] = [];
  for (const rawScene of record.scenes) {
    const sceneRecord = asRecord(rawScene);
    if (!sceneRecord) return null;
    const id = readString(sceneRecord, "id");
    const rawEntryBeatId = readString(sceneRecord, "entryBeatId");
    const rawImageUrl = sceneRecord.imageUrl;
    if (
      !id ||
      rawEntryBeatId === undefined ||
      !isAllowedMediaUrl(rawImageUrl) ||
      !Array.isArray(sceneRecord.beats)
    ) {
      return null;
    }

    const beats: SharedSceneBeat[] = [];
    for (const rawBeat of sceneRecord.beats) {
      const beatRecord = asRecord(rawBeat);
      if (!beatRecord) return null;
      const beatId = readString(beatRecord, "id");
      if (!beatId) return null;
      const next = parseBeatNext(beatRecord.next);
      if (!next) return null;
      const beat: SharedSceneBeat = { id: beatId, next };
      copyBeatText(beatRecord, beat);
      beats.push(beat);
    }
    if (beats.length === 0) return null;
    if (!beats.some((beat) => beat.id === rawEntryBeatId)) return null;

    scenes.push({
      id,
      imageUrl: rawImageUrl,
      entryBeatId: rawEntryBeatId,
      beats,
    });
  }

  // Drop cross-scene targets that do not exist in this snapshot.
  const scenesById = new Map<string, SharedScene>();
  for (const scene of scenes) scenesById.set(scene.id, scene);
  for (const scene of scenes) {
    for (const beat of scene.beats) {
      if (beat.next.type !== "choice") continue;
      for (const choice of beat.next.choices) {
        if (!choice.target) continue;
        const targetScene = scenesById.get(choice.target.sceneId);
        const targetBeatId = choice.target.beatId;
        if (!targetScene || !targetScene.beats.some((beat) => beat.id === targetBeatId)) {
          delete choice.target;
        }
      }
    }
  }

  return { v: 1, scenes };
}

/** Parse the DIRECT `GET /api/shared-stories/[id]` response (not wrapped). */
export function parseSharedStoryDetail(value: unknown): SharedStoryDetail | null {
  const summary = parseSharedSummary(value);
  if (!summary) return null;
  const record = asRecord(value);
  if (!record) return null;
  const document = parseSharedDocument(record.document);
  if (!document) return null;
  return { ...summary, document };
}
