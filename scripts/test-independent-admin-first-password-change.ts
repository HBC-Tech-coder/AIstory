import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import {
  createFirstChangeIndependentAdminCredential, serializeIndependentAdminPrincipalCredential,
  rotateFirstChangeIndependentAdminPassword,
} from "@/lib/admin/independentPrincipal";
import { INDEPENDENT_ADMIN_PASSWORD_POLICY, independentAdminPasswordPolicyViolation,
  isIndependentAdminPasswordAllowed } from "@/lib/admin/independentPasswordPolicy";
import { FIRST_PASSWORD_CHANGE_ENV, FIRST_PASSWORD_CHANGE_POLICY,
  firstChangeBinding, firstChangePasswordState, exactFirstChangeRecord, readFirstPasswordState,
} from "@/lib/admin/independentFirstPasswordChange";
import { handleIndependentAdminPrincipalProductionLogin as login, handleIndependentAdminPrincipalProductionMe as me,
  resolveIndependentAdminPrincipalAuthorizedContext as authority, handleIndependentAdminPasswordChange as performChange,
  handleIndependentAdminPrincipalProductionLogout as logout, independentAdminNavigationState as navigation,
  type IndependentAdminPrincipalServerOptions,
} from "@/lib/admin/independentPrincipalServer";
import { parseTemporaryBootstrapInput } from "./bootstrap-independent-admin-temporary";
import { PendingActivationFake, syntheticAdminEnvironment } from "./fixtures/independent-admin-pending-activation-v2";
import * as actualServer from "@/lib/admin/independentPrincipalServer";

let networkCalls = 0;
const savedFetch = globalThis.fetch;
globalThis.fetch = async () => { networkCalls++; throw Error("network forbidden"); };
const now = Date.parse("2026-08-31T04:00:00Z");
const origin = "https://admin.example.invalid";
const seed = await createFirstChangeIndependentAdminCredential({ username: "admin", password: "admin888" });
const nextPassword = "Aa1aaaaaa";
const raw = serializeIndependentAdminPrincipalCredential(seed);
const env = syntheticAdminEnvironment;
class Fake extends PendingActivationFake {
  constructor() { super(seed, now); }
}
class InterleavedFake extends Fake {
  beforeRpc?: { name: string; run: () => Promise<void> | void };
  override async rpc(name: string, args?: Record<string, unknown>) {
    if (this.beforeRpc?.name === name) {
      const hook = this.beforeRpc; this.beforeRpc = undefined;
      await hook.run();
    }
    return super.rpc(name, args);
  }
}
function options(fake: Fake): IndependentAdminPrincipalServerOptions { return fake.options(); }
const change = performChange;
function request(body: unknown, url = body && typeof body === "object" && "currentPassword" in body ? "/api/admin/password-change" : "/api/admin/session", headers: Record<string,string> = {}, method = "POST") {
  return new Request(origin + url, { method, headers: { origin, host: "admin.example.invalid", "content-type": "application/json",
    "x-aistory-admin-action": "first-password-change-v1", ...headers }, body: JSON.stringify(body) });
}
async function temporary(fake: Fake) {
  const r = await login(request({ username: "admin", password: "admin888" }), options(fake));
  assert.equal(r.response.status, 200); assert.ok(r.sessionToken);
  assert.deepEqual(await r.response.json(), { ok: true, authMode: "independent", state: "password_change_required" });
  return r.sessionToken!;
}
const summaries: unknown[] = [];

