import "server-only";

import { createHash, randomUUID } from "node:crypto";

import type { AdminActor } from "@/lib/admin/types";
import { cacheMediaBytes } from "@/lib/engine/mediaCache";
import { getProjectAsset } from "@/lib/project-assets/repository";
import { saveProjectAssetIfAbsent } from "@/lib/project-assets/repository";
import type {
  AdoptProjectAssetResult,
  ProjectAsset,
} from "@/lib/project-assets/types";

import { canonicalSha256 } from "./canonical";
import {
  videoWorkflowABMaxPackageBytes,
  validateVideoWorkflowABPackage,
  VIDEO_WORKFLOW_AB_MAX_ENTRIES,
  type ValidateVideoWorkflowABPackageOptions,
} from "./package";
import {
  getLocalVideoWorkflowABRepository,
  type LocalVideoWorkflowABRepository,
  type VideoWorkflowABAudit,
  type VideoWorkflowABIdempotency,
} from "./repository";
import type {
  StoredVideoWorkflowABExperiment,
  StoredVideoWorkflowABRun,
  VideoWorkflowABCapabilityStatus,
  VideoWorkflowABExperimentDto,
  VideoWorkflowABReviewScores,
  VideoWorkflowABRunDto,
} from "./types";

type ServiceOptions = {
  repository?: LocalVideoWorkflowABRepository;
  allowTestAdapter?: boolean;
  allowSyntheticApproval?: boolean;
  now?: () => Date;
  randomId?: () => string;
  packageValidation?: ValidateVideoWorkflowABPackageOptions;
  resolveProjectAsset?: typeof getProjectAsset;
  mirrorMedia?: typeof cacheMediaBytes;
  saveProjectAsset?: typeof saveProjectAssetIfAbsent;
};

export type VideoWorkflowABMutationInput =
  | {
      action: "review_run";
      blindRunId: string;
      scores: VideoWorkflowABReviewScores;
      note?: string;
    }
  | { action: "finalize_review" }
  | { action: "reveal" }
  | { action: "approve"; blindRunId: string }
  | { action: "reject" }
  | { action: "offline" };

function assertLocalAdapter(
  actor: AdminActor,
  options: ServiceOptions,
): LocalVideoWorkflowABRepository {
  if (actor.mode !== "local") {
    throw new Error("Production A/B experiment repository is not configured.");
  }
  if (
    !options.allowTestAdapter &&
    process.env.AISTORY_VIDEO_AB_ADAPTER !== "local_development"
  ) {
    throw new Error("Local A/B experiment repository is not enabled.");
  }
  return options.repository ?? getLocalVideoWorkflowABRepository();
}

export function videoWorkflowABCapabilityStatus(
  actor: AdminActor,
): VideoWorkflowABCapabilityStatus {
  if (actor.mode === "production") {
    return {
      adapter: "production_repository",
      available: false,
      reason: "生产 A/B 实验仓储和对象存储尚未配置。",
      maxPackageBytes: videoWorkflowABMaxPackageBytes(),
      maxEntries: VIDEO_WORKFLOW_AB_MAX_ENTRIES,
    };
  }
  const available =
    process.env.AISTORY_VIDEO_AB_ADAPTER === "local_development" &&
    Boolean(process.env.AISTORY_VIDEO_FFPROBE_PATH?.trim());
  return {
    adapter: "local_development",
    available,
    ...(!available
      ? { reason: "本地 A/B 仓储或视频探测器尚未启用。" }
      : {}),
    maxPackageBytes: videoWorkflowABMaxPackageBytes(),
    maxEntries: VIDEO_WORKFLOW_AB_MAX_ENTRIES,
  };
}

function cleanId(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(value.trim())
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value.trim();
}

function cleanReason(value: unknown): string {
  if (typeof value !== "string") throw new Error("Operation reason is required.");
  const reason = value.trim();
  if (
    reason.length < 3 ||
    reason.length > 500 ||
    /[\u0000-\u001f<>]/.test(reason)
  ) {
    throw new Error("Operation reason is invalid.");
  }
  return reason;
}

function cleanIdempotencyKey(value: string): string {
  const key = value.trim();
  if (
    key.length < 16 ||
    key.length > 160 ||
    !/^[A-Za-z0-9:._-]+$/.test(key)
  ) {
    throw new Error("Idempotency key is invalid.");
  }
  return key;
}

