export const STEAM_VIDEO_PRODUCTION_PLAN_SCHEMA =
  "aistory-steam-video-production-plan";
export const STEAM_VIDEO_PRODUCTION_PLAN_SCHEMA_VERSION = 1 as const;
export const STEAM_VIDEO_PRODUCTION_PLAN_JSON_FILENAME =
  "aistory-steam-video-production-plan-v1.json";
export const STEAM_VIDEO_PRODUCTION_PLAN_CSV_FILENAME =
  "aistory-steam-video-production-plan-v1.csv";

export const STEAM_VIDEO_PRODUCTION_PLAN_STAGES = [
  "original_video",
  "upscale",
  "subtitle_audio_attach",
  "review",
  "publish",
] as const;

export const STEAM_VIDEO_PRODUCTION_PLAN_STATUSES = [
  "missing_source",
  "blocked",
  "ready",
  "queued",
  "generated",
  "upscale_pending",
  "review_pending",
  "approved",
  "published",
] as const;

export type SteamVideoProductionPlanStage =
  (typeof STEAM_VIDEO_PRODUCTION_PLAN_STAGES)[number];
export type SteamVideoProductionPlanStatus =
  (typeof STEAM_VIDEO_PRODUCTION_PLAN_STATUSES)[number];

export type SteamVideoProductionPlanBlocker =
  | "release_story_not_designated"
  | "authoritative_graph_invalid"
  | "source_media_missing"
  | "workflow_capability_missing"
  | "workflow_pin_missing"
  | "non_publishable_job"
  | "job_artifact_missing"
  | "job_stage_mismatch"
  | "ambiguous_job_binding"
  | "ambiguous_asset_binding"
  | "dependency_not_ready"
  | "video_asset_not_adopted"
  | "attach_capability_missing"
  | "asset_offline"
  | "release_policy_not_public";

export type SteamVideoProductionPlanArtifactType =
  | "video_original"
  | "video_upscaled"
  | "video_with_subtitle_audio"
  | "review_decision"
  | "public_video_release";

export type SteamVideoProductionPlanNodeInput = {
  ordinal: number;
  nodeId: string;
  sceneId: string;
  episodeId: string;
  releasePolicy: "public";
  sourceContentHash: string;
  sourceAvailable: boolean;
};

export type SteamVideoProductionPlanJobSnapshot = {
  jobId: string;
  idempotencyKey: string;
  provider: "comfyui" | "gpu-connector-lan" | "other";
  modality: "video" | "image";
  status:
    | "queued"
    | "running"
    | "pending"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "interrupted";
  taskType?: "generate" | "upscale";
  exactWorkflowPin: boolean;
  artifactAvailable: boolean;
  releaseClassification?: "non_publishable";
};

export type SteamVideoProductionPlanAssetSnapshot = {
  assetId: string;
  storyId?: string;
  nodeId?: string;
  status: "draft" | "review_pending" | "publishable" | "offline";
  releasePolicy: "public" | "internal" | "enterprise";
  hasAudio: boolean;
  subtitleCount: number;
  generationJobId?: string;
};

export type SteamVideoProductionPlanDesignation =
  | {
      status: "designated";
      caseId: string;
      storyId: string;
      version: string;
      projectRef: string;
      sourceGraphHash: string;
      evidence: readonly ["steam_default_case", "public_author_locked_bundle"];
    }
  | {
      status: "blocked";
      blockedReason:
        | "release_story_not_designated"
        | "authoritative_graph_invalid";
      candidates: Array<{
        caseId: string;
        version: string;
        publicNodeCount: number;
        sourceContentHash: string;
      }>;
    };

