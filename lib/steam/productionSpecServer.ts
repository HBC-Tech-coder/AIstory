import "server-only";

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  getComfyUIWorkflowTemplateVersion,
  listComfyUIWorkflowTemplates,
} from "@/lib/providers/comfyui/registry";
import type { SteamVideoProductionPlan } from "@/lib/steam/productionPlan";
import { readSteamVideoProductionPlan } from "@/lib/steam/productionPlanServer";
import {
  deriveSteamVideoGenerationPreflight,
  STEAM_RELEASE_TARGET_POLICY,
  STEAM_VIDEO_GENERATION_PREFLIGHT_NODE_IDS,
  type SteamVideoGenerationAuthoritativeInput,
  type SteamVideoGenerationPreflightPackage,
  type SteamVideoGenerationPreflightNodeId,
  type SteamVideoGenerationReferenceRole,
  type SteamVideoGenerationWorkflowCandidate,
} from "@/lib/steam/productionSpec";
import {
  STEAM_LAUNCH_CASE_ID,
  STEAM_LAUNCH_PROJECT_REF,
  STEAM_LAUNCH_STORY_ID,
  STEAM_LAUNCH_STORY_VERSION,
} from "@/lib/steam/releaseContent";

const AUTHOR_ROOT = path.join(
  /* turbopackIgnore: true */ process.cwd(),
  "content",
  "case-studies",
  STEAM_LAUNCH_CASE_ID,
  "author-locked-v1.1",
);
const SHOT_CATALOG_FILE = path.join(AUTHOR_ROOT, "video-prompts.v1.1.json");
const ASSET_MANIFEST_FILE = path.join(AUTHOR_ROOT, "asset-manifest.v1.1.json");
const PUBLIC_STORY_FILE = path.join(
  /* turbopackIgnore: true */ process.cwd(),
  "public",
  "case-studies",
  STEAM_LAUNCH_CASE_ID,
  "story.json",
);

type JsonRecord = Record<string, unknown>;
type WorkflowSummary = Awaited<
  ReturnType<typeof listComfyUIWorkflowTemplates>
>[number];
type ProductionSpecReaders = {
  readPlan: () => Promise<SteamVideoProductionPlan>;
  readShotCatalog: () => Promise<unknown>;
  readAssetManifest: () => Promise<unknown>;
  readPublicStory: () => Promise<unknown>;
  listWorkflowCandidates: () => Promise<SteamVideoGenerationWorkflowCandidate[]>;
  now: () => string;
};

const REFERENCE_ROLES: Record<string, SteamVideoGenerationReferenceRole> = {
  R1_FACE: "identity_face",
  R2_HOME_OUTFIT: "home_outfit",
  R4_EXPRESSIONS: "expressions",
};

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function safeId(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)
    ? value
    : null;
}

function safeHash(value: unknown): string | null {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
    ? value
    : null;
}

function safeBasename(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 1 || value.length > 160) {
    return null;
  }
  const basename = path.posix.basename(value.replaceAll("\\", "/"));
  return basename === value.replaceAll("\\", "/").split("/").at(-1) &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(basename)
    ? basename
    : null;
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8")) as unknown;
}

function activeCandidate(
  summary: WorkflowSummary,
  exactVersionResolved: boolean,
): SteamVideoGenerationWorkflowCandidate {
  return {
    source: "comfyui_registry",
    templateId: summary.id,
    modality: summary.modality,
    enabled: summary.enabled,
    activeVersion: summary.activeVersion,
    activeFingerprint: summary.fingerprint,
    selectedVersion: summary.activeVersion,
    selectedFingerprint: summary.fingerprint,
    exactVersionResolved,
    // Registry schema v1 does not carry a reviewed release classification,
    // purpose or reference-role capability map. Never infer those from names,
    // ids, checkpoints, nodes or workflow JSON.
    releaseClassification: "unclassified",
    capabilities: [],
    compatibility: { discriminator: "UNCLASSIFIED" },
  };
}

