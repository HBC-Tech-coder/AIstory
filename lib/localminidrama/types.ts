export type LocalMiniDramaStatus = {
  ok: boolean;
  backendUrl: string;
  frontendUrl: string;
  health?: unknown;
  message?: string;
};

export type LocalMiniDramaCapabilityStatus = {
  ok: boolean;
  failClosed: boolean;
  backend: "ready" | "offline" | "blocked";
  frontend: "ready" | "offline" | "blocked";
  backendUrl: string;
  frontendUrl: string;
  modules: Array<{
    id: string;
    available: boolean;
    source: "aistory" | "localminidrama";
  }>;
  message: string;
  checkedAt: string;
};

export type LocalMiniDramaPagination = {
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
};

export type LocalMiniDramaDrama = {
  id: number;
  title: string;
  description?: string | null;
  genre?: string | null;
  style?: string | null;
  total_episodes?: number;
  status?: string;
  thumbnail?: string | null;
  tags?: string | null;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
  episodes?: LocalMiniDramaEpisode[];
  characters?: LocalMiniDramaCharacter[];
};

export type LocalMiniDramaCharacter = {
  id?: number;
  name: string;
  role?: string | null;
  description?: string | null;
  personality?: string | null;
  appearance?: string | null;
  image_url?: string | null;
  local_path?: string | null;
  negative_prompt?: string | null;
  sort_order?: number;
};

export type LocalMiniDramaEpisode = {
  id?: number;
  drama_id?: number;
  episode_number: number;
  title: string;
  script_content?: string | null;
  description?: string | null;
  duration?: number;
  status?: string;
  video_url?: string | null;
  thumbnail?: string | null;
  storyboards?: unknown[];
};

export type DreamFrameContinuationSettings = {
  targetEpisodes: number;
  firstBatchEpisodes: number;
  keywords: string[];
  gender: string;
  artStyle: string;
  plotStyle: string;
  voice: string;
  pacing: string;
  branchMode: "single-line" | "branch-overlay" | "branch-native";
  releaseMode?: string;
  adaptiveCrossFormat?: boolean;
};

export type DreamFrameBranchDraft = {
  branchId: string;
  parentEpisode: number;
  choiceText: string;
  direction: string;
  cachePolicy: "reuse-story-cache" | "new-story-cache";
  imageStyleCacheKey: string;
};

export type DreamFrameMiniDramaDraft = {
  title: string;
  summary: string;
  genre: string;
  style: string;
  tags: string[];
  thumbnail?: string | null;
  thumbnailName?: string | null;
  sourceText: string;
  characters: LocalMiniDramaCharacter[];
  episodes: LocalMiniDramaEpisode[];
  branches: DreamFrameBranchDraft[];
  platformVariants?: DreamFramePlatformVariant[];
  continuation: DreamFrameContinuationSettings;
};

export type DreamFramePlatformVariant = {
  platform: "desktop" | "mobile";
  orientation: "landscape" | "portrait";
  generationPolicy: "generate-first" | "generate-on-demand";
  referenceStrategy: "native" | "follow-winning-format";
};

export type LocalMiniDramaListResult = {
  items: LocalMiniDramaDrama[];
  pagination: LocalMiniDramaPagination;
};

export type LocalMiniDramaCreateResult = {
  drama: LocalMiniDramaDrama;
  detailUrl: string;
  filmUrl: string;
  frontendUrl: string;
};

export type LocalMiniDramaProjectSummary = {
  id: number;
  title: string;
  status: string;
  genre?: string;
  style?: string;
  episodeCount: number;
  updatedAt?: string;
};

export type LocalMiniDramaTaskSummary = {
  id: string;
  type: string;
  status:
    | "queued"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "unknown";
  progress: number;
  updatedAt?: string;
};

export type LocalMiniDramaProjectContext = {
  state: "ready" | "partial";
  project: LocalMiniDramaProjectSummary;
  counts: {
    characters: number;
    scenes: number;
    props: number;
    tasks: number;
    media: number;
    images: number;
    videos: number;
  };
  activeTasks: LocalMiniDramaTaskSummary[];
  lastUpdatedAt?: string;
  warnings: string[];
  checkedAt: string;
};
