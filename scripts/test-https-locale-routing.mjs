import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { parse as parseUrl } from "node:url";

const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), "..");
// Do not forward provider/auth credentials or NODE_OPTIONS into test processes.
const cleanEnv = { NEXT_TELEMETRY_DISABLED: "1", TSX_DISABLE_CACHE: "1" };
for (const name of ["SystemRoot", "WINDIR", "PATH", "TEMP", "TMP"]) {
  if (process.env[name]) cleanEnv[name] = process.env[name];
}

if (!process.argv.includes("--isolated")) {
  const child = spawn(process.execPath, [script, "--isolated"], {
    cwd: root, env: cleanEnv, stdio: "inherit", windowsHide: true,
  });
  const [code] = await once(child, "exit");
  process.exit(code ?? 1);
}

const require = createRequire(import.meta.url);
globalThis.AsyncLocalStorage = AsyncLocalStorage;
require("tsx/cjs");
let fakeAuthCalls = 0;
const ssrPath = require.resolve("@supabase/ssr");
require(ssrPath);
require.cache[ssrPath].exports = { createServerClient: (url, key, { cookies }) => {
  assert.equal(url, "https://routing-fixture.invalid");
  assert.equal(key, "synthetic-test-key");
  return { auth: { getUser: async () => {
    fakeAuthCalls++;
    cookies.setAll([{ name: "routing-fixture-refresh", value: "synthetic", options: { secure: true, httpOnly: true } }]);
  } } };
} };
const { middleware, config: middlewareConfig } = require("../middleware.ts");
const nextConfig = require("../next.config.ts").default;
const { NextRequest, NextResponse } = require("next/server");
const { unstable_doesMiddlewareMatch } = require("next/experimental/testing/server");
const { getPathMatch } = require("next/dist/shared/lib/router/utils/path-match");
const { matchHas, prepareDestination } = require("next/dist/shared/lib/router/utils/prepare-destination");
const { getRelativeURL } = require("next/dist/shared/lib/router/utils/relativize-url");
// Mirror the build-time define emitted by the documented config flag. Only
// this clean unit-test child receives it; the live fixture uses next.config.
assert.equal(nextConfig.skipProxyUrlNormalize, true);
process.env.__NEXT_NO_MIDDLEWARE_URL_NORMALIZE = "true";
const marker = "x-aistory-default-locale-rewrite";
const rules = await nextConfig.rewrites();
assert.ok(rules.beforeFiles.every((rule) => !rule.has));
// The experimental config test helper collapses repeated query values to a
// comma-separated string. Use the real resolver's primitives here; the live
// Next server below independently verifies the full routing/adapter pipeline.
function routePath(url, headers) {
  const parsed = parseUrl(url, true);
  for (const rule of rules.beforeFiles) {
    const params = getPathMatch(rule.source)(parsed.pathname);
    if (!params) continue;
    const has = matchHas({ headers: Object.fromEntries(headers) }, parsed.query, rule.has, rule.missing);
    if (!has) continue;
    const { parsedDestination } = prepareDestination({ appendParamsToQuery: true,
      destination: rule.destination, params: { ...params, ...has }, query: parsed.query });
    assert.ok(!parsedDestination.protocol, "rewrites must remain internal");
    parsed.pathname = parsedDestination.pathname;
    Object.assign(parsed.query, parsedDestination.query);
  }
  return parsed;
}
let forbiddenFetches = 0;
globalThis.fetch = async () => { forbiddenFetches++; throw new Error("external fetch forbidden"); };