export type SteamVideoProductionPlanTask = {
  taskId: string;
  projectRef: string;
  storyId: string;
  nodeId: string;
  sceneId: string;
  episodeId: string;
  sourceContentHash: string;
  priority: "launch_p0";
  batch: 1 | 2 | 3 | 4 | 5;
  stage: SteamVideoProductionPlanStage;
  artifactType: SteamVideoProductionPlanArtifactType;
  outputRef: string;
  dependencies: string[];
  optionalDependencies: string[];
  optional: boolean;
  requiredCapabilities: string[];
  status: SteamVideoProductionPlanStatus;
  blockerCodes: SteamVideoProductionPlanBlocker[];
};

export type SteamVideoProductionPlan = {
  schema: typeof STEAM_VIDEO_PRODUCTION_PLAN_SCHEMA;
  schemaVersion: typeof STEAM_VIDEO_PRODUCTION_PLAN_SCHEMA_VERSION;
  mode: "plan_only";
  executionAllowed: false;
  observedAt: string;
  publicationScope: "asset_publication";
  designation: SteamVideoProductionPlanDesignation;
  gpu: {
    connected: false;
    executionAllowed: false;
    state: "not_probed";
  };
  capabilities: {
    originalVideo: {
      state: "available" | "missing";
      enabledTemplateCount: number;
    };
    upscale: {
      state: "available" | "missing";
      enabledTemplateCount: number;
    };
    subtitleAudioAttach: {
      state: "available" | "missing";
    };
  };
  summary: Record<"total" | SteamVideoProductionPlanStatus, number>;
  batches: Array<{
    batch: 1 | 2 | 3 | 4 | 5;
    stage: SteamVideoProductionPlanStage;
    taskIds: string[];
    statusCounts: Record<SteamVideoProductionPlanStatus, number>;
  }>;
  tasks: SteamVideoProductionPlanTask[];
};

export type DeriveSteamVideoProductionPlanInput = {
  observedAt: string;
  designation: SteamVideoProductionPlanDesignation;
  nodes: SteamVideoProductionPlanNodeInput[];
  jobs: SteamVideoProductionPlanJobSnapshot[];
  assets: SteamVideoProductionPlanAssetSnapshot[];
  capabilities: {
    enabledOriginalVideoTemplateCount: number;
    enabledUpscaleTemplateCount: number;
    subtitleAudioAttach: boolean;
  };
};

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ACTIVE_JOB_STATUSES = new Set(["queued", "running", "pending"]);

const STAGE_META: Record<
  SteamVideoProductionPlanStage,
  {
    batch: 1 | 2 | 3 | 4 | 5;
    artifactType: SteamVideoProductionPlanArtifactType;
    requiredCapabilities: string[];
    optional: boolean;
  }
> = {
  original_video: {
    batch: 1,
    artifactType: "video_original",
    requiredCapabilities: ["video_generation"],
    optional: false,
  },
  upscale: {
    batch: 2,
    artifactType: "video_upscaled",
    requiredCapabilities: ["video_upscale"],
    optional: true,
  },
  subtitle_audio_attach: {
    batch: 3,
    artifactType: "video_with_subtitle_audio",
    requiredCapabilities: ["subtitle_attach", "audio_attach"],
    optional: false,
  },
  review: {
    batch: 4,
    artifactType: "review_decision",
    requiredCapabilities: ["video_asset_review"],
    optional: false,
  },
  publish: {
    batch: 5,
    artifactType: "public_video_release",
    requiredCapabilities: ["video_asset_publish"],
    optional: false,
  },
};

function emptyStatusCounts(): Record<SteamVideoProductionPlanStatus, number> {
  return Object.fromEntries(
    STEAM_VIDEO_PRODUCTION_PLAN_STATUSES.map((status) => [status, 0]),
  ) as Record<SteamVideoProductionPlanStatus, number>;
}

function taskId(
  designation: Extract<SteamVideoProductionPlanDesignation, { status: "designated" }>,
  node: SteamVideoProductionPlanNodeInput,
  stage: SteamVideoProductionPlanStage,
): string {
  return `svp1-${designation.sourceGraphHash.slice(0, 24)}-${node.sourceContentHash.slice(0, 24)}-${stage}`;
}

