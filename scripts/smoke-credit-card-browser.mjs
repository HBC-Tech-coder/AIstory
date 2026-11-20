import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const chromePath = path.resolve(
  process.env.AISTORY_TEST_CHROMIUM_PATH
    || "C:/Users/sunat/AppData/Local/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-win64/chrome-headless-shell.exe",
);
const forbiddenPorts = new Set([4200, 4107, 5679, 8188]);
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function assertTemp(target) {
  const prefix = `${path.resolve(os.tmpdir())}${path.sep}`.toLowerCase();
  if (!path.resolve(target).toLowerCase().startsWith(prefix)) {
    throw new Error("credit_card_browser_temp_invalid");
  }
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string" || forbiddenPorts.has(address.port)) {
    throw new Error("credit_card_browser_port_invalid");
  }
  return address.port;
}

async function closeServer(server) {
  if (server.listening) await new Promise((resolve) => server.close(resolve));
}

async function reservePort() {
  const server = createServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
}

async function esbuildModule() {
  const store = path.resolve(root, "node_modules/.pnpm");
  const entries = (await readdir(store, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^esbuild@\d/.test(entry.name))
    .map((entry) => entry.name).sort().reverse();
  for (const entry of entries) {
    const candidate = path.resolve(store, entry, "node_modules/esbuild/lib/main.js");
    try {
      await access(candidate);
      return import(pathToFileURL(candidate).href);
    } catch {
      // Continue within the workspace package store.
    }
  }
  throw new Error("credit_card_browser_esbuild_missing");
}

async function bundleHarness(tempRoot) {
  const entryPath = path.resolve(tempRoot, "entry.tsx");
  const outputPath = path.resolve(tempRoot, "bundle.js");
  const adminPath = path.resolve(root, "components/AdminCreditCardPanel.tsx").replaceAll("\\", "/");
  const userPath = path.resolve(root, "components/CreditCardRedeemPanel.tsx").replaceAll("\\", "/");
  const source = `
import React from "react";
import { createRoot } from "react-dom/client";
import { AdminCreditCardPanel } from ${JSON.stringify(adminPath)};
import { CreditCardRedeemPanel } from ${JSON.stringify(userPath)};

const params = new URLSearchParams(location.search);
const scenario = params.get("scenario") || "admin";
const state = { requests: [], accountEvents: 0 };
globalThis.__creditCardHarness = state;
window.addEventListener("aistory:account-changed", () => { state.accountEvents += 1; });
const batch = {
  batchId: "ccb_aaaaaaaaaaaaaaaaaaaaaaaa",
  denominationCredits: 100,
  quantity: 1,
  redeemedCount: 0,
  remainingCount: 0,
  disabledCount: 0,
  expiredCount: 1,
  state: "active",
  createdAt: "2026-08-01T00:00:00.000Z",
  expiresAt: "2026-08-08T00:00:00.000Z",
  activatedAt: "2026-08-01T00:01:00.000Z",
};
const snapshot = {
  schemaVersion: "aistory.credit-card.v1",
  status: "READY",
  policyVersion: "credit-card-policy-v1.synthetic",
  allowedDenominations: [100], allowedValidityDays: [7],
  maxBatchCount: 2, maxBatchCredits: 200, batches: [batch],
};
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input), location.origin);
  if (url.origin !== location.origin) throw new Error("external_network_forbidden");
  const body = init.body ? JSON.parse(String(init.body)) : undefined;
  state.requests.push({ path: url.pathname, method: init.method || "GET", action: body?.action || null });
  if (scenario === "admin-session" && !body) {
    return new Response(JSON.stringify({ error: "CREDIT_CARD_SESSION_REQUIRED" }), { status: 401 });
  }
  if (url.pathname === "/api/admin/credit-cards" && !body) {
    return Response.json(snapshot);
  }
  if (url.pathname === "/api/admin/credit-cards" && body?.action === "issue") {
    return Response.json({
      deliveryAvailable: true,
      oneTimeDelivery: {
        batchId: "ccb_bbbbbbbbbbbbbbbbbbbbbbbb",
        activationToken: "11111-11111-11111-11111-111111",
        cards: [{
          cardNumber: "AC1-00000-00000-00000-00000-000000",
          pin: "22222-22222-22222-22222-222222",
        }],
      },
    }, { status: 201 });
  }
  if (url.pathname === "/api/admin/credit-cards") {
    return Response.json({ ok: true, batch });
  }
  if (url.pathname === "/api/account/credit-cards/redeem") {
    if (scenario === "user-session") return Response.json({}, { status: 401 });
    if (scenario === "user-rate") return Response.json({}, { status: 429 });
    if (scenario === "user-failure") return Response.json({}, { status: 400 });
    return Response.json({ creditedCredits: 100, balanceAfter: 1100, replayed: false });
  }
  throw new Error("unexpected_request");
};
createRoot(document.getElementById("root")).render(
  scenario.startsWith("user") ? <CreditCardRedeemPanel /> : <AdminCreditCardPanel />,
);
`;
  await writeFile(entryPath, source, { encoding: "utf8", flag: "wx" });
  const { build } = await esbuildModule();
  await build({
    absWorkingDir: root,
    bundle: true,
    entryPoints: [entryPath],
    format: "iife",
    jsx: "automatic",
    logLevel: "silent",
    outfile: outputPath,
    platform: "browser",
    nodePaths: [path.resolve(root, "node_modules")],
    plugins: [{
      name: "credit-card-next-link-fake",
      setup(buildApi) {
        buildApi.onResolve({ filter: /^next\/link$/ }, () => ({
          path: "next-link", namespace: "credit-card-fake",
        }));
        buildApi.onLoad({ filter: /.*/, namespace: "credit-card-fake" }, () => ({
          contents: "import React from 'react'; export default function Link(p){return React.createElement('a',{...p,href:String(p.href)},p.children);}",
          loader: "js",
          resolveDir: root,
        }));
      },
    }],
  });
  return readFile(outputPath);
}

class Cdp {
  constructor(socketUrl, origin) {
    const url = new URL(socketUrl);
    if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1") throw new Error("cdp_not_loopback");
    this.socket = new WebSocket(url);
    this.origin = origin;
    this.id = 1;
    this.pending = new Map();
    this.exceptions = 0;
    this.consoleProblems = 0;
    this.external = 0;
  }
  async open() {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("cdp_open_timeout")), 5000);
      this.socket.addEventListener("open", () => { clearTimeout(timer); resolve(); });
      this.socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("cdp_open_error")); });
    });
    this.socket.addEventListener("message", (event) => this.message(event));
  }
  message(event) {
    const message = JSON.parse(String(event.data));
    if (message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id); this.pending.delete(message.id);
      if (message.error) pending.reject(new Error("cdp_command_failed"));
      else pending.resolve(message.result || {});
      return;
    }
    if (message.method === "Runtime.exceptionThrown") this.exceptions += 1;
    if (message.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(message.params.type)) this.consoleProblems += 1;
    if (message.method === "Fetch.requestPaused") {
      const requestId = message.params.requestId;
      let allowed = false;
      try { allowed = new URL(message.params.request.url).origin === this.origin; } catch { allowed = false; }
      if (!allowed) this.external += 1;
      void this.command(allowed ? "Fetch.continueRequest" : "Fetch.failRequest", allowed ? { requestId } : { requestId, errorReason: "BlockedByClient" });
    }
  }
  command(method, params = {}) {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const value = await this.command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (value.exceptionDetails) throw new Error("evaluate_failed");
    return value.result?.value;
  }
  async wait(expression, code) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (await this.evaluate(expression)) return;
      await delay(50);
    }
    throw new Error(code);
  }
  close() { this.socket.close(); }
}

