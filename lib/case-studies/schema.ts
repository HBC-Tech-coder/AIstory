import type {
  AuthoredAiContinuationBoundary,
  AuthoredReleasePolicy,
  AuthoredReleaseScope,
  AuthoredStoryNode,
  AuthoredStoryRuntime,
  Beat,
  BeatChoice,
  Character,
  Orientation,
  Scene,
  SceneExit,
  Session,
  StoryState,
} from "@infiplot/types";

export const CASE_STUDY_SCHEMA_VERSION = 1;

export type CaseStudySourceBeat = { speaker: string | null; text: string };

export type CaseStudySourceChoice = {
  choiceId: string;
  label: string;
  targetNodeId: string;
  mergeNodeId?: string;
  variableDelta?: Record<string, number>;
  reason?: string;
};

export type CaseStudySourceNode = {
  nodeId: string;
  sceneId: string;
  title: string;
  kind: string;
  episodeId?: string;
  sourceParagraphIds?: string[];
  restricted?: boolean;
  releasePolicy?: AuthoredReleaseScope;
  estimatedSeconds?: number;
  location: string;
  summary: string;
  characterState?: Record<string, string>;
  visualState?: string | Record<string, string>;
  /** Content-pipeline alias for a single-character visual state. */
  formState?: string;
  characterVisualStates?: Record<string, string>;
  roleState?: Record<string, string>;
  beats: CaseStudySourceBeat[];
  choices?: CaseStudySourceChoice[];
  next?: { type: "continue"; nextNodeId: string };
};

export type CaseStudySource = {
  schemaVersion: typeof CASE_STUDY_SCHEMA_VERSION;
  caseStudyId: string;
  workingTitle: string;
  recommendedTitle: string;
  authorLocked?: boolean;
  releaseVersion?: string;
  releasePolicy?: AuthoredReleasePolicy;
  aiContinuationBoundary?: AuthoredAiContinuationBoundary;
  storyMeta: { genre: string[]; audience: string; recommendedTitle: string; tagline: string };
  variables: Array<{ id: string; label: string; default: number; range: [number, number]; meaning: string }>;
  characters: Array<{
    id: string;
    name: string;
    age: number | null;
    role: string;
    goal: string;
    visualAnchor: string;
    visualStates?: Array<{
      id: string;
      label: string;
      description: string;
      assetId?: string;
    }>;
    /** Compact content-pipeline form: state id -> public visual description. */
    visualForms?: Record<string, string>;
  }>;
  interactiveGraph: {
    startNodeId: string;
    mergeNodes: string[];
    defaultVariables: Record<string, number>;
    nodes: CaseStudySourceNode[];
  };
  firstActCompat: {
    sessionId: string;
    scene: Scene;
    imageUrl: string;
    characters: Character[];
    storyState: StoryState;
    cardName: string;
    cardTitle: string;
    cardGender: "男性向" | "女性向";
    worldSetting: string;
    styleGuide: string;
  };
};

export type CaseStudySourceAsset = {
  assetId: string;
  title: string;
  kind: string;
  status: "generated" | "pending_generation" | "failed" | "restricted";
  releasePolicy?: AuthoredReleaseScope;
  localPath: string | null;
  sceneId: string | null;
  shotId: string | null;
  characterId?: string;
  visualState?: string;
  /** Content-pipeline alias used by the asset manifest. */
  formState?: string;
  prompt?: string;
  safeZoneNotes?: string;
};

export type CaseStudyAssetManifest = {
  schemaVersion: typeof CASE_STUDY_SCHEMA_VERSION;
  caseStudyId: string;
  releaseVersion?: string;
  statusLegend: string[];
  assets: CaseStudySourceAsset[];
};

export type CaseStudyPublishedCard = {
  id: string;
  gender: "男性向" | "女性向";
  index: number;
  title: string;
  outline: string;
  style: string;
  tags: string[];
  coverPath: string;
  playPath: string;
  assetStatus: "ready" | "pending";
  active: true;
};