function outputRef(
  designation: Extract<SteamVideoProductionPlanDesignation, { status: "designated" }>,
  node: SteamVideoProductionPlanNodeInput,
  stage: SteamVideoProductionPlanStage,
): string {
  return `steam-video:v1:${designation.sourceGraphHash.slice(0, 24)}:${node.sourceContentHash.slice(0, 24)}:${stage}`;
}

function safeDesignation(
  designation: SteamVideoProductionPlanDesignation,
): designation is Extract<SteamVideoProductionPlanDesignation, { status: "designated" }> {
  return (
    designation.status === "designated" &&
    SAFE_ID.test(designation.caseId) &&
    SAFE_ID.test(designation.storyId) &&
    SAFE_ID.test(designation.version) &&
    SAFE_ID.test(designation.projectRef) &&
    SHA256.test(designation.sourceGraphHash)
  );
}

function validNodes(nodes: SteamVideoProductionPlanNodeInput[]): boolean {
  const nodeIds = new Set<string>();
  return nodes.length > 0 && nodes.every((node) => {
    if (
      !Number.isSafeInteger(node.ordinal) ||
      node.ordinal < 0 ||
      !SAFE_ID.test(node.nodeId) ||
      !SAFE_ID.test(node.sceneId) ||
      !SAFE_ID.test(node.episodeId) ||
      !SHA256.test(node.sourceContentHash) ||
      node.releasePolicy !== "public" ||
      nodeIds.has(node.nodeId)
    ) {
      return false;
    }
    nodeIds.add(node.nodeId);
    return true;
  });
}

function matchingJobs(
  jobs: SteamVideoProductionPlanJobSnapshot[],
  id: string,
): SteamVideoProductionPlanJobSnapshot[] {
  return jobs.filter((job) => job.idempotencyKey === id);
}

function matchingNodeAssets(
  assets: SteamVideoProductionPlanAssetSnapshot[],
  storyId: string,
  nodeId: string,
): SteamVideoProductionPlanAssetSnapshot[] {
  return assets.filter(
    (asset) => asset.storyId === storyId && asset.nodeId === nodeId,
  );
}

function classifyAsset(
  asset: SteamVideoProductionPlanAssetSnapshot,
  jobs: SteamVideoProductionPlanJobSnapshot[],
  originalTaskId: string,
  upscaleTaskId: string,
): "original" | "upscale" | "unresolved" {
  if (!asset.generationJobId) return "original";
  const linked = jobs.filter((job) => job.jobId === asset.generationJobId);
  if (linked.length !== 1 || linked[0]!.modality !== "video") return "unresolved";
  const job = linked[0]!;
  if (job.idempotencyKey === upscaleTaskId) {
    return job.taskType === "upscale" ? "upscale" : "unresolved";
  }
  if (job.idempotencyKey === originalTaskId) {
    return job.taskType === "upscale" ? "unresolved" : "original";
  }
  if (job.taskType === "upscale") return "upscale";
  if (job.taskType === "generate" || job.provider === "comfyui") return "original";
  return "unresolved";
}

function jobStatus(
  matches: SteamVideoProductionPlanJobSnapshot[],
  expectedStage: "original_video" | "upscale",
): Pick<SteamVideoProductionPlanTask, "status" | "blockerCodes"> | null {
  if (matches.length > 1) {
    return { status: "blocked", blockerCodes: ["ambiguous_job_binding"] };
  }
  const job = matches[0];
  if (!job) return null;
  if (job.releaseClassification === "non_publishable") {
    return { status: "blocked", blockerCodes: ["non_publishable_job"] };
  }
  const stageMatches =
    job.modality === "video" &&
    (expectedStage === "upscale"
      ? job.taskType === "upscale"
      : job.taskType !== "upscale" &&
        (job.provider !== "gpu-connector-lan" || job.taskType === "generate"));
  if (!stageMatches) {
    return { status: "blocked", blockerCodes: ["job_stage_mismatch"] };
  }
  if (job.provider === "comfyui" && !job.exactWorkflowPin) {
    return { status: "blocked", blockerCodes: ["workflow_pin_missing"] };
  }
  if (ACTIVE_JOB_STATUSES.has(job.status)) {
    return { status: "queued", blockerCodes: [] };
  }
  if (job.status === "succeeded") {
    return job.artifactAvailable
      ? { status: "generated", blockerCodes: [] }
      : { status: "blocked", blockerCodes: ["job_artifact_missing"] };
  }
  return null;
}

