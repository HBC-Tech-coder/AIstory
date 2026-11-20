import "server-only";

import { createHash, randomInt, randomUUID } from "node:crypto";

import {
  ComfyUIWorkflowSelectionUnavailableError,
  getComfyUIProviderConfig,
  queueRegisteredComfyUIWorkflow,
} from "@/lib/providers/comfyui/server";
import { getComfyUIWorkflowTemplate } from "@/lib/providers/comfyui/registry";
import {
  cancelComfyUIJob,
  getComfyUIHistory,
  mirrorComfyUIHistoryOutput,
} from "@/lib/providers/comfyui/transport";
import { validateComfyUIWorkflowRequest } from "@/lib/providers/comfyui/validation";
import {
  getLocalMiniDramaGenerationTask,
  mirrorLocalMiniDramaImage,
  submitLocalMiniDramaImage,
} from "@/lib/localminidrama/generationAdapter";
import {
  findStoredGenerationJobByFingerprint,
  findStoredGenerationJobByIdempotencyKey,
  getStoredGenerationJob,
  listStoredGenerationJobs,
  recoverStoredGenerationJobs,
  saveStoredGenerationJob,
  updateStoredGenerationJob,
} from "./store";
import {
  releaseGpuExecution,
  tryAcquireGpuExecution,
} from "./executionGate";
import type {
  ComfyUIGenerationJobInput,
  GenerationJob,
  LocalMiniDramaImageJobInput,
  StoredGenerationJob,
} from "./types";

type SchedulerOptions = {
  fetcher?: typeof fetch;
  pollIntervalMs?: number;
  maxPolls?: number;
  beforeIdle?: () => Promise<void> | void;
  localMiniDramaMaxPolls?: number;
  localMiniDramaMaxDurationMs?: number;
  localMiniDramaMaxConsecutiveErrors?: number;
  localMiniDramaMaxPollIntervalMs?: number;
};

function safeJob(job: StoredGenerationJob): GenerationJob {
  const publicJob: GenerationJob & {
    input?: unknown;
    workflowFingerprint?: unknown;
  } = { ...job };
  delete publicJob.input;
  delete publicJob.workflowFingerprint;
  return publicJob;
}

function pinnedComfyUIWorkflowSelection(
  job: StoredGenerationJob,
): { id: string; version: number; fingerprint: string } | undefined {
  if (job.provider !== "comfyui") return undefined;
  const inputWorkflowId = (job.input as { workflowId?: unknown } | undefined)
    ?.workflowId;
  if (
    typeof inputWorkflowId !== "string" ||
    typeof job.workflowId !== "string" ||
    inputWorkflowId !== job.workflowId ||
    !/^[a-z0-9][a-z0-9_-]{2,63}$/.test(job.workflowId) ||
    typeof job.workflowVersion !== "number" ||
    !Number.isSafeInteger(job.workflowVersion) ||
    job.workflowVersion <= 0 ||
    typeof job.workflowFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(job.workflowFingerprint)
  ) {
    return undefined;
  }
  return {
    id: job.workflowId,
    version: job.workflowVersion,
    fingerprint: job.workflowFingerprint,
  };
}

export function generationRequestFingerprint(
  input: unknown,
  workflow: string,
): string {
  const semantic = input && typeof input === "object"
    ? Object.fromEntries(
        Object.entries(input).filter(
          ([key]) => key !== "idempotencyKey" && key !== "force",
        ),
      )
    : input;
  return createHash("sha256")
    .update(JSON.stringify({ input: semantic, workflow }))
    .digest("hex");
}

function generatedSeed(): number {
  return randomInt(0, 2_147_483_647);
}

