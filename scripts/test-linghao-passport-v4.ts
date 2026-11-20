/**
 * Self-contained, zero-external-network verification for the default-off
 * Linghao Passport v4 local integration.
 *
 * The fake provider serves discovery, JWKS, token, and revocation responses
 * from this process only. RSA keys and JWTs are generated locally. The real
 * protected secret path is never opened by this script: a reader dependency is
 * injected, and file-reader behaviour is exercised only against temporary
 * synthetic files under the workspace.
 */

import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  sign as cryptoSign,
} from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  closeSync,
  fstatSync,
  openSync,
  readSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import * as configModule from "../lib/auth/linghaoPassportV4Config";
import {
  LINGHAO_PASSPORT_V4_CALLBACK_PATH,
  LINGHAO_PASSPORT_V4_CLIENT_ID,
  LINGHAO_PASSPORT_V4_CLIENT_SECRET_FILE_ENV,
  LINGHAO_PASSPORT_V4_CLIENT_SECRET_FILE_PATH,
  LINGHAO_PASSPORT_V4_FAMILY_COOKIE,
  LINGHAO_PASSPORT_V4_ISSUER,
  LINGHAO_PASSPORT_V4_LOCAL_SELECTOR_ENV,
  LINGHAO_PASSPORT_V4_LOCAL_SELECTOR_VALUE,
  LINGHAO_PASSPORT_V4_LOGOUT_COOKIE,
  LINGHAO_PASSPORT_V4_MAX_FAMILIES,
  LINGHAO_PASSPORT_V4_MAX_LOGOUT_RESULTS,
  LINGHAO_PASSPORT_V4_MAX_PROFILES,
  LINGHAO_PASSPORT_V4_MAX_RATE_BUCKETS,
  LINGHAO_PASSPORT_V4_MAX_SESSIONS,
  LINGHAO_PASSPORT_V4_MAX_TRANSACTIONS,
  LINGHAO_PASSPORT_V4_PUBLIC_ORIGIN,
  LINGHAO_PASSPORT_V4_REDIRECT_URI,
  LINGHAO_PASSPORT_V4_SESSION_COOKIE,
  LINGHAO_PASSPORT_V4_TRANSACTION_COOKIE,
  linghaoPassportV4LocalModeRequested,
  loadLinghaoPassportV4Config,
} from "../lib/auth/linghaoPassportV4Config";
import {
  createLinghaoPassportV4AuthorizationSecrets,
  createLinghaoPassportV4LocalJwks,
  LinghaoPassportV4OidcClient,
  verifyLinghaoPassportV4IdToken,
  type LinghaoPassportV4Fetch,
} from "../lib/auth/linghaoPassportV4Oidc";
import {
  readLinghaoPassportV4ClientSecretFile,
  type LinghaoPassportV4SecretFileSystem,
} from "../lib/auth/linghaoPassportV4SecretFile";
import {
  deriveLinghaoPassportV4ProfileId,
  LinghaoPassportV4FamilyStore,
  LinghaoPassportV4LogoutStateStore,
  LinghaoPassportV4ProfileStore,
  LinghaoPassportV4SessionStore,
  LinghaoPassportV4StartRateLimiter,
  LinghaoPassportV4TransactionStore,
} from "../lib/auth/linghaoPassportV4Session";
import {
  getLinghaoPassportV4Server,
  LINGHAO_PASSPORT_V4_SERVER_REGISTRY_SYMBOL,
  LinghaoPassportV4Server,
  type LinghaoPassportV4Action,
} from "../lib/auth/linghaoPassportV4Server";

const TEST_SECRET = "test-only-local-secret-0123456789-abc*~def";
const WIN32 = "win32" as NodeJS.Platform;

const TEST_RSA = generateKeyPairSync("rsa", { modulusLength: 2048 });
const OTHER_RSA = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PUBLIC_JWK = TEST_RSA.publicKey.export({ format: "jwk" });
const JWKS = {
  keys: [
    {
      ...PUBLIC_JWK,
      kid: "test-key-1",
      use: "sig",
      alg: "RS256",
    },
  ],
};
const LOCAL_JWKS = createLinghaoPassportV4LocalJwks(JWKS);

interface FixtureClock {
  nowMs: number;
}

interface Cookies {
  readonly rawCookies: Map<string, string>;
}

interface Gate {
  readonly promise: Promise<void>;
  readonly release: () => void;
}

function gate(): Gate {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function base64Url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

function signJwt(
  payload: Record<string, unknown>,
  options: {
    readonly header?: Record<string, unknown>;
    readonly key?: typeof TEST_RSA.privateKey;
    readonly algorithm?: string;
  } = {},
): string {
  const header = {
    alg: "RS256",
    kid: "test-key-1",
    typ: "JWT",
    ...(options.header ?? {}),
  };
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(
    JSON.stringify(payload),
  )}`;
  const signature = cryptoSign(
    options.algorithm ?? "RSA-SHA256",
    Buffer.from(signingInput, "utf8"),
    options.key ?? TEST_RSA.privateKey,
  );
  return `${signingInput}.${base64Url(signature)}`;
}

function validPayload(
  clock: FixtureClock,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const nowSeconds = Math.floor(clock.nowMs / 1000);
  return {
    iss: LINGHAO_PASSPORT_V4_ISSUER,
    sub: "subject-alpha",
    aud: LINGHAO_PASSPORT_V4_CLIENT_ID,
    exp: nowSeconds + 3600,
    iat: nowSeconds,
    nonce: "n".repeat(43),
    ...overrides,
  };
}

function testEnv(): Record<string, string | undefined> {
  return {
    NODE_ENV: "test",
    [LINGHAO_PASSPORT_V4_LOCAL_SELECTOR_ENV]:
      LINGHAO_PASSPORT_V4_LOCAL_SELECTOR_VALUE,
    [LINGHAO_PASSPORT_V4_CLIENT_SECRET_FILE_ENV]:
      LINGHAO_PASSPORT_V4_CLIENT_SECRET_FILE_PATH,
  };
}

function configFor(
  env: Record<string, string | undefined> = testEnv(),
  options: {
    readonly platform?: NodeJS.Platform;
    readonly readSecretFile?: () => string;
    readonly reads?: { count: number };
  } = {},
) {
  return loadLinghaoPassportV4Config(env, {
    platform: options.platform ?? WIN32,
    readSecretFile: () => {
      if (options.reads) options.reads.count += 1;
      return (options.readSecretFile ?? (() => TEST_SECRET))();
    },
  });
}

function request(
  pathname: string,
  options: {
    readonly method?: string;
    readonly cookie?: string;
    readonly body?: string;
    readonly contentType?: string | null;
    readonly origin?: string | null;
    readonly host?: string;
    readonly headers?: Record<string, string>;
  } = {},
): Request {
  const headers = new Headers(options.headers);
  headers.set("host", options.host ?? "127.0.0.1:4200");
  const method = options.method ?? "GET";
  if (method !== "GET") {
    if (options.origin !== null) {
      headers.set("origin", options.origin ?? LINGHAO_PASSPORT_V4_PUBLIC_ORIGIN);
    }
  }
  if (options.cookie !== undefined) headers.set("cookie", options.cookie);
  if (options.body !== undefined) {
    if (options.contentType !== null) {
      headers.set("content-type", options.contentType ?? "application/json");
    }
  }
  return new Request(`${LINGHAO_PASSPORT_V4_PUBLIC_ORIGIN}${pathname}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: options.body }),
  });
}

function absorbCookies(response: Response, jar: Cookies): void {
  for (const raw of response.headers.getSetCookie()) {
    const pair = raw.split(";", 1)[0] ?? "";
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const name = pair.slice(0, separator);
    const rawValue = pair.slice(separator + 1);
    if (/Max-Age=0(?:;|$)/i.test(raw)) {
      jar.rawCookies.delete(name);
    } else {
      jar.rawCookies.set(name, rawValue);
    }
  }
}