function blockedTask(
  base: Omit<SteamVideoProductionPlanTask, "status" | "blockerCodes">,
  blocker: SteamVideoProductionPlanBlocker,
): SteamVideoProductionPlanTask {
  return { ...base, status: "blocked", blockerCodes: [blocker] };
}

function taskBase(
  designation: Extract<SteamVideoProductionPlanDesignation, { status: "designated" }>,
  node: SteamVideoProductionPlanNodeInput,
  stage: SteamVideoProductionPlanStage,
  dependencies: string[],
  optionalDependencies: string[] = [],
): Omit<SteamVideoProductionPlanTask, "status" | "blockerCodes"> {
  const meta = STAGE_META[stage];
  return {
    taskId: taskId(designation, node, stage),
    projectRef: designation.projectRef,
    storyId: designation.storyId,
    nodeId: node.nodeId,
    sceneId: node.sceneId,
    episodeId: node.episodeId,
    sourceContentHash: node.sourceContentHash,
    priority: "launch_p0",
    batch: meta.batch,
    stage,
    artifactType: meta.artifactType,
    outputRef: outputRef(designation, node, stage),
    dependencies,
    optionalDependencies,
    optional: meta.optional,
    requiredCapabilities: [...meta.requiredCapabilities],
  };
}

function blockedPlan(
  input: DeriveSteamVideoProductionPlanInput,
  reason: "release_story_not_designated" | "authoritative_graph_invalid",
): SteamVideoProductionPlan {
  const designation: SteamVideoProductionPlanDesignation =
    input.designation.status === "blocked"
      ? input.designation
      : { status: "blocked", blockedReason: reason, candidates: [] };
  return finalizePlan(input, designation, []);
}

function finalizePlan(
  input: DeriveSteamVideoProductionPlanInput,
  designation: SteamVideoProductionPlanDesignation,
  tasks: SteamVideoProductionPlanTask[],
): SteamVideoProductionPlan {
  const summary = { total: tasks.length, ...emptyStatusCounts() };
  for (const task of tasks) summary[task.status] += 1;
  const batches = STEAM_VIDEO_PRODUCTION_PLAN_STAGES.map((stage) => {
    const stageTasks = tasks.filter((task) => task.stage === stage);
    const statusCounts = emptyStatusCounts();
    for (const task of stageTasks) statusCounts[task.status] += 1;
    return {
      batch: STAGE_META[stage].batch,
      stage,
      taskIds: stageTasks.map((task) => task.taskId),
      statusCounts,
    };
  });
  return {
    schema: STEAM_VIDEO_PRODUCTION_PLAN_SCHEMA,
    schemaVersion: STEAM_VIDEO_PRODUCTION_PLAN_SCHEMA_VERSION,
    mode: "plan_only",
    executionAllowed: false,
    observedAt: input.observedAt,
    publicationScope: "asset_publication",
    designation,
    gpu: { connected: false, executionAllowed: false, state: "not_probed" },
    capabilities: {
      originalVideo: {
        state:
          input.capabilities.enabledOriginalVideoTemplateCount > 0
            ? "available"
            : "missing",
        enabledTemplateCount:
          input.capabilities.enabledOriginalVideoTemplateCount,
      },
      upscale: {
        state:
          input.capabilities.enabledUpscaleTemplateCount > 0
            ? "available"
            : "missing",
        enabledTemplateCount: input.capabilities.enabledUpscaleTemplateCount,
      },
      subtitleAudioAttach: {
        state: input.capabilities.subtitleAudioAttach ? "available" : "missing",
      },
    },
    summary,
    batches,
    tasks,
  };
}

