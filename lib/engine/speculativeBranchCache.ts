import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";

import type {
  EngineConfig,
  SceneStreamEvent,
  Session,
  SpeculativeBranchCacheMeta,
  SpeculativeBranchMode,
  SpeculativeBranchRequest,
  SpeculativeBranchStatus,
} from "@infiplot/types";
import {
  buildSpeculativeBranchKeys,
  clampBranchPrefetchDepth,
  normalizeSpeculation,
  type SpeculativeBranchKeys,
  type SpeculativePolicy,
} from "@/lib/speculativeBranch";

const CACHE_ROOT =
  process.env.AISTORY_CACHE_DIR || path.join(process.cwd(), ".aistory-cache");
const BRANCH_CACHE_DIR = path.join(CACHE_ROOT, "speculative-branches");
const CACHE_TTL_MS = readPositiveInt("AISTORY_BRANCH_PREFETCH_TTL_MS", 24 * 60 * 60 * 1000);
const CACHE_MAX_ENTRIES = readPositiveInt("AISTORY_BRANCH_PREFETCH_MAX_ENTRIES", 500);

type CacheEnvelope<T> = {
  version: 1;
  key: string;
  textKey: string;
  imageKey: string;
  status: SpeculativeBranchStatus;
  createdAt: number;
  updatedAt: number;
  lastAccessAt: number;
  attempts: number;
  retryAt?: number;
  data?: T;
  error?: string;
};

type BranchMetricName =
  | "prefetch_queued"
  | "prefetch_hit"
  | "partial_hit"
  | "miss"
  | "wasted"
  | "latency_saved_ms"
  | "provider_cost_estimate";

export type SpeculativeBranchMetrics = Record<BranchMetricName, number>;

const metrics: SpeculativeBranchMetrics = {
  prefetch_queued: 0,
  prefetch_hit: 0,
  partial_hit: 0,
  miss: 0,
  wasted: 0,
  latency_saved_ms: 0,
  provider_cost_estimate: 0,
};
const envelopeWriteQueues = new Map<string, Promise<void>>();

type ScheduledJob<T> = {
  key: string;
  mode: SpeculativeBranchMode;
  task: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

const scheduled = new Map<string, Promise<unknown>>();
const queuedByKey = new Map<string, ScheduledJob<unknown>>();
const foregroundQueue: ScheduledJob<unknown>[] = [];
const predictionQueue: ScheduledJob<unknown>[] = [];
let activeForeground = 0;
let activePrediction = 0;

function readPositiveInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

export function getSpeculativePolicy(): SpeculativePolicy {
  return {
    maxDepth: clampBranchPrefetchDepth(
      process.env.AISTORY_BRANCH_PREFETCH_MAX_DEPTH ?? 2,
      2,
    ),
    branchBudget: readPositiveInt("AISTORY_BRANCH_PREFETCH_BRANCH_BUDGET", 8),
    predictionConcurrency: readPositiveInt(
      "AISTORY_BRANCH_PREFETCH_CONCURRENCY",
      1,
    ),
    foregroundConcurrency: readPositiveInt(
      "AISTORY_BRANCH_FOREGROUND_CONCURRENCY",
      2,
    ),
  };
}

export function getSpeculativeBranchMetrics(): SpeculativeBranchMetrics {
  return { ...metrics };
}

export function resetSpeculativeBranchMetricsForTest(): void {
  for (const name of Object.keys(metrics) as BranchMetricName[]) metrics[name] = 0;
}

function recordMetric(name: BranchMetricName, value = 1): void {
  metrics[name] += value;
  console.log(JSON.stringify({
    event: "speculative_branch_metric",
    metric: name,
    value,
    total: metrics[name],
    at: new Date().toISOString(),
  }));
}

function cacheFile(key: string): string {
  return path.join(BRANCH_CACHE_DIR, `${key}.json`);
}

async function readEnvelope<T>(keys: SpeculativeBranchKeys): Promise<CacheEnvelope<T> | null> {
  try {
    const raw = await readFile(cacheFile(keys.key), "utf8");
    const envelope = JSON.parse(raw) as CacheEnvelope<T>;
    if (
      envelope.version !== 1 ||
      envelope.key !== keys.key ||
      envelope.textKey !== keys.textKey ||
      envelope.imageKey !== keys.imageKey
    ) {
      return null;
    }
    if (Date.now() - envelope.updatedAt > CACHE_TTL_MS) {
      await unlink(cacheFile(keys.key)).catch(() => undefined);
      return null;
    }
    envelope.lastAccessAt = Date.now();
    void writeEnvelope(envelope);
    return envelope;
  } catch {
    return null;
  }
}

async function writeEnvelope<T>(envelope: CacheEnvelope<T>): Promise<void> {
  const payload = JSON.stringify(envelope);
  const target = cacheFile(envelope.key);
  const previous = envelopeWriteQueues.get(envelope.key) || Promise.resolve();
  const current = previous.catch(() => undefined).then(async () => {
    await mkdir(BRANCH_CACHE_DIR, { recursive: true });
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, payload, "utf8");
    await rename(temporary, target);
  });
  envelopeWriteQueues.set(envelope.key, current);
  try {
    await current;
  } finally {
    if (envelopeWriteQueues.get(envelope.key) === current) {
      envelopeWriteQueues.delete(envelope.key);
    }
  }
}

