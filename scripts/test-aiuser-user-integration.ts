import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
import { createHash, hkdfSync, randomBytes } from "node:crypto";
import { EncryptJWT, exportJWK, generateKeyPair, SignJWT } from "jose";
import { AIUSER_ENDPOINTS, AIUSER_IDENTITY_COOKIE, AIUSER_TRANSACTION_COOKIE, AIUSER_PENDING_COOKIE_PREFIX,
  readAiUserTransactionHash } from "../lib/auth/aiUserOidcCallback";
import { AIUSER_OIDC_PRODUCTION_BETA_REGISTRATION as tuple,
  AIUSER_OIDC_PRODUCTION_BETA_REGISTRATION_SHA256 as tupleHash } from "../lib/auth/aiUserOidcProductionBeta";
import { createAiUserProductSession, createAiUserUserRuntime, AIUSER_PRODUCT_SESSION_COOKIE,
  aiUserSessionDigest, AIUSER_USER_INTEGRATION_ENV, clearAiUserProductCookie } from "../lib/auth/aiUserProductSession";
import { aiUserPublicAccount } from "../lib/auth/aiUserAccountPublic";
import { aiUserUserCapabilities, readAiUserBusinessSession, logoutAiUserBusinessSession, claimAiUserReplayOnce } from "../lib/auth/aiUserOidcCallbackServer";
import { rejectUnboundCloudProgressPrincipal } from "../lib/supabase/guard";
import { authorizeCredentialAccess } from "../lib/credentials/serverPolicy";
import * as accountRoute from "../app/api/account/me/route";

let externalNetwork = 0;
let persistentWrites = 0;
let checks = 0;
const undo: Array<() => void> = [];
function trap(target: object, name: string, write = false) {
  const descriptor = Object.getOwnPropertyDescriptor(target, name)!;
  Object.defineProperty(target, name, { ...descriptor, value: () => {
    if (write) persistentWrites++; else externalNetwork++;
    throw Error("EXTERNAL_EFFECT_FORBIDDEN");
  } });
  undo.push(() => Object.defineProperty(target, name, descriptor));
}
trap(globalThis, "fetch");
for (const target of [http, https]) for (const name of ["request", "get"]) trap(target, name);
for (const name of ["connect", "createConnection"]) trap(net, name);
for (const target of [fs, fsp]) for (const name of ["writeFile", "appendFile", "mkdir", "rename", "unlink", "rm"]) trap(target, name, true);
for (const name of ["writeFileSync", "appendFileSync", "mkdirSync", "renameSync", "unlinkSync", "rmSync", "createWriteStream"]) trap(fs, name, true);
syncBuiltinESMExports();