async function defaultWorkflowCandidates(): Promise<
  SteamVideoGenerationWorkflowCandidate[]
> {
  const summaries = await listComfyUIWorkflowTemplates();
  return Promise.all(
    summaries.map(async (summary) => {
      const exact = await getComfyUIWorkflowTemplateVersion(
        {
          id: summary.id,
          version: summary.activeVersion,
          fingerprint: summary.fingerprint,
        },
        { includeDisabled: true },
      );
      return activeCandidate(
        summary,
        Boolean(
          exact &&
            exact.template.activeVersion === summary.activeVersion &&
            exact.version.version === summary.activeVersion &&
            exact.version.fingerprint === summary.fingerprint,
        ),
      );
    }),
  );
}

const defaultReaders: ProductionSpecReaders = {
  readPlan: readSteamVideoProductionPlan,
  readShotCatalog: () => readJson(SHOT_CATALOG_FILE),
  readAssetManifest: () => readJson(ASSET_MANIFEST_FILE),
  readPublicStory: () => readJson(PUBLIC_STORY_FILE),
  listWorkflowCandidates: defaultWorkflowCandidates,
  now: () => new Date().toISOString(),
};

type SafeAsset = {
  assetId: string;
  kind: string;
  releasePolicy: "public";
  sha256: string;
};

function projectAssets(raw: unknown): Map<string, SafeAsset> {
  const root = record(raw);
  if (
    root?.schemaVersion !== 1 ||
    root?.caseStudyId !== STEAM_LAUNCH_CASE_ID ||
    root?.releaseVersion !== "v1.1" ||
    !Array.isArray(root.assets)
  ) {
    throw new Error("authoritative_spec_invalid");
  }
  const result = new Map<string, SafeAsset>();
  for (const value of root.assets) {
    const asset = record(value);
    const assetId = safeId(asset?.assetId);
    const sha256 = safeHash(asset?.sha256);
    const kind = safeId(asset?.kind);
    if (
      !assetId ||
      !sha256 ||
      !kind ||
      asset?.status !== "generated" ||
      asset?.releasePolicy !== "public" ||
      result.has(assetId)
    ) {
      continue;
    }
    result.set(assetId, {
      assetId,
      kind,
      releasePolicy: "public",
      sha256,
    });
  }
  return result;
}

function publicNodes(raw: unknown): Map<
  SteamVideoGenerationPreflightNodeId,
  {
    sourceSceneId: string;
    episodeId: string;
    orientation: "landscape" | "portrait";
    imageBasename: string;
  }
> {
  const root = record(raw);
  const session = record(root?.session);
  const identity = record(session?.cacheIdentity);
  const authored = record(session?.authoredStory);
  if (
    identity?.visibility !== "public" ||
    identity?.storyId !== STEAM_LAUNCH_STORY_ID ||
    identity?.version !== STEAM_LAUNCH_STORY_VERSION ||
    authored?.caseStudyId !== STEAM_LAUNCH_CASE_ID ||
    authored?.version !== STEAM_LAUNCH_STORY_VERSION ||
    authored?.authorLocked !== true ||
    typeof session?.styleGuide !== "string" ||
    !/(?:^|\D)16:9(?:\D|$)/.test(session.styleGuide) ||
    !Array.isArray(authored.nodes)
  ) {
    throw new Error("authoritative_spec_invalid");
  }
  const targets = new Set<string>(STEAM_VIDEO_GENERATION_PREFLIGHT_NODE_IDS);
  const result = new Map<
    SteamVideoGenerationPreflightNodeId,
    {
      sourceSceneId: string;
      episodeId: string;
      orientation: "landscape" | "portrait";
      imageBasename: string;
    }
  >();
  for (const value of authored.nodes) {
    const node = record(value);
    const nodeId = safeId(node?.nodeId);
    if (!nodeId || !targets.has(nodeId)) continue;
    const scene = record(node?.scene);
    const sourceSceneId = safeId(node?.sourceSceneId);
    const episodeId = safeId(node?.episodeId);
    const imageBasename = safeBasename(scene?.imageUrl);
    const orientation = scene?.orientation;
    if (
      !sourceSceneId ||
      !episodeId ||
      !imageBasename ||
      (orientation !== "landscape" && orientation !== "portrait") ||
      node?.releasePolicy !== "public" ||
      result.has(nodeId as SteamVideoGenerationPreflightNodeId)
    ) {
      throw new Error("authoritative_spec_invalid");
    }
    result.set(nodeId as SteamVideoGenerationPreflightNodeId, {
      sourceSceneId,
      episodeId,
      orientation,
      imageBasename,
    });
  }
  if (result.size !== STEAM_VIDEO_GENERATION_PREFLIGHT_NODE_IDS.length) {
    throw new Error("authoritative_spec_invalid");
  }
  return result;
}

