import {
  STUDIO_DRAFT_VERSION,
  STUDIO_PUBLISHED_VERSION,
  StudioProjectsError,
  type StudioDraftScene,
  type StudioDraftV1,
  type StudioProjectVisibility,
  type StudioPublishedScene,
  type StudioPublishedSnapshotV1,
} from "./types";

/**
 * Hard limits for the Studio draft/snapshot contracts. They are applied to
 * inbound requests, to request bodies, and again to every value read back from
 * durable storage so a corrupted or hostile row cannot return unbounded data.
 */
export const STUDIO_LIMITS = {
  maxRequestBodyBytes: 256 * 1024,
  maxProjectsPerOwner: 100,
  maxTitleLength: 200,
  maxSynopsisLength: 2_000,
  maxAuthoringNotesLength: 8_000,
  maxScenes: 100,
  maxSceneIdLength: 128,
  maxSceneHeadingLength: 200,
  maxSceneBodyLength: 8_000,
  maxExpectedRevision: 1_000_000_000,
  defaultListLimit: 20,
  maxListLimit: 50,
  maxCursorLength: 512,
  maxCursorOffset: 1_000_000,
} as const;

const SCENE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OWNER_KEY_PATTERN = /^[a-f0-9]{64}$/;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const TAG_LIKE_MARKUP = /<(?=[A-Za-z/!?])/;

const DRAFT_KEYS = ["v", "title", "synopsis", "authoringNotes", "scenes"] as const;
const DRAFT_SCENE_KEYS = ["id", "heading", "body"] as const;
const PUBLISHED_KEYS = ["v", "title", "synopsis", "scenes"] as const;
const CREATE_REQUEST_KEYS = ["draft"] as const;
const REVISE_REQUEST_KEYS = ["expectedRevision", "draft"] as const;
const PUBLISH_REQUEST_KEYS = ["expectedRevision", "visibility", "published"] as const;
const VISIBILITY_REQUEST_KEYS = ["expectedRevision", "visibility"] as const;

const CURSOR_VERSION = 1;
const CURSOR_SORT = "createdAt:desc,id:asc";
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,512}$/;

export function invalidRequest(message: string): StudioProjectsError {
  return new StudioProjectsError("invalid_request", 400, message);
}

export function isStudioVisibility(value: unknown): value is StudioProjectVisibility {
  return value === "public" || value === "hidden";
}

export function parseStudioVisibility(value: unknown): StudioProjectVisibility {
  if (!isStudioVisibility(value)) {
    throw invalidRequest("visibility must be public or hidden.");
  }
  return value;
}

export function isOwnerKey(value: unknown): value is string {
  return typeof value === "string" && OWNER_KEY_PATTERN.test(value);
}

export function isProjectId(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertPlainObject(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!isPlainObject(value)) throw invalidRequest(`${label} must be an object.`);
  return value;
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      const display = key.length > 64 ? "unknown" : key;
      throw invalidRequest(`Unknown field "${display}" in ${label}.`);
    }
  }
}

function assertSafeText(value: string, label: string): void {
  if (CONTROL_CHARACTERS.test(value)) {
    throw invalidRequest(`${label} contains unsupported control characters.`);
  }
  if (TAG_LIKE_MARKUP.test(value)) {
    throw invalidRequest(`${label} contains unsupported markup.`);
  }
}

export function assertBoundedText(
  value: unknown,
  label: string,
  maxLength: number,
): string {
  if (typeof value !== "string") throw invalidRequest(`${label} must be a string.`);
  if (value.length === 0) throw invalidRequest(`${label} must not be empty.`);
  if (value.length > maxLength) throw invalidRequest(`${label} is too long.`);
  assertSafeText(value, label);
  return value;
}

function readOptionalText(
  value: unknown,
  label: string,
  maxLength: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw invalidRequest(`${label} must be a string.`);
  if (value.length === 0) throw invalidRequest(`${label} must not be empty.`);
  if (value.length > maxLength) throw invalidRequest(`${label} is too long.`);
  assertSafeText(value, label);
  return value;
}

function readSceneId(value: unknown, label: string): string {
  if (typeof value !== "string" || !SCENE_ID_PATTERN.test(value)) {
    throw invalidRequest(`${label} must be a stable scene id.`);
  }
  return value;
}