export function deriveSteamVideoProductionPlan(
  input: DeriveSteamVideoProductionPlanInput,
): SteamVideoProductionPlan {
  if (input.designation.status === "blocked") {
    return blockedPlan(input, input.designation.blockedReason);
  }
  if (!safeDesignation(input.designation) || !validNodes(input.nodes)) {
    return blockedPlan(input, "authoritative_graph_invalid");
  }
  const designation = input.designation;
  const tasks: SteamVideoProductionPlanTask[] = [];
  for (const node of [...input.nodes].sort((a, b) => a.ordinal - b.ordinal)) {
    const originalBase = taskBase(designation, node, "original_video", []);
    const upscaleBase = taskBase(
      designation,
      node,
      "upscale",
      [originalBase.taskId],
    );
    const nodeAssets = matchingNodeAssets(
      input.assets,
      designation.storyId,
      node.nodeId,
    );
    const classifiedAssets = nodeAssets.map((asset) => ({
      asset,
      role: classifyAsset(
        asset,
        input.jobs,
        originalBase.taskId,
        upscaleBase.taskId,
      ),
    }));
    const unresolvedAssets = classifiedAssets.filter(
      (entry) => entry.role === "unresolved",
    );
    const originalAssets = classifiedAssets
      .filter((entry) => entry.role === "original")
      .map((entry) => entry.asset);
    const upscaleAssets = classifiedAssets
      .filter((entry) => entry.role === "upscale")
      .map((entry) => entry.asset);
    const originalJobs = matchingJobs(input.jobs, originalBase.taskId);
    const upscaleJobs = matchingJobs(input.jobs, upscaleBase.taskId);
    let original: SteamVideoProductionPlanTask;
    if (!node.sourceAvailable) {
      original = {
        ...originalBase,
        status: "missing_source",
        blockerCodes: ["source_media_missing"],
      };
    } else if (unresolvedAssets.length > 0 || originalAssets.length > 1) {
      original = blockedTask(originalBase, "ambiguous_asset_binding");
    } else if (originalAssets.length === 1) {
      original = { ...originalBase, status: "generated", blockerCodes: [] };
    } else {
      const projected = jobStatus(originalJobs, "original_video");
      original = projected
        ? { ...originalBase, ...projected }
        : input.capabilities.enabledOriginalVideoTemplateCount > 0
          ? { ...originalBase, status: "ready", blockerCodes: [] }
          : blockedTask(originalBase, "workflow_capability_missing");
    }
    tasks.push(original);

    let upscale: SteamVideoProductionPlanTask;
    if (original.status !== "generated") {
      upscale = blockedTask(upscaleBase, "dependency_not_ready");
    } else if (upscaleAssets.length > 1) {
      upscale = blockedTask(upscaleBase, "ambiguous_asset_binding");
    } else if (upscaleAssets.length === 1) {
      upscale = { ...upscaleBase, status: "generated", blockerCodes: [] };
    } else {
      const projected = jobStatus(upscaleJobs, "upscale");
      upscale = projected
        ? { ...upscaleBase, ...projected }
        : input.capabilities.enabledUpscaleTemplateCount > 0
          ? { ...upscaleBase, status: "upscale_pending", blockerCodes: [] }
          : blockedTask(upscaleBase, "workflow_capability_missing");
    }
    tasks.push(upscale);

    const attachBase = taskBase(
      designation,
      node,
      "subtitle_audio_attach",
      [original.taskId],
      [upscale.taskId],
    );
    const upscaleChosen = upscaleAssets.length > 0 || upscaleJobs.length > 0;
    const effectiveAsset = upscaleChosen
      ? upscaleAssets.length === 1
        ? upscaleAssets[0]
        : undefined
      : originalAssets.length === 1
        ? originalAssets[0]
        : undefined;
    let attach: SteamVideoProductionPlanTask;
    if (original.status !== "generated") {
      attach = blockedTask(attachBase, "dependency_not_ready");
    } else if (upscaleChosen && upscale.status !== "generated") {
      attach = blockedTask(attachBase, "dependency_not_ready");
    } else if (!effectiveAsset) {
      attach = blockedTask(attachBase, "video_asset_not_adopted");
    } else if (effectiveAsset.hasAudio && effectiveAsset.subtitleCount > 0) {
      attach = { ...attachBase, status: "generated", blockerCodes: [] };
    } else if (input.capabilities.subtitleAudioAttach) {
      attach = { ...attachBase, status: "ready", blockerCodes: [] };
    } else {
      attach = blockedTask(attachBase, "attach_capability_missing");
    }
    tasks.push(attach);

    const reviewBase = taskBase(
      designation,
      node,
      "review",
      [attach.taskId],
    );
    let review: SteamVideoProductionPlanTask;
    if (attach.status !== "generated" || !effectiveAsset) {
      review = blockedTask(reviewBase, "dependency_not_ready");
    } else if (effectiveAsset.status === "offline") {
      review = blockedTask(reviewBase, "asset_offline");
    } else if (effectiveAsset.status === "publishable") {
      review = { ...reviewBase, status: "approved", blockerCodes: [] };
    } else if (effectiveAsset.status === "review_pending") {
      review = { ...reviewBase, status: "review_pending", blockerCodes: [] };
    } else {
      review = { ...reviewBase, status: "ready", blockerCodes: [] };
    }
    tasks.push(review);

    const publishBase = taskBase(
      designation,
      node,
      "publish",
      [review.taskId],
    );
    let publish: SteamVideoProductionPlanTask;
    if (review.status !== "approved" || !effectiveAsset) {
      publish = blockedTask(publishBase, "dependency_not_ready");
    } else if (effectiveAsset.releasePolicy === "public") {
      publish = { ...publishBase, status: "published", blockerCodes: [] };
    } else {
      publish = blockedTask(publishBase, "release_policy_not_public");
    }
    tasks.push(publish);
  }
  return finalizePlan(input, designation, tasks);
}