function optionalAspectRatio(value: unknown): "16:9" | "9:16" | null {
  if (value === undefined || value === null) return null;
  if (value === "16:9" || value === "9:16") return value;
  throw new Error("authoritative_spec_invalid");
}

function optionalInteger(value: unknown, min: number, max: number): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) {
    throw new Error("authoritative_spec_invalid");
  }
  return Number(value);
}

function optionalAudioIntent(
  value: unknown,
): "preserve" | "attach" | "silent" | null {
  if (value === undefined || value === null) return null;
  if (value === "preserve" || value === "attach" || value === "silent") {
    return value;
  }
  throw new Error("authoritative_spec_invalid");
}

function optionalSubtitleIntent(
  value: unknown,
): "attach_webvtt" | "none" | null {
  if (value === undefined || value === null) return null;
  if (value === "attach_webvtt" || value === "none") return value;
  throw new Error("authoritative_spec_invalid");
}

function planTasksForNode(
  plan: SteamVideoProductionPlan,
  nodeId: SteamVideoGenerationPreflightNodeId,
): {
  original: SteamVideoGenerationAuthoritativeInput["originalPlanTask"];
  upscale: SteamVideoGenerationAuthoritativeInput["upscalePlanTask"];
} {
  const originals = plan.tasks.filter(
    (task) => task.nodeId === nodeId && task.stage === "original_video",
  );
  const upscales = plan.tasks.filter(
    (task) => task.nodeId === nodeId && task.stage === "upscale",
  );
  if (originals.length !== 1 || upscales.length !== 1) {
    throw new Error("authoritative_spec_invalid");
  }
  const original = originals[0]!;
  const upscale = upscales[0]!;
  return {
    original: {
      taskId: original.taskId,
      outputRef: original.outputRef,
      status: original.status,
      blockerCodes: [...original.blockerCodes],
    },
    upscale: { taskId: upscale.taskId, outputRef: upscale.outputRef },
  };
}

function referenceLibrary(raw: unknown): Map<string, string> {
  const root = record(raw);
  if (
    root?.schemaVersion !== 1 ||
    root?.caseStudyId !== STEAM_LAUNCH_CASE_ID ||
    root?.releaseVersion !== "v1.1" ||
    !Array.isArray(root.referenceLibrary)
  ) {
    throw new Error("authoritative_spec_invalid");
  }
  const result = new Map<string, string>();
  for (const value of root.referenceLibrary) {
    const item = record(value);
    const id = safeId(item?.id);
    const file = safeBasename(item?.file);
    if (id && file && !result.has(id)) result.set(id, file);
  }
  return result;
}

function assetForFile(
  assets: Map<string, SafeAsset>,
  file: string,
  expectedKinds: string[],
): SafeAsset {
  const assetId = file.replace(/\.[^.]+$/, "");
  const asset = assets.get(assetId);
  if (!asset || !expectedKinds.includes(asset.kind)) {
    throw new Error("authoritative_spec_invalid");
  }
  return asset;
}