const cases = [
  ["/", "/zh-CN"], ["/play?x=1&x=2", "/zh-CN/play"],
  ["/studio", "/zh-CN/studio"], ["/en", "/en"], ["/ja/play", "/ja/play"],
  ["/zh-CN/play", "/zh-CN/play"], ["/api", "/zh-CN/api"],
  ["/api/x", "/api/x"], ["/auth", "/zh-CN/auth"], ["/auth/x", "/auth/x"],
  ["/administer", "/administer"], ["/admin/login", "/admin/login"],
  ["/home", "/zh-CN/home"], ["/home/x", "/home/x"],
  ["/docs", "/zh-CN/docs"], ["/docs/x", "/docs/x"],
  ["/EN/play", "/zh-CN/EN/play"], ["/API/x", "/zh-CN/API/x"],
  ["/Admin", "/zh-CN/Admin"], ["/ZH-CN/play", "/zh-CN/ZH-CN/play"],
  ["/foo.JS/child", "/zh-CN/foo.JS/child"], ["/FAVICONXICO", "/zh-CN/FAVICONXICO"],
  ["/_NEXT/static/foo", "/zh-CN/_NEXT/static/foo"],
  ["/home/firstact/example.json", "/home/firstact/example.json"],
  ["/file.html", "/file.html"], ["/file.PNG", "/file.PNG"],
  ["/play.js/child", "/play.js/child"], ["/faviconXico", "/faviconXico"],
  ["/icon.svg.extra", "/icon.svg.extra"], ["/_next/static/file.js", "/_next/static/file.js"],
  ["/api/auth/aiuser/start", "/api/auth/aiuser/start"],
  ["/api/auth/aiuser/callback", "/api/auth/aiuser/callback"],
];
const normalize = (value) => value.replace(/\/$/, "") || "/";
let unitCases = 0;
for (const protocol of ["http", "https"]) {
  for (const origin of [`${protocol}://127.0.0.1:4200`, `${protocol}://localhost:4200`, `${protocol}://[::1]:4200`, `${protocol}://iy.vxmeng.com`]) {
    for (const [pathname, expected] of cases) {
      for (const spoof of [false, true]) {
        const url = origin + pathname;
        const incoming = new Headers({ host: "iy.vxmeng.com", "x-forwarded-proto": protocol,
          "x-forwarded-host": "iy.vxmeng.com", cookie: "routing-fixture=synthetic" });
        if (spoof) incoming.set(marker, "zh-CN");
        let upstream = new Headers(incoming);
        let rewrittenUrl = url;
        const originallyMatched = unstable_doesMiddlewareMatch({ config: { matcher: [middlewareConfig.matcher[0]] }, url });
        const matched = unstable_doesMiddlewareMatch({ config: middlewareConfig, url, headers: Object.fromEntries(incoming) });
        assert.equal(matched, originallyMatched);
        if (matched) {
          const response = await middleware(new NextRequest(url, { headers: incoming }));
          rewrittenUrl = response.headers.get("x-middleware-rewrite") || url;
          assert.equal(new URL(rewrittenUrl).origin, new URL(url).origin, url);
          assert.ok(getRelativeURL(rewrittenUrl, url).startsWith("/"), url);
          const override = response.headers.get("x-middleware-override-headers");
          if (override) {
            upstream = new Headers();
            for (const key of override.split(",")) {
              upstream.set(key, response.headers.get(`x-middleware-request-${key}`));
            }
          }
          for (const key of ["host", "x-forwarded-proto", "x-forwarded-host", "cookie"]) {
            assert.equal(upstream.get(key), incoming.get(key), `${key}: ${url}`);
          }
        }
        const destination = routePath(rewrittenUrl, upstream);
        assert.equal(normalize(destination.pathname), expected, `${url}, spoof=${spoof}`);
        assert.deepEqual(destination.query.x, parseUrl(url, true).query.x);
        unitCases++;
      }
    }
  }
}
// A negative control using the former production rewrite demonstrates why HTTPS
// on the internal origin was incorrectly sent back to the HTTP-only listener.
const legacyRequest = new NextRequest("https://127.0.0.1:4200/", {
  headers: { host: "iy.vxmeng.com", "x-forwarded-proto": "https" },
});
const legacyUrl = legacyRequest.nextUrl.clone();
legacyUrl.pathname = "/zh-CN/";
const legacyRewrite = NextResponse.rewrite(legacyUrl).headers.get("x-middleware-rewrite");
assert.match(getRelativeURL(legacyRewrite, "https://127.0.0.1:4200/"), /^https:\/\/localhost:4200\//);
assert.equal(forbiddenFetches, 0);
console.log(`HTTPS_LOCALE_UNIT_PASS cases=${unitCases} legacyAbsoluteProxy=1 providerCalls=0`);
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://routing-fixture.invalid";
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "synthetic-test-key";
for (const [pathname, cookie, expectedCalls] of [
  ["/play", "", 1], ["/api/example", "", 1],
  ["/api/auth/aiuser/start", "", 0], ["/api/auth/aiuser/callback", "", 0],
  ["/auth/aiuser", "", 0], ["/play", "__Host-aistory_aiuser_user_v1=synthetic", 0],
  ["/play", "__Host-aistory_linghao_passport_v4_user_v1=synthetic", 0],
  ["/file.js", "", 0], ["/file.html", "", 0], ["/file.js/child", "", 0],
  ["/faviconXico", "", 0], ["/_next/static/asset", "", 0],
]) {
  const previous = fakeAuthCalls;
  const url = "https://127.0.0.1:4200" + pathname;
  const response = unstable_doesMiddlewareMatch({ config: middlewareConfig, url })
    ? await middleware(new NextRequest(url, { headers: { [marker]: "zh-CN", cookie } })) : null;
  assert.equal(fakeAuthCalls - previous, expectedCalls, pathname);
  if (expectedCalls) assert.match(response.headers.get("set-cookie"), /routing-fixture-refresh=synthetic.*Secure.*HttpOnly/);
  else assert.equal(response?.headers.get("set-cookie") ?? null, null, pathname);
}
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
assert.equal(forbiddenFetches, 0);
console.log("HTTPS_LOCALE_AUTH_PASS cases=12 fakeRefreshCalls=2 providerCalls=0");

const fixtureParent = path.join(root, ".tmp");
await mkdir(fixtureParent, { recursive: true });
const fixture = await mkdtemp(path.join(fixtureParent, "https-locale-routing-"));
let server;
let serverClosed;
const nextCli = require.resolve("next/dist/bin/next");
function runNext(args, timeout = 180_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [nextCli, ...args], {
      cwd: fixture, env: cleanEnv, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (data) => { output += data.toString(); });
    child.stderr.on("data", (data) => { output += data.toString(); });
    const timer = setTimeout(() => { child.kill(); reject(new Error("isolated Next build timed out")); }, timeout);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      console.log(output);
      if (code === 0) resolve(); else reject(new Error(`isolated Next build exit ${code}`));
    });
  });
}
function get(port, requestPath, headers, method = "GET", payload) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: "127.0.0.1", port, path: requestPath,
      headers, method, agent: false, timeout: 10_000 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (data) => { body += data; });
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    request.on("timeout", () => request.destroy(new Error("loopback test timeout")));
    request.on("error", reject);
    request.end(payload);
  });
}
try {
  for (const file of [
    "middleware.ts",
    "next.config.ts",
    "lib/auth/linghaoPassportV4ProductionCookies.ts",
    "lib/world-model-demos/rewrites.ts",
    "lib/world-model-demos/catalog.ts",
  ]) {
    const destination = path.join(fixture, file);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(root, file), destination);
  }
  // Fixture-only negative control: the old two-line rewrite runs at one
  // synthetic path and can contact only this fixture's own loopback listener.
  const middlewareSource = await readFile(path.join(fixture, "middleware.ts"), "utf8");
  assert.ok(middlewareSource.includes("export async function middleware(request: NextRequest)"));
  await writeFile(path.join(fixture, "middleware.ts"), middlewareSource.replace(
    "export async function middleware(request: NextRequest)", "async function candidateMiddleware(request: NextRequest)") + `
export async function middleware(request: NextRequest) {
  if (request.nextUrl.pathname === "/__legacy_regression_control") {
    const url = request.nextUrl.clone();
    url.pathname = "/zh-CN/__legacy_regression_control";
    return NextResponse.rewrite(url);
  }
  return candidateMiddleware(request);
}
`);
  await writeFile(path.join(fixture, "package.json"), JSON.stringify({ name: "https-locale-routing-fixture", private: true }));
  await mkdir(path.join(fixture, "app", "[[...segments]]"), { recursive: true });
  await writeFile(path.join(fixture, "app", "[[...segments]]", "route.ts"), `
import { NextRequest, NextResponse } from "next/server";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest, context: { params: Promise<{ segments?: string[] }> }) {
  const { segments = [] } = await context.params;
  const response = NextResponse.json({ pathname: "/" + segments.join("/"), requestPathname: request.nextUrl.pathname,
    payload: request.method === "POST" ? await request.text() : null,
    query: request.nextUrl.searchParams.getAll("x"), host: request.headers.get("host"),
    protocol: request.headers.get("x-forwarded-proto"), forwardedHost: request.headers.get("x-forwarded-host") });
  response.cookies.set("routing-fixture", "synthetic", { secure: request.headers.get("x-forwarded-proto") === "https", httpOnly: true, sameSite: "lax" });
  return response;
}
export const POST = GET;
`);
  await writeFile(path.join(fixture, "app", "layout.tsx"), `
export default function Layout({ children }: { children: React.ReactNode }) {
  return <html><body>{children}</body></html>;
}
`);
  await mkdir(path.join(fixture, "app", "[locale]", "routing-page"), { recursive: true });
  await writeFile(path.join(fixture, "app", "[locale]", "routing-page", "page.tsx"), `
export const dynamic = "force-dynamic";
export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  return <main>routing-page-locale:{locale}</main>;
}
`);
  await mkdir(path.join(fixture, "public"), { recursive: true });
  await writeFile(path.join(fixture, "public", "fixture.txt"), "static fixture\n");
  await runNext(["build", fixture, "--webpack"]);
  const fixtureBuildId = (await readFile(path.join(fixture, ".next", "BUILD_ID"), "utf8")).trim();
  const portProbe = net.createServer();
  portProbe.listen(0, "127.0.0.1");
  await once(portProbe, "listening");
  const port = portProbe.address().port;
  await new Promise((resolve) => portProbe.close(resolve));
  server = spawn(process.execPath, [nextCli, "start", fixture, "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: fixture, env: cleanEnv, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  serverClosed = once(server, "close");
  let serverOutput = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("isolated Next start timeout")), 30_000);
    const collect = (data) => {
      serverOutput += data.toString();
      if (serverOutput.includes("Ready in")) { clearTimeout(timer); resolve(); }
    };
    server.stdout.on("data", collect);
    server.stderr.on("data", collect);
    server.on("error", reject);
    server.on("exit", (code) => { clearTimeout(timer); reject(new Error(`isolated Next start exit ${code}: ${serverOutput}`)); });
  });
  let liveCases = 0;
  for (const protocol of ["http", "https"]) {
    for (const forwardedHost of [false, true]) {
      for (const [requestPath, expected] of cases.filter(([p]) => !p.startsWith("/_next/"))) {
        const headers = { host: "iy.vxmeng.com", "x-forwarded-proto": protocol, [marker]: "zh-CN" };
        if (forwardedHost) headers["x-forwarded-host"] = "iy.vxmeng.com";
        const response = await get(port, requestPath, headers);
        assert.equal(response.status, 200, `${protocol} ${requestPath}: ${response.body.slice(0, 200)}`);
        const body = JSON.parse(response.body);
        assert.equal(normalize(body.pathname), expected, requestPath);
        assert.equal(body.protocol, protocol);
        assert.equal(body.host, "iy.vxmeng.com");
        if (forwardedHost) assert.equal(body.forwardedHost, "iy.vxmeng.com");
        assert.deepEqual(body.query, new URL(requestPath, "http://fixture.test").searchParams.getAll("x"));
        if (protocol === "https") assert.match(response.headers["set-cookie"][0], /; Secure/i);
        liveCases++;
      }
    }
  }
  const headers = { host: "iy.vxmeng.com", "x-forwarded-proto": "https", [marker]: "zh-CN" };
  const asset = await get(port, "/fixture.txt", headers);
  assert.equal(asset.status, 200);
  assert.equal(asset.body, "static fixture\n");
  for (const rule of rules.beforeFiles) {
    const video = await get(port, rule.source.replaceAll("\\.", "."), { ...headers, range: "bytes=0-7" });
    assert.equal(video.status, 200);
    assert.equal(JSON.parse(video.body).pathname, rule.destination);
  }
  // Routing-only fixture: this tests target selection, not real video bytes or
  // the production API's independent Range/authorization implementation.
  let parityCases = 0;
  for (const requestPath of ["/%2Fapi/x", "/%5Capi/x", "/x%2Ejs/child", "/a/%2e%2e/play",
    "/%252Fapi/x", "/bad%", "//play", "/故事", "/play.rsc", "/play.segments/__PAGE__.segment.rsc",
    "/_next/data/wrong-build/play.json", `/_next/data/${fixtureBuildId}/play.json`]) {
    const encodedPath = requestPath.replace("故事", "%E6%95%85%E4%BA%8B");
    const baselineHeaders = { host: "iy.vxmeng.com", "x-forwarded-proto": "https" };
    const baseline = await get(port, encodedPath, baselineHeaders);
    if (requestPath === "/_next/data/wrong-build/play.json") assert.equal(baseline.status, 404);
    if (requestPath === "/bad%") {
      const noRewriteControl = await get(port, "/en/bad%", baselineHeaders);
      console.log(`HTTPS_LOCALE_MALFORMED_CONTROL rewrite=${baseline.status} noRewrite=${noRewriteControl.status}`);
      assert.equal(baseline.status, noRewriteControl.status, "malformed input must not add a new failure mode");
    } else {
      assert.ok([200, 308, 400, 404].includes(baseline.status), `${requestPath}: ${baseline.status}`);
    }
    for (const value of ["zh-CN", "wrong", "zh-CN, zh-CN"]) {
      const spoof = await get(port, encodedPath, { ...baselineHeaders, [marker]: value });
      assert.equal(spoof.status, baseline.status, requestPath);
      assert.equal(spoof.headers.location, baseline.headers.location, requestPath);
      if (baseline.headers["content-type"]?.includes("application/json")) assert.deepEqual(JSON.parse(spoof.body), JSON.parse(baseline.body), requestPath);
      parityCases++;
    }
  }
  const post = await get(port, "/play?x=1&x=2", { ...headers, origin: "https://iy.vxmeng.com", "content-type": "text/plain" }, "POST", "synthetic-body");
  assert.equal(post.status, 200);
  assert.equal(JSON.parse(post.body).pathname, "/zh-CN/play");
  assert.equal(JSON.parse(post.body).payload, "synthetic-body");
  for (const requestPath of ["/routing-page", "/en/routing-page", "/ja/routing-page"]) {
    const expectedLocale = requestPath === "/routing-page" ? "zh-CN" : requestPath.split("/")[1];
    const html = await get(port, requestPath, headers);
    assert.equal(html.status, 200);
    assert.match(html.headers["content-type"], /text\/html/);
    assert.match(html.body, new RegExp(`routing-page-locale:(?:<!-- -->)?${expectedLocale}`));
    const rsc = await get(port, requestPath + "?_rsc=synthetic", { ...headers, rsc: "1" });
    assert.equal(rsc.status, 200);
    assert.match(rsc.headers["content-type"], /text\/x-component/);
    assert.match(rsc.body, /routing-page-locale/);
    assert.ok(rsc.body.includes(`["locale","${expectedLocale}"`), requestPath);
    const prefetch = await get(port, requestPath + "?_rsc=synthetic", { ...headers, rsc: "1", "next-router-prefetch": "1", purpose: "prefetch" });
    assert.equal(prefetch.status, 200);
    assert.match(prefetch.headers["content-type"], /text\/x-component/);
    assert.ok(prefetch.body.includes(`["locale","${expectedLocale}"`), requestPath);
  }
  const head = await get(port, "/", headers, "HEAD");
  assert.equal(head.status, 200);
  assert.equal(head.body, "");
  assert.doesNotMatch(serverOutput, /Failed to proxy|EPROTO/);
  console.log(`HTTPS_LOCALE_NEXT_PASS routeCases=${liveCases + 2 + rules.beforeFiles.length} encodedParityCases=${parityCases} htmlRscCases=9 postCases=1 next=${require("next/package.json").version} externalHTTPS=preserved internalListener=HTTP loopbackOnly=1`);
  const legacy = await get(port, "/__legacy_regression_control", headers);
  assert.equal(legacy.status, 500);
  assert.match(serverOutput, /Failed to proxy https:\/\/localhost:/);
  console.log("HTTPS_LOCALE_LEGACY_500_REPRODUCED loopbackOnly=1");
} finally {
  if (server && server.exitCode === null) server.kill();
  if (serverClosed) await serverClosed;
  const resolved = await realpath(fixture);
  assert.equal(resolved, fixture);
  assert.ok(path.dirname(resolved) === fixtureParent && path.basename(resolved).startsWith("https-locale-routing-"));
  await rm(resolved, { recursive: true, force: false });
  console.log("HTTPS_LOCALE_FIXTURE_CLEANUP_PASS");
}
