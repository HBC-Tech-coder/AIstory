import "server-only";

import { createHash } from "node:crypto";

import {
  STUDIO_LIMITS,
  decodeStudioCursor,
  encodeStudioCursor,
  parseStudioListQuery,
  validateCreateProjectInput,
  validatePublishProjectInput,
  validateReviseProjectInput,
  validateSetVisibilityInput,
} from "./validation";
import {
  createStudioProjectsRepositoryFromEnv,
  type StudioProjectsStore,
} from "./repository";
import {
  StudioProjectsError,
  type StudioOwner,
  type StudioOwnerList,
  type StudioOwnerProject,
  type StudioOwnerRecord,
  type StudioOwnerSummary,
  type StudioPublicProject,
} from "./types";

/**
 * Studio online projects: owner-scoped CRUD plus the HTTP boundary.
 *
 * Ownership is derived only from the verified caller identity. Nothing from the
 * request body, query string, or headers can select, hint at, or override the
 * owner. The internal owner key is a namespaced one-way digest and it is never
 * returned in any response.
 */

/** Auth types the guard can currently prove. Anything else fails closed. */
const ALLOWED_AUTH_TYPES = ["phone", "aiuser", "supabase", "passport_v4"] as const;

const OWNER_NAMESPACE = "aistory.studio.projects.owner.v1";

function unauthorized(): StudioProjectsError {
  return new StudioProjectsError("unauthorized", 401, "Login required.");
}

function notFound(): StudioProjectsError {
  return new StudioProjectsError("not_found", 404, "Studio project not found.");
}

function payloadTooLarge(): StudioProjectsError {
  return new StudioProjectsError("payload_too_large", 413, "Request body is too large.");
}

function invalid(message: string): StudioProjectsError {
  return new StudioProjectsError("invalid_request", 400, message);
}

function csrfRejected(): StudioProjectsError {
  return new StudioProjectsError("csrf_rejected", 400, "Cross-site request rejected.");
}

function originUnavailable(code: string): StudioProjectsError {
  return new StudioProjectsError(code, 503, "Studio origin is not configured.");
}

function rejectStudioCsrf(): never {
  throw csrfRejected();
}

function parseStudioUrl(value: string): URL {
  try {
    return new URL(value);
  } catch {
    rejectStudioCsrf();
  }
}

function normalizedHost(value: string): string {
  return value.trim().toLowerCase();
}

function isLoopbackHost(value: string): boolean {
  const host = value.trim().toLowerCase();
  let hostname: string;
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end === -1) return false;
    hostname = host.slice(1, end);
  } else if (host.split(":").length > 2) {
    hostname = host;
  } else {
    const colon = host.lastIndexOf(":");
    hostname = colon === -1 ? host : host.slice(0, colon);
  }
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

type PinnedOrigin = { origin: string; host: string };

function readPinnedOrigin(raw: string | undefined, internal: boolean): PinnedOrigin | null {
  if (raw === undefined) return null;
  let value: URL;
  try {
    value = new URL(raw);
  } catch {
    throw originUnavailable("origin_misconfigured");
  }
  if (
    raw !== value.origin
    || value.username || value.password
    || value.pathname !== "/" || value.search || value.hash
    || (internal
      ? (value.protocol !== "http:" && value.protocol !== "https:")
        || !isLoopbackHost(value.host)
      : value.protocol !== "https:"
        && !(value.protocol === "http:" && isLoopbackHost(value.host)))
  ) {
    throw originUnavailable("origin_misconfigured");
  }
  return { origin: value.origin, host: value.host };
}

/**
 * Strict same-origin guard for mutations.
 *
 * A production public HTTPS origin is pinned exactly. The optional internal
 * loopback pin accounts for Next's Request.url behind the reverse proxy while
 * preserving the public Origin and Host checks. Next may apply the trusted
 * proxy's forwarded HTTPS scheme to that loopback URL, so both HTTP and HTTPS
 * are accepted only for the exact configured loopback origin. Forwarded
 * headers are otherwise ignored.
 */
