import "server-only";

import { randomBytes as nodeRandomBytes } from "node:crypto";
import {
  LINGHAO_PASSPORT_V4_PRODUCTION_CALLBACK,
  LINGHAO_PASSPORT_V4_PRODUCTION_CLIENT_ID,
  LINGHAO_PASSPORT_V4_PRODUCTION_ISSUER,
  LINGHAO_PASSPORT_V4_PRODUCTION_ORIGIN,
  LINGHAO_PASSPORT_V4_PRODUCTION_POST_LOGOUT,
  LINGHAO_PASSPORT_V4_PRODUCTION_SCOPES,
} from "./linghaoPassportV4ProductionPublic";
import {
  LINGHAO_PASSPORT_V4_ACCOUNT_NAMESPACE,
  deriveLinghaoPassportV4PrincipalKey,
  linghaoPassportV4PublicAccount,
  type LinghaoPassportV4ProductSession,
  type LinghaoPassportV4ProductSessionRead,
} from "./linghaoPassportV4ProductionSession";
import {
  LINGHAO_PASSPORT_V4_FAMILY_COOKIE,
  LINGHAO_PASSPORT_V4_LOGOUT_COOKIE,
  LINGHAO_PASSPORT_V4_PRODUCT_SESSION_COOKIE,
  LINGHAO_PASSPORT_V4_TRANSACTION_COOKIE,
} from "./linghaoPassportV4ProductionCookies";
import {
  deriveLinghaoPassportV4DurableHash,
  safeLinghaoPassportV4HashEqual,
  type LinghaoPassportV4CommitCallbackResult,
  type LinghaoPassportV4CommitRefreshResult,
} from "./linghaoPassportV4DurableAuthority";
import {
  openLinghaoPassportV4State,
  sealLinghaoPassportV4State,
  type LinghaoPassportV4SealedKind,
} from "./linghaoPassportV4StateSeal";
import {
  createLinghaoPassportV4AuthorizationSecrets,
  LinghaoPassportV4OidcClient,
  type LinghaoPassportV4Fetch,
  type LinghaoPassportV4RandomBytes,
  type LinghaoPassportV4AuthenticationResult,
} from "./linghaoPassportV4Oidc";
import type { LinghaoPassportV4ProductionMaterials } from "./linghaoPassportV4ProductionLoader";

export type LinghaoPassportV4ProductionAction =
  | "capabilities"
  | "start"
  | "callback"
  | "session"
  | "renew"
  | "logout"
  | "logged-out";

export type LinghaoPassportV4ProductionServerOptions = Readonly<{
  materials: LinghaoPassportV4ProductionMaterials;
  publicEntry: boolean;
  fetch?: LinghaoPassportV4Fetch;
  now?: () => number;
  randomBytes?: LinghaoPassportV4RandomBytes;
}>;

const OPAQUE = /^[A-Za-z0-9_-]{43}$/;
const HASH = /^[a-f0-9]{64}$/;
const CALLBACK_KEYS = new Set([
  "code",
  "state",
  "iss",
  "error",
  "error_description",
  "error_uri",
]);
const PATHS: Record<LinghaoPassportV4ProductionAction, string> = {
  capabilities: "/api/auth/linghao-passport-v4/capabilities",
  start: "/api/auth/linghao-passport-v4/start",
  callback: "/api/auth/linghao-passport-v4/callback",
  session: "/api/auth/linghao-passport-v4/session",
  renew: "/api/auth/linghao-passport-v4/renew",
  logout: "/api/auth/linghao-passport-v4/logout",
  "logged-out": "/api/auth/linghao-passport-v4/logged-out",
};

function headers(contentType = true): Headers {
  const output = new Headers({
    "Cache-Control": "private, no-store, max-age=0",
    Pragma: "no-cache",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  });
  if (contentType) output.set("Content-Type", "application/json; charset=utf-8");
  return output;
}

function json(body: unknown, status: number, cookies: readonly string[] = []): Response {
  const responseHeaders = headers();
  if (cookies.length > 0) responseHeaders.set("Vary", "Cookie");
  for (const cookie of cookies) responseHeaders.append("Set-Cookie", cookie);
  return new Response(JSON.stringify(body), { status, headers: responseHeaders });
}