function audit(
  actor: AdminActor,
  action: string,
  experimentId: string,
  reason: string,
  requestId: string,
  now: Date,
): VideoWorkflowABAudit {
  return {
    id: randomUUID(),
    actorId: actor.userId,
    action,
    experimentId,
    reason,
    requestId: requestId.slice(0, 160),
    createdAt: now.toISOString(),
  };
}

function idempotency(
  key: string,
  fingerprint: string,
  experimentId: string,
  operation: VideoWorkflowABIdempotency["operation"],
  now: Date,
): VideoWorkflowABIdempotency {
  return {
    key,
    fingerprint,
    experimentId,
    operation,
    createdAt: now.toISOString(),
  };
}

function scoredRuns(
  experiment: StoredVideoWorkflowABExperiment,
): StoredVideoWorkflowABRun[] {
  return experiment.runs.filter(
    (run) => !run.warmup && run.status === "succeeded",
  );
}

function measuredPairs(
  experiment: StoredVideoWorkflowABExperiment,
): StoredVideoWorkflowABRun[][] {
  const indexes = [
    ...new Set(
      experiment.runs
        .filter((run) => !run.warmup)
        .map((run) => run.pairIndex),
    ),
  ].sort((left, right) => left - right);
  return indexes
    .map((index) =>
      experiment.runs
        .filter((run) => !run.warmup && run.pairIndex === index)
        .sort((left, right) => left.executionOrder - right.executionOrder),
    )
    .filter(
      (pair) =>
        pair.length === 2 &&
        pair.every((run) => run.status === "succeeded"),
    );
}

export function approvalProtocolSatisfied(
  experiment: StoredVideoWorkflowABExperiment,
): boolean {
  const pairs = measuredPairs(experiment);
  if (pairs.length < 2) return false;
  for (let index = 1; index < pairs.length; index += 1) {
    if (pairs[index]![0]!.variantId === pairs[index - 1]![0]!.variantId) {
      return false;
    }
  }
  return scoredRuns(experiment).every((run) => Boolean(run.review));
}

function runDto(
  experimentId: string,
  run: StoredVideoWorkflowABRun,
  revealed: boolean,
): VideoWorkflowABRunDto {
  return {
    blindId: run.blindId,
    blindSlot: run.blindSlot,
    pairIndex: run.pairIndex,
    executionOrder: run.executionOrder,
    warmup: run.warmup,
    status: run.status,
    queuedMs: run.queuedMs,
    generationMs: run.generationMs,
    totalMs: run.totalMs,
    peakVramMiB: run.peakVramMiB,
    ...(run.errorCode ? { errorCode: run.errorCode } : {}),
    ...(run.output
      ? {
          output: {
            contentType: run.output.contentType,
            sha256: run.output.sha256,
            bytes: run.output.bytes,
            durationMs: run.output.durationMs,
            width: run.output.width,
            height: run.output.height,
            videoCodec: run.output.videoCodec,
            ...(run.output.audioCodec
              ? { audioCodec: run.output.audioCodec }
              : {}),
            hasAudio: run.output.hasAudio,
            frameCount: run.output.frameCount,
            fps: run.output.fps,
            previewUrl: `/api/admin/video-workflow-ab/${encodeURIComponent(
              experimentId,
            )}/runs/${encodeURIComponent(run.blindId)}/content`,
          },
        }
      : {}),
    ...(run.review
      ? {
          review: {
            scores: structuredClone(run.review.scores),
            note: run.review.note,
            createdAt: run.review.createdAt,
          },
        }
      : {}),
    ...(revealed ? { variantId: run.variantId } : {}),
  };
}

