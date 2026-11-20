import type {
  AuthoredVariableCondition,
  BeatChoice,
} from "@infiplot/types";
import type { VideoCompletionReason } from "@/lib/sceneMedia";
import type {
  VideoStoryNodeDraft,
  VideoStoryPreviewTransition,
} from "./types";

export function evaluateAuthoredVariableCondition(
  condition: AuthoredVariableCondition,
  variables: Readonly<Record<string, number>>,
): boolean {
  const current = variables[condition.variableId];
  if (!Number.isFinite(current)) return false;
  const value = Number(current);
  switch (condition.operator) {
    case "eq":
      return value === condition.value;
    case "neq":
      return value !== condition.value;
    case "gte":
      return value >= condition.value;
    case "lte":
      return value <= condition.value;
    case "gt":
      return value > condition.value;
    case "lt":
      return value < condition.value;
  }
}

export function isAuthoredChoiceAvailable(
  choice: BeatChoice,
  variables: Readonly<Record<string, number>>,
): boolean {
  return (choice.conditions ?? []).every((condition) =>
    evaluateAuthoredVariableCondition(condition, variables),
  );
}

export function resolveVideoStoryPreviewCompletion(
  node: VideoStoryNodeDraft,
  reason: VideoCompletionReason,
): VideoStoryPreviewTransition {
  return {
    nodeId: node.nodeId,
    completionReason: reason,
    ...(node.endedBehavior === "advance" && node.endedTargetNodeId
      ? { targetNodeId: node.endedTargetNodeId }
      : {}),
    ...(node.endedVariableDelta
      ? { variableDelta: structuredClone(node.endedVariableDelta) }
      : {}),
  };
}