function readScenes<T extends StudioDraftScene | StudioPublishedScene>(
  value: unknown,
  label: string,
  keys: readonly string[],
): T[] {
  if (!Array.isArray(value)) throw invalidRequest(`${label} must be an array.`);
  if (value.length === 0) {
    throw invalidRequest(`${label} must contain at least one scene.`);
  }
  if (value.length > STUDIO_LIMITS.maxScenes) {
    throw invalidRequest(`${label} has too many scenes.`);
  }
  const ids = new Set<string>();
  return value.map((rawScene, index) => {
    const sceneLabel = `${label}[${index}]`;
    const scene = assertPlainObject(rawScene, sceneLabel);
    assertAllowedKeys(scene, keys, sceneLabel);
    const id = readSceneId(scene.id, `${sceneLabel}.id`);
    if (ids.has(id)) throw invalidRequest(`${label} contains duplicate scene ids.`);
    ids.add(id);
    const heading = assertBoundedText(
      scene.heading,
      `${sceneLabel}.heading`,
      STUDIO_LIMITS.maxSceneHeadingLength,
    );
    const body = assertBoundedText(
      scene.body,
      `${sceneLabel}.body`,
      STUDIO_LIMITS.maxSceneBodyLength,
    );
    return { id, heading, body } as T;
  });
}

/**
 * Explicit whitelist validation of the private draft. Unknown keys at every
 * level (owner keys, provider data, generated assets, iframe state, ...) are
 * rejected rather than ignored.
 */
export function validateDraftStructure(input: unknown): StudioDraftV1 {
  const raw = assertPlainObject(input, "draft");
  assertAllowedKeys(raw, DRAFT_KEYS, "draft");
  if (raw.v !== STUDIO_DRAFT_VERSION) throw invalidRequest("draft.v must be 1.");

  const title = assertBoundedText(raw.title, "draft.title", STUDIO_LIMITS.maxTitleLength);
  const synopsis = readOptionalText(
    raw.synopsis,
    "draft.synopsis",
    STUDIO_LIMITS.maxSynopsisLength,
  );
  const authoringNotes = readOptionalText(
    raw.authoringNotes,
    "draft.authoringNotes",
    STUDIO_LIMITS.maxAuthoringNotesLength,
  );
  const scenes = readScenes<StudioDraftScene>(raw.scenes, "draft.scenes", DRAFT_SCENE_KEYS);

  return {
    v: STUDIO_DRAFT_VERSION,
    title,
    ...(synopsis === undefined ? {} : { synopsis }),
    ...(authoringNotes === undefined ? {} : { authoringNotes }),
    scenes,
  };
}

/**
 * Explicit whitelist validation of the published safe snapshot. It shares no
 * optional authoring field with the draft, so `authoringNotes` cannot cross the
 * public boundary even when a caller tries to send it.
 */
export function validatePublishedStructure(input: unknown): StudioPublishedSnapshotV1 {
  const raw = assertPlainObject(input, "published");
  assertAllowedKeys(raw, PUBLISHED_KEYS, "published");
  if (raw.v !== STUDIO_PUBLISHED_VERSION) {
    throw invalidRequest("published.v must be 1.");
  }

  const title = assertBoundedText(raw.title, "published.title", STUDIO_LIMITS.maxTitleLength);
  const synopsis = readOptionalText(
    raw.synopsis,
    "published.synopsis",
    STUDIO_LIMITS.maxSynopsisLength,
  );
  const scenes = readScenes<StudioPublishedScene>(
    raw.scenes,
    "published.scenes",
    DRAFT_SCENE_KEYS,
  );

  return {
    v: STUDIO_PUBLISHED_VERSION,
    title,
    ...(synopsis === undefined ? {} : { synopsis }),
    scenes,
  };
}

function readExpectedRevision(value: unknown, required: boolean): number | undefined {
  if (value === undefined) {
    if (required) throw invalidRequest("expectedRevision is required.");
    return undefined;
  }
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 1
    || value > STUDIO_LIMITS.maxExpectedRevision
  ) {
    throw invalidRequest("expectedRevision must be a positive integer.");
  }
  return value;
}

export type CreateProjectInput = {
  draft: StudioDraftV1;
};

export function validateCreateProjectInput(input: unknown): CreateProjectInput {
  const body = assertPlainObject(input, "request body");
  assertAllowedKeys(body, CREATE_REQUEST_KEYS, "request body");
  if (body.draft === undefined) throw invalidRequest("draft is required.");
  return { draft: validateDraftStructure(body.draft) };
}

export type ReviseProjectInput = {
  expectedRevision: number;
  draft: StudioDraftV1;
};

export function validateReviseProjectInput(input: unknown): ReviseProjectInput {
  const body = assertPlainObject(input, "request body");
  assertAllowedKeys(body, REVISE_REQUEST_KEYS, "request body");
  const expectedRevision = readExpectedRevision(body.expectedRevision, true)!;
  if (body.draft === undefined) throw invalidRequest("draft is required.");
  return { expectedRevision, draft: validateDraftStructure(body.draft) };
}