export function asVideoWorkflowABDto(
  experiment: StoredVideoWorkflowABExperiment,
): VideoWorkflowABExperimentDto {
  const revealed = Boolean(experiment.revealedAt);
  return {
    id: experiment.id,
    projectId: experiment.projectId,
    title: experiment.title,
    synthetic: experiment.synthetic,
    status: experiment.status,
    input: structuredClone(experiment.input),
    environment: structuredClone(experiment.environment),
    weights: structuredClone(experiment.weights),
    ...(revealed
      ? {
          variants: experiment.variants.map(({ workflowFile, ...variant }) => {
            void workflowFile;
            return structuredClone(variant);
          }),
        }
      : {}),
    runs: experiment.runs
      .slice()
      .sort(
        (left, right) =>
          left.pairIndex - right.pairIndex ||
          left.blindSlot.localeCompare(right.blindSlot),
      )
      .map((run) => runDto(experiment.id, run, revealed)),
    postprocessLayerCount: experiment.postprocessLayers.length,
    revealed,
    eligibleForReview: scoredRuns(experiment).length >= 2,
    eligibleForApproval: approvalProtocolSatisfied(experiment),
    createdAt: experiment.createdAt,
    importedAt: experiment.importedAt,
    ...(experiment.reviewedAt ? { reviewedAt: experiment.reviewedAt } : {}),
    ...(experiment.revealedAt ? { revealedAt: experiment.revealedAt } : {}),
    ...(experiment.approvedAt ? { approvedAt: experiment.approvedAt } : {}),
    ...(experiment.selectedBlindRunId
      ? { selectedBlindRunId: experiment.selectedBlindRunId }
      : {}),
    ...(experiment.adoptedProjectAssetId
      ? { adoptedProjectAssetId: experiment.adoptedProjectAssetId }
      : {}),
    videoAssetReviewRequired: true,
  };
}

export async function listVideoWorkflowABExperiments(
  actor: AdminActor,
  options: ServiceOptions = {},
): Promise<VideoWorkflowABExperimentDto[]> {
  const repository = assertLocalAdapter(actor, options);
  return (await repository.list()).map(asVideoWorkflowABDto);
}

function blindSides(
  pairIndexes: number[],
  randomId: () => string,
): Map<number, { A: "left" | "right"; B: "left" | "right" }> {
  return new Map(
    pairIndexes.map((pairIndex) => {
      const digest = createHash("sha256").update(randomId()).digest();
      const aSide = digest[0]! % 2 === 0 ? "left" : "right";
      return [
        pairIndex,
        {
          A: aSide,
          B: aSide === "left" ? "right" : "left",
        },
      ];
    }),
  );
}

