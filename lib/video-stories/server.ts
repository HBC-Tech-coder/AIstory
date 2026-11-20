import "server-only";

import { createHash, randomUUID } from "node:crypto";

import type { AdminActor } from "@/lib/admin/types";
import {
  getLocalVideoAssetRepository,
  type LocalVideoAssetRepository,
  type StoredVideoAsset,
} from "@/lib/video-assets/repository";
import {
  compileVideoStoryRelease,
  stableVideoStoryJson,
  validateVideoStoryDraft,
  type CompiledVideoStoryRelease,
} from "./compiler";
import {
  getLocalVideoStoryRepository,
  type LocalVideoStoryRepository,
  type StoredVideoStoryRelease,
  type VideoStoryAudit,
} from "./repository";
import {
  VIDEO_STORY_SCHEMA_VERSION,
  type VideoStoryAssetProjection,
  type VideoStoryDraft,
  type VideoStoryNodeDraft,
  type VideoStoryPublicReleaseSummary,
  type VideoStoryValidationResult,
  type VideoStoryVariableDefinition,
} from "./types";
import { VIDEO_STORY_MAX_DURATION_MS } from "./editor";

type ServiceOptions = {
  repository?: LocalVideoStoryRepository;
  assetRepository?: LocalVideoAssetRepository;
  now?: () => Date;
  randomId?: () => string;
  allowTestAdapter?: boolean;
};

export type VideoStoryCapabilityStatus = {
  adapter: "local_development" | "production_repository";
  available: boolean;
  reason?: string;
};

export type VideoStoryCreateInput = {
  id?: string;
  projectId: unknown;
  storyId: unknown;
  title: unknown;
  summary?: unknown;
  version?: unknown;
  orientation?: unknown;
  reason: unknown;
  idempotencyKey: string;
  requestId: string;
};

export type VideoStorySaveInput = {
  title: unknown;
  summary?: unknown;
  version: unknown;
  orientation: unknown;
  startNodeId: unknown;
  variables: unknown;
  nodes: unknown;
  reason: unknown;
  idempotencyKey: string;
  requestId: string;
};

export type VideoStoryActionInput = {
  action:
    | "submit_review"
    | "publish"
    | "offline";
  reason: unknown;
  idempotencyKey: string;
  requestId: string;
};

function assertLocalAdapter(
  actor: AdminActor,
  options: ServiceOptions,
): LocalVideoStoryRepository {
  if (actor.mode !== "local") {
    throw new Error("生产视频剧情仓储尚未配置。");
  }
  if (
    !options.allowTestAdapter &&
    process.env.AISTORY_VIDEO_STORY_ADAPTER !== "local_development"
  ) {
    throw new Error("本地视频剧情仓储未启用。");
  }
  return options.repository ?? getLocalVideoStoryRepository();
}

export function videoStoryCapabilityStatus(
  actor: AdminActor,
): VideoStoryCapabilityStatus {
  if (actor.mode === "production") {
    return {
      adapter: "production_repository",
      available: false,
      reason: "生产视频剧情仓储与对象存储尚未配置。",
    };
  }
  const available =
    process.env.AISTORY_VIDEO_STORY_ADAPTER === "local_development";
  return {
    adapter: "local_development",
    available,
    ...(!available ? { reason: "本地视频剧情仓储未启用。" } : {}),
  };
}

function cleanId(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(value.trim())
  ) {
    throw new Error(`${label}不合法。`);
  }
  return value.trim();
}

function cleanText(
  value: unknown,
  label: string,
  max: number,
  required = true,
): string {
  if (value === undefined || value === null || value === "") {
    if (!required) return "";
    throw new Error(`${label}不能为空。`);
  }
  if (typeof value !== "string") throw new Error(`${label}格式不合法。`);
  const text = value.trim();
  if (
    (!text && required) ||
    text.length > max ||
    /[\u0000-\u001f<>\\]/.test(text)
  ) {
    throw new Error(`${label}包含不安全内容。`);
  }
  return text;
}

function cleanSubtitleText(
  value: unknown,
  label: string,
  max: number,
): string {
  const text = cleanText(value, label, max);
  if (
    /(?:https?:\/\/|www\.|file:|data:|blob:|[A-Za-z]:[\\/]|(?:^|\s)\\\\|\/(?:api|home|users|var|etc|tmp)\b)/i.test(
      text,
    )
  ) {
    throw new Error(`${label}不得包含 URL 或本地路径。`);
  }
  return text;
}

