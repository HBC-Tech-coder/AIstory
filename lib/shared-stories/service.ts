import path from "node:path";

import { createMediaValidator, validateDocumentMedia } from "./media";
import {
  SharedStoriesRepository,
  deriveOwnerKey,
  type SharedStoriesRepositoryOptions,
} from "./repository";
import {
  validateCreateStoryInput,
  validatePatchStoryInput,
} from "./validation";
import {
  SharedStoriesError,
  type SharedDocumentV1,
  type SharedListResponse,
  type SharedMediaValidator,
  type SharedOwner,
  type SharedStory,
  type SharedStoryRecord,
  type SharedSummary,
} from "./types";

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 50;
const CURSOR_VERSION = 1;
const CURSOR_SORT = "createdAt:desc,id:asc";
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,512}$/;
const MAX_CURSOR_OFFSET = 1_000_000;

type ListQueryKind = "public" | "mine";

type ListCursorPayload = {
  v: typeof CURSOR_VERSION;
  q: ListQueryKind;
  s: typeof CURSOR_SORT;
  o: number;
};

export type SharedStoriesServiceOptions = {
  repository?: SharedStoriesRepository;
  validateMedia?: SharedMediaValidator;
  repositoryOptions?: Omit<SharedStoriesRepositoryOptions, "validateMedia">;
};

export class SharedStoriesService {
  readonly repository: SharedStoriesRepository;
  private readonly validateMedia: SharedMediaValidator | undefined;

  constructor(options: SharedStoriesServiceOptions = {}) {
    this.validateMedia = options.validateMedia;
    this.repository =
      options.repository ??
      createRepositoryFromEnv(options.repositoryOptions, options.validateMedia);
  }

  private async validateDocument(document: SharedDocumentV1): Promise<void> {
    if (this.validateMedia) await validateDocumentMedia(document, this.validateMedia);
  }

  async createStory(
    owner: SharedOwner,
    rawInput: unknown,
  ): Promise<{ story: SharedSummary; created: boolean }> {
    assertOwner(owner);
    const input = validateCreateStoryInput(rawInput);
    await this.validateDocument(input.document);
    const ownerKey = deriveOwnerKey(owner.userId, owner.authType);
    const result = await this.repository.createStory(
      {
        ownerKey,
        sourceId: input.sourceId,
        title: input.title,
        ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
        ...(input.expectedRevision === undefined
          ? {}
          : { expectedRevision: input.expectedRevision }),
        document: input.document,
      },
      this.validateMedia,
    );
    return { story: toSummary(result.record, false), created: result.created };
  }

  async updateVisibility(
    owner: SharedOwner,
    id: string,
    rawInput: unknown,
  ): Promise<SharedSummary> {
    assertOwner(owner);
    const input = validatePatchStoryInput(rawInput);
    const ownerKey = deriveOwnerKey(owner.userId, owner.authType);
    const record = await this.repository.updateVisibility({
      id,
      ownerKey,
      visibility: input.visibility,
      expectedRevision: input.expectedRevision,
    });
    return toSummary(record, false);
  }

  /** Public view only: hidden records are indistinguishable from unknown ones. */
  async getPublicStory(id: string): Promise<SharedStory | null> {
    if (typeof id !== "string" || id.length === 0 || id.length > 128) return null;
    const record = await this.repository.getStory(id);
    if (!record || record.visibility !== "public") return null;
    return toStory(record);
  }

  async listPublic(options: { limit?: number; cursor?: string | null } = {}): Promise<SharedListResponse> {
    return this.list("public", undefined, options);
  }

  async listMine(
    owner: SharedOwner,
    options: { limit?: number; cursor?: string | null } = {},
  ): Promise<SharedListResponse> {
    assertOwner(owner);
    return this.list("mine", deriveOwnerKey(owner.userId, owner.authType), options);
  }

  private async list(
    kind: ListQueryKind,
    ownerKey: string | undefined,
    options: { limit?: number; cursor?: string | null },
  ): Promise<SharedListResponse> {
    const limit = normalizeLimit(options.limit);
    const offset =
      options.cursor === undefined || options.cursor === null
        ? 0
        : decodeListCursor(options.cursor, kind);
    const page = await this.repository.listStories({ ownerKey, offset, limit });
    return {
      items: page.records.map((record) => toSummary(record, kind === "mine")),
      nextCursor: page.hasMore ? encodeListCursor(kind, offset + page.records.length) : null,
    };
  }
}

