import { randomBytes as nodeRandomBytes } from "node:crypto";
import {
  LINGHAO_PASSPORT_V4_AUTHENTICATED_REDIRECT,
  LINGHAO_PASSPORT_V4_CALLBACK_PATH,
  LINGHAO_PASSPORT_V4_COOKIE_PATH,
  LINGHAO_PASSPORT_V4_DRAFT_MAX_BYTES,
  LINGHAO_PASSPORT_V4_FAMILY_COOKIE,
  LINGHAO_PASSPORT_V4_HOST,
  LINGHAO_PASSPORT_V4_INBOUND_BODY_TIMEOUT_MS,
  LINGHAO_PASSPORT_V4_LOGOUT_COOKIE,
  LINGHAO_PASSPORT_V4_LOGOUT_TTL_SECONDS,
  LINGHAO_PASSPORT_V4_MAX_FAMILIES,
  LINGHAO_PASSPORT_V4_MAX_LOGOUT_RESULTS,
  LINGHAO_PASSPORT_V4_MAX_PROFILES,
  LINGHAO_PASSPORT_V4_MAX_RATE_BUCKETS,
  LINGHAO_PASSPORT_V4_MAX_REFRESH_FLIGHTS,
  LINGHAO_PASSPORT_V4_MAX_SESSIONS,
  LINGHAO_PASSPORT_V4_MAX_TRANSACTIONS,
  LINGHAO_PASSPORT_V4_POST_LOGOUT_REDIRECT_URI,
  LINGHAO_PASSPORT_V4_PUBLIC_ORIGIN,
  LINGHAO_PASSPORT_V4_SESSION_ABSOLUTE_MS,
  LINGHAO_PASSPORT_V4_SESSION_COOKIE,
  LINGHAO_PASSPORT_V4_SESSION_IDLE_MS,
  LINGHAO_PASSPORT_V4_START_RATE_MAX,
  LINGHAO_PASSPORT_V4_START_RATE_WINDOW_MS,
  LINGHAO_PASSPORT_V4_TRANSACTION_COOKIE,
  LINGHAO_PASSPORT_V4_TRANSACTION_TTL_SECONDS,
  linghaoPassportV4LocalModeRequested,
  loadLinghaoPassportV4Config,
  type LinghaoPassportV4EnabledConfig,
  type LinghaoPassportV4Environment,
} from "./linghaoPassportV4Config";
import {
  createLinghaoPassportV4AuthorizationSecrets,
  LinghaoPassportV4OidcClient,
  type LinghaoPassportV4AuthenticationResult,
  type LinghaoPassportV4Fetch,
  type LinghaoPassportV4RandomBytes,
} from "./linghaoPassportV4Oidc";
import {
  clearPassportCookie,
  isPassportOpaqueIdentifier,
  LinghaoPassportV4FamilyStore,
  LinghaoPassportV4LogoutStateStore,
  LinghaoPassportV4ProfileStore,
  LinghaoPassportV4SessionStore,
  LinghaoPassportV4StartRateLimiter,
  LinghaoPassportV4TransactionStore,
  linghaoPassportV4SafeSession,
  readSinglePassportCookie,
  serializePassportCookie,
  type LinghaoPassportV4LogoutResult,
  type LinghaoPassportV4Session,
  type SingleCookieResult,
} from "./linghaoPassportV4Session";
import type { LinghaoPassportV4SecretReader } from "./linghaoPassportV4SecretFile";

export type LinghaoPassportV4Action =
  | "capabilities"
  | "start"
  | "callback"
  | "session"
  | "renew"
  | "draft"
  | "logout"
  | "logged-out";

export interface LinghaoPassportV4ServerOptions {
  readonly env?: LinghaoPassportV4Environment;
  readonly fetch?: LinghaoPassportV4Fetch;
  readonly now?: () => number;
  readonly randomBytes?: LinghaoPassportV4RandomBytes;
  readonly sessions?: LinghaoPassportV4SessionStore;
  readonly transactions?: LinghaoPassportV4TransactionStore;
  readonly families?: LinghaoPassportV4FamilyStore;
  readonly profiles?: LinghaoPassportV4ProfileStore;
  readonly logoutStates?: LinghaoPassportV4LogoutStateStore;
  readonly startRateLimiter?: LinghaoPassportV4StartRateLimiter;
  readonly readSecretFile?: LinghaoPassportV4SecretReader;
  readonly platform?: NodeJS.Platform;
  readonly bodyTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly maxRefreshFlights?: number;
}

interface RefreshOutcome {
  readonly status:
    | "not-needed"
    | "refreshed"
    | "failed"
    | "unavailable"
    | "discarded";
  /**
   * False means a replacement refresh token may have been minted without a
   * confirmed revocation. Logout must then report revocation unconfirmed.
   */
  readonly cleanupConfirmed?: boolean;
}

const ACTION_PATHS: Record<LinghaoPassportV4Action, string> = {
  capabilities: "/api/auth/linghao-passport-v4/capabilities",
  start: "/api/auth/linghao-passport-v4/start",
  callback: LINGHAO_PASSPORT_V4_CALLBACK_PATH,
  session: "/api/auth/linghao-passport-v4/session",
  renew: "/api/auth/linghao-passport-v4/renew",
  draft: "/api/auth/linghao-passport-v4/draft",
  logout: "/api/auth/linghao-passport-v4/logout",
  "logged-out": "/api/auth/linghao-passport-v4/logged-out",
};

// Next 16.2.7 normalizes a route-handler Request URL from 127.0.0.1 to
// localhost even though the external Host header remains exact. This internal
// spelling is accepted only after the Host header is pinned to 127.0.0.1:4200.
const NEXT_INTERNAL_LOOPBACK_ORIGIN = "http://localhost:4200";

const CALLBACK_QUERY_KEYS = new Set([
  "code",
  "state",
  "iss",
  "error",
  "error_description",
  "error_uri",
  "error_hint",
]);
const JSON_MEDIA_TYPE = "application/json";
const OPAQUE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * A collision-resistant, AIstory-specific global registry symbol. Next.js
 * compiles Route Handlers into independent chunks; a module-local singleton
 * would give each chunk a different server and store.
 */