function redirect(location: string, cookies: readonly string[]): Response {
  const responseHeaders = headers(false);
  responseHeaders.set("Location", location);
  responseHeaders.set("Content-Length", "0");
  for (const cookie of cookies) responseHeaders.append("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers: responseHeaders });
}

function cookie(name: string, value: string, maxAgeSeconds: number): string {
  if (!OPAQUE.test(value) || !Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 1) {
    throw new Error("passport cookie rejected");
  }
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

function clearCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function readCookie(request: Request, name: string):
  | { state: "absent" }
  | { state: "invalid" }
  | { state: "present"; value: string } {
  const raw = request.headers.get("cookie") ?? "";
  if (raw.length > 16 * 1024) return { state: "invalid" };
  const values = raw
    .split(";")
    .map((item) => item.trim())
    .filter((item) => item.startsWith(`${name}=`))
    .map((item) => item.slice(name.length + 1));
  if (values.length === 0) return { state: "absent" };
  if (values.length !== 1 || !OPAQUE.test(values[0]!)) return { state: "invalid" };
  return { state: "present", value: values[0]! };
}

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("sealed payload rejected");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) {
    throw new Error("sealed payload rejected");
  }
  return record;
}

async function emptyJsonBody(request: Request): Promise<boolean> {
  if (request.headers.get("transfer-encoding") !== null) return false;
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") return false;
  const length = request.headers.get("content-length");
  if (length !== "2") return false;
  try {
    return (await request.text()) === "{}";
  } catch {
    return false;
  }
}

async function emptyLogoutBody(request: Request): Promise<boolean> {
  if (request.headers.get("transfer-encoding") !== null) return false;
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType === "application/json") {
    const length = request.headers.get("content-length");
    if (length !== "2") return false;
    try { return (await request.text()) === "{}"; } catch { return false; }
  }
  if (contentType !== "application/x-www-form-urlencoded") return false;
  const length = request.headers.get("content-length");
  if (length !== null && length !== "0") return false;
  try { return (await request.text()) === ""; } catch { return false; }
}

export class LinghaoPassportV4ProductionServer {
  private readonly materials: LinghaoPassportV4ProductionMaterials;
  private readonly publicEntry: boolean;
  private readonly now: () => number;
  private readonly randomBytes: LinghaoPassportV4RandomBytes;
  private readonly oidc: LinghaoPassportV4OidcClient;

  constructor(options: LinghaoPassportV4ProductionServerOptions) {
    this.materials = options.materials;
    this.publicEntry = options.publicEntry;
    this.now = options.now ?? Date.now;
    this.randomBytes = options.randomBytes ?? ((size) => new Uint8Array(nodeRandomBytes(size)));
    this.oidc = new LinghaoPassportV4OidcClient({
      config: {
        issuer: LINGHAO_PASSPORT_V4_PRODUCTION_ISSUER,
        clientId: LINGHAO_PASSPORT_V4_PRODUCTION_CLIENT_ID,
        clientSecret: options.materials.clientSecret,
        publicOrigin: LINGHAO_PASSPORT_V4_PRODUCTION_ORIGIN,
        redirectUri: LINGHAO_PASSPORT_V4_PRODUCTION_CALLBACK,
        postLogoutRedirectUri: LINGHAO_PASSPORT_V4_PRODUCTION_POST_LOGOUT,
        scopes: LINGHAO_PASSPORT_V4_PRODUCTION_SCOPES,
      },
      fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
      now: this.now,
      randomBytes: this.randomBytes,
      endpointPolicy: "production_https",
      requireRefreshToken: false,
    });
  }

  async handle(action: LinghaoPassportV4ProductionAction, request: Request): Promise<Response> {
    try {
      const url = this.requestUrl(request, PATHS[action]);
      if (!url) return json({ error: "not_found" }, 404);
      switch (action) {
        case "capabilities":
          if (request.method !== "GET" || url.search) return json({ error: "invalid_request" }, 400);
          return json({ enabled: true, mode: "production", publicEntry: this.publicEntry }, 200);
        case "start":
          return await this.start(request, url);
        case "callback":
          return await this.callback(request, url);
        case "session":
          return await this.session(request, url);
        case "renew":
          return await this.renew(request, url);
        case "logout":
          return await this.logout(request, url);
        case "logged-out":
          return await this.loggedOut(request, url);
      }
    } catch {
      return json({ error: "temporarily_unavailable" }, 503);
    }
  }

  async readProductSession(request: Request): Promise<LinghaoPassportV4ProductSessionRead> {
    const sessionCookie = readCookie(request, LINGHAO_PASSPORT_V4_PRODUCT_SESSION_COOKIE);
    if (sessionCookie.state === "absent") return { state: "absent" };
    if (sessionCookie.state === "invalid") return { state: "invalid" };
    const result = await this.readAuthenticated(sessionCookie.value);
    if (!result) return { state: "invalid" };
    return {
      state: "authenticated",
      session: Object.freeze({
        authType: "passport_v4",
        userId: `passport_v4:${result.principalKey}`,
        principalKey: result.principalKey,
        sessionBinding: result.sessionHash,
        accountNamespace: LINGHAO_PASSPORT_V4_ACCOUNT_NAMESPACE,
        authenticatedAtMs: result.authenticatedAtMs,
        expiresAtMs: result.expiresAtMs,
      }),
    };
  }

