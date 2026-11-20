/**
 * Studio online project contracts (server-only).
 *
 * An owner keeps a private authoring draft. Publishing stores a separate,
 * explicitly supplied safe snapshot. Public reads can only ever observe that
 * snapshot, so authoring-only fields and the internal owner key stay private by
 * construction rather than by projection discipline at call sites.
 *
 * There is deliberately no provider task, workflow, credit, or iframe field
 * anywhere in this module.
 */

/** Exact forward-only schema-gate version owned by this slice. */
export const STUDIO_PROJECTS_GATE_VERSION = "20261115090000" as const;

/** Exact, default-off feature selector value for the online repository. */
export const STUDIO_PROJECTS_MODE = "supabase-v1" as const;

export const STUDIO_DRAFT_VERSION = 1 as const;
export const STUDIO_PUBLISHED_VERSION = 1 as const;

export type StudioProjectVisibility = "public" | "hidden";

/** One authored scene inside the private draft. */
export type StudioDraftScene = {
  id: string;
  heading: string;
  body: string;
};

/** Private authoring document. `authoringNotes` is never published. */
export type StudioDraftV1 = {
  v: typeof STUDIO_DRAFT_VERSION;
  title: string;
  synopsis?: string;
  authoringNotes?: string;
  scenes: StudioDraftScene[];
};

/** One scene inside the explicitly published safe snapshot. */
export type StudioPublishedScene = {
  id: string;
  heading: string;
  body: string;
};

/**
 * Explicitly published safe document. It has no authoring-only field, so a
 * draft note cannot be published even by accident.
 */
export type StudioPublishedSnapshotV1 = {
  v: typeof STUDIO_PUBLISHED_VERSION;
  title: string;
  synopsis?: string;
  scenes: StudioPublishedScene[];
};

/** Owner-only summary. Never carries owner identity or draft bodies. */
export type StudioOwnerSummary = {
  id: string;
  revision: number;
  title: string;
  visibility: StudioProjectVisibility;
  published: boolean;
  publishedRevision: number | null;
  sceneCount: number;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
};

/** Owner-only detail. The private draft is scoped to the owning caller. */
export type StudioOwnerProject = StudioOwnerSummary & {
  draft: StudioDraftV1;
};

/** Owner list page. */
export type StudioOwnerList = {
  items: StudioOwnerSummary[];
  nextCursor: string | null;
};

/** Public projection: published safe fields only. */
export type StudioPublicProject = {
  id: string;
  revision: number;
  publishedAt: string;
  title: string;
  synopsis?: string;
  scenes: StudioPublishedScene[];
};

/**
 * Internal repository record for an owner-scoped row. It intentionally has no
 * owner key field: the domain layer must never be able to echo it.
 */
export type StudioOwnerRecord = {
  id: string;
  revision: number;
  draft: StudioDraftV1;
  visibility: StudioProjectVisibility;
  published: boolean;
  publishedRevision: number | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
};

/** Internal repository record for the public projection. */
export type StudioPublicRecord = {
  id: string;
  revision: number;
  publishedAt: string;
  title: string;
  synopsis?: string;
  scenes: StudioPublishedScene[];
};

/**
 * Verified caller identity copied field by field from the auth guard. A
 * framework session object is never spread into this type.
 */
export type StudioOwner = {
  userId: string;
  authType: string;
};

export type StudioErrorStatus = 400 | 401 | 404 | 409 | 413 | 503;

/**
 * Expected, safe-to-map domain failure. `publicMessage` is the only text that
 * may cross the HTTP boundary; it never contains an owner key, a user id, a
 * filesystem path, or an internal SQL message.
 */
export class StudioProjectsError extends Error {
  readonly code: string;
  readonly status: StudioErrorStatus;
  readonly publicMessage: string | undefined;

  constructor(code: string, status: StudioErrorStatus, publicMessage?: string) {
    super(publicMessage ? `${code}: ${publicMessage}` : code);
    this.name = "StudioProjectsError";
    this.code = code;
    this.status = status;
    this.publicMessage = publicMessage;
  }
}
