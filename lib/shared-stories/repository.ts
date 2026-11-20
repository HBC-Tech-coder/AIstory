import { createHash, randomBytes, randomUUID } from "node:crypto";
import { accessSync, constants, lstatSync, realpathSync } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import {
  assertBoundedText,
  isSharedVisibility,
  validateDocumentStructure,
  SHARED_LIMITS,
} from "./validation";
import { createMediaValidator } from "./media";
import {
  SHARED_STORE_SCHEMA,
  SharedStoriesError,
  type SharedDocumentV1,
  type SharedMediaValidator,
  type SharedStoryRecord,
  type SharedVisibility,
} from "./types";

const STATE_FILE_NAME = "state.json";
const LOCK_DIRECTORY_NAME = ".lock";
const MAX_STATE_BYTES = 32 * 1024 * 1024;
const MAX_STORIES_GLOBAL = 1_000;
const MAX_STORIES_PER_OWNER = 100;
const DEFAULT_LOCK_TIMEOUT_MS = 1_000;
const OWNER_KEY_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONTENT_HASH_PATTERN = /^[a-f0-9]{64}$/;

type StoreState = {
  schema: typeof SHARED_STORE_SCHEMA;
  stories: SharedStoryRecord[];
};

type CreateRecordInput = {
  ownerKey: string;
  sourceId: string;
  title: string;
  visibility?: SharedVisibility;
  expectedRevision?: number;
  document: SharedDocumentV1;
};