export function assertStudioSameOriginMutation(request: Request): void {
  const originHeader = request.headers.get("origin");
  const hostHeader = request.headers.get("host");
  if (!originHeader || !hostHeader) rejectStudioCsrf();

  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite.trim().toLowerCase() === "cross-site") {
    rejectStudioCsrf();
  }

  const origin = parseStudioUrl(originHeader);
  const requestUrl = parseStudioUrl(request.url);
  if (origin.username || origin.password) rejectStudioCsrf();
  if (origin.pathname !== "/" || origin.search || origin.hash) rejectStudioCsrf();
  if (origin.protocol !== "https:" && origin.protocol !== "http:") rejectStudioCsrf();
  if (requestUrl.protocol !== "http:" && requestUrl.protocol !== "https:") {
    rejectStudioCsrf();
  }
  if (origin.protocol === "http:" && !isLoopbackHost(origin.host)) rejectStudioCsrf();
  const configured = readPinnedOrigin(process.env.AISTORY_STUDIO_PROJECTS_ORIGIN, false);
  const internal = readPinnedOrigin(process.env.AISTORY_STUDIO_PROJECTS_INTERNAL_ORIGIN, true);
  if (internal && (!configured || !configured.origin.startsWith("https://") || isLoopbackHost(configured.host))) {
    throw originUnavailable("origin_misconfigured");
  }
  if (process.env.NODE_ENV === "production" && !configured) {
    throw originUnavailable("origin_not_configured");
  }
  if (configured) {
    if (originHeader !== configured.origin || origin.origin !== configured.origin) rejectStudioCsrf();
    if (normalizedHost(hostHeader) !== configured.host) rejectStudioCsrf();
    if (requestUrl.origin !== configured.origin && requestUrl.origin !== internal?.origin) {
      rejectStudioCsrf();
    }
    return;
  }
  if (normalizedHost(origin.host) !== normalizedHost(hostHeader)) rejectStudioCsrf();
  if (requestUrl.origin !== origin.origin || normalizedHost(requestUrl.host) !== normalizedHost(hostHeader)) {
    rejectStudioCsrf();
  }
}

/**
 * Namespaced, one-way, stable owner identity. The namespace and auth type are
 * part of the digest input so the same `userId` under two auth contracts can
 * never alias one owner.
 */
export function deriveStudioOwnerKey(owner: StudioOwner): string {
  if (
    !owner
    || typeof owner.userId !== "string"
    || owner.userId.length === 0
    || owner.userId.length > 512
  ) {
    throw unauthorized();
  }
  if (
    typeof owner.authType !== "string"
    || !(ALLOWED_AUTH_TYPES as readonly string[]).includes(owner.authType)
  ) {
    throw unauthorized();
  }
  return createHash("sha256")
    .update(OWNER_NAMESPACE)
    .update("\u0000")
    .update(owner.authType)
    .update("\u0000")
    .update(owner.userId)
    .digest("hex");
}

function assertOwner(owner: StudioOwner): string {
  return deriveStudioOwnerKey(owner);
}

function sceneCount(record: StudioOwnerRecord): number {
  return record.draft.scenes.length;
}

function toSummary(record: StudioOwnerRecord): StudioOwnerSummary {
  return {
    id: record.id,
    revision: record.revision,
    title: record.draft.title,
    visibility: record.visibility,
    published: record.published,
    publishedRevision: record.publishedRevision,
    sceneCount: sceneCount(record),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    publishedAt: record.publishedAt,
  };
}

function toOwnerProject(record: StudioOwnerRecord): StudioOwnerProject {
  return { ...toSummary(record), draft: record.draft };
}

export type StudioProjectsServiceOptions = {
  store?: StudioProjectsStore;
};

export class StudioProjectsService {
  readonly store: StudioProjectsStore;

  constructor(options: StudioProjectsServiceOptions = {}) {
    this.store = options.store ?? createStudioProjectsRepositoryFromEnv();
  }

  async create(owner: StudioOwner, rawInput: unknown): Promise<StudioOwnerProject> {
    const ownerKey = assertOwner(owner);
    const input = validateCreateProjectInput(rawInput);
    const record = await this.store.create(ownerKey, input.draft);
    return toOwnerProject(record);
  }