  async revokeProductSessionForAccount(request: Request): Promise<readonly string[] | null> {
    const url = this.requestUrl(request, "/api/account/me");
    if (!url || request.method !== "DELETE" || url.search || !this.sameOriginPost(request)) return null;
    const familyCookie = readCookie(request, LINGHAO_PASSPORT_V4_FAMILY_COOKIE);
    const sessionCookie = readCookie(request, LINGHAO_PASSPORT_V4_PRODUCT_SESSION_COOKIE);
    if (familyCookie.state === "absent" && sessionCookie.state === "absent") return [];
    if (familyCookie.state !== "present" || sessionCookie.state !== "present") return null;
    const receiptRaw = this.opaque();
    const stateRaw = this.opaque();
    const receiptHash = this.hash("logout_receipt", receiptRaw);
    const stateHash = this.hash("logout_state", stateRaw);
    const begun = await this.materials.authority.beginLogout({
      familyHash: this.hash("family_cookie", familyCookie.value),
      sessionHash: this.hash("session_cookie", sessionCookie.value),
      receiptHash,
      stateHash,
      upstreamReturnExpected: false,
    });
    if (begun.status !== "revoked") return null;
    await this.drainRevocations(16);
    const inspection = await this.materials.authority.inspectLogoutResult(receiptHash);
    if (inspection.status !== "ready" || !inspection.revocationConfirmed) return null;
    const consumed = await this.materials.authority.consumeLogoutResult(receiptHash, stateHash, false);
    if (consumed.status !== "consumed" || !consumed.revocationConfirmed) return null;
    return [
      clearCookie(LINGHAO_PASSPORT_V4_FAMILY_COOKIE),
      clearCookie(LINGHAO_PASSPORT_V4_TRANSACTION_COOKIE),
      clearCookie(LINGHAO_PASSPORT_V4_PRODUCT_SESSION_COOKIE),
      clearCookie(LINGHAO_PASSPORT_V4_LOGOUT_COOKIE),
    ];
  }

  private requestUrl(request: Request, pathname: string): URL | null {
    if (request.headers.get("host") !== new URL(LINGHAO_PASSPORT_V4_PRODUCTION_ORIGIN).host) return null;
    let url: URL;
    try { url = new URL(request.url); } catch { return null; }
    if (
      url.pathname !== pathname ||
      (url.origin !== LINGHAO_PASSPORT_V4_PRODUCTION_ORIGIN &&
        url.origin !== this.materials.configuration.proxyRequestOrigin) ||
      url.username || url.password
    ) return null;
    return url;
  }

  private sameOriginPost(request: Request): boolean {
    return request.headers.get("origin") === LINGHAO_PASSPORT_V4_PRODUCTION_ORIGIN
      && request.headers.get("sec-fetch-site") === "same-origin";
  }

