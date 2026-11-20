import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 1 && args[0] === "--serve-only"), "admin_browser_arguments");
const serveOnly = args[0] === "--serve-only";
const savedFetch = globalThis.fetch;
let externalNetworkAttempts = 0;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
    externalNetworkAttempts++; throw new Error("admin_browser_external_network_forbidden");
  }
  return savedFetch(input, init);
};
const chromePath = path.resolve(
  process.env.AISTORY_TEST_CHROMIUM_PATH
    || "C:/Users/sunat/AppData/Local/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-win64/chrome-headless-shell.exe",
);
const forbiddenPorts = new Set([3000, 4200, 4107, 5679, 8188, 19527]);
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function assertTempRoot(target) {
  const resolved = path.resolve(target);
  const tempBase = `${path.resolve(os.tmpdir())}${path.sep}`.toLowerCase();
  if (!resolved.toLowerCase().startsWith(tempBase)) {
    throw new Error("admin_browser_temp_root_invalid");
  }
}

async function listenLoopback(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string" || forbiddenPorts.has(address.port)) {
    throw new Error("admin_browser_port_invalid");
  }
  return address.port;
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

async function reserveLoopbackPort() {
  const server = createServer();
  const port = await listenLoopback(server);
  await closeServer(server);
  return port;
}

async function resolveEsbuild() {
  const pnpmRoot = path.resolve(root, "node_modules/.pnpm");
  const entries = (await readdir(pnpmRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^esbuild@\d/.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "en"));
  for (const entry of entries.reverse()) {
    const candidate = path.resolve(
      pnpmRoot,
      entry,
      "node_modules/esbuild/lib/main.js",
    );
    try {
      await access(candidate);
      return import(pathToFileURL(candidate).href);
    } catch {
      // Try the next workspace-owned package instance.
    }
  }
  throw new Error("admin_browser_esbuild_missing");
}

async function createHarness(tempRoot) {
  const entryPath = path.resolve(tempRoot, "entry.tsx");
  const bundlePath = path.resolve(tempRoot, "bundle.js");
  const componentPath = path
    .resolve(root, "app/admin/login/AdminLoginForm.tsx")
    .replaceAll("\\", "/");
  const changePath = path.resolve(root, "app/admin/password-change/AdminPasswordChangeForm.tsx").replaceAll("\\", "/");
  const entrySource = `
import React from "react";
import { createRoot } from "react-dom/client";
import { AdminLoginForm } from ${JSON.stringify(componentPath)};
import { AdminPasswordChangeForm } from ${JSON.stringify(changePath)};

const params = new URLSearchParams(location.search);
const scenario = params.get("scenario") || "failure";
const httpFlow = location.pathname.startsWith("/admin");
const state = { requests: [], router: [] };
globalThis.__adminHarnessState = state;
globalThis.__adminHarnessRouter = {
  replace(value) { state.router.push({ kind: "replace", value }); if(httpFlow) location.replace(value); },
  refresh() { state.router.push({ kind: "refresh" }); },
};
const realFetch=globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input), location.origin);
  if (url.origin !== location.origin || !["/api/admin/session", "/api/admin/password-change"].includes(url.pathname)) {
    throw new Error("network_forbidden");
  }
  if (httpFlow) return realFetch(input, init);
  const parsed = JSON.parse(String(init.body || "{}"));
  state.requests.push({
    method: String(init.method || "GET"),
    keys: Object.keys(parsed).sort(),
    contentType: new Headers(init.headers).get("content-type"),
  });
  const status = ["success", "temporary", "change-success", "change-unsafe"].includes(scenario) ? 200
    : scenario === "rate" ? 429 : scenario === "change-expired" ? 401 : scenario === "change-unavailable" ? 503 : 403;
  const responseState = scenario === "temporary" ? "password_change_required" : scenario === "change-success" ? "signed_out" : "console";
  return new Response(JSON.stringify({ ok: status === 200, state: responseState, ...(scenario === "change-success" ? {freshLoginRequired:true}: {}) }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
};

createRoot(document.getElementById("root")).render(
  httpFlow && location.pathname==="/admin" ? <section><h1>独立管理员控制台（合成只读）</h1><p>Fresh login verified; no business mutation available.</p>
    <button onClick={async()=>{const r=await fetch('/api/admin/session',{method:'DELETE',headers:{'Content-Type':'application/json'},body:'{}'});if(r.ok)location.replace('/admin/login?state=session-ended');}}>退出管理员登录</button></section>
  : location.pathname==="/admin/password-change" || scenario.startsWith("change-") ? <AdminPasswordChangeForm /> : <AdminLoginForm
    localAdminAvailable={false}
    sessionEnded={scenario === "session-ended" || params.get("state")==="session-ended"}
    passwordChanged={scenario === "password-changed" || params.get("state")==="password-changed"}
  />,
);
`;
  await writeFile(entryPath, entrySource, { encoding: "utf8", flag: "wx" });
  const { build } = await resolveEsbuild();
  await build({
    absWorkingDir: root,
    bundle: true,
    entryPoints: [entryPath],
    format: "iife",
    jsx: "automatic",
    logLevel: "silent",
    outfile: bundlePath,
    platform: "browser",
    // Synthetic compile-time flags for Next Link; never load a runtime env file.
    define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
    nodePaths: [path.resolve(root, "node_modules")],
    plugins: [{
      name: "admin-next-navigation-fake",
      setup(buildApi) {
        buildApi.onResolve(
          { filter: /^next\/navigation$/ },
          () => ({ path: "admin-next-navigation", namespace: "admin-fake" }),
        );
        buildApi.onLoad(
          { filter: /.*/, namespace: "admin-fake" },
          () => ({
            contents: "export function useRouter(){return globalThis.__adminHarnessRouter;}",
            loader: "js",
          }),
        );
      },
    }],
  });
  return readFile(bundlePath);
}