export type CaseStudyPublishedBundle = {
  schemaVersion: 1;
  kind: "aistory-authored-case";
  card: CaseStudyPublishedCard;
  session: Session;
  assetSummary: {
    generated: number;
    pending: number;
    failed: number;
    restricted?: number;
  };
};

export type CaseStudyValidationResult<T> =
  | { ok: true; value: T; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

const AUTHORED_RELEASE_SCOPES = new Set<AuthoredReleaseScope>([
  "public",
  "restricted",
  "internal",
  "enterprise",
]);

export function authoredContinuationBoundaryNodeId(
  boundary: AuthoredAiContinuationBoundary | undefined,
): string | null {
  if (typeof boundary === "string") return boundary.trim() || null;
  return boundary?.afterNodeId?.trim() || null;
}

export function isAuthoredNodePubliclyAccessible(
  runtime: AuthoredStoryRuntime,
  nodeId: string,
): boolean {
  const node = runtime.nodes.find((candidate) => candidate.nodeId === nodeId);
  if (!node) return false;
  if (node.restricted || (node.releasePolicy && node.releasePolicy !== "public")) {
    return false;
  }
  if (runtime.releasePolicy?.restrictedNodeIds.includes(nodeId)) return false;
  if (node.releasePolicy === "public") return true;
  return runtime.releasePolicy?.defaultAccess !== "restricted";
}

export function isAuthoredAiContinuationAllowed(
  runtime: AuthoredStoryRuntime,
): boolean {
  if (!runtime.authorLocked) return true;
  const boundaryNodeId = authoredContinuationBoundaryNodeId(
    runtime.aiContinuationBoundary,
  );
  if (!boundaryNodeId) return false;
  return runtime.visitedNodeIds.includes(boundaryNodeId);
}

function validateScene(value: unknown, path: string, errors: string[]): value is Scene {
  if (!isRecord(value)) { errors.push(`${path} 必须是对象`); return false; }
  if (!nonEmpty(value.id)) errors.push(`${path}.id 必须是非空字符串`);
  if (!nonEmpty(value.scenePrompt)) errors.push(`${path}.scenePrompt 必须是非空字符串`);
  if (!nonEmpty(value.entryBeatId)) errors.push(`${path}.entryBeatId 必须是非空字符串`);
  if (!Array.isArray(value.beats) || value.beats.length === 0) errors.push(`${path}.beats 必须是非空数组`);
  return errors.length === 0;
}

export function validateCaseStudySource(value: unknown, expectedCaseStudyId?: string): CaseStudyValidationResult<CaseStudySource> {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ["故事 JSON 必须是对象"], warnings };
  if (value.schemaVersion !== CASE_STUDY_SCHEMA_VERSION) errors.push(`schemaVersion 必须为 ${CASE_STUDY_SCHEMA_VERSION}`);
  if (!nonEmpty(value.caseStudyId)) errors.push("caseStudyId 必须是非空字符串");
  if (expectedCaseStudyId && value.caseStudyId !== expectedCaseStudyId) errors.push(`caseStudyId 必须为 ${expectedCaseStudyId}`);
  for (const key of ["workingTitle", "recommendedTitle"]) if (!nonEmpty(value[key])) errors.push(`${key} 必须是非空字符串`);

  if (value.authorLocked !== undefined && typeof value.authorLocked !== "boolean") {
    errors.push("authorLocked 必须是布尔值");
  }
  const authorLocked = value.authorLocked === true;
  const policyRestrictedNodeIds = new Set<string>();
  if (authorLocked) {
    if (!nonEmpty(value.releaseVersion)) {
      errors.push("authorLocked 内容必须声明 releaseVersion");
    }
    if (!isRecord(value.releasePolicy)) {
      errors.push("authorLocked 内容必须声明 releasePolicy");
    } else {
      if (
        value.releasePolicy.defaultAccess !== "public" &&
        value.releasePolicy.defaultAccess !== "restricted"
      ) {
        errors.push("releasePolicy.defaultAccess 必须为 public 或 restricted");
      }
      if (!Array.isArray(value.releasePolicy.restrictedNodeIds)) {
        errors.push("releasePolicy.restrictedNodeIds 必须是数组");
      } else {
        value.releasePolicy.restrictedNodeIds.forEach((nodeId, index) => {
          if (!nonEmpty(nodeId)) {
            errors.push(`releasePolicy.restrictedNodeIds[${index}] 必须是非空字符串`);
          } else {
            policyRestrictedNodeIds.add(nodeId);
          }
        });
      }
    }
    if (!authoredContinuationBoundaryNodeId(
      value.aiContinuationBoundary as AuthoredAiContinuationBoundary | undefined,
    )) {
      errors.push("authorLocked 内容必须声明 aiContinuationBoundary");
    }
  }

  if (!Array.isArray(value.variables) || value.variables.length === 0) {
    errors.push("variables 必须是非空数组");
  } else {
    const variableIds = new Set<string>();
    for (const [index, variable] of value.variables.entries()) {
      if (!isRecord(variable) || !nonEmpty(variable.id)) { errors.push(`variables[${index}].id 必须是非空字符串`); continue; }
      variableIds.add(variable.id);
      if (typeof variable.default !== "number" || !Number.isFinite(variable.default) || !Array.isArray(variable.range) || variable.range.length !== 2 || !variable.range.every((item) => typeof item === "number" && Number.isFinite(item))) {
        errors.push(`variables[${index}] 默认值或范围不合法`);
      }
    }
    for (const required of ["intimacy", "trust", "autonomy"]) if (!variableIds.has(required)) errors.push(`variables 必须声明 ${required}`);
  }

  const declaredVisualStates = new Map<string, Set<string>>();
  if (!Array.isArray(value.characters) || value.characters.length === 0) {
    errors.push("characters 必须是非空数组");
  } else {
    for (const [index, character] of value.characters.entries()) {
      if (!isRecord(character) || !nonEmpty(character.id) || !nonEmpty(character.name)) {
        errors.push(`characters[${index}] 必须包含 id 和 name`);
        continue;
      }
      const ids = new Set<string>();
      if (character.visualStates !== undefined) {
        if (!Array.isArray(character.visualStates)) {
          errors.push(`characters[${index}].visualStates 必须是数组`);
        } else {
          character.visualStates.forEach((state, stateIndex) => {
            if (!isRecord(state) || !nonEmpty(state.id) || !nonEmpty(state.label) || !nonEmpty(state.description)) errors.push(`characters[${index}].visualStates[${stateIndex}] 字段不完整`);
            else ids.add(state.id);
          });
        }
      }
      if (character.visualForms !== undefined) {
        if (!isRecord(character.visualForms)) {
          errors.push(`characters[${index}].visualForms 必须是对象`);
        } else {
          for (const [stateId, description] of Object.entries(character.visualForms)) {
            if (!nonEmpty(stateId) || !nonEmpty(description)) errors.push(`characters[${index}].visualForms 字段不完整`);
            else ids.add(stateId);
          }
        }
      }
      declaredVisualStates.set(character.id, ids);
    }
    const lanjianStates = declaredVisualStates.get("lanjian");
    if (!lanjianStates?.has("humanized_homewear") || !lanjianStates.has("native_android_chassis")) {
      warnings.push("岚见双形态尚未在 source characters.visualStates 完整声明");
    }
  }

  if (!isRecord(value.interactiveGraph)) {
    errors.push("interactiveGraph 必须是对象");
  } else {
    const graph = value.interactiveGraph;
    if (!nonEmpty(graph.startNodeId)) errors.push("interactiveGraph.startNodeId 必须是非空字符串");
    if (!isRecord(graph.defaultVariables)) errors.push("interactiveGraph.defaultVariables 必须是对象");
    if (!Array.isArray(graph.nodes) || graph.nodes.length === 0) {
      errors.push("interactiveGraph.nodes 必须是非空数组");
    } else {
      const ids = new Set<string>();
      for (const [index, node] of graph.nodes.entries()) {
        if (!isRecord(node) || !nonEmpty(node.nodeId)) { errors.push(`interactiveGraph.nodes[${index}].nodeId 必须是非空字符串`); continue; }
        if (ids.has(node.nodeId)) errors.push(`节点 id 重复：${node.nodeId}`);
        ids.add(node.nodeId);
      }
      if (nonEmpty(graph.startNodeId) && !ids.has(graph.startNodeId)) errors.push("interactiveGraph.startNodeId 未指向有效节点");
      if (authorLocked) {
        const boundaryNodeId = authoredContinuationBoundaryNodeId(
          value.aiContinuationBoundary as AuthoredAiContinuationBoundary | undefined,
        );
        if (boundaryNodeId && !ids.has(boundaryNodeId)) {
          errors.push("aiContinuationBoundary 未指向有效节点");
        }
        for (const restrictedNodeId of policyRestrictedNodeIds) {
          if (!ids.has(restrictedNodeId)) {
            errors.push(`releasePolicy 指向不存在的 restricted 节点：${restrictedNodeId}`);
          }
        }
      }
      for (const [index, node] of graph.nodes.entries()) {
        if (!isRecord(node)) continue;
        const path = `interactiveGraph.nodes[${index}]`;
        for (const key of ["nodeId", "sceneId", "title", "kind", "location", "summary"]) if (!nonEmpty(node[key])) errors.push(`${path}.${key} 必须是非空字符串`);
        if (authorLocked) {
          if (!nonEmpty(node.episodeId)) errors.push(`${path}.episodeId 必须是非空字符串`);
          if (
            !Array.isArray(node.sourceParagraphIds) ||
            node.sourceParagraphIds.length === 0 ||
            !node.sourceParagraphIds.every(nonEmpty)
          ) {
            errors.push(`${path}.sourceParagraphIds 必须是非空字符串数组`);
          }
          if (node.restricted !== undefined && typeof node.restricted !== "boolean") {
            errors.push(`${path}.restricted 必须是布尔值`);
          }
          if (
            node.releasePolicy !== undefined &&
            (!nonEmpty(node.releasePolicy) ||
              !AUTHORED_RELEASE_SCOPES.has(node.releasePolicy as AuthoredReleaseScope))
          ) {
            errors.push(`${path}.releasePolicy 不受支持`);
          }
          if (
            node.restricted === true &&
            nonEmpty(node.nodeId) &&
            !policyRestrictedNodeIds.has(node.nodeId)
          ) {
            errors.push(`${path} 标记 restricted 但未列入根 releasePolicy`);
          }
        }
        if (!Array.isArray(node.beats) || node.beats.length === 0) errors.push(`${path}.beats 必须是非空数组`);
        else node.beats.forEach((beat, beatIndex) => { if (!isRecord(beat) || !nonEmpty(beat.text)) errors.push(`${path}.beats[${beatIndex}].text 必须是非空字符串`); });
        if (node.next !== undefined && (!isRecord(node.next) || node.next.type !== "continue" || !nonEmpty(node.next.nextNodeId) || !ids.has(node.next.nextNodeId))) errors.push(`${path}.next 必须指向有效节点`);
        if (node.choices !== undefined) {
          if (!Array.isArray(node.choices)) errors.push(`${path}.choices 必须是数组`);
          else node.choices.forEach((choice, choiceIndex) => {
            const choicePath = `${path}.choices[${choiceIndex}]`;
            if (!isRecord(choice) || !nonEmpty(choice.choiceId) || !nonEmpty(choice.label) || !nonEmpty(choice.targetNodeId) || !ids.has(choice.targetNodeId)) errors.push(`${choicePath} 必须包含有效 id、label 和 targetNodeId`);
            if (
              authorLocked &&
              isRecord(choice) &&
              nonEmpty(choice.label) &&
              !/^【选项】\S/.test(choice.label)
            ) {
              errors.push(`${choicePath}.label 必须保留完整【选项】原文标记`);
            }
            if (isRecord(choice) && choice.variableDelta !== undefined && (!isRecord(choice.variableDelta) || !Object.values(choice.variableDelta).every((item) => typeof item === "number" && Number.isFinite(item)))) errors.push(`${choicePath}.variableDelta 必须是有限数字对象`);
          });
        }
        const visualState = node.characterVisualStates ?? node.visualState ?? node.formState;
        if (visualState !== undefined && typeof visualState !== "string" && !isRecord(visualState)) errors.push(`${path}.visualState 必须是字符串或角色映射`);
      }
    }
  }

  if (!isRecord(value.firstActCompat)) {
    errors.push("firstActCompat 必须是对象");
  } else {
    const sceneErrors: string[] = [];
    validateScene(value.firstActCompat.scene, "firstActCompat.scene", sceneErrors);
    errors.push(...sceneErrors);
    if (!nonEmpty(value.firstActCompat.cardTitle)) errors.push("firstActCompat.cardTitle 必须是非空字符串");
    if (value.firstActCompat.cardGender !== "男性向" && value.firstActCompat.cardGender !== "女性向") errors.push("firstActCompat.cardGender 不合法");
  }
  return errors.length > 0 ? { ok: false, errors, warnings } : { ok: true, value: value as unknown as CaseStudySource, warnings };
}

