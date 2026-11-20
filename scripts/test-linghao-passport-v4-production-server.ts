import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";

import {
  LINGHAO_PASSPORT_V4_PRODUCTION_PATHS,
  LINGHAO_PASSPORT_V4_PRODUCTION_REGISTRATION,
  LINGHAO_PASSPORT_V4_PRODUCTION_REGISTRATION_SHA256,
  type LinghaoPassportV4ProductionConfiguration,
} from "../lib/auth/linghaoPassportV4ProductionContract";
import {
  LINGHAO_PASSPORT_V4_PRODUCTION_CALLBACK,
  LINGHAO_PASSPORT_V4_PRODUCTION_CLIENT_ID,
  LINGHAO_PASSPORT_V4_PRODUCTION_ISSUER,
  LINGHAO_PASSPORT_V4_PRODUCTION_ORIGIN,
} from "../lib/auth/linghaoPassportV4ProductionPublic";
import {
  LINGHAO_PASSPORT_V4_FAMILY_COOKIE,
  LINGHAO_PASSPORT_V4_LOGOUT_COOKIE,
  LINGHAO_PASSPORT_V4_PRODUCT_SESSION_COOKIE,
  LINGHAO_PASSPORT_V4_TRANSACTION_COOKIE,
} from "../lib/auth/linghaoPassportV4ProductionCookies";
import {
  LinghaoPassportV4ProductionServer,
} from "../lib/auth/linghaoPassportV4ProductionServer";
import type {
  LinghaoPassportV4BeginLogoutResult,
  LinghaoPassportV4CommitCallbackInput,
  LinghaoPassportV4CommitCallbackResult,
  LinghaoPassportV4CommitRefreshResult,
  LinghaoPassportV4ConsumeCallbackResult,
  LinghaoPassportV4DurableAuthority,
  LinghaoPassportV4LogoutInspection,
  LinghaoPassportV4LogoutResult,
  LinghaoPassportV4ReserveStartInput,
  LinghaoPassportV4ReserveStartResult,
  LinghaoPassportV4RevocationWork,
  LinghaoPassportV4SessionRead,
} from "../lib/auth/linghaoPassportV4DurableAuthority";
import type { LinghaoPassportV4Fetch } from "../lib/auth/linghaoPassportV4Oidc";

const NOW = Date.UTC(2026, 10, 19, 20, 0, 0);
const CLIENT_SECRET = "production-server-test-secret-0123456789";
const HASH = "a".repeat(64);
const keyOne = generateKeyPairSync("rsa", { modulusLength: 2048 });
const keyTwo = generateKeyPairSync("rsa", { modulusLength: 2048 });