export type SharedStoriesRepositoryOptions = {
  validateMedia?: SharedMediaValidator;
  lockTimeoutMs?: number;
  now?: () => Date;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function storeUnavailable(): SharedStoriesError {
  return new SharedStoriesError(
    "store_unavailable",
    503,
    "Shared stories storage is unavailable.",
  );
}

function disabled(): SharedStoriesError {
  return new SharedStoriesError("disabled", 503, "Shared stories are not enabled.");
}

function corruptStore(): SharedStoriesError {
  return new SharedStoriesError(
    "store_corrupt",
    503,
    "Shared stories storage is corrupted; an operator must inspect it.",
  );
}

function notFound(): SharedStoriesError {
  return new SharedStoriesError("not_found", 404, "Shared story not found.");
}

function revisionConflict(): SharedStoriesError {
  return new SharedStoriesError(
    "revision_conflict",
    409,
    "The shared story changed; refresh and retry.",
  );
}

function revisionRequired(): SharedStoriesError {
  return new SharedStoriesError(
    "revision_required",
    409,
    "expectedRevision is required when changing an existing shared story.",
  );
}

function lockBusy(): SharedStoriesError {
  return new SharedStoriesError("lock_busy", 409, "The shared story is busy; try again.");
}

function capacityReached(): SharedStoriesError {
  return new SharedStoriesError(
    "limit_reached",
    409,
    "The shared story store has reached its capacity.",
  );
}

function sizeLimit(): SharedStoriesError {
  return new SharedStoriesError("size_limit", 413, "Shared story data exceeds the size limit.");
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

function assertNoSymlinkChainSync(target: string): void {
  for (const prefix of pathPrefixes(target)) {
    try {
      const info = lstatSync(prefix);
      if (info.isSymbolicLink()) throw storeUnavailable();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      if (error instanceof SharedStoriesError) throw error;
      throw storeUnavailable();
    }
  }
}

async function assertNoSymlinkChain(target: string): Promise<void> {
  for (const prefix of pathPrefixes(target)) {
    try {
      const info = await lstat(prefix);
      if (info.isSymbolicLink()) throw storeUnavailable();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      if (error instanceof SharedStoriesError) throw error;
      throw storeUnavailable();
    }
  }
}

function assertRootSync(root: string): void {
  assertNoSymlinkChainSync(root);
  let info;
  try {
    info = lstatSync(root);
  } catch {
    throw storeUnavailable();
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw storeUnavailable();
  try {
    const real = realpathSync(root);
    if (normalizedForCompare(real) !== normalizedForCompare(root)) {
      throw storeUnavailable();
    }
  } catch (error) {
    if (error instanceof SharedStoriesError) throw error;
    throw storeUnavailable();
  }
  try {
    accessSync(root, constants.R_OK | constants.W_OK);
  } catch {
    throw storeUnavailable();
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw corruptStore();
  }
}

function requireIsoDate(value: unknown): string {
  if (typeof value !== "string") throw corruptStore();
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) throw corruptStore();
  if (new Date(timestamp).toISOString() !== value) throw corruptStore();
  return value;
}

function hashDocument(document: SharedDocumentV1): string {
  return createHash("sha256").update(JSON.stringify(document)).digest("hex");
}

function validateStoredRecord(value: unknown): SharedStoryRecord {
  try {
    if (!isPlainObject(value)) throw corruptStore();
    assertAllowedKeys(value, [
      "id",
      "ownerKey",
      "sourceId",
      "title",
      "visibility",
      "revision",
      "createdAt",
      "updatedAt",
      "sceneCount",
      "coverUrl",
      "contentHash",
      "document",
    ]);

    if (typeof value.id !== "string" || !UUID_PATTERN.test(value.id)) throw corruptStore();
    if (typeof value.ownerKey !== "string" || !OWNER_KEY_PATTERN.test(value.ownerKey)) {
      throw corruptStore();
    }
    const sourceId = assertBoundedText(
      value.sourceId,
      "sourceId",
      SHARED_LIMITS.maxSourceIdLength,
    );
    const title = assertBoundedText(value.title, "title", SHARED_LIMITS.maxTitleLength);
    if (!isSharedVisibility(value.visibility)) throw corruptStore();
    if (
      typeof value.revision !== "number" ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < 1
    ) {
      throw corruptStore();
    }
    const createdAt = requireIsoDate(value.createdAt);
    const updatedAt = requireIsoDate(value.updatedAt);

    const document = validateDocumentStructure(value.document);
    // Stored documents are canonicalized by this module. Reject reordered or
    // mutated bytes rather than silently accepting a different graph.
    if (JSON.stringify(document) !== JSON.stringify(value.document)) throw corruptStore();
    const sceneCount = document.scenes.length;
    if (value.sceneCount !== sceneCount) throw corruptStore();
    const coverUrl = document.scenes[0]?.imageUrl ?? null;
    if (value.coverUrl !== coverUrl) throw corruptStore();
    if (
      typeof value.contentHash !== "string" ||
      !CONTENT_HASH_PATTERN.test(value.contentHash) ||
      value.contentHash !== hashDocument(document)
    ) {
      throw corruptStore();
    }

    return {
      id: value.id,
      ownerKey: value.ownerKey,
      sourceId,
      title,
      visibility: value.visibility,
      revision: value.revision,
      createdAt,
      updatedAt,
      sceneCount,
      coverUrl,
      contentHash: value.contentHash,
      document,
    };
  } catch (error) {
    if (error instanceof SharedStoriesError && error.code === "store_corrupt") throw error;
    throw corruptStore();
  }
}

function validateStoreState(value: unknown): StoreState {
  if (!isPlainObject(value)) throw corruptStore();
  assertAllowedKeys(value, ["schema", "stories"]);
  if (value.schema !== SHARED_STORE_SCHEMA) throw corruptStore();
  if (!Array.isArray(value.stories)) throw corruptStore();
  if (value.stories.length > MAX_STORIES_GLOBAL) throw corruptStore();

  const stories = value.stories.map(validateStoredRecord);
  const ids = new Set<string>();
  const ownerSources = new Set<string>();
  const perOwner = new Map<string, number>();

  for (const story of stories) {
    if (ids.has(story.id)) throw corruptStore();
    ids.add(story.id);
    const ownerSource = `${story.ownerKey}\u0000${story.sourceId}`;
    if (ownerSources.has(ownerSource)) throw corruptStore();
    ownerSources.add(ownerSource);
    const count = (perOwner.get(story.ownerKey) ?? 0) + 1;
    if (count > MAX_STORIES_PER_OWNER) throw corruptStore();
    perOwner.set(story.ownerKey, count);
  }

  return { schema: SHARED_STORE_SCHEMA, stories };
}

function emptyState(): StoreState {
  return { schema: SHARED_STORE_SCHEMA, stories: [] };
}

export function deriveOwnerKey(userId: string, authType = ""): string {
  if (typeof userId !== "string" || userId.length === 0 || userId.length > 512) {
    throw new SharedStoriesError("unauthorized", 401, "Login required.");
  }
  return createHash("sha256")
    .update("shared-stories-owner-v1\u0000")
    .update(authType)
    .update("\u0000")
    .update(userId)
    .digest("hex");
}

/**
 * Filesystem-backed store. The constructor is injectable for temporary-dir
 * tests and is completely independent of the production enable flag; callers
 * that want production configuration checks use createSharedStoriesServiceFromEnv.
 */
export class SharedStoriesRepository {
  readonly root: string;
  private readonly validateMedia: SharedMediaValidator;
  private readonly lockTimeoutMs: number;
  private readonly now: () => Date;

  constructor(root: string, options: SharedStoriesRepositoryOptions = {}) {
    if (typeof root !== "string" || root.trim().length === 0 || !path.isAbsolute(root)) {
      throw disabled();
    }
    this.root = path.resolve(root);
    this.validateMedia = options.validateMedia ?? createMediaValidator();
    const requestedTimeout = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.lockTimeoutMs = Math.max(50, Math.min(requestedTimeout, 5_000));
    this.now = options.now ?? (() => new Date());
    assertRootSync(this.root);
  }

  private statePath(): string {
    return path.join(this.root, STATE_FILE_NAME);
  }

  private lockPath(): string {
    return path.join(this.root, LOCK_DIRECTORY_NAME);
  }

  private async assertRootAsync(): Promise<void> {
    await assertNoSymlinkChain(this.root);
    let info;
    try {
      info = await lstat(this.root);
    } catch {
      throw storeUnavailable();
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw storeUnavailable();
    try {
      const real = await realpath(this.root);
      if (normalizedForCompare(real) !== normalizedForCompare(this.root)) {
        throw storeUnavailable();
      }
    } catch (error) {
      if (error instanceof SharedStoriesError) throw error;
      throw storeUnavailable();
    }
  }

  private async readState(): Promise<StoreState> {
    const statePath = this.statePath();
    await assertNoSymlinkChain(statePath);

    let info;
    try {
      info = await lstat(statePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
      throw storeUnavailable();
    }
    if (info.isSymbolicLink() || !info.isFile()) throw corruptStore();
    if (info.size > MAX_STATE_BYTES) throw corruptStore();

    try {
      const realRoot = await realpath(this.root);
      const realState = await realpath(statePath);
      const expected = path.join(realRoot, STATE_FILE_NAME);
      if (normalizedForCompare(realState) !== normalizedForCompare(expected)) {
        throw corruptStore();
      }
    } catch (error) {
      if (error instanceof SharedStoriesError) throw error;
      throw corruptStore();
    }

    let bytes: Buffer;
    try {
      bytes = await readFile(statePath);
    } catch {
      throw corruptStore();
    }

    let parsed: unknown;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      parsed = JSON.parse(text);
    } catch {
      throw corruptStore();
    }
    return validateStoreState(parsed);
  }

  private async writeState(state: StoreState): Promise<void> {
    const perOwner = new Map<string, number>();
    for (const story of state.stories) {
      perOwner.set(story.ownerKey, (perOwner.get(story.ownerKey) ?? 0) + 1);
    }
    if (state.stories.length > MAX_STORIES_GLOBAL) throw capacityReached();
    for (const count of perOwner.values()) {
      if (count > MAX_STORIES_PER_OWNER) throw capacityReached();
    }

    const serialized = `${JSON.stringify(state)}\n`;
    const byteLength = Buffer.byteLength(serialized, "utf8");
    if (byteLength > MAX_STATE_BYTES) throw sizeLimit();

    const statePath = this.statePath();
    const tempPath = path.join(
      this.root,
      `.state.${process.pid}.${randomBytes(12).toString("hex")}.tmp`,
    );
    await assertNoSymlinkChain(statePath);

    let handle;
    try {
      handle = await open(tempPath, "wx", 0o600);
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    } catch {
      await unlink(tempPath).catch(() => undefined);
      throw storeUnavailable();
    } finally {
      await handle?.close().catch(() => undefined);
    }

    try {
      await rename(tempPath, statePath);
      // Best-effort directory sync; not supported on every platform.
      try {
        const directory = await open(this.root, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } catch {
        // Ignore: the temp file itself was fsynced before rename.
      }
    } catch {
      await unlink(tempPath).catch(() => undefined);
      throw storeUnavailable();
    }
  }

  private async withStoreLock<T>(transaction: (state: StoreState) => Promise<T>): Promise<T> {
    await this.assertRootAsync();
    const lockPath = this.lockPath();
    await assertNoSymlinkChain(lockPath);

    const deadline = Date.now() + this.lockTimeoutMs;
    for (;;) {
      try {
        await mkdir(lockPath);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw storeUnavailable();
        let info;
        try {
          info = await lstat(lockPath);
        } catch {
          throw storeUnavailable();
        }
        if (info.isSymbolicLink() || !info.isDirectory()) {
          // A stale file/symlink in the lock slot is an operator problem. Never
          // break or remove it automatically.
          throw lockBusy();
        }
        if (Date.now() >= deadline) throw lockBusy();
        await delay(20 + Math.floor(Math.random() * 20));
      }
    }

    try {
      const state = await this.readState();
      return await transaction(state);
    } finally {
      try {
        const info = await lstat(lockPath);
        if (info.isDirectory() && !info.isSymbolicLink()) {
          await rmdir(lockPath);
        }
      } catch {
        // Lock cleanup is best effort; a stale lock fails closed for operators.
      }
    }
  }

  async getStory(id: string): Promise<SharedStoryRecord | null> {
    await this.assertRootAsync();
    const state = await this.readState();
    return state.stories.find((story) => story.id === id) ?? null;
  }

  async getStoryForOwner(id: string, ownerKey: string): Promise<SharedStoryRecord | null> {
    await this.assertRootAsync();
    const state = await this.readState();
    const story = state.stories.find((candidate) => candidate.id === id);
    if (!story || story.ownerKey !== ownerKey) return null;
    return story;
  }

  async listStories(options: {
    ownerKey?: string;
    offset: number;
    limit: number;
  }): Promise<{ records: SharedStoryRecord[]; hasMore: boolean }> {
    if (
      !Number.isSafeInteger(options.offset) ||
      options.offset < 0 ||
      !Number.isSafeInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > 50
    ) {
      throw new SharedStoriesError("invalid_request", 400, "Invalid list cursor or limit.");
    }
    await this.assertRootAsync();
    const state = await this.readState();
    const filtered = state.stories.filter((story) =>
      options.ownerKey === undefined
        ? story.visibility === "public"
        : story.ownerKey === options.ownerKey,
    );
    // Deterministic ordering: newest first, then stable id.
    filtered.sort((a, b) => {
      const created = b.createdAt.localeCompare(a.createdAt);
      return created !== 0 ? created : a.id.localeCompare(b.id);
    });
    const records = filtered.slice(options.offset, options.offset + options.limit);
    return {
      records,
      hasMore: options.offset + records.length < filtered.length,
    };
  }

  async createStory(
    input: CreateRecordInput,
    validateMediaOverride?: SharedMediaValidator,
  ): Promise<{ record: SharedStoryRecord; created: boolean }> {
    if (!OWNER_KEY_PATTERN.test(input.ownerKey)) {
      throw new SharedStoriesError("unauthorized", 401, "Login required.");
    }
    const sourceId = assertBoundedText(
      input.sourceId,
      "sourceId",
      SHARED_LIMITS.maxSourceIdLength,
    );
    const title = assertBoundedText(input.title, "title", SHARED_LIMITS.maxTitleLength);
    const document = validateDocumentStructure(input.document);
    if (input.visibility !== undefined && !isSharedVisibility(input.visibility)) {
      throw new SharedStoriesError("invalid_request", 400, "visibility must be public or hidden.");
    }
    if (input.expectedRevision !== undefined) {
      if (
        !Number.isSafeInteger(input.expectedRevision) ||
        input.expectedRevision < 1 ||
        input.expectedRevision > SHARED_LIMITS.maxExpectedRevision
      ) {
        throw new SharedStoriesError(
          "invalid_request",
          400,
          "expectedRevision must be a positive integer.",
        );
      }
    }

    // Media checks touch only local bytes (or pure inline bytes), never network.
    const mediaValidator = validateMediaOverride ?? this.validateMedia;
    for (const scene of document.scenes) {
      await mediaValidator(scene.imageUrl);
    }

    const contentHash = hashDocument(document);

    return this.withStoreLock(async (state) => {
      const existingIndex = state.stories.findIndex(
        (story) => story.ownerKey === input.ownerKey && story.sourceId === sourceId,
      );

      if (existingIndex === -1) {
        const ownerCount = state.stories.reduce(
          (count, story) => count + (story.ownerKey === input.ownerKey ? 1 : 0),
          0,
        );
        if (ownerCount >= MAX_STORIES_PER_OWNER || state.stories.length >= MAX_STORIES_GLOBAL) {
          throw capacityReached();
        }
        const timestamp = this.now().toISOString();
        const record: SharedStoryRecord = {
          id: randomUUID(),
          ownerKey: input.ownerKey,
          sourceId,
          title,
          visibility: input.visibility ?? "public",
          revision: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
          sceneCount: document.scenes.length,
          coverUrl: document.scenes[0]?.imageUrl ?? null,
          contentHash,
          document,
        };
        state.stories.push(record);
        await this.writeState(state);
        return { record, created: true };
      }

      const existing = state.stories[existingIndex]!;
      const nextVisibility = input.visibility ?? existing.visibility;
      const changed =
        existing.title !== title ||
        existing.visibility !== nextVisibility ||
        existing.contentHash !== contentHash;

      if (!changed) {
        return { record: existing, created: false };
      }
      if (input.expectedRevision === undefined) throw revisionRequired();
      if (input.expectedRevision !== existing.revision) throw revisionConflict();

      const timestamp = this.now().toISOString();
      const updated: SharedStoryRecord = {
        ...existing,
        title,
        visibility: nextVisibility,
        revision: existing.revision + 1,
        updatedAt: timestamp,
        sceneCount: document.scenes.length,
        coverUrl: document.scenes[0]?.imageUrl ?? null,
        contentHash,
        document,
      };
      state.stories[existingIndex] = updated;
      await this.writeState(state);
      return { record: updated, created: false };
    });
  }

  async updateVisibility(input: {
    id: string;
    ownerKey: string;
    visibility: SharedVisibility;
    expectedRevision: number;
  }): Promise<SharedStoryRecord> {
    if (!OWNER_KEY_PATTERN.test(input.ownerKey)) {
      throw new SharedStoriesError("unauthorized", 401, "Login required.");
    }
    if (!isSharedVisibility(input.visibility)) {
      throw new SharedStoriesError("invalid_request", 400, "visibility must be public or hidden.");
    }
    if (
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 1 ||
      input.expectedRevision > SHARED_LIMITS.maxExpectedRevision
    ) {
      throw new SharedStoriesError(
        "invalid_request",
        400,
        "expectedRevision must be a positive integer.",
      );
    }

    return this.withStoreLock(async (state) => {
      const index = state.stories.findIndex((story) => story.id === input.id);
      if (index === -1) throw notFound();
      const existing = state.stories[index]!;
      // Wrong owner and unknown id are indistinguishable.
      if (existing.ownerKey !== input.ownerKey) throw notFound();
      if (existing.revision !== input.expectedRevision) throw revisionConflict();
      if (existing.visibility === input.visibility) return existing;

      const updated: SharedStoryRecord = {
        ...existing,
        visibility: input.visibility,
        revision: existing.revision + 1,
        updatedAt: this.now().toISOString(),
      };
      state.stories[index] = updated;
      await this.writeState(state);
      return updated;
    });
  }
}