  async list(
    owner: StudioOwner,
    query: { limit?: number; cursor?: string | null } = {},
  ): Promise<StudioOwnerList> {
    const ownerKey = assertOwner(owner);
    const limit = query.limit ?? STUDIO_LIMITS.defaultListLimit;
    const offset =
      query.cursor === undefined || query.cursor === null
        ? 0
        : decodeStudioCursor(query.cursor);
    const page = await this.store.listOwner(ownerKey, offset, limit);
    return {
      items: page.records.map(toSummary),
      nextCursor: page.hasMore
        ? encodeStudioCursor(offset + page.records.length)
        : null,
    };
  }

  async getOwn(owner: StudioOwner, id: string): Promise<StudioOwnerProject> {
    const ownerKey = assertOwner(owner);
    const record = await this.store.getOwner(ownerKey, id);
    // A wrong owner and an unknown id are indistinguishable.
    if (!record) throw notFound();
    return toOwnerProject(record);
  }

  async revise(
    owner: StudioOwner,
    id: string,
    rawInput: unknown,
  ): Promise<StudioOwnerProject> {
    const ownerKey = assertOwner(owner);
    const input = validateReviseProjectInput(rawInput);
    const record = await this.store.revise(
      ownerKey,
      id,
      input.expectedRevision,
      input.draft,
    );
    return toOwnerProject(record);
  }

  async publish(
    owner: StudioOwner,
    id: string,
    rawInput: unknown,
  ): Promise<StudioOwnerSummary> {
    const ownerKey = assertOwner(owner);
    const input = validatePublishProjectInput(rawInput);
    const record = await this.store.publish(
      ownerKey,
      id,
      input.expectedRevision,
      input.published,
      input.visibility,
    );
    return toSummary(record);
  }

  async setVisibility(
    owner: StudioOwner,
    id: string,
    rawInput: unknown,
  ): Promise<StudioOwnerSummary> {
    const ownerKey = assertOwner(owner);
    const input = validateSetVisibilityInput(rawInput);
    const record: StudioOwnerRecord = await this.store.setVisibility(
      ownerKey,
      id,
      input.expectedRevision,
      input.visibility,
    );
    return toSummary(record);
  }

  /** Public read: only the explicitly published safe snapshot can be returned. */
  async getPublic(id: string): Promise<StudioPublicProject | null> {
    if (typeof id !== "string" || id.length === 0 || id.length > 128) return null;
    const record = await this.store.getPublic(id);
    if (!record) return null;
    return {
      id: record.id,
      revision: record.revision,
      publishedAt: record.publishedAt,
      title: record.title,
      ...(record.synopsis === undefined ? {} : { synopsis: record.synopsis }),
      scenes: record.scenes,
    };
  }
}

/* ------------------------------------------------------------------ *
 * HTTP boundary
 * ------------------------------------------------------------------ */

const JSON_CACHE_OWNER = "private, no-store";
const JSON_CACHE_PUBLIC = "no-store";

function jsonResponse(
  data: unknown,
  status: number,
  cacheControl: string,
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cacheControl,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

function errorResponse(error: unknown, cacheControl: string): Response {
  if (error instanceof StudioProjectsError) {
    return jsonResponse(
      {
        error: error.publicMessage ?? "The request could not be completed.",
        code: error.code,
      },
      error.status,
      cacheControl,
    );
  }
  // Never reflect internal messages, SQL text, owner keys, or stack traces.
  console.error(
    "[studio-online] unexpected failure",
    error instanceof Error ? error.name : "unknown",
  );
  return jsonResponse(
    {
      error: "Studio online projects are temporarily unavailable.",
      code: "unavailable",
    },
    503,
    cacheControl,
  );
}

async function readJsonBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type");
  const mediaType = contentType?.split(";")[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new StudioProjectsError(
      "invalid_content_type",
      400,
      "Content-Type must be application/json.",
    );
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const trimmed = contentLength.trim();
    if (!/^\d+$/.test(trimmed)) throw invalid("Invalid Content-Length.");
    if (Number(trimmed) > STUDIO_LIMITS.maxRequestBodyBytes) throw payloadTooLarge();
  }

  const body = request.body;
  if (!body) throw invalid("Request body must be JSON.");

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > STUDIO_LIMITS.maxRequestBodyBytes) {
        await reader.cancel().catch(() => undefined);
        throw payloadTooLarge();
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof StudioProjectsError) throw error;
    throw invalid("Request body could not be read.");
  }

  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalid("Request body must be valid UTF-8.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalid("Request body must be valid JSON.");
  }
}

