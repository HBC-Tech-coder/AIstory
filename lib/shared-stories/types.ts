/**
 * Shared story domain types.
 *
 * This module deliberately exposes only replay data. There is no generation,
 * provider, credit, prompt, or authored-source field anywhere in the public
 * document or DTOs.
 */

export const SHARED_DOCUMENT_VERSION = 1 as const;
export const SHARED_STORE_SCHEMA = "shared-stories-v1" as const;

export type SharedVisibility = "public" | "hidden";

export type SharedChoiceTarget = {
  sceneId: string;
  beatId: string;
};

export type SharedChoice = {
  id: string;
  label: string;
  /**
   * Missing target means this recorded choice has no generated continuation.
   * Viewers must render it as disabled.
   */
  target?: SharedChoiceTarget;
};

export type SharedNext =
  | { type: "continue"; nextBeatId: string }
  | { type: "choice"; choices: SharedChoice[] };

export type SharedBeat = {
  id: string;
  narration?: string;
  speaker?: string;
  line?: string;
  next: SharedNext;
};

export type SharedScene = {
  id: string;
  imageUrl: string;
  entryBeatId: string;
  beats: SharedBeat[];
};

export type SharedDocumentV1 = {
  v: 1;
  scenes: SharedScene[];
};

/** Summary DTO. sourceId is included only in owner-only "mine" listings. */
export type SharedSummary = {
  id: string;
  title: string;
  visibility: SharedVisibility;
  revision: number;
  createdAt: string;
  updatedAt: string;
  sceneCount: number;
  coverUrl: string | null;
  sourceId?: string;
};

/** Full public DTO. It intentionally never contains sourceId or owner data. */
export type SharedStory = SharedSummary & {
  document: SharedDocumentV1;
};

export type SharedListResponse = {
  items: SharedSummary[];
  nextCursor: string | null;
};

/** Verified caller identity. Never spread a framework session into this type. */
export type SharedOwner = {
  userId: string;
  authType: string;
};

export type SharedMediaValidator = (url: string) => Promise<void>;

/** Internal persisted record. ownerKey is a one-way derived identity. */
export type SharedStoryRecord = {
  id: string;
  ownerKey: string;
  sourceId: string;
  title: string;
  visibility: SharedVisibility;
  revision: number;
  createdAt: string;
  updatedAt: string;
  sceneCount: number;
  coverUrl: string | null;
  contentHash: string;
  document: SharedDocumentV1;
};

export type SharedErrorStatus = 400 | 401 | 404 | 409 | 413 | 503;

/**
 * Expected, safe-to-map domain failure. publicMessage is the only text that may
 * cross the HTTP boundary; it never contains owner, path, or internal ids.
 */
export class SharedStoriesError extends Error {
  readonly code: string;
  readonly status: SharedErrorStatus;
  readonly publicMessage: string | undefined;

  constructor(code: string, status: SharedErrorStatus, publicMessage?: string) {
    super(publicMessage ? `${code}: ${publicMessage}` : code);
    this.name = "SharedStoriesError";
    this.code = code;
    this.status = status;
    this.publicMessage = publicMessage;
  }
}