export const LINGHAO_PASSPORT_V4_SERVER_REGISTRY_SYMBOL = Symbol.for(
  "aistory.linghao-passport-v4.server-registry.v1",
);
export const LINGHAO_PASSPORT_V4_SERVER_REGISTRY_VERSION = 1;

interface LinghaoPassportV4ServerRegistry {
  readonly version: 1;
  readonly key: "aistory.linghao-passport-v4.server-registry.v1";
  readonly server: LinghaoPassportV4Server;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function securityHeaders(): Headers {
  return new Headers({
    "Cache-Control": "no-store, max-age=0",
    Pragma: "no-cache",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Content-Security-Policy":
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  });
}

function appendCookies(headers: Headers, cookies: readonly string[]): void {
  for (const cookie of cookies) {
    headers.append("Set-Cookie", cookie);
  }
}

function jsonResponse(
  body: unknown,
  status: number,
  options?: {
    readonly cookies?: readonly string[];
    readonly varyCookie?: boolean;
    readonly headers?: Record<string, string>;
  },
): Response {
  const headers = securityHeaders();
  headers.set("Content-Type", `${JSON_MEDIA_TYPE}; charset=utf-8`);
  if (options?.varyCookie) headers.set("Vary", "Cookie");
  for (const [name, value] of Object.entries(options?.headers ?? {})) {
    headers.set(name, value);
  }
  appendCookies(headers, options?.cookies ?? []);
  return new Response(JSON.stringify(body), { status, headers });
}

function emptyRedirectResponse(
  location: string,
  cookies: readonly string[],
): Response {
  const headers = securityHeaders();
  headers.set("Location", location);
  headers.set("Content-Length", "0");
  appendCookies(headers, cookies);
  return new Response(null, { status: 303, headers });
}

function unavailableResponse(): Response {
  return jsonResponse({ error: "unavailable" }, 404);
}

function capacityResponse(cookies: readonly string[] = []): Response {
  return jsonResponse({ error: "capacity_unavailable" }, 503, { cookies });
}

function rateLimitedResponse(): Response {
  return jsonResponse({ error: "rate_limited" }, 429);
}

function invalidResponse(cookies: readonly string[] = []): Response {
  return jsonResponse({ error: "invalid_request" }, 400, { cookies });
}

function unauthenticatedResponse(cookies: readonly string[] = []): Response {
  return jsonResponse({ authenticated: false }, 401, {
    cookies,
    varyCookie: true,
  });
}

function methodNotAllowed(allow: string): Response {
  return jsonResponse({ error: "method_not_allowed" }, 405, {
    headers: { Allow: allow },
  });
}

function isJsonContentType(request: Request): boolean {
  const contentType = request.headers.get("content-type") ?? "";
  return contentType.split(";", 1)[0]?.trim().toLowerCase() === JSON_MEDIA_TYPE;
}

function isSameOriginPost(request: Request): boolean {
  if (request.headers.get("origin") !== LINGHAO_PASSPORT_V4_PUBLIC_ORIGIN) {
    return false;
  }
  const fetchSite = request.headers.get("sec-fetch-site");
  return fetchSite === null || fetchSite === "same-origin";
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Rejects every transfer/framing ambiguity, enforces the byte cap from both the
 * declared and actual body, holds the declared length to the actual byte count,
 * and races every stream read against a wall-clock deadline.
 */
async function readBoundedRequestBody(
  request: Request,
  maximumBytes: number,
  timeoutMs: number,
): Promise<Uint8Array | null> {
  if (request.headers.get("transfer-encoding") !== null) return null;

  let declaredLength: number | null = null;
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^(?:0|[1-9]\d*)$/.test(declared)) return null;
    declaredLength = Number(declared);
    if (
      !Number.isSafeInteger(declaredLength) ||
      declaredLength > maximumBytes
    ) {
      return null;
    }
  }

  if (!request.body) {
    if (declaredLength !== null && declaredLength !== 0) return null;
    return new Uint8Array();
  }