export function validateCaseStudyAssetManifest(value: unknown, expectedCaseStudyId?: string): CaseStudyValidationResult<CaseStudyAssetManifest> {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ["资产 manifest 必须是对象"], warnings };
  if (value.schemaVersion !== CASE_STUDY_SCHEMA_VERSION) errors.push(`asset manifest schemaVersion 必须为 ${CASE_STUDY_SCHEMA_VERSION}`);
  if (!nonEmpty(value.caseStudyId)) errors.push("asset manifest caseStudyId 必须是非空字符串");
  if (expectedCaseStudyId && value.caseStudyId !== expectedCaseStudyId) errors.push(`asset manifest caseStudyId 必须为 ${expectedCaseStudyId}`);
  if (!Array.isArray(value.assets)) {
    errors.push("asset manifest assets 必须是数组");
  } else {
    const ids = new Set<string>();
    for (const [index, asset] of value.assets.entries()) {
      const path = `assets[${index}]`;
      if (!isRecord(asset) || !nonEmpty(asset.assetId)) { errors.push(`${path}.assetId 必须是非空字符串`); continue; }
      if (ids.has(asset.assetId)) errors.push(`${path}.assetId 重复：${asset.assetId}`);
      ids.add(asset.assetId);
      if (!["generated", "pending_generation", "failed", "restricted"].includes(String(asset.status))) errors.push(`${path}.status 不受支持`);
      if (
        asset.releasePolicy !== undefined &&
        (!nonEmpty(asset.releasePolicy) ||
          !AUTHORED_RELEASE_SCOPES.has(asset.releasePolicy as AuthoredReleaseScope))
      ) {
        errors.push(`${path}.releasePolicy 不受支持`);
      }
      if (asset.status === "generated" && !nonEmpty(asset.localPath)) errors.push(`${path} 已标 generated 但缺少 localPath`);
      if (asset.status !== "generated" && asset.localPath !== null) warnings.push(`${path} 未标 generated，导入器会忽略 localPath`);
    }
  }
  return errors.length > 0 ? { ok: false, errors, warnings } : { ok: true, value: value as unknown as CaseStudyAssetManifest, warnings };
}