const savedMode = process.env[AIUSER_USER_INTEGRATION_ENV];
try {
  const pair = await generateKeyPair("ES256", { extractable: true });
  const jwk = { ...await exportJWK(pair.publicKey), kid: "synthetic", alg: "ES256", use: "sig" };
  const secret = randomBytes(48).toString("base64url");
  const base = 1900000000000;
  const cookieOf = (response: Response, name: string) => response.headers.getSetCookie().find((item) => item.startsWith(`${name}=`))!.split(";")[0]!;
  const readRequest = (cookies: string) => new Request(`${tuple.publicOrigin}/api/account/me`, { headers: { cookie: cookies } });
  const logoutRequest = (cookies: string, headers: Record<string, string> = {}) => new Request(`${tuple.publicOrigin}/api/account/me`, {
    method: "DELETE", headers: { cookie: cookies, origin: tuple.publicOrigin, "sec-fetch-site": "same-origin", ...headers },
  });
  type Options = { accessTyp?: string | null; idTyp?: string; membership?: number; upstreamStatus?: number;
    accessTtl?: number; wrongAudience?: boolean; authTime?: unknown };
  async function fixture(options: Options = {}) {
    let now = base;
    let exchanges = 0;
    let storeFailed = false;
    const markers = new Set<string>();
    const attempts = new Map<string, URL>();
    const deps = {
      clientSecret: secret, now: () => now, allowStart: () => true,
      isClaimed: async (digest: string) => { if (storeFailed) throw Error("private-store-failure"); return markers.has(digest); },
      claimOnce: async (digest: string) => { if (storeFailed) throw Error("private-store-failure");
        if (markers.has(digest)) return false; markers.add(digest); return true; },
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url === AIUSER_ENDPOINTS.discovery) return Response.json({ issuer: tuple.issuerUrl,
          authorization_endpoint: AIUSER_ENDPOINTS.authorization, token_endpoint: AIUSER_ENDPOINTS.token,
          jwks_uri: AIUSER_ENDPOINTS.jwks, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["client_secret_basic"], id_token_signing_alg_values_supported: ["ES256"],
          scopes_supported: ["openid", "product.access"] });
        if (url === AIUSER_ENDPOINTS.jwks) return Response.json({ keys: [jwk] });
        assert.equal(url, AIUSER_ENDPOINTS.token); exchanges++;
        const body = new URLSearchParams(String(init?.body));
        assert.equal(body.has("resource"), false);
        const authorization = attempts.get(body.get("code")!);
        assert.ok(authorization, "only an independently registered synthetic code may exchange");
        assert.equal(createHash("sha256").update(body.get("code_verifier")!).digest("base64url"), authorization.searchParams.get("code_challenge"));
        if (options.upstreamStatus) return Response.json({ error: "PRIVATE_PROVIDER_FAILURE" }, { status: options.upstreamStatus });
        const common = { iss: tuple.issuerUrl, sub: "synthetic-pairwise-subject", iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 900 };
        const id = await new SignJWT({ ...common, aud: tuple.clientId, nonce: authorization.searchParams.get("nonce"),
          ...(Object.hasOwn(options, "authTime") ? { auth_time: options.authTime } : {}) })
          .setProtectedHeader({ alg: "ES256", kid: jwk.kid, ...(options.idTyp ? { typ: options.idTyp } : {}) }).sign(pair.privateKey);
        const access = await new SignJWT({ ...common, exp: common.iat + (options.accessTtl ?? 900),
          aud: options.wrongAudience ? tuple.clientId : tuple.audience, product_id: "aistory", scope: "product.access",
          membership_generation: options.membership ?? 1 })
          .setProtectedHeader({ alg: "ES256", kid: jwk.kid,
            ...(options.accessTyp === null ? {} : { typ: options.accessTyp ?? "at+jwt" }) }).sign(pair.privateKey);
        return Response.json({ id_token: id, access_token: access, token_type: "Bearer", expires_in: 900, scope: "product.access" });
      }) as typeof fetch,
    };
    const runtime = createAiUserUserRuntime(deps);
    const begin = async (previousCookie = "", linkReauth = false) => {
      const path = linkReauth ? "/api/auth/aiuser/account-link/reauth" : "/api/auth/aiuser/start";
      const started = await (linkReauth ? runtime.business.startLinkReauth : runtime.start)(new Request(`${tuple.publicOrigin}${path}`, {
        method: "POST", headers: { origin: tuple.publicOrigin, "sec-fetch-site": "same-origin", "content-type": "application/json", cookie: previousCookie }, body: "{}",
      }));
      assert.equal(started.status, 200);
      const authorization = new URL((await started.json()).authorizationUrl);
      const code = randomBytes(32).toString("base64url");
      assert.equal(attempts.has(code), false); attempts.set(code, authorization);
      const transaction = cookieOf(started, AIUSER_TRANSACTION_COOKIE);
      const callback = (extraCookie = "") => new Request(`${tuple.redirectUri}?${new URLSearchParams({ state: authorization.searchParams.get("state")!, code, iss: tuple.issuerUrl })}`, {
        headers: { cookie: transaction + extraCookie },
      });
      return { transaction, callback, authorization, code, startHeaders: started.headers };
    };
    const first = await begin();
    return { runtime, deps, markers, ...first, begin, exchanges: () => exchanges,
      advance: (ms: number) => { now += ms; }, failStore: (value: boolean) => { storeFailed = value; } };
  }

  const f = await fixture();
  assert.equal(f.authorization.searchParams.has("max_age"), false); checks++;
  const completed = await f.runtime.callback(f.callback());
  assert.equal(completed.status, 303); assert.equal(completed.headers.get("location"), "/auth/aiuser"); checks++;
  assert.equal(await completed.text(), "");
  const productCookie = cookieOf(completed, AIUSER_PRODUCT_SESSION_COOKIE);
  assert.match(productCookie, /^__Host-aistory_aiuser_user_v1=/);
  for (const attr of ["Secure", "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=900"]) {
    assert.ok(completed.headers.getSetCookie().find((value) => value.startsWith(AIUSER_PRODUCT_SESSION_COOKIE))!.includes(attr)); checks++;
  }
  const session = await f.runtime.business.read(readRequest(productCookie));
  assert.ok(session); assert.match(session.principalKey, /^[a-f0-9]{64}$/); checks++;
  assert.equal(session.idpAuthenticatedAt, null); assert.equal(session.sessionIssuedAt, base); checks++;
  const account = aiUserPublicAccount(session.expiresAt);
  assert.match(f.startHeaders.getSetCookie().find((item) => item.startsWith(AIUSER_TRANSACTION_COOKIE))!, /Max-Age=1595/); checks++;
  assert.equal(account.balance, null); assert.equal(account.accountLinked, null);
  assert.deepEqual(Object.values(account.capabilities), [false, false, false, false]);
  assert.doesNotMatch(JSON.stringify(account), /synthetic|subject|principalKey|sessionBinding|token|secret|userId|membershipGeneration|idpAuthenticatedAt|auth_time/); checks++;
  const oldIdpAuth = await fixture({ authTime: base / 1000 - 301 });
  const oldIdpAuthResponse = await oldIdpAuth.runtime.callback(oldIdpAuth.callback());
  const oldIdpAuthSession = await oldIdpAuth.runtime.business.read(readRequest(cookieOf(oldIdpAuthResponse, AIUSER_PRODUCT_SESSION_COOKIE)));
  assert.equal(oldIdpAuthSession?.idpAuthenticatedAt, base - 301000);
  assert.equal(oldIdpAuthSession?.sessionIssuedAt, base); checks++;
  for (const [authTime, expectedStatus] of [[base / 1000, 303], [undefined, 400], [base / 1000 - 6, 400]] as const) {
    const recent = await fixture(authTime === undefined ? {} : { authTime });
    const firstLogin = await recent.runtime.callback(recent.callback());
    const sessionCookie = cookieOf(firstLogin, AIUSER_PRODUCT_SESSION_COOKIE);
    const second = await recent.begin(`${sessionCookie}; aistory_user_session=synthetic-phone-proof`, true);
    assert.equal(second.authorization.searchParams.get("max_age"), "0");
    assert.equal(second.authorization.searchParams.has("prompt"), false);
    assert.equal(second.authorization.searchParams.has("returnTo"), false); checks++;
    const response = await recent.runtime.callback(second.callback("; aistory_user_session=synthetic-phone-proof"));
    assert.equal(response.status, expectedStatus); checks++;
    assert.equal(response.headers.getSetCookie().some((line) => line.startsWith("aistory_user_session=")), false); checks++;
    if (expectedStatus === 303) {
      assert.equal(response.headers.get("location"), "/auth/aiuser");
      const refreshed = await recent.runtime.business.read(readRequest(cookieOf(response, AIUSER_PRODUCT_SESSION_COOKIE)));
      assert.equal(refreshed?.idpAuthenticatedAt, base); checks++;
    }
  }
  // A real redirect always completes after the IdP's auth_time. Link reauth
  // must anchor its proof expiry to that earlier instant, or the account-link
  // policy's 900-second lifetime bound fails immediately.
  const delayedLinkReauth = await fixture({ authTime: base / 1000 });
  const delayedInitial = await delayedLinkReauth.runtime.callback(delayedLinkReauth.callback());
  const delayedInitialCookie = cookieOf(delayedInitial, AIUSER_PRODUCT_SESSION_COOKIE);
  const delayedSecond = await delayedLinkReauth.begin(
    `${delayedInitialCookie}; aistory_user_session=synthetic-phone-proof`, true,
  );
  delayedLinkReauth.advance(8000);
  const delayedResponse = await delayedLinkReauth.runtime.callback(
    delayedSecond.callback("; aistory_user_session=synthetic-phone-proof"),
  );
  assert.equal(delayedResponse.status, 303);
  assert.match(delayedResponse.headers.getSetCookie().find((value) =>
    value.startsWith(`${AIUSER_PRODUCT_SESSION_COOKIE}=`))!, /Max-Age=892/);
  const delayedSession = await delayedLinkReauth.runtime.business.read(
    readRequest(cookieOf(delayedResponse, AIUSER_PRODUCT_SESSION_COOKIE)),
  );
  assert.equal(delayedSession?.idpAuthenticatedAt, base);
  assert.equal(delayedSession?.expiresAt, base + 900000); checks++;
  const blockedReauth = await fixture({ authTime: base / 1000 });
  for (const [path, body, origin] of [
    ["/api/auth/aiuser/account-link/reauth?returnTo=https://untrusted.invalid", "{}", tuple.publicOrigin],
    ["/api/auth/aiuser/account-link/reauth", '{"returnTo":"https://untrusted.invalid"}', tuple.publicOrigin],
    ["/api/auth/aiuser/account-link/reauth", "{}", "https://untrusted.invalid"],
  ] as const) {
    const denied = await blockedReauth.runtime.business.startLinkReauth(new Request(`${tuple.publicOrigin}${path}`, {
      method: "POST", headers: { origin, "sec-fetch-site": "same-origin", "content-type": "application/json" }, body,
    }));
    assert.equal(denied.status, 400); checks++;
  }
  assert.equal(rejectUnboundCloudProgressPrincipal({ authType: "aiuser", userId: `aiuser:${session.principalKey}`, aiuser: session })?.status, 503); checks++;
  assert.equal(rejectUnboundCloudProgressPrincipal({ authType: "phone", userId: "synthetic" })?.status, 503);
  assert.equal(rejectUnboundCloudProgressPrincipal({ authType: "anonymous", userId: "anonymous" }), undefined);
  const requestIdentity = readRequest(productCookie);
  await assert.rejects(f.runtime.business.logout(logoutRequest(productCookie, { origin: "https://untrusted.invalid" })), /REJECTED|rejected/); checks++;
  await assert.rejects(f.runtime.business.logout(logoutRequest(productCookie, { "sec-fetch-site": "cross-site" })), /REJECTED|rejected/); checks++;
  assert.ok(await f.runtime.business.read(requestIdentity));
  f.failStore(true);
  assert.equal(await f.runtime.business.read(requestIdentity), null);
  await assert.rejects(f.runtime.business.logout(logoutRequest(productCookie)), /private-store-failure/); checks++;
  f.failStore(false);
  assert.ok(await f.runtime.business.read(requestIdentity));
  await f.runtime.business.logout(logoutRequest(productCookie));
  assert.equal(await f.runtime.business.read(requestIdentity), null); checks++;
  assert.equal(await createAiUserUserRuntime(f.deps).business.read(requestIdentity), null); checks++;
  await f.runtime.business.logout(logoutRequest(productCookie));
  assert.equal((await f.runtime.callback(f.callback())).status, 400); assert.equal(f.exchanges(), 1); checks++;

  // Next 16's Node adapter supplies a stream for a real zero-byte DELETE. It
  // must be accepted without weakening the strict no-request-body boundary.
  const { NextRequestAdapter } = await import("next/dist/server/web/spec-extension/adapters/next-request");
  const { addRequestMeta } = await import("next/dist/server/request-meta");
  const { Readable } = await import("node:stream");
  const proxyOrigin = "https://localhost:4200";
  function adaptedLogout(cookies: string, chunks: Buffer[] = [], overrides: Record<string, string> = {}) {
    const nodeRequest = { method: "DELETE", url: "/api/account/me", body: Readable.from(chunks), headers: {
      host: "play.hibcglobal.com", origin: tuple.publicOrigin, "x-forwarded-proto": "https",
      "x-forwarded-host": "play.hibcglobal.com", "sec-fetch-site": "same-origin", cookie: cookies, ...overrides,
    } };
    addRequestMeta(nodeRequest as never, "initURL", `${proxyOrigin}/api/account/me`);
    return NextRequestAdapter.fromNodeNextRequest(nodeRequest as never, new AbortController().signal);
  }
  const adapted = await fixture();
  const adaptedResponse = await adapted.runtime.callback(adapted.callback());
  const adaptedCookie = cookieOf(adaptedResponse, AIUSER_PRODUCT_SESSION_COOKIE);
  const adaptedRuntime = createAiUserUserRuntime({ ...adapted.deps, proxyRequestOrigin: proxyOrigin });
  assert.equal(adaptedLogout(adaptedCookie).body === null, false); checks++;
  await adaptedRuntime.business.logout(adaptedLogout(adaptedCookie));
  assert.equal(await adaptedRuntime.business.read(readRequest(adaptedCookie)), null); checks++;
  for (const [chunks, headers] of [
    [[Buffer.from("x")], {}],
    [[], { "content-length": "1" }],
    [[], { "transfer-encoding": "chunked" }],
  ] as const) {
    const hostile = await fixture();
    const admitted = await hostile.runtime.callback(hostile.callback());
    const cookie = cookieOf(admitted, AIUSER_PRODUCT_SESSION_COOKIE);
    const runtime = createAiUserUserRuntime({ ...hostile.deps, proxyRequestOrigin: proxyOrigin });
    await assert.rejects(runtime.business.logout(adaptedLogout(cookie, [...chunks], headers)), /REJECTED|rejected/); checks++;
    assert.ok(await runtime.business.read(readRequest(cookie))); checks++;
  }

  const race = await fixture();
  const raceHash = await readAiUserTransactionHash(readRequest(race.transaction), secret, Math.floor(base / 1000));
  assert.ok(raceHash);
  await race.runtime.business.logout(logoutRequest(race.transaction));
  assert.ok(race.markers.has(aiUserSessionDigest("transaction", raceHash)));
  assert.equal((await race.runtime.callback(race.callback())).status, 400); checks++;
  const concurrent = await fixture();
  const responses = await Promise.all([concurrent.runtime.callback(concurrent.callback()), concurrent.runtime.callback(concurrent.callback())]);
  assert.deepEqual(responses.map((value) => value.status).sort(), [303, 400]); assert.equal(concurrent.exchanges(), 1); checks++;

  // Same runtime and replay store, independent code/nonce/PKCE per attempt.
  const swappedAfterLogout = await fixture();
  await swappedAfterLogout.runtime.business.logout(logoutRequest(swappedAfterLogout.transaction));
  const afterLogoutB = await swappedAfterLogout.begin();
  const wrongAfterLogout = await swappedAfterLogout.runtime.callback(new Request(swappedAfterLogout.callback().url, {
    headers: { cookie: afterLogoutB.transaction },
  }));
  assert.equal(wrongAfterLogout.status, 400); assert.equal(wrongAfterLogout.headers.getSetCookie().length, 0);
  assert.equal(swappedAfterLogout.exchanges(), 0); checks++;
  assert.equal((await swappedAfterLogout.runtime.callback(afterLogoutB.callback())).status, 303);
  assert.equal(swappedAfterLogout.exchanges(), 1); checks++;

  const twoAttempts = await fixture();
  const attemptB = await twoAttempts.begin(twoAttempts.transaction);
  assert.notEqual(twoAttempts.code, attemptB.code);
  for (const field of ["state", "nonce", "code_challenge"]) {
    assert.notEqual(twoAttempts.authorization.searchParams.get(field), attemptB.authorization.searchParams.get(field));
  }
  for (const [query, cookies] of [[twoAttempts.callback().url, attemptB.transaction], [attemptB.callback().url, twoAttempts.transaction]] as const) {
    const response = await twoAttempts.runtime.callback(new Request(query, { headers: { cookie: cookies } }));
    assert.equal(response.status, 400); assert.equal(response.headers.getSetCookie().length, 0);
    assert.equal(twoAttempts.exchanges(), 0); checks++;
  }
  assert.equal((await twoAttempts.runtime.callback(twoAttempts.callback())).status, 303);
  assert.equal((await twoAttempts.runtime.callback(attemptB.callback())).status, 303);
  assert.equal(twoAttempts.exchanges(), 2); checks++;

  // Two cookie-less start requests can have independent lineages. A late B
  // response must not erase the logout correlation for an admitted callback A.
  for (const paused of ["A", "B"] as const) {
  const parallelStarts = await fixture();
  const parallelB = await parallelStarts.begin();
  let parallelEntered!: () => void, parallelRelease!: () => void;
  const parallelAtNetwork = new Promise<void>((resolve) => { parallelEntered = resolve; });
  const parallelHold = new Promise<void>((resolve) => { parallelRelease = resolve; });
  const parallelRuntime = createAiUserUserRuntime({ ...parallelStarts.deps, fetch: (async (input, init) => {
    if (String(input) === AIUSER_ENDPOINTS.discovery) { parallelEntered(); await parallelHold; }
    return parallelStarts.deps.fetch(input, init);
  }) as typeof fetch });
  const parallelCallbackA = parallelRuntime.callback(paused === "A" ? parallelStarts.callback() : parallelB.callback()); await parallelAtNetwork;
  const browserCookies = new Map<string, string>();
  for (const headers of paused === "A" ? [parallelStarts.startHeaders, parallelB.startHeaders] : [parallelB.startHeaders, parallelStarts.startHeaders]) {
    for (const line of headers.getSetCookie()) {
      const item = line.split(";")[0]!; browserCookies.set(item.slice(0, item.indexOf("=")), item);
    }
  }
  await parallelRuntime.business.logout(logoutRequest([...browserCookies.values()].join("; "))); parallelRelease();
  const parallelResult = await parallelCallbackA;
  const parallelSessionCookie = parallelResult.headers.getSetCookie().find((line) => line.startsWith(`${AIUSER_PRODUCT_SESSION_COOKIE}=`));
  assert.equal(parallelSessionCookie ? Boolean(await parallelRuntime.business.read(readRequest(parallelSessionCookie.split(";")[0]!))) : false,
    false, `logout must invalidate independently started callback ${paused}`); checks++;
  }

  const markerFixture = await fixture();
  const marker = markerFixture.startHeaders.getSetCookie().find((line) => line.startsWith(AIUSER_PENDING_COOKIE_PREFIX))!.split(";")[0]!;
  const markerName = marker.slice(0, marker.indexOf("="));
  assert.match(marker, /./); assert.ok(markerFixture.startHeaders.getSetCookie().some((line) => line.startsWith(markerName) && line.includes("Max-Age=1595")));
  assert.equal(await markerFixture.runtime.business.read(readRequest(marker)), null); checks++;
  for (const bad of [`${marker}; ${marker}`, `${markerName}=forged`, marker.replace(markerName, AIUSER_PENDING_COOKIE_PREFIX + "a".repeat(64)),
    Array.from({ length: 9 }, (_, i) => `${AIUSER_PENDING_COOKIE_PREFIX}${String(i).repeat(64)}=forged`).join("; ")]) {
    await assert.rejects(markerFixture.runtime.business.logout(logoutRequest(bad))); checks++;
  }
  // Marker-only logout still revokes a callback after the normal transaction
  // cookie was overwritten/cleared; business mode off cannot pretend to revoke.
  delete process.env[AIUSER_USER_INTEGRATION_ENV];
  assert.equal(await logoutAiUserBusinessSession(logoutRequest(marker), new Response(null)), false); checks++;
  const markerClears = await markerFixture.runtime.business.logout(logoutRequest(marker));
  assert.equal(markerClears.length, 1); assert.ok(markerClears[0]!.startsWith(`${markerName}=`));
  assert.equal((await markerFixture.runtime.callback(markerFixture.callback())).status, 400); checks++;
  const bounded = await fixture(); const outstanding = [bounded];
  for (let i = 0; i < 3; i++) outstanding.push({ ...bounded, ...await bounded.begin() });
  const fourMarkers = outstanding.map((attempt) => attempt.startHeaders.getSetCookie().find((line) => line.startsWith(AIUSER_PENDING_COOKIE_PREFIX))!.split(";")[0]!).join("; ");
  const excessStart = await bounded.runtime.start(new Request(`${tuple.publicOrigin}/api/auth/aiuser/start`, {
    method: "POST", headers: { origin: tuple.publicOrigin, "sec-fetch-site": "same-origin", "content-type": "application/json", cookie: fourMarkers }, body: "{}",
  }));
  assert.equal(excessStart.status, 400); assert.equal(excessStart.headers.getSetCookie().length, 0); assert.equal(bounded.exchanges(), 0); checks++;

  for (const options of [{ accessTyp: null }, { accessTyp: "JWT" }, { accessTyp: "AT+JWT" }, { idTyp: "at+jwt" },
    { membership: 0 }, { membership: 1.5 }, { upstreamStatus: 403 }, { upstreamStatus: 500 }, { accessTtl: 901 }, { wrongAudience: true }]) {
    const negative = await fixture(options);
    const response = await negative.runtime.callback(negative.callback());
    assert.equal(response.status, 400); assert.equal(response.headers.getSetCookie().some((value) => value.startsWith(AIUSER_PRODUCT_SESSION_COOKIE)), false);
    assert.doesNotMatch(await response.text(), /PRIVATE|subject|token|secret|principal/); checks++;
  }
  for (const authTime of [base / 1000 + 6, base / 1000 + 0.5, "recent", null, -1]) {
    const negative = await fixture({ authTime });
    const response = await negative.runtime.callback(negative.callback());
    assert.equal(response.status, 400);
    assert.equal(response.headers.getSetCookie().some((value) => value.startsWith(AIUSER_PRODUCT_SESSION_COOKIE)), false); checks++;
  }
  const shorter = await fixture({ idTyp: "JWT", accessTtl: 60, membership: 3 });
  const shorterResponse = await shorter.runtime.callback(shorter.callback());
  const shorterCookie = cookieOf(shorterResponse, AIUSER_PRODUCT_SESSION_COOKIE);
  assert.equal((await shorter.runtime.business.read(readRequest(shorterCookie)))?.membershipGeneration, 3); checks++;
  shorter.advance(59999); assert.ok(await shorter.runtime.business.read(readRequest(shorterCookie)));
  shorter.advance(1); assert.equal(await shorter.runtime.business.read(readRequest(shorterCookie)), null); checks++;
  shorter.advance(5000); assert.equal(await shorter.runtime.business.read(readRequest(shorterCookie)), null); checks++;

  // Identity cookie is never itself the ordinary business session; duplicate/fake cookies reject.
  const identityCookie = cookieOf(completed, AIUSER_IDENTITY_COOKIE).replace(AIUSER_IDENTITY_COOKIE, AIUSER_PRODUCT_SESSION_COOKIE);
  assert.equal(await f.runtime.business.read(readRequest(identityCookie)), null); checks++;
  assert.equal(await f.runtime.business.read(readRequest(`${productCookie}; ${productCookie}`)), null); checks++;
  assert.equal(await f.runtime.business.read(readRequest(`${AIUSER_PRODUCT_SESSION_COOKIE}=forged`)), null); checks++;

  // Even a correctly encrypted unsupported field or altered authority cannot be accepted.
  const cryptoKey = new Uint8Array(hkdfSync("sha256", secret, tupleHash, "aistory.aiuser.business-session.v1", 32));
  const template = { registration: tupleHash, principalKey: "a".repeat(64), sid: randomBytes(32).toString("base64url"), transactionHash: "b".repeat(64), lineage: "c".repeat(64), membershipGeneration: 1 };
  const sealProduct = (payload: Record<string, unknown>) => new EncryptJWT(payload)
    .setProtectedHeader({ alg: "dir", enc: "A256GCM", typ: "aistory-business+jwt" })
    .setIssuer(tuple.publicOrigin).setAudience("aistory-aiuser-business-v1").setIssuedAt(base / 1000)
    .setExpirationTime(base / 1000 + 60).encrypt(cryptoKey);
  const legacyProduct = await sealProduct(template);
  assert.equal((await f.runtime.business.read(readRequest(`${AIUSER_PRODUCT_SESSION_COOKIE}=${legacyProduct}`)))?.idpAuthenticatedAt, null); checks++;
  for (const [idpAuthenticatedAt, expected] of [[null, null], [base / 1000 - 301, base - 301000]] as const) {
    const value = await sealProduct({ ...template, idpAuthenticatedAt });
    assert.equal((await f.runtime.business.read(readRequest(`${AIUSER_PRODUCT_SESSION_COOKIE}=${value}`)))?.idpAuthenticatedAt, expected); checks++;
  }
  for (const idpAuthenticatedAt of [base / 1000 + 6, base / 1000 + 0.5]) {
    const value = await sealProduct({ ...template, idpAuthenticatedAt });
    assert.equal(await f.runtime.business.read(readRequest(`${AIUSER_PRODUCT_SESSION_COOKIE}=${value}`)), null); checks++;
  }
  for (const patch of [{ administrator: true }, { registration: "c".repeat(64) }, { membershipGeneration: 0 }, { principalKey: "a".repeat(16) }]) {
    const value = await sealProduct({ ...template, idpAuthenticatedAt: null, ...patch });
    assert.equal(await f.runtime.business.read(readRequest(`${AIUSER_PRODUCT_SESSION_COOKIE}=${value}`)), null); checks++;
  }
  const rawProduct = createAiUserProductSession(f.deps);
  let getters = 0;
  await assert.rejects(rawProduct.establish(Object.defineProperty({ issuer: tuple.issuerUrl, subject: "synthetic", membershipGeneration: 1, expiresAt: base / 1000 + 60 },
    "subject", { enumerable: true, get() { getters++; return "bad"; } }), "d".repeat(64), readRequest(""), new Headers()));
  assert.equal(getters, 0); checks++;

  delete process.env[AIUSER_USER_INTEGRATION_ENV];
  const legacyLogout = new Response(null);
  assert.equal(await logoutAiUserBusinessSession(logoutRequest(`${AIUSER_IDENTITY_COOKIE}=synthetic; aistory_user_session=synthetic-phone`), legacyLogout), true);
  assert.equal(legacyLogout.headers.getSetCookie().length, 2); checks++;
  assert.deepEqual(await (await aiUserUserCapabilities()).json(), { enabled: false, linkingEnabled: false, linkReauthAvailable: false });
  assert.equal((await readAiUserBusinessSession(readRequest(productCookie))).state, "invalid"); checks++;
  for (const mode of ["true", "enabled", "unknown"]) {
    process.env[AIUSER_USER_INTEGRATION_ENV] = mode;
    assert.deepEqual(await (await aiUserUserCapabilities()).json(), { enabled: false, linkingEnabled: false, linkReauthAvailable: false }); checks++;
  }
  // A captured older callback shares the logout lineage even when another tab replaced its transaction.
  const lineageFixture = await fixture();
  const lineageResponse = await lineageFixture.runtime.callback(lineageFixture.callback());
  const sourceCookie = cookieOf(lineageResponse, AIUSER_PRODUCT_SESSION_COOKIE);
  const lineageSession = await lineageFixture.runtime.business.read(readRequest(sourceCookie)); assert.ok(lineageSession);
  const nextStart = await lineageFixture.runtime.start(new Request(`${tuple.publicOrigin}/api/auth/aiuser/start`, {
    method: "POST", headers: { origin: tuple.publicOrigin, "sec-fetch-site": "same-origin", "content-type": "application/json", cookie: sourceCookie }, body: "{}",
  }));
  assert.equal(nextStart.status, 200);
  await lineageFixture.runtime.business.logout(logoutRequest(`${sourceCookie}; ${cookieOf(nextStart, AIUSER_TRANSACTION_COOKIE)}`));
  const derived = createAiUserProductSession(lineageFixture.deps);
  await assert.rejects(derived.establish({ issuer: tuple.issuerUrl, subject: "synthetic-pairwise-subject", membershipGeneration: 1,
    expiresAt: base / 1000 + 900 }, "e".repeat(64), readRequest(sourceCookie), new Headers(), lineageSession.lineage)); checks++;
  // Logout after establishment's initial check but before it publishes cannot resurrect authority.
  const late = await fixture();
  const lateResponse = await late.runtime.callback(late.callback());
  const lateCookie = cookieOf(lateResponse, AIUSER_PRODUCT_SESSION_COOKIE);
  const lateSession = await late.runtime.business.read(readRequest(lateCookie)); assert.ok(lateSession);
  let didRace = false;
  const racing = createAiUserProductSession({ ...late.deps, claimOnce: async (digest) => {
    const result = await late.deps.claimOnce(digest);
    if (!didRace) { didRace = true; await late.deps.claimOnce(aiUserSessionDigest("lineage", lateSession.lineage)); }
    return result;
  } });
  const raceResult = await racing.establish({ issuer: tuple.issuerUrl, subject: "synthetic-pairwise-subject", membershipGeneration: 1,
    expiresAt: base / 1000 + 900 }, "f".repeat(64), readRequest(lateCookie), new Headers(), lateSession.lineage);
  assert.equal(await late.runtime.business.read(readRequest(cookieOf(raceResult, AIUSER_PRODUCT_SESSION_COOKIE))), null); checks++;
  // First login: a bounded human interaction can exceed90s. Pending-cookie
  // retention remains revocation-only beyond the 690s transaction deadline.
  const interactive = await fixture(); interactive.advance(300000);
  assert.equal((await interactive.runtime.callback(interactive.callback())).status, 303); checks++;
  const pendingFirst = await fixture(); pendingFirst.advance(680000);
  let reached!: () => void, release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const startedNetwork = new Promise<void>((resolve) => { reached = resolve; });
  const delayedRuntime = createAiUserUserRuntime({ ...pendingFirst.deps, fetch: (async (input, init) => {
    if (String(input) === AIUSER_ENDPOINTS.discovery) { reached(); await held; }
    return pendingFirst.deps.fetch(input, init);
  }) as typeof fetch });
  const pendingResponse = delayedRuntime.callback(pendingFirst.callback()); await startedNetwork;
  pendingFirst.advance(16000);
  assert.ok(await readAiUserTransactionHash(readRequest(pendingFirst.transaction), secret, Math.floor((base + 696000) / 1000))); checks++;
  await delayedRuntime.business.logout(logoutRequest(pendingFirst.transaction)); release();
  assert.equal((await pendingResponse).status, 400); checks++;
  const expiredCompletion = await fixture(); expiredCompletion.advance(680000);
  const expiredRuntime = createAiUserUserRuntime({ ...expiredCompletion.deps, fetch: (async (input, init) => {
    const value = await expiredCompletion.deps.fetch(input, init);
    if (String(input) === AIUSER_ENDPOINTS.jwks) expiredCompletion.advance(16000);
    return value;
  }) as typeof fetch });
  assert.equal((await expiredRuntime.callback(expiredCompletion.callback())).status, 400); checks++;
  // Response constructed before expiry, delivered after logout: retained pending
  // envelope still lets logout invalidate the future-delivered business cookie.
  const lateDelivery = await fixture(); lateDelivery.advance(680000);
  const constructed = await lateDelivery.runtime.callback(lateDelivery.callback());
  assert.equal(constructed.status, 303); lateDelivery.advance(16000);
  await lateDelivery.runtime.business.logout(logoutRequest(lateDelivery.transaction));
  assert.equal(await lateDelivery.runtime.business.read(readRequest(cookieOf(constructed, AIUSER_PRODUCT_SESSION_COOKIE))), null); checks++;
  // A losing sibling callback must not remove the only pending logout marker.
  const siblings = await fixture(); let entered!: () => void, finish!: () => void;
  const enteredNetwork = new Promise<void>((resolve) => { entered = resolve; });
  const releaseNetwork = new Promise<void>((resolve) => { finish = resolve; });
  const siblingRuntime = createAiUserUserRuntime({ ...siblings.deps, fetch: (async (input, init) => {
    if (String(input) === AIUSER_ENDPOINTS.discovery) { entered(); await releaseNetwork; }
    return siblings.deps.fetch(input, init);
  }) as typeof fetch });
  const firstSibling = siblingRuntime.callback(siblings.callback()); await enteredNetwork;
  const duplicate = await siblingRuntime.callback(siblings.callback());
  assert.equal(duplicate.status, 400); assert.equal(duplicate.headers.getSetCookie().length, 0); checks++;
  await siblingRuntime.business.logout(logoutRequest(siblings.transaction)); finish();
  assert.equal((await firstSibling).status, 400); checks++;
  for (const bound of ["transaction", "access"] as const) {
    const deadline = await fixture(); let shifted = false;
    const slowStore = createAiUserProductSession({ ...deadline.deps, isClaimed: async (digest) => {
      const claimed = await deadline.deps.isClaimed(digest);
      if (!shifted) { shifted = true; deadline.advance(bound === "transaction" ? 696000 : 11000); }
      return claimed;
    } });
    const outHeaders = new Headers();
    await assert.rejects(slowStore.establish({ issuer: tuple.issuerUrl, subject: "synthetic-delayed-subject", membershipGeneration: 1,
      expiresAt: base / 1000 + (bound === "access" ? 10 : 900) }, "b".repeat(64), readRequest(""), outHeaders, "b".repeat(64), base / 1000 + 695));
    assert.equal(outHeaders.getSetCookie().length, 0); checks++;
  }
  // Actual production claim implementation, injected filesystem only. A file
  // created before failed fsync is not durable proof on the next EEXIST retry.
  const replayRestores: Array<() => void> = [];
  const replayDirectory = "/var/lib/aistory/synthetic-replay";
  const replayFile = `${replayDirectory}/${"a".repeat(64)}.claim`;
  let replayExists = false, failReplaySync: "file" | "directory" | null = "file", syncCalls = 0;
  const replayInfo = (file: boolean) => ({ uid: 950, gid: 950, mode: file ? 0o600 : 0o700, nlink: 1,
    size: 0, dev: 1, ino: file ? 2 : 1, isFile: () => file, isDirectory: () => !file, isSymbolicLink: () => false });
  const replaceReplay = (name: string, value: unknown) => {
    const descriptor = Object.getOwnPropertyDescriptor(fsp, name)!;
    Object.defineProperty(fsp, name, { ...descriptor, value }); replayRestores.push(() => Object.defineProperty(fsp, name, descriptor));
  };
  try {
    replaceReplay("realpath", async (file: string) => file);
    replaceReplay("lstat", async (file: string) => {
      if (file === replayFile && !replayExists) throw Object.assign(Error("synthetic missing"), { code: "ENOENT" });
      return replayInfo(file === replayFile);
    });
    replaceReplay("opendir", async () => ({ async *[Symbol.asyncIterator]() {
      if (replayExists) yield { name: "a".repeat(64) + ".claim", isFile: () => true };
    } }));
    replaceReplay("open", async (file: string, flags: number) => {
      if (file === replayFile && (flags & fs.constants.O_EXCL)) {
        if (replayExists) throw Object.assign(Error("synthetic exists"), { code: "EEXIST" });
        replayExists = true;
      }
      return { stat: async () => replayInfo(file === replayFile), close: async () => undefined,
        sync: async () => { syncCalls++;
          if (failReplaySync === (file === replayFile ? "file" : "directory")) throw Error("SYNTHETIC_SYNC_UNAVAILABLE"); } };
    });
    syncBuiltinESMExports();
    for (const failurePoint of ["file", "directory"] as const) {
      replayExists = false; failReplaySync = failurePoint;
      await assert.rejects(claimAiUserReplayOnce(replayDirectory, 950, 950, "a".repeat(64))); assert.equal(replayExists, true); checks++;
      const firstFailureSyncCalls = syncCalls;
      await assert.rejects(claimAiUserReplayOnce(replayDirectory, 950, 950, "a".repeat(64)),
        `EEXIST must not convert unconfirmed ${failurePoint} sync into successful logout`);
      assert.ok(syncCalls > firstFailureSyncCalls); checks++;
      failReplaySync = null; const beforeConfirmed = syncCalls;
      assert.equal(await claimAiUserReplayOnce(replayDirectory, 950, 950, "a".repeat(64)), false);
      assert.ok(syncCalls >= beforeConfirmed + 2); checks++;
    }
  } finally {
    for (const restore of replayRestores.reverse()) restore(); syncBuiltinESMExports();
  }
  // Positive phone-only predicates remain intact; no subject/UUID coercion or business grant.
  assert.match(fs.readFileSync("lib/credentials/serverPolicy.ts", "utf8"), /input\.authType === "aiuser"/);
  assert.match(fs.readFileSync("lib/credentials/serverPolicy.ts", "utf8"), /verifiedLinkedPhoneUserId/);
  assert.match(fs.readFileSync("lib/credentials/hosted/service.ts", "utf8"), /actor.authType !== "phone"/);
  assert.equal(typeof authorizeCredentialAccess, "function");
  const route = fs.readFileSync("app/api/account/me/route.ts", "utf8");
  const logoutRoute = fs.readFileSync("lib/auth/accountLogoutRoute.ts", "utf8");
  const aiuserProjection = route.indexOf('auth.authType === "aiuser"');
  const legacyAdminRead = route.indexOf("getAdminRepository()");
  assert.ok(aiuserProjection >= 0 && legacyAdminRead >= 0 && aiuserProjection < legacyAdminRead);
  assert.match(route, /return handleAccountLogout\(request\)/);
  assert.match(logoutRoute, /logoutBusinessSession[\s\S]*?status: 503/);
  const legacyCookieClear = logoutRoute.indexOf("response.cookies.set(USER_SESSION_COOKIE");
  const businessLogout = logoutRoute.indexOf("deps.logoutBusinessSession(request, response)");
  assert.ok(legacyCookieClear >= 0 && businessLogout >= 0 && legacyCookieClear < businessLogout); checks++;
  // Exercise the actual NextResponse cookie implementation and real route
  // wrapper. ResponseCookies.set after raw appends would overwrite them.
  const { NextResponse } = await import("next/server");
  const cookieResponse = NextResponse.json({ ok: true });
  cookieResponse.cookies.set("aistory_user_session", "", { path: "/", httpOnly: true, secure: true, sameSite: "lax", maxAge: 0 });
  const syntheticPending = `${AIUSER_PENDING_COOKIE_PREFIX}${"a".repeat(64)}`;
  for (const clear of [clearAiUserProductCookie(), `${syntheticPending}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
    `${AIUSER_IDENTITY_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
    `${AIUSER_TRANSACTION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`]) cookieResponse.headers.append("Set-Cookie", clear);
  assert.deepEqual(cookieResponse.headers.getSetCookie().map((value) => value.slice(0, value.indexOf("="))),
    ["aistory_user_session", AIUSER_PRODUCT_SESSION_COOKIE, syntheticPending, AIUSER_IDENTITY_COOKIE, AIUSER_TRANSACTION_COOKIE]); checks++;
  delete process.env[AIUSER_USER_INTEGRATION_ENV];
  const actualRouteLogout = await accountRoute.DELETE(logoutRequest(`${AIUSER_IDENTITY_COOKIE}=synthetic`));
  assert.equal(actualRouteLogout.status, 200);
  assert.deepEqual(actualRouteLogout.headers.getSetCookie().map((value) => value.slice(0, value.indexOf("="))),
    ["aistory_user_session", AIUSER_IDENTITY_COOKIE, AIUSER_TRANSACTION_COOKIE]); checks++;
  for (const file of ["lib/auth/aiUserProductSession.ts", "lib/auth/aiUserAccountPublic.ts"]) {
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), /ensureMembership|initial_grant|updateBalance|readPhone|console\.|admin\/|cloudStore/);
  }
  assert.equal(externalNetwork, 0); assert.equal(persistentWrites, 0);
  console.log(JSON.stringify({ status: "PASS_LOCAL_AIUSER_BUSINESS_SESSION", checks, externalNetwork, persistentWrites,
    membershipWrites: 0, grants: 0, productionEnabled: false, productionE2E: false }));
} finally {
  if (savedMode === undefined) delete process.env[AIUSER_USER_INTEGRATION_ENV]; else process.env[AIUSER_USER_INTEGRATION_ENV] = savedMode;
  for (const restore of undo.reverse()) restore();
  syncBuiltinESMExports();
}