function safeReferenceImages(
  value: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!value) return undefined;
  const entries = Object.entries(value).filter(
    ([slot, image]) =>
      /^[a-zA-Z0-9_-]{1,64}$/.test(slot) &&
      /^aistory\/[a-f0-9-]{36}\.(?:avif|jpe?g|png|webp)$/i.test(image),
  );
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function normalizeComfyInput(
  raw: ComfyUIGenerationJobInput,
): ComfyUIGenerationJobInput {
  const references = safeReferenceImages(raw.referenceImages);
  const faceReference = raw.faceReference &&
    /^aistory\/[a-f0-9-]{36}\.(?:avif|jpe?g|png|webp)$/i.test(raw.faceReference)
      ? raw.faceReference
      : undefined;
  return {
    workflowId: raw.workflowId,
    modality: raw.modality,
    prompt: raw.prompt,
    negativePrompt: raw.negativePrompt,
    referenceImages: references,
    faceReference,
    seed: raw.seed ?? generatedSeed(),
    width: raw.width,
    height: raw.height,
    orientation: raw.orientation,
    visualStyleRevision: raw.visualStyleRevision,
    characterStateRevision: raw.characterStateRevision,
    referenceRevision: raw.referenceRevision,
    idempotencyKey: raw.idempotencyKey,
    force: raw.force === true,
    regenerationNonce: raw.force
      ? raw.regenerationNonce || randomUUID()
      : raw.regenerationNonce,
  };
}