function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)); }

export function applyAuthoredVariableDelta(runtime: AuthoredStoryRuntime, delta: Record<string, number> | undefined): AuthoredStoryRuntime {
  if (!delta) return runtime;
  const nextVariables = { ...runtime.variables };
  for (const definition of runtime.variableDefinitions) {
    const change = delta[definition.id];
    if (typeof change !== "number" || !Number.isFinite(change)) continue;
    nextVariables[definition.id] = clamp((nextVariables[definition.id] ?? definition.value) + change, definition.min, definition.max);
  }
  return { ...runtime, variables: nextVariables };
}

export function findAuthoredNode(runtime: AuthoredStoryRuntime, nodeId: string): AuthoredStoryNode | null {
  return runtime.nodes.find((node) => node.nodeId === nodeId) ?? null;
}

export function transitionAuthoredStorySession(
  baseSession: Session,
  choice: BeatChoice,
  exit: SceneExit,
  visitedForCurrent: string[],
): { session: Session; target: AuthoredStoryNode } {
  if (choice.effect.kind !== "change-scene") {
    throw new Error("仅 change-scene 选项可切换 authored node");
  }
  const runtime = baseSession.authoredStory;
  const targetNodeId = choice.effect.authoredTargetNodeId;
  if (!runtime || !targetNodeId) throw new Error("缺少 authored story transition");
  if (!isAuthoredNodePubliclyAccessible(runtime, targetNodeId)) {
    throw new Error("该作者锁定节点未向公开版本发行");
  }
  const target = findAuthoredNode(runtime, targetNodeId);
  if (!target) throw new Error(`authored node 不存在：${targetNodeId}`);
  let nextRuntime = applyAuthoredVariableDelta(runtime, choice.effect.variableDelta);
  nextRuntime = {
    ...nextRuntime,
    currentNodeId: target.nodeId,
    currentBeatId: target.scene.entryBeatId,
    visitedNodeIds: [...nextRuntime.visitedNodeIds, target.nodeId],
    currentCharacterState: target.characterState,
    currentVisualStates: target.characterVisualStates,
    currentRoleState: target.roleState,
  };
  const lanjianState = target.characterState?.lanjian;
  const characters = baseSession.characters.map((character) =>
    character.name === "岚见" && lanjianState
      ? {
          ...character,
          currentState: {
            ...character.currentState,
            name: character.name,
            publicIntro: character.currentState?.publicIntro || character.visualDescription,
            visualStatePrompt: lanjianState,
            spriteStateId:
              target.characterVisualStates?.lanjian ||
              character.currentState?.spriteStateId,
            updatedAtSceneId: target.scene.id,
            source: "client" as const,
          },
        }
      : character,
  );
  return {
    target,
    session: {
      ...baseSession,
      characters,
      history: [
        ...baseSession.history.map((entry, index, entries) =>
          index === entries.length - 1
            ? { ...entry, visitedBeatIds: visitedForCurrent, exit }
            : entry,
        ),
        {
          scene: target.scene,
          visitedBeatIds: [target.scene.entryBeatId],
          storyStateAfter: baseSession.storyState,
        },
      ],
      authoredStory: nextRuntime,
    },
  };
}

