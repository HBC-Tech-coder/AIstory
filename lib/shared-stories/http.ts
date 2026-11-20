import {
  createSharedStoriesServiceFromEnv,
  SharedStoriesService,
} from "./service";
import { SharedStoriesError, type SharedOwner } from "./types";

const MAX_REQUEST_BYTES = 1024 * 1024;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function errorResponse(error: unknown): Response {
  if (error instanceof SharedStoriesError) {
    return jsonResponse(
      {
        error: error.publicMessage ?? "The request could not be completed.",
        code: error.code,
      },
      error.status,
    );
  }
  // Never reflect internal messages, paths, owner ids, or stack traces.
  console.error(
    "[shared-stories] unexpected failure",
    error instanceof Error ? error.name : "unknown",
  );
  return jsonResponse(
    {
      error: "Shared stories are temporarily unavailable.",
      code: "store_unavailable",
    },
    503,
  );
}

function invalid(message: string): SharedStoriesError {
  return new SharedStoriesError("invalid_request", 400, message);
}

function payloadTooLarge(): SharedStoriesError {
  return new SharedStoriesError("payload_too_large", 413, "Request body is too large.");
}

function normalizeHost(value: string): string {
  return value.trim().toLowerCase();
}

function isLoopbackHost(value: string): boolean {
  const host = value.trim().toLowerCase();
  let hostname: string;
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end === -1) return false;
    hostname = host.slice(1, end);
  } else {
    const colon = host.lastIndexOf(":");
    hostname = colon === -1 ? host : host.slice(0, colon);
  }
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function csrfRejected(): SharedStoriesError {
  return new SharedStoriesError("csrf_rejected", 400, "Cross-site request rejected.");
}

function originNotConfigured(): SharedStoriesError {
  return new SharedStoriesError(
    "origin_not_configured",
    503,
    "Shared story origin is not configured.",
  );
}

function originMisconfigured(): SharedStoriesError {
  return new SharedStoriesError(
    "origin_misconfigured",
    503,
    "Shared story origin configuration is invalid.",
  );
}

/**
 * Explicit `never` function declaration: TypeScript only narrows control flow
 * after calls to function declarations with an explicit `never` return type.
 * An arrow function stored in a const is not treated as a terminating call.
 */
function rejectCsrf(): never {
  throw csrfRejected();
}

function parseUrlOrRejectCsrf(value: string): URL {
  try {
    return new URL(value);
  } catch {
    rejectCsrf();
  }
}

function parseOriginHeader(value: string): URL {
  const origin = parseUrlOrRejectCsrf(value);
  if (origin.username || origin.password) rejectCsrf();
  if (origin.pathname !== "/" || origin.search || origin.hash) rejectCsrf();
  return origin;
}

const SHARED_ORIGIN_ENV = "AISTORY_SHARED_STORIES_ORIGIN";
const SHARED_INTERNAL_ORIGIN_ENV = "AISTORY_SHARED_STORIES_INTERNAL_ORIGIN";

type ConfiguredOrigin = { origin: string; host: string };

function isExactInternalHostname(hostname: string): boolean {
  // Node's URL exposes IPv6 hostnames with brackets; accept the unbracketed
  // canonical spelling too but never a normalized alias.
  return (
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

/**
 * Optional exact internal transport origin pin, default off.
 *
 * `next start -H 127.0.0.1 -p 4200` builds the App Route `Request.url` from the
 * listening socket rather than the public reverse-proxy Host. That pinned
 * transport origin can be recognized without trusting forwarded headers or
 * widening the public Origin/Host guards.
 *
 * When explicitly supplied the value must already be canonical: plain `http`
 * on exactly 127.0.0.1, localhost, or [::1], with no credentials, path, query,
 * fragment, trailing slash, uppercase spelling, or default-port/octal/integer/
 * shorthand normalization. The raw value must equal `parsed.origin`. An empty
 * value is invalid, not absent.
 */
function readInternalOrigin(): ConfiguredOrigin | null {
  const raw = process.env[SHARED_INTERNAL_ORIGIN_ENV];
  if (raw === undefined) return null;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw originMisconfigured();
  }
  if (parsed.protocol !== "http:") throw originMisconfigured();
  if (parsed.username || parsed.password) throw originMisconfigured();
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw originMisconfigured();
  }
  if (!isExactInternalHostname(parsed.hostname)) throw originMisconfigured();
  if (raw !== parsed.origin) throw originMisconfigured();
  return { origin: parsed.origin, host: parsed.host };
}