function assertOwner(owner: SharedOwner): void {
  if (
    !owner ||
    typeof owner.userId !== "string" ||
    owner.userId.length === 0 ||
    owner.userId.length > 512 ||
    owner.authType === "anonymous"
  ) {
    throw new SharedStoriesError("unauthorized", 401, "Login required.");
  }
}

function toSummary(record: SharedStoryRecord, includeSourceId: boolean): SharedSummary {
  return {
    id: record.id,
    title: record.title,
    visibility: record.visibility,
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    sceneCount: record.sceneCount,
    coverUrl: record.coverUrl,
    ...(includeSourceId ? { sourceId: record.sourceId } : {}),
  };
}

function toStory(record: SharedStoryRecord): SharedStory {
  return {
    ...toSummary(record, false),
    document: record.document,
  };
}

function normalizeLimit(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_LIST_LIMIT;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_LIST_LIMIT
  ) {
    throw new SharedStoriesError("invalid_request", 400, "limit must be between 1 and 50.");
  }
  return value;
}

export function encodeListCursor(kind: ListQueryKind, offset: number): string {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_CURSOR_OFFSET) {
    throw new SharedStoriesError("invalid_request", 400, "Invalid list cursor.");
  }
  const payload: ListCursorPayload = {
    v: CURSOR_VERSION,
    q: kind,
    s: CURSOR_SORT,
    o: offset,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeListCursor(raw: string, kind: ListQueryKind): number {
  if (typeof raw !== "string" || !CURSOR_PATTERN.test(raw)) {
    throw new SharedStoriesError("invalid_request", 400, "Invalid list cursor.");
  }
  let payload: unknown;
  try {
    const bytes = Buffer.from(raw, "base64url");
    if (bytes.toString("base64url") !== raw) {
      throw new Error("non-canonical cursor");
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    payload = JSON.parse(text);
  } catch {
    throw new SharedStoriesError("invalid_request", 400, "Invalid list cursor.");
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new SharedStoriesError("invalid_request", 400, "Invalid list cursor.");
  }
  const keys = Object.keys(payload);
  if (keys.length !== 4) {
    throw new SharedStoriesError("invalid_request", 400, "Invalid list cursor.");
  }
  for (const key of keys) {
    if (!["v", "q", "s", "o"].includes(key)) {
      throw new SharedStoriesError("invalid_request", 400, "Invalid list cursor.");
    }
  }
  const cursor = payload as Record<string, unknown>;
  if (cursor.v !== CURSOR_VERSION || cursor.q !== kind || cursor.s !== CURSOR_SORT) {
    throw new SharedStoriesError("invalid_request", 400, "Invalid list cursor.");
  }
  const offset = cursor.o;
  if (
    typeof offset !== "number" ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > MAX_CURSOR_OFFSET
  ) {
    throw new SharedStoriesError("invalid_request", 400, "Invalid list cursor.");
  }
  return offset;
}

function createRepositoryFromEnv(
  repositoryOptions: Omit<SharedStoriesRepositoryOptions, "validateMedia"> = {},
  validateMedia?: SharedMediaValidator,
): SharedStoriesRepository {
  const mode = process.env.AISTORY_SHARED_STORIES_MODE;
  if (mode !== "filesystem-v1") {
    throw new SharedStoriesError("disabled", 503, "Shared stories are not enabled.");
  }
  const root = process.env.AISTORY_SHARED_STORIES_ROOT;
  if (typeof root !== "string" || root.trim().length === 0 || !path.isAbsolute(root)) {
    throw new SharedStoriesError(
      "disabled",
      503,
      "Shared stories storage is not configured.",
    );
  }
  const media = validateMedia ?? createMediaValidator();
  return new SharedStoriesRepository(root, {
    ...repositoryOptions,
    validateMedia: media,
  });
}

/**
 * Production wiring. Environment is read per call so enablement is a request
 * concern, never a compile-time constant. There is deliberately no memory
 * fallback and no auto-created root.
 */
export function createSharedStoriesServiceFromEnv(): SharedStoriesService {
  const media = createMediaValidator();
  return new SharedStoriesService({ validateMedia: media });
}