/**
 * `store` is an explicit qualification seam: routes never pass it, and the
 * production default always resolves the gated Supabase repository.
 */
function service(store?: StudioProjectsStore): StudioProjectsService {
  return new StudioProjectsService(store ? { store } : {});
}

export async function handleStudioCreateProject(
  request: Request,
  owner: StudioOwner,
  store?: StudioProjectsStore,
): Promise<Response> {
  try {
    assertStudioSameOriginMutation(request);
    const body = await readJsonBody(request);
    const project = await service(store).create(owner, body);
    return jsonResponse(project, 201, JSON_CACHE_OWNER);
  } catch (error) {
    return errorResponse(error, JSON_CACHE_OWNER);
  }
}

export async function handleStudioListProjects(
  request: Request,
  owner: StudioOwner,
  store?: StudioProjectsStore,
): Promise<Response> {
  try {
    const query = parseStudioListQuery(request);
    const page = await service(store).list(owner, {
      limit: query.limit,
      cursor: query.cursor,
    });
    return jsonResponse(page, 200, JSON_CACHE_OWNER);
  } catch (error) {
    return errorResponse(error, JSON_CACHE_OWNER);
  }
}

export async function handleStudioGetOwnProject(
  _request: Request,
  id: string,
  owner: StudioOwner,
  store?: StudioProjectsStore,
): Promise<Response> {
  try {
    const project = await service(store).getOwn(owner, id);
    return jsonResponse(project, 200, JSON_CACHE_OWNER);
  } catch (error) {
    return errorResponse(error, JSON_CACHE_OWNER);
  }
}

export async function handleStudioReviseProject(
  request: Request,
  id: string,
  owner: StudioOwner,
  store?: StudioProjectsStore,
): Promise<Response> {
  try {
    assertStudioSameOriginMutation(request);
    const body = await readJsonBody(request);
    const project = await service(store).revise(owner, id, body);
    return jsonResponse(project, 200, JSON_CACHE_OWNER);
  } catch (error) {
    return errorResponse(error, JSON_CACHE_OWNER);
  }
}

export async function handleStudioPublishProject(
  request: Request,
  id: string,
  owner: StudioOwner,
  store?: StudioProjectsStore,
): Promise<Response> {
  try {
    assertStudioSameOriginMutation(request);
    const body = await readJsonBody(request);
    const project = await service(store).publish(owner, id, body);
    return jsonResponse(project, 200, JSON_CACHE_OWNER);
  } catch (error) {
    return errorResponse(error, JSON_CACHE_OWNER);
  }
}

export async function handleStudioSetVisibility(
  request: Request,
  id: string,
  owner: StudioOwner,
  store?: StudioProjectsStore,
): Promise<Response> {
  try {
    assertStudioSameOriginMutation(request);
    const body = await readJsonBody(request);
    const project = await service(store).setVisibility(owner, id, body);
    return jsonResponse(project, 200, JSON_CACHE_OWNER);
  } catch (error) {
    return errorResponse(error, JSON_CACHE_OWNER);
  }
}

/**
 * Anonymous public read. Hidden and unknown ids return the same 404 body so the
 * two states stay indistinguishable. An unavailable gate returns an honest 503
 * instead of a misleading 404.
 */
export async function handleStudioGetPublicProject(
  _request: Request,
  id: string,
  store?: StudioProjectsStore,
): Promise<Response> {
  try {
    const project = await service(store).getPublic(id);
    if (!project) {
      return jsonResponse(
        { error: "Studio project not found.", code: "not_found" },
        404,
        JSON_CACHE_PUBLIC,
      );
    }
    return jsonResponse(project, 200, JSON_CACHE_PUBLIC);
  } catch (error) {
    return errorResponse(error, JSON_CACHE_PUBLIC);
  }
}