function cleanReason(value: unknown): string {
  const reason = cleanText(value, "操作原因", 500);
  if (reason.length < 3) throw new Error("操作原因至少 3 个字符。");
  return reason;
}

function cleanProjectId(value: unknown): number {
  const projectId = Number(value);
  if (!Number.isSafeInteger(projectId) || projectId <= 0) {
    throw new Error("项目 ID 不合法。");
  }
  return projectId;
}

function cleanIdempotencyKey(value: string): string {
  const key = value.trim();
  if (
    key.length < 16 ||
    key.length > 160 ||
    !/^[A-Za-z0-9:._-]+$/.test(key)
  ) {
    throw new Error("幂等键不合法。");
  }
  return key;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableVideoStoryJson(value)).digest("hex");
}

function audit(
  actor: AdminActor,
  action: string,
  storyId: string,
  reason: string,
  requestId: string,
  now: Date,
): VideoStoryAudit {
  return {
    id: randomUUID(),
    actorId: actor.userId,
    action,
    storyId,
    reason,
    requestId: requestId.slice(0, 160),
    createdAt: now.toISOString(),
  };
}

function assetProjection(asset: StoredVideoAsset): VideoStoryAssetProjection {
  return {
    id: asset.id,
    ...(asset.projectId ? { projectId: asset.projectId } : {}),
    ...(asset.storyId ? { storyId: asset.storyId } : {}),
    status: asset.status,
    releasePolicy: asset.releasePolicy,
    ...(asset.status === "publishable" && asset.releasePolicy === "public"
      ? {
          publicUrl: `/api/video-assets/${encodeURIComponent(asset.id)}/content`,
        }
      : {}),
    durationMs: asset.durationMs,
    hasAudio: asset.hasAudio,
    subtitles: structuredClone(asset.subtitles),
  };
}

async function availableAssets(
  options: ServiceOptions,
): Promise<VideoStoryAssetProjection[]> {
  const repository =
    options.assetRepository ?? getLocalVideoAssetRepository();
  return (await repository.list()).map(assetProjection);
}

function sanitizeVariables(value: unknown): VideoStoryVariableDefinition[] {
  if (!Array.isArray(value)) throw new Error("变量列表格式不合法。");
  return value.map((item) => {
    if (!item || typeof item !== "object") {
      throw new Error("变量定义格式不合法。");
    }
    const record = item as Record<string, unknown>;
    return {
      id: cleanId(record.id, "变量 ID"),
      label: cleanText(record.label, "变量名称", 80),
      initialValue: Number(record.initialValue),
      min: Number(record.min),
      max: Number(record.max),
    };
  });
}