export async function importVideoWorkflowABExperiment(
  actor: AdminActor,
  input: {
    packageBytes: Uint8Array;
    reason: string;
    idempotencyKey: string;
    requestId: string;
  },
  options: ServiceOptions = {},
): Promise<{ experiment: VideoWorkflowABExperimentDto; created: boolean }> {
  const repository = assertLocalAdapter(actor, options);
  const reason = cleanReason(input.reason);
  const key = cleanIdempotencyKey(input.idempotencyKey);
  const validated = await validateVideoWorkflowABPackage(
    input.packageBytes,
    options.packageValidation,
  );
  const manifest = validated.manifest;
  const fingerprint = canonicalSha256({
    action: "import",
    actorId: actor.userId,
    reason,
    manifest,
  });
  const replay = await repository.findIdempotency(key);
  if (replay) {
    if (replay.fingerprint !== fingerprint) {
      throw new Error("Idempotency key conflicts with another A/B import.");
    }
    const existing = await repository.get(replay.experimentId);
    if (!existing) throw new Error("A/B idempotency record is incomplete.");
    return { experiment: asVideoWorkflowABDto(existing), created: false };
  }
  const asset = await (options.resolveProjectAsset ?? getProjectAsset)(
    manifest.experiment.projectId,
    manifest.input.imageAssetId,
  );
  if (
    !asset ||
    asset.modality !== "image" ||
    asset.contentHash !== manifest.input.imageSha256
  ) {
    throw new Error("A/B input image is not a matching project asset.");
  }
  const randomId = options.randomId ?? randomUUID;
  const now = options.now?.() ?? new Date();
  const pairIndexes = [...new Set(manifest.runs.map((run) => run.pairIndex))];
  const sides = blindSides(pairIndexes, randomId);
  const variants = await Promise.all(
    manifest.variants.map(async (variant) => {
      const bytes = validated.files.get(variant.workflowPath)!;
      const workflowFile = await repository.writeContentAddressedFile(
        "workflow",
        variant.workflowSha256,
        "application/json",
        bytes,
      );
      const { workflowPath, ...rest } = variant;
      void workflowPath;
      return { ...rest, workflowFile };
    }),
  );
  const runs: StoredVideoWorkflowABRun[] = [];
  for (const run of manifest.runs) {
    const blindId = `blind-${randomId()}`;
    let output: StoredVideoWorkflowABRun["output"];
    let firstFrame: StoredVideoWorkflowABRun["firstFrame"];
    let lastFrame: StoredVideoWorkflowABRun["lastFrame"];
    if (run.output && run.firstFrame && run.lastFrame) {
      const outputFile = await repository.writeContentAddressedFile(
        "artifact",
        run.output.sha256,
        run.output.contentType,
        validated.files.get(run.output.path)!,
      );
      const firstFile = await repository.writeContentAddressedFile(
        "artifact",
        run.firstFrame.sha256,
        run.firstFrame.contentType,
        validated.files.get(run.firstFrame.path)!,
      );
      const lastFile = await repository.writeContentAddressedFile(
        "artifact",
        run.lastFrame.sha256,
        run.lastFrame.contentType,
        validated.files.get(run.lastFrame.path)!,
      );
      const { path: outputPath, ...outputRest } = run.output;
      const { path: firstPath, ...firstRest } = run.firstFrame;
      const { path: lastPath, ...lastRest } = run.lastFrame;
      void outputPath;
      void firstPath;
      void lastPath;
      output = { ...outputRest, artifactFile: outputFile };
      firstFrame = { ...firstRest, artifactFile: firstFile };
      lastFrame = { ...lastRest, artifactFile: lastFile };
    }
    runs.push({
      id: run.id,
      variantId: run.variantId,
      blindId,
      blindSlot: sides.get(run.pairIndex)![run.variantId],
      pairIndex: run.pairIndex,
      executionOrder: run.executionOrder,
      warmup: run.warmup,
      status: run.status,
      queuedMs: run.queuedMs,
      generationMs: run.generationMs,
      totalMs: run.totalMs,
      peakVramMiB: run.peakVramMiB,
      ...(run.errorCode ? { errorCode: run.errorCode } : {}),
      ...(output ? { output } : {}),
      ...(firstFrame ? { firstFrame } : {}),
      ...(lastFrame ? { lastFrame } : {}),
    });
  }
  const postprocessLayers = [];
  for (const layer of manifest.postprocessLayers ?? []) {
    const file = await repository.writeContentAddressedFile(
      "artifact",
      layer.output.sha256,
      layer.output.contentType,
      validated.files.get(layer.output.path)!,
    );
    const { path, ...output } = layer.output;
    void path;
    postprocessLayers.push({
      id: layer.id,
      parentOutputSha256: layer.parentOutputSha256,
      operations: [...layer.operations],
      output: { ...output, artifactFile: file },
    });
  }
  const experiment: StoredVideoWorkflowABExperiment = {
    schemaVersion: 1,
    id: manifest.experiment.id,
    projectId: manifest.experiment.projectId,
    title: manifest.experiment.title,
    synthetic: manifest.experiment.synthetic,
    status: "completed",
    input: structuredClone(manifest.input),
    environment: structuredClone(manifest.environment),
    weights: structuredClone(manifest.weights),
    variants: variants as StoredVideoWorkflowABExperiment["variants"],
    runs,
    postprocessLayers,
    createdAt: manifest.experiment.createdAt,
    importedAt: now.toISOString(),
  };
  const result = await repository.create(
    experiment,
    idempotency(key, fingerprint, experiment.id, "import", now),
    audit(
      actor,
      "video_workflow_ab.import",
      experiment.id,
      reason,
      input.requestId,
      now,
    ),
  );
  return {
    experiment: asVideoWorkflowABDto(result.experiment),
    created: result.created,
  };
}

function validateScores(value: VideoWorkflowABReviewScores): VideoWorkflowABReviewScores {
  const keys: Array<keyof VideoWorkflowABReviewScores> = [
    "firstFrameFidelity",
    "lastFrameIdentityFidelity",
    "characterConsistency",
    "motionCoherence",
    "artifactCleanliness",
  ];
  const result = {} as VideoWorkflowABReviewScores;
  for (const key of keys) {
    const score = Number(value[key]);
    if (!Number.isInteger(score) || score < 1 || score > 5) {
      throw new Error("A/B review scores must be integers from 1 to 5.");
    }
    result[key] = score;
  }
  return result;
}