function normalizeLocalMiniDramaInput(
  raw: LocalMiniDramaImageJobInput,
): LocalMiniDramaImageJobInput {
  return {
    dramaId: raw.dramaId,
    storyboardId: raw.storyboardId,
    sceneId: raw.sceneId,
    prompt: raw.prompt,
    negativePrompt: raw.negativePrompt,
    frameType: raw.frameType,
    size: raw.size,
    aspectRatio: raw.aspectRatio,
    style: raw.style,
    seed: raw.seed ?? generatedSeed(),
    idempotencyKey: raw.idempotencyKey,
    force: raw.force === true,
    regenerationNonce: raw.force
      ? raw.regenerationNonce || randomUUID()
      : raw.regenerationNonce,
  };
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function safeErrorCode(error: unknown): string {
  if (error instanceof ComfyUIWorkflowSelectionUnavailableError) {
    return "workflow_selection_unavailable";
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("HTTP 429")) return "provider_rate_limited";
  if (message.includes("HTTP 5")) return "provider_unavailable";
  if (message.includes("cancel")) return "cancelled";
  if (message.includes("timeout") || message.includes("exceeded")) {
    return "provider_timeout";
  }
  return "generation_failed";
}

export class GenerationJobScheduler {
  private readonly fetcher: typeof fetch;
  private readonly pollIntervalMs: number;
  private readonly maxPolls: number;
  private readonly beforeIdle?: () => Promise<void> | void;
  private readonly localMiniDramaMaxPolls: number;
  private readonly localMiniDramaMaxDurationMs: number;
  private readonly localMiniDramaMaxConsecutiveErrors: number;
  private readonly localMiniDramaMaxPollIntervalMs: number;
  private initializing?: Promise<void>;
  private processing = false;
  private readonly idempotencySubmissions = new Map<string, Promise<GenerationJob>>();
  private readonly contentSubmissions = new Map<string, Promise<GenerationJob>>();
  private currentJobId?: string;
  private currentPromptId?: string;

  constructor(options: SchedulerOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.pollIntervalMs = Math.max(
      10,
      options.pollIntervalMs ??
        (Number(process.env.AISTORY_JOB_POLL_INTERVAL_MS) || 1_000),
    );
    this.maxPolls = Math.max(
      1,
      options.maxPolls ??
        (Number(process.env.AISTORY_JOB_MAX_POLLS) || 1_800),
    );
    this.beforeIdle = options.beforeIdle;
    this.localMiniDramaMaxPolls = Math.max(
      1,
      options.localMiniDramaMaxPolls ?? 360,
    );
    this.localMiniDramaMaxDurationMs = Math.max(
      100,
      options.localMiniDramaMaxDurationMs ?? 30 * 60 * 1_000,
    );
    this.localMiniDramaMaxConsecutiveErrors = Math.max(
      1,
      options.localMiniDramaMaxConsecutiveErrors ?? 5,
    );
    this.localMiniDramaMaxPollIntervalMs = Math.max(
      this.pollIntervalMs,
      options.localMiniDramaMaxPollIntervalMs ?? 5_000,
    );
  }

  async initialize(): Promise<void> {
    if (!this.initializing) {
      this.initializing = recoverStoredGenerationJobs().then(() => {
        this.kick();
      });
    }
    return this.initializing;
  }

  async list(): Promise<GenerationJob[]> {
    await this.initialize();
    return (await listStoredGenerationJobs())
      .filter((job) => job.provider !== "gpu-connector-lan")
      .slice(0, 100)
      .map(safeJob);
  }

  async get(id: string): Promise<GenerationJob | undefined> {
    await this.initialize();
    const job = await getStoredGenerationJob(id);
    return job && job.provider !== "gpu-connector-lan"
      ? safeJob(job)
      : undefined;
  }

  async submitComfyUI(input: ComfyUIGenerationJobInput): Promise<GenerationJob> {
    await this.initialize();
    if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.length < 8) {
      throw new Error("A valid idempotency key is required.");
    }
    const replay = await findStoredGenerationJobByIdempotencyKey(
      "comfyui",
      input.idempotencyKey,
    );
    if (replay) return safeJob(replay);
    const key = `comfyui:${input.idempotencyKey}`;
    const concurrent = this.idempotencySubmissions.get(key);
    if (concurrent) return concurrent;
    const submission = this.submitComfyUIContent(input);
    this.idempotencySubmissions.set(key, submission);
    try {
      return await submission;
    } finally {
      if (this.idempotencySubmissions.get(key) === submission) {
        this.idempotencySubmissions.delete(key);
      }
    }
  }

  private async submitComfyUIContent(
    rawInput: ComfyUIGenerationJobInput,
  ): Promise<GenerationJob> {
    const input = normalizeComfyInput(rawInput);
    const registered = await getComfyUIWorkflowTemplate(input.workflowId);
    if (!registered || registered.template.modality !== input.modality) {
      throw new Error("Enabled ComfyUI workflow template not found.");
    }
    const validation = validateComfyUIWorkflowRequest({
      ...input,
      purpose: "foreground",
    });
    if (!validation.ok) {
      throw new Error(validation.issues.map((item) => item.message).join(" "));
    }
    const requestFingerprint = generationRequestFingerprint(
      input,
      `${registered.template.id}@${registered.version.version}:${registered.version.fingerprint}`,
    );
    const concurrent = this.contentSubmissions.get(requestFingerprint);
    if (concurrent) return concurrent;
    const submission = (async () => {
      const existing =
        await findStoredGenerationJobByFingerprint(requestFingerprint);
      if (existing) return safeJob(existing);

      const now = new Date().toISOString();
      const job: StoredGenerationJob = {
        id: randomUUID(),
        provider: "comfyui",
        modality: input.modality,
        status: "queued",
        progress: 0,
        requestFingerprint,
        idempotencyKey: input.idempotencyKey,
        workflowId: registered.template.id,
        workflowVersion: registered.version.version,
        workflowFingerprint: registered.version.fingerprint,
        attempts: 0,
        maxAttempts: 2,
        retryable: false,
        provenance: {
          purpose: "foreground",
          source: "aistory-studio",
          provider: "comfyui",
        },
        createdAt: now,
        updatedAt: now,
        input: structuredClone(input),
      };
      await saveStoredGenerationJob(job);
      this.kick();
      return safeJob(job);
    })();
    this.contentSubmissions.set(requestFingerprint, submission);
    try {
      return await submission;
    } finally {
      if (this.contentSubmissions.get(requestFingerprint) === submission) {
        this.contentSubmissions.delete(requestFingerprint);
      }
    }
  }

  async submitLocalMiniDramaImage(
    input: LocalMiniDramaImageJobInput,
  ): Promise<GenerationJob> {
    await this.initialize();
    if (
      !Number.isSafeInteger(input.dramaId) ||
      input.dramaId <= 0 ||
      typeof input.prompt !== "string" ||
      !input.prompt.trim() ||
      input.prompt.length > 4_000 ||
      typeof input.idempotencyKey !== "string" ||
      input.idempotencyKey.length < 8
    ) {
      throw new Error("Invalid LocalMiniDrama image generation input.");
    }
    const replay = await findStoredGenerationJobByIdempotencyKey(
      "localminidrama",
      input.idempotencyKey,
    );
    if (replay) return safeJob(replay);
    const key = `localminidrama:${input.idempotencyKey}`;
    const concurrent = this.idempotencySubmissions.get(key);
    if (concurrent) return concurrent;
    const submission = this.submitLocalMiniDramaContent(input);
    this.idempotencySubmissions.set(key, submission);
    try {
      return await submission;
    } finally {
      if (this.idempotencySubmissions.get(key) === submission) {
        this.idempotencySubmissions.delete(key);
      }
    }
  }

  private async submitLocalMiniDramaContent(
    rawInput: LocalMiniDramaImageJobInput,
  ): Promise<GenerationJob> {
    const input = normalizeLocalMiniDramaInput(rawInput);
    const requestFingerprint = generationRequestFingerprint(
      input,
      "localminidrama-image-adapter-v1",
    );
    const concurrent = this.contentSubmissions.get(requestFingerprint);
    if (concurrent) return concurrent;
    const submission = (async () => {
      const existing =
        await findStoredGenerationJobByFingerprint(requestFingerprint);
      if (existing) return safeJob(existing);
      const now = new Date().toISOString();
      const job: StoredGenerationJob = {
        id: randomUUID(),
        provider: "localminidrama",
        modality: "image",
        status: "queued",
        progress: 0,
        requestFingerprint,
        idempotencyKey: input.idempotencyKey,
        attempts: 0,
        maxAttempts: 2,
        retryable: false,
        provenance: {
          purpose: "foreground",
          source: "aistory-studio",
          provider: "localminidrama",
        },
        createdAt: now,
        updatedAt: now,
        input: structuredClone(input),
      };
      await saveStoredGenerationJob(job);
      this.kick();
      return safeJob(job);
    })();
    this.contentSubmissions.set(requestFingerprint, submission);
    try {
      return await submission;
    } finally {
      if (this.contentSubmissions.get(requestFingerprint) === submission) {
        this.contentSubmissions.delete(requestFingerprint);
      }
    }
  }

  async cancel(id: string): Promise<GenerationJob> {
    await this.initialize();
    const job = await getStoredGenerationJob(id);
    if (!job) throw new Error("Generation job not found.");
    if (job.provider === "gpu-connector-lan") {
      throw new Error("LAN GPU jobs require the administrator coordinator.");
    }
    if (job.status === "queued") {
      return safeJob(
        await updateStoredGenerationJob(id, (item) => {
          item.status = "cancelled";
          item.progress = 0;
          item.retryable = true;
          item.completedAt = new Date().toISOString();
        }),
      );
    }
    if (
      (job.status === "running" || job.status === "pending") &&
      this.currentJobId === id
    ) {
      if (job.provider === "localminidrama") {
        return safeJob(
          await updateStoredGenerationJob(id, (item) => {
            item.cancelRequested = true;
          }),
        );
      }
      if (!job.providerTaskId) {
        return safeJob(
          await updateStoredGenerationJob(id, (item) => {
            item.cancelRequested = true;
          }),
        );
      }
      await cancelComfyUIJob(
        getComfyUIProviderConfig(),
        job.providerTaskId,
        { runningPromptId: this.currentPromptId },
        this.fetcher,
      );
      return safeJob(
        await updateStoredGenerationJob(id, (item) => {
          item.status = "cancelled";
          item.cancelRequested = true;
          item.retryable = true;
          item.completedAt = new Date().toISOString();
        }),
      );
    }
    throw new Error("Only this scheduler's queued or active job can be cancelled.");
  }

  async retry(id: string): Promise<GenerationJob> {
    await this.initialize();
    const job = await getStoredGenerationJob(id);
    if (
      !job ||
      job.provider === "gpu-connector-lan" ||
      !["failed", "cancelled", "interrupted"].includes(job.status) ||
      !job.retryable ||
      job.attempts >= job.maxAttempts
    ) {
      throw new Error("Generation job is not retryable.");
    }
    if (job.provider === "comfyui" && !pinnedComfyUIWorkflowSelection(job)) {
      throw new Error("Generation job is not retryable.");
    }
    const updated = await updateStoredGenerationJob(id, (item) => {
      item.status = "queued";
      item.progress = 0;
      item.providerTaskId = undefined;
      item.errorCode = undefined;
      item.completedAt = undefined;
      item.retryable = false;
      item.cancelRequested = false;
    });
    this.kick();
    return safeJob(updated);
  }

  private kick() {
    if (this.processing) return;
    this.processing = true;
    void this.processQueue().finally(async () => {
      await this.beforeIdle?.();
      this.currentJobId = undefined;
      this.currentPromptId = undefined;
      this.processing = false;
      const queued = (await listStoredGenerationJobs()).some(
        (job) =>
          job.status === "queued" && job.provider !== "gpu-connector-lan",
      );
      if (queued) this.kick();
    });
  }

  private async processQueue(): Promise<void> {
    while (true) {
      const next = (await listStoredGenerationJobs())
        .filter(
          (job) =>
            job.status === "queued" && job.provider !== "gpu-connector-lan",
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (!next) return;
      await this.process(next);
    }
  }

  private async process(job: StoredGenerationJob): Promise<void> {
    if (job.provider === "gpu-connector-lan") return;
    if (!tryAcquireGpuExecution({ kind: "local", jobId: job.id })) return;
    this.currentJobId = job.id;
    await updateStoredGenerationJob(job.id, (item) => {
      item.status = "running";
      item.progress = 5;
      item.attempts += 1;
      item.startedAt = new Date().toISOString();
    });
    try {
      const beforeSubmit = await getStoredGenerationJob(job.id);
      if (beforeSubmit?.cancelRequested) {
        await updateStoredGenerationJob(job.id, (item) => {
          item.status = "cancelled";
          item.retryable = true;
          item.completedAt = new Date().toISOString();
        });
        return;
      }
      if (job.provider === "localminidrama") {
        await this.processLocalMiniDrama(job);
        return;
      }
      const selection = pinnedComfyUIWorkflowSelection(job);
      if (!selection) throw new ComfyUIWorkflowSelectionUnavailableError();
      const queued = await queueRegisteredComfyUIWorkflow(
        selection,
        { ...job.input, purpose: "foreground" },
        this.fetcher,
      );
      this.currentPromptId = queued.promptId;
      const afterSubmit = await getStoredGenerationJob(job.id);
      if (afterSubmit?.cancelRequested) {
        await cancelComfyUIJob(
          getComfyUIProviderConfig(),
          queued.promptId,
          { runningPromptId: queued.promptId },
          this.fetcher,
        ).catch(() => undefined);
        await updateStoredGenerationJob(job.id, (item) => {
          item.providerTaskId = queued.promptId;
          item.status = "cancelled";
          item.retryable = true;
          item.completedAt = new Date().toISOString();
        });
        return;
      }
      await updateStoredGenerationJob(job.id, (item) => {
        item.status = "pending";
        item.progress = 10;
        item.providerTaskId = queued.promptId;
      });

      const outputNodes = new Set(queued.outputNodeIds);
      for (let poll = 0; poll < this.maxPolls; poll += 1) {
        const current = await getStoredGenerationJob(job.id);
        if (current?.status === "cancelled") return;
        const history = await getComfyUIHistory(
          getComfyUIProviderConfig(),
          queued.promptId,
          this.fetcher,
        );
        if (history.state === "failed") {
          throw new Error("ComfyUI execution failed.");
        }
        if (history.state === "succeeded") {
          const output = history.outputs.find(
            (item) =>
              outputNodes.has(item.nodeId) &&
              (job.modality === "image"
                ? item.mediaKind === "image"
                : item.mediaKind === "video"),
          );
          if (!output) throw new Error("ComfyUI completed without an allowed output.");
          const artifact = await mirrorComfyUIHistoryOutput(
            getComfyUIProviderConfig(),
            output,
            this.fetcher,
          );
          await updateStoredGenerationJob(job.id, (item) => {
            item.status = "succeeded";
            item.progress = 100;
            item.artifact = artifact;
            item.retryable = false;
            item.completedAt = new Date().toISOString();
          });
          return;
        }
        await updateStoredGenerationJob(job.id, (item) => {
          item.progress = Math.min(90, 15 + poll);
        });
        await delay(this.pollIntervalMs);
      }
      await cancelComfyUIJob(
        getComfyUIProviderConfig(),
        queued.promptId,
        { runningPromptId: this.currentPromptId },
        this.fetcher,
      ).catch(() => undefined);
      throw new Error("ComfyUI generation timeout.");
    } catch (error) {
      const current = await getStoredGenerationJob(job.id);
      if (current?.status === "cancelled") return;
      await updateStoredGenerationJob(job.id, (item) => {
        item.status = "failed";
        item.errorCode = safeErrorCode(error);
        item.errorMessage = item.provider === "localminidrama" && item.providerTaskId
          ? `LocalMiniDrama provider task ${item.providerTaskId} failed (${item.errorCode}).`
          : undefined;
        item.retryable =
          !(error instanceof ComfyUIWorkflowSelectionUnavailableError) &&
          item.attempts < item.maxAttempts;
        item.completedAt = new Date().toISOString();
      });
    } finally {
      this.currentJobId = undefined;
      this.currentPromptId = undefined;
      releaseGpuExecution({ kind: "local", jobId: job.id });
    }
  }

  private async processLocalMiniDrama(
    job: Extract<StoredGenerationJob, { provider: "localminidrama" }>,
  ): Promise<void> {
    const submitted = await submitLocalMiniDramaImage(job.input, this.fetcher);
    await updateStoredGenerationJob(job.id, (item) => {
      item.status = "pending";
      item.progress = 10;
      item.providerTaskId = submitted.taskId;
    });
    const startedAt = Date.now();
    let consecutiveErrors = 0;
    for (let poll = 0; poll < this.localMiniDramaMaxPolls; poll += 1) {
      if (Date.now() - startedAt >= this.localMiniDramaMaxDurationMs) {
        throw new Error(`LocalMiniDrama task ${submitted.taskId} polling timeout.`);
      }
      try {
        const task = await getLocalMiniDramaGenerationTask(
          submitted.taskId,
          this.fetcher,
        );
        if (task.status === "failed") {
          throw new Error(`LocalMiniDrama task ${submitted.taskId} generation failed.`);
        }
        consecutiveErrors = 0;
        if (task.status === "succeeded") {
          let artifact: GenerationJob["artifact"];
          const notes: GenerationJob["notes"] = [];
          if (task.imageUrl) {
            try {
              artifact = await mirrorLocalMiniDramaImage(
                task.imageUrl,
                this.fetcher,
              );
            } catch {
              notes.push("artifact_unavailable");
            }
          } else {
            notes.push("artifact_unavailable");
          }
          const current = await getStoredGenerationJob(job.id);
          if (current?.cancelRequested) {
            notes.push("cancel_requested_but_completed");
          }
          await updateStoredGenerationJob(job.id, (item) => {
            item.status = "succeeded";
            item.progress = 100;
            item.artifact = artifact;
            item.notes = [...new Set(notes)];
            item.retryable = false;
            item.completedAt = new Date().toISOString();
          });
          return;
        }
        await updateStoredGenerationJob(job.id, (item) => {
          item.status = "pending";
          item.progress = Math.max(10, task.progress);
        });
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes(`task ${submitted.taskId} generation failed`)
        ) throw error;
        consecutiveErrors += 1;
        if (consecutiveErrors >= this.localMiniDramaMaxConsecutiveErrors) {
          throw new Error(
            `LocalMiniDrama task ${submitted.taskId} polling failed ${consecutiveErrors} times.`,
          );
        }
      }
      const pollDelay = Math.min(
        this.localMiniDramaMaxPollIntervalMs,
        this.pollIntervalMs * 2 ** Math.min(poll, 4),
      );
      await delay(pollDelay);
    }
    throw new Error(
      `LocalMiniDrama task ${submitted.taskId} exceeded ${this.localMiniDramaMaxPolls} polls.`,
    );
  }
}

declare global {
  var __aistoryGenerationJobScheduler: GenerationJobScheduler | undefined;
}

export function getGenerationJobScheduler(): GenerationJobScheduler {
  globalThis.__aistoryGenerationJobScheduler ??= new GenerationJobScheduler();
  return globalThis.__aistoryGenerationJobScheduler;
}
