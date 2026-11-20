import "server-only";

import {
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import type {
  VideoAssetReleasePolicy,
  VideoAssetStatus,
  VideoProbeResult,
  VideoSubtitleCue,
} from "./types";

export type VideoAssetStorageReference =
  | {
      kind: "local";
      fileName: string;
    }
  | {
      kind: "object";
      provider: "aliyun_oss";
      objectKey: string;
      etag?: string;
    };

export type StoredVideoAsset = VideoProbeResult & {
  id: string;
  tenantId: string;
  contentHash: string;
  contentType: "video/mp4" | "video/webm";
  bytes: number;
  storage: VideoAssetStorageReference;
  status: VideoAssetStatus;
  releasePolicy: VideoAssetReleasePolicy;
  projectId?: number;
  storyId?: string;
  nodeId?: string;
  title: string;
  subtitles: VideoSubtitleCue[];
  source: "upload" | "generation_job";
  generation?: {
    jobId: string;
    provider: string;
    workflowId?: string;
    workflowVersion?: number;
    seed?: number;
  };
  createdAt: string;
  updatedAt: string;
  reviewNote?: string;
  /** Production-only optimistic concurrency token; never projected to a DTO. */
  revision?: number;
};

export type VideoAssetIdempotency = {
  key: string;
  fingerprint: string;
  assetId: string;
  operation: "upload" | "adopt" | "mutation";
  createdAt: string;
};

export type VideoAssetAudit = {
  id: string;
  actorId: string;
  action: string;
  assetId: string;
  reason: string;
  requestId: string;
  createdAt: string;
};

type VideoAssetStore = {
  schemaVersion: 1;
  assets: StoredVideoAsset[];
  idempotency: VideoAssetIdempotency[];
  audit: VideoAssetAudit[];
};

/**
 * Production implementations must scope every method to `tenantId` and commit
 * an asset/idempotency/audit tuple atomically. Audit entries are append-only;
 * mutation replays return the existing result without appending a second row.
 */
export interface VideoAssetRepository {
  readonly source: "local_development" | "production_database";
  readonly tenantId: string;
  list(): Promise<StoredVideoAsset[]>;
  get(id: string): Promise<StoredVideoAsset | undefined>;
  findIdempotency(
    key: string,
  ): Promise<VideoAssetIdempotency | undefined>;
  hasObjectReference(objectKey: string): Promise<boolean>;
  create(
    asset: StoredVideoAsset,
    idempotency: VideoAssetIdempotency,
    audit: VideoAssetAudit,
  ): Promise<{ asset: StoredVideoAsset; created: boolean }>;
  mutateAsset(
    id: string,
    idempotency: VideoAssetIdempotency,
    audit: VideoAssetAudit,
    update: (asset: StoredVideoAsset) => void,
  ): Promise<{ asset: StoredVideoAsset; changed: boolean }>;
}

const DEFAULT_ROOT = path.join(
  /* turbopackIgnore: true */
  process.cwd(),
  ".aistory-video-assets",
);

function emptyStore(): VideoAssetStore {
  return { schemaVersion: 1, assets: [], idempotency: [], audit: [] };
}

type LegacyStoredVideoAsset = Omit<StoredVideoAsset, "tenantId" | "storage"> & {
  tenantId?: string;
  storage?: VideoAssetStorageReference;
  storageFile?: string;
};

function normalizeLocalAsset(
  value: LegacyStoredVideoAsset,
  tenantId: string,
): StoredVideoAsset {
  const storage = value.storage ??
    (typeof value.storageFile === "string"
      ? { kind: "local" as const, fileName: value.storageFile }
      : undefined);
  if (
    !storage ||
    storage.kind !== "local" ||
    !/^[a-f0-9]{64}\.(?:mp4|webm)$/i.test(storage.fileName)
  ) {
    throw new Error("Invalid local video asset storage record.");
  }
  if (value.tenantId && value.tenantId !== tenantId) {
    throw new Error("Video asset tenant mismatch.");
  }
  const asset = { ...value };
  delete asset.storageFile;
  return {
    ...asset,
    tenantId,
    storage,
  };
}

export class LocalVideoAssetRepository implements VideoAssetRepository {
  readonly source = "local_development" as const;
  private mutationQueue = Promise.resolve();

  constructor(
    readonly rootDir = process.env.AISTORY_VIDEO_ASSET_DIR || DEFAULT_ROOT,
    readonly tenantId = "local-development",
  ) {}

  mediaDir(): string {
    return path.join(this.rootDir, "media");
  }

  private targetFile(): string {
    return path.join(this.rootDir, "video-assets.json");
  }

  private backupFile(): string {
    return path.join(this.rootDir, "video-assets.previous.json");
  }

  private async parseFile(file: string): Promise<VideoAssetStore> {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Omit<
      VideoAssetStore,
      "assets"
    > & { assets: LegacyStoredVideoAsset[] };
    if (
      parsed.schemaVersion !== 1 ||
      !Array.isArray(parsed.assets) ||
      !Array.isArray(parsed.idempotency) ||
      !Array.isArray(parsed.audit)
    ) {
      throw new Error("Unsupported video asset store schema.");
    }
    return {
      ...parsed,
      assets: parsed.assets.map((asset) =>
        normalizeLocalAsset(asset, this.tenantId),
      ),
    };
  }

  private async readStore(): Promise<VideoAssetStore> {
    let firstError: unknown;
    for (const file of [this.targetFile(), this.backupFile()]) {
      try {
        return await this.parseFile(file);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (
      firstError &&
      typeof firstError === "object" &&
      "code" in firstError &&
      firstError.code === "ENOENT"
    ) {
      return emptyStore();
    }
    throw firstError;
  }

  private async writeStore(store: VideoAssetStore): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    const target = this.targetFile();
    const backup = this.backupFile();
    const temp = path.join(
      this.rootDir,
      `.video-assets-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
    );
    let movedPrimary = false;
    try {
      await writeFile(temp, JSON.stringify(store, null, 2), {
        encoding: "utf8",
        flag: "wx",
      });
      await unlink(backup).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      await rename(target, backup)
        .then(() => {
          movedPrimary = true;
        })
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      await rename(temp, target);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      if (movedPrimary) await rename(backup, target).catch(() => undefined);
      throw error;
    }
  }

  private async mutate<T>(
    operation: (store: VideoAssetStore) => Promise<T> | T,
  ): Promise<T> {
    let release: (() => void) | undefined;
    const previous = this.mutationQueue;
    this.mutationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const store = await this.readStore();
      const result = await operation(store);
      await this.writeStore(store);
      return result;
    } finally {
      release?.();
    }
  }

  async list(): Promise<StoredVideoAsset[]> {
    return (await this.readStore()).assets
      .slice()
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((asset) => structuredClone(asset));
  }

  async get(id: string): Promise<StoredVideoAsset | undefined> {
    const asset = (await this.readStore()).assets.find((item) => item.id === id);
    return asset ? structuredClone(asset) : undefined;
  }

  async findIdempotency(
    key: string,
  ): Promise<VideoAssetIdempotency | undefined> {
    const record = (await this.readStore()).idempotency.find(
      (item) => item.key === key,
    );
    return record ? structuredClone(record) : undefined;
  }

  async hasObjectReference(objectKey: string): Promise<boolean> {
    void objectKey;
    return false;
  }

  async create(
    asset: StoredVideoAsset,
    idempotency: VideoAssetIdempotency,
    audit: VideoAssetAudit,
  ): Promise<{ asset: StoredVideoAsset; created: boolean }> {
    if (
      asset.tenantId !== this.tenantId ||
      asset.storage.kind !== "local"
    ) {
      throw new Error("视频资产不属于当前本地租户或存储适配器。");
    }
    return this.mutate((store) => {
      const replay = store.idempotency.find(
        (item) => item.key === idempotency.key,
      );
      if (replay) {
        if (replay.fingerprint !== idempotency.fingerprint) {
          throw new Error("幂等键已用于不同的视频资产请求。");
        }
        const existing = store.assets.find(
          (item) => item.id === replay.assetId,
        );
        if (!existing) throw new Error("视频资产幂等记录损坏。");
        return { asset: structuredClone(existing), created: false };
      }
      store.assets.push(structuredClone(asset));
      store.idempotency.push(structuredClone(idempotency));
      store.audit.push(structuredClone(audit));
      return { asset: structuredClone(asset), created: true };
    });
  }

  async mutateAsset(
    id: string,
    idempotency: VideoAssetIdempotency,
    audit: VideoAssetAudit,
    update: (asset: StoredVideoAsset) => void,
  ): Promise<{ asset: StoredVideoAsset; changed: boolean }> {
    return this.mutate((store) => {
      const replay = store.idempotency.find(
        (item) => item.key === idempotency.key,
      );
      if (replay) {
        if (
          replay.fingerprint !== idempotency.fingerprint ||
          replay.assetId !== id
        ) {
          throw new Error("幂等键已用于不同的视频资产操作。");
        }
        const existing = store.assets.find((item) => item.id === id);
        if (!existing) throw new Error("视频资产不存在。");
        return { asset: structuredClone(existing), changed: false };
      }
      const asset = store.assets.find((item) => item.id === id);
      if (!asset) throw new Error("视频资产不存在。");
      update(asset);
      asset.updatedAt = new Date().toISOString();
      store.idempotency.push(structuredClone(idempotency));
      store.audit.push(structuredClone(audit));
      return { asset: structuredClone(asset), changed: true };
    });
  }
}

let singleton: LocalVideoAssetRepository | undefined;

export function getLocalVideoAssetRepository(): LocalVideoAssetRepository {
  const root = process.env.AISTORY_VIDEO_ASSET_DIR || DEFAULT_ROOT;
  if (!singleton || singleton.rootDir !== root) {
    singleton = new LocalVideoAssetRepository(root);
  }
  return singleton;
}

