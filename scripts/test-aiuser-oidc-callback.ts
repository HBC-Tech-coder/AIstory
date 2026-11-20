import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
import { createHash, randomBytes } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import {
  AIUSER_CALLBACK_MODE, AIUSER_CALLBACK_REJECTION_STAGES, AIUSER_ENDPOINTS, AIUSER_IDENTITY_COOKIE, AIUSER_REGISTRY_BINDING_SHA256,
  AIUSER_TRANSACTION_COOKIE, createAiUserOidcCallback, readAiUserIdentitySession,
  validateAiUserCallbackConfiguration, validateAiUserHostReceipt, type AiUserCallbackRejectionStage,
} from "../lib/auth/aiUserOidcCallback";
import { AIUSER_OIDC_PRODUCTION_BETA_REGISTRATION as tuple,
  AIUSER_OIDC_PRODUCTION_BETA_REGISTRATION_SHA256 as tupleHash } from "../lib/auth/aiUserOidcProductionBeta";
import { assertAiUserProtectedFile, createAiUserOidcHttpBoundary,
  reportAiUserOidcCallbackRejection } from "../lib/auth/aiUserOidcCallbackServer";
import * as callbackRoute from "../app/api/auth/aiuser/callback/route";

let networkCalls = 0;
let writesPerformed = 0;
let assertions = 0;
let accessorCalls = 0;
const undo: Array<() => void> = [];
function trap(target: object, name: string, kind: "network" | "write") {
  const original = Object.getOwnPropertyDescriptor(target, name)!;
  Object.defineProperty(target, name, { ...original, value: () => {
    if (kind === "network") networkCalls++; else writesPerformed++;
    throw new Error("external_effect_forbidden");
  } });
  undo.push(() => Object.defineProperty(target, name, original));
}
trap(globalThis, "fetch", "network");
for (const target of [fs, fsPromises]) {
  for (const name of ["writeFile", "appendFile", "mkdir", "rename", "unlink", "rm"]) trap(target, name, "write");
}
for (const name of ["writeFileSync", "appendFileSync", "mkdirSync", "renameSync", "unlinkSync", "rmSync"]) trap(fs, name, "write");
trap(fs, "createWriteStream", "write");
for (const [target, name] of [[fs, "open"], [fs, "openSync"], [fsPromises, "open"]] as const) {
  const original = Object.getOwnPropertyDescriptor(target, name)!;
  Object.defineProperty(target, name, { ...original, value: (...args: unknown[]) => {
    const flags = args[1];
    if ((typeof flags === "string" && /[wa+]/.test(flags)) || (typeof flags === "number"
      && (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) !== 0)) {
      writesPerformed++; throw new Error("external_effect_forbidden");
    }
    return Reflect.apply(original.value, target, args);
  } });
  undo.push(() => Object.defineProperty(target, name, original));
}
for (const target of [http, https]) for (const name of ["request", "get"]) trap(target, name, "network");
for (const name of ["connect", "createConnection"]) trap(net, name, "network");
syncBuiltinESMExports();