export async function mutateVideoWorkflowABExperiment(
  actor: AdminActor,
  experimentId: string,
  input: VideoWorkflowABMutationInput & {
    reason: string;
    idempotencyKey: string;
    requestId: string;
  },
  options: ServiceOptions = {},
): Promise<{ experiment: VideoWorkflowABExperimentDto; changed: boolean }> {
  const repository = assertLocalAdapter(actor, options);
  const id = cleanId(experimentId, "Experiment id");
  const current = await repository.get(id);
  if (!current) throw new Error("A/B experiment does not exist.");
  const reason = cleanReason(input.reason);
  const key = cleanIdempotencyKey(input.idempotencyKey);
  const now = options.now?.() ?? new Date();
  const semantic = {
    action: input.action,
    actorId: actor.userId,
    experimentId: id,
    ...(input.action === "review_run"
      ? {
          blindRunId: input.blindRunId,
          scores: input.scores,
          note: input.note ?? "",
        }
      : {}),
    ...("blindRunId" in input && input.action === "approve"
      ? { blindRunId: input.blindRunId }
      : {}),
    reason,
  };
  const result = await repository.mutateExperiment(
    id,
    idempotency(
      key,
      canonicalSha256(semantic),
      id,
      input.action === "review_run" ? "review" : "transition",
      now,
    ),
    audit(
      actor,
      `video_workflow_ab.${input.action}`,
      id,
      reason,
      input.requestId,
      now,
    ),
    (experiment) => {
      if (input.action === "review_run") {
        if (experiment.status !== "completed") {
          throw new Error("Only completed experiments can be reviewed.");
        }
        const run = experiment.runs.find(
          (candidate) => candidate.blindId === input.blindRunId,
        );
        if (!run || run.warmup || run.status !== "succeeded") {
          throw new Error("Only measured successful blind runs can be scored.");
        }
        const note = (input.note ?? "").trim();
        if (note.length > 500 || /[\u0000-\u001f<>]/.test(note)) {
          throw new Error("A/B review note is invalid.");
        }
        run.review = {
          scores: validateScores(input.scores),
          note,
          actorId: actor.userId,
          createdAt: now.toISOString(),
        };
        return;
      }
      if (input.action === "finalize_review") {
        if (experiment.status !== "completed") {
          throw new Error("Only completed experiments can finish review.");
        }
        if (!approvalProtocolSatisfied(experiment)) {
          throw new Error(
            "Review requires scored successful A/B pairs with alternating execution order.",
          );
        }
        experiment.status = "reviewed";
        experiment.reviewedAt = now.toISOString();
        return;
      }
      if (input.action === "reveal") {
        if (experiment.status !== "reviewed") {
          throw new Error("Only reviewed experiments can be revealed.");
        }
        experiment.revealedAt = now.toISOString();
        return;
      }
      if (input.action === "approve") {
        if (experiment.status !== "reviewed" || !experiment.revealedAt) {
          throw new Error("Experiment must be reviewed and revealed before approval.");
        }
        if (experiment.synthetic && !options.allowSyntheticApproval) {
          throw new Error("Synthetic experiments cannot be approved.");
        }
        const run = experiment.runs.find(
          (candidate) => candidate.blindId === input.blindRunId,
        );
        if (!run || run.warmup || run.status !== "succeeded" || !run.review) {
          throw new Error("Approved run must be a scored successful measured run.");
        }
        experiment.status = "approved";
        experiment.selectedBlindRunId = run.blindId;
        experiment.approvedAt = now.toISOString();
        return;
      }
      if (input.action === "reject") {
        if (experiment.status !== "reviewed" || !experiment.revealedAt) {
          throw new Error("Experiment must be reviewed and revealed before rejection.");
        }
        experiment.status = "rejected";
        experiment.rejectedAt = now.toISOString();
        return;
      }
      if (input.action === "offline") {
        if (experiment.status !== "approved") {
          throw new Error("Only approved experiments can be taken offline.");
        }
        experiment.status = "offline";
        experiment.offlineAt = now.toISOString();
      }
    },
  );
  return {
    experiment: asVideoWorkflowABDto(result.experiment),
    changed: result.changed,
  };
}