async function pruneCache(): Promise<void> {
  try {
    const names = (await readdir(BRANCH_CACHE_DIR)).filter((name) => name.endsWith(".json"));
    const rows = await Promise.all(
      names.map(async (name) => {
        const fullPath = path.join(BRANCH_CACHE_DIR, name);
        try {
          const info = await stat(fullPath);
          return { fullPath, mtimeMs: info.mtimeMs };
        } catch {
          return null;
        }
      }),
    );
    const live = rows.filter((row): row is { fullPath: string; mtimeMs: number } => !!row);
    const now = Date.now();
    const expired = live.filter((row) => now - row.mtimeMs > CACHE_TTL_MS);
    await Promise.all(expired.map((row) => unlink(row.fullPath).catch(() => undefined)));
    const remaining = live
      .filter((row) => now - row.mtimeMs <= CACHE_TTL_MS)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    await Promise.all(
      remaining
        .slice(CACHE_MAX_ENTRIES)
        .map((row) => unlink(row.fullPath).catch(() => undefined)),
    );
  } catch {
    // Cache maintenance must never fail a story request.
  }
}

function runQueues(): void {
  const policy = getSpeculativePolicy();
  while (activeForeground < policy.foregroundConcurrency && foregroundQueue.length > 0) {
    startJob(foregroundQueue.shift()!, "foreground");
  }
  while (
    activePrediction < policy.predictionConcurrency &&
    predictionQueue.length > 0
  ) {
    startJob(predictionQueue.shift()!, "prefetch");
  }
}

function startJob(job: ScheduledJob<unknown>, mode: SpeculativeBranchMode): void {
  queuedByKey.delete(job.key);
  if (mode === "foreground") activeForeground += 1;
  else activePrediction += 1;
  void job.task().then(job.resolve, job.reject).finally(() => {
    if (mode === "foreground") activeForeground -= 1;
    else activePrediction -= 1;
    scheduled.delete(job.key);
    runQueues();
  });
}

function schedule<T>(
  key: string,
  mode: SpeculativeBranchMode,
  task: () => Promise<T>,
): Promise<T> {
  const existing = scheduled.get(key) as Promise<T> | undefined;
  if (existing) {
    if (mode === "foreground") promoteSpeculativeTask(key);
    return existing;
  }
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const job: ScheduledJob<T> = { key, mode, task, resolve, reject };
  scheduled.set(key, promise);
  queuedByKey.set(key, job as ScheduledJob<unknown>);
  if (mode === "foreground") foregroundQueue.push(job as ScheduledJob<unknown>);
  else predictionQueue.push(job as ScheduledJob<unknown>);
  runQueues();
  return promise;
}

/** Shared by the HTTP wrapper and targeted tests; callers with the same key
 * receive one promise, and a foreground caller promotes a queued prediction. */
export function runSpeculativeSingleFlight<T>(
  key: string,
  mode: SpeculativeBranchMode,
  task: () => Promise<T>,
): Promise<T> {
  return schedule(key, mode, task);
}

export function promoteSpeculativeTask(key: string): boolean {
  const job = queuedByKey.get(key);
  if (!job || job.mode === "foreground") return scheduled.has(key);
  const index = predictionQueue.indexOf(job);
  if (index >= 0) predictionQueue.splice(index, 1);
  job.mode = "foreground";
  foregroundQueue.unshift(job);
  runQueues();
  return true;
}

export function cancelQueuedSpeculativeTask(key: string): boolean {
  const job = queuedByKey.get(key);
  if (!job) return false;
  const foregroundIndex = foregroundQueue.indexOf(job);
  if (foregroundIndex >= 0) foregroundQueue.splice(foregroundIndex, 1);
  const predictionIndex = predictionQueue.indexOf(job);
  if (predictionIndex >= 0) predictionQueue.splice(predictionIndex, 1);
  queuedByKey.delete(key);
  scheduled.delete(key);
  job.reject(new DOMException("stale style prediction", "AbortError"));
  recordMetric("wasted");
  return true;
}

function isProviderBusy(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b429\b|rate.?limit|too many requests|service busy|overloaded|资源繁忙/i.test(message);
}

