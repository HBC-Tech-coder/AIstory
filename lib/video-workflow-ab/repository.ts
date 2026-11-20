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

import type { StoredVideoWorkflowABExperiment } from "./types";

export type VideoWorkflowABAudit = {
  id: string;
  actorId: string;
  action: string;
  experimentId: string;
  reason: string;
  requestId: string;
  createdAt: string;
};

export type VideoWorkflowABIdempotency = {
  key: string;
  fingerprint: string;
  experimentId: string;
  operation: "import" | "review" | "transition" | "adopt";
  createdAt: string;
};

type VideoWorkflowABStore = {
  schemaVersion: 1;
  experiments: StoredVideoWorkflowABExperiment[];
  idempotency: VideoWorkflowABIdempotency[];
  audit: VideoWorkflowABAudit[];
};

const DEFAULT_ROOT = path.join(
  /* turbopackIgnore: true */
  process.cwd(),
  ".aistory-video-ab",
);

function emptyStore(): VideoWorkflowABStore {
  return { schemaVersion: 1, experiments: [], idempotency: [], audit: [] };
}

function extensionFor(contentType: string): string {
  if (contentType === "video/mp4") return ".mp4";
  if (contentType === "video/webm") return ".webm";
  if (contentType === "image/png") return ".png";
  if (contentType === "image/jpeg") return ".jpg";
  if (contentType === "image/webp") return ".webp";
  if (contentType === "application/json") return ".json";
  throw new Error("Unsupported A/B artifact content type.");
}

export class LocalVideoWorkflowABRepository {
  readonly source = "local_development" as const;
  private mutationQueue = Promise.resolve();

  constructor(
    readonly rootDir =
      process.env.AISTORY_VIDEO_AB_DIR || DEFAULT_ROOT,
  ) {}

  private targetFile(): string {
    return path.join(this.rootDir, "video-workflow-ab.json");
  }

  private backupFile(): string {
    return path.join(this.rootDir, "video-workflow-ab.previous.json");
  }

  private artifactRoot(): string {
    return path.join(this.rootDir, "artifacts");
  }

  private workflowRoot(): string {
    return path.join(this.rootDir, "workflows");
  }

  private async parseFile(file: string): Promise<VideoWorkflowABStore> {
    const parsed = JSON.parse(await readFile(file, "utf8")) as VideoWorkflowABStore;
    if (
      parsed.schemaVersion !== 1 ||
      !Array.isArray(parsed.experiments) ||
      !Array.isArray(parsed.idempotency) ||
      !Array.isArray(parsed.audit)
    ) {
      throw new Error("Unsupported A/B experiment store schema.");
    }
    return parsed;
  }