try {
  const secret = randomBytes(48).toString("base64url"); // Ephemeral test-only, never written or printed.
  const keys = await generateKeyPair("ES256", { extractable: true });
  const publicKey = { ...await exportJWK(keys.publicKey), kid: "synthetic-key", use: "sig", alg: "ES256" };
  const nowBase = 1900000000000;
  const discovery = {
    issuer: tuple.issuerUrl, authorization_endpoint: AIUSER_ENDPOINTS.authorization,
    token_endpoint: AIUSER_ENDPOINTS.token, jwks_uri: AIUSER_ENDPOINTS.jwks,
    response_types_supported: ["code"], code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_basic"], id_token_signing_alg_values_supported: ["ES256"],
    scopes_supported: ["openid", "product.access", "offline_access"],
  };
  const config = {
    schema: "aistory.aiuser-oidc-callback-config.v1", registrationSha256: tupleHash,
    registryBindingSha256: AIUSER_REGISTRY_BINDING_SHA256, secretRef: tuple.credentialReference.referenceId,
    secretFile: "/etc/aistory/aiuser-oidc/client-secret", hostReceiptFile: "/etc/aistory/aiuser-oidc/host-acceptance.json",
    hostReceiptSha256: "a".repeat(64), replayDirectory: "/var/lib/aistory/aiuser-oidc-replay", recipientUid: 1001, recipientGid: 1001,
    proxyRequestOrigin: "https://localhost:54444",
  };
  const receipt = {
    schema: "aistory.aiuser-oidc-host-acceptance.v1", registrationSha256: tupleHash,
    registryBindingSha256: AIUSER_REGISTRY_BINDING_SHA256, registryReleaseSha256: "b".repeat(64),
    secretRef: config.secretRef, secretFile: config.secretFile, recipientUid: 1001, recipientGid: 1001,
    registryActivated: true, distinctSecretDelivered: true, recipientAclVerified: true,
    ingressRedactionVerified: true, startRateLimitVerified: true, sharedReplayDirectoryVerified: true,
    proxyRequestOrigin: config.proxyRequestOrigin, loopbackIngressVerified: true, forwardedHeaderScrubbingVerified: true,
  };
  function rejects(fn: () => unknown) { assertions++; assert.throws(fn, /aiuser_oidc_rejected|aiuser_runtime_unavailable/); }
  const cleanConfig = validateAiUserCallbackConfiguration(config);
  validateAiUserHostReceipt(receipt, cleanConfig);
  for (const [field, value] of Object.entries({ schema: "v2", registrationSha256: "c".repeat(64),
    registryBindingSha256: "c".repeat(64), secretRef: "ref_other", recipientUid: -1, recipientGid: 1.1,
    secretFile: "/etc/aiuser/secret", hostReceiptFile: "/etc/aistory/aiuser-oidc/../private",
    hostReceiptSha256: "not-a-digest", replayDirectory: "/var/lib/aistory/../elsewhere", unexpected: true,
    proxyRequestOrigin: "https://untrusted.invalid:54444" })) {
    rejects(() => validateAiUserCallbackConfiguration({ ...config, [field]: value }));
  }
  for (const field of Object.keys(config)) {
    const data: Record<string, unknown> = { ...config }; delete data[field];
    rejects(() => validateAiUserCallbackConfiguration(data));
  }
  for (const hostile of [Object.assign(Object.create({ injected: true }), config),
    { ...config, [Symbol("extra")]: true }, Object.defineProperty({ ...config }, "secretRef", {
      enumerable: true, get: () => { accessorCalls++; throw Error("PRIVATE_EXCEPTION"); },
    })]) rejects(() => validateAiUserCallbackConfiguration(hostile));
  for (const field of Object.keys(receipt)) {
    rejects(() => validateAiUserHostReceipt({ ...receipt, [field]: false }, cleanConfig));
  }
  const metadata = { regular: true, symbolicLink: false, uid: 1001, gid: 1001, mode: 0o600, nlink: 1, size: 64 };
  assertAiUserProtectedFile(metadata, 1001, 256, 1001);
  for (const [field, value] of Object.entries({ regular: false, symbolicLink: true, uid: 0, gid: 0,
    mode: 0o640, nlink: 2, size: 257 })) rejects(() => assertAiUserProtectedFile({ ...metadata, [field]: value }, 1001, 256, 1001));

  type Options = {
    idPatch?: JWTPayload; accessPatch?: JWTPayload; tokenPatch?: Record<string, unknown>;
    discoveryPatch?: Record<string, unknown>; jwksValue?: unknown; status?: number; badSignature?: boolean; badIdSignature?: boolean;
    unknownKid?: boolean; rotation?: boolean; invalidHeader?: Record<string, unknown>; allowStart?: boolean;
    responseTooLarge?: boolean; responseRedirected?: boolean; wrongContentType?: boolean; delayed?: boolean;
    discoveryContentType?: string; tokenContentType?: string; jwksContentType?: string;
    expireAtFinalCheck?: boolean; onVerifiedFailure?: boolean; reporterThrows?: boolean;
  };
  function startRequest(patch: RequestInit = {}) {
    return new Request(`${tuple.publicOrigin}/api/auth/aiuser/start`, {
      method: "POST", body: "{}", headers: { origin: tuple.publicOrigin, "sec-fetch-site": "same-origin", "content-type": "application/json" }, ...patch,
    });
  }
  function transactionCookie(response: Response) {
    const value = response.headers.getSetCookie().find((item) => item.startsWith(`${AIUSER_TRANSACTION_COOKIE}=`));
    assert.ok(value); return value.split(";")[0]!;
  }
  async function fixture(options: Options = {}) {
    let now = nowBase;
    let tokenCalls = 0;
    let calls = 0;
    let jwksCalls = 0;
    let nowReads = 0;
    const used = new Set<string>();
    const rejections: AiUserCallbackRejectionStage[] = [];
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls++;
      assert.equal(init?.redirect, "error"); assert.equal(init?.credentials, "omit"); assert.equal(init?.cache, "no-store");
      assert.ok(init?.signal);
      const url = String(input);
      if (url === AIUSER_ENDPOINTS.discovery) {
        if (options.responseTooLarge) return new Response(" ".repeat(65537), { headers: { "content-type": "application/json" } });
        if (options.responseRedirected) return new Response(null, { status: 302, headers: { location: "https://forbidden.invalid" } });
        return Response.json({ ...discovery, ...options.discoveryPatch }, { headers: {
          "content-type": options.wrongContentType ? "text/plain" : (options.discoveryContentType ?? "application/json"),
        } });
      }
      if (url === AIUSER_ENDPOINTS.jwks) {
        jwksCalls++;
        const headers = { "content-type": options.jwksContentType ?? "application/json" };
        if (options.rotation && jwksCalls === 1) return Response.json({ keys: [{ ...publicKey, kid: "previous-key" }] }, { headers });
        return Response.json(options.jwksValue ?? { keys: [publicKey] }, { headers });
      }
      assert.equal(url, AIUSER_ENDPOINTS.token);
      tokenCalls++;
      assert.equal(init?.method, "POST");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), `Basic ${Buffer.from(`${tuple.clientId}:${secret}`).toString("base64")}`);
      const body = new URLSearchParams(String(init?.body));
      assert.deepEqual(Array.from(body.keys()).sort(), ["code", "code_verifier", "grant_type", "redirect_uri"]);
      assert.equal(body.get("grant_type"), "authorization_code"); assert.equal(body.get("redirect_uri"), tuple.redirectUri);
      assert.equal(body.has("resource"), false); assert.equal(body.has("client_secret"), false);
      assert.equal(createHash("sha256").update(body.get("code_verifier")!).digest("base64url"), authorization.searchParams.get("code_challenge"));
      const tokenHeaders = { "content-type": options.tokenContentType ?? "application/json" };
      if (options.status) return Response.json({ error: "PRIVATE_EXCEPTION" }, { status: options.status, headers: tokenHeaders });
      if (options.delayed) now += 8000;
      const iat = Math.floor(now / 1000);
      const common = { iss: tuple.issuerUrl, sub: "synthetic-pairwise-subject", iat, exp: iat + 900 };
      const header = { alg: "ES256", kid: options.unknownKid ? "unknown-key" : publicKey.kid, ...options.invalidHeader };
      let id = await new SignJWT({ ...common, aud: tuple.clientId, nonce: authorization.searchParams.get("nonce"), ...options.idPatch })
        .setProtectedHeader(header).sign(keys.privateKey);
      if (options.badIdSignature) id = `${id.slice(0, -20)}${"A".repeat(20)}`;
      let access = await new SignJWT({ ...common, aud: tuple.audience, product_id: "aistory", membership_generation: 1,
        scope: "product.access", ...options.accessPatch }).setProtectedHeader({ ...header, typ: "at+jwt" }).sign(keys.privateKey);
      if (options.badSignature) access = `${access.slice(0, -20)}${"A".repeat(20)}`;
      return Response.json({ id_token: id, access_token: access, token_type: "Bearer", expires_in: 900,
        scope: "product.access", ...options.tokenPatch }, { headers: tokenHeaders });
    }) as typeof fetch;
    const runtime = createAiUserOidcCallback({ clientSecret: secret, fetch: fakeFetch, now: () => {
      nowReads++;
      return options.expireAtFinalCheck && nowReads >= 4 ? now + 696000 : now;
    },
      claimOnce: async (digest) => { if (used.has(digest)) return false; used.add(digest); return true; },
      allowStart: () => options.allowStart !== false,
      onCallbackRejected: (stage) => { rejections.push(stage); if (options.reporterThrows) throw new Error("PRIVATE_EXCEPTION"); },
      ...(options.onVerifiedFailure ? { onVerified: async () => { throw new Error("PRIVATE_EXCEPTION"); } } : {}),
    });
    const started = await runtime.start(startRequest());
    if (options.allowStart === false) return { runtime, started, calls: () => calls, tokenCalls: () => tokenCalls,
      jwksCalls: () => jwksCalls, rejections };
    assert.equal(started.status, 200);
    const authorization = new URL((await started.clone().json()).authorizationUrl);
    assert.equal(authorization.origin + authorization.pathname, AIUSER_ENDPOINTS.authorization);
    assert.equal(authorization.searchParams.get("scope"), "openid product.access");
    assert.equal(authorization.searchParams.get("resource"), tuple.resource);
    assert.equal(authorization.searchParams.get("redirect_uri"), tuple.redirectUri);
    assert.equal(authorization.searchParams.get("client_id"), tuple.clientId);
    const parameters = new URLSearchParams({ code: "synthetic-code-for-local-test", state: authorization.searchParams.get("state")!, iss: tuple.issuerUrl });
    const callback = (params = parameters, cookies = transactionCookie(started)) => new Request(`${tuple.redirectUri}?${params}`, { headers: { cookie: cookies } });
    return { runtime, started, parameters, callback, calls: () => calls, tokenCalls: () => tokenCalls,
      jwksCalls: () => jwksCalls, advance: (ms: number) => { now += ms; }, used, rejections };
  }
  async function deniedResponse(response: Response) {
    assertions++;
    const publicProjection = `${response.status}\n${Array.from(response.headers).flat().join("\n")}\n${await response.clone().text()}`;
    assert.doesNotMatch(publicProjection, /callback_rejected|["' ]stage["'= :]/);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { ok: false, code: "AIUSER_LOGIN_FAILED" });
    assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(response.headers.getSetCookie().some((value) => value.startsWith(`${AIUSER_IDENTITY_COOKIE}=`)), false);
  }

  const good = await fixture();
  const success = await good.runtime.callback(good.callback!());
  assert.equal(success.status, 200);
  const dto = await success.clone().json();
  assert.deepEqual(dto, { ok: true, status: "OIDC_IDENTITY_VERIFIED_ONLY", accountLinked: false,
    membershipCreated: false, entitlementGranted: false, creditsGranted: false });
  assert.deepEqual(good.rejections, []);
  assert.equal(good.tokenCalls(), 1); assert.equal(good.calls(), 3);
  const identityCookie = success.headers.getSetCookie().find((item) => item.startsWith(`${AIUSER_IDENTITY_COOKIE}=`))!;
  for (const text of [secret, "synthetic-pairwise-subject", "membershipGeneration", "access_token"]) {
    assert.equal(JSON.stringify(dto).includes(text), false); assert.equal(identityCookie.includes(text), false);
  }
  assert.ok(identityCookie.includes("HttpOnly; Secure; SameSite=Lax"));
  const identityRequest = new Request(tuple.publicOrigin, { headers: { cookie: identityCookie.split(";")[0]! } });
  const identity = await readAiUserIdentitySession(identityRequest, secret, nowBase / 1000);
  assert.equal(identity?.subject, "synthetic-pairwise-subject");
  assert.equal(identity?.idpAuthenticatedAt, null);
  assert.equal(await readAiUserIdentitySession(identityRequest, secret, nowBase / 1000 + 906), null);
  assert.equal(await readAiUserIdentitySession(identityRequest, randomBytes(48).toString("base64url"), nowBase / 1000), null);
  const oldIdpAuth = await fixture({ idPatch: { auth_time: nowBase / 1000 - 301 } });
  const oldIdpAuthResponse = await oldIdpAuth.runtime.callback(oldIdpAuth.callback!());
  const oldIdpAuthCookie = oldIdpAuthResponse.headers.getSetCookie().find((item) => item.startsWith(`${AIUSER_IDENTITY_COOKIE}=`))!;
  assert.equal((await readAiUserIdentitySession(new Request(tuple.publicOrigin, {
    headers: { cookie: oldIdpAuthCookie.split(";")[0]! },
  }), secret, nowBase / 1000))?.idpAuthenticatedAt, nowBase / 1000 - 301);
  await deniedResponse(await good.runtime.callback(good.callback!())); assert.equal(good.tokenCalls(), 1);

  for (const jwksContentType of ["application/jwk-set+json; charset=utf-8",
    'Application/JWK-Set+JSON; Charset="utf-8"; profile="public;v1"']) {
    const standardsJwks = await fixture({ jwksContentType,
      discoveryContentType: "Application/JSON; Charset=utf-8", tokenContentType: "application/json; charset=utf-8" });
    assert.equal((await standardsJwks.runtime.callback(standardsJwks.callback!())).status, 200);
    assert.equal(standardsJwks.jwksCalls(), 1);
  }

  const race = await fixture();
  const results = await Promise.all([race.runtime.callback(race.callback!()), race.runtime.callback(race.callback!())]);
  assert.deepEqual(results.map((item) => item.status).sort(), [200, 400]); assert.equal(race.tokenCalls(), 1);
  const refused = await fixture({ status: 403 });
  await deniedResponse(await refused.runtime.callback(refused.callback!()));
  await deniedResponse(await refused.runtime.callback(refused.callback!())); assert.equal(refused.tokenCalls(), 1);

  const hostileOptions: Options[] = [
    { discoveryPatch: { issuer: `${tuple.issuerUrl}/` } }, { discoveryPatch: { token_endpoint: `${tuple.issuerUrl}/other` } },
    { discoveryPatch: { jwks_uri: "https://forbidden.invalid/jwks" } }, { discoveryPatch: { code_challenge_methods_supported: ["plain"] } },
    { discoveryPatch: { response_types_supported: ["token"] } }, { discoveryPatch: { scopes_supported: ["openid"] } },
    { discoveryPatch: { id_token_signing_alg_values_supported: ["HS256"] } },
    { tokenPatch: { refresh_token: "synthetic-forbidden-refresh" } }, { tokenPatch: { refresh_token: null } },
    { tokenPatch: { token_type: "bearer" } }, { tokenPatch: { expires_in: 901 } }, { tokenPatch: { scope: "openid offline_access product.access" } },
    { tokenPatch: { id_token: "not-a-token" } }, { tokenPatch: { access_token: null } },
    { idPatch: { aud: tuple.audience } }, { idPatch: { aud: [tuple.clientId] } }, { idPatch: { iss: `${tuple.issuerUrl}/` } },
    { idPatch: { nonce: "wrong-nonce" } }, { idPatch: { iat: nowBase / 1000 + 6, exp: nowBase / 1000 + 906 } },
    { idPatch: { auth_time: nowBase / 1000 + 6 } }, { idPatch: { auth_time: nowBase / 1000 + 0.5 } },
    { idPatch: { auth_time: "recent" } }, { idPatch: { auth_time: null } }, { idPatch: { auth_time: -1 } },
    { idPatch: { exp: nowBase / 1000 + 901 } }, { idPatch: { exp: nowBase / 1000 - 6, iat: nowBase / 1000 - 906 } },
    { accessPatch: { aud: tuple.clientId } }, { accessPatch: { sub: "cross-product-subject" } },
    { accessPatch: { product_id: "linghao" } }, { accessPatch: { membership_generation: 0 } },
    { accessPatch: { membership_generation: 1.2 } }, { accessPatch: { scope: "product.access extra" } },
    { badSignature: true }, { unknownKid: true }, { invalidHeader: { jku: "https://forbidden.invalid" } },
    { jwksValue: { keys: [{ ...publicKey, d: "synthetic-private-material" }] } },
    { jwksValue: { keys: [publicKey, publicKey] } }, { jwksValue: { keys: [{ ...publicKey, crv: "P-384" }] } },
    { jwksValue: { keys: [{ ...publicKey, alg: "RS256" }] } }, { jwksValue: { keys: [] } },
    { discoveryContentType: "application/jwk-set+json" }, { tokenContentType: "application/jwk-set+json" },
    { jwksContentType: "text/json" }, { jwksContentType: "application/problem+json" },
    { jwksContentType: "application/jose+json" }, { jwksContentType: "application/vnd.example+json" },
    { jwksContentType: "application/jwk-set+json, application/json" },
    { jwksContentType: "application/jwk-set+json; charset=utf-8; CHARSET=utf-8" },
    { jwksContentType: "application/jwk-set+json; charset" },
    { jwksContentType: 'application/jwk-set+json; charset="unterminated' },
    { responseTooLarge: true }, { responseRedirected: true }, { wrongContentType: true }, { status: 500 },
  ];
  for (const options of hostileOptions) {
    const f = await fixture(options);
    await deniedResponse(await f.runtime.callback(f.callback!()));
    assert.ok(f.calls() <= 4); assert.ok(f.tokenCalls() <= 1);
    if (options.unknownKid) assert.equal(f.jwksCalls(), 2);
  }

  assert.deepEqual(AIUSER_CALLBACK_REJECTION_STAGES, ["transaction", "claimOnce", "discovery", "token_exchange",
    "token_shape", "jwks", "id_verify", "access_verify", "claims", "completion_deadline", "session_establish"]);
  assert.equal(Object.isFrozen(AIUSER_CALLBACK_REJECTION_STAGES), true);
  const diagnosticMatrix: Array<{ options?: Options; stage: AiUserCallbackRejectionStage; request: "normal" | "missing-cookie" | "replay" }> = [
    { stage: "transaction", request: "missing-cookie" },
    { stage: "claimOnce", request: "replay" },
    { options: { discoveryPatch: { issuer: `${tuple.issuerUrl}/` } }, stage: "discovery", request: "normal" },
    { options: { status: 403 }, stage: "token_exchange", request: "normal" },
    { options: { tokenPatch: { token_type: "bearer" } }, stage: "token_shape", request: "normal" },
    { options: { jwksContentType: "application/problem+json" }, stage: "jwks", request: "normal" },
    { options: { badIdSignature: true }, stage: "id_verify", request: "normal" },
    { options: { badSignature: true }, stage: "access_verify", request: "normal" },
    { options: { accessPatch: { product_id: "linghao" } }, stage: "claims", request: "normal" },
    { options: { expireAtFinalCheck: true }, stage: "completion_deadline", request: "normal" },
    { options: { onVerifiedFailure: true }, stage: "session_establish", request: "normal" },
  ];
  for (const item of diagnosticMatrix) {
    const f = await fixture(item.options);
    if (item.request === "replay") {
      assert.equal((await f.runtime.callback(f.callback!())).status, 200);
      await deniedResponse(await f.runtime.callback(f.callback!()));
    } else {
      await deniedResponse(await f.runtime.callback(f.callback!(f.parameters!, item.request === "missing-cookie" ? "" : transactionCookie(f.started))));
    }
    assert.deepEqual(f.rejections, [item.stage]);
  }
  const diagnosticFailure = await fixture({ reporterThrows: true });
  await deniedResponse(await diagnosticFailure.runtime.callback(diagnosticFailure.callback!(diagnosticFailure.parameters!, "")));
  assert.deepEqual(diagnosticFailure.rejections, ["transaction"]);

  const diagnosticLines: string[] = [];
  const stderrWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { diagnosticLines.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    for (const stage of AIUSER_CALLBACK_REJECTION_STAGES) reportAiUserOidcCallbackRejection(stage);
    const beforeInvalid = diagnosticLines.length;
    rejects(() => reportAiUserOidcCallbackRejection("unknown" as AiUserCallbackRejectionStage));
    assert.equal(diagnosticLines.length, beforeInvalid);
  } finally { process.stderr.write = stderrWrite; }
  assert.deepEqual(diagnosticLines, AIUSER_CALLBACK_REJECTION_STAGES.map((stage) => `[aiuser-oidc] callback_rejected stage=${stage}\n`));
  for (const options of [{ rotation: true }, { delayed: true }, { idPatch: { iat: nowBase / 1000 + 5, exp: nowBase / 1000 + 905 } },
    { idPatch: { auth_time: nowBase / 1000 + 5 } },
    { tokenPatch: { expires_in: 600 }, idPatch: { exp: nowBase / 1000 + 600 }, accessPatch: { exp: nowBase / 1000 + 600 } }]) {
    const f = await fixture(options);
    assert.equal((await f.runtime.callback(f.callback!())).status, 200); assertions++;
  }
  // The product transaction spans AIUser's bounded human interaction plus the
  // separately minted 90-second code. It must not expire during an ordinary
  // registration/login/join flow, while still failing closed at its hard bound.
  const humanInteraction = await fixture(); humanInteraction.advance!(300000);
  assert.equal((await humanInteraction.runtime.callback(humanInteraction.callback!())).status, 200);
  assert.equal(humanInteraction.tokenCalls(), 1); assertions++;

  const parameterAttacks = [
    (p: URLSearchParams) => p.append("state", "duplicate"), (p: URLSearchParams) => p.set("state", "wrong"),
    (p: URLSearchParams) => p.delete("code"), (p: URLSearchParams) => p.set("error", "access_denied"),
    (p: URLSearchParams) => p.set("iss", `${tuple.issuerUrl}/`), (p: URLSearchParams) => p.set("redirect_uri", "https://forbidden.invalid"),
    (p: URLSearchParams) => p.set("error_description", "PRIVATE_EXCEPTION"),
  ];
  for (const attack of parameterAttacks) {
    const f = await fixture(); const params = new URLSearchParams(f.parameters!); attack(params);
    await deniedResponse(await f.runtime.callback(f.callback!(params))); assert.equal(f.calls(), 0);
  }
  for (const attack of ["missing-cookie", "duplicate-cookie", "corrupt-cookie", "expired"] as const) {
    const f = await fixture(); let cookies = transactionCookie(f.started);
    if (attack === "missing-cookie") cookies = "";
    if (attack === "duplicate-cookie") cookies += `; ${cookies}`;
    if (attack === "corrupt-cookie") cookies += "x";
    if (attack === "expired") f.advance!(696000);
    await deniedResponse(await f.runtime.callback(f.callback!(f.parameters!, cookies))); assert.equal(f.calls(), 0);
  }
  const noMembership = await fixture();
  const errorParams = new URLSearchParams(noMembership.parameters!); errorParams.delete("code"); errorParams.set("error", "access_denied");
  await deniedResponse(await noMembership.runtime.callback(noMembership.callback!(errorParams))); assert.equal(noMembership.calls(), 0);
  assert.equal(noMembership.used!.size, 1);
  for (const patch of [
    { headers: { origin: "https://forbidden.invalid", "sec-fetch-site": "same-origin", "content-type": "application/json" } },
    { headers: { origin: tuple.publicOrigin, "sec-fetch-site": "cross-site", "content-type": "application/json" } },
    { headers: { origin: tuple.publicOrigin, "sec-fetch-site": "same-origin", "content-type": "text/plain" } },
    { body: "x".repeat(4096) }, { body: '{"returnTo":"https://forbidden.invalid"}' },
  ]) { await deniedResponse(await good.runtime.start(startRequest(patch))); }
  const throttled = await fixture({ allowStart: false }); await deniedResponse(throttled.started); assert.equal(throttled.calls(), 0);

  // Actual Next Node adapter. The root-configured internal URL is the raw
  // loopback origin the production listener exposes, but Next 16 normalizes that
  // loopback alias to `localhost` unless the production flag is truthy. Cover
  // both framework modes so a config/receipt re-pin cannot silently regress.
  const { NextRequestAdapter } = await import("next/dist/server/web/spec-extension/adapters/next-request");
  const { addRequestMeta } = await import("next/dist/server/request-meta");
  const { Readable } = await import("node:stream");
  const proxyRuntime = createAiUserOidcCallback({ clientSecret: secret, fetch: globalThis.fetch, now: () => nowBase,
    allowStart: () => true, claimOnce: async () => true, proxyRequestOrigin: config.proxyRequestOrigin });
  function proxyRequest(overrides: Record<string, string> = {}, initOrigin = "https://127.0.0.1:54444") {
    const request = { method: "POST", url: "/api/auth/aiuser/start", body: Readable.from([Buffer.from("{}")]),
      headers: { host: "play.hibcglobal.com", origin: tuple.publicOrigin, "x-forwarded-proto": "https",
        "x-forwarded-host": "play.hibcglobal.com", "sec-fetch-site": "same-origin", "content-type": "application/json", ...overrides } };
    addRequestMeta(request as never, "initURL", `${initOrigin}/api/auth/aiuser/start`);
    return NextRequestAdapter.fromNodeNextRequest(request as never, new AbortController().signal);
  }
  const proxyAttacks: Record<string, string>[] = [{ "x-forwarded-host": "attacker.invalid" }, { "x-forwarded-proto": "http" },
    { host: "attacker.invalid" }, { "x-forwarded-proto": "https,http" }];
  // The framework flag is captured before either adapter mode is exercised and
  // restored by one outer `finally`, so an ambient parent/CI value cannot turn
  // the default-mode assertions into production-mode ones and a throwing
  // assertion cannot leak the flag into the later callback/route tests.
  const normalizationDescriptor = Object.getOwnPropertyDescriptor(process.env, "__NEXT_NO_MIDDLEWARE_URL_NORMALIZE");
  try {
    // Default mode: explicitly clear the flag, then confirm Next normalizes the
    // raw loopback URL to `localhost`, which is exactly the historical pin, so
    // the otherwise valid start is accepted.
    delete process.env.__NEXT_NO_MIDDLEWARE_URL_NORMALIZE;
    assert.equal(config.proxyRequestOrigin, "https://localhost:54444");
    assert.equal(new URL(proxyRequest().url).origin, "https://localhost:54444");
    assert.equal((await proxyRuntime.start(proxyRequest())).status, 200); assertions++;
    await deniedResponse(await good.runtime.start(proxyRequest()));
    for (const overrides of proxyAttacks) {
      await deniedResponse(await proxyRuntime.start(proxyRequest(overrides)));
    }
    // Production mode: the raw `https://127.0.0.1:54444` URL survives. A runtime
    // pinned to that exact raw origin accepts the valid start; the historical
    // localhost pin and every header/URL mismatch fail closed with the unchanged
    // public 400 contract.
    process.env.__NEXT_NO_MIDDLEWARE_URL_NORMALIZE = "1";
    const rawProxyRuntime = createAiUserOidcCallback({ clientSecret: secret, fetch: globalThis.fetch, now: () => nowBase,
      allowStart: () => true, claimOnce: async () => true, proxyRequestOrigin: "https://127.0.0.1:54444" });
    const rawRequest = proxyRequest();
    assert.equal(new URL(rawRequest.url).origin, "https://127.0.0.1:54444");
    assert.equal(rawRequest.nextUrl.origin, "https://localhost:54444");
    assert.equal((await rawProxyRuntime.start(proxyRequest())).status, 200); assertions++;
    await deniedResponse(await proxyRuntime.start(proxyRequest()));
    await deniedResponse(await good.runtime.start(proxyRequest()));
    for (const overrides of proxyAttacks) {
      await deniedResponse(await rawProxyRuntime.start(proxyRequest(overrides)));
    }
    await deniedResponse(await rawProxyRuntime.start(proxyRequest({}, "http://127.0.0.1:54444")));
    await deniedResponse(await rawProxyRuntime.start(proxyRequest({}, "https://127.0.0.1:54445")));
  } finally {
    if (normalizationDescriptor) Object.defineProperty(process.env, "__NEXT_NO_MIDDLEWARE_URL_NORMALIZE", normalizationDescriptor);
    else delete process.env.__NEXT_NO_MIDDLEWARE_URL_NORMALIZE;
  }

  const disabled = createAiUserOidcHttpBoundary(async () => null);
  const failedLoader = createAiUserOidcHttpBoundary(async () => { throw new Error("PRIVATE_EXCEPTION"); });
  for (const boundary of [disabled, failedLoader]) {
    const response = await boundary("callback", new Request(tuple.redirectUri));
    assert.equal(response.status, 503); assert.deepEqual(await response.json(), { ok: false, code: "AIUSER_LOGIN_UNAVAILABLE" });
  }
  // Actual route graph + disabled loader, never the caller's environment values.
  const modeDescriptor = Object.getOwnPropertyDescriptor(process.env, "AISTORY_AIUSER_OIDC_CALLBACK_MODE");
  process.env.AISTORY_AIUSER_OIDC_CALLBACK_MODE = "disabled";
  try {
    assert.equal((await callbackRoute.GET(new Request(tuple.redirectUri))).status, 503);
    process.env.AISTORY_AIUSER_OIDC_CALLBACK_MODE = "unknown-mode";
    assert.equal((await callbackRoute.GET(new Request(tuple.redirectUri))).status, 503);
  } finally {
    if (modeDescriptor) Object.defineProperty(process.env, "AISTORY_AIUSER_OIDC_CALLBACK_MODE", modeDescriptor);
    else delete process.env.AISTORY_AIUSER_OIDC_CALLBACK_MODE;
  }
  const middleware = fs.readFileSync("middleware.ts", "utf8");
  const bypass = middleware.indexOf('pathname === "/api/auth/aiuser/start"');
  assert.ok(bypass > 0 && bypass < middleware.indexOf("process.env.NEXT_PUBLIC_SUPABASE_URL"));
  for (const filename of ["lib/auth/aiUserOidcCallback.ts", "lib/auth/aiUserOidcCallbackServer.ts",
    "app/api/auth/aiuser/start/route.ts", "app/api/auth/aiuser/callback/route.ts"]) {
    const source = fs.readFileSync(filename, "utf8");
    const imports = source.match(/(?:import|export)[\s\S]*?from\s+["'][^"']+["']/g) ?? [];
    for (const statement of imports) assert.doesNotMatch(statement, /billing|phone|userSession|supabase|admin|provider|credentials\/hosted/);
    assert.doesNotMatch(source, /console\.|ensureMembership|initial_grant|createUser|AISTORY_USER_SESSION_SECRET/);
  }
  const callbackServerSource = fs.readFileSync("lib/auth/aiUserOidcCallbackServer.ts", "utf8");
  assert.match(callbackServerSource, /onCallbackRejected: reportAiUserOidcCallbackRejection/);
  assert.match(callbackServerSource, /process\.stderr\.write\(`\[aiuser-oidc\] callback_rejected stage=\$\{stage\}\\n`\)/);
  assert.equal(AIUSER_CALLBACK_MODE, "aistory-aiuser-oidc-callback-v1:enabled");
  assert.equal(networkCalls, 0); assert.equal(writesPerformed, 0); assert.equal(accessorCalls, 0);
  console.log(JSON.stringify({ status: "PASS_LOCAL_DEFAULT_OFF_OIDC_CALLBACK", hostileAssertions: assertions,
    authoritySignature: "ES256", replay: "one_exchange", externalNetworkCalls: networkCalls,
    persistentWrites: writesPerformed, accessorCalls, membershipWrites: 0, entitlementWrites: 0, creditWrites: 0,
    productionEnabled: false, productionE2E: false }));
} finally {
  for (const restore of undo.reverse()) restore();
  syncBuiltinESMExports();
}