export type PublishProjectInput = {
  expectedRevision: number;
  /** Absent means the explicit publish default: public. */
  visibility: StudioProjectVisibility;
  published: StudioPublishedSnapshotV1;
};

/**
 * Publish is the only place where the public default is applied, and only when
 * the request explicitly performs a publish. A stored draft keeps the private
 * `hidden` default until then.
 */
export function validatePublishProjectInput(input: unknown): PublishProjectInput {
  const body = assertPlainObject(input, "request body");
  assertAllowedKeys(body, PUBLISH_REQUEST_KEYS, "request body");
  const expectedRevision = readExpectedRevision(body.expectedRevision, true)!;
  const visibility =
    body.visibility === undefined ? "public" : parseStudioVisibility(body.visibility);
  if (body.published === undefined) throw invalidRequest("published is required.");
  return {
    expectedRevision,
    visibility,
    published: validatePublishedStructure(body.published),
  };
}

export type SetVisibilityInput = {
  expectedRevision: number;
  visibility: StudioProjectVisibility;
};

export function validateSetVisibilityInput(input: unknown): SetVisibilityInput {
  const body = assertPlainObject(input, "request body");
  assertAllowedKeys(body, VISIBILITY_REQUEST_KEYS, "request body");
  return {
    expectedRevision: readExpectedRevision(body.expectedRevision, true)!,
    visibility: parseStudioVisibility(body.visibility),
  };
}

export type StudioListQuery = {
  limit: number;
  cursor: string | null;
};

export function parseStudioListQuery(request: Request): StudioListQuery {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    throw invalidRequest("Invalid request URL.");
  }
  const params = url.searchParams;
  for (const key of params.keys()) {
    if (key !== "limit" && key !== "cursor") {
      throw invalidRequest("Unknown query parameter.");
    }
  }
  for (const key of ["limit", "cursor"] as const) {
    if (params.getAll(key).length > 1) throw invalidRequest("Duplicate query parameter.");
  }

  const limitRaw = params.get("limit");
  let limit: number = STUDIO_LIMITS.defaultListLimit;
  if (limitRaw !== null) {
    if (!/^\d{1,3}$/.test(limitRaw)) throw invalidRequest("limit must be an integer.");
    limit = Number(limitRaw);
    if (limit < 1 || limit > STUDIO_LIMITS.maxListLimit) {
      throw invalidRequest("limit must be between 1 and 50.");
    }
  }

  const cursorRaw = params.get("cursor");
  let cursor: string | null = null;
  if (cursorRaw !== null) {
    if (cursorRaw.length === 0 || cursorRaw.length > STUDIO_LIMITS.maxCursorLength) {
      throw invalidRequest("Invalid list cursor.");
    }
    cursor = cursorRaw;
  }

  return { limit, cursor };
}

type CursorPayload = {
  v: typeof CURSOR_VERSION;
  s: typeof CURSOR_SORT;
  o: number;
};

export function encodeStudioCursor(offset: number): string {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > STUDIO_LIMITS.maxCursorOffset) {
    throw invalidRequest("Invalid list cursor.");
  }
  const payload: CursorPayload = { v: CURSOR_VERSION, s: CURSOR_SORT, o: offset };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeStudioCursor(raw: string): number {
  if (typeof raw !== "string" || !CURSOR_PATTERN.test(raw)) {
    throw invalidRequest("Invalid list cursor.");
  }
  let payload: unknown;
  try {
    const bytes = Buffer.from(raw, "base64url");
    if (bytes.toString("base64url") !== raw) throw new Error("non-canonical cursor");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    payload = JSON.parse(text);
  } catch {
    throw invalidRequest("Invalid list cursor.");
  }
  if (!isPlainObject(payload)) throw invalidRequest("Invalid list cursor.");
  const keys = Object.keys(payload);
  if (keys.length !== 3) throw invalidRequest("Invalid list cursor.");
  for (const key of keys) {
    if (key !== "v" && key !== "s" && key !== "o") {
      throw invalidRequest("Invalid list cursor.");
    }
  }
  const cursor = payload as Record<string, unknown>;
  if (cursor.v !== CURSOR_VERSION || cursor.s !== CURSOR_SORT) {
    throw invalidRequest("Invalid list cursor.");
  }
  const offset = cursor.o;
  if (
    typeof offset !== "number"
    || !Number.isSafeInteger(offset)
    || offset < 0
    || offset > STUDIO_LIMITS.maxCursorOffset
  ) {
    throw invalidRequest("Invalid list cursor.");
  }
  return offset;
}