async function actualRouteCookieTests() {
  // Execute the unmodified Next route wrappers, retaining real NextResponse and
  // Cookie serialization. Only runtime options and request Cookie context fake.
  const require = createRequire(import.meta.url);
  const { build } = require(require.resolve("esbuild", { paths: [path.dirname(require.resolve("tsx"))] })) as {
    build(options: unknown): Promise<{ outputFiles: Array<{ text: string }> }>;
  };
  type BuildApi = {
    onResolve(options: { filter: RegExp }, fn: (args: { path: string; importer: string }) => unknown): void;
    onLoad(options: { filter: RegExp; namespace: string }, fn: (args: { path: string }) => unknown): void;
  };
  let fake = new Fake(); let cookie: string | undefined;
  let selectedEnv: Record<string, string | undefined> = env;
  const bridge = { actualServer, options: () => ({ ...options(fake), env: selectedEnv }), env: () => selectedEnv,
    cookie: (name: string) => name === actualServer.INDEPENDENT_ADMIN_PRINCIPAL_PRODUCTION_COOKIE && cookie ? { value: cookie } : undefined };
  const routes = ["app/api/admin/session/route.ts", "app/api/admin/password-change/route.ts"].map(file => path.resolve(file).replaceAll("\\", "/"));
  const result = await build({ stdin: { contents: `export * as session from ${JSON.stringify(routes[0])};export * as change from ${JSON.stringify(routes[1])};`,
    resolveDir: process.cwd(), sourcefile: "synthetic-routes.ts" }, bundle: true, write: false, platform: "node", format: "cjs",
    packages: "external", logLevel: "silent", plugins: [{ name: "synthetic-route-context", setup(api: BuildApi) {
      api.onResolve({ filter: /^(next\/headers|@\/lib\/admin\/(independentPrincipalServer|security|service))$/ }, args => {
        if (args.path === "next/headers" || /app[\\/]api[\\/]admin/.test(args.importer)) return { path: args.path, namespace: "route-test" };
      });
      api.onResolve({ filter: /^__pending_activation_bridge$/ }, () => ({ path: "__pending_activation_bridge", external: true }));
      api.onLoad({ filter: /.*/, namespace: "route-test" }, ({ path: modulePath }) => {
        const prelude = 'const b=require("__pending_activation_bridge");';
        if (modulePath === "next/headers") return { contents: prelude + 'export async function cookies(){return {get:b.cookie};}', loader: "js" };
        if (modulePath.endsWith("/independentPrincipalServer")) return { contents: prelude + `
          export const INDEPENDENT_ADMIN_PRINCIPAL_PRODUCTION_COOKIE=b.actualServer.INDEPENDENT_ADMIN_PRINCIPAL_PRODUCTION_COOKIE;
          export const independentAdminPrincipalProductionCookieOptions=b.actualServer.independentAdminPrincipalProductionCookieOptions;
          export const isIndependentAdminPrincipalProductionModeSelected=()=>b.actualServer.isIndependentAdminPrincipalProductionModeSelected(b.env());
          export const hasIndependentAdminPrincipalModeValue=()=>b.actualServer.hasIndependentAdminPrincipalModeValue(b.env());
          export const handleIndependentAdminPrincipalProductionLogin=r=>b.actualServer.handleIndependentAdminPrincipalProductionLogin(r,b.options());
          export const handleIndependentAdminPrincipalProductionMe=t=>b.actualServer.handleIndependentAdminPrincipalProductionMe(t,b.options());
          export const handleIndependentAdminPrincipalProductionLogout=(r,t)=>b.actualServer.handleIndependentAdminPrincipalProductionLogout(r,t,b.options());
          export const handleIndependentAdminPasswordChange=(r,t)=>b.actualServer.handleIndependentAdminPasswordChange(r,t,b.options());`, loader: "js" };
        return { contents: `const denied=()=>{throw Error("unrelated branch called");};
          export const createLocalAdminToken=denied,isLocalAdminEnabled=denied,localAdminCookieOptions=denied,localSecretMatches=denied,resolveAdminActor=denied,getAdminRepositoryForActor=denied;
          export const LOCAL_ADMIN_COOKIE="unused";`, loader: "js" };
      });
    } }] });
  const compiledModule = { exports: {} };
  new Function("module", "exports", "require", result.outputFiles[0]!.text)(compiledModule, compiledModule.exports,
    (id: string) => id === "__pending_activation_bridge" ? bridge : require(id));
  const handler = compiledModule.exports as { session: { GET(): Promise<Response>; POST(r: Request): Promise<Response>; DELETE(r: Request): Promise<Response> };
    change: { POST(r: Request): Promise<Response> } };
  const signed = await handler.session.POST(request({ username: "admin", password: "admin888" }));
  assert.equal(signed.status, 200);
  const issued = signed.headers.get("set-cookie") ?? "";
  for (const attribute of ["__Host-aistory_admin_principal_v2=", "HttpOnly", "Secure", "SameSite=strict", "Path=/", "Max-Age=900"]) {
    assert.equal(issued.toLowerCase().includes(attribute.toLowerCase()), true);
  }
  cookie = issued.split(";")[0]!.slice(actualServer.INDEPENDENT_ADMIN_PRINCIPAL_PRODUCTION_COOKIE.length + 1);
  const prior = cookie;
  const restricted = await handler.session.GET();
  assert.deepEqual(await restricted.json(), { authenticated: false, state: "password_change_required" });
  assert.equal(restricted.headers.get("set-cookie"), null);
  const failed = await handler.change.POST(request({ currentPassword: "wrong", newPassword: nextPassword }));
  assert.equal(failed.status, 403); assert.equal(failed.headers.get("set-cookie"), null);
  const completed = await handler.change.POST(request({ currentPassword: "admin888", newPassword: nextPassword }));
  assert.equal(completed.status, 200);
  assert.equal((completed.headers.get("set-cookie") ?? "").includes("Max-Age=0"), true);
  assert.deepEqual(await completed.json(), { ok: true, state: "signed_out", freshLoginRequired: true });
  assert.equal(fake.active, undefined);
  const expired = await handler.session.GET();
  assert.equal(expired.status, 401); assert.equal((expired.headers.get("set-cookie") ?? "").includes("Max-Age=0"), true);
  const oldLogin = await handler.session.POST(request({ username: "admin", password: "admin888" }));
  assert.equal(oldLogin.status, 403); assert.equal(oldLogin.headers.get("set-cookie"), null);
  const fresh = await handler.session.POST(request({ username: "admin", password: nextPassword }));
  assert.equal(fresh.status, 200); assert.ok(fresh.headers.get("set-cookie"));
  cookie = fresh.headers.get("set-cookie")!.split(";")[0]!.slice(actualServer.INDEPENDENT_ADMIN_PRINCIPAL_PRODUCTION_COOKIE.length + 1);
  assert.equal(cookie === prior, false);
  const ended = await handler.session.DELETE(request({}, "/api/admin/session", {}, "DELETE"));
  assert.equal(ended.status, 200); assert.equal((ended.headers.get("set-cookie") ?? "").includes("Max-Age=0"), true);
  selectedEnv = { ...env, [FIRST_PASSWORD_CHANGE_ENV]: "independent_admin_first_password_change_v1" };
  for (const response of [await handler.session.GET(), await handler.session.POST(request({ username: "admin", password: "admin888" })),
    await handler.change.POST(request({ currentPassword: "admin888", newPassword: nextPassword }))]) {
    assert.equal(response.status, 503); assert.equal(response.headers.get("set-cookie"), null);
  }
  fake = new Fake(); selectedEnv = env;
  const unknownLogin = await handler.session.POST(request({ username: "admin", password: "admin888" }));
  cookie = unknownLogin.headers.get("set-cookie")!.split(";")[0]!.slice(actualServer.INDEPENDENT_ADMIN_PRINCIPAL_PRODUCTION_COOKIE.length + 1);
  fake.unknownCommit = true;
  const unknown = await handler.change.POST(request({ currentPassword: "admin888", newPassword: nextPassword }));
  assert.equal(unknown.status, 403); assert.equal(unknown.headers.get("set-cookie"), null);
  assert.equal(fake.restricted, false); assert.equal(fake.active, undefined);
}
try {
  assert.deepEqual(INDEPENDENT_ADMIN_PASSWORD_POLICY,
    { minimumCodePoints: 9, maximumUtf8Bytes: 512, minimumCategories: 3 });
  assert.equal(Object.isFrozen(INDEPENDENT_ADMIN_PASSWORD_POLICY), true);
  assert.equal(independentAdminPasswordPolicyViolation("Aa1!bcde"), "too_short");
  assert.equal(independentAdminPasswordPolicyViolation("abcdefg12"), "insufficient_categories");
  assert.equal(independentAdminPasswordPolicyViolation("admin888"), "public_default_password");
  assert.equal(isIndependentAdminPasswordAllowed(nextPassword), true);
  assert.equal(new Set(nextPassword).size, 3);
  assert.equal([...nextPassword].length, 9);
  assert.equal(isIndependentAdminPasswordAllowed("Aa1界界界界界界"), true);
  assert.equal(independentAdminPasswordPolicyViolation("Aa1界界界界界"), "too_short");
  const exactByteLimit = `Aa1${"b".repeat(509)}`;
  assert.equal(new TextEncoder().encode(exactByteLimit).byteLength, 512);
  assert.equal(isIndependentAdminPasswordAllowed(exactByteLimit), true);
  assert.equal(independentAdminPasswordPolicyViolation(`${exactByteLimit}b`), "too_large");
  const publicClient = new Fake();
  const publicLogin = await login(request({username:"admin",password:"admin888"}),options(publicClient));
  assert.equal(publicLogin.response.status,200);
  assert.equal(await authority(publicLogin.sessionToken,options(publicClient)),undefined);
  assert.equal(publicClient.restricted,true); assert.equal(publicClient.revision,1);
  assert.equal((await performChange(request({currentPassword:"admin888",newPassword:nextPassword}),undefined,options(publicClient))).response.status,403);
  const f = new Fake(); const token = await temporary(f);
  assert.equal(await authority(token, options(f)), undefined);
  assert.equal(await navigation(token, options(f)), "password_change_required");
  assert.deepEqual(await (await me(token, options(f))).response.json(), { authenticated: false, state: "password_change_required" });
  assert.equal(f.calls.filter(n => n.includes("snapshot")).length, 0);
  for (const corrupted of [undefined, token + "x", token.split(".")[0] + ".invalid"]) {
    assert.equal(await authority(corrupted, options(f)), undefined);
    assert.equal((await change(request({ currentPassword: "admin888", newPassword: nextPassword }), corrupted, options(f))).response.status, 403);
  }
  for (const [body, headers] of [
    [{ currentPassword: "admin888", newPassword: nextPassword, mustChangePassword: false }, {}],
    [{ currentPassword: "admin888", newPassword: nextPassword }, { origin: "https://wrong.example.invalid" }],
    [{ currentPassword: "admin888", newPassword: nextPassword }, { "x-aistory-admin-action": "" }],
    [{ currentPassword: "admin888", newPassword: nextPassword }, { "content-type": "text/plain" }],
    [{ currentPassword: "admin888", newPassword: "x".repeat(2100) }, {}],
  ] as const) assert.equal((await change(request(body, "/api/admin/password-change", headers), token, options(f))).response.status, 403);
  assert.equal(f.attempts, 0);
  assert.equal((await change(request({ currentPassword: "wrong", newPassword: nextPassword }), token, options(f))).response.status, 403);
  assert.equal((await change(request({ currentPassword: "admin888", newPassword: "admin888" }), token, options(f))).response.status, 403);
  const changed = await change(request({ currentPassword: "admin888", newPassword: nextPassword }), token, options(f));
  assert.equal(changed.response.status, 200); assert.equal(changed.sessionToken, undefined);
  summaries.push(await changed.response.clone().json());
  assert.deepEqual(await changed.response.json(), { ok: true, state: "signed_out", freshLoginRequired: true });
  assert.equal(f.active, undefined); assert.equal(f.audit.filter(e => e === "password_change_succeeded").length, 1);
  assert.equal(await authority(token, options(f)), undefined);
  assert.equal((await me(token, options(f))).response.status, 401);
  assert.equal((await change(request({ currentPassword: "admin888", newPassword: nextPassword }), token, options(f))).response.status, 403);
  assert.equal((await login(request({ username: "admin", password: "admin888" }), options(f))).response.status, 403);
  assert.equal((await login(request({ username: "unknown", password: nextPassword }), options(f))).response.status, 403);
  const fresh = await login(request({ username: "admin", password: nextPassword }), options(f));
  assert.equal(fresh.response.status, 200); assert.ok(fresh.sessionToken);
  assert.notEqual(fresh.sessionToken, token); assert.equal((await authority(fresh.sessionToken, options(f)))?.actor.mode, "independent");
  summaries.push(await (await me(fresh.sessionToken, options(f))).response.json());
  assert.equal((await change(request({ currentPassword: nextPassword, newPassword: nextPassword }), fresh.sessionToken, options(f))).response.status, 403);
  assert.equal((await logout(request({}, "/api/admin/session", {}, "DELETE"), fresh.sessionToken, options(f))).status, 200);
  assert.equal(await authority(fresh.sessionToken, options(f)), undefined);

  // Use Next's actual Node adapter with a synthetic, explicitly pinned internal
  // origin. It does not replace the DB-derived restricted/console stage.
  const { NextRequestAdapter } = await import("next/dist/server/web/spec-extension/adapters/next-request");
  const { addRequestMeta } = await import("next/dist/server/request-meta");
  const { Readable } = await import("node:stream");
  const internal = "https://localhost:19001";
  function proxyRequest(body: unknown, overrides: Record<string,string> = {}, method = "POST", internalOrigin = internal, pathname = "/api/admin/session") {
    const nodeRequest = { method, url: pathname, body: Readable.from([Buffer.from(JSON.stringify(body))]),
      headers: { host: "admin.example.invalid", origin, "x-forwarded-host": "admin.example.invalid",
        "x-forwarded-proto": "https", "sec-fetch-site": "same-origin", "content-type": "application/json", ...overrides } };
    addRequestMeta(nodeRequest as never, "initURL", internalOrigin + pathname);
    return NextRequestAdapter.fromNodeNextRequest(nodeRequest as never, new AbortController().signal);
  }
  const proxyOptions = { ...options(f), env: { ...env, AISTORY_ADMIN_PRINCIPAL_INTERNAL_ORIGIN: internal } };
  assert.equal(new URL(proxyRequest({}).url).origin, internal);
  const callsBefore = f.calls.length;
  assert.equal((await login(proxyRequest({username:"admin",password:nextPassword}),options(f))).response.status,403);
  const proxyHostiles: Record<string,string>[] = [{"x-forwarded-host":"wrong.example.invalid"},{"x-forwarded-proto":"http"},
    {"x-forwarded-proto":"https,http"},{forwarded:"proto=https"},{origin:"https://wrong.example.invalid"},
    {host:"wrong.example.invalid"},{"sec-fetch-site":"cross-site"},{"sec-fetch-site":"none"},
    {"sec-fetch-site":""},{host:""},{origin:""},{"x-forwarded-host":""},{"x-forwarded-proto":""}];
  for (const headers of proxyHostiles) {
    assert.equal((await login(proxyRequest({username:"admin",password:nextPassword},headers),proxyOptions)).response.status,403);
    assert.equal((await logout(proxyRequest({}, headers, "DELETE"), fresh.sessionToken, proxyOptions)).status, 403);
  }
  const missingFetchSite=proxyRequest({username:"admin",password:nextPassword});missingFetchSite.headers.delete("sec-fetch-site");
  assert.equal((await login(missingFetchSite,proxyOptions)).response.status,403);
  for(const configured of ["", internal+"/",internal+"/path","https://localhost","https://localhost:443",
    "https://user@localhost:19001","https://wrong.example.invalid:19001",internal+"?x=1",internal+"#x"]) {
    assert.equal((await login(proxyRequest({username:"admin",password:nextPassword}),{...proxyOptions,env:{...proxyOptions.env,AISTORY_ADMIN_PRINCIPAL_INTERNAL_ORIGIN:configured}})).response.status,403);
  }
  for(const pathname of ["/api/admin/other","/api/admin/session?x=1","/api/admin/session#x"])
    assert.equal((await login(proxyRequest({}, {}, "POST", internal, pathname),proxyOptions)).response.status,403);
  assert.equal((await login(proxyRequest({}, {}, "PUT"),proxyOptions)).response.status,403);
  assert.equal((await login(new Request(internal+"/api/admin/session"),proxyOptions)).response.status,403);
  assert.equal((await login(proxyRequest({}, {}, "POST", "https://localhost:19002"),proxyOptions)).response.status,403);
  assert.equal((await login(proxyRequest({username:"admin",password:nextPassword},{},"POST","http://localhost:19001"),proxyOptions)).response.status,403);
  assert.equal((await logout(proxyRequest({}, {}, "POST"), fresh.sessionToken, proxyOptions)).status, 403);
  assert.equal((await logout(proxyRequest({}, {}, "DELETE", internal, "/api/admin/password-change"), fresh.sessionToken, proxyOptions)).status, 403);
  for (const pathname of ["/api/admin/other", "/api/admin/session?x=1", "/api/admin/session#x"]) {
    assert.equal((await login(request({}, pathname), options(f))).response.status, 403);
    assert.equal((await logout(request({}, pathname, {}, "DELETE"), fresh.sessionToken, options(f))).status, 403);
  }
  assert.equal(f.calls.length,callsBefore);
  const restrictedProxy = new Fake();
  const proxyPendingOptions={...options(restrictedProxy),env:proxyOptions.env};
  const proxyPending=await login(proxyRequest({username:"admin",password:"admin888"}),proxyPendingOptions);
  assert.equal(proxyPending.response.status,200); assert.ok(proxyPending.sessionToken);
  assert.equal(await authority(proxyPending.sessionToken,proxyPendingOptions),undefined);
  for (const headers of proxyHostiles) assert.equal((await change(proxyRequest(
    {currentPassword:"admin888",newPassword:nextPassword},{"x-aistory-admin-action":"first-password-change-v1",...headers},
    "POST",internal,"/api/admin/password-change"),proxyPending.sessionToken,proxyPendingOptions)).response.status,403);
  assert.equal(restrictedProxy.attempts,0);
  const proxyChanged=await change(proxyRequest({currentPassword:"admin888",newPassword:nextPassword},
    {"x-aistory-admin-action":"first-password-change-v1"},"POST",internal,"/api/admin/password-change"),proxyPending.sessionToken,proxyPendingOptions);
  assert.equal(proxyChanged.response.status,200); assert.equal(proxyChanged.sessionToken,undefined);
  assert.equal(await authority(proxyPending.sessionToken,proxyPendingOptions),undefined);
  const proxyLogin = await login(proxyRequest({username:"admin",password:nextPassword}),proxyOptions);
  assert.equal(proxyLogin.response.status,200);assert.ok(proxyLogin.sessionToken);
  assert.equal((await authority(proxyLogin.sessionToken,proxyOptions))?.actor.mode,"independent");
  assert.equal((await logout(proxyRequest({}, {}, "DELETE"),proxyLogin.sessionToken,proxyOptions)).status,200);
  assert.equal(await authority(proxyLogin.sessionToken,proxyOptions),undefined);

  const limited = new Fake(); const lt = await temporary(limited);
  for (let i = 0; i < 5; i++) assert.equal((await change(request({ currentPassword: "wrong", newPassword: nextPassword }), lt, options(limited))).response.status, 403);
  assert.equal((await change(request({ currentPassword: "admin888", newPassword: nextPassword }), lt, options(limited))).response.status, 429);
  const again = await temporary(limited);
  assert.equal((await change(request({ currentPassword: "admin888", newPassword: nextPassword }), again, options(limited))).response.status, 429);

  // The 60s ticket is an internal CAS proof, never a deadline on the account.
  const ticketExpiry = new InterleavedFake(); const te = await temporary(ticketExpiry);
  ticketExpiry.beforeRpc = { name: "aistory_iap_first_change_complete", run: () => { ticketExpiry.now += 60_000; } };
  assert.equal((await change(request({ currentPassword: "admin888", newPassword: nextPassword }), te, options(ticketExpiry))).response.status, 403);
  assert.equal(ticketExpiry.restricted, true); assert.equal(ticketExpiry.revision, 1);
  assert.equal(ticketExpiry.audit.filter(e => e === "password_change_succeeded").length, 0);
  assert.equal((await change(request({ currentPassword: "admin888", newPassword: nextPassword }), te, options(ticketExpiry))).response.status, 200);

  // Both DB lock serializations: another login first invalidates the old change
  // session; a change first invalidates the old-binding in-flight login commit.
  const loginFirst = new InterleavedFake(); const priorPending = await temporary(loginFirst);
  let replacementPending: string | undefined;
  loginFirst.beforeRpc = { name: "aistory_iap_first_change_complete", run: async () => { replacementPending = await temporary(loginFirst); } };
  assert.equal((await change(request({ currentPassword: "admin888", newPassword: nextPassword }), priorPending, options(loginFirst))).response.status, 403);
  assert.ok(replacementPending); assert.equal(loginFirst.restricted, true);
  assert.equal(await authority(priorPending, options(loginFirst)), undefined);
  assert.equal((await change(request({ currentPassword: "admin888", newPassword: nextPassword }), replacementPending, options(loginFirst))).response.status, 200);
  assert.equal(loginFirst.active, undefined);
  const changeFirst = new InterleavedFake(); const cf = await temporary(changeFirst);
  changeFirst.beforeRpc = { name: "aistory_independent_admin_commit_login", run: async () => {
    assert.equal((await change(request({ currentPassword: "admin888", newPassword: nextPassword }), cf, options(changeFirst))).response.status, 200);
  } };
  const staleLogin = await login(request({ username: "admin", password: "admin888" }), options(changeFirst));
  assert.notEqual(staleLogin.response.status, 200); assert.equal(staleLogin.sessionToken, undefined);
  assert.equal(changeFirst.restricted, false); assert.equal(changeFirst.revision, 2);
  assert.equal(changeFirst.active, undefined);
  assert.equal(changeFirst.audit.filter(e => e === "password_change_succeeded").length, 1);
  assert.equal((await login(request({ username: "admin", password: nextPassword }), options(changeFirst))).response.status, 200);

  const concurrent = new Fake(); const ct = await temporary(concurrent);
  const attempts = await Promise.all([1,2].map(() => change(request({ currentPassword: "admin888", newPassword: nextPassword }), ct, options(concurrent))));
  assert.deepEqual(attempts.map(r => r.response.status).sort(), [200,403]);
  assert.equal(concurrent.audit.filter(e => e === "password_change_succeeded").length, 1);
  assert.equal(concurrent.active, undefined);
  for (const flag of ["failCommit", "unknownCommit"] as const) {
    const broken = new Fake(); const bt = await temporary(broken); broken[flag] = true;
    const result = await change(request({ currentPassword: "admin888", newPassword: nextPassword }), bt, options(broken));
    assert.equal(result.response.status, 403); assert.equal(result.sessionToken, undefined);
    assert.doesNotMatch(await result.response.text(), /PRIVATE_EXCEPTION|passwordVerifier|principal_ref/);
  }
  for (const bad of [null, "20260829063000", true, {}]) {
    const broken = new Fake(); broken.gate = bad;
    assert.equal((await login(request({ username: "admin", password: "admin888" }), options(broken))).response.status, 503);
  }
  for (const bad of [{}, Object.create({}), { revision: 1, must_change_password: false }, { ...firstChangePasswordState(seed), secret: true }]) {
    const broken = new Fake(); broken.drift = bad;
    await assert.rejects(readFirstPasswordState(broken, seed));
  }
  const dangerous = Object.defineProperty({}, "value", { get() { throw Error("getter invoked"); } });
  assert.equal(exactFirstChangeRecord(dangerous, ["value"]), false);
  assert.equal(exactFirstChangeRecord({ [Symbol("x")]: 1 }, ["value"]), false);
  assert.throws(() => parseTemporaryBootstrapInput('{"username":"admin","password":"admin888","schemaVersion":1,"role":"super_admin"}'));
  assert.deepEqual(parseTemporaryBootstrapInput('{"username":"admin","password":"admin888","schemaVersion":1}'), { username: "admin", password: "admin888" });
  await assert.rejects(rotateFirstChangeIndependentAdminPassword(seed, "admin888"));
  for (const bad of ["Aa1!bcde", "abcdefg12", "Aa9!" + "界".repeat(170)]) {
    await assert.rejects(rotateFirstChangeIndependentAdminPassword(seed, bad));
    await assert.rejects(createFirstChangeIndependentAdminCredential({ username: "admin", password: bad }));
  }
  const missing = { ...env }; delete (missing as Record<string,string>)[FIRST_PASSWORD_CHANGE_ENV];
  assert.equal((await login(request({ username: "admin", password: "admin888" }), { ...options(new Fake()), env: missing })).response.status, 503);
  // Pending-account longevity is independent of session/rate/CAS lifetimes.
  const lasting=new Fake(); const expired=await temporary(lasting);
  lasting.now+=16*60*1000;
  assert.equal((await me(expired,options(lasting))).response.status,401);
  assert.equal((await change(request({currentPassword:"admin888",newPassword:nextPassword}),expired,options(lasting))).response.status,403);
  lasting.now+=7*24*60*60*1000;
  const resumed=await temporary(lasting);
  assert.equal(lasting.revision,1); assert.equal(lasting.restricted,true);
  assert.equal(await authority(resumed,options(lasting)),undefined);
  assert.equal(lasting.audit.filter(e=>e==="temporary_bootstrap").length,0);
  // Each request reconstructs the runtime from the same immutable seed + DB.
  const beforeSeed=serializeIndependentAdminPrincipalCredential(lasting.seed);
  const changedAfterRestart=await change(request({currentPassword:"admin888",newPassword:nextPassword}),resumed,options(lasting));
  assert.equal(changedAfterRestart.response.status,200);
  assert.equal(serializeIndependentAdminPrincipalCredential(lasting.seed),beforeSeed);
  assert.equal(lasting.sessions.size,2); assert.equal(lasting.families.size,2);
  assert.ok([...lasting.sessions.values()].every(s=>s.revoked));
  assert.ok([...lasting.families.values()].every(s=>s.revoked));
  lasting.now+=7*24*60*60*1000;
  assert.equal((await login(request({username:"admin",password:"admin888"}),options(lasting))).response.status,403);
  assert.equal(await authority(resumed,options(lasting)),undefined);
  assert.equal(await navigation(resumed,options(lasting)),"signed_out");
  const activeAgain=await login(request({username:"admin",password:nextPassword}),options(lasting));
  assert.equal(activeAgain.response.status,200); assert.ok(await authority(activeAgain.sessionToken,options(lasting)));
  lasting.failRead=true;
  assert.equal((await login(request({username:"admin",password:"admin888"}),options(lasting))).response.status,503);
  assert.equal((await me(activeAgain.sessionToken,options(lasting))).response.status,503);
  lasting.failRead=false; lasting.drift=null;
  assert.equal((await login(request({username:"admin",password:"admin888"}),options(lasting))).response.status,503);
  assert.equal(serializeIndependentAdminPrincipalCredential(seed),raw);

  // No body/cookie-declared active, revision or role can select the DB state.
  const asserted=new Fake();
  for(const injected of [{active:true},{mustChangePassword:false},{revision:2},{roles:["super_admin"]},{state:"console"}]) {
    assert.equal((await login(request({username:"admin",password:"admin888",...injected}),options(asserted))).response.status,403);
  }
  assert.equal(asserted.calls.length,0);
  for(const state of [
    {must_change_password:false,revision:1},{must_change_password:true,revision:2},{must_change_password:true,revision:0},
    {must_change_password:"false",revision:2},
  ]) {
    const drifted=new Fake(); drifted.drift={password_state:firstChangePasswordState(seed),binding:firstChangeBinding(seed),...state};
    assert.equal((await login(request({username:"admin",password:"admin888"}),options(drifted))).response.status,503);
  }
  for(const selected of ["", "independent_admin_first_password_change_v1", "unknown", FIRST_PASSWORD_CHANGE_POLICY+" "]) {
    const disabled=new Fake();const disabledOptions={...options(disabled),env:{...env,[FIRST_PASSWORD_CHANGE_ENV]:selected}};
    assert.equal((await login(request({username:"admin",password:"admin888"}),disabledOptions)).response.status,503);
    assert.equal((await change(request({currentPassword:"admin888",newPassword:nextPassword}),undefined,disabledOptions)).response.status,503);
    assert.equal((await me(token, disabledOptions)).response.status, 503);
    assert.equal((await logout(request({}, "/api/admin/session", {}, "DELETE"), token, disabledOptions)).status, 503);
    assert.equal(await navigation(token, disabledOptions), "signed_out");
    await assert.rejects(authority(token, disabledOptions), { code: "INDEPENDENT_ADMIN_PRINCIPAL_UNAVAILABLE", status: 503 });
    assert.equal(disabled.calls.length,0);
  }

  // A lost commit response never causes automatic reinitialization or promotion.
  const uncertain=new Fake(); const ut=await temporary(uncertain); uncertain.unknownCommit=true;
  assert.equal((await change(request({currentPassword:"admin888",newPassword:nextPassword}),ut,options(uncertain))).response.status,403);
  assert.equal(uncertain.restricted,false);assert.equal(uncertain.active,undefined);
  assert.equal((await login(request({username:"admin",password:"admin888"}),options(uncertain))).response.status,403);
  assert.equal((await login(request({username:"admin",password:nextPassword}),options(uncertain))).response.status,200);
  assert.equal(uncertain.audit.filter(e=>e==="password_change_succeeded").length,1);

  assert.equal(networkCalls, 0);
  await actualRouteCookieTests();
  assert.equal(networkCalls, 0);
  assert.doesNotMatch(JSON.stringify(summaries), /principal|hash|token|passwordVerifier|admin888|keyMaterial|PRIVATE_EXCEPTION/i);
  assert.equal(JSON.stringify(summaries).includes(nextPassword), false);

  const migration = await readFile("supabase/migrations/20260831113000_independent_admin_first_password_change_gate.sql", "utf8");
  assert.doesNotMatch(migration, /admin888|phone_identities|update\s+(?:public\.)?independent_admin_auth_audit|delete\s+from|truncate\s+table/i);
  assert.match(migration, /FORCE LOGOUT/);
  const completion = migration.split("create function public.aistory_iap_first_change_complete")[1]!.split("revoke all on function")[0]!;
  assert.doesNotMatch(completion, /commit_login|insert into public.independent_admin_sessions/);
  for (const table of ["state", "families", "audit"]) assert.match(migration, new RegExp(`independent_admin_password_${table} force row level security`));
  const gate16 = await readFile("supabase/migrations/20260829063000_independent_admin_qualification_residue_retirement_gate.sql");
  assert.equal(gate16.length, 66767);
  assert.equal(createHash("sha256").update(gate16).digest("hex"), "4c958ca8af443e97f254fef1cfb1c2e6ea48f1907466d1b1c2ebc2282f598644");
  const cli = spawnSync(process.execPath, ["--import=tsx", "scripts/bootstrap-independent-admin-temporary.ts", "--check-module-boundary"],
    { encoding: "utf8", timeout: 30000, env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TSX_DISABLE_CACHE: "1", NODE_ENV: "test" } });
  assert.equal(cli.status, 0); assert.equal(cli.stderr, ""); assert.match(cli.stdout, /PROTECTED_BOOTSTRAP_CHECK_PASS/);
  const source=await readFile("lib/admin/independentPrincipalServer.ts","utf8");
  assert.doesNotMatch(source,/OwnerClaim|ownerClaimProof|activationToken|claimDeadline/);
  const page=await readFile("app/admin/password-change/page.tsx","utf8");
  assert.match(page,/independentAdminNavigationState/); assert.match(page,/AdminPasswordChangeForm/);
  assert.doesNotMatch(page,/notFound|searchParams|localStorage/);
  const form=await readFile("app/admin/login/AdminLoginForm.tsx","utf8");
  assert.match(form,/first-claim-wins/);assert.match(form,/不能证明部署者所有权/);
  assert.doesNotMatch(form,/localStorage|sessionStorage|activationToken/);
  const passwordForm=await readFile("app/admin/password-change/AdminPasswordChangeForm.tsx","utf8");
  assert.match(passwordForm,/independentAdminPasswordPolicyViolation/);
  assert.match(passwordForm,/至少 9 个 Unicode 字符、最多 512 个 UTF-8 字节/);
  assert.doesNotMatch(passwordForm,/至少 24|12 个不同字符/);
  console.log("PASS pending-activation-v2: normal-login restricted/no-role, expiry/relogin/restart, atomic force-logout/fresh-login, drift/hostile/concurrency/replay/rate/redaction, CLI graph; external-network=0; Gate16 exact; SQL execution NOT CLAIMED");
} finally { globalThis.fetch = savedFetch; }
