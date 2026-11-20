import "server-only";

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { listStoredGenerationJobs } from "@/lib/generation-jobs/store";
import type { StoredGenerationJob } from "@/lib/generation-jobs/types";
import { listComfyUIWorkflowTemplates } from "@/lib/providers/comfyui/registry";
import { getLocalVideoAssetRepository } from "@/lib/video-assets/repository";
import type { StoredVideoAsset } from "@/lib/video-assets/repository";
import {
  deriveSteamVideoProductionPlan,
  type SteamVideoProductionPlan,
  type SteamVideoProductionPlanAssetSnapshot,
  type SteamVideoProductionPlanDesignation,
  type SteamVideoProductionPlanJobSnapshot,
  type SteamVideoProductionPlanNodeInput,
} from "@/lib/steam/productionPlan";
import {
  STEAM_LAUNCH_CASE_ID,
  STEAM_LAUNCH_PROJECT_REF,
  STEAM_LAUNCH_STORY_ID,
  STEAM_LAUNCH_STORY_VERSION,
} from "@/lib/steam/releaseContent";

const PUBLIC_STORY_FILE = path.join(
  /* turbopackIgnore: true */ process.cwd(),
  "public",
  "case-studies",
  STEAM_LAUNCH_CASE_ID,
  "story.json",
);