function projectShots(input: {
  rawCatalog: unknown;
  plan: SteamVideoProductionPlan;
  publicNodeMap: ReturnType<typeof publicNodes>;
  assets: Map<string, SafeAsset>;
  workflows: SteamVideoGenerationWorkflowCandidate[];
}): SteamVideoGenerationAuthoritativeInput[] {
  const root = record(input.rawCatalog);
  if (!root || !Array.isArray(root.shots)) {
    throw new Error("authoritative_spec_invalid");
  }
  const library = referenceLibrary(input.rawCatalog);
  const wanted = new Set<string>(STEAM_VIDEO_GENERATION_PREFLIGHT_NODE_IDS);
  const shots = root.shots.filter((value) => {
    const nodeId = record(value)?.nodeId;
    return typeof nodeId === "string" && wanted.has(nodeId);
  });
  if (shots.length !== STEAM_VIDEO_GENERATION_PREFLIGHT_NODE_IDS.length) {
    throw new Error("authoritative_spec_invalid");
  }
  return STEAM_VIDEO_GENERATION_PREFLIGHT_NODE_IDS.map((nodeId) => {
    const shot = record(
      shots.find((value) => record(value)?.nodeId === nodeId),
    );
    const publicNode = input.publicNodeMap.get(nodeId);
    const shotId = safeId(shot?.shotId);
    const sceneId = safeId(shot?.sceneId);
    const episodeId = safeId(shot?.episodeId);
    const firstFrame = safeBasename(shot?.firstFrameAsset);
    const prompt = typeof shot?.prompt === "string" ? shot.prompt : "";
    const negativePrompt =
      typeof shot?.negativePrompt === "string" ? shot.negativePrompt : undefined;
    const referenceIds = Array.isArray(shot?.referenceIds)
      ? shot.referenceIds.filter((value): value is string => typeof value === "string")
      : [];
    if (
      !publicNode ||
      !shotId ||
      !sceneId ||
      !episodeId ||
      !firstFrame ||
      !prompt.trim() ||
      shot?.releasePolicy !== "public" ||
      sceneId !== publicNode.sourceSceneId ||
      episodeId !== publicNode.episodeId ||
      firstFrame !== publicNode.imageBasename ||
      !Number.isSafeInteger(shot?.durationSeconds) ||
      Number(shot?.durationSeconds) < 1 ||
      Number(shot?.durationSeconds) > 600 ||
      referenceIds.length !== Object.keys(REFERENCE_ROLES).length ||
      Object.keys(REFERENCE_ROLES).some((id) => !referenceIds.includes(id))
    ) {
      throw new Error("authoritative_spec_invalid");
    }
    const frameAsset = assetForFile(input.assets, firstFrame, ["keyframe"]);
    const references: SteamVideoGenerationAuthoritativeInput["references"] = [
      {
        role: "source_frame",
        assetId: frameAsset.assetId,
        sha256: frameAsset.sha256,
      },
    ];
    for (const referenceId of referenceIds.sort()) {
      const role = REFERENCE_ROLES[referenceId];
      const file = library.get(referenceId);
      if (!role || !file) throw new Error("authoritative_spec_invalid");
      const asset = assetForFile(input.assets, file, [
        "character_base",
        "outfit_sheet",
        "expression_sheet",
      ]);
      references.push({ role, assetId: asset.assetId, sha256: asset.sha256 });
    }
    const tasks = planTasksForNode(input.plan, nodeId);
    const catalogAspectRatio = optionalAspectRatio(shot.aspectRatio);
    const catalogWidth = optionalInteger(shot.width, 256, 8192);
    const catalogHeight = optionalInteger(shot.height, 256, 8192);
    const catalogFps = optionalInteger(shot.fps, 1, 120);
    const catalogAudioIntent = optionalAudioIntent(shot.audioIntent);
    const catalogSubtitleIntent = optionalSubtitleIntent(shot.subtitleIntent);
    if (
      publicNode.orientation !== STEAM_RELEASE_TARGET_POLICY.orientation ||
      Number(shot.durationSeconds) !==
        STEAM_RELEASE_TARGET_POLICY.durationSeconds ||
      (catalogAspectRatio !== null &&
        catalogAspectRatio !== STEAM_RELEASE_TARGET_POLICY.aspectRatio) ||
      (catalogWidth !== null && catalogWidth !== STEAM_RELEASE_TARGET_POLICY.width) ||
      (catalogHeight !== null &&
        catalogHeight !== STEAM_RELEASE_TARGET_POLICY.height) ||
      (catalogFps !== null && catalogFps !== STEAM_RELEASE_TARGET_POLICY.fps) ||
      (catalogAudioIntent !== null &&
        catalogAudioIntent !== STEAM_RELEASE_TARGET_POLICY.audioIntent) ||
      (catalogSubtitleIntent !== null &&
        catalogSubtitleIntent !== STEAM_RELEASE_TARGET_POLICY.subtitleIntent)
    ) {
      throw new Error("authoritative_spec_invalid");
    }
    return {
      projectRef: STEAM_LAUNCH_PROJECT_REF,
      caseId: STEAM_LAUNCH_CASE_ID,
      storyId: STEAM_LAUNCH_STORY_ID,
      storyVersion: STEAM_LAUNCH_STORY_VERSION,
      nodeId,
      sceneId,
      episodeId,
      shotId,
      sourceContentHash: tasks.original
        ? input.plan.tasks.find(
            (task) => task.taskId === tasks.original.taskId,
          )!.sourceContentHash
        : "",
      privatePrompt: prompt,
      ...(negativePrompt ? { privateNegativePrompt: negativePrompt } : {}),
      videoPolicy: {
        orientation: STEAM_RELEASE_TARGET_POLICY.orientation,
        durationSeconds: STEAM_RELEASE_TARGET_POLICY.durationSeconds,
        aspectRatio: STEAM_RELEASE_TARGET_POLICY.aspectRatio,
        width: STEAM_RELEASE_TARGET_POLICY.width,
        height: STEAM_RELEASE_TARGET_POLICY.height,
        fps: STEAM_RELEASE_TARGET_POLICY.fps,
      },
      audioIntent: STEAM_RELEASE_TARGET_POLICY.audioIntent,
      subtitleIntent: STEAM_RELEASE_TARGET_POLICY.subtitleIntent,
      references,
      originalPlanTask: tasks.original,
      upscalePlanTask: tasks.upscale,
      workflowCandidates: input.workflows.map((workflow) => ({ ...workflow })),
    };
  });
}