async function waitCdp(port) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch { /* Chromium is starting. */ }
    await delay(100);
  }
  throw new Error("cdp_start_timeout");
}

async function target(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT", signal: AbortSignal.timeout(2000) });
  const value = await response.json();
  if (!response.ok || !value.webSocketDebuggerUrl) throw new Error("cdp_target_failed");
  return value.webSocketDebuggerUrl;
}

async function navigate(client, url, text) {
  await client.command("Page.navigate", { url });
  await client.wait("document.readyState === 'complete'", "navigation_timeout");
  await client.wait(`document.body.textContent.includes(${JSON.stringify(text)})`, "component_missing");
}

const clickText = (text) => `(() => { const item=[...document.querySelectorAll('button')].find(x=>x.textContent.includes(${JSON.stringify(text)})); if(!item)return false; item.click(); return true; })()`;
const setInput = (index, value) => `(() => { const input=document.querySelectorAll('input')[${index}]; const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; setter.call(input,${JSON.stringify(value)}); input.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`;

let tempRoot;
let server;
let browser;
let client;
try {
  await access(chromePath);
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "aistory-credit-card-browser-"));
  assertTemp(tempRoot);
  const bundle = await bundleHarness(tempRoot);
  server = createServer((request, response) => {
    const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
    if (pathname === "/bundle.js") {
      response.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-store" }); response.end(bundle); return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'self'; connect-src 'self'; img-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'" });
    response.end("<!doctype html><html lang=zh-CN><meta charset=utf-8><body><div id=root></div><script src=/bundle.js></script></body></html>");
  });
  const runtimePort = await listen(server);
  const origin = `http://127.0.0.1:${runtimePort}`;
  const cdpPort = await reservePort();
  browser = spawn(chromePath, ["--headless=new", "--disable-background-networking", "--disable-component-update", "--disable-default-apps", "--disable-extensions", "--disable-sync", "--metrics-recording-only", "--no-first-run", "--no-proxy-server", "--proxy-bypass-list=<-loopback>", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${path.resolve(tempRoot, "profile")}`, "about:blank"], { stdio: "ignore", windowsHide: true });
  await waitCdp(cdpPort);
  client = new Cdp(await target(cdpPort), origin);
  await client.open();
  await client.command("Runtime.enable"); await client.command("Page.enable"); await client.command("Fetch.enable", { patterns: [{ urlPattern: "*" }] });

  await client.command("Page.navigate", { url: `${origin}/?scenario=admin-session` });
  await client.wait(
    "location.pathname === '/admin/login' && new URLSearchParams(location.search).get('state') === 'session-ended'",
    "admin_session_redirect_missing",
  );

  await navigate(client, `${origin}/?scenario=admin`, "管理员积分卡");
  await client.wait("document.querySelectorAll('select').length === 2", "admin_snapshot_missing");
  await client.evaluate(`${clickText("生成一次性卡密")}; ${clickText("生成一次性卡密")}`);
  await client.wait("Boolean(document.querySelector('[data-one-time-delivery]'))", "delivery_missing");
  let state = await client.evaluate("globalThis.__creditCardHarness");
  assert.equal(state.requests.filter((item) => item.action === "issue").length, 1);
  assert.equal(await client.evaluate("document.body.textContent.includes('AC1-00000')"), true);
  await client.evaluate("window.dispatchEvent(new Event('pagehide')); true");
  await client.wait("!document.querySelector('[data-one-time-delivery]')", "pagehide_clear_failed");
  await client.evaluate(clickText("生成一次性卡密"));
  await client.wait("Boolean(document.querySelector('[data-one-time-delivery]'))", "second_delivery_missing");
  await client.evaluate(clickText("已安全保存，激活批次"));
  await client.wait("!document.querySelector('[data-one-time-delivery]')", "activation_clear_failed");
  await client.evaluate(clickText("禁用未兑换卡"));
  await client.wait("globalThis.__creditCardHarness.requests.some(x=>x.action==='disable_batch')", "expired_disable_missing");

  await navigate(client, `${origin}/?scenario=user-success`, "兑换积分卡");
  await client.evaluate(setInput(0, "AC1-00000-00000-00000-00000-000000"));
  await client.evaluate(setInput(1, "22222-22222-22222-22222-222222"));
  await client.evaluate(`${clickText("确认兑换")}; ${clickText("确认兑换")}`);
  await client.wait("document.body.textContent.includes('兑换成功')", "redeem_success_missing");
  state = await client.evaluate("globalThis.__creditCardHarness");
  assert.equal(state.requests.filter((item) => item.path.includes("redeem")).length, 1);
  assert.equal(state.accountEvents, 1);
  assert.equal(await client.evaluate("[...document.querySelectorAll('input')].every(x=>x.value==='')"), true);

  await navigate(client, `${origin}/?scenario=user-failure`, "兑换积分卡");
  await client.evaluate(setInput(0, "AC1-00000-00000-00000-00000-000000"));
  await client.evaluate(setInput(1, "22222-22222-22222-22222-222222"));
  await client.evaluate(clickText("确认兑换"));
  await client.wait("document.body.textContent.includes('暂不可用')", "enumeration_safe_failure_missing");

  await navigate(client, `${origin}/?scenario=user-session`, "兑换积分卡");
  await client.evaluate(setInput(0, "AC1-00000-00000-00000-00000-000000"));
  await client.evaluate(setInput(1, "22222-22222-22222-22222-222222"));
  await client.evaluate(clickText("确认兑换"));
  await client.wait("document.body.textContent.includes('请先登录普通用户账户')", "user_session_message_missing");

  await navigate(client, `${origin}/?scenario=user-rate`, "兑换积分卡");
  await client.evaluate(setInput(0, "AC1-00000-00000-00000-00000-000000"));
  await client.evaluate(setInput(1, "22222-22222-22222-22222-222222"));
  await client.evaluate(clickText("确认兑换"));
  await client.wait("document.body.textContent.includes('尝试次数过多')", "user_rate_message_missing");
  assert.equal(client.exceptions, 0); assert.equal(client.consoleProblems, 0); assert.equal(client.external, 0);
  console.log("credit-card Chromium local-fake smoke: PASS (one-time clear, idempotent clicks, expired disable, redeem success/failure, admin/user session, rate limit, zero external network)");
} finally {
  client?.close();
  if (browser?.pid) {
    const killer = spawn("taskkill", ["/PID", String(browser.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    await new Promise((resolve) => killer.once("exit", resolve));
  }
  if (server) await closeServer(server);
  if (tempRoot) { assertTemp(tempRoot); await rm(tempRoot, { recursive: true, force: false, maxRetries: 20, retryDelay: 100 }); }
}