export async function adoptApprovedVideoWorkflowABRun(
  actor: AdminActor,
  experimentId: string,
  input: {
    reason: string;
    idempotencyKey: string;
    requestId: string;
  },
  options: ServiceOptions = {},
): Promise<{
  experiment: VideoWorkflowABExperimentDto;
  asset: ProjectAsset;
  created: boolean;
  videoAssetReviewRequired: true;
}> {
  const repository = assertLocalAdapter(actor, options);
  const id = cleanId(experimentId, "Experiment id");
  const experiment = await repository.get(id);
  if (
    !experiment ||
    experiment.status !== "approved" ||
    !experiment.selectedBlindRunId
  ) {
    throw new Error("Only an approved A/B run can enter the project asset library.");
  }
  if (experiment.synthetic && !options.allowSyntheticApproval) {
    throw new Error("Synthetic experiments cannot enter the project asset library.");
  }
  const run = experiment.runs.find(
    (candidate) => candidate.blindId === experiment.selectedBlindRunId,
  );
  if (!run?.output) throw new Error("Approved A/B run has no safe video output.");
  const reason = cleanReason(input.reason);
  const key = cleanIdempotencyKey(input.idempotencyKey);
  const now = options.now?.() ?? new Date();
  const bytes = await repository.readStoredFile(run.output.artifactFile);
  if (
    bytes.byteLength !== run.output.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== run.output.sha256
  ) {
    throw new Error("Approved A/B output failed integrity validation.");
  }
  const mirrored = await (options.mirrorMedia ?? cacheMediaBytes)(
    bytes,
    run.output.contentType,
  );
  const variant = experiment.variants.find(
    (candidate) => candidate.id === run.variantId,
  )!;
  const candidate: ProjectAsset = {
    id: randomUUID(),
    projectId: experiment.projectId,
    jobId: `ab:${experiment.id}:${run.id}`,
    provider: "comfyui",
    modality: "video",
    status: "ready",
    name: `${experiment.title} · 获批样本 ${run.output.sha256.slice(0, 8)}`,
    url: mirrored.url,
    contentHash: run.output.sha256,
    contentType: run.output.contentType,
    bytes: run.output.bytes,
    orientation:
      run.output.width === run.output.height
        ? "square"
        : run.output.width > run.output.height
          ? "landscape"
          : "portrait",
    seed: experiment.input.seed,
    provenance: {
      source: "aistory-video-ab-experiment",
      experimentId: experiment.id,
      runId: run.id,
      variantId: run.variantId,
      workflowSha256: variant.workflowSha256,
    },
    generatedAt: experiment.importedAt,
    createdAt: now.toISOString(),
  };
  const saved: AdoptProjectAssetResult = await (
    options.saveProjectAsset ?? saveProjectAssetIfAbsent
  )(candidate);
  const semantic = {
    action: "adopt",
    actorId: actor.userId,
    experimentId: id,
    selectedBlindRunId: run.blindId,
    outputSha256: run.output.sha256,
    projectAssetId: saved.asset.id,
    reason,
  };
  const mutation = await repository.mutateExperiment(
    id,
    idempotency(key, canonicalSha256(semantic), id, "adopt", now),
    audit(
      actor,
      "video_workflow_ab.adopt_project_asset",
      id,
      reason,
      input.requestId,
      now,
    ),
    (stored) => {
      if (
        stored.status !== "approved" ||
        stored.selectedBlindRunId !== run.blindId
      ) {
        throw new Error("A/B approval changed before adoption completed.");
      }
      stored.adoptedProjectAssetId = saved.asset.id;
    },
  );
  return {
    experiment: asVideoWorkflowABDto(mutation.experiment),
    asset: saved.asset,
    created: saved.created,
    videoAssetReviewRequired: true,
  };
}

export async function getVideoWorkflowABBlindRunFile(
  actor: AdminActor,
  experimentId: string,
  blindRunId: string,
  options: ServiceOptions = {},
): Promise<{
  file: string;
  contentType: "video/mp4" | "video/webm";
} | null> {
  const repository = assertLocalAdapter(actor, options);
  const experiment = await repository.get(cleanId(experimentId, "Experiment id"));
  if (!experiment) return null;
  const run = experiment.runs.find(
    (candidate) => candidate.blindId === blindRunId,
  );
  if (
    !run?.output ||
    (run.output.contentType !== "video/mp4" &&
      run.output.contentType !== "video/webm")
  ) {
    return null;
  }
  return {
    file: repository.resolveStoredFile(run.output.artifactFile),
    contentType: run.output.contentType,
  };
}
