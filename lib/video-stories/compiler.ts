import { createHash } from "node:crypto";

import type {
  AuthoredStoryNode,
  AuthoredStoryRuntime,
  Beat,
  BeatChoice,
  Scene,
  Session,
  StoryState,
} from "@infiplot/types";
import type { CaseStudyPublishedBundle } from "@/lib/case-studies/schema";
import {
  isControlledSceneMediaUrl,
} from "@/lib/sceneMedia";
import { VIDEO_STORY_MAX_DURATION_MS } from "./editor";
import type {
  VideoStoryAssetProjection,
  VideoStoryChoiceDraft,
  VideoStoryDraft,
  VideoStoryNodeDraft,
  VideoStoryValidationIssue,
  VideoStoryValidationResult,
} from "./types";

type AssetMap = ReadonlyMap<string, VideoStoryAssetProjection>;

export type CompiledVideoStoryRelease = {
  schemaVersion: 1;
  kind: "aistory-video-story-release";
  storyId: string;
  version: string;
  contentHash: string;
  bundle: CaseStudyPublishedBundle;
};

function issue(
  code: string,
  message: string,
  nodeId?: string,
): VideoStoryValidationIssue {
  return { code, message, ...(nodeId ? { nodeId } : {}) };
}

function stableId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(value);
}

function safeText(value: string, maxLength: number): boolean {
  const text = value.trim();
  return (
    text.length > 0 &&
    text.length <= maxLength &&
    !/[\u0000-\u001f<>\\]/.test(text)
  );
}

function safeSubtitleText(value: string, maxLength: number): boolean {
  return (
    safeText(value, maxLength) &&
    !/(?:https?:\/\/|www\.|file:|data:|blob:|[A-Za-z]:[\\/]|(?:^|\s)\\\\|\/(?:api|home|users|var|etc|tmp)\b)/i.test(
      value,
    )
  );
}

function isPublicVideoStoryMediaUrl(value: string): boolean {
  if (!isControlledSceneMediaUrl(value)) return false;
  return (
    value.startsWith("/api/video-assets/") ||
    value.startsWith("/case-studies/")
  );
}

function validateVariableDelta(
  delta: Record<string, number> | undefined,
  variableIds: ReadonlySet<string>,
  label: string,
  errors: VideoStoryValidationIssue[],
  nodeId: string,
): void {
  if (!delta) return;
  for (const [key, value] of Object.entries(delta)) {
    if (!variableIds.has(key) || !Number.isFinite(value)) {
      errors.push(
        issue(
          "invalid_variable_update",
          `${label}包含未声明变量或非有限数值。`,
          nodeId,
        ),
      );
      return;
    }
  }
}

function validateChoice(
  choice: VideoStoryChoiceDraft,
  node: VideoStoryNodeDraft,
  nodeIds: ReadonlySet<string>,
  variableIds: ReadonlySet<string>,
  errors: VideoStoryValidationIssue[],
): void {
  if (!stableId(choice.id)) {
    errors.push(issue("invalid_choice_id", "选项 ID 不稳定或不合法。", node.nodeId));
  }
  if (!safeText(choice.label, 160)) {
    errors.push(issue("invalid_choice_label", "选项文案不能为空或包含不安全内容。", node.nodeId));
  }
  if (!nodeIds.has(choice.targetNodeId)) {
    errors.push(
      issue(
        "missing_choice_target",
        `选项目标节点不存在：${choice.targetNodeId}`,
        node.nodeId,
      ),
    );
  }
  for (const condition of choice.conditions ?? []) {
    if (
      !variableIds.has(condition.variableId) ||
      !["eq", "neq", "gte", "lte", "gt", "lt"].includes(condition.operator) ||
      !Number.isFinite(condition.value)
    ) {
      errors.push(
        issue(
          "invalid_choice_condition",
          `选项“${choice.label}”包含不合法的变量条件。`,
          node.nodeId,
        ),
      );
      break;
    }
  }
  validateVariableDelta(
    choice.variableDelta,
    variableIds,
    `选项“${choice.label}”`,
    errors,
    node.nodeId,
  );
}