export async function readSteamVideoGenerationPreflight(
  overrides: Partial<ProductionSpecReaders> = {},
): Promise<SteamVideoGenerationPreflightPackage> {
  const readers = { ...defaultReaders, ...overrides };
  const [plan, rawCatalog, rawAssets, rawPublicStory, workflows] =
    await Promise.all([
      readers.readPlan(),
      readers.readShotCatalog(),
      readers.readAssetManifest(),
      readers.readPublicStory(),
      readers.listWorkflowCandidates(),
    ]);
  if (
    plan.designation.status !== "designated" ||
    plan.designation.caseId !== STEAM_LAUNCH_CASE_ID ||
    plan.designation.storyId !== STEAM_LAUNCH_STORY_ID ||
    plan.designation.version !== STEAM_LAUNCH_STORY_VERSION ||
    plan.designation.projectRef !== STEAM_LAUNCH_PROJECT_REF
  ) {
    throw new Error("authoritative_spec_invalid");
  }
  const result = deriveSteamVideoGenerationPreflight({
    observedAt: readers.now(),
    authority: {
      caseId: STEAM_LAUNCH_CASE_ID,
      storyId: STEAM_LAUNCH_STORY_ID,
      storyVersion: STEAM_LAUNCH_STORY_VERSION,
      projectRef: STEAM_LAUNCH_PROJECT_REF,
    },
    shots: projectShots({
      rawCatalog,
      plan,
      publicNodeMap: publicNodes(rawPublicStory),
      assets: projectAssets(rawAssets),
      workflows,
    }),
    sha256: (value) => createHash("sha256").update(value).digest("hex"),
  });
  return result.publicPackage;
}
