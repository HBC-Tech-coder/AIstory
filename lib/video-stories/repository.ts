import "server-only";

import {
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import type {
  VideoStoryDraft,
  VideoStoryPublicReleaseSummary,
} from "./types";

export type StoredVideoStoryRelease = VideoStoryPublicReleaseSummary & {
  artifactFile: string;
  draftId: string;
};

export type VideoStoryAudit = {
  id: string;
  actorId: string;
  action: string;
  storyId: string;
  reason: string;
  requestId: string;
  createdAt: string;
};

type VideoStoryIdempotency = {
  key: string;
  fingerprint: string;
  draftId: string;
  releaseId?: string;
  createdAt: string;
};

type VideoStoryStore = {
  schemaVersion: 1;
  drafts: VideoStoryDraft[];
  releases: StoredVideoStoryRelease[];
  idempotency: VideoStoryIdempotency[];
  audit: VideoStoryAudit[];
};

const DEFAULT_ROOT = path.join(
  /* turbopackIgnore: true */
  process.cwd(),
  ".aistory-video-stories",
);

function emptyStore(): VideoStoryStore {
  return {
    schemaVersion: 1,
    drafts: [],
    releases: [],
    idempotency: [],
    audit: [],
  };
}

export class LocalVideoStoryRepository {
  readonly source = "local_development" as const;
  private mutationQueue = Promise.resolve();

  constructor(
    readonly rootDir =
      process.env.AISTORY_VIDEO_STORY_DIR || DEFAULT_ROOT,
  ) {}

  private targetFile(): string {
    return path.join(this.rootDir, "video-stories.json");
  }

  private backupFile(): string {
    return path.join(this.rootDir, "video-stories.previous.json");
  }

  private releaseDir(): string {
    return path.join(this.rootDir, "releases");
  }

  private async parseFile(file: string): Promise<VideoStoryStore> {
    const parsed = JSON.parse(await readFile(file, "utf8")) as VideoStoryStore;
    if (
      parsed.schemaVersion !== 1 ||
      !Array.isArray(parsed.drafts) ||
      !Array.isArray(parsed.releases) ||
      !Array.isArray(parsed.idempotency) ||
      !Array.isArray(parsed.audit)
    ) {
      throw new Error("Unsupported video story store schema.");
    }
    return parsed;
  }

  private async readStore(): Promise<VideoStoryStore> {
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

  private async writeStore(store: VideoStoryStore): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    const target = this.targetFile();
    const backup = this.backupFile();
    const temp = path.join(
      this.rootDir,
      `.video-stories-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
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
    operation: (store: VideoStoryStore) => Promise<T> | T,
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

  async listDrafts(): Promise<VideoStoryDraft[]> {
    return (await this.readStore()).drafts
      .slice()
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((draft) => structuredClone(draft));
  }

  async getDraft(id: string): Promise<VideoStoryDraft | undefined> {
    const draft = (await this.readStore()).drafts.find((item) => item.id === id);
    return draft ? structuredClone(draft) : undefined;
  }

  async getPublishedRelease(
    storyId: string,
  ): Promise<StoredVideoStoryRelease | undefined> {
    const store = await this.readStore();
    const release = store.releases
      .filter((item) => item.storyId === storyId && item.status === "published")
      .sort((left, right) => right.publishedAt.localeCompare(left.publishedAt))[0];
    return release ? structuredClone(release) : undefined;
  }

  async createDraft(
    draft: VideoStoryDraft,
    idempotency: VideoStoryIdempotency,
    audit: VideoStoryAudit,
  ): Promise<{ draft: VideoStoryDraft; created: boolean }> {
    return this.mutate((store) => {
      const replay = store.idempotency.find(
        (item) => item.key === idempotency.key,
      );
      if (replay) {
        if (replay.fingerprint !== idempotency.fingerprint) {
          throw new Error("幂等键已用于不同的视频剧情请求。");
        }
        const existing = store.drafts.find((item) => item.id === replay.draftId);
        if (!existing) throw new Error("视频剧情幂等记录损坏。");
        return { draft: structuredClone(existing), created: false };
      }
      if (store.drafts.some((item) => item.id === draft.id)) {
        throw new Error("视频剧情草稿 ID 已存在。");
      }
      store.drafts.push(structuredClone(draft));
      store.idempotency.push(structuredClone(idempotency));
      store.audit.push(structuredClone(audit));
      return { draft: structuredClone(draft), created: true };
    });
  }

  async mutateDraft(
    id: string,
    idempotency: VideoStoryIdempotency,
    audit: VideoStoryAudit,
    update: (
      draft: VideoStoryDraft,
      store: {
        releases: StoredVideoStoryRelease[];
      },
    ) => { release?: StoredVideoStoryRelease } | void,
  ): Promise<{
    draft: VideoStoryDraft;
    release?: StoredVideoStoryRelease;
    changed: boolean;
  }> {
    return this.mutate((store) => {
      const replay = store.idempotency.find(
        (item) => item.key === idempotency.key,
      );
      if (replay) {
        if (
          replay.fingerprint !== idempotency.fingerprint ||
          replay.draftId !== id
        ) {
          throw new Error("幂等键已用于不同的视频剧情操作。");
        }
        const existing = store.drafts.find((item) => item.id === id);
        if (!existing) throw new Error("视频剧情不存在。");
        const release = replay.releaseId
          ? store.releases.find((item) => item.releaseId === replay.releaseId)
          : undefined;
        return {
          draft: structuredClone(existing),
          ...(release ? { release: structuredClone(release) } : {}),
          changed: false,
        };
      }
      const draft = store.drafts.find((item) => item.id === id);
      if (!draft) throw new Error("视频剧情不存在。");
      const result = update(draft, { releases: store.releases });
      const release = result?.release;
      store.idempotency.push({
        ...structuredClone(idempotency),
        ...(release ? { releaseId: release.releaseId } : {}),
      });
      store.audit.push(structuredClone(audit));
      return {
        draft: structuredClone(draft),
        ...(release ? { release: structuredClone(release) } : {}),
        changed: true,
      };
    });
  }

  async writeReleaseArtifact(contentHash: string, bytes: string): Promise<string> {
    if (!/^[a-f0-9]{64}$/.test(contentHash)) {
      throw new Error("发布物内容哈希不合法。");
    }
    await mkdir(this.releaseDir(), { recursive: true });
    const artifactFile = `${contentHash}.json`;
    const target = path.join(this.releaseDir(), artifactFile);
    const temp = path.join(
      this.releaseDir(),
      `.${contentHash}-${process.pid}-${Date.now()}.tmp`,
    );
    try {
      await writeFile(temp, bytes, { encoding: "utf8", flag: "wx" });
      try {
        await rename(temp, target);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST" && code !== "EPERM") throw error;
        const existing = await readFile(target, "utf8");
        if (existing !== bytes) {
          throw new Error("发布物内容寻址文件冲突。");
        }
        await unlink(temp).catch(() => undefined);
      }
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error;
    }
    const checked = await stat(target);
    if (!checked.isFile() || checked.size !== Buffer.byteLength(bytes, "utf8")) {
      throw new Error("发布物写入校验失败。");
    }
    return artifactFile;
  }

  async readReleaseArtifact(release: StoredVideoStoryRelease): Promise<string> {
    if (!/^[a-f0-9]{64}\.json$/.test(release.artifactFile)) {
      throw new Error("发布物路径不合法。");
    }
    return readFile(path.join(this.releaseDir(), release.artifactFile), "utf8");
  }
}

let singleton: LocalVideoStoryRepository | undefined;

export function getLocalVideoStoryRepository(): LocalVideoStoryRepository {
  const root = process.env.AISTORY_VIDEO_STORY_DIR || DEFAULT_ROOT;
  if (!singleton || singleton.rootDir !== root) {
    singleton = new LocalVideoStoryRepository(root);
  }
  return singleton;
}