export function serializeSteamVideoProductionPlanJson(
  plan: SteamVideoProductionPlan,
): string {
  return `${JSON.stringify(plan, null, 2)}\n`;
}

export function escapeSteamVideoProductionPlanCsvCell(
  value: string | number | boolean,
): string {
  let text = String(value);
  if (/^[=+\-@\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function serializeSteamVideoProductionPlanCsv(
  plan: SteamVideoProductionPlan,
): string {
  const columns = [
    "taskId",
    "projectRef",
    "storyId",
    "nodeId",
    "sceneId",
    "episodeId",
    "sourceContentHash",
    "priority",
    "batch",
    "stage",
    "artifactType",
    "outputRef",
    "dependencies",
    "optionalDependencies",
    "optional",
    "requiredCapabilities",
    "status",
    "blockerCodes",
  ] as const;
  const rows = plan.tasks.map((task) =>
    [
      task.taskId,
      task.projectRef,
      task.storyId,
      task.nodeId,
      task.sceneId,
      task.episodeId,
      task.sourceContentHash,
      task.priority,
      task.batch,
      task.stage,
      task.artifactType,
      task.outputRef,
      task.dependencies.join("|"),
      task.optionalDependencies.join("|"),
      task.optional,
      task.requiredCapabilities.join("|"),
      task.status,
      task.blockerCodes.join("|"),
    ].map(escapeSteamVideoProductionPlanCsvCell).join(","),
  );
  return `${columns.map(escapeSteamVideoProductionPlanCsvCell).join(",")}\r\n${rows.join("\r\n")}\r\n`;
}