  private opaque(): string {
    const bytes = this.randomBytes(32);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 32) throw new Error("random rejected");
    return Buffer.from(bytes).toString("base64url");
  }

  private hash(purpose: Parameters<typeof deriveLinghaoPassportV4DurableHash>[0], value: string): string {
    return deriveLinghaoPassportV4DurableHash(purpose, value, this.materials.stateSealKey);
  }

  private seal(kind: LinghaoPassportV4SealedKind, context: string, value: Record<string, unknown>): string {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    try {
      return sealLinghaoPassportV4State(kind, context, bytes, this.materials.stateSealKey, this.randomBytes);
    } finally { bytes.fill(0); }
  }

  private open(kind: LinghaoPassportV4SealedKind, context: string, envelope: string): unknown {
    const bytes = openLinghaoPassportV4State(kind, context, envelope, this.materials.stateSealKey);
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } finally { bytes.fill(0); }
  }

  private async start(request: Request, url: URL): Promise<Response> {
    if (!this.publicEntry) return json({ error: "not_found" }, 404);
    if (request.method !== "POST" || url.search || !this.sameOriginPost(request) || !(await emptyJsonBody(request))) {
      return json({ error: "invalid_request" }, 400);
    }
    const trustedBucket = request.headers.get(this.materials.configuration.ingressRateBucketHeader);
    if (!trustedBucket || !HASH.test(trustedBucket)) return json({ error: "temporarily_unavailable" }, 503);
    const existingFamily = readCookie(request, LINGHAO_PASSPORT_V4_FAMILY_COOKIE);
    const familyRaw = existingFamily.state === "present" ? existingFamily.value : this.opaque();
    const transactionRaw = this.opaque();
    const secrets = createLinghaoPassportV4AuthorizationSecrets(this.randomBytes);
    const familyHash = this.hash("family_cookie", familyRaw);
    const transactionHash = this.hash("transaction_cookie", transactionRaw);
    const stateHash = this.hash("oidc_state", secrets.state);
    const nonceHash = this.hash("oidc_nonce", secrets.nonce);
    const verifierEnvelope = this.seal("authorization_transaction", transactionHash, {
      schema: "aistory.linghao-passport-v4.authorization-transaction.v1",
      state: secrets.state,
      nonce: secrets.nonce,
      codeVerifier: secrets.codeVerifier,
    });
    const reserved = await this.materials.authority.reserveStart({
      familyHash,
      transactionHash,
      stateHash,
      nonceHash,
      rateBucketHash: this.hash("rate_bucket", trustedBucket),
      verifierEnvelope,
    });
    if (reserved.status === "rate_limited") return json({ error: "rate_limited" }, 429);
    let authorizationUrl: string;
    try {
      authorizationUrl = await this.oidc.createAuthorizationUrl(secrets);
    } catch {
      await this.materials.authority.cancelStart(transactionHash);
      return json({ error: "temporarily_unavailable" }, 503);
    }
    return json({ authorizationUrl }, 200, [
      cookie(LINGHAO_PASSPORT_V4_TRANSACTION_COOKIE, transactionRaw, 600),
      cookie(LINGHAO_PASSPORT_V4_FAMILY_COOKIE, familyRaw, 24 * 60 * 60),
    ]);
  }

  private callbackQuery(url: URL): Map<string, string> | null {
    const output = new Map<string, string>();
    let size = 0;
    for (const [key, value] of url.searchParams) {
      if (!CALLBACK_KEYS.has(key) || output.has(key) || value.length > 4096) return null;
      size += key.length + value.length;
      if (size > 16 * 1024) return null;
      output.set(key, value);
    }
    return output.has("state") ? output : null;
  }

  private sessionFromEnvelope(transactionHash: string, value: string): string {
    const payload = exactObject(this.open("session_result", transactionHash, value), ["schema", "session"]);
    if (payload.schema !== "aistory.linghao-passport-v4.session-result.v1" || typeof payload.session !== "string" || !OPAQUE.test(payload.session)) {
      throw new Error("session result rejected");
    }
    return payload.session;
  }

  private async callback(request: Request, url: URL): Promise<Response> {
    const clearTransaction = clearCookie(LINGHAO_PASSPORT_V4_TRANSACTION_COOKIE);
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
    const query = this.callbackQuery(url);
    const transactionCookie = readCookie(request, LINGHAO_PASSPORT_V4_TRANSACTION_COOKIE);
    const familyCookie = readCookie(request, LINGHAO_PASSPORT_V4_FAMILY_COOKIE);
    if (!query || transactionCookie.state !== "present" || familyCookie.state !== "present") {
      return redirect(`${LINGHAO_PASSPORT_V4_PRODUCTION_POST_LOGOUT}?status=failed`, [clearTransaction]);
    }
    const stateRaw = query.get("state")!;
    if (!OPAQUE.test(stateRaw)) return redirect(`${LINGHAO_PASSPORT_V4_PRODUCTION_POST_LOGOUT}?status=failed`, [clearTransaction]);
    const transactionHash = this.hash("transaction_cookie", transactionCookie.value);
    const consumed = await this.materials.authority.consumeCallback(transactionHash, this.hash("oidc_state", stateRaw));
    if (consumed.status === "completed") {
      const sessionRaw = this.sessionFromEnvelope(transactionHash, consumed.sessionResultEnvelope);
      const existing = await this.readAuthenticated(sessionRaw);
      if (
        !existing ||
        !safeLinghaoPassportV4HashEqual(
          existing.familyHash,
          this.hash("family_cookie", familyCookie.value),
        )
      ) {
        return redirect(`${LINGHAO_PASSPORT_V4_PRODUCTION_POST_LOGOUT}?status=failed`, [clearTransaction]);
      }
      const maxAge = Math.max(
        1,
        Math.min(3600, Math.floor((existing.expiresAtMs - this.now()) / 1000)),
      );
      return redirect(`${LINGHAO_PASSPORT_V4_PRODUCTION_POST_LOGOUT}?status=authenticated`, [
        clearTransaction,
        cookie(LINGHAO_PASSPORT_V4_PRODUCT_SESSION_COOKIE, sessionRaw, maxAge),
      ]);
    }
    if (consumed.status !== "accepted" || !safeLinghaoPassportV4HashEqual(consumed.familyHash, this.hash("family_cookie", familyCookie.value))) {
      return redirect(`${LINGHAO_PASSPORT_V4_PRODUCTION_POST_LOGOUT}?status=failed`, [clearTransaction]);
    }
    const transaction = exactObject(this.open("authorization_transaction", transactionHash, consumed.verifierEnvelope),
      ["schema", "state", "nonce", "codeVerifier"]);
    if (
      transaction.schema !== "aistory.linghao-passport-v4.authorization-transaction.v1" ||
      transaction.state !== stateRaw ||
      typeof transaction.nonce !== "string" ||
      typeof transaction.codeVerifier !== "string" ||
      !safeLinghaoPassportV4HashEqual(consumed.nonceHash, this.hash("oidc_nonce", transaction.nonce)) ||
      query.has("error") ||
      (query.has("iss") && query.get("iss") !== LINGHAO_PASSPORT_V4_PRODUCTION_ISSUER)
    ) return redirect(`${LINGHAO_PASSPORT_V4_PRODUCTION_POST_LOGOUT}?status=failed`, [clearTransaction]);
    const code = query.get("code");
    if (!code || code.length > 4096 || /[\u0000-\u001f\u007f]/.test(code)) {
      return redirect(`${LINGHAO_PASSPORT_V4_PRODUCTION_POST_LOGOUT}?status=failed`, [clearTransaction]);
    }
    let authentication: LinghaoPassportV4AuthenticationResult;
    try {
      authentication = await this.oidc.exchangeAuthorizationCode(code, {
        state: stateRaw,
        nonce: transaction.nonce,
        codeVerifier: transaction.codeVerifier,
      });
    } catch {
      return redirect(`${LINGHAO_PASSPORT_V4_PRODUCTION_POST_LOGOUT}?status=failed`, [clearTransaction]);
    }
    const sessionRaw = this.opaque();
    const sessionHash = this.hash("session_cookie", sessionRaw);
    const principalKey = deriveLinghaoPassportV4PrincipalKey(
      authentication.identity.issuer,
      authentication.identity.clientId,
      authentication.identity.subject,
    );
    const accessTokenFingerprint = this.hash("access_token", authentication.tokens.accessToken);
    const accessTokenEnvelope = this.seal("access_token", accessTokenFingerprint, {
      schema: "aistory.linghao-passport-v4.provider-token.v1",
      token: authentication.tokens.accessToken,
    });
    const refreshToken = authentication.tokens.refreshToken;
    const refreshFingerprint = refreshToken ? this.hash("refresh_token", refreshToken) : null;
    const refreshEnvelope = refreshToken && refreshFingerprint ? this.seal("refresh_token", refreshFingerprint, {
      schema: "aistory.linghao-passport-v4.refresh-token.v1",
      token: refreshToken,
      subject: authentication.identity.subject,
      ...(authentication.identity.nonce ? { nonce: authentication.identity.nonce } : {}),
    }) : null;
    const idTokenHintEnvelope = this.seal("id_token_hint", sessionHash, {
      schema: "aistory.linghao-passport-v4.id-token-hint.v1",
      token: authentication.tokens.idToken,
    });
    const sessionResultEnvelope = this.seal("session_result", transactionHash, {
      schema: "aistory.linghao-passport-v4.session-result.v1",
      session: sessionRaw,
    });
    const commitInput = {
      transactionHash,
      familyHash: consumed.familyHash,
      principalKey,
      sessionHash,
      completionHash: this.hash("completion", `${transactionCookie.value}.${sessionRaw}`),
      sessionResultEnvelope,
      accessTokenFingerprint,
      accessTokenEnvelope,
      idTokenHintEnvelope,
      refreshFingerprint,
      refreshEnvelope,
      providerExpiresAtMs: Math.min(
        authentication.identity.expiresAt * 1000,
        this.now() + authentication.tokens.expiresIn * 1000,
      ),
    } as const;
    let committed: LinghaoPassportV4CommitCallbackResult | null = null;
    for (let attempt = 0; attempt < 2 && committed === null; attempt += 1) {
      try {
        committed = await this.materials.authority.commitCallback(commitInput);
      } catch {
        // The RPC is exact-idempotent. One bounded retry reconciles the common
        // response-loss case without revoking credentials that may be bound to
        // a successfully committed durable session.
      }
    }
    if (committed === null) {
      await this.revokeMinted(authentication.tokens.accessToken, refreshToken);
      return redirect(`${LINGHAO_PASSPORT_V4_PRODUCTION_POST_LOGOUT}?status=failed`, [clearTransaction]);
    }
    await this.drainRevocations(16);
    if (committed.status !== "committed" && committed.status !== "replayed") {
      if (committed.status === "rejected") await this.revokeMinted(authentication.tokens.accessToken, refreshToken);
      return redirect(`${LINGHAO_PASSPORT_V4_PRODUCTION_POST_LOGOUT}?status=failed`, [clearTransaction]);
    }
    const canonicalSession = this.sessionFromEnvelope(transactionHash, committed.sessionResultEnvelope);
    const maxAge = Math.max(1, Math.min(3600, Math.floor((committed.absoluteExpiresAtMs - this.now()) / 1000)));
    return redirect(`${LINGHAO_PASSPORT_V4_PRODUCTION_POST_LOGOUT}?status=authenticated`, [
      clearTransaction,
      cookie(LINGHAO_PASSPORT_V4_PRODUCT_SESSION_COOKIE, canonicalSession, maxAge),
    ]);
  }

  private async readAuthenticated(sessionRaw: string) {
    const sessionHash = this.hash("session_cookie", sessionRaw);
    let result = await this.materials.authority.readSession(sessionHash);
    if (result.status === "refresh_required") {
      if (!(await this.performRefresh(sessionHash))) return null;
      result = await this.materials.authority.readSession(sessionHash);
    }
    return result.status === "authenticated" ? result : null;
  }

  private account(result: Awaited<ReturnType<LinghaoPassportV4ProductionServer["readAuthenticated"]>>) {
    if (!result) throw new Error("session absent");
    const session: LinghaoPassportV4ProductSession = Object.freeze({
      authType: "passport_v4",
      userId: `passport_v4:${result.principalKey}`,
      principalKey: result.principalKey,
      sessionBinding: result.sessionHash,
      accountNamespace: LINGHAO_PASSPORT_V4_ACCOUNT_NAMESPACE,
      authenticatedAtMs: result.authenticatedAtMs,
      expiresAtMs: result.expiresAtMs,
    });
    return linghaoPassportV4PublicAccount(session);
  }

  private async session(request: Request, url: URL): Promise<Response> {
    if (request.method !== "GET" || url.search) return json({ error: "invalid_request" }, 400);
    const sessionCookie = readCookie(request, LINGHAO_PASSPORT_V4_PRODUCT_SESSION_COOKIE);
    if (sessionCookie.state !== "present") {
      return json({ authenticated: false, account: null }, 401,
        sessionCookie.state === "invalid" ? [clearCookie(LINGHAO_PASSPORT_V4_PRODUCT_SESSION_COOKIE)] : []);
    }
    const result = await this.readAuthenticated(sessionCookie.value);
    if (!result) return json({ authenticated: false, account: null }, 401,
      [clearCookie(LINGHAO_PASSPORT_V4_PRODUCT_SESSION_COOKIE)]);
    return json({ authenticated: true, account: this.account(result) }, 200);
  }

  private async renew(request: Request, url: URL): Promise<Response> {
    if (request.method !== "POST" || url.search || !this.sameOriginPost(request) || !(await emptyJsonBody(request))) {
      return json({ error: "invalid_request" }, 400);
    }
    const sessionCookie = readCookie(request, LINGHAO_PASSPORT_V4_PRODUCT_SESSION_COOKIE);
    if (sessionCookie.state !== "present") return json({ authenticated: false }, 401);
    const sessionHash = this.hash("session_cookie", sessionCookie.value);
    if (!(await this.performRefresh(sessionHash))) return json({ error: "refresh_unavailable" }, 503);
    const result = await this.materials.authority.readSession(sessionHash);
    if (result.status !== "authenticated") return json({ authenticated: false }, 401,
      [clearCookie(LINGHAO_PASSPORT_V4_PRODUCT_SESSION_COOKIE)]);
    return json({ authenticated: true, account: this.account(result) }, 200);
  }

  private async performRefresh(sessionHash: string): Promise<boolean> {
    const attemptHash = this.hash("refresh_attempt", this.opaque());
    const claimed = await this.materials.authority.beginRefresh(sessionHash, attemptHash);
    if (claimed.status !== "claimed") return false;
    const opened = this.open("refresh_token", claimed.refreshContextHash, claimed.refreshEnvelope);
    const base = exactObject(
      opened,
      opened && typeof opened === "object" && Object.hasOwn(opened, "nonce")
        ? ["schema", "token", "subject", "nonce"]
        : ["schema", "token", "subject"],
    );
    const payload = base;
    if (
      payload.schema !== "aistory.linghao-passport-v4.refresh-token.v1" ||
      typeof payload.token !== "string" || typeof payload.subject !== "string" ||
      (payload.nonce !== undefined && typeof payload.nonce !== "string")
    ) {
      await this.materials.authority.failRefresh(attemptHash);
      return false;
    }
    let authentication: LinghaoPassportV4AuthenticationResult;
    try {
      authentication = await this.oidc.refresh(payload.token, payload.subject, payload.nonce as string | undefined);
    } catch {
      await this.materials.authority.failRefresh(attemptHash);
      await this.drainRevocations(16);
      return false;
    }
    const replacement = authentication.tokens.refreshToken;
    if (!replacement) {
      await this.materials.authority.failRefresh(attemptHash);
      return false;
    }
    const replacementFingerprint = this.hash("refresh_token", replacement);
    const accessTokenFingerprint = this.hash("access_token", authentication.tokens.accessToken);
    const commitInput = {
      attemptHash,
      completionHash: this.hash("completion", `${attemptHash}.${replacementFingerprint}`),
      replacementFingerprint,
      replacementEnvelope: this.seal("refresh_token", replacementFingerprint, {
        schema: "aistory.linghao-passport-v4.refresh-token.v1",
        token: replacement,
        subject: authentication.identity.subject,
        ...(authentication.identity.nonce ? { nonce: authentication.identity.nonce } : {}),
      }),
      accessTokenFingerprint,
      accessTokenEnvelope: this.seal("access_token", accessTokenFingerprint, {
        schema: "aistory.linghao-passport-v4.provider-token.v1",
        token: authentication.tokens.accessToken,
      }),
      idTokenHintEnvelope: this.seal("id_token_hint", sessionHash, {
        schema: "aistory.linghao-passport-v4.id-token-hint.v1",
        token: authentication.tokens.idToken,
      }),
      providerExpiresAtMs: Math.min(
        authentication.identity.expiresAt * 1000,
        this.now() + authentication.tokens.expiresIn * 1000,
      ),
    } as const;
    let committed: LinghaoPassportV4CommitRefreshResult | null = null;
    for (let attempt = 0; attempt < 2 && committed === null; attempt += 1) {
      try {
        committed = await this.materials.authority.commitRefresh(commitInput);
      } catch {
        // Exact completion hashes make this retry safe after response loss.
      }
    }
    if (committed === null) {
      await this.revokeMinted(authentication.tokens.accessToken, replacement);
      await this.materials.authority.failRefresh(attemptHash).catch(() => undefined);
      await this.drainRevocations(16).catch(() => undefined);
      return false;
    }
    await this.drainRevocations(16);
    if (committed.status === "committed" || committed.status === "replayed") return true;
    if (committed.status === "rejected") {
      await this.revokeMinted(authentication.tokens.accessToken, replacement);
      await this.materials.authority.failRefresh(attemptHash).catch(() => undefined);
    }
    return false;
  }

  private async logout(request: Request, url: URL): Promise<Response> {
    if (request.method !== "POST" || url.search || !this.sameOriginPost(request) || !(await emptyLogoutBody(request))) {
      return json({ error: "invalid_request" }, 400);
    }
    const familyCookie = readCookie(request, LINGHAO_PASSPORT_V4_FAMILY_COOKIE);
    const sessionCookie = readCookie(request, LINGHAO_PASSPORT_V4_PRODUCT_SESSION_COOKIE);
    if (familyCookie.state === "invalid" || sessionCookie.state === "invalid"
      || familyCookie.state !== sessionCookie.state) {
      return json({ error: "logout_unavailable" }, 503);
    }
    if (familyCookie.state === "absent" && sessionCookie.state === "absent") {
      return redirect(`${LINGHAO_PASSPORT_V4_PRODUCTION_POST_LOGOUT}?status=logged-out`, [
        clearCookie(LINGHAO_PASSPORT_V4_FAMILY_COOKIE),
        clearCookie(LINGHAO_PASSPORT_V4_TRANSACTION_COOKIE),
        clearCookie(LINGHAO_PASSPORT_V4_PRODUCT_SESSION_COOKIE),
      ]);
    }
    if (familyCookie.state !== "present" || sessionCookie.state !== "present") {
      return json({ error: "logout_unavailable" }, 503);
    }
    const receiptRaw = this.opaque();
    const stateRaw = this.opaque();
    const receiptHash = this.hash("logout_receipt", receiptRaw);
    const stateHash = this.hash("logout_state", stateRaw);
    const sessionHash = this.hash("session_cookie", sessionCookie.value);
    const begun = await this.materials.authority.beginLogout({
      familyHash: this.hash("family_cookie", familyCookie.value),
      sessionHash,
      receiptHash,
      stateHash,
      upstreamReturnExpected: true,
    });
    if (begun.status === "missing") return json({ error: "logout_unavailable" }, 503);
    await this.drainRevocations(16);
    const inspection = await this.materials.authority.inspectLogoutResult(receiptHash);
    const clears = [
      clearCookie(LINGHAO_PASSPORT_V4_FAMILY_COOKIE),
      clearCookie(LINGHAO_PASSPORT_V4_TRANSACTION_COOKIE),
      clearCookie(LINGHAO_PASSPORT_V4_PRODUCT_SESSION_COOKIE),
    ];
    if (inspection.status === "ready" && inspection.revocationConfirmed && begun.idTokenHintEnvelope) {
      try {
        const hint = exactObject(this.open("id_token_hint", sessionHash, begun.idTokenHintEnvelope), ["schema", "token"]);
        if (hint.schema === "aistory.linghao-passport-v4.id-token-hint.v1" && typeof hint.token === "string") {
          const endSessionUrl = await this.oidc.buildEndSessionUrl(hint.token, stateRaw);
          return redirect(endSessionUrl, [...clears, cookie(LINGHAO_PASSPORT_V4_LOGOUT_COOKIE, receiptRaw, 600)]);
        }
      } catch {
        // Local revocation already committed. Fall through to the truthful
        // local-only result while still clearing every browser authority.
      }
    }
    const outcome = await this.materials.authority.consumeLogoutResult(receiptHash, stateHash, false);
    return redirect(`${LINGHAO_PASSPORT_V4_PRODUCTION_POST_LOGOUT}?status=logged-out&revocation=${outcome.status === "consumed" && outcome.revocationConfirmed ? "confirmed" : "unconfirmed"}`, [
      ...clears,
      clearCookie(LINGHAO_PASSPORT_V4_LOGOUT_COOKIE),
    ]);
  }

  private async loggedOut(request: Request, url: URL): Promise<Response> {
    if (request.method !== "POST" || !this.sameOriginPost(request) || !(await emptyJsonBody(request))) {
      return json({ error: "invalid_request" }, 400);
    }
    const values = url.searchParams.getAll("state");
    const receiptCookie = readCookie(request, LINGHAO_PASSPORT_V4_LOGOUT_COOKIE);
    if (url.searchParams.size !== 1 || values.length !== 1 || !OPAQUE.test(values[0]!) || receiptCookie.state !== "present") {
      return json({ error: "invalid_request" }, 400, [clearCookie(LINGHAO_PASSPORT_V4_LOGOUT_COOKIE)]);
    }
    const outcome = await this.materials.authority.consumeLogoutResult(
      this.hash("logout_receipt", receiptCookie.value),
      this.hash("logout_state", values[0]!),
      true,
    );
    if (outcome.status !== "consumed") return json({ error: "invalid_request" }, 400,
      [clearCookie(LINGHAO_PASSPORT_V4_LOGOUT_COOKIE)]);
    return json(outcome, 200, [clearCookie(LINGHAO_PASSPORT_V4_LOGOUT_COOKIE)]);
  }

  private async revokeMinted(accessToken: string, refreshToken?: string): Promise<void> {
    await this.oidc.revokeToken(accessToken, "access_token").catch(() => undefined);
    if (refreshToken) await this.oidc.revokeToken(refreshToken, "refresh_token").catch(() => undefined);
  }

  private async drainRevocations(maximum: number): Promise<void> {
    const workItems = [];
    for (let index = 0; index < maximum; index += 1) {
      const work = await this.materials.authority.claimRevocation(
        this.hash("refresh_attempt", this.opaque()),
      );
      if (work.status === "empty") break;
      workItems.push(work);
    }
    await Promise.all(workItems.map(async (work) => {
      try {
        const opened = this.open(work.tokenKind, work.tokenContextHash, work.tokenEnvelope);
        const payload = work.tokenKind === "access_token"
          ? exactObject(opened, ["schema", "token"])
          : exactObject(
              opened,
              opened && typeof opened === "object" && Object.hasOwn(opened, "nonce")
                ? ["schema", "token", "subject", "nonce"]
                : ["schema", "token", "subject"],
            );
        if (
          (work.tokenKind === "access_token" && payload.schema !== "aistory.linghao-passport-v4.provider-token.v1") ||
          (work.tokenKind === "refresh_token" && payload.schema !== "aistory.linghao-passport-v4.refresh-token.v1")
        ) throw new Error("token envelope rejected");
        if (typeof payload.token !== "string") throw new Error("token envelope rejected");
        await this.oidc.revokeToken(payload.token, work.tokenKind);
        await this.materials.authority.completeRevocation(work.outboxHash, true);
      } catch {
        await this.materials.authority.completeRevocation(work.outboxHash, false);
      }
    }));
  }
}