  private async readStore(): Promise<VideoWorkflowABStore> {
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

  private async writeStore(store: VideoWorkflowABStore): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    const target = this.targetFile();
    const backup = this.backupFile();
    const temp = path.join(
      this.rootDir,
      `.video-workflow-ab-${process.pid}-${Date.now()}-${Math.random()
        .toString(16)
        .slice(2)}.tmp`,
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
    operation: (store: VideoWorkflowABStore) => Promise<T> | T,
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

  async list(): Promise<StoredVideoWorkflowABExperiment[]> {
    return (await this.readStore()).experiments
      .slice()
      .sort((left, right) => right.importedAt.localeCompare(left.importedAt))
      .map((experiment) => structuredClone(experiment));
  }

  async get(id: string): Promise<StoredVideoWorkflowABExperiment | undefined> {
    const experiment = (await this.readStore()).experiments.find(
      (item) => item.id === id,
    );
    return experiment ? structuredClone(experiment) : undefined;
  }

  async findIdempotency(
    key: string,
  ): Promise<VideoWorkflowABIdempotency | undefined> {
    const record = (await this.readStore()).idempotency.find(
      (item) => item.key === key,
    );
    return record ? structuredClone(record) : undefined;
  }

  async create(
    experiment: StoredVideoWorkflowABExperiment,
    idempotency: VideoWorkflowABIdempotency,
    audit: VideoWorkflowABAudit,
  ): Promise<{ experiment: StoredVideoWorkflowABExperiment; created: boolean }> {
    return this.mutate((store) => {
      const replay = store.idempotency.find(
        (item) => item.key === idempotency.key,
      );
      if (replay) {
        if (replay.fingerprint !== idempotency.fingerprint) {
          throw new Error("Idempotency key conflicts with another A/B import.");
        }
        const existing = store.experiments.find(
          (item) => item.id === replay.experimentId,
        );
        if (!existing) throw new Error("A/B idempotency record is incomplete.");
        return { experiment: structuredClone(existing), created: false };
      }
      if (store.experiments.some((item) => item.id === experiment.id)) {
        throw new Error("A/B experiment id already exists.");
      }
      store.experiments.push(structuredClone(experiment));
      store.idempotency.push(structuredClone(idempotency));
      store.audit.push(structuredClone(audit));
      return { experiment: structuredClone(experiment), created: true };
    });
  }

  async mutateExperiment(
    id: string,
    idempotency: VideoWorkflowABIdempotency,
    audit: VideoWorkflowABAudit,
    update: (experiment: StoredVideoWorkflowABExperiment) => void,
  ): Promise<{ experiment: StoredVideoWorkflowABExperiment; changed: boolean }> {
    return this.mutate((store) => {
      const replay = store.idempotency.find(
        (item) => item.key === idempotency.key,
      );
      if (replay) {
        if (
          replay.fingerprint !== idempotency.fingerprint ||
          replay.experimentId !== id
        ) {
          throw new Error("Idempotency key conflicts with another A/B operation.");
        }
        const existing = store.experiments.find((item) => item.id === id);
        if (!existing) throw new Error("A/B experiment does not exist.");
        return { experiment: structuredClone(existing), changed: false };
      }
      const experiment = store.experiments.find((item) => item.id === id);
      if (!experiment) throw new Error("A/B experiment does not exist.");
      update(experiment);
      store.idempotency.push(structuredClone(idempotency));
      store.audit.push(structuredClone(audit));
      return { experiment: structuredClone(experiment), changed: true };
    });
  }

  async writeContentAddressedFile(
    kind: "artifact" | "workflow",
    sha256: string,
    contentType: string,
    bytes: Uint8Array,
  ): Promise<string> {
    if (!/^[a-f0-9]{64}$/.test(sha256)) {
      throw new Error("A/B content hash is invalid.");
    }
    const actual = await import("node:crypto").then(({ createHash }) =>
      createHash("sha256").update(bytes).digest("hex"),
    );
    if (actual !== sha256) throw new Error("A/B content hash does not match.");
    const directory =
      kind === "workflow" ? this.workflowRoot() : this.artifactRoot();
    await mkdir(directory, { recursive: true });
    const file = `${sha256}${extensionFor(contentType)}`;
    const target = path.join(directory, file);
    const temp = path.join(
      directory,
      `.${file}.${process.pid}-${Date.now()}-${Math.random()
        .toString(16)
        .slice(2)}.tmp`,
    );
    try {
      await writeFile(temp, bytes, { flag: "wx" });
      await rename(temp, target).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST" && error.code !== "EPERM") throw error;
        const existing = await readFile(target);
        if (
          existing.byteLength !== bytes.byteLength ||
          !existing.equals(Buffer.from(bytes))
        ) {
          throw new Error("A/B content-addressed file conflicts.");
        }
        await unlink(temp).catch(() => undefined);
      });
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error;
    }
    const checked = await stat(target);
    if (!checked.isFile() || checked.size !== bytes.byteLength) {
      throw new Error("A/B content-addressed file verification failed.");
    }
    return `${kind === "workflow" ? "workflows" : "artifacts"}/${file}`;
  }

  resolveStoredFile(relative: string): string {
    if (
      !/^(?:artifacts|workflows)\/[a-f0-9]{64}\.(?:jpe?g|json|mp4|png|webm|webp)$/i.test(
        relative,
      )
    ) {
      throw new Error("A/B stored file reference is invalid.");
    }
    const resolved = path.resolve(this.rootDir, relative);
    const root = path.resolve(this.rootDir);
    if (!resolved.startsWith(`${root}${path.sep}`)) {
      throw new Error("A/B stored file reference is invalid.");
    }
    return resolved;
  }

  async readStoredFile(relative: string): Promise<Buffer> {
    return readFile(this.resolveStoredFile(relative));
  }
}

let singleton: LocalVideoWorkflowABRepository | undefined;

export function getLocalVideoWorkflowABRepository(): LocalVideoWorkflowABRepository {
  const root = process.env.AISTORY_VIDEO_AB_DIR || DEFAULT_ROOT;
  if (!singleton || singleton.rootDir !== root) {
    singleton = new LocalVideoWorkflowABRepository(root);
  }
  return singleton;
}
