import type {
  BranchPrefetchDepth,
  Character,
  EngineConfig,
  SceneRequest,
  Session,
  SpeculativeBranchRequest,
  StoryState,
} from "@infiplot/types";
import { coerceOrientation } from "@infiplot/types";

export const SPECULATIVE_BRANCH_CACHE_VERSION = "speculative-branch-v1";
export const DEFAULT_BRANCH_PREFETCH_DEPTH: BranchPrefetchDepth = 1;
export const DEFAULT_BRANCH_PREFETCH_BUDGET = 6;

export type SpeculativeBranchKeys = {
  textKey: string;
  imageKey: string;
  key: string;
  namespace: string;
  sourceNodeId: string;
  choiceId: string;
  targetNodeId: string;
  characterStateRevision: string;
};

export type SpeculativePolicy = {
  maxDepth: BranchPrefetchDepth;
  branchBudget: number;
  predictionConcurrency: number;
  foregroundConcurrency: number;
};

export function coerceBranchPrefetchDepth(
  value: unknown,
  fallback: BranchPrefetchDepth = DEFAULT_BRANCH_PREFETCH_DEPTH,
): BranchPrefetchDepth {
  const numeric = Number(value);
  return numeric === 0 || numeric === 1 || numeric === 2 ? numeric : fallback;
}

export function clampBranchPrefetchDepth(
  requested: unknown,
  adminMax: unknown,
): BranchPrefetchDepth {
  const depth = coerceBranchPrefetchDepth(requested);
  const cap = coerceBranchPrefetchDepth(adminMax, 2);
  return Math.min(depth, cap) as BranchPrefetchDepth;
}

export function shouldSchedulePrefetch(
  currentDepth: number,
  requestedDepth: unknown,
  adminMax: unknown,
  usedBudget: number,
  branchBudget: number,
): boolean {
  return (
    currentDepth < clampBranchPrefetchDepth(requestedDepth, adminMax) &&
    usedBudget < Math.max(0, Math.floor(branchBudget))
  );
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Web-compatible deterministic hash; keys never contain raw story/user text. */
export function stableHash(value: unknown): string {
  const input = stableStringify(value);
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

function normalizeText(value: string | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ");
}

function storyStateForRevision(state: StoryState | undefined): unknown {
  if (!state) return null;
  return {
    logline: state.logline,
    genreTags: state.genreTags,
    protagonist: state.protagonist,
    castNotes: state.castNotes,
    synopsis: state.synopsis,
    openThreads: state.openThreads,
    relationships: state.relationships,
    nextHook: state.nextHook,
  };
}

function characterForRevision(character: Character): unknown {
  return {
    name: character.name,
    persona: character.persona,
    personalityTraits: character.personalityTraits,
    speakingStyle: character.speakingStyle,
    relationshipToPlayer: character.relationshipToPlayer,
    currentState: character.currentState,
    spriteStates: character.spriteStates,
    profileStages: character.profileStages,
    voiceProfile: character.voiceProfile,
  };
}

export function characterStateRevision(session: Pick<Session, "characters" | "storyState">): string {
  return stableHash({
    characters: [...(session.characters ?? [])]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(characterForRevision),
    storyState: storyStateForRevision(session.storyState),
  });
}

function latestChoice(session: Session): {
  sourceNodeId: string;
  choiceId: string;
  targetNodeId: string;
} | null {
  const latest = session.history[session.history.length - 1];
  if (!latest || latest.exit?.kind !== "choice") return null;
  return {
    sourceNodeId: latest.scene.id,
    choiceId: latest.exit.choiceId,
    // Generated stories do not know the next scene id before generation. The
    // writer-authored seed is the stable target-node identity at this boundary.
    targetNodeId: normalizeText(latest.exit.nextSceneSeed),
  };
}

function cacheNamespace(session: Session): string {
  const identity = session.cacheIdentity;
  if (identity?.visibility === "public") return "public";
  return `private:${identity?.ownerNamespace || session.id}`;
}

export function buildSpeculativeBranchKeys(
  session: Session,
  config: Pick<EngineConfig, "text" | "image">,
): SpeculativeBranchKeys | null {
  const edge = latestChoice(session);
  if (!edge) return null;
  const identity = session.cacheIdentity;
  const namespace = cacheNamespace(session);
  const stateRevision = characterStateRevision(session);
  const storyConfigRevision = stableHash({
    worldSetting: normalizeText(session.worldSetting),
    storyState: storyStateForRevision(session.storyState),
    narrativeStyle: normalizeText(session.narrativeStyle) || "自动",
    narrativeStyleRevision: session.narrativeStyleRevision ?? null,
    textProvider: config.text.provider ?? "openai_compatible",
    textModel: config.text.model,
  });
  const textKey = stableHash({
    version: SPECULATIVE_BRANCH_CACHE_VERSION,
    namespace,
    storyId: identity?.storyId || stableHash(session.worldSetting),
    templateId: identity?.templateId ?? null,
    storyVersion: identity?.version || "session-v1",
    sourceNodeId: edge.sourceNodeId,
    choiceId: edge.choiceId,
    targetNodeId: edge.targetNodeId,
    language: normalizeText(session.language) || "zh-CN",
    storyConfigRevision,
    characterStateRevision: stateRevision,
  });
  const orientation = coerceOrientation(session.orientation);
  const imageKey = stableHash({
    version: SPECULATIVE_BRANCH_CACHE_VERSION,
    textKey,
    visualStyleRevision: stableHash(normalizeText(session.styleGuide)),
    sessionVisualStyleRevision: session.visualStyleRevision ?? null,
    visualReferenceRevision: session.styleReferenceImage
      ? stableHash(session.styleReferenceImage)
      : null,
    orientation,
    aspectRatio: orientation === "portrait" ? "9:16" : "16:9",
    imageProvider: config.image.provider ?? "auto",
    imageModel: config.image.model,
    imageVersion: process.env.AISTORY_IMAGE_MODEL_VERSION || config.image.model,
  });
  return {
    textKey,
    imageKey,
    key: `${textKey}.${imageKey}`,
    namespace,
    ...edge,
    characterStateRevision: stateRevision,
  };
}

export function normalizeSpeculation(
  value: SceneRequest["speculation"],
): SpeculativeBranchRequest | undefined {
  if (!value || (value.mode !== "prefetch" && value.mode !== "foreground")) {
    return undefined;
  }
  return {
    mode: value.mode,
    requestedDepth: coerceBranchPrefetchDepth(value.requestedDepth),
    branchOrdinal: Math.max(0, Math.floor(Number(value.branchOrdinal) || 0)),
    includeAudio: value.includeAudio === true,
  };
}
