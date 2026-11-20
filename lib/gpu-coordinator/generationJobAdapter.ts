import "server-only";

import { createHash, randomUUID } from "node:crypto";

import { cacheMediaBytes } from "@/lib/engine/mediaCache";
import {
  findStoredGenerationJobByFingerprint,
  findStoredGenerationJobByIdempotencyKey,
  getStoredGenerationJob,
  listStoredGenerationJobs,
  saveStoredGenerationJob,
  updateStoredGenerationJob,
} from "@/lib/generation-jobs/store";
import type {
  GenerationJob,
  LanGpuVideoJobInput,
  StoredGenerationJob,
} from "@/lib/generation-jobs/types";

import type { CoordinatorGenerationJobPort } from "./ports";
import {
  coordinatorFingerprint,
  stableCoordinatorJson,
  validateCoordinatorLeasePayload,
} from "./protocol";
import type { LanLabCoordinatorRepository } from "./labRepository";
import type {
  CoordinatorLeasePayload,
  StoredCoordinatorLease,
} from "./types";

export type LanGpuWorkflowAllowlistEntry = {
  workflowId: string;
  workflowSha256: string;
  purpose: "generate" | "upscale";
  modality: "video";
  classification: "non_publishable";
  parameterBindingSha256: string;
  fixedParameters: {
    width: number;
    height: number;
    frames: number;
    fps: number;
    seed?: number;
    preserveAudio?: true;
  };
  inputSlots: readonly (
    | "referenceImage"
    | "firstFrame"
    | "lastFrame"
    | "sourceVideo"
  )[];
  outputSlots: Array<{
    nodeId: string;
    slot: number;
    mimeType: "video/mp4" | "video/webm";
  }>;
};

export type LanGpuCoordinatorAdminStatus = {
  mode: "disabled" | "lan_lab";
  state: "offline" | "online";
  lastHeartbeatAt?: string;
  activeJob?: {
    jobId: string;
    status: string;
    progress: number;
    cancelRequested: boolean;
  };
  recentJobs: Array<{
    jobId: string;
    taskType: "generate" | "upscale";
    status: string;
    progress: number;
    artifactUrl?: string;
    sourceJobId?: string;
    createdAt: string;
  }>;
  workflowCount: number;
  concurrency: 1;
  speculativePrefetch: false;
};

export type LanGpuCoordinatorStudioStatus = {
  state: "disabled" | "offline" | "online";
  ready: boolean;
  lastHeartbeatAt?: string;
  active?: {
    status: string;
    progress: number;
    cancelRequested: boolean;
  };
  releaseClassification: "non_publishable";
  speculativePrefetch: false;
};

