// Isolated HTTP/React harness with an in-memory issuer/replay store. No real account or secret.
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createAiUserUserRuntime, AIUSER_PRODUCT_SESSION_COOKIE, clearAiUserProductCookie, hasAiUserProductCookie } from "../lib/auth/aiUserProductSession";
import { AIUSER_ENDPOINTS, AIUSER_IDENTITY_COOKIE, AIUSER_TRANSACTION_COOKIE } from "../lib/auth/aiUserOidcCallback";
import { AIUSER_OIDC_PRODUCTION_BETA_REGISTRATION as tuple } from "../lib/auth/aiUserOidcProductionBeta";
import { aiUserPublicAccount } from "../lib/auth/aiUserAccountPublic";

const args = process.argv.slice(2);
assert.ok(JSON.stringify(args) === '["--serve-only"]' || JSON.stringify(args) === '["--serve-only","--existing-membership"]');
const nativeFetch = globalThis.fetch;
let networkAttempts = 0;
globalThis.fetch = (() => { networkAttempts++; throw Error("test_external_network_forbidden"); }) as typeof fetch;
// The isolated browser bundle is optional tooling: some confined workers cannot
// spawn an esbuild service. The synthetic API surface must still be runnable for
// contract checks, so a missing bundle degrades to an explicit 503 for /bundle.js
// instead of failing the whole harness. No network access is added by this path.
const pnpm = path.resolve("node_modules/.pnpm");
let js = "";
let bundleReady = false;
try {
  const esbuildName = (await readdir(pnpm)).filter((name) => /^esbuild@\d/.test(name)).sort().at(-1)!;
  const { build } = await import(pathToFileURL(path.join(pnpm, esbuildName, "node_modules/esbuild/lib/main.js")).href);
  const bundle = await build({ entryPoints: [path.resolve("scripts/fixtures/aiuser-user-integration-browser.tsx")],
    bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", logLevel: "silent",
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [{ name: "test-link", setup(plugin: { onResolve: (options: { filter: RegExp }, callback: () => object) => void;
      onLoad: (options: { filter: RegExp; namespace: string }, callback: () => object) => void }) {
      plugin.onResolve({ filter: /^next\/link$/ }, () => ({ path: "link", namespace: "test-link" }));
      plugin.onLoad({ filter: /.*/, namespace: "test-link" }, () => ({ contents: 'import React from "react";export default function Link(p){return React.createElement("a",p)}', loader: "js", resolveDir: process.cwd() }));
    } }],
  });
  const text = bundle.outputFiles[0]?.text;
  if (typeof text !== "string") throw Error("test_bundle_output");
  js = text;
  bundleReady = true;
} catch (error) {
  // A confined worker cannot spawn the esbuild service (EPERM on spawn). Keep the
  // synthetic API runnable and surface the missing bundle as an explicit 503; any
  // other build failure is a real harness defect and must still fail loudly.
  if ((error as { code?: string } | null)?.code !== "EPERM") throw error;
  bundleReady = false;
}
const pair = await generateKeyPair("ES256", { extractable: true });
const jwk = { ...await exportJWK(pair.publicKey), kid: "isolated-test", use: "sig", alg: "ES256" };
const secret = randomBytes(48).toString("base64url");
const csrf = randomBytes(32).toString("base64url");
const claims = new Set<string>();
const codes = new Map<string, URL>();
let pending: URL | undefined;
let nowOffset = 0;
let membership = args.includes("--existing-membership");
let enabled = true;
let exchanges = 0;
let joins = 0;
let loggedOut = 0;
let authorityNavigation = 0;
let joinRequests = 0;
let rejectedRequests = 0;
let joinPhase = "not_attempted";
let delayStart = false, delayRead = false;
let accountReadHeld = false;
let releaseRead: (() => void) | undefined;
const now = () => Date.now() + nowOffset;
const runtime = createAiUserUserRuntime({ clientSecret: secret, now, allowStart: () => true,
  isClaimed: async (digest) => claims.has(digest),
  claimOnce: async (digest) => { if (claims.has(digest)) return false; claims.add(digest); return true; },
  fetch: (async (input: string | URL | Request, init?: RequestInit) => {
    const target = String(input);
    if (target === AIUSER_ENDPOINTS.discovery) return Response.json({ issuer: tuple.issuerUrl,
      authorization_endpoint: AIUSER_ENDPOINTS.authorization, token_endpoint: AIUSER_ENDPOINTS.token,
      jwks_uri: AIUSER_ENDPOINTS.jwks, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_basic"], id_token_signing_alg_values_supported: ["ES256"], scopes_supported: ["openid", "product.access"] });
    if (target === AIUSER_ENDPOINTS.jwks) return Response.json({ keys: [jwk] });
    assert.equal(target, AIUSER_ENDPOINTS.token); exchanges++;
    const form = new URLSearchParams(String(init?.body));
    const authorization = codes.get(form.get("code") ?? "");
    if (!membership || !authorization) return Response.json({ error: "denied" }, { status: 403 });
    codes.delete(form.get("code")!);
    assert.equal(form.has("resource"), false);
    assert.equal(form.get("redirect_uri"), tuple.redirectUri);
    assert.equal(createHash("sha256").update(form.get("code_verifier")!).digest("base64url"), authorization.searchParams.get("code_challenge"));
    const common = { iss: tuple.issuerUrl, sub: "synthetic-browser-subject", iat: Math.floor(now() / 1000), exp: Math.floor(now() / 1000) + 900 };
    const idToken = await new SignJWT({ ...common, aud: tuple.clientId, nonce: authorization.searchParams.get("nonce") })
      .setProtectedHeader({ alg: "ES256", kid: jwk.kid, typ: "JWT" }).sign(pair.privateKey);
    const accessToken = await new SignJWT({ ...common, aud: tuple.audience, product_id: "aistory", scope: "product.access", membership_generation: 1 })
      .setProtectedHeader({ alg: "ES256", kid: jwk.kid, typ: "at+jwt" }).sign(pair.privateKey);
    return Response.json({ id_token: idToken, access_token: accessToken, token_type: "Bearer", expires_in: 900, scope: "product.access" });
  }) as typeof fetch,
});

// Synthetic stale-session regression constants. The marker only exists in this
// harness; the cookie value is a fixed non-secret that can never decrypt, and the
// status surface below never exposes any cookie value to callers.
const STALE_AIUSER_COOKIE_VALUE = "aistory-synthetic-stale-aiuser-product-cookie-v1";
const STALE_AIUSER_MARKER = "__test_stale_aiuser_cookie";
const STALE_RECOVERY_ACTION = "清理失效的 AIUser 登录状态";
// Fixed, non-secret product copy the panel renders from a dedicated role=status
// node once cleanup is confirmed. Referencing this deterministic label keeps the
// test-only step machine-checkable without exposing any cookie or session value.
const STALE_CLEANUP_CONFIRMED_STATUS = "已确认清理本网站上失效的 AIUser 登录状态；不会注销或删除 AIUser 账户，也不影响本机剧情。可重新登录。";
const STALE_SCENARIO_PATH = `/auth/aiuser?status=failed&${STALE_AIUSER_MARKER}=1`;
let port = 0;
let staleCookieSeeded = 0;
let invalidAiUserReads = 0;
let logoutRejected = 0;
function staleAiUserProductCookie() {
  return `${AIUSER_PRODUCT_SESSION_COOKIE}=${STALE_AIUSER_COOKIE_VALUE}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=300`;
}
function html(body: string, nativeForm = false, cookies: string[] = []) {
  const headers = new Headers({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": nativeForm ? "same-origin" : "no-referrer",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'none'; frame-src 'none'; form-action 'self'; base-uri 'none'" });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(`<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>AIstory 隔离登录验收</title><style>body{margin:0;background:#101522;color:#eef2fa;font:16px/1.7 system-ui}main{max-width:640px;margin:40px auto;padding:20px}button,a{color:inherit}button{background:#253955;padding:12px;border:1px solid #8294af;border-radius:8px}input{margin:12px}a{display:inline-block;margin:12px}</style></head><body>${body}</body></html>`, { headers });
}
async function boundedBody(incoming: IncomingMessage): Promise<string> {
  let bytes = 0; const chunks: Buffer[] = [];
  for await (const chunk of incoming) { bytes += chunk.length; if (bytes > 2048) throw Error("test_body"); chunks.push(chunk); }
  return Buffer.concat(chunks).toString("utf8");
}
async function dispatch(incoming: IncomingMessage): Promise<Response> {
  const host = incoming.headers.host ?? "";
  const localOrigin = `http://${host}`;
  if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(host) || !["127.0.0.1", "::ffff:127.0.0.1"].includes(incoming.socket.remoteAddress ?? "")) return new Response(null, { status: 403 });
  const url = new URL(incoming.url ?? "/", localOrigin);
  if (incoming.method === "GET" && url.pathname === "/bundle.js") {
    if (!bundleReady) return new Response(JSON.stringify({ error: "SYNTHETIC_BUNDLE_UNAVAILABLE" }), { status: 503, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    return new Response(js, { headers: { "Content-Type": "application/javascript", "Cache-Control": "no-store" } });
  }
  if (incoming.method === "GET" && ["/", "/auth/aiuser"].includes(url.pathname)) {
    const seedStale = url.pathname === "/auth/aiuser" && url.searchParams.get(STALE_AIUSER_MARKER) === "1";
    if (seedStale) staleCookieSeeded++;
    return html('<div id="root"></div><script src="/bundle.js"></script>', false, seedStale ? [staleAiUserProductCookie()] : []);
  }
  if (incoming.method === "GET" && url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
  if (url.pathname === "/issuer/authorize" && incoming.method === "GET") {
    assert.equal(url.searchParams.get("client_id"), tuple.clientId);
    assert.equal(url.searchParams.get("redirect_uri"), tuple.redirectUri);
    assert.equal(url.searchParams.get("scope"), "openid product.access");
    assert.equal(url.searchParams.get("resource"), tuple.resource);
    pending = url; authorityNavigation++;
    if (membership) {
      const code = randomBytes(24).toString("base64url"); codes.set(code, pending); pending = undefined;
      const query = new URLSearchParams({ state: url.searchParams.get("state")!, code, iss: tuple.issuerUrl });
      return new Response(null, { status: 303, headers: { Location: `/api/auth/aiuser/callback?${query}`, "Referrer-Policy": "no-referrer" } });
    }
    // Exact AIUser native-form-origin-v2 contract: no Origin fallback or injection.
    return html(`<main><h1>合成 AIUser 确认页</h1><p>仅用于本机测试，不是真实账号或服务条款。</p><form method="post" action="/issuer/join"><input type="hidden" name="csrfToken" value="${csrf}"><input type="hidden" name="acceptedRevision" value="aistory-public-beta-resettable-v1"><label><input type="checkbox" name="confirmJoin" value="yes" required>主动加入 AIstory（合成）</label><br><label><input type="checkbox" name="acceptResettableData" value="yes" required>知晓本测试数据可重置</label><br><button type="submit">确认并返回 AIstory</button></form><a href="/issuer/cancel">取消本次登录</a></main>`, true);
  }
  if (url.pathname === "/issuer/cancel" && pending) {
    const query = new URLSearchParams({ state: pending.searchParams.get("state")!, error: "access_denied", iss: tuple.issuerUrl });
    return new Response(null, { status: 303, headers: { Location: `/api/auth/aiuser/callback?${query}` } });
  }
  if (url.pathname === "/issuer/join" && incoming.method === "POST") {
    joinRequests++;
    joinPhase = incoming.headers.origin === undefined ? "origin_absent" : incoming.headers.origin === "null" ? "origin_null" : "origin_other";
    assert.equal(incoming.headers.origin, localOrigin);
    joinPhase = "body";
    const form = new URLSearchParams(await boundedBody(incoming));
    joinPhase = "shape";
    assert.deepEqual(Array.from(form.keys()).sort(), ["acceptResettableData", "acceptedRevision", "confirmJoin", "csrfToken"]);
    joinPhase = "binding";
    assert.equal(form.get("csrfToken"), csrf); assert.equal(form.get("acceptedRevision"), "aistory-public-beta-resettable-v1");
    assert.equal(form.get("confirmJoin"), "yes"); assert.equal(form.get("acceptResettableData"), "yes"); assert.ok(pending);
    joinPhase = "accepted";
    if (!membership) { membership = true; joins++; }
    const code = randomBytes(24).toString("base64url"); codes.set(code, pending);
    const query = new URLSearchParams({ state: pending.searchParams.get("state")!, code, iss: tuple.issuerUrl }); pending = undefined;
    return new Response(null, { status: 303, headers: { Location: `/api/auth/aiuser/callback?${query}` } });
  }
  if (url.pathname === "/__test/status") return Response.json({ authorityNavigation, joinRequests, joinPhase, rejectedRequests, joins, exchanges, loggedOut, accountReadHeld, networkAttempts, membershipWrites: joins, businessCredits: 0, adminCapabilities: 0, bundleReady, staleCookieSeeded, invalidAiUserReads, logoutRejected });
  if (url.pathname === "/__test/steps" && incoming.method === "GET") return Response.json({
    scenario: "aiuser_stale_session_recovery",
    origin: localOrigin,
    url: `${localOrigin}${STALE_SCENARIO_PATH}`,
    cookieValueExposed: false,
    steps: [
      { step: "navigate", url: `${localOrigin}${STALE_SCENARIO_PATH}`, expect: `response seeds one malformed HttpOnly+Secure ${AIUSER_PRODUCT_SESSION_COOKIE}` },
      { step: "observe", expression: "globalThis.__aistoryStaleSessionHarness.snapshot()", expect: { cleanupActionVisible: true, cleanupActionEnabled: true } },
      { step: "click", target: `button with exact text ${STALE_RECOVERY_ACTION}` },
      { step: "observe", expression: "globalThis.__aistoryStaleSessionHarness.snapshot()", expect: { cleanupActionVisible: false, loginButtonVisible: true, loginButtonEnabled: true, statusTextsIncludes: STALE_CLEANUP_CONFIRMED_STATUS }, note: "cleanup is confirmed once the recovery action is gone, the ordinary AIUser login button is visible and enabled, and at least one fixed role=status message confirms the cleanup; the original callback-failure notice may remain visible and is accurate context, not a functional failure" },
      { step: "fetch", method: "GET", url: `${localOrigin}/__test/status`, expect: { staleCookieSeeded: 1, invalidAiUserReads: ">=1", loggedOut: 1, logoutRejected: 0, networkAttempts: 0, membershipWrites: 0, businessCredits: 0, adminCapabilities: 0 } },
    ],
    note: "Synthetic loopback only; no real AIUser issuer, membership, credits or administrator state.",
  });
  if (url.pathname === "/__test/delay-start" && incoming.method === "POST") { delayStart = true; return Response.json({ ok: true }); }
  if (url.pathname === "/__test/delay-read" && incoming.method === "POST") { delayRead = true; return Response.json({ ok: true }); }
  if (url.pathname === "/__test/release-read" && incoming.method === "POST") { releaseRead?.(); releaseRead = undefined; return Response.json({ ok: true }); }
  if (url.pathname === "/__test/expire" && incoming.method === "POST") { nowOffset += 901000; return Response.json({ ok: true }); }
  if (url.pathname === "/__test/disabled" && incoming.method === "POST") { enabled = false; return Response.json({ ok: true }); }
  if (url.pathname === "/__test/stop" && incoming.method === "POST") { setTimeout(() => server.close(), 50); return Response.json({ ok: true }); }
  if (url.pathname === "/api/auth/aiuser/capabilities") return Response.json({ enabled, linkingEnabled: false });
  const requestHeaders = new Headers();
  if (incoming.headers.cookie) requestHeaders.set("cookie", incoming.headers.cookie);
  // Test-only loopback transport maps its independently checked origin to the exact production contract.
  // App source retains its HTTPS-only origin and Secure/__Host cookie requirements.
  if (incoming.method === "POST" || incoming.method === "DELETE") {
    const sameOrigin = incoming.headers.origin === localOrigin && incoming.headers["sec-fetch-site"] === "same-origin";
    if (!sameOrigin) { if (incoming.method === "DELETE") logoutRejected++; return new Response(null, { status: 403 }); }
    if (incoming.method === "DELETE") {
      // The production route only accepts a completed zero-byte DELETE body.
      const length = incoming.headers["content-length"];
      if ((length !== undefined && length !== "0") || incoming.headers["transfer-encoding"] !== undefined) { logoutRejected++; return new Response(null, { status: 403 }); }
    }
    requestHeaders.set("origin", tuple.publicOrigin); requestHeaders.set("sec-fetch-site", "same-origin");
  }
  if (incoming.headers["content-type"]) requestHeaders.set("content-type", incoming.headers["content-type"]);
  const body = incoming.method === "POST" ? await boundedBody(incoming) : undefined;
  const request = new Request(`${tuple.publicOrigin}${url.pathname}${url.search}`, { method: incoming.method, headers: requestHeaders, ...(body ? { body } : {}) });
  if (url.pathname === "/api/auth/aiuser/start") {
    if (delayStart) { delayStart = false; await new Promise((resolve) => setTimeout(resolve, 2000)); }
    return enabled ? runtime.start(request) : new Response(null, { status: 503 });
  }
  if (url.pathname === "/api/auth/aiuser/callback") {
    const response = await runtime.callback(request);
    if (response.status === 400) { const headers = new Headers(response.headers); headers.set("Location", "/auth/aiuser?status=failed"); return new Response(null, { status: 303, headers }); }
    return response;
  }
  if (url.pathname === "/api/account/me" && incoming.method === "GET") {
    const hasProductCookie = hasAiUserProductCookie(request);
    const session = await runtime.business.read(request);
    if (delayRead) { delayRead = false; accountReadHeld = true; await new Promise<void>((resolve) => { releaseRead = resolve; }); accountReadHeld = false; }
    // Externally visible fail-closed contract: a present-but-undecodable AIUser
    // product cookie is never treated as signed-out and never falls through.
    if (hasProductCookie && !session) {
      invalidAiUserReads++;
      return Response.json({ error: "Session expired or unavailable.", code: "AIUSER_SESSION_UNAVAILABLE" }, { status: 401, headers: { "Cache-Control": "no-store" } });
    }
    return Response.json({ authenticated: !!session, account: session ? aiUserPublicAccount(session.expiresAt) : null }, { headers: { "Cache-Control": "no-store" } });
  }
  if (url.pathname === "/api/account/me" && incoming.method === "DELETE") {
    const pendingClears = await runtime.business.logout(request); loggedOut++;
    const headers = new Headers({ "Cache-Control": "no-store" }); headers.append("Set-Cookie", clearAiUserProductCookie());
    for (const clear of pendingClears) headers.append("Set-Cookie", clear);
    for (const name of [AIUSER_IDENTITY_COOKIE, AIUSER_TRANSACTION_COOKIE]) headers.append("Set-Cookie", `${name}=; Secure; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
    return Response.json({ ok: true }, { headers });
  }
  return new Response(null, { status: 404 });
}
const server = createServer(async (incoming, outgoing) => {
  try {
    const response = await dispatch(incoming);
    outgoing.statusCode = response.status;
    response.headers.forEach((value, key) => { if (key !== "set-cookie") outgoing.setHeader(key, value); });
    const cookies = response.headers.getSetCookie(); if (cookies.length) outgoing.setHeader("Set-Cookie", cookies);
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch { rejectedRequests++; outgoing.statusCode = 400; outgoing.end("synthetic_request_rejected"); }
});
server.listen(0, "127.0.0.1");
await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
const address = server.address(); assert.ok(address && typeof address !== "string"); port = address.port;
assert.ok(![3000, 4200, 4107, 5679, 8188, 19527].includes(port));
assert.doesNotMatch(await readFile("app/api/auth/aiuser/callback/route.ts", "utf8"), /scripts|fixtures/);
const expiry = setTimeout(() => server.close(), 20 * 60 * 1000);
console.log(JSON.stringify({ status: "SYNTHETIC_HTTP_REACT_READY", origin: `http://127.0.0.1:${port}`, processId: process.pid,
  realAccount: false, externalNetwork: networkAttempts, cookie: AIUSER_PRODUCT_SESSION_COOKIE, bundleReady,
  staleSessionUrl: `http://127.0.0.1:${port}${STALE_SCENARIO_PATH}` }));
await new Promise<void>((resolve) => server.once("close", resolve));
clearTimeout(expiry); globalThis.fetch = nativeFetch;
console.log(JSON.stringify({ status: "SYNTHETIC_HTTP_REACT_CLOSED", authorityNavigation, joins, exchanges, loggedOut, networkAttempts, staleCookieSeeded, invalidAiUserReads, logoutRejected }));