function cookieHeader(jar: Cookies): string {
  return [...jar.rawCookies]
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

function cookieRaw(response: Response, name: string): string | undefined {
  return response.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${name}=`));
}

function emptyJar(): Cookies {
  return { rawCookies: new Map() };
}

function cloneJar(jar: Cookies): Cookies {
  return { rawCookies: new Map(jar.rawCookies) };
}

async function jsonBody<T = Record<string, unknown>>(
  response: Response,
): Promise<T> {
  return (await response.json()) as T;
}

function basicCredentials(
  init: RequestInit | undefined,
): { readonly clientId: string; readonly clientSecret: string } | null {
  const headers = new Headers(init?.headers);
  const authorization = headers.get("authorization") ?? "";
  if (!authorization.startsWith("Basic ")) return null;
  const decoded = Buffer.from(
    authorization.slice("Basic ".length),
    "base64",
  ).toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator <= 0) return null;
  const decodeFormComponent = (value: string): string | null =>
    new URLSearchParams(`value=${value}`).get("value");
  const clientId = decodeFormComponent(decoded.slice(0, separator));
  const clientSecret = decodeFormComponent(decoded.slice(separator + 1));
  if (clientId === null || clientSecret === null) return null;
  return {
    clientId,
    clientSecret,
  };
}

function assertBasicClientAuthentication(
  init: RequestInit | undefined,
): void {
  const credentials = basicCredentials(init);
  assert.ok(credentials);
  assert.equal(credentials.clientId, LINGHAO_PASSPORT_V4_CLIENT_ID);
  assert.equal(credentials.clientSecret, TEST_SECRET);
  const authorization = new Headers(init?.headers).get("authorization")!;
  const encodedUserPass = Buffer.from(
    authorization.slice("Basic ".length),
    "base64",
  ).toString("utf8");
  const formEncode = (value: string): string =>
    new URLSearchParams([["value", value]])
      .toString()
      .slice("value=".length);
  assert.equal(
    encodedUserPass,
    `${formEncode(LINGHAO_PASSPORT_V4_CLIENT_ID)}:${formEncode(TEST_SECRET)}`,
  );
}

type PreparedCode = {
  readonly subject: string;
  readonly nonce: string;
};

type RefreshRecord = {
  readonly subject: string;
  readonly nonce: string;
};

class FakeProvider {
  readonly fetchCalls: string[] = [];
  readonly codes = new Map<string, PreparedCode>();
  readonly refreshRecords = new Map<string, RefreshRecord>();
  readonly loginRefreshTokens: string[] = [];
  readonly revokedTokens: string[] = [];
  readonly hangingPaths = new Set<string>();
  readonly clock: FixtureClock;

  discovery: Record<string, unknown>;
  expiresIn = 3600;
  refreshCalls = 0;
  revocationCalls = 0;
  tokenCalls = 0;
  failRevocation = false;
  failRevocationForPrefix: string | null = null;
  failRefresh = false;
  refreshSubjectOverride: string | null = null;
  refreshTokenMode: "rotate" | "missing" | "same" = "rotate";
  tokenResponseOverride: Record<string, unknown> | null = null;
  refreshResponseOverride: Record<string, unknown> | null = null;
  refreshGateBeforeMint: Gate | null = null;
  refreshGateAfterMint: Gate | null = null;
  tokenGate: Gate | null = null;
  private tokenCounter = 1;

  constructor(clock: FixtureClock) {
    this.clock = clock;
    this.discovery = this.defaultDiscovery();
  }

  private defaultDiscovery(): Record<string, unknown> {
    return {
      issuer: LINGHAO_PASSPORT_V4_ISSUER,
      authorization_endpoint: `${LINGHAO_PASSPORT_V4_ISSUER}/login/oauth/authorize`,
      token_endpoint: `${LINGHAO_PASSPORT_V4_ISSUER}/api/login/oauth/access_token`,
      jwks_uri: `${LINGHAO_PASSPORT_V4_ISSUER}/.well-known/jwks`,
      end_session_endpoint: `${LINGHAO_PASSPORT_V4_ISSUER}/logout`,
      revocation_endpoint: `${LINGHAO_PASSPORT_V4_ISSUER}/api/revoke`,
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      id_token_signing_alg_values_supported: ["RS256"],
      token_endpoint_auth_methods_supported: ["client_secret_basic"],
      scopes_supported: ["openid", "profile", "email"],
      grant_types_supported: ["authorization_code", "refresh_token"],
    };
  }

  prepareCode(code: string, prepared: PreparedCode): void {
    this.codes.set(code, prepared);
  }

  readonly fetch: LinghaoPassportV4Fetch = async (input, init) => {
    const url = new URL(String(input));
    this.fetchCalls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.origin !== LINGHAO_PASSPORT_V4_ISSUER) {
      throw new Error("unexpected provider origin");
    }
    if (this.hangingPaths.has(url.pathname)) {
      return this.hangingResponse();
    }

    if (url.pathname === "/.well-known/openid-configuration") {
      return this.json(this.discovery, 200);
    }
    if (url.pathname === "/.well-known/jwks") {
      return this.json(JWKS, 200);
    }
    if (url.pathname === "/api/login/oauth/access_token") {
      assertBasicClientAuthentication(init);
      return this.handleToken(init);
    }
    if (url.pathname === "/api/revoke") {
      return this.handleRevocation(init);
    }
    if (url.pathname === "/logout") {
      return new Response(null, { status: 200 });
    }
    throw new Error("unexpected provider endpoint");
  };

  private hangingResponse(): Response {
    const stream = new ReadableStream<Uint8Array>({
      start() {
        // Headers arrive; the body never does and never closes.
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  private json(body: unknown, status: number): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  private async handleToken(init: RequestInit | undefined): Promise<Response> {
    const form = new URLSearchParams(String(init?.body ?? ""));
    const grantType = form.get("grant_type");
    this.tokenCalls += 1;
    if (grantType === "authorization_code") {
      if (this.tokenGate) await this.tokenGate.promise;
      if (this.tokenResponseOverride) {
        return this.json(this.tokenResponseOverride, 200);
      }
      const code = form.get("code") ?? "";
      const prepared = this.codes.get(code);
      if (!prepared) return this.json({ error: "invalid_grant" }, 400);
      assert.equal(form.get("redirect_uri"), LINGHAO_PASSPORT_V4_REDIRECT_URI);
      assert.ok((form.get("code_verifier") ?? "").length >= 43);

      const refreshToken = `refresh-${prepared.subject}-${this.tokenCounter++}`;
      this.refreshRecords.set(refreshToken, {
        subject: prepared.subject,
        nonce: prepared.nonce,
      });
      this.loginRefreshTokens.push(refreshToken);
      return this.tokenResponse(prepared.subject, prepared.nonce, refreshToken);
    }

    if (grantType === "refresh_token") {
      this.refreshCalls += 1;
      if (this.refreshResponseOverride) {
        return this.json(this.refreshResponseOverride, 200);
      }
      const presented = form.get("refresh_token") ?? "";
      const record = this.refreshRecords.get(presented);
      if (!record || this.failRefresh) {
        return this.json({ error: "invalid_grant" }, 400);
      }
      if (this.refreshGateBeforeMint) {
        await this.refreshGateBeforeMint.promise;
      }
      this.refreshRecords.delete(presented);
      const rotated = `refresh-rotated-${this.tokenCounter++}`;
      this.refreshRecords.set(rotated, {
        subject: record.subject,
        nonce: record.nonce,
      });
      let response = this.tokenResponse(
        this.refreshSubjectOverride ?? record.subject,
        record.nonce,
        rotated,
      );
      if (this.refreshGateAfterMint) {
        await this.refreshGateAfterMint.promise;
      }
      if (this.refreshTokenMode === "missing" || this.refreshTokenMode === "same") {
        const body = (await response.clone().json()) as Record<string, unknown>;
        if (this.refreshTokenMode === "missing") {
          delete body.refresh_token;
        } else {
          body.refresh_token = presented;
        }
        response = this.json(body, 200);
      }
      return response;
    }

    return this.json({ error: "unsupported_grant_type" }, 400);
  }

  private tokenResponse(
    subject: string,
    nonce: string | undefined,
    refreshToken: string,
  ): Response {
    const idToken = this.idToken(subject, nonce);
    return this.json(
      {
        token_type: "Bearer",
        expires_in: this.expiresIn,
        access_token: `access-${subject}-${this.tokenCounter}`,
        refresh_token: refreshToken,
        id_token: idToken,
      },
      200,
    );
  }

  idToken(subject: string, nonce: string | undefined): string {
    const payload = validPayload(this.clock, {
      sub: subject,
      email: "private-person@example.test",
      email_verified: true,
      name: "Private Person",
    });
    if (nonce === undefined) {
      delete payload.nonce;
    } else {
      payload.nonce = nonce;
    }
    return signJwt(payload);
  }

  private handleRevocation(init: RequestInit | undefined): Response {
    this.revocationCalls += 1;
    assertBasicClientAuthentication(init);
    const form = new URLSearchParams(String(init?.body ?? ""));
    const token = form.get("token");
    assert.ok(token);
    if (
      this.failRevocation ||
      (this.failRevocationForPrefix !== null &&
        token.startsWith(this.failRevocationForPrefix))
    ) {
      return this.json({ error: "server_error" }, 500);
    }
    assert.ok(
      form.get("token_type_hint") === "refresh_token" ||
        form.get("token_type_hint") === "access_token",
    );
    this.revokedTokens.push(token);
    this.refreshRecords.delete(token);
    return this.json({}, 200);
  }
}

function setup(options?: {
  readonly expiresIn?: number;
  readonly bodyTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly rateMaximum?: number;
  readonly maxRefreshFlights?: number;
}): {
  readonly clock: FixtureClock;
  readonly provider: FakeProvider;
  readonly server: LinghaoPassportV4Server;
  readonly env: Record<string, string | undefined>;
  readonly secretReads: { count: number };
} {
  const clock: FixtureClock = { nowMs: 1_800_000_000_000 };
  const provider = new FakeProvider(clock);
  provider.expiresIn = options?.expiresIn ?? 3600;
  const env = testEnv();
  const secretReads = { count: 0 };
  const server = new LinghaoPassportV4Server({
    env,
    fetch: provider.fetch,
    now: () => clock.nowMs,
    platform: WIN32,
    readSecretFile: () => {
      secretReads.count += 1;
      return TEST_SECRET;
    },
    ...(options?.bodyTimeoutMs === undefined
      ? {}
      : { bodyTimeoutMs: options.bodyTimeoutMs }),
    ...(options?.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.requestTimeoutMs }),
    ...(options?.maxRefreshFlights === undefined
      ? {}
      : { maxRefreshFlights: options.maxRefreshFlights }),
    startRateLimiter: new LinghaoPassportV4StartRateLimiter({
      windowMs: 10_000,
      maximum: options?.rateMaximum ?? 1000,
      maxBuckets: 128,
      now: () => clock.nowMs,
    }),
  });
  return { clock, provider, server, env, secretReads };
}

async function startTransaction(
  server: LinghaoPassportV4Server,
  jar: Cookies = emptyJar(),
  options: { readonly requestCookie?: string } = {},
): Promise<{ readonly url: URL; readonly jar: Cookies }> {
  const response = await server.handle(
    "start",
    request("/api/auth/linghao-passport-v4/start", {
      method: "POST",
      body: "{}",
      ...(options.requestCookie === undefined
        ? { cookie: cookieHeader(jar) }
        : { cookie: options.requestCookie }),
    }),
  );
  assert.equal(response.status, 200);
  absorbCookies(response, jar);
  const body = await jsonBody<{ authorizationUrl: string }>(response);
  assert.ok(jar.rawCookies.has(LINGHAO_PASSPORT_V4_TRANSACTION_COOKIE));
  assert.ok(jar.rawCookies.has(LINGHAO_PASSPORT_V4_FAMILY_COOKIE));
  return { url: new URL(body.authorizationUrl), jar };
}

async function callbackFor(
  server: LinghaoPassportV4Server,
  provider: FakeProvider,
  jar: Cookies,
  transaction: URL,
  subject: string,
  code: string,
): Promise<Response> {
  const state = transaction.searchParams.get("state");
  const nonce = transaction.searchParams.get("nonce");
  assert.ok(state && nonce);
  provider.prepareCode(code, { subject, nonce });
  return server.handle(
    "callback",
    request(
      `${LINGHAO_PASSPORT_V4_CALLBACK_PATH}?code=${encodeURIComponent(
        code,
      )}&state=${encodeURIComponent(state)}&iss=${encodeURIComponent(
        LINGHAO_PASSPORT_V4_ISSUER,
      )}`,
      { cookie: cookieHeader(jar) },
    ),
  );
}

async function login(
  server: LinghaoPassportV4Server,
  provider: FakeProvider,
  subject: string,
  options: {
    readonly code?: string;
    readonly jar?: Cookies;
  } = {},
): Promise<{ readonly jar: Cookies; readonly session: Record<string, unknown> }> {
  const jar = options.jar ?? emptyJar();
  const transaction = await startTransaction(server, jar);
  const callback = await callbackFor(
    server,
    provider,
    jar,
    transaction.url,
    subject,
    options.code ?? `code-${subject}`,
  );
  assert.equal(callback.status, 303);
  absorbCookies(callback, jar);
  const sessionResponse = await server.handle(
    "session",
    request("/api/auth/linghao-passport-v4/session", {
      cookie: cookieHeader(jar),
    }),
  );
  assert.equal(sessionResponse.status, 200);
  const session = await jsonBody(sessionResponse);
  assert.equal(session.authenticated, true);
  return { jar, session };
}

function rawRequest(
  pathname: string,
  headers: Record<string, string>,
  body: string | ReadableStream<Uint8Array>,
): Request {
  return new Request(`${LINGHAO_PASSPORT_V4_PUBLIC_ORIGIN}${pathname}`, {
    method: "POST",
    headers: {
      host: "127.0.0.1:4200",
      origin: LINGHAO_PASSPORT_V4_PUBLIC_ORIGIN,
      "content-type": "application/json",
      ...headers,
    },
    body,
    ...(typeof body === "string" ? {} : { duplex: "half" }),
  } as RequestInit);
}

function hangingStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start() {
      // Never enqueue and never close.
    },
    cancel() {
      // A hostile peer may never settle cancellation either. Request and
      // response deadlines must not await this promise after they fire.
      return new Promise<void>(() => undefined);
    },
  });
}

function syntheticStats(
  real: Stats,
  overrides: Record<string, unknown> = {},
): Stats {
  return {
    dev: real.dev,
    ino: real.ino,
    mode: real.mode,
    nlink: real.nlink,
    size: real.size,
    isFile: () => real.isFile(),
    isSymbolicLink: () => real.isSymbolicLink(),
    ...overrides,
  } as unknown as Stats;
}

const tests: Array<{ readonly name: string; readonly run: () => Promise<void> }> = [];
function test(name: string, run: () => Promise<void>): void {
  tests.push({ name, run });
}

test("secret intake is gated by exact selector, production, Windows, origin, and exact file reference", async () => {
  const cases: Array<{
    readonly env: Record<string, string | undefined>;
    readonly platform?: NodeJS.Platform;
  }> = [
    { env: {} },
    {
      env: {
        [LINGHAO_PASSPORT_V4_LOCAL_SELECTOR_ENV]: "wrong",
        [LINGHAO_PASSPORT_V4_CLIENT_SECRET_FILE_ENV]:
          LINGHAO_PASSPORT_V4_CLIENT_SECRET_FILE_PATH,
      },
    },
    {
      env: {
        NODE_ENV: "production",
        [LINGHAO_PASSPORT_V4_LOCAL_SELECTOR_ENV]:
          LINGHAO_PASSPORT_V4_LOCAL_SELECTOR_VALUE,
        [LINGHAO_PASSPORT_V4_CLIENT_SECRET_FILE_ENV]:
          LINGHAO_PASSPORT_V4_CLIENT_SECRET_FILE_PATH,
      },
    },
    {
      env: {
        ...testEnv(),
        [LINGHAO_PASSPORT_V4_CLIENT_SECRET_FILE_ENV]:
          "C:\\Users\\sunat\\AppData\\Local\\AIstory\\secrets\\wrong.v1",
      },
    },
    {
      env: {
        NODE_ENV: "test",
        [LINGHAO_PASSPORT_V4_LOCAL_SELECTOR_ENV]:
          LINGHAO_PASSPORT_V4_LOCAL_SELECTOR_VALUE,
      },
    },
  ];

  for (const [index, entry] of cases.entries()) {
    const reads = { count: 0 };
    let fetches = 0;
    const clock: FixtureClock = { nowMs: 1_800_000_000_000 };
    const provider = new FakeProvider(clock);
    const server = new LinghaoPassportV4Server({
      env: entry.env,
      platform: entry.platform ?? WIN32,
      now: () => clock.nowMs,
      fetch: (input, init) => {
        fetches += 1;
        return provider.fetch(input, init);
      },
      readSecretFile: () => {
        reads.count += 1;
        return TEST_SECRET;
      },
    });

    const capability = await server.handle(
      "capabilities",
      request("/api/auth/linghao-passport-v4/capabilities"),
    );
    assert.equal(capability.status, 200);
    assert.deepEqual(await jsonBody(capability), { enabled: false });

    const routes: Array<{
      readonly action: LinghaoPassportV4Action;
      readonly path: string;
      readonly method: string;
      readonly body?: string;
    }> = [
      { action: "start", path: "/api/auth/linghao-passport-v4/start", method: "POST", body: "{}" },
      {
        action: "callback",
        path: `${LINGHAO_PASSPORT_V4_CALLBACK_PATH}?code=x&state=${"a".repeat(43)}`,
        method: "GET",
      },
      { action: "session", path: "/api/auth/linghao-passport-v4/session", method: "GET" },
      { action: "renew", path: "/api/auth/linghao-passport-v4/renew", method: "POST", body: "{}" },
      { action: "draft", path: "/api/auth/linghao-passport-v4/draft", method: "GET" },
      {
        action: "logout",
        path: "/api/auth/linghao-passport-v4/logout",
        method: "POST",
      },
      {
        action: "logged-out",
        path: `/api/auth/linghao-passport-v4/logged-out?state=${"a".repeat(43)}`,
        method: "POST",
      },
    ];
    for (const route of routes) {
      const response = await server.handle(
        route.action,
        request(route.path, {
          method: route.method,
          ...(route.body === undefined ? {} : { body: route.body }),
        }),
      );
      assert.equal(response.status, 404);
      assert.deepEqual(await jsonBody(response), { error: "unavailable" });
    }

    assert.equal(reads.count, 0);
    assert.equal(fetches, 0);
    assert.equal(server.sessions.size(), 0);
    assert.equal(server.transactions.size(), 0);
    assert.equal(server.profiles.size(), 0);
    assert.equal(server.logoutStates.size(), 0);
    assert.equal(server.families.size(), 0);
    assert.equal(
      linghaoPassportV4LocalModeRequested(entry.env, entry.platform ?? WIN32),
      index < 3 ? false : true,
    );
    assert.equal(configFor(entry.env, {
      platform: entry.platform ?? WIN32,
      reads,
    }), null);
    assert.equal(reads.count, 0);
  }

  assert.equal("AISTORY_LINGHAO_PASSPORT_V4_CLIENT_SECRET_ENV" in configModule, false);
  const directEnv = {
    ...testEnv(),
    AISTORY_LINGHAO_PASSPORT_V4_CLIENT_SECRET: "alternate-direct-secret-must-be-ignored",
  };
  const directReads = { count: 0 };
  const directConfig = configFor(directEnv, { reads: directReads });
  assert.ok(directConfig);
  assert.equal(directConfig.clientSecret, TEST_SECRET);
  assert.equal(directReads.count, 1);
  assert.equal(configModule.LINGHAO_PASSPORT_V4_CLIENT_SECRET_FILE_ENV, LINGHAO_PASSPORT_V4_CLIENT_SECRET_FILE_ENV);
});

test("valid config uses only an injected file reader; invalid or throwing readers fail closed", async () => {
  const reads = { count: 0 };
  const config = configFor(testEnv(), { reads });
  assert.ok(config);
  assert.equal(config.clientSecret, TEST_SECRET);
  assert.equal(reads.count, 1);

  assert.equal(
    loadLinghaoPassportV4Config(testEnv(), {
      platform: "linux",
      readSecretFile: () => {
        throw new Error("must not be called");
      },
    }),
    null,
  );
  assert.equal(
    loadLinghaoPassportV4Config(testEnv(), {
      platform: WIN32,
      readSecretFile: () => {
        throw new Error("unreadable");
      },
    }),
    null,
  );
  assert.equal(
    loadLinghaoPassportV4Config(testEnv(), {
      platform: WIN32,
      readSecretFile: () => "short",
    }),
    null,
  );
  assert.equal(
    loadLinghaoPassportV4Config(testEnv(), {
      platform: WIN32,
      readSecretFile: () => `${TEST_SECRET}\n`,
    }),
    null,
  );
});

test("Next internal localhost URL normalization is accepted only behind the exact external Host", async () => {
  const { server } = setup();
  const internal = await server.handle(
    "capabilities",
    new Request(
      "http://localhost:4200/api/auth/linghao-passport-v4/capabilities",
      { headers: { host: "127.0.0.1:4200", accept: "application/json" } },
    ),
  );
  assert.equal(internal.status, 200);
  assert.deepEqual(await jsonBody(internal), { enabled: true });

  const externalLocalhost = await server.handle(
    "capabilities",
    new Request(
      "http://localhost:4200/api/auth/linghao-passport-v4/capabilities",
      { headers: { host: "localhost:4200", accept: "application/json" } },
    ),
  );
  assert.equal(externalLocalhost.status, 404);
});

test("secret file reader rejects structural and content counterexamples through one bounded handle", async () => {
  const testRoot = path.join(process.cwd(), ".tmp", "secret-file-tests");
  mkdirSync(testRoot, { recursive: true });
  const root = mkdtempSync(path.join(testRoot, "case-"));
  const file = path.join(root, "client-secret.v1");
  const valid = TEST_SECRET;
  const write = (bytes: Buffer | string): void => {
    writeFileSync(file, bytes);
  };

  write(valid);
  assert.equal(
    readLinghaoPassportV4ClientSecretFile(file, {
      exactPath: file,
      platform: WIN32,
    }),
    valid,
  );

  const expectReject = (label: string, exactPath = file): void => {
    assert.throws(
      () =>
        readLinghaoPassportV4ClientSecretFile(file, {
          exactPath,
          platform: WIN32,
        }),
      (error: unknown) =>
        error instanceof Error &&
        error.message === "client secret file is unavailable" &&
        !error.message.includes(valid),
      label,
    );
  };

  expectReject("wrong exact path", path.join(root, "other.v1"));

  for (const [label, bytes] of [
    ["too short", Buffer.alloc(31, 0x41)],
    ["too long", Buffer.alloc(257, 0x41)],
    ["BOM", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(valid)])],
    ["NUL", Buffer.from(`${valid.slice(0, 31)}\u0000`)],
    ["CRLF", Buffer.from(`${valid.slice(0, 30)}\r\n`)],
    ["space", Buffer.from(`${valid.slice(0, 31)} `)],
    ["tab", Buffer.from(`${valid.slice(0, 31)}\t`)],
    ["non-ASCII", Buffer.from(`${valid.slice(0, 31)}é`)],
    ["invalid UTF-8", Buffer.from([0x41, 0x42, 0xc3, 0x28, ...Buffer.alloc(40, 0x41)])],
  ] as const) {
    write(bytes as Buffer);
    expectReject(label);
  }

  write(valid);
  const hardLink = path.join(root, "hardlink.v1");
  linkSync(file, hardLink);
  assert.throws(
    () =>
      readLinghaoPassportV4ClientSecretFile(file, {
        exactPath: file,
        platform: WIN32,
      }),
    /client secret file is unavailable/,
  );
  rmSync(hardLink);

  const symlink = path.join(root, "symlink.v1");
  try {
    symlinkSync(file, symlink, "file");
    assert.throws(
      () =>
        readLinghaoPassportV4ClientSecretFile(symlink, {
          exactPath: symlink,
          platform: WIN32,
        }),
      /client secret file is unavailable/,
    );
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !/client secret file is unavailable/.test(error.message)
    ) {
      // Windows without symlink privilege cannot create this counterexample.
      assert.match((error as NodeJS.ErrnoException).code ?? "", /EPERM|EACCES/);
    }
  }

  assert.throws(
    () =>
      readLinghaoPassportV4ClientSecretFile(root, {
        exactPath: root,
        platform: WIN32,
      }),
    /client secret file is unavailable/,
  );

  write(valid);
  const realBefore = lstatSync(file);
  const realPath = realpathSync.native(file);
  const driftFs = (overrides: {
    readonly lstat?: Stats;
    readonly fstat?: Stats;
  }): LinghaoPassportV4SecretFileSystem => {
    let descriptor = -1;
    return {
      lstat: () => overrides.lstat ?? realBefore,
      realpath: () => realPath,
      open: () => {
        descriptor = openSync(file, "r");
        return descriptor;
      },
      fstat: () => overrides.fstat ?? fstatSync(descriptor),
      read: (fd, buffer, offset, length, position) =>
        readSync(fd, buffer, offset, length, position),
      close: (fd) => closeSync(fd),
    };
  };
  assert.throws(
    () =>
      readLinghaoPassportV4ClientSecretFile(file, {
        exactPath: file,
        platform: WIN32,
        fileSystem: driftFs({
          lstat: syntheticStats(realBefore, { ino: 42 }),
        }),
      }),
    /client secret file is unavailable/,
  );
  assert.throws(
    () =>
      readLinghaoPassportV4ClientSecretFile(file, {
        exactPath: file,
        platform: WIN32,
        fileSystem: driftFs({
          fstat: syntheticStats(realBefore, { size: realBefore.size + 1 }),
        }),
      }),
    /client secret file is unavailable/,
  );
  assert.throws(
    () =>
      readLinghaoPassportV4ClientSecretFile(file, {
        exactPath: file,
        platform: "linux",
      }),
    /client secret file is unavailable/,
  );

  rmSync(root, { recursive: true, force: true });
});

test("one versioned global registry is shared across independently evaluated module copies", async () => {
  const holder = globalThis as unknown as Record<PropertyKey, unknown>;
  const original = holder[LINGHAO_PASSPORT_V4_SERVER_REGISTRY_SYMBOL];
  delete holder[LINGHAO_PASSPORT_V4_SERVER_REGISTRY_SYMBOL];
  try {
    const moduleA = await import(
      new URL("../lib/auth/linghaoPassportV4Server.js?copy=a", import.meta.url).href
    );
    const moduleB = await import(
      new URL("../lib/auth/linghaoPassportV4Server.js?copy=b", import.meta.url).href
    );
    const first = moduleA.getLinghaoPassportV4Server();
    const second = moduleB.getLinghaoPassportV4Server();
    assert.equal(first, second);
    assert.equal(getLinghaoPassportV4Server(), first);
    assert.equal(first.sessions, second.sessions);
    assert.equal(first.transactions, second.transactions);
    assert.equal(first.families, second.families);

    const incompatible = (value: unknown): void => {
      holder[LINGHAO_PASSPORT_V4_SERVER_REGISTRY_SYMBOL] = value;
      assert.throws(
        () => moduleA.getLinghaoPassportV4Server(),
        /incompatible Passport server registry/,
      );
    };
    incompatible({ version: 2, key: "aistory.linghao-passport-v4.server-registry.v1", server: first });
    incompatible({ version: 1, key: "aistory.linghao-passport-v4.server-registry.v2", server: first });
    incompatible({ version: 1, key: "aistory.linghao-passport-v4.server-registry.v1", server: null });
    incompatible({ version: 1, key: "aistory.linghao-passport-v4.server-registry.v1", server: {} });

    holder[LINGHAO_PASSPORT_V4_SERVER_REGISTRY_SYMBOL] = {
      version: 1,
      key: "aistory.linghao-passport-v4.server-registry.v1",
      server: first,
    };
    assert.equal(moduleB.getLinghaoPassportV4Server(), first);
  } finally {
    if (original === undefined) {
      delete holder[LINGHAO_PASSPORT_V4_SERVER_REGISTRY_SYMBOL];
    } else {
      holder[LINGHAO_PASSPORT_V4_SERVER_REGISTRY_SYMBOL] = original;
    }
  }
});

test("every bounded store prunes, caps, and fails closed instead of evicting active security bindings", async () => {
  let now = 1_800_000_000_000;
  const identity = {
    issuer: LINGHAO_PASSPORT_V4_ISSUER,
    clientId: LINGHAO_PASSPORT_V4_CLIENT_ID,
    subject: "subject-alpha",
    expiresAt: Math.floor(now / 1000) + 3600,
    issuedAt: Math.floor(now / 1000),
  };
  const profileId = deriveLinghaoPassportV4ProfileId(identity.issuer, identity.subject);

  const sessions = new LinghaoPassportV4SessionStore({
    idleMs: 1000,
    absoluteMs: 10_000,
    maxSessions: 2,
    now: () => now,
  });
  const firstSession = sessions.createAuthenticated(undefined, {
    profileId,
    identity,
    idToken: "id-1",
    accessToken: "access-1",
  });
  const secondSession = sessions.createAuthenticated(undefined, {
    profileId,
    identity,
    idToken: "id-2",
    accessToken: "access-2",
  });
  assert.ok(firstSession && secondSession);
  assert.equal(
    sessions.createAuthenticated(undefined, {
      profileId,
      identity,
      idToken: "id-3",
      accessToken: "access-3",
    }),
    null,
  );
  assert.equal(sessions.size(), 2);
  now += 2000;
  assert.equal(sessions.get(firstSession.id), null);
  assert.ok(sessions.size() <= 2);

  const transactions = new LinghaoPassportV4TransactionStore({
    ttlMs: 1000,
    maxTransactions: 2,
    now: () => now,
  });
  const txInput = () => ({
    state: "a".repeat(43),
    nonce: "b".repeat(43),
    codeVerifier: "c".repeat(43),
  });
  assert.ok(transactions.create(txInput()));
  assert.ok(transactions.create(txInput()));
  assert.equal(transactions.create(txInput()), null);
  assert.equal(transactions.size(), 2);
  now += 2000;
  assert.equal(transactions.size(), 0);
  assert.ok(transactions.create(txInput()));

  const families = new LinghaoPassportV4FamilyStore({
    ttlMs: 1000,
    maxFamilies: 2,
    now: () => now,
  });
  assert.equal(families.reserve("d".repeat(43)), true);
  assert.equal(families.reserve("e".repeat(43)), true);
  assert.equal(families.reserve("f".repeat(43)), false);
  assert.equal(families.size(), 2);
  now += 2000;
  assert.equal(families.size(), 0);

  const logoutStates = new LinghaoPassportV4LogoutStateStore({
    ttlMs: 1000,
    maxResults: 2,
    now: () => now,
  });
  assert.ok(logoutStates.create({ revocationConfirmed: false, upstreamReturnExpected: false }));
  assert.ok(logoutStates.create({ revocationConfirmed: true, upstreamReturnExpected: true }));
  assert.equal(
    logoutStates.create({ revocationConfirmed: false, upstreamReturnExpected: false }),
    null,
  );
  assert.equal(logoutStates.size(), 2);
  now += 2000;
  assert.equal(logoutStates.size(), 0);

  const profiles = new LinghaoPassportV4ProfileStore({
    now: () => now,
    ttlMs: 1000,
    maxProfiles: 2,
  });
  const p1 = profiles.getOrCreate(LINGHAO_PASSPORT_V4_ISSUER, "subject-one");
  const p2 = profiles.getOrCreate(LINGHAO_PASSPORT_V4_ISSUER, "subject-two");
  assert.ok(p1 && p2);
  assert.equal(
    profiles.getOrCreate(LINGHAO_PASSPORT_V4_ISSUER, "subject-three"),
    null,
  );
  assert.equal(profiles.size(), 2);
  assert.equal(profiles.setDraft(p1.profileId, "one"), true);
  assert.equal(profiles.setDraft(p2.profileId, "two"), true);
  assert.equal(profiles.draftSize(), 2);
  now += 2000;
  assert.equal(profiles.size(), 0);
  assert.equal(profiles.draftSize(), 0);

  const limiter = new LinghaoPassportV4StartRateLimiter({
    windowMs: 1000,
    maximum: 2,
    maxBuckets: 2,
    now: () => now,
  });
  assert.equal(limiter.take("a"), true);
  assert.equal(limiter.take("a"), true);
  assert.equal(limiter.take("a"), false);
  assert.equal(limiter.take("b"), true);
  assert.equal(limiter.take("c"), false);
  assert.equal(limiter.size(), 2);
  now += 2000;
  assert.equal(limiter.size(), 0);
  assert.equal(LINGHAO_PASSPORT_V4_MAX_SESSIONS >= 1, true);
  assert.equal(LINGHAO_PASSPORT_V4_MAX_TRANSACTIONS >= 1, true);
  assert.equal(LINGHAO_PASSPORT_V4_MAX_FAMILIES >= 1, true);
  assert.equal(LINGHAO_PASSPORT_V4_MAX_LOGOUT_RESULTS >= 1, true);
  assert.equal(LINGHAO_PASSPORT_V4_MAX_PROFILES >= 1, true);
  assert.equal(LINGHAO_PASSPORT_V4_MAX_RATE_BUCKETS >= 1, true);
});

test("/start is rate limited and a replaced transaction cookie cannot accumulate unreachable state", async () => {
  const limited = setup({ rateMaximum: 2 });
  assert.equal(
    (
      await limited.server.handle(
        "start",
        request("/api/auth/linghao-passport-v4/start", {
          method: "POST",
          body: "{}",
        }),
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await limited.server.handle(
        "start",
        request("/api/auth/linghao-passport-v4/start", {
          method: "POST",
          body: "{}",
        }),
      )
    ).status,
    200,
  );
  const third = await limited.server.handle(
    "start",
    request("/api/auth/linghao-passport-v4/start", {
      method: "POST",
      body: "{}",
    }),
  );
  assert.equal(third.status, 429);
  assert.ok(limited.server.transactions.size() <= 2);
  assert.equal(limited.server.startRateLimiter.size(), 1);

  const bounded = setup();
  const jar = emptyJar();
  for (let index = 0; index < 20; index += 1) {
    const response = await startTransaction(bounded.server, jar);
    assert.ok(response.url);
  }
  assert.equal(bounded.server.transactions.size(), 1);
  assert.equal(bounded.server.families.size(), 1);
});

test("callback rejects adversarial queries and consumes terminal transaction records", async () => {
  {
    const { server, provider } = setup();
    const transaction = await startTransaction(server);
    const response = await server.handle(
      "callback",
      request(
        `${LINGHAO_PASSPORT_V4_CALLBACK_PATH}?state=${"a".repeat(43)}&state=${"b".repeat(43)}&code=good`,
        { cookie: cookieHeader(transaction.jar) },
      ),
    );
    assert.equal(response.status, 400);
    assert.equal(provider.tokenCalls, 0);
    assert.equal(server.transactions.size(), 0);
  }

  {
    const { server, provider } = setup();
    const transaction = await startTransaction(server);
    const response = await server.handle(
      "callback",
      request(
        `${LINGHAO_PASSPORT_V4_CALLBACK_PATH}?state=${"a".repeat(43)}&code=good`,
        { cookie: cookieHeader(transaction.jar) },
      ),
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await jsonBody(response), { error: "invalid_request" });
    assert.equal(provider.tokenCalls, 0);
    assert.equal(server.transactions.size(), 0);
  }

  {
    const { server, provider } = setup();
    const transaction = await startTransaction(server);
    const state = transaction.url.searchParams.get("state")!;
    const response = await server.handle(
      "callback",
      request(
        `${LINGHAO_PASSPORT_V4_CALLBACK_PATH}?error=access_denied&error_description=provider-secret&state=${encodeURIComponent(state)}`,
        { cookie: cookieHeader(transaction.jar) },
      ),
    );
    assert.equal(response.status, 400);
    const body = await jsonBody(response);
    assert.deepEqual(body, { error: "invalid_request" });
    assert.equal(JSON.stringify(body).includes("provider-secret"), false);
    assert.equal(provider.tokenCalls, 0);
    assert.equal(server.transactions.size(), 0);
  }

  {
    const { server, provider } = setup();
    const transaction = await startTransaction(server);
    const state = transaction.url.searchParams.get("state")!;
    const response = await server.handle(
      "callback",
      request(
        `${LINGHAO_PASSPORT_V4_CALLBACK_PATH}/extra?code=good&state=${encodeURIComponent(state)}`,
        { cookie: cookieHeader(transaction.jar) },
      ),
    );
    assert.equal(response.status, 404);
    assert.equal(provider.tokenCalls, 0);
  }

  {
    const { server, provider } = setup();
    const transaction = await startTransaction(server);
    const state = transaction.url.searchParams.get("state")!;
    const response = await server.handle(
      "callback",
      request(
        `${LINGHAO_PASSPORT_V4_CALLBACK_PATH}?code=good&state=${encodeURIComponent(state)}&iss=${encodeURIComponent("https://issuer.example")}`,
        { cookie: cookieHeader(transaction.jar) },
      ),
    );
    assert.equal(response.status, 400);
    assert.equal(provider.tokenCalls, 0);
    assert.equal(server.transactions.size(), 0);
  }

  {
    const { server, provider } = setup();
    const transaction = await startTransaction(server);
    const state = transaction.url.searchParams.get("state")!;
    transaction.jar.rawCookies.set(LINGHAO_PASSPORT_V4_FAMILY_COOKIE, "%ZZ");
    const response = await server.handle(
      "callback",
      request(
        `${LINGHAO_PASSPORT_V4_CALLBACK_PATH}?code=good&state=${encodeURIComponent(state)}`,
        { cookie: cookieHeader(transaction.jar) },
      ),
    );
    assert.equal(response.status, 400);
    assert.equal(provider.tokenCalls, 0);
    assert.equal(server.transactions.size(), 0);
    assert.match(
      cookieRaw(response, LINGHAO_PASSPORT_V4_FAMILY_COOKIE) ?? "",
      /Max-Age=0/,
    );
  }
});

test("ID token verification requires exact typ, safe integer times, bounded lifetime, and verification-only key_ops", async () => {
  const clock: FixtureClock = { nowMs: 1_800_000_000_000 };
  const now = new Date(clock.nowMs);
  const verify = (idToken: string) =>
    verifyLinghaoPassportV4IdToken({
      idToken,
      issuer: LINGHAO_PASSPORT_V4_ISSUER,
      clientId: LINGHAO_PASSPORT_V4_CLIENT_ID,
      keys: LOCAL_JWKS,
      now,
      expectedNonce: "n".repeat(43),
    });

  await assert.doesNotReject(() => verify(signJwt(validPayload(clock))));
  await assert.doesNotReject(() =>
    verify(
      signJwt(
        validPayload(clock, {
          aud: [LINGHAO_PASSPORT_V4_CLIENT_ID, "other-client"],
          azp: LINGHAO_PASSPORT_V4_CLIENT_ID,
        }),
      ),
    ),
  );

  const expectReject = async (token: string, label: string): Promise<void> => {
    await assert.rejects(() => verify(token), /./, label);
  };

  const algorithmNone = `${base64Url(
    JSON.stringify({ alg: "none", kid: "test-key-1", typ: "JWT" }),
  )}.${base64Url(JSON.stringify(validPayload(clock)))}.`;
  await expectReject(algorithmNone, "alg none");
  await expectReject(
    signJwt(validPayload(clock), { header: { alg: "RS512" }, algorithm: "RSA-SHA512" }),
    "alg RS512",
  );
  await expectReject(signJwt(validPayload(clock), { key: OTHER_RSA.privateKey }), "wrong signature");
  await expectReject(signJwt(validPayload(clock), { header: { kid: "unknown-kid" } }), "unknown kid");
  await expectReject(
    signJwt(validPayload(clock), { header: { jku: "https://evil.test/jwks" } }),
    "jku header",
  );
  await expectReject(
    signJwt(validPayload(clock), { header: { jwk: PUBLIC_JWK } }),
    "embedded jwk",
  );
  await expectReject(signJwt(validPayload(clock, { iss: "https://issuer.example" })), "wrong issuer");
  await expectReject(signJwt(validPayload(clock, { aud: "other-client" })), "wrong audience");
  await expectReject(
    signJwt(validPayload(clock, { aud: [LINGHAO_PASSPORT_V4_CLIENT_ID, "other-client"] })),
    "multiple audiences without azp",
  );
  await expectReject(signJwt(validPayload(clock, { nonce: "x".repeat(43) })), "wrong nonce");
  await expectReject(signJwt(validPayload(clock, { nonce: undefined })), "missing nonce");
  await expectReject(
    signJwt(validPayload(clock, { exp: Math.floor(clock.nowMs / 1000) - 1 })),
    "expired token",
  );
  await expectReject(signJwt(validPayload(clock, { iat: Math.floor(clock.nowMs / 1000) + 120 })), "future iat");
  const missingSub = validPayload(clock);
  delete missingSub.sub;
  await expectReject(signJwt(missingSub), "missing sub");

  await expectReject(signJwt(validPayload(clock), { header: { typ: undefined } }), "missing typ");
  await expectReject(signJwt(validPayload(clock), { header: { typ: "jwt" } }), "lowercase typ");
  await expectReject(signJwt(validPayload(clock), { header: { typ: "at+jwt" } }), "other typ");

  const nowSeconds = Math.floor(clock.nowMs / 1000);
  await expectReject(signJwt(validPayload(clock, { iat: nowSeconds + 0.5 })), "fractional iat");
  await expectReject(signJwt(validPayload(clock, { exp: nowSeconds + 3600.5 })), "fractional exp");
  await expectReject(signJwt(validPayload(clock, { iat: -1 })), "negative iat");
  await expectReject(signJwt(validPayload(clock, { exp: -1 })), "negative exp");
  await expectReject(signJwt(validPayload(clock, { iat: nowSeconds + 61 })), "iat beyond sixty seconds");
  await expectReject(
    signJwt(validPayload(clock, { iat: nowSeconds, exp: nowSeconds + 3661 })),
    "lifetime over bound",
  );
  await expectReject(
    signJwt(validPayload(clock, { iat: nowSeconds, exp: nowSeconds })),
    "exp equal iat",
  );
  await assert.doesNotReject(() =>
    verify(signJwt(validPayload(clock, { iat: nowSeconds, exp: nowSeconds + 3660 }))),
  );

  const withVerify = createLinghaoPassportV4LocalJwks({
    keys: [{ ...PUBLIC_JWK, kid: "test-key-1", use: "sig", alg: "RS256", key_ops: ["verify"] }],
  });
  await assert.doesNotReject(() =>
    verifyLinghaoPassportV4IdToken({
      idToken: signJwt(validPayload(clock)),
      issuer: LINGHAO_PASSPORT_V4_ISSUER,
      clientId: LINGHAO_PASSPORT_V4_CLIENT_ID,
      keys: withVerify,
      now,
      expectedNonce: "n".repeat(43),
    }),
  );
  for (const keyOps of [["verify", "sign"], ["sign"], [], "verify", ["verify", "verify"]]) {
    assert.throws(
      () =>
        createLinghaoPassportV4LocalJwks({
          keys: [{ ...PUBLIC_JWK, kid: "test-key-1", key_ops: keyOps }],
        }),
      /key_ops/,
    );
  }
  assert.throws(
    () =>
      createLinghaoPassportV4LocalJwks({
        keys: [
          {
            ...PUBLIC_JWK,
            kid: "test-key-1",
            oth: [{ r: "private", d: "private", t: "private" }],
          },
        ],
      }),
    /private key material/,
  );
});

test("authorization-code and refresh responses require bounded tokens, positive expires_in, and real rotation", async () => {
  const { clock, provider } = setup();
  const config = configFor();
  assert.ok(config);
  const oidc = new LinghaoPassportV4OidcClient({
    config,
    fetch: provider.fetch,
    now: () => clock.nowMs,
  });
  const secrets = createLinghaoPassportV4AuthorizationSecrets();
  provider.prepareCode("code-contract", {
    subject: "subject-alpha",
    nonce: secrets.nonce,
  });
  const valid = await oidc.exchangeAuthorizationCode("code-contract", secrets);
  assert.ok(valid.tokens.refreshToken);

  const baseResponse = {
    token_type: "Bearer",
    expires_in: 3600,
    access_token: "access-token-0123456789",
    refresh_token: "refresh-token-0123456789",
    id_token: provider.idToken("subject-alpha", secrets.nonce),
  };
  const cases: Array<[string, Record<string, unknown>]> = [
    ["missing access token", { ...baseResponse, access_token: undefined }],
    ["empty access token", { ...baseResponse, access_token: "" }],
    ["oversized access token", { ...baseResponse, access_token: "a".repeat(32769) }],
    ["missing id token", { ...baseResponse, id_token: undefined }],
    ["non-compact id token", { ...baseResponse, id_token: "not-a-jwt" }],
    ["missing refresh token", { ...baseResponse, refresh_token: undefined }],
    ["empty refresh token", { ...baseResponse, refresh_token: "" }],
    ["missing expires_in", { ...baseResponse, expires_in: undefined }],
    ["zero expires_in", { ...baseResponse, expires_in: 0 }],
    ["fractional expires_in", { ...baseResponse, expires_in: 1.5 }],
    ["string expires_in", { ...baseResponse, expires_in: "3600" }],
    ["oversized expires_in", { ...baseResponse, expires_in: 365 * 24 * 60 * 60 + 1 }],
  ];
  for (const [label, response] of cases) {
    provider.tokenResponseOverride = response;
    await assert.rejects(
      () => oidc.exchangeAuthorizationCode("code-contract-2", secrets),
      /./,
      label,
    );
  }
  provider.tokenResponseOverride = null;

  const firstRefresh = valid.tokens.refreshToken;
  provider.refreshTokenMode = "missing";
  await assert.rejects(
    () => oidc.refresh(firstRefresh, "subject-alpha", secrets.nonce),
    /new token|refresh token|missing/i,
  );
  provider.refreshTokenMode = "rotate";
  provider.prepareCode("code-contract-3", {
    subject: "subject-alpha",
    nonce: secrets.nonce,
  });
  const secondExchange = await oidc.exchangeAuthorizationCode(
    "code-contract-3",
    secrets,
  );
  provider.refreshTokenMode = "same";
  await assert.rejects(
    () => oidc.refresh(secondExchange.tokens.refreshToken, "subject-alpha", secrets.nonce),
    /new token|rotation/i,
  );
  provider.refreshTokenMode = "rotate";
});

test("outbound deadlines stay armed through headers and hanging response bodies", async () => {
  {
    const { server, provider } = setup({ requestTimeoutMs: 100 });
    provider.hangingPaths.add("/.well-known/openid-configuration");
    const started = Date.now();
    const response = await server.handle(
      "start",
      request("/api/auth/linghao-passport-v4/start", { method: "POST", body: "{}" }),
    );
    assert.equal(response.status, 404);
    assert.ok(Date.now() - started < 1500);
  }

  {
    const { server, provider } = setup({ requestTimeoutMs: 100 });
    provider.hangingPaths.add("/api/login/oauth/access_token");
    const transaction = await startTransaction(server);
    const callback = await callbackFor(
      server,
      provider,
      transaction.jar,
      transaction.url,
      "subject-alpha",
      "code-hanging-token",
    );
    assert.equal(callback.status, 400);
  }

  {
    const { server, provider } = setup({ requestTimeoutMs: 100 });
    provider.hangingPaths.add("/.well-known/jwks");
    const transaction = await startTransaction(server);
    const callback = await callbackFor(
      server,
      provider,
      transaction.jar,
      transaction.url,
      "subject-alpha",
      "code-hanging-jwks",
    );
    assert.equal(callback.status, 400);
  }

  {
    const { server, provider } = setup({ requestTimeoutMs: 100 });
    provider.hangingPaths.add("/api/revoke");
    const loginResult = await login(server, provider, "subject-alpha");
    const started = Date.now();
    const logout = await server.handle(
      "logout",
      request("/api/auth/linghao-passport-v4/logout", {
        method: "POST",
        cookie: cookieHeader(loginResult.jar),
      }),
    );
    assert.equal(logout.status, 303);
    assert.match(logout.headers.get("location") ?? "", /\/auth\/linghao-passport-v4/);
    assert.ok(Date.now() - started < 1500);
    assert.equal(server.sessions.size(), 0);
  }

  {
    const { server, provider } = setup({ requestTimeoutMs: 100 });
    provider.discovery = {
      ...provider.discovery,
      authorization_endpoint: "https://127.0.0.1:8000/login/oauth/authorize",
    };
    const response = await server.handle(
      "start",
      request("/api/auth/linghao-passport-v4/start", { method: "POST", body: "{}" }),
    );
    assert.equal(response.status, 404);
  }
});

test("inbound framing rejects transfer-encoding, ambiguous length, mismatches, caps, and hanging bodies", async () => {
  const { server, provider } = setup({ bodyTimeoutMs: 75 });
  const startPath = "/api/auth/linghao-passport-v4/start";
  const execute = (requestValue: Request) => server.handle("start", requestValue);

  assert.equal(
    (await execute(rawRequest(startPath, { "transfer-encoding": "chunked", "content-length": "2" }, "{}"))).status,
    400,
  );
  assert.equal(
    (await execute(rawRequest(startPath, { "content-length": "2, 2" }, "{}"))).status,
    400,
  );
  assert.equal(
    (await execute(rawRequest(startPath, { "content-length": "+2" }, "{}"))).status,
    400,
  );
  assert.equal(
    (await execute(rawRequest(startPath, { "content-length": "2048" }, "{}"))).status,
    400,
  );
  assert.equal(
    (await execute(rawRequest(startPath, { "content-length": "10" }, "{}"))).status,
    400,
  );
  assert.equal(
    (await execute(rawRequest(startPath, {}, "x".repeat(2048)))).status,
    400,
  );

  const started = Date.now();
  assert.equal(
    (await execute(rawRequest(startPath, { "content-length": "2" }, hangingStream()))).status,
    400,
  );
  assert.ok(Date.now() - started < 1500);

  assert.equal((await execute(rawRequest(startPath, {}, "{}"))).status, 200);
  assert.equal((await execute(rawRequest(startPath, {}, '{"unexpected":true}'))).status, 400);
  assert.equal((await execute(rawRequest(startPath, {}, "{ }"))).status, 200);

  const loginResult = await login(server, provider, "subject-alpha");
  const extraDraft = await server.handle(
    "draft",
    request("/api/auth/linghao-passport-v4/draft", {
      method: "PUT",
      cookie: cookieHeader(loginResult.jar),
      body: JSON.stringify({ text: "x", extra: true }),
    }),
  );
  assert.equal(extraDraft.status, 400);
  const nonEmptyLogout = await server.handle(
    "logout",
    request("/api/auth/linghao-passport-v4/logout", {
      method: "POST",
      cookie: cookieHeader(loginResult.jar),
      body: "{}",
    }),
  );
  assert.equal(nonEmptyLogout.status, 400);
  assert.equal(server.sessions.size(), 1);
});

test("present-but-malformed cookies are expired on every relevant boundary", async () => {
  const { server } = setup();
  const malformedSession = `${LINGHAO_PASSPORT_V4_SESSION_COOKIE}=%ZZ`;
  const assertCleared = (response: Response, name: string): void => {
    assert.match(cookieRaw(response, name) ?? "", /Max-Age=0/);
  };

  const session = await server.handle(
    "session",
    request("/api/auth/linghao-passport-v4/session", {
      cookie: malformedSession,
    }),
  );
  assert.equal(session.status, 200);
  assertCleared(session, LINGHAO_PASSPORT_V4_SESSION_COOKIE);

  const renew = await server.handle(
    "renew",
    request("/api/auth/linghao-passport-v4/renew", {
      method: "POST",
      cookie: malformedSession,
      body: "{}",
    }),
  );
  assert.equal(renew.status, 401);
  assertCleared(renew, LINGHAO_PASSPORT_V4_SESSION_COOKIE);

  const draft = await server.handle(
    "draft",
    request("/api/auth/linghao-passport-v4/draft", {
      cookie: malformedSession,
    }),
  );
  assert.equal(draft.status, 401);
  assertCleared(draft, LINGHAO_PASSPORT_V4_SESSION_COOKIE);

  const callback = await server.handle(
    "callback",
    request(
      `${LINGHAO_PASSPORT_V4_CALLBACK_PATH}?code=good&state=${"s".repeat(43)}`,
      { cookie: `${LINGHAO_PASSPORT_V4_TRANSACTION_COOKIE}=%ZZ` },
    ),
  );
  assert.equal(callback.status, 400);
  assertCleared(callback, LINGHAO_PASSPORT_V4_TRANSACTION_COOKIE);

  const loggedOut = await server.handle(
    "logged-out",
    request(
      `/api/auth/linghao-passport-v4/logged-out?state=${"l".repeat(43)}`,
      {
        method: "POST",
        cookie: `${LINGHAO_PASSPORT_V4_LOGOUT_COOKIE}=%ZZ`,
      },
    ),
  );
  assert.equal(loggedOut.status, 400);
  assertCleared(loggedOut, LINGHAO_PASSPORT_V4_LOGOUT_COOKIE);
});

test("two browser profiles stay isolated; same-family relogin and concurrent callbacks leave one winner", async () => {
  const { server, provider } = setup();
  const alpha = await login(server, provider, "subject-alpha");
  const beta = await login(server, provider, "subject-beta");
  assert.notEqual(
    (alpha.session.profile as Record<string, unknown>).profileId,
    (beta.session.profile as Record<string, unknown>).profileId,
  );

  const put = (jar: Cookies, text: string) =>
    server.handle(
      "draft",
      request("/api/auth/linghao-passport-v4/draft", {
        method: "PUT",
        cookie: cookieHeader(jar),
        body: JSON.stringify({ text }),
      }),
    );
  const get = (jar: Cookies) =>
    server.handle(
      "draft",
      request("/api/auth/linghao-passport-v4/draft", {
        cookie: cookieHeader(jar),
      }),
    );
  assert.equal((await put(alpha.jar, "alpha-private")).status, 200);
  assert.equal((await put(beta.jar, "beta-private")).status, 200);
  assert.deepEqual(await jsonBody(await get(alpha.jar)), { text: "alpha-private" });
  assert.deepEqual(await jsonBody(await get(beta.jar)), { text: "beta-private" });

  const oldCookie = alpha.jar.rawCookies.get(LINGHAO_PASSPORT_V4_SESSION_COOKIE);
  assert.ok(oldCookie);
  const relogin = await login(server, provider, "subject-gamma", { jar: alpha.jar });
  assert.notEqual(
    relogin.jar.rawCookies.get(LINGHAO_PASSPORT_V4_SESSION_COOKIE),
    oldCookie,
  );
  const oldSession = await server.handle(
    "session",
    request("/api/auth/linghao-passport-v4/session", {
      cookie: `${LINGHAO_PASSPORT_V4_SESSION_COOKIE}=${oldCookie}`,
    }),
  );
  assert.equal((await jsonBody(oldSession)).authenticated, false);

  const concurrent = setup();
  const familyJar = emptyJar();
  const firstStart = await startTransaction(concurrent.server, familyJar);
  const familyCookie = `${LINGHAO_PASSPORT_V4_FAMILY_COOKIE}=${
    familyJar.rawCookies.get(LINGHAO_PASSPORT_V4_FAMILY_COOKIE)!
  }`;
  const jarOne = cloneJar(familyJar);
  const secondStart = await startTransaction(concurrent.server, familyJar, {
    requestCookie: familyCookie,
  });
  const jarTwo = cloneJar(familyJar);
  concurrent.provider.tokenCalls = 0;
  concurrent.provider.tokenGate = gate();
  const firstCallback = callbackFor(
    concurrent.server,
    concurrent.provider,
    jarOne,
    firstStart.url,
    "subject-first",
    "code-concurrent-one",
  );
  const secondCallback = callbackFor(
    concurrent.server,
    concurrent.provider,
    jarTwo,
    secondStart.url,
    "subject-second",
    "code-concurrent-two",
  );
  await waitFor(() => concurrent.provider.tokenCalls >= 2, "two concurrent token exchanges");
  concurrent.provider.tokenGate.release();
  const [firstResponse, secondResponse] = await Promise.all([
    firstCallback,
    secondCallback,
  ]);
  assert.equal(firstResponse.status, 303);
  assert.equal(secondResponse.status, 303);
  const oneSession = cookieRaw(firstResponse, LINGHAO_PASSPORT_V4_SESSION_COOKIE);
  const twoSession = cookieRaw(secondResponse, LINGHAO_PASSPORT_V4_SESSION_COOKIE);
  assert.ok(oneSession && twoSession);
  assert.notEqual(oneSession, twoSession);
  const oneValue = oneSession.split("=", 2)[1]!;
  const twoValue = twoSession.split("=", 2)[1]!;
  const oneCheck = await concurrent.server.handle(
    "session",
    request("/api/auth/linghao-passport-v4/session", {
      cookie: `${LINGHAO_PASSPORT_V4_SESSION_COOKIE}=${oneValue}`,
    }),
  );
  const twoCheck = await concurrent.server.handle(
    "session",
    request("/api/auth/linghao-passport-v4/session", {
      cookie: `${LINGHAO_PASSPORT_V4_SESSION_COOKIE}=${twoValue}`,
    }),
  );
  const oneBody = await jsonBody(oneCheck);
  const twoBody = await jsonBody(twoCheck);
  assert.equal(
    Number(oneBody.authenticated === true) + Number(twoBody.authenticated === true),
    1,
  );
  assert.equal(concurrent.server.sessions.size(), 1);
  assert.equal(concurrent.server.families.size(), 1);
  concurrent.provider.tokenGate = null;
});

test("refresh is single-flight, rotates, rejects spent tokens/subject changes, and caps concurrent flights", async () => {
  const { clock, provider, server } = setup({ expiresIn: 120 });
  const loginResult = await login(server, provider, "subject-alpha");
  const firstRefreshToken = provider.loginRefreshTokens[0]!;

  clock.nowMs += 130_000;
  provider.refreshGateBeforeMint = gate();
  const one = server.handle(
    "session",
    request("/api/auth/linghao-passport-v4/session", { cookie: cookieHeader(loginResult.jar) }),
  );
  const two = server.handle(
    "session",
    request("/api/auth/linghao-passport-v4/session", { cookie: cookieHeader(loginResult.jar) }),
  );
  await waitFor(() => provider.refreshCalls === 1, "single refresh");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(provider.refreshCalls, 1);
  provider.refreshGateBeforeMint.release();
  const [oneResponse, twoResponse] = await Promise.all([one, two]);
  assert.equal((await jsonBody(oneResponse)).authenticated, true);
  assert.equal((await jsonBody(twoResponse)).authenticated, true);
  assert.equal(provider.refreshCalls, 1);

  const renewedResponse = await server.handle(
    "renew",
    request("/api/auth/linghao-passport-v4/renew", {
      method: "POST",
      cookie: cookieHeader(loginResult.jar),
      body: "{}",
    }),
  );
  assert.equal(renewedResponse.status, 200);
  assert.equal((await jsonBody(renewedResponse)).renewed, true);
  assert.equal(provider.refreshCalls, 2);

  const config = configFor();
  assert.ok(config);
  const oidc = new LinghaoPassportV4OidcClient({ config, fetch: provider.fetch, now: () => clock.nowMs });
  const spent = await oidc
    .refresh(firstRefreshToken, "subject-alpha")
    .then(() => false)
    .catch(() => true);
  assert.equal(spent, true);

  const capped = setup({ expiresIn: 120, maxRefreshFlights: 1 });
  const alpha = await login(capped.server, capped.provider, "subject-alpha");
  const beta = await login(capped.server, capped.provider, "subject-beta");
  capped.clock.nowMs += 130_000;
  capped.provider.refreshGateBeforeMint = gate();
  const alphaRefresh = capped.server.handle(
    "session",
    request("/api/auth/linghao-passport-v4/session", { cookie: cookieHeader(alpha.jar) }),
  );
  await waitFor(() => capped.provider.refreshCalls === 1, "alpha refresh in flight");
  const betaResponse = await capped.server.handle(
    "session",
    request("/api/auth/linghao-passport-v4/session", { cookie: cookieHeader(beta.jar) }),
  );
  assert.equal((await jsonBody(betaResponse)).authenticated, false);
  assert.equal(capped.provider.refreshCalls, 1);
  capped.provider.refreshGateBeforeMint.release();
  assert.equal((await jsonBody(await alphaRefresh)).authenticated, true);

  const missing = setup({ expiresIn: 120 });
  const missingLogin = await login(missing.server, missing.provider, "subject-alpha");
  missing.clock.nowMs += 130_000;
  missing.provider.refreshTokenMode = "missing";
  const missingResponse = await missing.server.handle(
    "session",
    request("/api/auth/linghao-passport-v4/session", {
      cookie: cookieHeader(missingLogin.jar),
    }),
  );
  assert.equal((await jsonBody(missingResponse)).authenticated, false);
  assert.equal(missing.server.sessions.size(), 0);

  const same = setup({ expiresIn: 120 });
  const sameLogin = await login(same.server, same.provider, "subject-alpha");
  same.clock.nowMs += 130_000;
  same.provider.refreshTokenMode = "same";
  const sameResponse = await same.server.handle(
    "session",
    request("/api/auth/linghao-passport-v4/session", {
      cookie: cookieHeader(sameLogin.jar),
    }),
  );
  assert.equal((await jsonBody(sameResponse)).authenticated, false);
  assert.equal(same.server.sessions.size(), 0);

  const mismatch = setup({ expiresIn: 120 });
  const mismatchLogin = await login(mismatch.server, mismatch.provider, "subject-alpha");
  mismatch.clock.nowMs += 130_000;
  mismatch.provider.refreshSubjectOverride = "subject-other";
  const mismatchResponse = await mismatch.server.handle(
    "session",
    request("/api/auth/linghao-passport-v4/session", {
      cookie: cookieHeader(mismatchLogin.jar),
    }),
  );
  assert.equal((await jsonBody(mismatchResponse)).authenticated, false);
  assert.equal(mismatch.server.sessions.size(), 0);
});

test("draft GET/PUT uses the same freshness path and explicit renew without a refresh token fails closed", async () => {
  const expired = setup({ expiresIn: 120 });
  const loginResult = await login(expired.server, expired.provider, "subject-alpha");
  assert.equal(
    (
      await expired.server.handle(
        "draft",
        request("/api/auth/linghao-passport-v4/draft", {
          method: "PUT",
          cookie: cookieHeader(loginResult.jar),
          body: JSON.stringify({ text: "private" }),
        }),
      )
    ).status,
    200,
  );
  expired.clock.nowMs += 130_000;
  expired.provider.failRefresh = true;
  const draftAfterExpiry = await expired.server.handle(
    "draft",
    request("/api/auth/linghao-passport-v4/draft", {
      cookie: cookieHeader(loginResult.jar),
    }),
  );
  assert.equal(draftAfterExpiry.status, 401);
  assert.match(
    cookieRaw(draftAfterExpiry, LINGHAO_PASSPORT_V4_SESSION_COOKIE) ?? "",
    /Max-Age=0/,
  );
  assert.equal(expired.server.sessions.size(), 0);

  const refreshed = setup({ expiresIn: 120 });
  const refreshedLogin = await login(refreshed.server, refreshed.provider, "subject-alpha");
  refreshed.clock.nowMs += 130_000;
  const draftAfterRefresh = await refreshed.server.handle(
    "draft",
    request("/api/auth/linghao-passport-v4/draft", {
      cookie: cookieHeader(refreshedLogin.jar),
    }),
  );
  assert.equal(draftAfterRefresh.status, 200);
  assert.equal(refreshed.provider.refreshCalls, 1);

  const noRefresh = setup();
  const noRefreshLogin = await login(noRefresh.server, noRefresh.provider, "subject-alpha");
  const liveId = noRefreshLogin.jar.rawCookies.get(LINGHAO_PASSPORT_V4_SESSION_COOKIE);
  assert.ok(liveId);
  const live = noRefresh.server.sessions.peek(liveId);
  assert.ok(live);
  delete live.refreshToken;
  const renew = await noRefresh.server.handle(
    "renew",
    request("/api/auth/linghao-passport-v4/renew", {
      method: "POST",
      cookie: cookieHeader(noRefreshLogin.jar),
      body: "{}",
    }),
  );
  assert.equal(renew.status, 401);
  assert.equal(noRefresh.server.sessions.size(), 0);
});

test("logout is a server 303 form flow with no endSessionUrl DTO and truthful one-time outcomes", async () => {
  const { server, provider } = setup();
  const loginResult = await login(server, provider, "subject-alpha");
  const logout = await server.handle(
    "logout",
    request("/api/auth/linghao-passport-v4/logout", {
      method: "POST",
      cookie: cookieHeader(loginResult.jar),
    }),
  );
  assert.equal(logout.status, 303);
  const location = logout.headers.get("location");
  assert.ok(location);
  const endSession = new URL(location);
  assert.equal(endSession.origin, LINGHAO_PASSPORT_V4_ISSUER);
  assert.equal(endSession.pathname, "/logout");
  assert.ok(endSession.searchParams.get("id_token_hint"));
  assert.equal(endSession.searchParams.get("client_id"), LINGHAO_PASSPORT_V4_CLIENT_ID);
  assert.equal(
    endSession.searchParams.get("post_logout_redirect_uri"),
    "http://127.0.0.1:4200/auth/linghao-passport-v4",
  );
  assert.match(endSession.searchParams.get("state") ?? "", /^[A-Za-z0-9_-]{43}$/);
  assert.equal(await logout.text(), "");
  absorbCookies(logout, loginResult.jar);
  assert.equal(loginResult.jar.rawCookies.has(LINGHAO_PASSPORT_V4_SESSION_COOKIE), false);
  assert.ok(loginResult.jar.rawCookies.has(LINGHAO_PASSPORT_V4_LOGOUT_COOKIE));
  assert.equal(server.sessions.size(), 0);

  const state = endSession.searchParams.get("state")!;
  const loggedOut = await server.handle(
    "logged-out",
    request(`/api/auth/linghao-passport-v4/logged-out?state=${encodeURIComponent(state)}`, {
      method: "POST",
      cookie: cookieHeader(loginResult.jar),
    }),
  );
  assert.equal(loggedOut.status, 200);
  assert.deepEqual(await jsonBody(loggedOut), {
    localLoggedOut: true,
    revocationConfirmed: true,
    upstreamReturnConfirmed: true,
  });
  absorbCookies(loggedOut, loginResult.jar);
  assert.equal(loginResult.jar.rawCookies.has(LINGHAO_PASSPORT_V4_LOGOUT_COOKIE), false);
  const replay = await server.handle(
    "logged-out",
    request(`/api/auth/linghao-passport-v4/logged-out?state=${encodeURIComponent(state)}`, {
      method: "POST",
      cookie: cookieHeader(loginResult.jar),
    }),
  );
  assert.equal(replay.status, 400);

  const failed = setup();
  const failedLogin = await login(failed.server, failed.provider, "subject-alpha");
  failed.provider.failRevocation = true;
  const failedLogout = await failed.server.handle(
    "logout",
    request("/api/auth/linghao-passport-v4/logout", {
      method: "POST",
      cookie: cookieHeader(failedLogin.jar),
    }),
  );
  assert.equal(failedLogout.status, 303);
  const failedLocation = failedLogout.headers.get("location");
  assert.ok(failedLocation);
  assert.equal(new URL(failedLocation).origin, LINGHAO_PASSPORT_V4_PUBLIC_ORIGIN);
  assert.equal(new URL(failedLocation).pathname, "/auth/linghao-passport-v4");
  assert.notEqual(new URL(failedLocation).searchParams.get("state"), null);
  absorbCookies(failedLogout, failedLogin.jar);
  const failedState = new URL(failedLocation).searchParams.get("state")!;
  const failedOutcome = await failed.server.handle(
    "logged-out",
    request(
      `/api/auth/linghao-passport-v4/logged-out?state=${encodeURIComponent(failedState)}`,
      {
        method: "POST",
        cookie: cookieHeader(failedLogin.jar),
      },
    ),
  );
  assert.deepEqual(await jsonBody(failedOutcome), {
    localLoggedOut: true,
    revocationConfirmed: false,
    upstreamReturnConfirmed: false,
  });
  assert.equal(failed.server.sessions.size(), 0);

  const pending = setup();
  const pendingTransaction = await startTransaction(pending.server);
  const lateCallbackCookies = cookieHeader(pendingTransaction.jar);
  const pendingState = pendingTransaction.url.searchParams.get("state")!;
  const pendingLogout = await pending.server.handle(
    "logout",
    request("/api/auth/linghao-passport-v4/logout", {
      method: "POST",
      cookie: lateCallbackCookies,
    }),
  );
  assert.equal(pendingLogout.status, 303);
  assert.match(
    cookieRaw(pendingLogout, LINGHAO_PASSPORT_V4_TRANSACTION_COOKIE) ?? "",
    /Max-Age=0/,
  );
  assert.match(
    cookieRaw(pendingLogout, LINGHAO_PASSPORT_V4_FAMILY_COOKIE) ?? "",
    /Max-Age=0/,
  );
  assert.equal(pending.server.transactions.size(), 0);
  assert.equal(pending.server.families.size(), 0);
  const lateCallback = await pending.server.handle(
    "callback",
    request(
      `${LINGHAO_PASSPORT_V4_CALLBACK_PATH}?code=late&state=${encodeURIComponent(pendingState)}&iss=${encodeURIComponent(LINGHAO_PASSPORT_V4_ISSUER)}`,
      { cookie: lateCallbackCookies },
    ),
  );
  assert.equal(lateCallback.status, 400);
  assert.equal(pending.provider.tokenCalls, 0);
  assert.equal(pending.server.sessions.size(), 0);

  const noSession = await failed.server.handle(
    "logout",
    request("/api/auth/linghao-passport-v4/logout", { method: "POST" }),
  );
  assert.equal(noSession.status, 303);
  const noSessionLocation = noSession.headers.get("location");
  assert.ok(noSessionLocation);
  assert.equal(new URL(noSessionLocation).origin, LINGHAO_PASSPORT_V4_PUBLIC_ORIGIN);
  const noSessionJar = emptyJar();
  absorbCookies(noSession, noSessionJar);
  const noSessionState = new URL(noSessionLocation).searchParams.get("state");
  assert.ok(noSessionState);
  const noSessionOutcome = await failed.server.handle(
    "logged-out",
    request(
      `/api/auth/linghao-passport-v4/logged-out?state=${encodeURIComponent(noSessionState)}`,
      {
        method: "POST",
        cookie: cookieHeader(noSessionJar),
      },
    ),
  );
  assert.deepEqual(await jsonBody(noSessionOutcome), {
    localLoggedOut: true,
    revocationConfirmed: false,
    upstreamReturnConfirmed: false,
  });
});

test("upstream refresh/logout racing revokes every minted rotated token before confirmation in both orderings", async () => {
  for (const ordering of ["before-mint", "after-mint"] as const) {
    const { clock, server, provider } = setup({ expiresIn: 120 });
    const loginResult = await login(server, provider, "subject-alpha");
    const firstRefresh = provider.loginRefreshTokens[0]!;
    clock.nowMs += 130_000;
    const refreshGate = gate();
    if (ordering === "before-mint") {
      provider.refreshGateBeforeMint = refreshGate;
    } else {
      provider.refreshGateAfterMint = refreshGate;
    }
    const refreshResponse = server.handle(
      "session",
      request("/api/auth/linghao-passport-v4/session", {
        cookie: cookieHeader(loginResult.jar),
      }),
    );
    await waitFor(() => provider.refreshCalls === 1, `${ordering} refresh in flight`);
    const logoutResponse = server.handle(
      "logout",
      request("/api/auth/linghao-passport-v4/logout", {
        method: "POST",
        cookie: cookieHeader(loginResult.jar),
      }),
    );
    await waitFor(() => provider.revocationCalls >= 1, `${ordering} original revocation`);
    refreshGate.release();
    const [refresh, logout] = await Promise.all([refreshResponse, logoutResponse]);
    assert.equal(logout.status, 303);
    assert.equal(new URL(logout.headers.get("location") ?? "http://invalid").pathname, "/logout");
    assert.equal((await jsonBody(refresh)).authenticated, false);
    assert.equal(server.sessions.size(), 0);
    assert.equal(provider.refreshRecords.size, 0);
    assert.equal(provider.refreshRecords.has(firstRefresh), false);
    assert.ok(provider.revokedTokens.some((token) => token.startsWith("refresh-rotated-")));
  }

  {
    const { clock, server, provider } = setup({ expiresIn: 120 });
    const loginResult = await login(server, provider, "subject-alpha");
    clock.nowMs += 130_000;
    const refreshGate = gate();
    provider.refreshGateAfterMint = refreshGate;
    provider.failRevocationForPrefix = "refresh-rotated";
    const refreshResponse = server.handle(
      "session",
      request("/api/auth/linghao-passport-v4/session", {
        cookie: cookieHeader(loginResult.jar),
      }),
    );
    await waitFor(() => provider.refreshCalls === 1, "cleanup refresh in flight");
    const logoutResponse = server.handle(
      "logout",
      request("/api/auth/linghao-passport-v4/logout", {
        method: "POST",
        cookie: cookieHeader(loginResult.jar),
      }),
    );
    await waitFor(() => provider.revocationCalls >= 1, "cleanup original revocation");
    refreshGate.release();
    const [refresh, logout] = await Promise.all([refreshResponse, logoutResponse]);
    assert.equal((await jsonBody(refresh)).authenticated, false);
    assert.equal(logout.status, 303);
    assert.equal(new URL(logout.headers.get("location") ?? "http://invalid").origin, LINGHAO_PASSPORT_V4_PUBLIC_ORIGIN);
    assert.equal(server.sessions.size(), 0);
    assert.equal(provider.refreshRecords.size, 1);
    const jar = cloneJar(loginResult.jar);
    absorbCookies(logout, jar);
    const state = new URL(logout.headers.get("location") ?? "http://invalid").searchParams.get("state");
    assert.ok(state);
    const outcome = await server.handle(
      "logged-out",
      request(`/api/auth/linghao-passport-v4/logged-out?state=${encodeURIComponent(state)}`, {
        method: "POST",
        cookie: cookieHeader(jar),
      }),
    );
    assert.equal((await jsonBody(outcome)).revocationConfirmed, false);
  }
});

test("static middleware, UI, launcher, dependency, and source checks close R1 regressions", async () => {
  const repoRoot = [
    fileURLToPath(new URL("..", import.meta.url)),
    fileURLToPath(new URL("../../../output/repo/", import.meta.url)),
  ].find((candidate) =>
    existsSync(path.join(candidate, "lib/auth/linghaoPassportV4Config.ts")),
  );
  assert.ok(repoRoot, "repository overlay root must be resolvable");
  const required = [
    "lib/auth/linghaoPassportV4Public.ts",
    "lib/auth/linghaoPassportV4Config.ts",
    "lib/auth/linghaoPassportV4SecretFile.ts",
    "lib/auth/linghaoPassportV4Oidc.ts",
    "lib/auth/linghaoPassportV4Session.ts",
    "lib/auth/linghaoPassportV4Server.ts",
    "app/api/auth/linghao-passport-v4/capabilities/route.ts",
    "app/api/auth/linghao-passport-v4/start/route.ts",
    "app/api/auth/linghao-passport-v4/callback/route.ts",
    "app/api/auth/linghao-passport-v4/session/route.ts",
    "app/api/auth/linghao-passport-v4/renew/route.ts",
    "app/api/auth/linghao-passport-v4/draft/route.ts",
    "app/api/auth/linghao-passport-v4/logout/route.ts",
    "app/api/auth/linghao-passport-v4/logged-out/route.ts",
    "app/auth/linghao-passport-v4/page.tsx",
    "components/LinghaoPassportV4LocalPanel.tsx",
    "scripts/test-linghao-passport-v4.ts",
    "scripts/start-aistory-linghao-passport-v4-local.ps1",
  ];
  for (const relative of required) {
    assert.equal(existsSync(path.join(repoRoot, relative)), true, relative);
  }
  const packagePath = path.join(repoRoot, "package.json");
  if (existsSync(packagePath)) {
    const packageDocument = JSON.parse(
      readFileSync(packagePath, "utf8"),
    ) as {
      readonly dependencies?: Record<string, string>;
    };
    assert.equal(packageDocument.dependencies?.jose, "6.2.3");
    assert.equal(packageDocument.dependencies?.["openid-client"], undefined);
  }

  const sourceFiles = required
    .filter((relative) => /\.(?:ts|tsx|ps1)$/.test(relative))
    .map((relative) => path.join(repoRoot, relative));

  const component = readFileSync(
    path.join(repoRoot, "components", "LinghaoPassportV4LocalPanel.tsx"),
    "utf8",
  );
  assert.doesNotMatch(component, /storyNamespace|setActiveStoryNamespace|isStableAccountNamespace/);
  assert.match(component, /<form method="post" action="\/api\/auth\/linghao-passport-v4\/logout">/);
  assert.doesNotMatch(component, /endSessionUrl|id_token_hint|allowedEndSessionUrl/);
  assert.doesNotMatch(component, /const logout = async/);
  assert.match(component, /hasExactKeys/);
  assert.match(component, /logoutNoticeRequestRef/);
  assert.match(component, /existing\?\.state === state/);
  assert.match(component, /@\/lib\/auth\/linghaoPassportV4Public/);
  assert.doesNotMatch(component, /linghaoPassportV4Config/);
  const publicSource = readFileSync(
    path.join(repoRoot, "lib/auth/linghaoPassportV4Public.ts"),
    "utf8",
  );
  assert.doesNotMatch(
    publicSource,
    /node:|CLIENT_SECRET|secrets\\linghao-passport-v4|AISTORY_/,
  );
  assert.match(
    publicSource,
    /灵号通行证 v4 本地测试用户/,
  );

  const forbiddenPatterns: Array<[RegExp, string]> = [
    [/\bfrom\s+["'][^"']*aiUser/i, "old AIUser import"],
    [/\bfrom\s+["'][^"']*phone/i, "phone identity import"],
    [/\bfrom\s+["'][^"']*billing/i, "billing import"],
    [/\bfrom\s+["'][^"']*account\/me/i, "account/me import"],
    [/\bfrom\s+["'][^"']*cloud/i, "cloud import"],
    [/\bfrom\s+["'][^"']*supabase/i, "Supabase authorization import"],
    [/\bfrom\s+["'][^"']*\/admin/i, "admin authorization import"],
    [/\bfrom\s+["']openid-client["']/, "openid-client dependency"],
    [/\brequire\(["'][^"']*(?:aiUser|phone|billing|supabase|admin)/i, "legacy require"],
    [/offline_access/, "forbidden scope"],
    [/product\.access/, "forbidden scope"],
    [/storyNamespace|setActiveStoryNamespace/, "story namespace access"],
    [/\bendSessionUrl\b/, "token-bearing end-session DTO"],
  ];
  for (const file of sourceFiles) {
    if (file.endsWith("test-linghao-passport-v4.ts")) continue;
    const source = readFileSync(file, "utf8");
    for (const [pattern, label] of forbiddenPatterns) {
      assert.equal(pattern.test(source), false, `${label}: ${file}`);
    }
  }

  const configSource = readFileSync(
    path.join(repoRoot, "lib/auth/linghaoPassportV4Config.ts"),
    "utf8",
  );
  assert.doesNotMatch(configSource, /AISTORY_LINGHAO_PASSPORT_V4_CLIENT_SECRET(?!_FILE)/);
  const directSecretReaders = sourceFiles
    .filter((file) => !file.endsWith("test-linghao-passport-v4.ts"))
    .filter((file) => /\.(?:ts|tsx)$/.test(file))
    .filter((file) =>
      /AISTORY_LINGHAO_PASSPORT_V4_CLIENT_SECRET(?!_FILE)/.test(
        readFileSync(file, "utf8"),
      ),
    );
  assert.deepEqual(directSecretReaders, []);

  const serverText = readFileSync(
    path.join(repoRoot, "lib/auth/linghaoPassportV4Server.ts"),
    "utf8",
  );
  assert.doesNotMatch(serverText, /endSessionUrl/);
  assert.match(serverText, /Symbol\.for\(/);
  assert.match(serverText, /incompatible Passport server registry/);

  const middlewarePatchPath = path.join(repoRoot, "..", "middleware.patch");
  if (existsSync(middlewarePatchPath)) {
    const patch = readFileSync(middlewarePatchPath, "utf8");
    assert.match(patch, /^diff --git a\/middleware\.ts b\/middleware\.ts/m);
    assert.match(patch, /pathname\.startsWith\("\/api\/auth\/linghao-passport-v4\/"\)/);
    assert.match(patch, /pathname === "\/auth\/linghao-passport-v4"/);
    assert.doesNotMatch(patch, /cookies\.has|aistory_linghao_passport_v4_session_v1/);
    assert.doesNotMatch(patch, /forged|Path=\//);
    const removed = patch
      .split(/\r?\n/)
      .filter((line) => line.startsWith("-") && !line.startsWith("---"));
    assert.deepEqual(removed, []);
    assert.equal((patch.match(/^@@/gm) ?? []).length, 1);
  } else {
    const middleware = readFileSync(path.join(repoRoot, "middleware.ts"), "utf8");
    const apiBoundary = 'pathname.startsWith("/api/auth/linghao-passport-v4/")';
    const pageBoundary = 'pathname === "/auth/linghao-passport-v4"';
    assert.match(middleware, /pathname\.startsWith\("\/api\/auth\/linghao-passport-v4\/"\)/);
    assert.match(middleware, /pathname === "\/auth\/linghao-passport-v4"/);
    const supabaseBoundary = middleware.indexOf("const supabaseUrl");
    assert.ok(supabaseBoundary > 0);
    assert.ok(middleware.indexOf(apiBoundary) < supabaseBoundary);
    assert.ok(middleware.indexOf(pageBoundary) < supabaseBoundary);
    assert.doesNotMatch(middleware, /aistory_linghao_passport_v4_session_v1/);
    assert.doesNotMatch(middleware, /runtime:\s*["']experimental-edge["']/);
  }

  const launcher = readFileSync(
    path.join(repoRoot, "scripts/start-aistory-linghao-passport-v4-local.ps1"),
    "utf8",
  );
  assert.match(launcher, /127\.0\.0\.1/);
  assert.match(launcher, /4200/);
  assert.match(launcher, /AISTORY_LINGHAO_PASSPORT_V4_CLIENT_SECRET_FILE/);
  assert.match(launcher, /AreAccessRulesProtected/);
  assert.match(launcher, /S-1-5-18/);
  assert.match(launcher, /next\\dist\\bin\\next/);
  assert.match(launcher, /AIstory-e2e-runs\\linghao-passport-v4/);
  assert.match(launcher, /Copy-VerifiedCandidateFile/);
  assert.match(launcher, /New-Item -ItemType Junction/);
  assert.match(launcher, /candidate-manifest\.json/);
  assert.match(launcher, /reactStrictMode: true/);
  assert.match(
    launcher,
    /\$nodeCommand\s+\$candidateNextEntry\s+dev\s+\$candidateRoot\s+--webpack/,
  );
  const runtimeAllowlist = launcher.match(
    /\$RuntimeRelativeFiles\s*=\s*@\(([\s\S]*?)\r?\n\)/,
  )?.[1];
  assert.ok(runtimeAllowlist);
  const runtimeFiles = [...runtimeAllowlist.matchAll(/"([^"]+)"/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(runtimeFiles, [
    "lib\\auth\\linghaoPassportV4Public.ts",
    "lib\\auth\\linghaoPassportV4Config.ts",
    "lib\\auth\\linghaoPassportV4SecretFile.ts",
    "lib\\auth\\linghaoPassportV4Oidc.ts",
    "lib\\auth\\linghaoPassportV4Session.ts",
    "lib\\auth\\linghaoPassportV4Server.ts",
    "app\\api\\auth\\linghao-passport-v4\\capabilities\\route.ts",
    "app\\api\\auth\\linghao-passport-v4\\start\\route.ts",
    "app\\api\\auth\\linghao-passport-v4\\callback\\route.ts",
    "app\\api\\auth\\linghao-passport-v4\\session\\route.ts",
    "app\\api\\auth\\linghao-passport-v4\\renew\\route.ts",
    "app\\api\\auth\\linghao-passport-v4\\draft\\route.ts",
    "app\\api\\auth\\linghao-passport-v4\\logout\\route.ts",
    "app\\api\\auth\\linghao-passport-v4\\logged-out\\route.ts",
    "app\\auth\\linghao-passport-v4\\page.tsx",
    "components\\LinghaoPassportV4LocalPanel.tsx",
  ]);
  assert.match(
    launcher,
    /\$CandidateBasePath\s*=\s*Join-Path\s*\(\s*Split-Path -Parent \$repoRoot\s*\)\s*\$CandidateBaseDirectoryName/,
  );
  assert.doesNotMatch(launcher, /LOCALAPPDATA|AppData\\Local\\AIstory\\e2e-runs/i);
  const cleanupScopeStart = launcher.indexOf(
    "# Enter the cleanup scope before creating the junction",
  );
  const cleanupScopeTry = launcher.lastIndexOf("try {", cleanupScopeStart);
  const junctionCreation = launcher.indexOf(
    "$junctionItem = New-Item -ItemType Junction",
  );
  const cleanupScopeFinally = launcher.indexOf("finally {", junctionCreation);
  assert.ok(
    cleanupScopeTry >= 0 &&
      cleanupScopeTry < cleanupScopeStart &&
      cleanupScopeStart < junctionCreation,
  );
  assert.ok(junctionCreation >= 0 && cleanupScopeFinally > junctionCreation);
  assert.match(
    launcher,
    /\$runState\.status -in @\("starting", "running"\)/,
  );
  assert.match(
    launcher,
    /\[string\]\$candidateNodeModulesItem\.Target/,
  );
  assert.match(
    launcher,
    /Remove-Item -LiteralPath \$candidateNodeModules -Force/,
  );
  const junctionRemoval = launcher.indexOf(
    "Remove-Item -LiteralPath $candidateNodeModules -Force",
  );
  const guaranteedEnvironmentRestore = launcher.indexOf(
    "# Environment restoration must run even if junction inspection/removal",
  );
  const environmentRestoreFinally = launcher.lastIndexOf(
    "finally {",
    guaranteedEnvironmentRestore,
  );
  assert.ok(
    junctionRemoval >= 0 &&
      junctionRemoval < environmentRestoreFinally &&
      environmentRestoreFinally < guaranteedEnvironmentRestore,
  );
  assert.match(launcher, /if \(\$hadSelector\)[\s\S]*?\$previousSelector/);
  assert.match(launcher, /if \(\$hadSecretFile\)[\s\S]*?\$previousSecretFile/);
  assert.match(
    launcher,
    /if \(\$hadTelemetryDisabled\)[\s\S]*?\$previousTelemetryDisabled/,
  );
  assert.doesNotMatch(launcher, /node_modules\\\.bin\\next\.cmd/);
  assert.doesNotMatch(launcher, /pnpm\s+exec/);
  assert.match(launcher, /retired direct-secret environment variable must be absent/);
  assert.match(launcher, /exactly current user and LocalSystem/);
  assert.doesNotMatch(launcher, /setx|\.env\.local|Start-Process|Get-Content.*secret/i);
});

let passed = 0;
const failures: Array<{ readonly name: string; readonly error: unknown }> = [];
for (const testCase of tests) {
  try {
    await testCase.run();
    passed += 1;
    console.log(`ok ${passed} - ${testCase.name}`);
  } catch (error) {
    failures.push({ name: testCase.name, error });
    console.error(`not ok - ${testCase.name}`);
    console.error(error);
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} test(s) failed, ${passed} passed.`);
  process.exitCode = 1;
} else {
  console.log(`\nAll ${passed} tests passed.`);
}