export function validateVideoStoryDraft(
  draft: VideoStoryDraft,
  assets: readonly VideoStoryAssetProjection[],
  options: { blockUnreachable?: boolean } = {},
): VideoStoryValidationResult {
  const errors: VideoStoryValidationIssue[] = [];
  const warnings: VideoStoryValidationIssue[] = [];
  const assetMap = new Map(assets.map((asset) => [asset.id, asset]));
  const nodeIds = new Set(draft.nodes.map((node) => node.nodeId));
  const variableIds = new Set(draft.variables.map((variable) => variable.id));

  if (draft.schemaVersion !== 1) {
    errors.push(issue("unsupported_schema", "视频剧情草稿版本不受支持。"));
  }
  if (
    !stableId(draft.id) ||
    !stableId(draft.storyId) ||
    !safeText(draft.title, 160) ||
    !safeText(draft.version, 80) ||
    !Number.isSafeInteger(draft.projectId) ||
    draft.projectId <= 0
  ) {
    errors.push(issue("invalid_story_metadata", "故事 ID、项目、标题或版本不合法。"));
  }
  if (draft.releasePolicy !== "public") {
    errors.push(issue("non_public_story", "公开编译只接受 public 发布策略。"));
  }
  if (!nodeIds.has(draft.startNodeId)) {
    errors.push(issue("missing_start", "起点节点不存在。"));
  }
  if (nodeIds.size !== draft.nodes.length) {
    const seen = new Set<string>();
    for (const node of draft.nodes) {
      if (seen.has(node.nodeId)) {
        errors.push(
          issue("duplicate_node_id", "节点 ID 不得重复。", node.nodeId),
        );
      }
      seen.add(node.nodeId);
    }
  }
  if (variableIds.size !== draft.variables.length) {
    errors.push(issue("duplicate_variable_id", "变量 ID 不得重复。"));
  }
  for (const variable of draft.variables) {
    if (
      !stableId(variable.id) ||
      !safeText(variable.label, 80) ||
      !Number.isFinite(variable.initialValue) ||
      !Number.isFinite(variable.min) ||
      !Number.isFinite(variable.max) ||
      variable.min > variable.max ||
      variable.initialValue < variable.min ||
      variable.initialValue > variable.max
    ) {
      errors.push(issue("invalid_variable", `变量定义不合法：${variable.id}`));
    }
  }

  for (const node of draft.nodes) {
    if (!stableId(node.nodeId) || !safeText(node.title, 160)) {
      errors.push(issue("invalid_node", "节点 ID 或标题不合法。", node.nodeId));
    }
    if (node.releasePolicy !== "public") {
      errors.push(issue("restricted_node", "受限节点不得进入公开编译。", node.nodeId));
    }
    const asset = assetMap.get(node.assetId);
    if (!asset) {
      errors.push(issue("missing_asset", "节点未绑定可用视频资产。", node.nodeId));
    } else {
      if (
        asset.status !== "publishable" ||
        asset.releasePolicy !== "public" ||
        !asset.publicUrl ||
        !isPublicVideoStoryMediaUrl(asset.publicUrl)
      ) {
        errors.push(
          issue(
            "asset_not_publishable",
            "视频资产尚未审核为公开可发布状态。",
            node.nodeId,
          ),
        );
      }
      if (asset.projectId !== draft.projectId || asset.storyId !== draft.storyId) {
        errors.push(
          issue(
            "asset_scope_mismatch",
            "视频资产必须绑定同一项目和故事。",
            node.nodeId,
          ),
        );
      }
      if (
        !Number.isSafeInteger(asset.durationMs) ||
        asset.durationMs <= 0 ||
        asset.durationMs > VIDEO_STORY_MAX_DURATION_MS
      ) {
        errors.push(
          issue(
            "invalid_asset_duration",
            "视频时长不合法或超过编排安全上限。",
            node.nodeId,
          ),
        );
      }
      let previousEnd = -1;
      for (const cue of node.subtitles ?? asset.subtitles) {
        if (
          !stableId(cue.id) ||
          !safeSubtitleText(cue.text, 500) ||
          (cue.speaker !== undefined &&
            !safeSubtitleText(cue.speaker, 80))
        ) {
          errors.push(
            issue(
              "unsafe_subtitle_content",
              "字幕不得包含危险标记、URL 或本地路径。",
              node.nodeId,
            ),
          );
          break;
        }
        if (
          !Number.isSafeInteger(cue.startMs) ||
          !Number.isSafeInteger(cue.endMs) ||
          cue.startMs < previousEnd ||
          cue.endMs <= cue.startMs ||
          cue.endMs > asset.durationMs
        ) {
          errors.push(
            issue(
              "invalid_subtitle_timing",
              "字幕必须按时间单调排列，且不得超出视频时长。",
              node.nodeId,
            ),
          );
          break;
        }
        previousEnd = cue.endMs;
      }
    }
    if (
      node.posterUrl !== undefined &&
      !isPublicVideoStoryMediaUrl(node.posterUrl)
    ) {
      errors.push(issue("invalid_poster", "海报必须使用受控 AIstory URL。", node.nodeId));
    }
    if (
      node.vttUrl !== undefined &&
      !isPublicVideoStoryMediaUrl(node.vttUrl)
    ) {
      errors.push(issue("invalid_vtt", "VTT 必须使用受控 AIstory URL。", node.nodeId));
    }

    const normalizedLabels = node.choices.map((choice) =>
      choice.label.trim().toLocaleLowerCase(),
    );
    if (new Set(normalizedLabels).size !== normalizedLabels.length) {
      errors.push(issue("duplicate_choice_label", "同一节点的选项文案不得重复。", node.nodeId));
    }
    if (new Set(node.choices.map((choice) => choice.id)).size !== node.choices.length) {
      errors.push(issue("duplicate_choice_id", "同一节点的选项 ID 不得重复。", node.nodeId));
    }
    for (const choice of node.choices) {
      validateChoice(choice, node, nodeIds, variableIds, errors);
    }

    if (node.terminal) {
      if (
        node.endedBehavior !== "hold" ||
        node.choices.length > 0 ||
        node.endedTargetNodeId
      ) {
        errors.push(
          issue(
            "invalid_terminal",
            "终局节点必须 hold，且不能再声明选项或自动跳转。",
            node.nodeId,
          ),
        );
      }
    } else if (node.endedBehavior === "choices") {
      if (node.choices.length === 0) {
        errors.push(issue("dead_end", "非终局选择节点不得成为死路。", node.nodeId));
      }
    } else if (node.endedBehavior === "advance") {
      if (!node.endedTargetNodeId || !nodeIds.has(node.endedTargetNodeId)) {
        errors.push(issue("missing_advance_target", "自动推进目标节点不存在。", node.nodeId));
      }
      validateVariableDelta(
        node.endedVariableDelta,
        variableIds,
        "自动推进",
        errors,
        node.nodeId,
      );
    } else {
      errors.push(issue("dead_end", "非终局节点不得使用 hold。", node.nodeId));
    }
  }

  const reachable = new Set<string>();
  const visit = (nodeId: string) => {
    if (reachable.has(nodeId)) return;
    const node = draft.nodes.find((candidate) => candidate.nodeId === nodeId);
    if (!node) return;
    reachable.add(nodeId);
    for (const choice of node.choices) visit(choice.targetNodeId);
    if (node.endedTargetNodeId) visit(node.endedTargetNodeId);
  };
  if (nodeIds.has(draft.startNodeId)) visit(draft.startNodeId);
  const unreachable = draft.nodes.filter((node) => !reachable.has(node.nodeId));
  for (const node of unreachable) {
    const unreachableIssue = issue(
      "unreachable_node",
      "节点无法从起点到达。",
      node.nodeId,
    );
    if (options.blockUnreachable) errors.push(unreachableIssue);
    else warnings.push(unreachableIssue);
  }

  const reverseEdges = new Map<string, Set<string>>();
  for (const node of draft.nodes) {
    const targets = [
      ...node.choices.map((choice) => choice.targetNodeId),
      ...(node.endedTargetNodeId ? [node.endedTargetNodeId] : []),
    ];
    for (const target of targets) {
      if (!nodeIds.has(target)) continue;
      const previous = reverseEdges.get(target) ?? new Set<string>();
      previous.add(node.nodeId);
      reverseEdges.set(target, previous);
    }
  }
  const canReachTerminal = new Set<string>();
  const visitReverse = (nodeId: string) => {
    if (canReachTerminal.has(nodeId)) return;
    canReachTerminal.add(nodeId);
    for (const previous of reverseEdges.get(nodeId) ?? []) {
      visitReverse(previous);
    }
  };
  for (const node of draft.nodes) {
    if (node.terminal && node.endedBehavior === "hold") {
      visitReverse(node.nodeId);
    }
  }
  for (const node of draft.nodes) {
    if (reachable.has(node.nodeId) && !canReachTerminal.has(node.nodeId)) {
      errors.push(
        issue(
          "non_terminating_cycle",
          "节点位于无法抵达终局的循环或路径中。",
          node.nodeId,
        ),
      );
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    reachableNodeIds: [...reachable].sort(),
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

export function stableVideoStoryJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function compiledChoices(node: VideoStoryNodeDraft): BeatChoice[] {
  return node.choices.map((choice) => ({
    id: choice.id,
    label: choice.label.trim(),
    ...(choice.conditions?.length
      ? { conditions: structuredClone(choice.conditions) }
      : {}),
    effect: {
      kind: "change-scene" as const,
      nextSceneSeed: `video-story:${node.nodeId}:${choice.id}`,
      authoredTargetNodeId: choice.targetNodeId,
      ...(choice.variableDelta
        ? { variableDelta: structuredClone(choice.variableDelta) }
        : {}),
    },
  }));
}

function compileNode(
  draft: VideoStoryDraft,
  node: VideoStoryNodeDraft,
  asset: VideoStoryAssetProjection,
): AuthoredStoryNode {
  const beatId = `${node.nodeId}_beat_1`;
  const beat: Beat = {
    id: beatId,
    narration: node.title,
    next: {
      type: "choice",
      choices: node.endedBehavior === "choices" ? compiledChoices(node) : [],
    },
  };
  const scene: Scene = {
    id: `video_story_scene_${node.nodeId}`,
    scenePrompt: node.title,
    beats: [beat],
    entryBeatId: beatId,
    sceneKey: `video-story-${draft.storyId}-${node.nodeId}`,
    imageUrl: node.posterUrl,
    orientation: draft.orientation,
    media: {
      kind: "video",
      url: asset.publicUrl!,
      assetId: asset.id,
      ...(node.posterUrl ? { posterUrl: node.posterUrl } : {}),
      durationMs: asset.durationMs,
      hasAudio: asset.hasAudio,
      subtitles: structuredClone(node.subtitles?.length ? node.subtitles : asset.subtitles),
      ...(node.vttUrl ? { vttUrl: node.vttUrl } : {}),
      allowSkip: node.allowSkip,
      endBehavior:
        node.endedBehavior === "advance"
          ? "advance-beat"
          : node.endedBehavior === "hold"
            ? "hold"
            : "unlock-interaction",
      ...(node.endedTargetNodeId
        ? { authoredTargetNodeId: node.endedTargetNodeId }
        : {}),
      ...(node.endedVariableDelta
        ? { authoredVariableDelta: structuredClone(node.endedVariableDelta) }
        : {}),
      hotspotsEnabled: false,
    },
  };
  return {
    nodeId: node.nodeId,
    sourceSceneId: scene.id,
    title: node.title,
    kind: node.terminal ? "ending" : "video",
    releasePolicy: "public",
    scene,
  };
}

function storyState(draft: VideoStoryDraft): StoryState {
  return {
    logline: draft.summary || draft.title,
    genreTags: "互动视频",
    protagonist: "你是当前互动视频故事的玩家。",
    synopsis: draft.summary || draft.title,
    openThreads: [],
    relationships: [],
  };
}

export function compileVideoStoryRelease(
  draft: VideoStoryDraft,
  assets: readonly VideoStoryAssetProjection[],
): { artifact: CompiledVideoStoryRelease; bytes: string } {
  const validation = validateVideoStoryDraft(draft, assets, {
    blockUnreachable: true,
  });
  if (!validation.ok) {
    throw new Error(
      validation.errors.map((item) => item.message).join("；") ||
        "视频剧情编译校验失败。",
    );
  }
  const assetMap: AssetMap = new Map(assets.map((asset) => [asset.id, asset]));
  const nodes = draft.nodes.map((node) =>
    compileNode(draft, node, assetMap.get(node.assetId)!),
  );
  const first = nodes.find((node) => node.nodeId === draft.startNodeId)!;
  const state = storyState(draft);
  const runtime: AuthoredStoryRuntime = {
    caseStudyId: draft.storyId,
    version: `video-story:${draft.version}:r${draft.revision}`,
    authorLocked: true,
    releasePolicy: { defaultAccess: "public", restrictedNodeIds: [] },
    currentNodeId: first.nodeId,
    currentBeatId: first.scene.entryBeatId,
    visitedNodeIds: [first.nodeId],
    variables: Object.fromEntries(
      draft.variables.map((variable) => [variable.id, variable.initialValue]),
    ),
    variableDefinitions: draft.variables.map((variable) => ({
      id: variable.id,
      label: variable.label,
      value: variable.initialValue,
      min: variable.min,
      max: variable.max,
    })),
    nodes,
  };
  const session: Session = {
    id: `video-story:${draft.storyId}`,
    createdAt: 0,
    worldSetting: draft.summary || draft.title,
    styleGuide: "已审核互动视频资产",
    history: [
      {
        scene: first.scene,
        visitedBeatIds: [first.scene.entryBeatId],
        storyStateAfter: state,
      },
    ],
    characters: [],
    storyState: state,
    orientation: draft.orientation,
    language: "zh-CN",
    cacheIdentity: {
      visibility: "public",
      storyId: `video-story:${draft.storyId}`,
      templateId: draft.storyId,
      version: runtime.version,
    },
    authoredStory: runtime,
  };
  const bundle: CaseStudyPublishedBundle = {
    schemaVersion: 1,
    kind: "aistory-authored-case",
    card: {
      id: draft.storyId,
      gender: "男性向",
      index: 0,
      title: draft.title,
      outline: draft.summary,
      style: "互动视频",
      tags: ["互动视频"],
      coverPath: first.scene.media?.kind === "video"
        ? first.scene.media.posterUrl || ""
        : "",
      playPath: `/play?videoStory=${encodeURIComponent(draft.storyId)}`,
      assetStatus: "ready",
      active: true,
    },
    session,
    assetSummary: {
      generated: nodes.length,
      pending: 0,
      failed: 0,
    },
  };
  const payload = {
    schemaVersion: 1 as const,
    kind: "aistory-video-story-release" as const,
    storyId: draft.storyId,
    version: runtime.version,
    bundle,
  };
  const contentHash = createHash("sha256")
    .update(stableVideoStoryJson(payload))
    .digest("hex");
  const artifact: CompiledVideoStoryRelease = {
    ...payload,
    contentHash,
  };
  return { artifact, bytes: stableVideoStoryJson(artifact) };
}