async function createHttpFixture(tempRoot) {
  const bundlePath = path.resolve(tempRoot, "server-fixture.cjs");
  const { build } = await resolveEsbuild();
  await build({ absWorkingDir: root, bundle: true, platform: "node", format: "cjs", logLevel: "silent",
    entryPoints: [path.resolve(root, "scripts/fixtures/independent-admin-pending-activation-v2.ts")], outfile: bundlePath,
    plugins: [{ name: "synthetic-server-only-boundary", setup(api) {
      api.onResolve({ filter: /^server-only$/ }, () => ({ path: "server-only", namespace: "test-only" }));
      api.onLoad({ filter: /.*/, namespace: "test-only" }, () => ({ contents: "", loader: "js" }));
    } }] });
  const fixtureModule = await import(pathToFileURL(bundlePath).href);
  return fixtureModule.createPendingActivationHttpFixture();
}

class CdpClient {
  constructor(webSocketUrl, origin) {
    const parsed = new URL(webSocketUrl);
    if (parsed.protocol !== "ws:" || parsed.hostname !== "127.0.0.1") {
      throw new Error("admin_browser_cdp_not_loopback");
    }
    this.socket = new WebSocket(parsed);
    this.origin = origin;
    this.nextId = 1;
    this.pending = new Map();
    this.runtimeExceptions = 0;
    this.consoleErrors = 0;
    this.consoleWarnings = 0;
    this.blockedExternal = 0;
  }