function metaFromEnvelope<T>(
  envelope: CacheEnvelope<T>,
  cacheStatus: SpeculativeBranchCacheMeta["cacheStatus"],
): SpeculativeBranchCacheMeta {
  return {
    status: envelope.status,
    cacheStatus,
    textKey: envelope.textKey.slice(0, 16),
    imageKey: envelope.imageKey.slice(0, 16),
    key: envelope.key,
    retryAt: envelope.retryAt,
  };
}

export type SpeculativeBranchContext = {
  keys: SpeculativeBranchKeys;
  request: SpeculativeBranchRequest;
};

export function getSpeculativeBranchContext(
  session: Session,
  config: EngineConfig,
  request: SceneRequestLike["speculation"],
): SpeculativeBranchContext | null {
  const normalized = normalizeSpeculation(request);
  if (!normalized) return null;
  const keys = buildSpeculativeBranchKeys(session, config);
  return keys ? { keys, request: normalized } : null;
}

type SceneRequestLike = {
  speculation?: SpeculativeBranchRequest;
};

export function rejectSpeculativeRequest(
  request: SpeculativeBranchRequest | undefined,
): string | null {
  const normalized = normalizeSpeculation(request);
  if (!normalized || normalized.mode !== "prefetch") return null;
  const policy = getSpeculativePolicy();
  if (normalized.requestedDepth === 0) return "prefetch-disabled";
  if (normalized.requestedDepth > policy.maxDepth) return "admin-depth-limit";
  if (normalized.branchOrdinal >= policy.branchBudget) return "branch-budget";
  if (normalized.includeAudio) return "audio-prefetch-disabled-p1";
  return null;
}

export async function withSpeculativeBranchCache<T extends object>(
  context: SpeculativeBranchContext | null,
  compute: (observe: (event: SceneStreamEvent) => void) => Promise<T>,
): Promise<T & { speculativeCache?: SpeculativeBranchCacheMeta }> {
  if (!context) return compute(() => undefined);
  const { keys, request } = context;
  const startedAt = Date.now();
  const cached = await readEnvelope<T>(keys);
  if (cached?.status === "ready" && cached.data) {
    recordMetric("prefetch_hit");
    recordMetric("latency_saved_ms", Math.max(0, Date.now() - cached.createdAt));
    return {
      ...cached.data,
      speculativeCache: metaFromEnvelope(cached, "hit"),
    };
  }
  if (cached && ["text_ready", "generating_image", "image_pending"].includes(cached.status)) {
    recordMetric("partial_hit");
  } else {
    recordMetric("miss");
  }

  const queuedAt = Date.now();
  const initial: CacheEnvelope<T> = {
    version: 1,
    key: keys.key,
    textKey: keys.textKey,
    imageKey: keys.imageKey,
    status: "queued",
    createdAt: cached?.createdAt ?? queuedAt,
    updatedAt: queuedAt,
    lastAccessAt: queuedAt,
    attempts: (cached?.attempts ?? 0) + 1,
  };
  await writeEnvelope(initial);
  if (request.mode === "prefetch") recordMetric("prefetch_queued");

  return runSpeculativeSingleFlight(keys.key, request.mode, async () => {
    let envelope = initial;
    const setStatus = (status: SpeculativeBranchStatus): void => {
      if (envelope.status === status) return;
      envelope = { ...envelope, status, updatedAt: Date.now(), lastAccessAt: Date.now() };
      void writeEnvelope(envelope);
    };
    setStatus("generating_text");
    const observe = (event: SceneStreamEvent): void => {
      if (event.type === "beat" || event.type === "choices") setStatus("text_ready");
      if (event.type === "background") setStatus("generating_image");
    };
    try {
      const value = await compute(observe);
      const ready: CacheEnvelope<T> = {
        ...envelope,
        status: "ready",
        updatedAt: Date.now(),
        lastAccessAt: Date.now(),
        data: value,
        error: undefined,
        retryAt: undefined,
      };
      await writeEnvelope(ready);
      void pruneCache();
      recordMetric("provider_cost_estimate", request.mode === "prefetch" ? 1 : 0);
      return {
        ...value,
        speculativeCache: metaFromEnvelope(ready, "write"),
      };
    } catch (error) {
      const busy = isProviderBusy(error);
      const retryDelay = Math.min(60_000, 1_000 * 2 ** Math.min(envelope.attempts, 6));
      const failed: CacheEnvelope<T> = {
        ...envelope,
        status: busy ? "image_pending" : "failed",
        updatedAt: Date.now(),
        lastAccessAt: Date.now(),
        retryAt: busy ? Date.now() + retryDelay : undefined,
        error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      };
      await writeEnvelope(failed);
      console.warn(JSON.stringify({
        event: "speculative_branch_generation",
        status: failed.status,
        key: keys.key.slice(0, 16),
        retryAt: failed.retryAt,
        elapsedMs: Date.now() - startedAt,
      }));
      throw error;
    }
  });
}