function beatId(nodeId: string, index: number): string { return `${nodeId}_b${index + 1}`; }

function nodeVisualStates(source: CaseStudySourceNode): Record<string, string> {
  if (source.characterVisualStates) return source.characterVisualStates;
  if (typeof source.visualState === "string") return { lanjian: source.visualState };
  if (typeof source.formState === "string") return { lanjian: source.formState };
  if (source.visualState && typeof source.visualState === "object") return source.visualState;
  return { lanjian: "humanized_homewear" };
}

function isRestrictedSourceNode(
  source: CaseStudySource,
  node: CaseStudySourceNode,
): boolean {
  return (
    node.restricted === true ||
    (node.releasePolicy !== undefined && node.releasePolicy !== "public") ||
    source.releasePolicy?.restrictedNodeIds.includes(node.nodeId) === true
  );
}

function compileNode(source: CaseStudySourceNode, imageUrl: string): AuthoredStoryNode {
  const beats: Beat[] = source.beats.map((beat, index) => {
    const id = beatId(source.nodeId, index);
    const isLast = index === source.beats.length - 1;
    let next: Beat["next"];
    if (!isLast) next = { type: "continue", nextBeatId: beatId(source.nodeId, index + 1) };
    else if (source.choices?.length) next = { type: "choice", choices: source.choices.map((choice) => ({ id: choice.choiceId, label: choice.label, effect: { kind: "change-scene", nextSceneSeed: choice.reason || source.summary, authoredTargetNodeId: choice.targetNodeId, variableDelta: choice.variableDelta } })) };
    else if (source.next) next = { type: "choice", choices: [{ id: `${source.nodeId}_continue`, label: "继续", effect: { kind: "change-scene", nextSceneSeed: source.summary, authoredTargetNodeId: source.next.nextNodeId } }] };
    else next = { type: "choice", choices: [] };
    return {
      id,
      ...(beat.speaker ? { speaker: beat.speaker, line: beat.text } : { narration: beat.text }),
      activeCharacters: beat.speaker && beat.speaker !== "你" && beat.speaker !== "原点售后语音" ? [{ name: beat.speaker, pose: source.characterState?.lanjian }] : undefined,
      next,
    };
  });
  return {
    nodeId: source.nodeId,
    sourceSceneId: source.sceneId,
    title: source.title,
    kind: source.kind,
    episodeId: source.episodeId,
    sourceParagraphIds: source.sourceParagraphIds,
    restricted: source.restricted,
    releasePolicy: source.releasePolicy,
    characterState: source.characterState,
    characterVisualStates: nodeVisualStates(source),
    roleState: source.roleState,
    scene: { id: `case_scene_${source.nodeId}`, scenePrompt: `${source.location}。${source.summary}`, beats, entryBeatId: beats[0]!.id, sceneKey: `case-${source.sceneId.toLowerCase()}`, imageUrl, orientation: "landscape" },
  };
}