  async open() {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("admin_browser_cdp_open_timeout")),
        5_000,
      );
      this.socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("admin_browser_cdp_open_failed"));
      });
    });
    this.socket.addEventListener("message", (event) => this.onMessage(event));
  }

  onMessage(event) {
    const message = JSON.parse(String(event.data));
    if (message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error("admin_browser_cdp_command_failed"));
      else pending.resolve(message.result || {});
      return;
    }
    if (message.method === "Fetch.requestPaused") {
      const requestId = message.params.requestId;
      let allowed = false;
      try {
        const requestUrl = new URL(String(message.params.request?.url || ""));
        allowed = requestUrl.origin === this.origin;
      } catch {
        allowed = false;
      }
      if (!allowed) this.blockedExternal += 1;
      void this.command(
        allowed ? "Fetch.continueRequest" : "Fetch.failRequest",
        allowed
          ? { requestId }
          : { requestId, errorReason: "BlockedByClient" },
      );
    } else if (message.method === "Runtime.exceptionThrown") {
      this.runtimeExceptions += 1;
    } else if (message.method === "Runtime.consoleAPICalled") {
      if (message.params.type === "error") this.consoleErrors += 1;
      if (message.params.type === "warning") this.consoleWarnings += 1;
    }
  }

  command(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.command("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) throw new Error("admin_browser_evaluate_failed");
    return result.result?.value;
  }

  async waitFor(expression, code) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (await this.evaluate(expression)) return;
      await delay(50);
    }
    throw new Error(code);
  }

  close() {
    this.socket.close();
  }
}

async function waitForCdp(port) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
      // Chromium is still starting.
    }
    await delay(100);
  }
  throw new Error("admin_browser_cdp_start_timeout");
}

async function createTarget(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
    method: "PUT",
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) throw new Error("admin_browser_target_failed");
  const target = await response.json();
  if (!target.webSocketDebuggerUrl) throw new Error("admin_browser_target_invalid");
  return target.webSocketDebuggerUrl;
}

async function navigate(client, url) {
  await client.command("Page.navigate", { url });
  await client.waitFor("document.readyState === 'complete'", "admin_browser_navigation_timeout");
  await client.waitFor(
    "Boolean(document.querySelector('input[autocomplete=current-password]'))",
    "admin_browser_form_missing",
  );
}

async function submit(client) {
  await client.evaluate(`(() => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    const username = document.querySelector('input[autocomplete=username]');
    const password = document.querySelector('input[autocomplete=current-password]');
    setValue.call(username, "admin");
    username.dispatchEvent(new Event("input", { bubbles: true }));
    setValue.call(password, "admin888");
    password.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector('button[type=submit]').click();
    return true;
  })()`);
}