  let rejectDeadline!: (error: Error) => void;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const timer = setTimeout(() => {
    rejectDeadline(new Error("request body deadline exceeded"));
  }, timeoutMs);
  const raceDeadline = <T>(operation: Promise<T>): Promise<T> =>
    Promise.race([operation, deadline]);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let completed = false;
  try {
    for (;;) {
      const next = await raceDeadline(reader.read());
      if (next.done) {
        completed = true;
        break;
      }
      total += next.value.byteLength;
      if (total > maximumBytes) return null;
      chunks.push(next.value);
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    if (!completed) {
      try {
        void reader.cancel().catch(() => undefined);
      } catch {
        // The deadline or a peer failure already settled the body.
      }
    }
    try {
      reader.releaseLock();
    } catch {
      // A partially cancelled stream may keep the lock until its rejection.
    }
  }

  if (declaredLength !== null && total !== declaredLength) return null;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseExactJsonObject(
  bytes: Uint8Array,
  allowedKeys: readonly string[],
): Record<string, unknown> | null {
  const text = decodeUtf8(bytes);
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const keys = Object.keys(parsed);
  if (keys.length !== allowedKeys.length) return null;
  if (!allowedKeys.every((key) => Object.prototype.hasOwnProperty.call(parsed, key))) {
    return null;
  }
  return parsed;
}

function parseExactDraftBody(
  bytes: Uint8Array,
): { readonly text: string } | null {
  const parsed = parseExactJsonObject(bytes, ["text"]);
  if (!parsed || typeof parsed.text !== "string") return null;
  if (
    Buffer.byteLength(parsed.text, "utf8") >
    LINGHAO_PASSPORT_V4_DRAFT_MAX_BYTES
  ) {
    return null;
  }
  return { text: parsed.text };
}

function readSingleQuery(
  url: URL,
  key: string,
):
  | { readonly present: false }
  | { readonly present: true; readonly value: string }
  | { readonly present: "duplicate" } {
  const values = url.searchParams.getAll(key);
  if (values.length === 0) return { present: false };
  if (values.length > 1) return { present: "duplicate" };
  return { present: true, value: values[0]! };
}

function readCallbackQuery(url: URL): Map<string, string> | null {
  const result = new Map<string, string>();
  let totalLength = 0;
  for (const [key, value] of url.searchParams) {
    if (!CALLBACK_QUERY_KEYS.has(key) || result.has(key)) return null;
    totalLength += key.length + value.length;
    if (value.length > 4096 || totalLength > 16_384) return null;
    result.set(key, value);
  }
  if (!result.has("state")) return null;
  return result;
}

function readLoggedOutQuery(url: URL): string | null {
  const keys = [...url.searchParams.keys()];
  if (keys.length !== 1 || keys[0] !== "state") return null;
  const state = readSingleQuery(url, "state");
  if (state.present !== true || !isPassportOpaqueIdentifier(state.value)) {
    return null;
  }
  return state.value;
}

function cookieValue(
  cookieHeader: string | undefined,
  name: string,
): { readonly valid: boolean; readonly value?: string } {
  const cookie: SingleCookieResult = readSinglePassportCookie(
    cookieHeader,
    name,
  );
  if (cookie.present === true) {
    return isPassportOpaqueIdentifier(cookie.value)
      ? { valid: true, value: cookie.value }
      : { valid: false };
  }
  return { valid: cookie.present === false };
}

export class LinghaoPassportV4Server {
  private readonly env: LinghaoPassportV4Environment;
  private readonly fetchImpl: LinghaoPassportV4Fetch;
  private readonly now: () => number;
  private readonly randomBytes: LinghaoPassportV4RandomBytes;
  private readonly readSecretFile: LinghaoPassportV4SecretReader | undefined;
  private readonly platform: NodeJS.Platform;
  private readonly bodyTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly maxRefreshFlights: number;
  private readonly refreshInFlight = new Map<string, Promise<RefreshOutcome>>();
  private oidcClient: LinghaoPassportV4OidcClient | null = null;
  private activeSecret: string | null = null;

  readonly sessions: LinghaoPassportV4SessionStore;
  readonly transactions: LinghaoPassportV4TransactionStore;
  readonly families: LinghaoPassportV4FamilyStore;
  readonly profiles: LinghaoPassportV4ProfileStore;
  readonly logoutStates: LinghaoPassportV4LogoutStateStore;
  readonly startRateLimiter: LinghaoPassportV4StartRateLimiter;

  constructor(options: LinghaoPassportV4ServerOptions = {}) {
    this.env = options.env ?? process.env;
    this.fetchImpl =
      options.fetch ??
      ((input, init) => globalThis.fetch(input, init));
    this.now = options.now ?? Date.now;
    this.randomBytes =
      options.randomBytes ??
      ((size) => new Uint8Array(nodeRandomBytes(size)));
    this.readSecretFile = options.readSecretFile;
    this.platform = options.platform ?? process.platform;
    this.bodyTimeoutMs =
      options.bodyTimeoutMs ?? LINGHAO_PASSPORT_V4_INBOUND_BODY_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.maxRefreshFlights =
      options.maxRefreshFlights ?? LINGHAO_PASSPORT_V4_MAX_REFRESH_FLIGHTS;
    if (
      !Number.isSafeInteger(this.bodyTimeoutMs) ||
      this.bodyTimeoutMs < 10 ||
      this.bodyTimeoutMs > 60_000 ||
      !Number.isSafeInteger(this.requestTimeoutMs) ||
      this.requestTimeoutMs < 50 ||
      this.requestTimeoutMs > 30_000 ||
      !Number.isSafeInteger(this.maxRefreshFlights) ||
      this.maxRefreshFlights < 1 ||
      this.maxRefreshFlights > 1024
    ) {
      throw new Error("Passport server bounds are invalid");
    }
    this.sessions =
      options.sessions ??
      new LinghaoPassportV4SessionStore({
        idleMs: LINGHAO_PASSPORT_V4_SESSION_IDLE_MS,
        absoluteMs: LINGHAO_PASSPORT_V4_SESSION_ABSOLUTE_MS,
        maxSessions: LINGHAO_PASSPORT_V4_MAX_SESSIONS,
        now: this.now,
        randomBytes: this.randomBytes,
      });
    this.transactions =
      options.transactions ??
      new LinghaoPassportV4TransactionStore({
        ttlMs: LINGHAO_PASSPORT_V4_TRANSACTION_TTL_SECONDS * 1000,
        maxTransactions: LINGHAO_PASSPORT_V4_MAX_TRANSACTIONS,
        now: this.now,
        randomBytes: this.randomBytes,
      });
    this.families =
      options.families ??
      new LinghaoPassportV4FamilyStore({
        ttlMs: LINGHAO_PASSPORT_V4_SESSION_ABSOLUTE_MS,
        maxFamilies: LINGHAO_PASSPORT_V4_MAX_FAMILIES,
        now: this.now,
      });
    this.profiles =
      options.profiles ??
      new LinghaoPassportV4ProfileStore({
        now: this.now,
        maxProfiles: LINGHAO_PASSPORT_V4_MAX_PROFILES,
      });
    this.logoutStates =
      options.logoutStates ??
      new LinghaoPassportV4LogoutStateStore({
        ttlMs: LINGHAO_PASSPORT_V4_LOGOUT_TTL_SECONDS * 1000,
        maxResults: LINGHAO_PASSPORT_V4_MAX_LOGOUT_RESULTS,
        now: this.now,
        randomBytes: this.randomBytes,
      });
    this.startRateLimiter =
      options.startRateLimiter ??
      new LinghaoPassportV4StartRateLimiter({
        windowMs: LINGHAO_PASSPORT_V4_START_RATE_WINDOW_MS,
        maximum: LINGHAO_PASSPORT_V4_START_RATE_MAX,
        maxBuckets: LINGHAO_PASSPORT_V4_MAX_RATE_BUCKETS,
        now: this.now,
      });
  }

  async handle(
    action: LinghaoPassportV4Action,
    request: Request,
  ): Promise<Response> {
    if (action === "capabilities") {
      return this.handleCapabilities(request);
    }

    if (!linghaoPassportV4LocalModeRequested(this.env, this.platform)) {
      return unavailableResponse();
    }
    const config = this.loadConfig();
    if (!config) {
      return unavailableResponse();
    }

    switch (action) {
      case "start":
        return this.handleStart(request, config);
      case "callback":
        return this.handleCallback(request, config);
      case "session":
        return this.handleSession(request, config);
      case "renew":
        return this.handleRenew(request, config);
      case "draft":
        return this.handleDraft(request, config);
      case "logout":
        return this.handleLogout(request, config);
      case "logged-out":
        return this.handleLoggedOut(request);
    }
  }

  private loadConfig(): LinghaoPassportV4EnabledConfig | null {
    return loadLinghaoPassportV4Config(this.env, {
      platform: this.platform,
      ...(this.readSecretFile === undefined
        ? {}
        : { readSecretFile: this.readSecretFile }),
    });
  }

  private handleCapabilities(request: Request): Response {
    if (!this.isLocalRequest(request, ACTION_PATHS.capabilities)) {
      return unavailableResponse();
    }
    if (request.method !== "GET") {
      return methodNotAllowed("GET");
    }
    if (new URL(request.url).search !== "") {
      return invalidResponse();
    }
    if (!linghaoPassportV4LocalModeRequested(this.env, this.platform)) {
      return jsonResponse({ enabled: false }, 200);
    }
    const config = this.loadConfig();
    return jsonResponse({ enabled: config !== null }, 200);
  }

  private async handleStart(
    request: Request,
    config: LinghaoPassportV4EnabledConfig,
  ): Promise<Response> {
    if (!this.isLocalRequest(request, ACTION_PATHS.start)) {
      return unavailableResponse();
    }
    if (request.method !== "POST") return methodNotAllowed("POST");
    if (
      new URL(request.url).search !== "" ||
      !isSameOriginPost(request) ||
      !isJsonContentType(request)
    ) {
      return invalidResponse();
    }

    const body = await readBoundedRequestBody(
      request,
      1024,
      this.bodyTimeoutMs,
    );
    if (body === null || parseExactJsonObject(body, []) === null) {
      return invalidResponse();
    }

    const cookieHeader = request.headers.get("cookie") ?? undefined;
    const familyCookie = cookieValue(
      cookieHeader,
      LINGHAO_PASSPORT_V4_FAMILY_COOKIE,
    );
    const existingFamily =
      familyCookie.valid && familyCookie.value !== undefined
        ? familyCookie.value
        : null;
    const rateKey =
      existingFamily !== null && this.families.has(existingFamily)
        ? `family:${existingFamily}`
        : "anonymous";
    if (!this.startRateLimiter.take(rateKey)) return rateLimitedResponse();

    let familyId = existingFamily;
    let createdFamily = false;
    if (familyId === null || !this.families.has(familyId)) {
      familyId = this.newOpaqueIdentifier();
      if (!this.families.reserve(familyId)) return rateLimitedResponse();
      createdFamily = true;
    }

    // A replaced transaction cookie must not leave the old pending binding
    // unreachable and accumulating in the bounded store.
    const existingTransaction = cookieValue(
      cookieHeader,
      LINGHAO_PASSPORT_V4_TRANSACTION_COOKIE,
    );
    if (existingTransaction.valid && existingTransaction.value !== undefined) {
      this.transactions.remove(existingTransaction.value);
    }

    const secrets =
      createLinghaoPassportV4AuthorizationSecrets(this.randomBytes);
    const transaction = this.transactions.create({
      state: secrets.state,
      nonce: secrets.nonce,
      codeVerifier: secrets.codeVerifier,
    });
    if (!transaction) {
      if (createdFamily) this.families.remove(familyId);
      return capacityResponse();
    }

    let authorizationUrl: string;
    try {
      authorizationUrl = await this.oidc(config).createAuthorizationUrl(
        secrets,
      );
    } catch {
      this.transactions.remove(transaction.id);
      if (createdFamily) this.families.remove(familyId);
      return unavailableResponse();
    }

    const cookies = [
      serializePassportCookie(
        LINGHAO_PASSPORT_V4_TRANSACTION_COOKIE,
        transaction.id,
        {
          path: LINGHAO_PASSPORT_V4_COOKIE_PATH,
          maxAgeSeconds: LINGHAO_PASSPORT_V4_TRANSACTION_TTL_SECONDS,
        },
      ),
      serializePassportCookie(
        LINGHAO_PASSPORT_V4_FAMILY_COOKIE,
        familyId,
        {
          path: LINGHAO_PASSPORT_V4_COOKIE_PATH,
          maxAgeSeconds: Math.floor(
            LINGHAO_PASSPORT_V4_SESSION_ABSOLUTE_MS / 1000,
          ),
        },
      ),
    ];
    return jsonResponse(
      { authorizationUrl },
      200,
      { cookies, varyCookie: true },
    );
  }

  private async handleCallback(
    request: Request,
    config: LinghaoPassportV4EnabledConfig,
  ): Promise<Response> {
    if (
      !this.isLocalRequest(request, LINGHAO_PASSPORT_V4_CALLBACK_PATH)
    ) {
      return unavailableResponse();
    }
    if (request.method !== "GET") {
      return methodNotAllowed("GET");
    }

    const clearTransaction = clearPassportCookie(
      LINGHAO_PASSPORT_V4_TRANSACTION_COOKIE,
      LINGHAO_PASSPORT_V4_COOKIE_PATH,
    );
    const clearFamily = clearPassportCookie(
      LINGHAO_PASSPORT_V4_FAMILY_COOKIE,
      LINGHAO_PASSPORT_V4_COOKIE_PATH,
    );
    const cookieHeader = request.headers.get("cookie") ?? undefined;
    const transactionCookie = cookieValue(
      cookieHeader,
      LINGHAO_PASSPORT_V4_TRANSACTION_COOKIE,
    );
    const url = new URL(request.url);
    const query = readCallbackQuery(url);
    if (!query) {
      if (transactionCookie.value !== undefined) {
        this.transactions.remove(transactionCookie.value);
      }
      return invalidResponse([clearTransaction]);
    }
    if (!transactionCookie.valid || transactionCookie.value === undefined) {
      return invalidResponse([clearTransaction]);
    }
    const familyCookie = cookieValue(
      cookieHeader,
      LINGHAO_PASSPORT_V4_FAMILY_COOKIE,
    );
    if (
      !familyCookie.valid ||
      familyCookie.value === undefined ||
      !this.families.has(familyCookie.value)
    ) {
      this.transactions.remove(transactionCookie.value);
      return invalidResponse([clearTransaction, clearFamily]);
    }

    // Consumption is deliberately before iss/error checks, code handling,
    // discovery, token exchange, and any JWKS fetch. A replay gets nothing.
    const consumed = this.transactions.consume(
      transactionCookie.value,
      query.get("state"),
    );
    if (!consumed.ok) {
      return invalidResponse([clearTransaction]);
    }

    if (query.has("error")) {
      return invalidResponse([clearTransaction]);
    }

    const responseIssuer = query.get("iss");
    if (responseIssuer !== undefined && responseIssuer !== config.issuer) {
      return invalidResponse([clearTransaction]);
    }

    const code = query.get("code");
    if (
      typeof code !== "string" ||
      code.length === 0 ||
      code.length > 4096 ||
      /[\u0000-\u001f\u007f]/.test(code)
    ) {
      return invalidResponse([clearTransaction]);
    }

    let authentication: LinghaoPassportV4AuthenticationResult;
    try {
      authentication = await this.oidc(config).exchangeAuthorizationCode(
        code,
        {
          state: consumed.transaction.state,
          nonce: consumed.transaction.nonce,
          codeVerifier: consumed.transaction.codeVerifier,
        },
      );
    } catch {
      return invalidResponse([clearTransaction]);
    }

    const profile = this.profiles.getOrCreate(
      authentication.identity.issuer,
      authentication.identity.subject,
    );
    if (!profile) return capacityResponse([clearTransaction]);

    const existingSession = cookieValue(
      cookieHeader,
      LINGHAO_PASSPORT_V4_SESSION_COOKIE,
    );
    const previousFamilySession = this.families.getSessionId(
      familyCookie.value,
    );
    const priorSessionId =
      existingSession.valid && existingSession.value !== undefined
        ? existingSession.value
        : undefined;
    if (
      previousFamilySession !== null &&
      previousFamilySession !== priorSessionId
    ) {
      this.sessions.destroy(previousFamilySession);
    }

    const session = this.sessions.createAuthenticated(priorSessionId, {
      profileId: profile.profileId,
      identity: authentication.identity,
      idToken: authentication.tokens.idToken,
      accessToken: authentication.tokens.accessToken,
      refreshToken: authentication.tokens.refreshToken,
      accessTokenExpiresAt:
        this.now() + authentication.tokens.expiresIn * 1000,
    });
    if (!session) return capacityResponse([clearTransaction]);
    if (!this.families.bind(familyCookie.value, session.id)) {
      this.sessions.destroy(session.id);
      return capacityResponse([clearTransaction, clearFamily]);
    }

    const sessionCookie = serializePassportCookie(
      LINGHAO_PASSPORT_V4_SESSION_COOKIE,
      session.id,
      {
        path: LINGHAO_PASSPORT_V4_COOKIE_PATH,
        maxAgeSeconds: Math.floor(
          LINGHAO_PASSPORT_V4_SESSION_ABSOLUTE_MS / 1000,
        ),
      },
    );
    return emptyRedirectResponse(
      LINGHAO_PASSPORT_V4_AUTHENTICATED_REDIRECT,
      [sessionCookie, clearTransaction],
    );
  }

  private async handleSession(
    request: Request,
    config: LinghaoPassportV4EnabledConfig,
  ): Promise<Response> {
    if (!this.isLocalRequest(request, ACTION_PATHS.session)) {
      return unavailableResponse();
    }
    if (request.method !== "GET") return methodNotAllowed("GET");
    if (new URL(request.url).search !== "") return invalidResponse();

    const clearSession = clearPassportCookie(
      LINGHAO_PASSPORT_V4_SESSION_COOKIE,
      LINGHAO_PASSPORT_V4_COOKIE_PATH,
    );
    const sessionCookie = cookieValue(
      request.headers.get("cookie") ?? undefined,
      LINGHAO_PASSPORT_V4_SESSION_COOKIE,
    );
    if (!sessionCookie.valid || sessionCookie.value === undefined) {
      return jsonResponse({ authenticated: false }, 200, {
        ...(sessionCookie.valid ? {} : { cookies: [clearSession] }),
        varyCookie: true,
      });
    }

    let session = this.sessions.get(sessionCookie.value);
    if (!session) {
      return jsonResponse({ authenticated: false }, 200, {
        cookies: [clearSession],
        varyCookie: true,
      });
    }

    const outcome = await this.ensureFresh(session, false, config);
    if (outcome.status === "failed" || outcome.status === "unavailable") {
      return jsonResponse({ authenticated: false }, 200, {
        cookies: [clearSession],
        varyCookie: true,
      });
    }
    session = this.sessions.get(sessionCookie.value);
    if (!session) {
      return jsonResponse({ authenticated: false }, 200, {
        cookies: [clearSession],
        varyCookie: true,
      });
    }

    const profile = this.profiles.get(session.profileId);
    if (!profile) {
      this.sessions.destroy(session.id);
      return jsonResponse({ authenticated: false }, 200, {
        cookies: [clearSession],
        varyCookie: true,
      });
    }

    return jsonResponse(
      linghaoPassportV4SafeSession(session, LINGHAO_PASSPORT_V4_SESSION_IDLE_MS),
      200,
      { varyCookie: true },
    );
  }

  private async handleRenew(
    request: Request,
    config: LinghaoPassportV4EnabledConfig,
  ): Promise<Response> {
    if (!this.isLocalRequest(request, ACTION_PATHS.renew)) {
      return unavailableResponse();
    }
    if (request.method !== "POST") return methodNotAllowed("POST");
    if (
      new URL(request.url).search !== "" ||
      !isSameOriginPost(request) ||
      !isJsonContentType(request)
    ) {
      return invalidResponse();
    }
    const body = await readBoundedRequestBody(
      request,
      1024,
      this.bodyTimeoutMs,
    );
    if (body === null || parseExactJsonObject(body, []) === null) {
      return invalidResponse();
    }

    const clearSession = clearPassportCookie(
      LINGHAO_PASSPORT_V4_SESSION_COOKIE,
      LINGHAO_PASSPORT_V4_COOKIE_PATH,
    );
    const sessionCookie = cookieValue(
      request.headers.get("cookie") ?? undefined,
      LINGHAO_PASSPORT_V4_SESSION_COOKIE,
    );
    if (!sessionCookie.valid || sessionCookie.value === undefined) {
      return unauthenticatedResponse(
        sessionCookie.valid ? [] : [clearSession],
      );
    }
    const initial = this.sessions.get(sessionCookie.value);
    if (!initial) {
      return unauthenticatedResponse([clearSession]);
    }
    if (initial.refreshToken === undefined) {
      this.sessions.destroy(initial.id);
      return unauthenticatedResponse([clearSession]);
    }

    const outcome = await this.ensureFresh(initial, true, config);
    if (outcome.status !== "refreshed") {
      this.sessions.destroy(initial.id);
      return unauthenticatedResponse([clearSession]);
    }
    const session = this.sessions.get(sessionCookie.value);
    if (!session) return unauthenticatedResponse([clearSession]);
    const profile = this.profiles.get(session.profileId);
    if (!profile) {
      this.sessions.destroy(session.id);
      return unauthenticatedResponse([clearSession]);
    }

    return jsonResponse(
      {
        ...linghaoPassportV4SafeSession(
          session,
          LINGHAO_PASSPORT_V4_SESSION_IDLE_MS,
        ),
        renewed: true,
      },
      200,
      { varyCookie: true },
    );
  }

  private async handleDraft(
    request: Request,
    config: LinghaoPassportV4EnabledConfig,
  ): Promise<Response> {
    if (!this.isLocalRequest(request, ACTION_PATHS.draft)) {
      return unavailableResponse();
    }
    if (request.method !== "GET" && request.method !== "PUT") {
      return methodNotAllowed("GET, PUT");
    }
    if (new URL(request.url).search !== "") return invalidResponse();
    if (request.method === "PUT" && !isSameOriginPost(request)) {
      return invalidResponse();
    }

    const clearSession = clearPassportCookie(
      LINGHAO_PASSPORT_V4_SESSION_COOKIE,
      LINGHAO_PASSPORT_V4_COOKIE_PATH,
    );
    const sessionCookie = cookieValue(
      request.headers.get("cookie") ?? undefined,
      LINGHAO_PASSPORT_V4_SESSION_COOKIE,
    );
    if (!sessionCookie.valid || sessionCookie.value === undefined) {
      return unauthenticatedResponse(
        sessionCookie.valid ? [] : [clearSession],
      );
    }
    const initial = this.sessions.get(sessionCookie.value);
    if (!initial) return unauthenticatedResponse([clearSession]);

    // Draft data follows exactly the same freshness path as /session. An
    // expired access/ID token whose refresh is rejected clears the session.
    const outcome = await this.ensureFresh(initial, false, config);
    if (outcome.status === "failed" || outcome.status === "unavailable") {
      this.sessions.destroy(initial.id);
      return unauthenticatedResponse([clearSession]);
    }
    const session = this.sessions.get(sessionCookie.value);
    if (!session) return unauthenticatedResponse([clearSession]);

    if (request.method === "GET") {
      const text = this.profiles.getDraft(session.profileId);
      if (text === null) return unauthenticatedResponse([clearSession]);
      return jsonResponse({ text }, 200, { varyCookie: true });
    }

    if (!isJsonContentType(request)) return invalidResponse();
    const body = await readBoundedRequestBody(
      request,
      8192,
      this.bodyTimeoutMs,
    );
    if (body === null) return invalidResponse();
    const draft = parseExactDraftBody(body);
    if (!draft) return invalidResponse();
    if (!this.profiles.setDraft(session.profileId, draft.text)) {
      return invalidResponse();
    }
    return jsonResponse({ text: draft.text }, 200, { varyCookie: true });
  }

  private async handleLogout(
    request: Request,
    config: LinghaoPassportV4EnabledConfig,
  ): Promise<Response> {
    if (!this.isLocalRequest(request, ACTION_PATHS.logout)) {
      return unavailableResponse();
    }
    if (request.method !== "POST") return methodNotAllowed("POST");
    if (
      new URL(request.url).search !== "" ||
      !isSameOriginPost(request)
    ) {
      return invalidResponse();
    }
    const body = await readBoundedRequestBody(
      request,
      1024,
      this.bodyTimeoutMs,
    );
    if (body === null || body.byteLength !== 0) return invalidResponse();

    const clearSession = clearPassportCookie(
      LINGHAO_PASSPORT_V4_SESSION_COOKIE,
      LINGHAO_PASSPORT_V4_COOKIE_PATH,
    );
    const clearLogout = clearPassportCookie(
      LINGHAO_PASSPORT_V4_LOGOUT_COOKIE,
      LINGHAO_PASSPORT_V4_COOKIE_PATH,
    );
    const clearTransaction = clearPassportCookie(
      LINGHAO_PASSPORT_V4_TRANSACTION_COOKIE,
      LINGHAO_PASSPORT_V4_COOKIE_PATH,
    );
    const clearFamily = clearPassportCookie(
      LINGHAO_PASSPORT_V4_FAMILY_COOKIE,
      LINGHAO_PASSPORT_V4_COOKIE_PATH,
    );
    const clearCookies = [
      clearSession,
      clearLogout,
      clearTransaction,
      clearFamily,
    ];
    const cookieHeader = request.headers.get("cookie") ?? undefined;
    const sessionCookie = cookieValue(
      cookieHeader,
      LINGHAO_PASSPORT_V4_SESSION_COOKIE,
    );
    const transactionCookie = cookieValue(
      cookieHeader,
      LINGHAO_PASSPORT_V4_TRANSACTION_COOKIE,
    );
    const familyCookie = cookieValue(
      cookieHeader,
      LINGHAO_PASSPORT_V4_FAMILY_COOKIE,
    );

    if (transactionCookie.value !== undefined) {
      this.transactions.remove(transactionCookie.value);
    }
    const familySessionId =
      familyCookie.valid && familyCookie.value !== undefined
        ? this.families.getSessionId(familyCookie.value)
        : null;
    if (familyCookie.value !== undefined) {
      this.families.remove(familyCookie.value);
    }

    // Local-first: remove every session this browser family can name before
    // any provider await. Removing the pending transaction and family binding
    // above also makes a late authorization callback fail closed.
    const sessionIds = new Set<string>();
    if (familySessionId !== null) sessionIds.add(familySessionId);
    if (
      sessionCookie.valid &&
      sessionCookie.value !== undefined
    ) {
      sessionIds.add(sessionCookie.value);
    }
    const sessionsToLogout: Array<{
      readonly session: LinghaoPassportV4Session;
      readonly pendingRefresh?: Promise<RefreshOutcome>;
    }> = [];
    for (const sessionId of sessionIds) {
      const session = this.sessions.beginLogout(sessionId);
      if (session === null) continue;
      sessionsToLogout.push({
        session,
        ...(this.refreshInFlight.get(session.id) === undefined
          ? {}
          : { pendingRefresh: this.refreshInFlight.get(session.id)! }),
      });
      this.families.unbindSession(session.id);
      this.sessions.destroy(session.id);
    }

    const revocationResults = await Promise.all(
      sessionsToLogout.map(async ({ session, pendingRefresh }) => {
        const token = session.refreshToken ?? session.accessToken;
        const [originalConfirmed, pending] = await Promise.all([
          this.oidc(config)
            .revokeToken(
              token,
              session.refreshToken === undefined
                ? "access_token"
                : "refresh_token",
            )
            .then(
              () => true,
              () => false,
            ),
          pendingRefresh === undefined
            ? Promise.resolve<RefreshOutcome | null>(null)
            : pendingRefresh.then(
                (outcome) => outcome,
                () => null,
              ),
        ]);
        return (
          originalConfirmed &&
          (pending === null || pending.cleanupConfirmed !== false)
        );
      }),
    );
    const revocationConfirmed =
      sessionsToLogout.length > 0 &&
      revocationResults.every((confirmed) => confirmed);
    const sessionForEndSession = sessionsToLogout[0]?.session ?? null;

    let providerEndSessionLocation: string | null = null;
    if (revocationConfirmed && sessionForEndSession !== null) {
      const result = this.logoutStates.create({
        revocationConfirmed: true,
        upstreamReturnExpected: true,
      });
      if (result) {
        try {
          // The state is generated only after the local session is gone and
          // revocation is confirmed. It is bound into the one-time result.
          providerEndSessionLocation = await this.oidc(config).buildEndSessionUrl(
            sessionForEndSession.idToken,
            result.state,
          );
          const cookies = [
            ...clearCookies,
            serializePassportCookie(
              LINGHAO_PASSPORT_V4_LOGOUT_COOKIE,
              result.cookieId,
              {
                path: LINGHAO_PASSPORT_V4_COOKIE_PATH,
                maxAgeSeconds: LINGHAO_PASSPORT_V4_LOGOUT_TTL_SECONDS,
              },
            ),
          ];
          return emptyRedirectResponse(providerEndSessionLocation, cookies);
        } catch {
          providerEndSessionLocation = null;
          this.logoutStates.remove(result.cookieId);
        }
      }
    }

    if (revocationConfirmed) {
      // Revocation succeeded but the provider end-session URL or result slot
      // was unavailable. Stay local and report the confirmed local outcome.
      const result = this.logoutStates.create({
        revocationConfirmed: true,
        upstreamReturnExpected: false,
      });
      return this.localLogoutRedirect(result, clearCookies);
    }

    const result = this.logoutStates.create({
      revocationConfirmed: false,
      upstreamReturnExpected: false,
    });
    return this.localLogoutRedirect(result, clearCookies);
  }

  private localLogoutRedirect(
    result: LinghaoPassportV4LogoutResult | null,
    clearCookies: readonly string[],
  ): Response {
    const cookies = [...clearCookies];
    let location: string;
    if (result) {
      cookies.push(
        serializePassportCookie(
          LINGHAO_PASSPORT_V4_LOGOUT_COOKIE,
          result.cookieId,
          {
            path: LINGHAO_PASSPORT_V4_COOKIE_PATH,
            maxAgeSeconds: LINGHAO_PASSPORT_V4_LOGOUT_TTL_SECONDS,
          },
        ),
      );
      location = `${LINGHAO_PASSPORT_V4_POST_LOGOUT_REDIRECT_URI}?state=${encodeURIComponent(
        result.state,
      )}`;
    } else {
      // No bounded result slot exists. Never navigate to the IdP and never
      // claim upstream logout; the fixed local status is intentionally bare.
      location = `${LINGHAO_PASSPORT_V4_POST_LOGOUT_REDIRECT_URI}?status=local-only`;
    }
    return emptyRedirectResponse(location, cookies);
  }

  private async handleLoggedOut(request: Request): Promise<Response> {
    if (!this.isLocalRequest(request, ACTION_PATHS["logged-out"])) {
      return unavailableResponse();
    }
    if (request.method !== "POST") return methodNotAllowed("POST");
    if (!isSameOriginPost(request)) return invalidResponse();

    const clearLogout = clearPassportCookie(
      LINGHAO_PASSPORT_V4_LOGOUT_COOKIE,
      LINGHAO_PASSPORT_V4_COOKIE_PATH,
    );
    const url = new URL(request.url);
    const state = readLoggedOutQuery(url);
    if (state === null) {
      return invalidResponse([clearLogout]);
    }

    const body = await readBoundedRequestBody(
      request,
      1024,
      this.bodyTimeoutMs,
    );
    if (body === null || body.byteLength !== 0) {
      return invalidResponse([clearLogout]);
    }
    const logoutCookie = cookieValue(
      request.headers.get("cookie") ?? undefined,
      LINGHAO_PASSPORT_V4_LOGOUT_COOKIE,
    );
    if (!logoutCookie.valid || logoutCookie.value === undefined) {
      return invalidResponse([clearLogout]);
    }
    const result = this.logoutStates.consume(
      logoutCookie.value,
      state,
    );
    if (!result) {
      return invalidResponse([clearLogout]);
    }
    return jsonResponse(
      {
        localLoggedOut: true,
        revocationConfirmed: result.revocationConfirmed,
        upstreamReturnConfirmed: result.upstreamReturnExpected,
      },
      200,
      { cookies: [clearLogout], varyCookie: true },
    );
  }

  private async ensureFresh(
    session: LinghaoPassportV4Session,
    force: boolean,
    config: LinghaoPassportV4EnabledConfig,
  ): Promise<RefreshOutcome> {
    if (!this.sessions.needsRefresh(session, force)) {
      return { status: "not-needed" };
    }
    if (session.refreshToken === undefined) {
      this.sessions.destroy(session.id);
      return { status: "failed" };
    }
    const existing = this.refreshInFlight.get(session.id);
    if (existing) return existing;
    if (this.refreshInFlight.size >= this.maxRefreshFlights) {
      return { status: "unavailable" };
    }

    const ticket = this.sessions.beginRefresh(session);
    if (!ticket) return { status: "unavailable" };

    const promise = this.performRefresh(ticket, config).finally(() => {
      this.refreshInFlight.delete(session.id);
    });
    this.refreshInFlight.set(session.id, promise);
    return promise;
  }

  private async performRefresh(
    ticket: {
      readonly sessionId: string;
      readonly refreshToken: string;
      readonly subject: string;
      readonly nonce?: string;
    },
    config: LinghaoPassportV4EnabledConfig,
  ): Promise<RefreshOutcome> {
    try {
      const result = await this.oidc(config).refresh(
        ticket.refreshToken,
        ticket.subject,
        ticket.nonce,
      );
      const rotatedRefreshToken = result.tokens.refreshToken;
      const applied = this.sessions.applyRefresh(
        ticket.sessionId,
        ticket.refreshToken,
        {
          identity: result.identity,
          idToken: result.tokens.idToken,
          accessToken: result.tokens.accessToken,
          refreshToken: rotatedRefreshToken,
          accessTokenExpiresAt:
            this.now() + result.tokens.expiresIn * 1000,
        },
      );
      if (!applied) {
        // Logout deleted the local binding while the provider minted a rotated
        // token. It must be revoked before logout may claim confirmation.
        let cleanupConfirmed = false;
        try {
          await this.oidc(config).revokeToken(
            result.tokens.accessToken,
            "access_token",
          );
          if (rotatedRefreshToken !== undefined) {
            await this.oidc(config).revokeToken(
              rotatedRefreshToken,
              "refresh_token",
            );
          }
          cleanupConfirmed = true;
        } catch {
          cleanupConfirmed = false;
        }
        const current = this.sessions.peek(ticket.sessionId);
        if (current && this.sessions.needsRefresh(current)) {
          this.sessions.invalidateAfterRefreshFailure(
            ticket.sessionId,
            ticket.refreshToken,
          );
        }
        return { status: "discarded", cleanupConfirmed };
      }
      return { status: "refreshed" };
    } catch {
      // A refresh response may have spent the old token and minted an unknown
      // replacement before failing parse/verification. Conservatively leave
      // cleanup unconfirmed for a concurrent logout.
      this.sessions.invalidateAfterRefreshFailure(
        ticket.sessionId,
        ticket.refreshToken,
      );
      return { status: "failed", cleanupConfirmed: false };
    }
  }

  private newOpaqueIdentifier(): string {
    const bytes = this.randomBytes(32);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 32) {
      throw new Error("secure random source returned an invalid length");
    }
    return Buffer.from(bytes).toString("base64url");
  }

  private oidc(config: LinghaoPassportV4EnabledConfig): LinghaoPassportV4OidcClient {
    if (this.oidcClient === null || this.activeSecret !== config.clientSecret) {
      this.oidcClient = new LinghaoPassportV4OidcClient({
        config,
        fetch: this.fetchImpl,
        now: this.now,
        randomBytes: this.randomBytes,
        requestTimeoutMs: this.requestTimeoutMs,
      });
      this.activeSecret = config.clientSecret;
    }
    return this.oidcClient;
  }

  private isLocalRequest(request: Request, expectedPath: string): boolean {
    if (request.headers.get("host") !== LINGHAO_PASSPORT_V4_HOST) {
      return false;
    }
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return false;
    }
    if (
      url.protocol !== "http:" ||
      (url.origin !== LINGHAO_PASSPORT_V4_PUBLIC_ORIGIN &&
        url.origin !== NEXT_INTERNAL_LOOPBACK_ORIGIN) ||
      url.pathname !== expectedPath ||
      url.username !== "" ||
      url.password !== ""
    ) {
      return false;
    }
    return true;
  }
}

