import type { VideoSubtitleCue } from "@/lib/video-assets/types";
import type {
  VideoStoryDraft,
  VideoStoryNodeDraft,
} from "./types";

export const VIDEO_STORY_MAX_DURATION_MS = 6 * 60 * 60 * 1_000;

export function nextVideoStoryEditorId(
  prefix: string,
  existing: readonly string[],
): string {
  const taken = new Set(existing);
  let index = Math.max(1, existing.length + 1);
  while (taken.has(`${prefix}-${index}`)) index += 1;
  return `${prefix}-${index}`;
}

export function clampVideoStoryTimeMs(
  value: number,
  durationMs: number,
): number {
  if (!Number.isFinite(value)) return 0;
  const safeDuration = Math.min(
    VIDEO_STORY_MAX_DURATION_MS,
    Math.max(0, Number.isFinite(durationMs) ? Math.round(durationMs) : 0),
  );
  return Math.min(safeDuration, Math.max(0, Math.round(value)));
}

export function moveVideoStoryItem<T>(
  values: readonly T[],
  from: number,
  to: number,
): T[] {
  if (
    from < 0 ||
    from >= values.length ||
    to < 0 ||
    to >= values.length ||
    from === to
  ) {
    return [...values];
  }
  const next = [...values];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

export function createVideoStorySubtitleCue(
  cues: readonly VideoSubtitleCue[],
  durationMs: number,
  preferredStartMs?: number,
): VideoSubtitleCue {
  const duration = clampVideoStoryTimeMs(durationMs, durationMs);
  const lastEnd = cues.at(-1)?.endMs ?? 0;
  let startMs = clampVideoStoryTimeMs(
    preferredStartMs ?? lastEnd,
    duration,
  );
  if (duration > 0 && startMs >= duration) {
    startMs = Math.max(0, duration - Math.min(1_000, duration));
  }
  let endMs = duration > 0
    ? Math.min(duration, startMs + 2_000)
    : startMs + 2_000;
  if (endMs <= startMs) endMs = startMs + 1;
  return {
    id: nextVideoStoryEditorId(
      "cue",
      cues.map((cue) => cue.id),
    ),
    startMs,
    endMs,
    text: "",
  };
}

export function duplicateVideoStorySubtitleCue(
  cues: readonly VideoSubtitleCue[],
  index: number,
  durationMs: number,
): VideoSubtitleCue[] {
  const source = cues[index];
  if (!source) return [...cues];
  const next = createVideoStorySubtitleCue(cues, durationMs);
  const copiedDuration = Math.max(1, source.endMs - source.startMs);
  const duration = clampVideoStoryTimeMs(durationMs, durationMs);
  next.endMs = duration > 0
    ? Math.min(duration, next.startMs + copiedDuration)
    : next.startMs + copiedDuration;
  if (next.endMs <= next.startMs) next.endMs = next.startMs + 1;
  next.text = source.text;
  if (source.speaker) next.speaker = source.speaker;
  return [...cues, next];
}

export function renameVideoStoryNode(
  draft: VideoStoryDraft,
  index: number,
  nextNodeId: string,
): VideoStoryDraft {
  const current = draft.nodes[index];
  if (!current || current.nodeId === nextNodeId) return draft;
  const previousNodeId = current.nodeId;
  return {
    ...draft,
    startNodeId:
      draft.startNodeId === previousNodeId
        ? nextNodeId
        : draft.startNodeId,
    nodes: draft.nodes.map((node, nodeIndex) => ({
      ...node,
      nodeId: nodeIndex === index ? nextNodeId : node.nodeId,
      ...(node.endedTargetNodeId === previousNodeId
        ? { endedTargetNodeId: nextNodeId }
        : {}),
      choices: node.choices.map((choice) => ({
        ...choice,
        targetNodeId:
          choice.targetNodeId === previousNodeId
            ? nextNodeId
            : choice.targetNodeId,
      })),
    })),
  };
}

export function duplicateVideoStoryNode(
  draft: VideoStoryDraft,
  index: number,
): VideoStoryDraft {
  const source = draft.nodes[index];
  if (!source) return draft;
  const nodeId = nextVideoStoryEditorId(
    `${source.nodeId}-copy`,
    draft.nodes.map((node) => node.nodeId),
  );
  const copy: VideoStoryNodeDraft = {
    ...structuredClone(source),
    nodeId,
    title: `${source.title}（副本）`,
  };
  const nodes = [...draft.nodes];
  nodes.splice(index + 1, 0, copy);
  return { ...draft, nodes };
}

export function deleteVideoStoryNode(
  draft: VideoStoryDraft,
  index: number,
): VideoStoryDraft {
  if (draft.nodes.length <= 1 || !draft.nodes[index]) return draft;
  const removedId = draft.nodes[index]!.nodeId;
  const nodes = draft.nodes.filter((_, nodeIndex) => nodeIndex !== index);
  return {
    ...draft,
    nodes,
    startNodeId:
      draft.startNodeId === removedId
        ? nodes[0]!.nodeId
        : draft.startNodeId,
  };
}