let tempRoot;
let runtimeServer;
let browser;
let client;
try {
  if (!serveOnly) await access(chromePath);
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "aistory-admin-browser-"));
  assertTempRoot(tempRoot);
  const bundle = await createHarness(tempRoot);
  const flow = await createHttpFixture(tempRoot);
  let requestCount = 0;
  runtimeServer = createServer(async (request, response) => {
    try {
    requestCount += 1;
    const handled = await flow.handle(request);
    if (handled) {
      response.writeHead(handled.status, Object.fromEntries(handled.headers));
      response.end(Buffer.from(await handled.arrayBuffer())); return;
    }
    const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
    if (pathname === "/favicon.ico") { response.writeHead(204); response.end(); return; }
    if (pathname === "/bundle.js") {
      response.writeHead(200, {
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(bundle);
      return;
    }
    if (["/", "/admin", "/admin/login", "/admin/password-change"].includes(pathname)) {
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'self'; connect-src 'self'; img-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'",
      });
      response.end("<!doctype html><html lang=zh-CN><meta charset=utf-8><meta name=viewport content=width=device-width,initial-scale=1><title>AIstory isolated admin fixture</title><body><div id=root></div><script src=/bundle.js></script></body></html>");
      return;
    }
    response.writeHead(404, { "Content-Type": "text/plain" });
    response.end("not found");
    } catch { response.writeHead(500, { "Content-Type": "application/json", "Cache-Control": "no-store" }); response.end('{"error":"Synthetic fixture failed."}'); }
  });
  const runtimePort = await listenLoopback(runtimeServer);
  const origin = `http://127.0.0.1:${runtimePort}`;
  if (serveOnly) {
    console.log(JSON.stringify({ state: "PENDING_ACTIVATION_V2_HTTP_FIXTURE_READY", origin, pid: process.pid,
      production: false, db: "synthetic_in_memory", credentialFiles: 0 }));
    await new Promise(resolve => {
      process.once("SIGTERM", resolve); process.once("SIGINT", resolve);
      process.stdin.once("data", resolve); process.stdin.once("end", resolve); process.stdin.resume();
    });
    process.stdin.pause();
  } else {
  const cdpPort = await reserveLoopbackPort();
  browser = spawn(chromePath, [
    "--headless=new",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-sync",
    "--metrics-recording-only",
    "--no-first-run",
    "--no-proxy-server",
    "--proxy-bypass-list=<-loopback>",
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${path.resolve(tempRoot, "profile")}`,
    "about:blank",
  ], { stdio: "ignore", windowsHide: true });
  await waitForCdp(cdpPort);
  client = new CdpClient(await createTarget(cdpPort), origin);
  await client.open();
  await client.command("Runtime.enable");
  await client.command("Page.enable");
  await client.command("Fetch.enable", { patterns: [{ urlPattern: "*" }] });

  await navigate(client, `${origin}/?scenario=failure`);
  await submit(client);
  await client.waitFor(
    "Boolean(document.querySelector('[role=alert]'))",
    "admin_browser_failure_state_missing",
  );
  const failure = await client.evaluate(`({
    alert: document.querySelector('[role=alert]')?.textContent,
    passwordCleared: document.querySelector('input[autocomplete=current-password]')?.value === "",
    localFormAbsent: !document.body.textContent.includes("Loopback 本地开发入口"),
    state: globalThis.__adminHarnessState,
  })`);
  assert.equal(failure.alert, "管理员账号或密码无效。");
  assert.equal(failure.passwordCleared, true);
  assert.equal(failure.localFormAbsent, true);
  assert.deepEqual(failure.state.requests, [{
    method: "POST",
    keys: ["password", "username"],
    contentType: "application/json",
  }]);
  assert.deepEqual(failure.state.router, []);

  await navigate(client, `${origin}/?scenario=success`);
  await submit(client);
  await client.waitFor(
    "globalThis.__adminHarnessState.router.length === 2",
    "admin_browser_success_redirect_missing",
  );
  const success = await client.evaluate("globalThis.__adminHarnessState");
  assert.deepEqual(success.router, [
    { kind: "replace", value: "/admin" },
    { kind: "refresh" },
  ]);
  assert.equal(success.requests.length, 1);

  await navigate(client, `${origin}/?scenario=temporary`);
  await submit(client);
  await client.waitFor("globalThis.__adminHarnessState.router.length === 2", "temporary_redirect_missing");
  assert.equal((await client.evaluate("globalThis.__adminHarnessState.router[0].value")), "/admin/password-change");

  for (const policyCase of [
    { password: "Aa1!bcde", message: "新密码须至少 9 个 Unicode 字符、最多 512 个 UTF-8 字节，并在大写字母、小写字母、数字、特殊字符中至少包含三类。" },
    { password: "abcdefg12", message: "新密码须至少 9 个 Unicode 字符、最多 512 个 UTF-8 字节，并在大写字母、小写字母、数字、特殊字符中至少包含三类。" },
    { password: "admin888", message: "新密码不能使用公开临时初始密码。" },
  ]) {
    await navigate(client, `${origin}/?scenario=change-policy`);
    await client.evaluate(`(() => {
      const setValue=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set;
      const current=document.querySelector('input[autocomplete=current-password]');
      setValue.call(current,'admin888'); current.dispatchEvent(new Event('input',{bubbles:true}));
      document.querySelectorAll('input[autocomplete=new-password]').forEach(input=>{
        setValue.call(input,${JSON.stringify(policyCase.password)}); input.dispatchEvent(new Event('input',{bubbles:true}));
      });
      document.querySelector('button[type=submit]').click();
    })()`);
    await client.waitFor("Boolean(document.querySelector('[role=alert]'))", "password_policy_alert_missing");
    const rejected = await client.evaluate(`({state:globalThis.__adminHarnessState,
      alert:document.querySelector('[role=alert]')?.textContent,
      cleared:[...document.querySelectorAll('input[type=password]')].every(x=>x.value===''),
      oldRuleAbsent:!document.body.textContent.includes('至少 24')&&!document.body.textContent.includes('12 个不同字符')})`);
    assert.equal(rejected.alert, policyCase.message);
    assert.equal(rejected.cleared, true);
    assert.equal(rejected.oldRuleAbsent, true);
    assert.deepEqual(rejected.state.requests, []);
  }

  for (const scenario of ["change-failure", "change-expired", "change-unavailable", "change-unsafe", "change-success"]) {
    await navigate(client, `${origin}/?scenario=${scenario}`);
    await client.evaluate(`(() => {
      const setValue=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set;
      const current=document.querySelector('input[autocomplete=current-password]');
      const next='Aa1aaaaaa';
      setValue.call(current,'admin888'); current.dispatchEvent(new Event('input',{bubbles:true}));
      document.querySelectorAll('input[autocomplete=new-password]').forEach(input=>{
        setValue.call(input,next); input.dispatchEvent(new Event('input',{bubbles:true}));
      });
      document.querySelector('button[type=submit]').click();
      document.querySelector('button[type=submit]').click();
    })()`);
    await client.waitFor(scenario === "change-success"
      ? "globalThis.__adminHarnessState.router.length === 2" : "Boolean(document.querySelector('[role=alert]'))", "change_state_missing");
    const observed = await client.evaluate(`({state:globalThis.__adminHarnessState,
      cleared:[...document.querySelectorAll('input[type=password]')].every(x=>x.value==='')})`);
    assert.equal(observed.cleared, true);
    assert.equal(observed.state.requests.length, 1);
    assert.deepEqual(observed.state.requests[0].keys, ["currentPassword", "newPassword"]);
    assert.deepEqual(observed.state.router, scenario === "change-success" ? [
      {kind:"replace",value:"/admin/login?state=password-changed"},{kind:"refresh"},
    ] : []);
  }

  await navigate(client, `${origin}/?scenario=session-ended`);
  const ended = await client.evaluate(`({
    status: document.querySelector('[role=status]')?.textContent,
    phoneOtpAbsent: !document.body.textContent.includes("手机号登录"),
  })`);
  assert.equal(ended.status, "管理员会话已结束，请重新登录。");
  assert.equal(ended.phoneOtpAbsent, true);
  assert.equal(client.runtimeExceptions, 0);
  assert.equal(client.consoleErrors, 0);
  assert.equal(client.consoleWarnings, 0);
  assert.equal(client.blockedExternal, 0);
  assert.ok(requestCount >= 6);
  console.log("independent administrator browser local-fake smoke passed");
  }
} finally {
  client?.close();
  if (browser?.pid) {
    const killer = spawn(
      "taskkill",
      ["/PID", String(browser.pid), "/T", "/F"],
      { stdio: "ignore", windowsHide: true },
    );
    await new Promise((resolve) => killer.once("exit", resolve));
  }
  if (runtimeServer) await closeServer(runtimeServer);
  if (tempRoot) {
    assertTempRoot(tempRoot);
    await rm(tempRoot, {
      recursive: true,
      force: false,
      maxRetries: 20,
      retryDelay: 100,
    });
  }
  globalThis.fetch = savedFetch;
  assert.equal(externalNetworkAttempts, 0);
  if (serveOnly) console.log("PENDING_ACTIVATION_V2_HTTP_FIXTURE_CLEANED external-network=0 temporary-root=removed listener=closed");
}