/**
 * The internal pin is meaningful only alongside a public HTTPS external origin.
 * A configured loopback HTTP origin is the local preview mode, and an HTTPS
 * loopback origin is still loopback, so neither may carry an internal pin.
 */
function isPublicHttpsOrigin(configured: ConfiguredOrigin): boolean {
  return configured.origin.startsWith("https://") && !isLoopbackHost(configured.host);
}

/**
 * Production pins mutations to one exact canonical origin. HTTPS is required
 * for every non-loopback host. Plain HTTP is permitted only for a strictly
 * loopback configured host (127.0.0.1, localhost, or [::1]); that exception
 * lets the local packaged Nextstart artifact run with NODE_ENV=production while
 * still requiring exact Host, request-URL host, and Origin matches below.
 *
 * The stored value must already be canonical: no path, query, fragment,
 * credentials, trailing slash, default port, or case spelling drift. Only
 * `parsed.origin` is normalized, and the original value must equal it.
 */
function readConfiguredOrigin(): ConfiguredOrigin | null {
  const raw = process.env[SHARED_ORIGIN_ENV];
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw originMisconfigured();
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw originMisconfigured();
  }
  if (parsed.protocol === "http:" && !isLoopbackHost(parsed.host)) {
    throw originMisconfigured();
  }
  if (parsed.username || parsed.password) throw originMisconfigured();
  if (parsed.search || parsed.hash) throw originMisconfigured();
  if (trimmed !== parsed.origin) throw originMisconfigured();
  return { origin: parsed.origin, host: parsed.host };
}

/**
 * Strict same-origin check for POST/PATCH.
 *
 * Pinned production mode (AISTORY_SHARED_STORIES_ORIGIN):
 * - requires Origin, and it must exactly equal the configured canonical origin,
 * - requires the Host header to equal the configured origin host,
 * - requires the request URL either to have the configured origin host, or (only
 *   when AISTORY_SHARED_STORIES_INTERNAL_ORIGIN is configured) to have an exact
 *   origin equal to that internal transport pin,
 * - allows an http configured origin only when it is loopback-only; non-loopback
 *   configured origins must be HTTPS,
 * - rejects embedded credentials, non-/ paths, queries, fragments,
 *   Sec-Fetch-Site: cross-site, and malformed configuration.
 *
 * The internal pin never relaxes Origin or Host and is accepted only alongside
 * a configured public HTTPS (non-loopback) external origin. It is default off,
 * so an absent pin preserves the previous strict request-URL host rule.
 *
 * Local preview mode (no configuration, non-production only):
 * - requires an actual plain-HTTP loopback request URL whose origin matches
 *   Origin and whose Host matches the request URL host.
 *
 * Production with a missing configuration fails closed. Forwarded headers are
 * intentionally never consulted.
 */
export function assertSameOriginMutation(request: Request): void {
  const originHeader = request.headers.get("origin");
  if (!originHeader) throw csrfRejected();

  const requestUrl = parseUrlOrRejectCsrf(request.url);
  if (requestUrl.username || requestUrl.password) throw csrfRejected();

  const origin = parseOriginHeader(originHeader);

  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite.trim().toLowerCase() === "cross-site") throw csrfRejected();

  const configured = readConfiguredOrigin();
  const internal = readInternalOrigin();

  if (internal && (!configured || !isPublicHttpsOrigin(configured))) {
    // A pin supplied in local-preview, missing-external, or loopback-external
    // mode is incompatible configuration: fail closed rather than falling back.
    throw originMisconfigured();
  }

  if (configured) {
    if (originHeader !== configured.origin) throw csrfRejected();
    if (origin.origin !== configured.origin) throw csrfRejected();
    if (requestUrl.protocol !== "http:" && requestUrl.protocol !== "https:") {
      throw csrfRejected();
    }

    const pinnedHostHeader = request.headers.get("host");
    if (!pinnedHostHeader) throw csrfRejected();
    if (normalizeHost(pinnedHostHeader) !== configured.host) throw csrfRejected();

    const requestUrlMatchesExternalHost =
      normalizeHost(requestUrl.host) === configured.host;
    const requestUrlMatchesInternalPin =
      internal !== null && requestUrl.origin === internal.origin;
    if (!requestUrlMatchesExternalHost && !requestUrlMatchesInternalPin) {
      throw csrfRejected();
    }
    return;
  }

  if (process.env.NODE_ENV === "production") throw originNotConfigured();

  const hostHeader = request.headers.get("host");
  if (!hostHeader) throw csrfRejected();
  if (normalizeHost(hostHeader) !== normalizeHost(requestUrl.host)) throw csrfRejected();
  if (normalizeHost(hostHeader) !== normalizeHost(origin.host)) throw csrfRejected();

  if (origin.origin !== requestUrl.origin) throw csrfRejected();
  if (requestUrl.protocol !== "http:") throw csrfRejected();
  if (!isLoopbackHost(requestUrl.host)) throw csrfRejected();
}