function sanitizeNodes(value: unknown): VideoStoryNodeDraft[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 200) {
    throw new Error("节点列表必须包含 1 到 200 个节点。");
  }
  return value.map((item) => {
    if (!item || typeof item !== "object") {
      throw new Error("节点格式不合法。");
    }
    const record = item as Record<string, unknown>;
    const choices = Array.isArray(record.choices)
      ? record.choices.map((choice) => {
          if (!choice || typeof choice !== "object") {
            throw new Error("选项格式不合法。");
          }
          const candidate = choice as Record<string, unknown>;
          const conditions = Array.isArray(candidate.conditions)
            ? candidate.conditions.map((condition) => {
                if (!condition || typeof condition !== "object") {
                  throw new Error("选项条件格式不合法。");
                }
                const raw = condition as Record<string, unknown>;
                return {
                  variableId: cleanId(raw.variableId, "条件变量 ID"),
                  operator: String(raw.operator) as
                    | "eq"
                    | "neq"
                    | "gte"
                    | "lte"
                    | "gt"
                    | "lt",
                  value: Number(raw.value),
                };
              })
            : undefined;
          const rawDelta =
            candidate.variableDelta &&
            typeof candidate.variableDelta === "object" &&
            !Array.isArray(candidate.variableDelta)
              ? Object.fromEntries(
                  Object.entries(
                    candidate.variableDelta as Record<string, unknown>,
                  ).map(([key, amount]) => [cleanId(key, "变量 ID"), Number(amount)]),
                )
              : undefined;
          return {
            id: cleanId(candidate.id, "选项 ID"),
            label: cleanText(candidate.label, "选项文案", 160),
            targetNodeId: cleanId(candidate.targetNodeId, "选项目标"),
            ...(conditions?.length ? { conditions } : {}),
            ...(rawDelta ? { variableDelta: rawDelta } : {}),
          };
        })
      : [];
    const rawEndedDelta =
      record.endedVariableDelta &&
      typeof record.endedVariableDelta === "object" &&
      !Array.isArray(record.endedVariableDelta)
        ? Object.fromEntries(
            Object.entries(
              record.endedVariableDelta as Record<string, unknown>,
            ).map(([key, amount]) => [cleanId(key, "变量 ID"), Number(amount)]),
          )
        : undefined;
    const subtitles = Array.isArray(record.subtitles)
      ? record.subtitles.map((cue) => {
          if (!cue || typeof cue !== "object") {
            throw new Error("字幕格式不合法。");
          }
          const raw = cue as Record<string, unknown>;
          const startMs = Number(raw.startMs);
          const endMs = Number(raw.endMs);
          if (
            !Number.isSafeInteger(startMs) ||
            !Number.isSafeInteger(endMs) ||
            startMs < 0 ||
            endMs <= startMs ||
            endMs > VIDEO_STORY_MAX_DURATION_MS
          ) {
            throw new Error("字幕时间不合法或超过安全上限。");
          }
          return {
            id: cleanId(raw.id, "字幕 ID"),
            startMs,
            endMs,
            text: cleanSubtitleText(raw.text, "字幕内容", 500),
            ...(raw.speaker
              ? { speaker: cleanSubtitleText(raw.speaker, "说话人", 80) }
              : {}),
          };
        })
      : undefined;
    const endedBehavior = String(record.endedBehavior || "choices") as
      | "choices"
      | "advance"
      | "hold";
    if (!["choices", "advance", "hold"].includes(endedBehavior)) {
      throw new Error("结束行为不合法。");
    }
    return {
      nodeId: cleanId(record.nodeId, "节点 ID"),
      title: cleanText(record.title, "节点标题", 160),
      assetId: cleanId(record.assetId, "视频资产 ID"),
      ...(record.posterUrl
        ? { posterUrl: cleanText(record.posterUrl, "海报 URL", 500) }
        : {}),
      ...(subtitles?.length ? { subtitles } : {}),
      ...(record.vttUrl
        ? { vttUrl: cleanText(record.vttUrl, "字幕 URL", 500) }
        : {}),
      allowSkip: record.allowSkip !== false,
      endedBehavior,
      ...(record.endedTargetNodeId
        ? {
            endedTargetNodeId: cleanId(
              record.endedTargetNodeId,
              "自动推进目标",
            ),
          }
        : {}),
      ...(rawEndedDelta
        ? { endedVariableDelta: rawEndedDelta }
        : {}),
      terminal: record.terminal === true,
      choices,
      releasePolicy: "public" as const,
    };
  });
}

export async function listVideoStoryDrafts(
  actor: AdminActor,
  options: ServiceOptions = {},
): Promise<{
  drafts: VideoStoryDraft[];
  assets: VideoStoryAssetProjection[];
  capability: VideoStoryCapabilityStatus;
}> {
  const repository = assertLocalAdapter(actor, options);
  return {
    drafts: await repository.listDrafts(),
    assets: await availableAssets(options),
    capability: { adapter: "local_development", available: true },
  };
}