/**
 * Resolves one process-wide versioned registry. Independent Route Handler
 * chunks all see the same object on `globalThis`. An incompatible existing
 * version or shape is rejected rather than silently replaced.
 */
export function getLinghaoPassportV4Server(): LinghaoPassportV4Server {
  const holder = globalThis as unknown as Record<PropertyKey, unknown>;
  const existing = holder[LINGHAO_PASSPORT_V4_SERVER_REGISTRY_SYMBOL];
  if (existing !== undefined) {
    if (
      !isPlainObject(existing) ||
      existing.version !== LINGHAO_PASSPORT_V4_SERVER_REGISTRY_VERSION ||
      existing.key !== "aistory.linghao-passport-v4.server-registry.v1" ||
      existing.server === null ||
      typeof existing.server !== "object" ||
      typeof (existing.server as { handle?: unknown }).handle !== "function"
    ) {
      throw new Error("incompatible Passport server registry");
    }
    return existing.server as unknown as LinghaoPassportV4Server;
  }

  const server = new LinghaoPassportV4Server();
  const registry: LinghaoPassportV4ServerRegistry = Object.freeze({
    version: 1,
    key: "aistory.linghao-passport-v4.server-registry.v1",
    server,
  });
  holder[LINGHAO_PASSPORT_V4_SERVER_REGISTRY_SYMBOL] = registry;
  return server;
}

export function createLinghaoPassportV4Server(
  options: LinghaoPassportV4ServerOptions = {},
): LinghaoPassportV4Server {
  return new LinghaoPassportV4Server(options);
}

export function isLinghaoPassportV4OpaqueIdentifier(
  value: unknown,
): value is string {
  return typeof value === "string" && OPAQUE_PATTERN.test(value);
}