function configuration(): LinghaoPassportV4ProductionConfiguration {
  return {
    schema: "aistory.linghao-passport-v4-production-config.v1",
    registrationSha256: LINGHAO_PASSPORT_V4_PRODUCTION_REGISTRATION_SHA256,
    secretRef: LINGHAO_PASSPORT_V4_PRODUCTION_REGISTRATION.credentialReference.referenceId,
    secretFile: LINGHAO_PASSPORT_V4_PRODUCTION_PATHS.clientSecretFile,
    stateSealKeyRef: "ref_aistory_linghao_passport_v4_state_seal_v1",
    stateSealKeyFile: LINGHAO_PASSPORT_V4_PRODUCTION_PATHS.stateSealKeyFile,
    registryReceiptFile: LINGHAO_PASSPORT_V4_PRODUCTION_PATHS.registryReceiptFile,
    registryReceiptSha256: HASH,
    hostReceiptFile: LINGHAO_PASSPORT_V4_PRODUCTION_PATHS.hostReceiptFile,
    hostReceiptSha256: "b".repeat(64),
    stateDirectory: LINGHAO_PASSPORT_V4_PRODUCTION_PATHS.stateDirectory,
    recipientUid: 1001,
    recipientGid: 1001,
    proxyRequestOrigin: "https://127.0.0.1:4200",
    authRepository: "supabase",
    authDatabaseGateVersion: "20261119120000",
    ingressRateBucketHeader: "x-aistory-passport-rate-bucket",
  };
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function signIdToken(
  key: typeof keyOne,
  kid: string,
  nonce: string,
  subject: string,
): string {
  const header = base64url(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
  const payload = base64url(JSON.stringify({
    iss: LINGHAO_PASSPORT_V4_PRODUCTION_ISSUER,
    sub: subject,
    aud: LINGHAO_PASSPORT_V4_PRODUCTION_CLIENT_ID,
    iat: Math.floor(NOW / 1000),
    exp: Math.floor(NOW / 1000) + 1800,
    nonce,
    name: "private-name-must-not-project",
    email: "private@example.invalid",
  }));
  const input = `${header}.${payload}`;
  return `${input}.${base64url(cryptoSign("RSA-SHA256", Buffer.from(input), key.privateKey))}`;
}

class FakeProvider {
  readonly prepared = new Map<string, { nonce: string; subject: string }>();
  readonly revoked: string[] = [];
  activeKey: 1 | 2 = 1;
  jwksCalls = 0;

  prepare(code: string, nonce: string, subject: string): void {
    this.prepared.set(code, { nonce, subject });
  }

  readonly fetch: LinghaoPassportV4Fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, LINGHAO_PASSPORT_V4_PRODUCTION_ISSUER);
    if (url.pathname === "/.well-known/openid-configuration") {
      return Response.json({
        issuer: LINGHAO_PASSPORT_V4_PRODUCTION_ISSUER,
        authorization_endpoint: `${LINGHAO_PASSPORT_V4_PRODUCTION_ISSUER}/login/oauth/authorize`,
        token_endpoint: `${LINGHAO_PASSPORT_V4_PRODUCTION_ISSUER}/api/login/oauth/access_token`,
        jwks_uri: `${LINGHAO_PASSPORT_V4_PRODUCTION_ISSUER}/.well-known/jwks`,
        end_session_endpoint: `${LINGHAO_PASSPORT_V4_PRODUCTION_ISSUER}/logout`,
        revocation_endpoint: `${LINGHAO_PASSPORT_V4_PRODUCTION_ISSUER}/api/revoke`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic"],
        scopes_supported: ["openid", "profile", "email"],
        grant_types_supported: ["authorization_code", "refresh_token"],
      });
    }
    if (url.pathname === "/.well-known/jwks") {
      this.jwksCalls += 1;
      const key = this.activeKey === 1 ? keyOne : keyTwo;
      const publicJwk = key.publicKey.export({ format: "jwk" });
      return Response.json({
        keys: [{
          ...publicJwk,
          kid: `production-test-key-${this.activeKey}`,
          use: "sig",
          alg: "RS256",
          key_ops: ["verify"],
        }],
      });
    }
    if (url.pathname === "/api/login/oauth/access_token") {
      assert.match(String(init?.headers && new Headers(init.headers).get("authorization")), /^Basic /);
      const form = new URLSearchParams(String(init?.body ?? ""));
      assert.equal(form.get("grant_type"), "authorization_code");
      assert.equal(form.get("redirect_uri"), LINGHAO_PASSPORT_V4_PRODUCTION_CALLBACK);
      assert.ok((form.get("code_verifier") ?? "").length >= 43);
      const code = form.get("code") ?? "";
      const prepared = this.prepared.get(code);
      if (!prepared) return Response.json({ error: "invalid_grant" }, { status: 400 });
      const key = this.activeKey === 1 ? keyOne : keyTwo;
      return Response.json({
        token_type: "Bearer",
        expires_in: 1800,
        access_token: `access-${code}-${this.activeKey}`,
        id_token: signIdToken(
          key,
          `production-test-key-${this.activeKey}`,
          prepared.nonce,
          prepared.subject,
        ),
      });
    }
    if (url.pathname === "/api/revoke") {
      const form = new URLSearchParams(String(init?.body ?? ""));
      const token = form.get("token");
      if (token) this.revoked.push(token);
      return new Response("", { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected provider path: ${url.pathname}`);
  };
}

type Transaction = {
  input: LinghaoPassportV4ReserveStartInput;
  status: "pending" | "consumed" | "completed" | "terminal";
  completionHash?: string;
  sessionResultEnvelope?: string;
};
type SessionRecord = {
  familyHash: string;
  sessionHash: string;
  principalKey: string;
  authenticatedAtMs: number;
  expiresAtMs: number;
  idTokenHintEnvelope: string | null;
  active: boolean;
};
type LogoutRecord = { stateHash: string; consumed: boolean; confirmed: boolean };
type RevocationRecord = Extract<LinghaoPassportV4RevocationWork, { status: "claimed" }>;

class FakeAuthority implements LinghaoPassportV4DurableAuthority {
  readonly transactions = new Map<string, Transaction>();
  readonly sessions = new Map<string, SessionRecord>();
  readonly logoutResults = new Map<string, LogoutRecord>();
  readonly revocations: RevocationRecord[] = [];
  throwAfterCommitOnce = true;
  corruptLogoutHint = false;
  commitCalls = 0;

  async assertReady(): Promise<void> {}
  async reserveStart(input: LinghaoPassportV4ReserveStartInput): Promise<LinghaoPassportV4ReserveStartResult> {
    this.transactions.set(input.transactionHash, { input, status: "pending" });
    return { status: "reserved", expiresAtMs: NOW + 600_000 };
  }
  async cancelStart(transactionHash: string): Promise<void> {
    const row = this.transactions.get(transactionHash);
    if (row) row.status = "terminal";
  }
  async consumeCallback(transactionHash: string, stateHash: string): Promise<LinghaoPassportV4ConsumeCallbackResult> {
    const row = this.transactions.get(transactionHash);
    if (!row) return { status: "rejected", reason: "missing" };
    if (row.status === "completed" && row.sessionResultEnvelope) {
      return { status: "completed", sessionResultEnvelope: row.sessionResultEnvelope };
    }
    if (row.status !== "pending" || row.input.stateHash !== stateHash) {
      row.status = "terminal";
      return { status: "rejected", reason: row.input.stateHash === stateHash ? "terminal" : "state_mismatch" };
    }
    row.status = "consumed";
    return {
      status: "accepted",
      familyHash: row.input.familyHash,
      transactionHash,
      nonceHash: row.input.nonceHash,
      verifierEnvelope: row.input.verifierEnvelope,
    };
  }
  async commitCallback(input: LinghaoPassportV4CommitCallbackInput): Promise<LinghaoPassportV4CommitCallbackResult> {
    this.commitCalls += 1;
    const row = this.transactions.get(input.transactionHash);
    if (!row || row.input.familyHash !== input.familyHash) return { status: "rejected" };
    if (row.status === "completed") {
      return row.completionHash === input.completionHash && row.sessionResultEnvelope
        ? { status: "replayed", sessionResultEnvelope: row.sessionResultEnvelope, absoluteExpiresAtMs: input.providerExpiresAtMs }
        : { status: "rejected" };
    }
    if (row.status !== "consumed") return { status: "rejected" };
    row.status = "completed";
    row.completionHash = input.completionHash;
    row.sessionResultEnvelope = input.sessionResultEnvelope;
    this.sessions.set(input.sessionHash, {
      familyHash: input.familyHash,
      sessionHash: input.sessionHash,
      principalKey: input.principalKey,
      authenticatedAtMs: NOW,
      expiresAtMs: input.providerExpiresAtMs,
      idTokenHintEnvelope: input.idTokenHintEnvelope,
      active: true,
    });
    this.revocations.push({
      status: "claimed",
      outboxHash: input.accessTokenFingerprint,
      tokenContextHash: input.accessTokenFingerprint,
      tokenKind: "access_token",
      tokenEnvelope: input.accessTokenEnvelope,
    });
    if (this.throwAfterCommitOnce) {
      this.throwAfterCommitOnce = false;
      throw new Error("simulated response loss after commit");
    }
    return {
      status: "committed",
      sessionResultEnvelope: input.sessionResultEnvelope,
      absoluteExpiresAtMs: input.providerExpiresAtMs,
    };
  }
  async readSession(sessionHash: string): Promise<LinghaoPassportV4SessionRead> {
    const row = this.sessions.get(sessionHash);
    if (!row?.active || row.expiresAtMs <= NOW) return { status: "invalid" };
    return {
      status: "authenticated",
      principalKey: row.principalKey,
      familyHash: row.familyHash,
      sessionHash: row.sessionHash,
      generation: 1,
      authenticatedAtMs: row.authenticatedAtMs,
      expiresAtMs: row.expiresAtMs,
    };
  }
  async beginRefresh() { return { status: "rejected" } as const; }
  async commitRefresh(): Promise<LinghaoPassportV4CommitRefreshResult> {
    return { status: "rejected" };
  }
  async failRefresh(): Promise<void> {}
  async beginLogout(input: {
    familyHash: string;
    sessionHash: string;
    receiptHash: string;
    stateHash: string;
    upstreamReturnExpected: boolean;
  }): Promise<LinghaoPassportV4BeginLogoutResult> {
    const session = this.sessions.get(input.sessionHash);
    if (!session || !session.active || session.familyHash !== input.familyHash) {
      return { status: "missing", localLoggedOut: true, revocationPending: false, idTokenHintEnvelope: null };
    }
    session.active = false;
    this.logoutResults.set(input.receiptHash, { stateHash: input.stateHash, consumed: false, confirmed: true });
    return {
      status: "revoked",
      localLoggedOut: true,
      revocationPending: false,
      resultExpiresAtMs: NOW + 600_000,
      idTokenHintEnvelope: this.corruptLogoutHint ? "corrupt" : session.idTokenHintEnvelope,
    };
  }
  async claimRevocation(): Promise<LinghaoPassportV4RevocationWork> {
    return this.revocations.shift() ?? { status: "empty" };
  }
  async completeRevocation(): Promise<void> {}
  async inspectLogoutResult(receiptHash: string): Promise<LinghaoPassportV4LogoutInspection> {
    const row = this.logoutResults.get(receiptHash);
    return row && !row.consumed ? { status: "ready", revocationConfirmed: row.confirmed } : { status: "invalid" };
  }
  async consumeLogoutResult(
    receiptHash: string,
    stateHash: string,
    upstreamReturnConfirmed: boolean,
  ): Promise<LinghaoPassportV4LogoutResult> {
    const row = this.logoutResults.get(receiptHash);
    if (!row || row.consumed || row.stateHash !== stateHash) {
      if (row) row.consumed = true;
      return { status: "invalid" };
    }
    row.consumed = true;
    return {
      status: "consumed",
      localLoggedOut: true,
      revocationConfirmed: row.confirmed,
      upstreamReturnConfirmed,
    };
  }
}

function request(
  path: string,
  init: RequestInit & { cookie?: string } = {},
): Request {
  const headers = new Headers(init.headers);
  headers.set("host", "play.hibcglobal.com");
  if (init.cookie) headers.set("cookie", init.cookie);
  return new Request(`${LINGHAO_PASSPORT_V4_PRODUCTION_ORIGIN}${path}`, { ...init, headers });
}

function post(path: string, cookie?: string): Request {
  return request(path, {
    method: "POST",
    cookie,
    headers: {
      origin: LINGHAO_PASSPORT_V4_PRODUCTION_ORIGIN,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      "content-length": "2",
      "x-aistory-passport-rate-bucket": "c".repeat(64),
    },
    body: "{}",
  });
}

function cookies(response: Response): Map<string, string> {
  const lines = (response.headers as Headers & { getSetCookie(): string[] }).getSetCookie();
  const output = new Map<string, string>();
  for (const line of lines) {
    const match = /^([^=]+)=([^;]*)/.exec(line);
    if (match) output.set(match[1]!, match[2]!);
  }
  return output;
}

function cookieHeader(values: Map<string, string>, names: readonly string[]): string {
  return names.map((name) => `${name}=${values.get(name) ?? ""}`).join("; ");
}

async function login(
  server: LinghaoPassportV4ProductionServer,
  provider: FakeProvider,
  code: string,
  subject: string,
) {
  const start = await server.handle("start", post("/api/auth/linghao-passport-v4/start"));
  assert.equal(start.status, 200);
  const startBody = await start.json() as { authorizationUrl: string };
  const authorization = new URL(startBody.authorizationUrl);
  assert.equal(authorization.origin, LINGHAO_PASSPORT_V4_PRODUCTION_ISSUER);
  assert.equal(authorization.pathname, "/login/oauth/authorize");
  assert.equal(authorization.searchParams.get("scope"), "openid profile email");
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  const state = authorization.searchParams.get("state")!;
  const nonce = authorization.searchParams.get("nonce")!;
  provider.prepare(code, nonce, subject);
  const startCookies = cookies(start);
  const family = startCookies.get(LINGHAO_PASSPORT_V4_FAMILY_COOKIE)!;
  const transaction = startCookies.get(LINGHAO_PASSPORT_V4_TRANSACTION_COOKIE)!;
  const callbackCookie = cookieHeader(startCookies, [
    LINGHAO_PASSPORT_V4_FAMILY_COOKIE,
    LINGHAO_PASSPORT_V4_TRANSACTION_COOKIE,
  ]);
  const callbackPath = `/api/auth/linghao-passport-v4/callback?code=${code}&state=${state}&iss=${encodeURIComponent(LINGHAO_PASSPORT_V4_PRODUCTION_ISSUER)}`;
  const callback = await server.handle("callback", request(callbackPath, { cookie: callbackCookie }));
  assert.equal(callback.status, 303);
  assert.match(callback.headers.get("location") ?? "", /status=authenticated/);
  const product = cookies(callback).get(LINGHAO_PASSPORT_V4_PRODUCT_SESSION_COOKIE)!;
  assert.match(product, /^[A-Za-z0-9_-]{43}$/);
  return { family, transaction, product, state, callbackPath };
}

const authority = new FakeAuthority();
const provider = new FakeProvider();
const materials = {
  configuration: configuration(),
  clientSecret: CLIENT_SECRET,
  stateSealKey: new Uint8Array(Buffer.alloc(32, 7)),
  authority,
};
const closed = new LinghaoPassportV4ProductionServer({ materials, publicEntry: false, fetch: provider.fetch, now: () => NOW });
const closedCapability = await closed.handle("capabilities", request("/api/auth/linghao-passport-v4/capabilities"));
assert.deepEqual(await closedCapability.json(), { enabled: true, mode: "production", publicEntry: false });
assert.equal((await closed.handle("start", post("/api/auth/linghao-passport-v4/start"))).status, 404);

const server = new LinghaoPassportV4ProductionServer({ materials, publicEntry: true, fetch: provider.fetch, now: () => NOW });
const hostile = new Request(`${LINGHAO_PASSPORT_V4_PRODUCTION_ORIGIN}/api/auth/linghao-passport-v4/capabilities`, {
  headers: { host: "evil.invalid" },
});
assert.equal((await server.handle("capabilities", hostile)).status, 404);

const first = await login(server, provider, "code-one", "subject-one");
assert.equal(authority.commitCalls, 2, "response-loss commit must reconcile through exact replay");
assert.ok(provider.revoked.includes("access-code-one-1"));

const firstSession = await server.handle("session", request("/api/auth/linghao-passport-v4/session", {
  cookie: `${LINGHAO_PASSPORT_V4_PRODUCT_SESSION_COOKIE}=${first.product}`,
}));
assert.equal(firstSession.status, 200);
const firstAccount = await firstSession.json() as Record<string, unknown>;
assert.equal((firstAccount.account as Record<string, unknown>).authType, "passport_v4");
assert.equal(Object.hasOwn(firstAccount.account as object, "userId"), false);

const wrongFamily = "w".repeat(43);
const wrongReplay = await server.handle("callback", request(first.callbackPath, {
  cookie: `${LINGHAO_PASSPORT_V4_FAMILY_COOKIE}=${wrongFamily}; ${LINGHAO_PASSPORT_V4_TRANSACTION_COOKIE}=${first.transaction}`,
}));
assert.match(wrongReplay.headers.get("location") ?? "", /status=failed/);
assert.equal(cookies(wrongReplay).has(LINGHAO_PASSPORT_V4_PRODUCT_SESSION_COOKIE), false);

const exactReplay = await server.handle("callback", request(first.callbackPath, {
  cookie: `${LINGHAO_PASSPORT_V4_FAMILY_COOKIE}=${first.family}; ${LINGHAO_PASSPORT_V4_TRANSACTION_COOKIE}=${first.transaction}`,
}));
assert.match(exactReplay.headers.get("location") ?? "", /status=authenticated/);

authority.corruptLogoutHint = true;
const fallbackLogout = await server.handle("logout", request("/api/auth/linghao-passport-v4/logout", {
  method: "POST",
  cookie: `${LINGHAO_PASSPORT_V4_FAMILY_COOKIE}=${first.family}; ${LINGHAO_PASSPORT_V4_PRODUCT_SESSION_COOKIE}=${first.product}`,
  headers: {
    origin: LINGHAO_PASSPORT_V4_PRODUCTION_ORIGIN,
    "sec-fetch-site": "same-origin",
    "content-type": "application/x-www-form-urlencoded",
    "content-length": "0",
  },
  body: "",
}));
assert.equal(fallbackLogout.status, 303);
assert.match(fallbackLogout.headers.get("location") ?? "", /status=logged-out&revocation=confirmed/);
assert.equal(cookies(fallbackLogout).get(LINGHAO_PASSPORT_V4_PRODUCT_SESSION_COOKIE), "");

authority.corruptLogoutHint = false;
provider.activeKey = 2;
const second = await login(server, provider, "code-two", "subject-two");
assert.equal(provider.jwksCalls, 2, "new signing kid must trigger one pinned JWKS refresh");

const upstreamLogout = await server.handle("logout", request("/api/auth/linghao-passport-v4/logout", {
  method: "POST",
  cookie: `${LINGHAO_PASSPORT_V4_FAMILY_COOKIE}=${second.family}; ${LINGHAO_PASSPORT_V4_PRODUCT_SESSION_COOKIE}=${second.product}`,
  headers: {
    origin: LINGHAO_PASSPORT_V4_PRODUCTION_ORIGIN,
    "sec-fetch-site": "same-origin",
    "content-type": "application/x-www-form-urlencoded",
    "content-length": "0",
  },
  body: "",
}));
assert.equal(upstreamLogout.status, 303);
const upstreamUrl = new URL(upstreamLogout.headers.get("location")!);
assert.equal(upstreamUrl.origin, LINGHAO_PASSPORT_V4_PRODUCTION_ISSUER);
assert.equal(upstreamUrl.pathname, "/logout");
const logoutState = upstreamUrl.searchParams.get("state")!;
const logoutReceipt = cookies(upstreamLogout).get(LINGHAO_PASSPORT_V4_LOGOUT_COOKIE)!;
const loggedOutRequest = () => post(
  `/api/auth/linghao-passport-v4/logged-out?state=${logoutState}`,
  `${LINGHAO_PASSPORT_V4_LOGOUT_COOKIE}=${logoutReceipt}`,
);
const loggedOut = await server.handle("logged-out", loggedOutRequest());
assert.equal(loggedOut.status, 200);
assert.deepEqual(await loggedOut.json(), {
  status: "consumed",
  localLoggedOut: true,
  revocationConfirmed: true,
  upstreamReturnConfirmed: true,
});
assert.equal((await server.handle("logged-out", loggedOutRequest())).status, 400);

const afterLogoutReplay = await server.handle("callback", request(second.callbackPath, {
  cookie: `${LINGHAO_PASSPORT_V4_FAMILY_COOKIE}=${second.family}; ${LINGHAO_PASSPORT_V4_TRANSACTION_COOKIE}=${second.transaction}`,
}));
assert.match(afterLogoutReplay.headers.get("location") ?? "", /status=failed/);

const third = await login(server, provider, "code-three", "subject-three");
const accountClears = await server.revokeProductSessionForAccount(request("/api/account/me", {
  method: "DELETE",
  cookie: `${LINGHAO_PASSPORT_V4_FAMILY_COOKIE}=${third.family}; ${LINGHAO_PASSPORT_V4_PRODUCT_SESSION_COOKIE}=${third.product}`,
  headers: { origin: LINGHAO_PASSPORT_V4_PRODUCTION_ORIGIN, "sec-fetch-site": "same-origin" },
}));
assert.equal(accountClears?.length, 4);

console.log("PASS_LINGHAO_PASSPORT_V4_PRODUCTION_SERVER");
console.log(JSON.stringify({
  callbackCommitResponseLossReconciled: true,
  completedReplayFamilyBound: true,
  jwksRotationRefetched: provider.jwksCalls,
  localLogoutFallbackCleared: true,
  oneTimeLogoutReceipt: true,
  accountLogoutBarrier: true,
  publicEntryEnabled: false,
  externalDeploymentPerformed: false,
}));
