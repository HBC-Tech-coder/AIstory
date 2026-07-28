import "server-only";

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { StoredGenerationJob } from "./types";
import type { GenerationJobProvider } from "./types";

type GenerationJobStore = {
  schemaVersion: 1;
  jobs: StoredGenerationJob[];
};

const DEFAULT_ROOT = path.join(
  /* turbopackIgnore: true */
  process.cwd(),
  ".aistory-jobs",
);
let mutationQueue = Promise.resolve();

function root(): string {
  return process.env.AISTORY_GENERATION_JOB_DIR || DEFAULT_ROOT;
}

function targetFile(): string {
  return path.join(root(), "jobs.json");
}

function backupFile(): string {
  return path.join(root(), "jobs.previous.json");
}

function emptyStore(): GenerationJobStore {
  return { schemaVersion: 1, jobs: [] };
}

async function parseFile(file: string): Promise<GenerationJobStore> {
  const parsed = JSON.parse(await readFile(file, "utf8")) as GenerationJobStore;
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.jobs)) {
    throw new Error("Unsupported generation job store schema.");
  }
  return parsed;
}

async function readStore(): Promise<GenerationJobStore> {
  let firstError: unknown;
  for (const file of [targetFile(), backupFile()]) {
    try {
      return await parseFile(file);
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

async function writeStore(store: GenerationJobStore): Promise<void> {
  await mkdir(root(), { recursive: true });
  const target = targetFile();
  const backup = backupFile();
  const temp = path.join(
    root(),
    `.jobs-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
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

async function mutate<T>(
  operation: (store: GenerationJobStore) => Promise<T> | T,
): Promise<T> {
  let release: (() => void) | undefined;
  const previous = mutationQueue;
  mutationQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    const store = await readStore();
    const value = await operation(store);
    await writeStore(store);
    return value;
  } finally {
    release?.();
  }
}

export async function listStoredGenerationJobs(): Promise<StoredGenerationJob[]> {
  return (await readStore()).jobs
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getStoredGenerationJob(
  id: string,
): Promise<StoredGenerationJob | undefined> {
  return (await readStore()).jobs.find((job) => job.id === id);
}

export async function findStoredGenerationJobByFingerprint(
  fingerprint: string,
): Promise<StoredGenerationJob | undefined> {
  return (await readStore()).jobs.find(
    (job) =>
      job.requestFingerprint === fingerprint &&
      !["failed", "cancelled", "interrupted"].includes(job.status),
  );
}

export async function findStoredGenerationJobByIdempotencyKey(
  provider: GenerationJobProvider,
  idempotencyKey: string,
): Promise<StoredGenerationJob | undefined> {
  return (await readStore()).jobs.find(
    (job) =>
      job.provider === provider && job.idempotencyKey === idempotencyKey,
  );
}

export async function saveStoredGenerationJob(
  job: StoredGenerationJob,
): Promise<StoredGenerationJob> {
  return mutate((store) => {
    const index = store.jobs.findIndex((item) => item.id === job.id);
    if (index >= 0) store.jobs[index] = structuredClone(job);
    else store.jobs.push(structuredClone(job));
    return structuredClone(job);
  });
}

export async function updateStoredGenerationJob(
  id: string,
  update: (job: StoredGenerationJob) => void,
): Promise<StoredGenerationJob> {
  return mutate((store) => {
    const job = store.jobs.find((item) => item.id === id);
    if (!job) throw new Error("Generation job not found.");
    update(job);
    job.updatedAt = new Date().toISOString();
    return structuredClone(job);
  });
}

export async function recoverStoredGenerationJobs(): Promise<void> {
  await mutate((store) => {
    const now = new Date().toISOString();
    for (const job of store.jobs) {
      if (job.status === "running" || job.status === "pending") {
        job.status = "interrupted";
        job.retryable = true;
        job.errorCode = "process_restarted";
        job.updatedAt = now;
      }
    }
  });
}