export async function createVideoStoryDraft(
  actor: AdminActor,
  input: VideoStoryCreateInput,
  options: ServiceOptions = {},
): Promise<{ draft: VideoStoryDraft; created: boolean }> {
  const repository = assertLocalAdapter(actor, options);
  const now = options.now?.() ?? new Date();
  const idempotencyKey = cleanIdempotencyKey(input.idempotencyKey);
  const projectId = cleanProjectId(input.projectId);
  const storyId = cleanId(input.storyId, "作品 ID");
  const title = cleanText(input.title, "标题", 160);
  const reason = cleanReason(input.reason);
  const id = input.id
    ? cleanId(input.id, "草稿 ID")
    : `video-story-${options.randomId?.() ?? randomUUID()}`;
  const draft: VideoStoryDraft = {
    schemaVersion: VIDEO_STORY_SCHEMA_VERSION,
    id,
    projectId,
    storyId,
    title,
    summary: cleanText(input.summary, "简介", 500, false),
    version: cleanText(input.version ?? "v1", "版本", 80),
    revision: 1,
    orientation: input.orientation === "portrait" ? "portrait" : "landscape",
    startNodeId: "start",
    releasePolicy: "public",
    status: "draft",
    variables: [],
    nodes: [],
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  const semantic = {
    action: "create",
    projectId,
    storyId,
    title,
    summary: draft.summary,
    version: draft.version,
    orientation: draft.orientation,
    reason,
  };
  return repository.createDraft(
    draft,
    {
      key: idempotencyKey,
      fingerprint: fingerprint(semantic),
      draftId: id,
      createdAt: now.toISOString(),
    },
    audit(actor, "video_story.create", storyId, reason, input.requestId, now),
  );
}

export async function copyVideoStoryDraft(
  actor: AdminActor,
  sourceId: string,
  input: VideoStoryCreateInput,
  options: ServiceOptions = {},
): Promise<{ draft: VideoStoryDraft; created: boolean }> {
  const repository = assertLocalAdapter(actor, options);
  const source = await repository.getDraft(cleanId(sourceId, "源草稿 ID"));
  if (!source) throw new Error("源视频剧情不存在。");
  const result = await createVideoStoryDraft(actor, input, options);
  if (!result.created) return result;
  const now = options.now?.() ?? new Date();
  const reason = cleanReason(input.reason);
  const saved = await repository.mutateDraft(
    result.draft.id,
    {
      key: `${cleanIdempotencyKey(input.idempotencyKey)}:copy-body`,
      fingerprint: fingerprint({
        sourceId: source.id,
        sourceRevision: source.revision,
        targetId: result.draft.id,
      }),
      draftId: result.draft.id,
      createdAt: now.toISOString(),
    },
    audit(
      actor,
      "video_story.copy",
      result.draft.storyId,
      reason,
      input.requestId,
      now,
    ),
    (draft) => {
      draft.startNodeId = source.startNodeId;
      draft.variables = structuredClone(source.variables);
      draft.nodes = structuredClone(source.nodes);
      draft.updatedAt = now.toISOString();
    },
  );
  return { draft: saved.draft, created: true };
}

export async function saveVideoStoryDraft(
  actor: AdminActor,
  draftId: string,
  input: VideoStorySaveInput,
  options: ServiceOptions = {},
): Promise<{ draft: VideoStoryDraft; changed: boolean }> {
  const repository = assertLocalAdapter(actor, options);
  const current = await repository.getDraft(cleanId(draftId, "草稿 ID"));
  if (!current) throw new Error("视频剧情不存在。");
  if (current.status !== "draft") {
    throw new Error("只有草稿状态可以编辑；请复制为新草稿。");
  }
  const now = options.now?.() ?? new Date();
  const reason = cleanReason(input.reason);
  const next = {
    title: cleanText(input.title, "标题", 160),
    summary: cleanText(input.summary, "简介", 500, false),
    version: cleanText(input.version, "版本", 80),
    orientation: input.orientation === "portrait" ? "portrait" as const : "landscape" as const,
    startNodeId: cleanId(input.startNodeId, "起点节点"),
    variables: sanitizeVariables(input.variables),
    nodes: sanitizeNodes(input.nodes),
  };
  const semantic = { action: "save", draftId, revision: current.revision, next, reason };
  const result = await repository.mutateDraft(
    current.id,
    {
      key: cleanIdempotencyKey(input.idempotencyKey),
      fingerprint: fingerprint(semantic),
      draftId: current.id,
      createdAt: now.toISOString(),
    },
    audit(actor, "video_story.save", current.storyId, reason, input.requestId, now),
    (draft) => {
      Object.assign(draft, structuredClone(next));
      draft.revision += 1;
      draft.updatedAt = now.toISOString();
    },
  );
  return { draft: result.draft, changed: result.changed };
}

export async function validateStoredVideoStoryDraft(
  actor: AdminActor,
  draftId: string,
  options: ServiceOptions = {},
): Promise<VideoStoryValidationResult> {
  const repository = assertLocalAdapter(actor, options);
  const draft = await repository.getDraft(cleanId(draftId, "草稿 ID"));
  if (!draft) throw new Error("视频剧情不存在。");
  return validateVideoStoryDraft(draft, await availableAssets(options));
}

export async function transitionVideoStoryDraft(
  actor: AdminActor,
  draftId: string,
  input: VideoStoryActionInput,
  options: ServiceOptions = {},
): Promise<{
  draft: VideoStoryDraft;
  release?: VideoStoryPublicReleaseSummary;
  changed: boolean;
}> {
  const repository = assertLocalAdapter(actor, options);
  const current = await repository.getDraft(cleanId(draftId, "草稿 ID"));
  if (!current) throw new Error("视频剧情不存在。");
  const reason = cleanReason(input.reason);
  const now = options.now?.() ?? new Date();
  const assets = await availableAssets(options);
  let compiled:
    | { artifact: CompiledVideoStoryRelease; bytes: string; artifactFile: string }
    | undefined;

  if (input.action === "submit_review" || input.action === "publish") {
    const validation = validateVideoStoryDraft(current, assets, {
      blockUnreachable: input.action === "publish",
    });
    if (!validation.ok) {
      throw new Error(
        validation.errors.map((item) => item.message).join("；") ||
          "视频剧情校验失败。",
      );
    }
  }
  if (input.action === "publish") {
    const result = compileVideoStoryRelease(current, assets);
    const artifactFile = await repository.writeReleaseArtifact(
      result.artifact.contentHash,
      result.bytes,
    );
    compiled = { ...result, artifactFile };
  }

  const semantic = {
    action: input.action,
    draftId: current.id,
    revision: current.revision,
    reason,
    contentHash: compiled?.artifact.contentHash,
  };
  const result = await repository.mutateDraft(
    current.id,
    {
      key: cleanIdempotencyKey(input.idempotencyKey),
      fingerprint: fingerprint(semantic),
      draftId: current.id,
      createdAt: now.toISOString(),
    },
    audit(
      actor,
      `video_story.${input.action}`,
      current.storyId,
      reason,
      input.requestId,
      now,
    ),
    (draft, store) => {
      if (input.action === "submit_review") {
        if (draft.status !== "draft") {
          throw new Error("只有草稿可以提交审核。");
        }
        draft.status = "review_pending";
        draft.submittedAt = now.toISOString();
      } else if (input.action === "publish" && compiled) {
        if (draft.status !== "review_pending") {
          throw new Error("只有待审核草稿可以发布。");
        }
        for (const release of store.releases) {
          if (release.storyId === draft.storyId && release.status === "published") {
            release.status = "offline";
          }
        }
        const release: StoredVideoStoryRelease = {
          releaseId: `release-${compiled.artifact.contentHash.slice(0, 24)}`,
          storyId: draft.storyId,
          version: compiled.artifact.version,
          contentHash: compiled.artifact.contentHash,
          publishedAt: now.toISOString(),
          status: "published",
          artifactFile: compiled.artifactFile,
          draftId: draft.id,
        };
        store.releases.push(release);
        draft.status = "published";
        draft.publishedReleaseId = release.releaseId;
        draft.updatedAt = now.toISOString();
        return { release };
      } else if (input.action === "offline") {
        if (draft.status !== "published") {
          throw new Error("只有已发布版本可以下线。");
        }
        for (const release of store.releases) {
          if (release.releaseId === draft.publishedReleaseId) {
            release.status = "offline";
          }
        }
        draft.status = "offline";
      }
      draft.updatedAt = now.toISOString();
    },
  );
  return {
    draft: result.draft,
    ...(result.release ? { release: result.release } : {}),
    changed: result.changed,
  };
}

export async function readPublishedVideoStory(
  storyId: string,
  options: Pick<ServiceOptions, "repository" | "allowTestAdapter"> = {},
): Promise<CompiledVideoStoryRelease | null> {
  if (
    !options.allowTestAdapter &&
    process.env.AISTORY_VIDEO_STORY_ADAPTER !== "local_development"
  ) {
    return null;
  }
  const repository = options.repository ?? getLocalVideoStoryRepository();
  const release = await repository.getPublishedRelease(cleanId(storyId, "作品 ID"));
  if (!release) return null;
  const raw = await repository.readReleaseArtifact(release);
  const parsed = JSON.parse(raw) as CompiledVideoStoryRelease;
  if (
    parsed.kind !== "aistory-video-story-release" ||
    parsed.storyId !== storyId ||
    parsed.contentHash !== release.contentHash
  ) {
    throw new Error("视频剧情发布物校验失败。");
  }
  const recalculated = createHash("sha256")
    .update(
      stableVideoStoryJson({
        schemaVersion: parsed.schemaVersion,
        kind: parsed.kind,
        storyId: parsed.storyId,
        version: parsed.version,
        bundle: parsed.bundle,
      }),
    )
    .digest("hex");
  if (recalculated !== parsed.contentHash) {
    throw new Error("视频剧情发布物内容哈希不匹配。");
  }
  return parsed;
}