export function compileCaseStudyBundle(source: CaseStudySource, manifest: CaseStudyAssetManifest, assetPaths: Record<string, string>, pendingImagePath: string): CaseStudyPublishedBundle {
  const cover = manifest.assets.find((asset) => asset.kind === "cover");
  const coverPath = cover?.status === "generated" && assetPaths[cover.assetId] ? assetPaths[cover.assetId]! : pendingImagePath;
  const imageForNode = (node: CaseStudySourceNode): string => {
    const desiredState = nodeVisualStates(node).lanjian;
    const exactStateFrame = manifest.assets.find((asset) =>
      asset.kind === "keyframe" &&
      asset.sceneId === node.sceneId &&
      (asset.formState ?? asset.visualState) === desiredState &&
      asset.status === "generated" &&
      assetPaths[asset.assetId],
    );
    const stateFallback = desiredState === "humanized_homewear"
      ? undefined
      : manifest.assets.find((asset) =>
          asset.kind === "keyframe" &&
          (asset.formState ?? asset.visualState) === desiredState &&
          asset.status === "generated" &&
          assetPaths[asset.assetId],
        );
    const sceneFallback = manifest.assets.find((asset) =>
      asset.kind === "keyframe" &&
      asset.sceneId === node.sceneId &&
      (!(asset.formState ?? asset.visualState) ||
        (asset.formState ?? asset.visualState) === desiredState) &&
      asset.status === "generated" &&
      assetPaths[asset.assetId],
    );
    const keyframe = exactStateFrame ?? stateFallback ?? sceneFallback;
    return keyframe ? assetPaths[keyframe.assetId]! : pendingImagePath;
  };
  const nodes = source.interactiveGraph.nodes
    .filter((node) => !isRestrictedSourceNode(source, node))
    .map((node) => compileNode(node, imageForNode(node)));
  const first = nodes.find((node) => node.nodeId === source.interactiveGraph.startNodeId);
  if (!first) throw new Error("首节点不存在，无法编译案例");
  const variableDefinitions = source.variables.map((definition) => ({ id: definition.id, label: definition.label, value: definition.default, min: definition.range[0], max: definition.range[1] }));
  const runtime: AuthoredStoryRuntime = {
    caseStudyId: source.caseStudyId,
    version: source.authorLocked
      ? `author-locked-${source.releaseVersion}`
      : `case-v${source.schemaVersion}`,
    authorLocked: source.authorLocked,
    releasePolicy: source.releasePolicy,
    aiContinuationBoundary: source.aiContinuationBoundary,
    currentNodeId: first.nodeId,
    currentBeatId: first.scene.entryBeatId,
    visitedNodeIds: [first.nodeId],
    variables: { ...source.interactiveGraph.defaultVariables },
    variableDefinitions,
    nodes,
    currentCharacterState: first.characterState,
    currentVisualStates: first.characterVisualStates,
    currentRoleState: first.roleState,
  };
  const characterBase = manifest.assets.find((asset) => asset.kind === "character_base");
  const characters = source.firstActCompat.characters.map((character) => {
    const sourceCharacter = source.characters.find((candidate) => candidate.name === character.name);
    const compactVisualStates = Object.entries(sourceCharacter?.visualForms ?? {}).map(
      ([id, description]) => {
        const matchingAsset = manifest.assets.find((asset) =>
          (asset.formState ?? asset.visualState) === id &&
          asset.status === "generated" &&
          (id === "native_android_chassis"
            ? asset.kind === "native_body_base"
            : asset.kind === "character_base"),
        );
        return {
          id,
          label: id === "humanized_homewear"
            ? "居家拟人态"
            : id === "native_android_chassis"
              ? "原生机体态"
              : id,
          description,
          assetId: matchingAsset?.assetId,
        };
      },
    );
    const visualStates = sourceCharacter?.visualStates?.length
      ? sourceCharacter.visualStates
      : compactVisualStates.length
        ? compactVisualStates
        : [
            {
              id: "humanized_homewear",
              label: "居家拟人态",
              description: sourceCharacter?.visualAnchor || character.visualDescription || "",
              assetId: characterBase?.assetId,
            },
          ];
    return {
      ...character,
      characterId: sourceCharacter?.id || character.characterId || character.name,
      basePortraitUrl: characterBase?.status === "generated" && assetPaths[characterBase.assetId] ? assetPaths[characterBase.assetId] : undefined,
      basePortraitUuid: undefined,
      basePortraitUrlRemote: undefined,
      currentState: {
        ...character.currentState,
        name: character.name,
        spriteStateId: first.characterVisualStates?.[sourceCharacter?.id || "lanjian"],
        visualStatePrompt: first.characterState?.[sourceCharacter?.id || "lanjian"],
        source: "client" as const,
      },
      spriteStates: visualStates.map((state) => ({
        id: state.id,
        label: state.label,
        visualPrompt: state.description,
        portraitUrl: state.assetId ? assetPaths[state.assetId] : undefined,
        source: "manual" as const,
      })),
    };
  });
  const session: Session = {
    id: `case:${source.caseStudyId}`,
    createdAt: Date.now(),
    worldSetting: source.firstActCompat.worldSetting,
    styleGuide: source.firstActCompat.styleGuide,
    history: [{ scene: first.scene, visitedBeatIds: [first.scene.entryBeatId], storyStateAfter: source.firstActCompat.storyState }],
    characters,
    storyState: source.firstActCompat.storyState,
    orientation: "landscape" as Orientation,
    language: "zh-CN",
    cacheIdentity: { visibility: "public", storyId: `case:${source.caseStudyId}`, templateId: source.caseStudyId, version: runtime.version },
    authoredStory: runtime,
  };
  const isRestrictedAsset = (asset: CaseStudySourceAsset) =>
    asset.status === "restricted" ||
    (asset.releasePolicy !== undefined && asset.releasePolicy !== "public");
  const restricted = manifest.assets.filter(isRestrictedAsset).length;
  const generated = manifest.assets.filter(
    (asset) => asset.status === "generated" && !isRestrictedAsset(asset),
  ).length;
  const failed = manifest.assets.filter(
    (asset) => asset.status === "failed" && !isRestrictedAsset(asset),
  ).length;
  const pending = manifest.assets.filter(
    (asset) => asset.status === "pending_generation" && !isRestrictedAsset(asset),
  ).length;
  return {
    schemaVersion: 1,
    kind: "aistory-authored-case",
    card: { id: source.caseStudyId, gender: source.firstActCompat.cardGender, index: 0, title: source.recommendedTitle, outline: source.storyMeta.tagline, style: source.firstActCompat.styleGuide, tags: source.storyMeta.genre, coverPath, playPath: `/play?case=${encodeURIComponent(source.caseStudyId)}`, assetStatus: coverPath === pendingImagePath ? "pending" : "ready", active: true },
    session,
    assetSummary: {
      generated,
      pending,
      failed,
      ...(restricted > 0 ? { restricted } : {}),
    },
  };
}