type JsonRecord = Record<string, unknown>;
type PlanReaders = {
  readPublicStory: () => Promise<unknown>;
  sourceExists: (publicUrl: string) => Promise<boolean>;
  listJobs: () => Promise<StoredGenerationJob[]>;
  listAssets: () => Promise<StoredVideoAsset[]>;
  listWorkflows: () => Promise<
    Array<{ modality: "image" | "video"; enabled: boolean }>
  >;
  now: () => string;
};

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function safeString(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)
    ? value
    : null;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as JsonRecord;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(",")}}`;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

async function defaultReadPublicStory(): Promise<unknown> {
  return JSON.parse(await readFile(PUBLIC_STORY_FILE, "utf8")) as unknown;
}

async function defaultSourceExists(publicUrl: string): Promise<boolean> {
  const prefix = `/case-studies/${STEAM_LAUNCH_CASE_ID}/assets/`;
  if (!publicUrl.startsWith(prefix) || publicUrl.includes("..")) return false;
  const relative = publicUrl.slice(1).split("/");
  if (relative.some((part) => !part || !/^[A-Za-z0-9._-]+$/.test(part))) {
    return false;
  }
  try {
    const target = path.resolve(
      /* turbopackIgnore: true */ process.cwd(),
      "public",
      ...relative,
    );
    const expectedRoot = path.resolve(
      /* turbopackIgnore: true */ process.cwd(),
      "public",
      "case-studies",
      STEAM_LAUNCH_CASE_ID,
      "assets",
    );
    if (!target.startsWith(`${expectedRoot}${path.sep}`)) return false;
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}

const defaultReaders: PlanReaders = {
  readPublicStory: defaultReadPublicStory,
  sourceExists: defaultSourceExists,
  listJobs: listStoredGenerationJobs,
  listAssets: () => getLocalVideoAssetRepository().list(),
  listWorkflows: listComfyUIWorkflowTemplates,
  now: () => new Date().toISOString(),
};

function blockedDesignation(
  blockedReason: "release_story_not_designated" | "authoritative_graph_invalid",
  sourceContentHash: string,
  publicNodeCount: number,
): SteamVideoProductionPlanDesignation {
  return {
    status: "blocked",
    blockedReason,
    candidates: [
      {
        caseId: STEAM_LAUNCH_CASE_ID,
        version: STEAM_LAUNCH_STORY_VERSION,
        publicNodeCount,
        sourceContentHash,
      },
    ],
  };
}

async function projectAuthoritativeGraph(
  raw: unknown,
  sourceExists: PlanReaders["sourceExists"],
): Promise<{
  designation: SteamVideoProductionPlanDesignation;
  nodes: SteamVideoProductionPlanNodeInput[];
}> {
  const root = record(raw);
  const session = record(root?.session);
  const cacheIdentity = record(session?.cacheIdentity);
  const authored = record(session?.authoredStory);
  const rawNodes = Array.isArray(authored?.nodes) ? authored.nodes : [];
  const safeFileHash = sha256(raw);
  const sourceGraphHash = sha256({
    caseId: STEAM_LAUNCH_CASE_ID,
    storyId: STEAM_LAUNCH_STORY_ID,
    version: STEAM_LAUNCH_STORY_VERSION,
    projectRef: STEAM_LAUNCH_PROJECT_REF,
    publicGraph: raw,
  });
  if (
    cacheIdentity?.visibility !== "public" ||
    cacheIdentity?.storyId !== STEAM_LAUNCH_STORY_ID ||
    cacheIdentity?.templateId !== STEAM_LAUNCH_CASE_ID ||
    cacheIdentity?.version !== STEAM_LAUNCH_STORY_VERSION ||
    authored?.caseStudyId !== STEAM_LAUNCH_CASE_ID ||
    authored?.version !== STEAM_LAUNCH_STORY_VERSION ||
    authored?.authorLocked !== true ||
    rawNodes.length === 0
  ) {
    return {
      designation: blockedDesignation(
        "release_story_not_designated",
        safeFileHash,
        0,
      ),
      nodes: [],
    };
  }

  const projected = await Promise.all(
    rawNodes.map(async (value, ordinal) => {
      const node = record(value);
      const scene = record(node?.scene);
      const nodeId = safeString(node?.nodeId);
      const sourceSceneId = safeString(node?.sourceSceneId);
      const episodeId = safeString(node?.episodeId);
      const sceneId = safeString(scene?.id);
      const imageUrl = typeof scene?.imageUrl === "string" ? scene.imageUrl : "";
      if (
        !nodeId ||
        !sourceSceneId ||
        !episodeId ||
        !sceneId ||
        node?.releasePolicy !== "public"
      ) {
        return null;
      }
      return {
        ordinal,
        nodeId,
        sceneId: sourceSceneId,
        episodeId,
        releasePolicy: "public" as const,
        sourceContentHash: sha256({
          caseId: STEAM_LAUNCH_CASE_ID,
          storyId: STEAM_LAUNCH_STORY_ID,
          version: STEAM_LAUNCH_STORY_VERSION,
          projectRef: STEAM_LAUNCH_PROJECT_REF,
          node: value,
        }),
        sourceAvailable: await sourceExists(imageUrl),
      };
    }),
  );
  const nodes = projected.filter(
    (node): node is SteamVideoProductionPlanNodeInput => node !== null,
  );
  if (nodes.length !== rawNodes.length || nodes.length === 0) {
    return {
      designation: blockedDesignation(
        "authoritative_graph_invalid",
        safeFileHash,
        nodes.length,
      ),
      nodes: [],
    };
  }
  return {
    designation: {
      status: "designated",
      caseId: STEAM_LAUNCH_CASE_ID,
      storyId: STEAM_LAUNCH_STORY_ID,
      version: STEAM_LAUNCH_STORY_VERSION,
      projectRef: STEAM_LAUNCH_PROJECT_REF,
      sourceGraphHash,
      evidence: ["steam_default_case", "public_author_locked_bundle"],
    },
    nodes,
  };
}

function projectJob(job: StoredGenerationJob): SteamVideoProductionPlanJobSnapshot {
  const input = record(job.input);
  const taskType = input?.taskType === "generate" || input?.taskType === "upscale"
    ? input.taskType
    : undefined;
  return {
    jobId: job.id,
    idempotencyKey: job.idempotencyKey,
    provider:
      job.provider === "comfyui" || job.provider === "gpu-connector-lan"
        ? job.provider
        : "other",
    modality: job.modality,
    status: job.status,
    ...(taskType ? { taskType } : {}),
    exactWorkflowPin:
      job.provider !== "comfyui" ||
      (typeof job.workflowId === "string" &&
        Number.isSafeInteger(job.workflowVersion) &&
        typeof job.workflowFingerprint === "string" &&
        /^[a-f0-9]{64}$/.test(job.workflowFingerprint)),
    artifactAvailable: Boolean(job.artifact),
    ...(job.releaseClassification
      ? { releaseClassification: job.releaseClassification }
      : {}),
  };
}

function projectAsset(asset: StoredVideoAsset): SteamVideoProductionPlanAssetSnapshot {
  return {
    assetId: asset.id,
    ...(asset.storyId ? { storyId: asset.storyId } : {}),
    ...(asset.nodeId ? { nodeId: asset.nodeId } : {}),
    status: asset.status,
    releasePolicy: asset.releasePolicy,
    hasAudio: asset.hasAudio,
    subtitleCount: asset.subtitles.length,
    ...(asset.generation?.jobId
      ? { generationJobId: asset.generation.jobId }
      : {}),
  };
}

export async function readSteamVideoProductionPlan(
  overrides: Partial<PlanReaders> = {},
): Promise<SteamVideoProductionPlan> {
  const readers = { ...defaultReaders, ...overrides };
  const graph = await projectAuthoritativeGraph(
    await readers.readPublicStory(),
    readers.sourceExists,
  );
  if (graph.designation.status === "blocked") {
    return deriveSteamVideoProductionPlan({
      observedAt: readers.now(),
      designation: graph.designation,
      nodes: [],
      jobs: [],
      assets: [],
      capabilities: {
        enabledOriginalVideoTemplateCount: 0,
        enabledUpscaleTemplateCount: 0,
        subtitleAudioAttach: false,
      },
    });
  }
  const [jobs, assets, workflows] = await Promise.all([
    readers.listJobs(),
    readers.listAssets(),
    readers.listWorkflows(),
  ]);
  const enabledVideoTemplates = workflows.filter(
    (workflow) => workflow.enabled && workflow.modality === "video",
  );
  return deriveSteamVideoProductionPlan({
    observedAt: readers.now(),
    designation: graph.designation,
    nodes: graph.nodes,
    jobs: jobs.map(projectJob),
    assets: assets.map(projectAsset),
    capabilities: {
      enabledOriginalVideoTemplateCount: enabledVideoTemplates.length,
      // Registry v1 has no validated purpose/capability field for upscaling.
      // Never infer this from a template id or display name.
      enabledUpscaleTemplateCount: 0,
      // There is no registered execution adapter for this stage yet.
      subtitleAudioAttach: false,
    },
  });
}