async function readJsonBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type");
  const mediaType = contentType?.split(";")[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new SharedStoriesError(
      "invalid_content_type",
      400,
      "Content-Type must be application/json.",
    );
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const trimmed = contentLength.trim();
    if (!/^\d+$/.test(trimmed)) throw invalid("Invalid Content-Length.");
    if (Number(trimmed) > MAX_REQUEST_BYTES) throw payloadTooLarge();
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
      if (total > MAX_REQUEST_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw payloadTooLarge();
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof SharedStoriesError) throw error;
    throw invalid("Request body could not be read.");
  }

  const bytes = Buffer.concat(chunks);
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

function service(): SharedStoriesService {
  return createSharedStoriesServiceFromEnv();
}

export function isMineListRequest(request: Request): boolean {
  try {
    return new URL(request.url).searchParams.get("mine") === "1";
  } catch {
    return false;
  }
}

type ParsedListQuery = {
  mine: boolean;
  limit?: number;
  cursor: string | null;
};

function parseListQuery(request: Request): ParsedListQuery {
  const url = new URL(request.url);
  const params = url.searchParams;
  for (const key of params.keys()) {
    if (key !== "mine" && key !== "limit" && key !== "cursor") {
      throw invalid("Unknown query parameter.");
    }
  }
  for (const key of ["mine", "limit", "cursor"] as const) {
    if (params.getAll(key).length > 1) throw invalid("Duplicate query parameter.");
  }

  const mineRaw = params.get("mine");
  if (mineRaw !== null && mineRaw !== "0" && mineRaw !== "1") {
    throw invalid("mine must be 0 or 1.");
  }

  const limitRaw = params.get("limit");
  let limit: number | undefined;
  if (limitRaw !== null) {
    if (!/^\d{1,3}$/.test(limitRaw)) throw invalid("limit must be an integer.");
    limit = Number(limitRaw);
    if (limit < 1 || limit > 50) throw invalid("limit must be between 1 and 50.");
  }

  const cursorRaw = params.get("cursor");
  let cursor: string | null = null;
  if (cursorRaw !== null) {
    if (cursorRaw.length === 0 || cursorRaw.length > 512) {
      throw invalid("Invalid list cursor.");
    }
    cursor = cursorRaw;
  }

  return { mine: mineRaw === "1", limit, cursor };
}

export async function handleCreateSharedStory(
  request: Request,
  owner: SharedOwner,
): Promise<Response> {
  try {
    assertSameOriginMutation(request);
    const body = await readJsonBody(request);
    const result = await service().createStory(owner, body);
    return jsonResponse(result.story, result.created ? 201 : 200);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handlePatchSharedStory(
  request: Request,
  id: string,
  owner: SharedOwner,
): Promise<Response> {
  try {
    assertSameOriginMutation(request);
    const body = await readJsonBody(request);
    const story = await service().updateVisibility(owner, id, body);
    return jsonResponse(story);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleGetSharedStory(
  _request: Request,
  id: string,
): Promise<Response> {
  try {
    const story = await service().getPublicStory(id);
    if (!story) {
      return jsonResponse(
        { error: "Shared story not found.", code: "not_found" },
        404,
      );
    }
    return jsonResponse(story);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleListSharedStories(
  request: Request,
  owner: SharedOwner | null,
): Promise<Response> {
  try {
    const query = parseListQuery(request);
    if (query.mine && !owner) {
      throw new SharedStoriesError("unauthorized", 401, "Login required.");
    }
    const sharedStories = service();
    const page = query.mine
      ? await sharedStories.listMine(owner!, {
          ...(query.limit === undefined ? {} : { limit: query.limit }),
          cursor: query.cursor,
        })
      : await sharedStories.listPublic({
          ...(query.limit === undefined ? {} : { limit: query.limit }),
          cursor: query.cursor,
        });
    return jsonResponse(page);
  } catch (error) {
    return errorResponse(error);
  }
}
