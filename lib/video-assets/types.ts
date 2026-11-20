export type VideoAssetStatus =
  | "draft"
  | "review_pending"
  | "publishable"
  | "offline";

export type VideoAssetReleasePolicy = "public" | "internal" | "enterprise";

export type VideoSubtitleCue = {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  speaker?: string;
};

export type VideoAssetDto = {
  id: string;
  contentHash: string;
  contentType: "video/mp4" | "video/webm";
  bytes: number;
  durationMs: number;
  width: number;
  height: number;
  videoCodec: string;
  audioCodec?: string;
  hasAudio: boolean;
  orientation: "landscape" | "portrait" | "square";
  status: VideoAssetStatus;
  releasePolicy: VideoAssetReleasePolicy;
  projectId?: number;
  storyId?: string;
  nodeId?: string;
  title: string;
  subtitles: VideoSubtitleCue[];
  source: "upload" | "generation_job";
  createdAt: string;
  updatedAt: string;
  reviewNote?: string;
  previewUrl: string;
  publicUrl?: string;
};

export type VideoAssetCapabilityStatus = {
  adapter: "local_development" | "production_object_storage";
  available: boolean;
  uploadAvailable: boolean;
  generationAvailable: boolean;
  reason?: string;
  maxUploadBytes: number;
  acceptedTypes: Array<"video/mp4" | "video/webm">;
};

export type VideoProbeResult = {
  durationMs: number;
  width: number;
  height: number;
  videoCodec: string;
  audioCodec?: string;
  hasAudio: boolean;
};