export function projectLanGpuCoordinatorStudioStatus(input: {
  ready: boolean;
  status: LanGpuCoordinatorAdminStatus;
}): LanGpuCoordinatorStudioStatus {
  return {
    state:
      input.status.mode === "disabled"
        ? "disabled"
        : input.status.state,
    ready: input.ready,
    ...(input.status.lastHeartbeatAt
      ? { lastHeartbeatAt: input.status.lastHeartbeatAt }
      : {}),
    ...(input.status.activeJob
      ? {
          active: {
            status: input.status.activeJob.status,
            progress: input.status.activeJob.progress,
            cancelRequested: input.status.activeJob.cancelRequested,
          },
        }
      : {}),
    releaseClassification: "non_publishable",
    speculativePrefetch: false,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeJob(job: StoredGenerationJob): GenerationJob {
  const result: GenerationJob & { input?: unknown } = structuredClone(job);
  delete result.input;
  delete result.providerTaskId;
  return result;
}

function validateInput(
  input: LanGpuVideoJobInput,
  workflow: LanGpuWorkflowAllowlistEntry,
): void {
  const fixed = workflow.fixedParameters;
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/.test(input.workflowId) ||
    !/^[a-f0-9]{64}$/.test(input.workflowSha256) ||
    input.taskType !== workflow.purpose ||
    !Number.isSafeInteger(input.width) ||
    input.width !== fixed.width ||
    !Number.isSafeInteger(input.height) ||
    input.height !== fixed.height ||
    !Number.isSafeInteger(input.frames) ||
    input.frames !== fixed.frames ||
    !Number.isFinite(input.fps) ||
    input.fps !== fixed.fps ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/.test(input.idempotencyKey)
  ) {
    throw new Error("Invalid LAN GPU video job.");
  }
  if (input.taskType === "generate") {
    if (
      workflow.inputSlots.length !== 0 ||
      !input.prompt.trim() ||
      input.prompt.length > 8_000 ||
      (input.negativePrompt?.length ?? 0) > 8_000 ||
      !Number.isSafeInteger(input.seed) ||
      input.seed !== fixed.seed
    ) {
      throw new Error("Invalid LAN GPU generation job.");
    }
    return;
  }
  if (
    workflow.inputSlots.length !== 1 ||
    workflow.inputSlots[0] !== "sourceVideo" ||
    fixed.preserveAudio !== true ||
    input.preserveAudio !== true ||
    !/^[0-9a-f-]{20,80}$/i.test(input.sourceJobId)
  ) {
    throw new Error("Invalid LAN GPU upscale job.");
  }
}

function semanticInput(input: LanGpuVideoJobInput): object {
  return input.taskType === "generate"
    ? {
        taskType: input.taskType,
        workflowId: input.workflowId,
        workflowSha256: input.workflowSha256,
        prompt: input.prompt,
        negativePrompt: input.negativePrompt ?? "",
        seed: input.seed,
        width: input.width,
        height: input.height,
        frames: input.frames,
        fps: input.fps,
        projectId: input.projectId,
      }
    : {
        taskType: input.taskType,
        workflowId: input.workflowId,
        workflowSha256: input.workflowSha256,
        sourceJobId: input.sourceJobId,
        width: input.width,
        height: input.height,
        frames: input.frames,
        fps: input.fps,
        preserveAudio: true,
        projectId: input.projectId,
      };
}

export function lanGpuPromptIdentity(
  input: LanGpuVideoJobInput,
): string {
  return sha256(
    stableCoordinatorJson({
      protocol: "aistory-lan-gpu-prompt-v1",
      ...semanticInput(input),
    }),
  );
}

export function mapLanGpuJobToLease(
  job: Extract<StoredGenerationJob, { provider: "gpu-connector-lan" }>,
  now: Date,
  workflow: LanGpuWorkflowAllowlistEntry,
): StoredCoordinatorLease {
  const promptIdentitySha256 = lanGpuPromptIdentity(job.input);
  const lease: CoordinatorLeasePayload = {
    jobId: job.id,
    leaseId: `lease-${randomUUID()}`,
    idempotencyKey: job.idempotencyKey,
    promptIdentitySha256,
    modality: "video",
    workflowId: job.input.workflowId,
    workflowSha256: job.input.workflowSha256,
    parameterBindingSha256: workflow.parameterBindingSha256,
    allowedOutputs: workflow.outputSlots.map((item) => ({ ...item })),
    businessParameters: job.input.taskType === "generate"
      ? {
          prompt: job.input.prompt,
          negativePrompt: job.input.negativePrompt ?? "",
          seed: job.input.seed,
          width: job.input.width,
          height: job.input.height,
          frames: job.input.frames,
          fps: job.input.fps,
        }
      : {
          width: job.input.width,
          height: job.input.height,
          frames: job.input.frames,
          fps: job.input.fps,
          preserveAudio: true,
        },
    inputTickets: {},
    expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1_000).toISOString(),
  };
  validateCoordinatorLeasePayload(lease, now, []);
  return {
    ...lease,
    state: "queued",
    progressSequence: 0,
    cancelRequested: false,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

export async function submitLanGpuVideoJob(input: {
  job: LanGpuVideoJobInput;
  allowlist: readonly LanGpuWorkflowAllowlistEntry[];
  repository: LanLabCoordinatorRepository;
  now?: Date;
}): Promise<GenerationJob> {
  const workflow = input.allowlist.find(
    (entry) =>
      entry.modality === "video" &&
      entry.classification === "non_publishable" &&
      entry.workflowId === input.job.workflowId &&
      entry.workflowSha256 === input.job.workflowSha256,
  );
  if (!workflow) throw new Error("LAN GPU workflow is not allowlisted.");
  validateInput(input.job, workflow);
  if (input.job.taskType === "upscale") {
    const source = await getStoredGenerationJob(input.job.sourceJobId);
    if (
      !source ||
      source.provider !== "gpu-connector-lan" ||
      source.input.taskType !== "generate" ||
      source.status !== "succeeded" ||
      !source.artifact ||
      source.input.frames !== input.job.frames ||
      source.input.fps !== input.job.fps ||
      input.job.width <= source.input.width ||
      input.job.height <= source.input.height
    ) {
      throw new Error("LAN GPU upscale source is unavailable.");
    }
  }
  const fingerprint = coordinatorFingerprint({
    target: "gpu-connector-lan",
    ...semanticInput(input.job),
  });
  const replay = await findStoredGenerationJobByIdempotencyKey(
    "gpu-connector-lan",
    input.job.idempotencyKey,
  );
  if (replay) {
    if (replay.requestFingerprint !== fingerprint) {
      throw new Error("LAN GPU idempotency conflict.");
    }
    return safeJob(replay);
  }
  const existing = await findStoredGenerationJobByFingerprint(fingerprint);
  if (existing) return safeJob(existing);
  const now = input.now ?? new Date();
  const stored: Extract<
    StoredGenerationJob,
    { provider: "gpu-connector-lan" }
  > = {
    id: randomUUID(),
    provider: "gpu-connector-lan",
    modality: "video",
    status: "queued",
    progress: 0,
    requestFingerprint: fingerprint,
    idempotencyKey: input.job.idempotencyKey,
    workflowId: input.job.workflowId,
    attempts: 0,
    maxAttempts: 2,
    retryable: false,
    releaseClassification: "non_publishable",
    provenance: {
      purpose: "foreground",
      source: "aistory-studio",
      provider: "gpu-connector-lan",
    },
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    input: structuredClone(input.job),
  };
  const lease = mapLanGpuJobToLease(stored, now, workflow);
  if (stored.input.taskType === "upscale") {
    lease.inputTickets.sourceVideo = await input.repository.issueInput({
      sourceJobId: stored.input.sourceJobId,
      targetLease: lease,
      now,
    });
  }
  validateCoordinatorLeasePayload(
    lease,
    now,
    input.repository.exactUploadHosts,
  );
  await saveStoredGenerationJob(stored);
  await input.repository.enqueueLease(lease);
  return safeJob(stored);
}

export class LanGpuGenerationJobPort implements CoordinatorGenerationJobPort {
  constructor(private readonly repository: LanLabCoordinatorRepository) {}

  async progress(input: {
    jobId: string;
    percent: number;
    phase: string;
  }): Promise<void> {
    await updateStoredGenerationJob(input.jobId, (job) => {
      if (job.provider !== "gpu-connector-lan") {
        throw new Error("LAN GPU job identity mismatch.");
      }
      job.status = "pending";
      job.progress = Math.max(job.progress, Math.min(99, input.percent));
      job.errorCode = undefined;
      job.retryable = false;
      job.startedAt ??= new Date().toISOString();
      job.attempts = Math.max(1, job.attempts);
    });
  }

  async complete(input: {
    jobId: string;
    artifact: {
      mimeType: "image/png" | "image/jpeg" | "image/webp" | "video/mp4" | "video/webm";
      bytes: number;
      sha256: string;
    };
  }): Promise<void> {
    if (
      input.artifact.mimeType !== "video/mp4" &&
      input.artifact.mimeType !== "video/webm"
    ) {
      throw new Error("LAN GPU artifact must be video.");
    }
    const bytes = await this.repository.readAcceptedArtifact({
      jobId: input.jobId,
      sha256: input.artifact.sha256,
      bytes: input.artifact.bytes,
      mimeType: input.artifact.mimeType,
    });
    const cached = await cacheMediaBytes(bytes, input.artifact.mimeType);
    await updateStoredGenerationJob(input.jobId, (job) => {
      if (job.provider !== "gpu-connector-lan") {
        throw new Error("LAN GPU job identity mismatch.");
      }
      job.status = "succeeded";
      job.progress = 100;
      job.artifact = {
        url: cached.url,
        contentType: input.artifact.mimeType,
        bytes: input.artifact.bytes,
      };
      job.retryable = false;
      job.completedAt = new Date().toISOString();
    });
  }

  async fail(input: {
    jobId: string;
    errorCode: string;
    retryable: boolean;
  }): Promise<void> {
    await updateStoredGenerationJob(input.jobId, (job) => {
      if (job.provider !== "gpu-connector-lan") {
        throw new Error("LAN GPU job identity mismatch.");
      }
      job.status = "failed";
      job.errorCode = input.errorCode;
      job.retryable = input.retryable;
      job.completedAt = new Date().toISOString();
    });
  }

  async cancelled(input: { jobId: string }): Promise<void> {
    await updateStoredGenerationJob(input.jobId, (job) => {
      if (job.provider !== "gpu-connector-lan") {
        throw new Error("LAN GPU job identity mismatch.");
      }
      job.status = "cancelled";
      job.retryable = true;
      job.cancelRequested = true;
      job.completedAt = new Date().toISOString();
    });
  }
}

export async function requestLanGpuJobCancellation(input: {
  jobId: string;
  repository: LanLabCoordinatorRepository;
  reasonCode?: string;
}): Promise<GenerationJob> {
  const job = await getStoredGenerationJob(input.jobId);
  if (!job || job.provider !== "gpu-connector-lan") {
    throw new Error("LAN GPU generation job not found.");
  }
  const lease = (await input.repository.listLeases()).find(
    (item) => item.jobId === input.jobId,
  );
  if (!lease) throw new Error("LAN GPU lease not found.");
  if (lease.state === "queued") {
    await input.repository.mutateLease(
      lease.jobId,
      lease.leaseId,
      (stored) => {
        stored.state = "cancelled";
        stored.cancelRequested = true;
        stored.cancellationId = `cancel-${randomUUID()}`;
        stored.cancellationReasonCode = input.reasonCode ?? "operator_request";
      },
    );
    await updateStoredGenerationJob(job.id, (stored) => {
      stored.status = "cancelled";
      stored.cancelRequested = true;
      stored.retryable = true;
      stored.completedAt = new Date().toISOString();
    });
  } else if (["offered", "acknowledged", "running"].includes(lease.state)) {
    await input.repository.requestCancellation({
      jobId: lease.jobId,
      leaseId: lease.leaseId,
      cancellationId: lease.cancellationId ?? `cancel-${randomUUID()}`,
      reasonCode: input.reasonCode ?? "operator_request",
    });
    await updateStoredGenerationJob(job.id, (stored) => {
      stored.cancelRequested = true;
    });
  }
  return safeJob((await getStoredGenerationJob(job.id))!);
}

export async function getLanGpuCoordinatorAdminStatus(input: {
  enabled: boolean;
  connectorId?: string;
  workflowCount: number;
  repository?: LanLabCoordinatorRepository;
  onlineWindowMs?: number;
  now?: Date;
}): Promise<LanGpuCoordinatorAdminStatus> {
  if (!input.enabled || !input.repository || !input.connectorId) {
    return {
      mode: "disabled",
      state: "offline",
      recentJobs: [],
      workflowCount: input.workflowCount,
      concurrency: 1,
      speculativePrefetch: false,
    };
  }
  const connector = await input.repository.getConnector(input.connectorId);
  const now = input.now ?? new Date();
  const online =
    connector?.status === "active" &&
    now.getTime() - Date.parse(connector.lastSeenAt) <=
      (input.onlineWindowMs ?? 30_000);
  const activeLease = (await input.repository.listLeases()).find((lease) =>
    ["offered", "acknowledged", "running"].includes(lease.state),
  );
  const activeJob = activeLease
    ? await getStoredGenerationJob(activeLease.jobId)
    : undefined;
  const recentJobs = (await listStoredGenerationJobs())
    .filter((job) => job.provider === "gpu-connector-lan")
    .slice(0, 12)
    .map((job) => ({
      jobId: job.id,
      taskType: job.input.taskType,
      status: job.status,
      progress: job.progress,
      ...(job.artifact ? { artifactUrl: job.artifact.url } : {}),
      ...(job.input.taskType === "upscale"
        ? { sourceJobId: job.input.sourceJobId }
        : {}),
      createdAt: job.createdAt,
    }));
  return {
    mode: "lan_lab",
    state: online ? "online" : "offline",
    ...(connector ? { lastHeartbeatAt: connector.lastSeenAt } : {}),
    ...(activeJob
      ? {
          activeJob: {
            jobId: activeJob.id,
            status: activeJob.status,
            progress: activeJob.progress,
            cancelRequested: Boolean(activeJob.cancelRequested),
          },
        }
      : {}),
    recentJobs,
    workflowCount: input.workflowCount,
    concurrency: 1,
    speculativePrefetch: false,
  };
}
