import type {
  Character,
  Scene,
  SceneExit,
  Session,
  StoryState,
} from "@infiplot/types";

export type CreatorShellSurface = "pc" | "mobile" | "embedded";

export type CreatorShellCapability =
  | "story.start"
  | "story.continue"
  | "beat.insert"
  | "branch.preview"
  | "branch.publish"
  | "worldline.inspect"
  | "character.edit"
  | "asset.import"
  | "asset.review"
  | "revenue.inspect"
  | "model.configure";

export type CreatorShellManifest = {
  id: string;
  name: string;
  version: string;
  author?: string;
  description?: string;
  surfaces: CreatorShellSurface[];
  capabilities: CreatorShellCapability[];
  entryRoute?: string;
};

export type CreatorShellContext = {
  userId: string;
  projectId?: string;
  sessionId?: string;
  locale: string;
  surface: CreatorShellSurface;
  role: "player" | "creator" | "operator";
  featureFlags?: Record<string, boolean>;
};

export type DraftPatch = {
  id?: string;
  baseSceneId?: string;
  title?: string;
  notes?: string;
  sceneText?: string;
  choices?: Array<{ label: string; intent: string }>;
  metadata?: Record<string, unknown>;
};

export type BranchPreviewRequest = {
  session: Session;
  exit: SceneExit;
  draftPatch?: DraftPatch;
};

export type BranchPreviewResponse = {
  scene: Scene;
  imageUrl: string;
  characters: Character[];
  storyState: StoryState;
  diagnostics?: Record<string, unknown>;
};

export type CreatorShellBridge = {
  getSession(sessionId: string): Promise<Session | null>;
  saveDraftPatch(projectId: string, patch: DraftPatch): Promise<DraftPatch>;
  previewBranch(request: BranchPreviewRequest): Promise<BranchPreviewResponse>;
  publishBranch(projectId: string, patchId: string): Promise<{ branchId: string }>;
  importAsset(projectId: string, file: File, metadata?: Record<string, unknown>): Promise<{ assetId: string }>;
  listCharacters(projectId: string): Promise<Character[]>;
};

