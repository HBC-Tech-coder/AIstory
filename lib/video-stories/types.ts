import type {
  AuthoredVariableCondition,
  Orientation,
} from "@infiplot/types";
import type { VideoCompletionReason } from "@/lib/sceneMedia";
import type {
  VideoAssetReleasePolicy,
  VideoAssetStatus,
  VideoSubtitleCue,
} from "@/lib/video-assets/types";

export const VIDEO_STORY_SCHEMA_VERSION = 1 as const;

export type VideoStoryDraftStatus =
  | "draft"
  | "review_pending"
  | "published"
  | "offline";

export type VideoStoryEndedBehavior = "choices" | "advance" | "hold";

export type VideoStoryVariableDefinition = {
  id: string;
  label: string;
  initialValue: number;
  min: number;
  max: number;
};

export type VideoStoryChoiceDraft = {
  id: string;
  label: string;
  targetNodeId: string;
  conditions?: AuthoredVariableCondition[];
  variableDelta?: Record<string, number>;
};

export type VideoStoryNodeDraft = {
  nodeId: string;
  title: string;
  assetId: string;
  posterUrl?: string;
  subtitles?: VideoSubtitleCue[];
  vttUrl?: string;
  allowSkip: boolean;
  endedBehavior: VideoStoryEndedBehavior;
  endedTargetNodeId?: string;
  endedVariableDelta?: Record<string, number>;
  terminal: boolean;
  choices: VideoStoryChoiceDraft[];
  releasePolicy: VideoAssetReleasePolicy;
};

export type VideoStoryDraft = {
  schemaVersion: typeof VIDEO_STORY_SCHEMA_VERSION;
  id: string;
  projectId: number;
  storyId: string;
  title: string;
  summary: string;
  version: string;
  revision: number;
  orientation: Orientation;
  startNodeId: string;
  releasePolicy: VideoAssetReleasePolicy;
  status: VideoStoryDraftStatus;
  variables: VideoStoryVariableDefinition[];
  nodes: VideoStoryNodeDraft[];
  createdAt: string;
  updatedAt: string;
  submittedAt?: string;
  publishedReleaseId?: string;
};

export type VideoStoryAssetProjection = {
  id: string;
  projectId?: number;
  storyId?: string;
  status: VideoAssetStatus;
  releasePolicy: VideoAssetReleasePolicy;
  publicUrl?: string;
  durationMs: number;
  hasAudio: boolean;
  subtitles: VideoSubtitleCue[];
};

export type VideoStoryValidationIssue = {
  code: string;
  message: string;
  nodeId?: string;
};

export type VideoStoryValidationResult = {
  ok: boolean;
  errors: VideoStoryValidationIssue[];
  warnings: VideoStoryValidationIssue[];
  reachableNodeIds: string[];
};

export type VideoStoryPublicReleaseSummary = {
  releaseId: string;
  storyId: string;
  version: string;
  contentHash: string;
  publishedAt: string;
  status: "published" | "offline";
};

export type VideoStoryPreviewTransition = {
  nodeId: string;
  completionReason: VideoCompletionReason;
  targetNodeId?: string;
  variableDelta?: Record<string, number>;
};
