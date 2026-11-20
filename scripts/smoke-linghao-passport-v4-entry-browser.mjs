#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = path.join(
  repoRoot,
  "scripts",
  "fixtures",
  "linghao-passport-v4-entry-browser.tsx",
);
const chromeExecutable = process.env.LINGHAO_PASSPORT_V4_CHROME
  || "C:\\Users\\sunat\\AppData\\Local\\ms-playwright\\chromium_headless_shell-1228\\chrome-headless-shell-win64\\chrome-headless-shell.exe";
const logoutState = "s".repeat(43);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const logDir = path.join(
  repoRoot,
  ".codex-logs",
  `linghao-passport-v4-entry-browser-${stamp}-${process.pid}`,
);
const requireFromRepo = createRequire(path.join(repoRoot, "package.json"));

let server;
let chrome;
let chromeLogFd;
let chromeSpawnError;
let userDataDir;
let cdp;
let sessionId = "";

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function resolveFromRepo(specifier) {
  try {
    return requireFromRepo.resolve(specifier);
  } catch {
    return null;
  }
}

function firstExisting(candidates) {
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? null;
}

function resolveRepoAlias(specifier) {
  const target = path.join(repoRoot, specifier.slice(2));
  const candidates = [
    target,
    `${target}.tsx`,
    `${target}.ts`,
    `${target}.jsx`,
    `${target}.js`,
    path.join(target, "index.tsx"),
    path.join(target, "index.ts"),
  ];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch {
      // Keep looking for an exact source file.
    }
  }
  return null;
}

function createAliasPlugin() {
  const stubs = new Map([
    [
      "next/link",
      `export default function Link(props) {
        const { href, children, ...rest } = props;
        return <a href={typeof href === "string" ? href : String(href)} {...rest}>{children}</a>;
      }`,
    ],
    [
      "@/components/LinghaoPassportV4LocalPanel",
      "export default function LinghaoPassportV4LocalPanel() { return <div>local panel stub</div>; }",
    ],
    [
      "@/components/LinghaoPassportV4LoginButton",
      "export function LinghaoPassportV4LoginButton() { return <button>login button stub</button>; }",
    ],
  ]);
  return {
    name: "linghao-passport-v4-entry-smoke-aliases",
    setup(build) {
      build.onResolve(
        { filter: /^(next\/link|@\/components\/LinghaoPassportV4(?:LocalPanel|LoginButton))$/ },
        (args) => ({ path: args.path, namespace: "entry-smoke-stub" }),
      );
      build.onLoad({ filter: /.*/, namespace: "entry-smoke-stub" }, (args) => ({
        contents: stubs.get(args.path),
        loader: "tsx",
        resolveDir: repoRoot,
      }));
      build.onResolve({ filter: /^@\// }, (args) => {
        const target = resolveRepoAlias(args.path);
        return target ? { path: target } : undefined;
      });
    },
  };
}

async function buildBundle() {
  const esbuildMain = firstExisting([
    path.join(repoRoot, "node_modules", ".pnpm", "esbuild@0.28.1", "node_modules", "esbuild", "lib", "main.js"),
    path.join(repoRoot, "node_modules", "esbuild", "lib", "main.js"),
    resolveFromRepo("esbuild"),
  ]);
  assert.ok(esbuildMain, "esbuild is required for the Passport entry browser smoke");
  const imported = await import(pathToFileURL(esbuildMain).href);
  const build = imported.build ?? imported.default?.build;
  assert.equal(typeof build, "function");
  const result = await build({
    absWorkingDir: repoRoot,
    entryPoints: [fixturePath],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: ["chrome120"],
    jsx: "automatic",
    jsxImportSource: "react",
    legalComments: "none",
    logLevel: "silent",
    nodePaths: [path.join(repoRoot, "node_modules")],
    define: { "process.env.NODE_ENV": '"development"' },
    plugins: [createAliasPlugin()],
    tsconfig: path.join(repoRoot, "tsconfig.json"),
  });
  const output = result.outputFiles?.find((file) => file.path.endsWith(".js"))
    ?? result.outputFiles?.[0];
  assert.ok(output, "esbuild did not emit the Passport entry fixture");
  return output.text;
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener("message", (event) => {
      const raw = typeof event.data === "string"
        ? event.data
        : Buffer.from(event.data).toString("utf8");
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        return;
      }
      if (typeof message.id !== "number") return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      else pending.resolve(message.result);
    });
  }

  send(method, params = {}, targetSession = undefined, timeoutMs = 15_000) {
    const id = this.nextId;
    this.nextId += 1;
    const message = { id, method, params };
    if (targetSession) message.sessionId = targetSession;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.socket.send(JSON.stringify(message));
    });
  }

  close() {
    try {
      this.socket.close();
    } catch {
      // Best effort.
    }
  }
}

async function startServer(bundle) {
  const html = "<!doctype html><html><head><meta charset='utf-8'><title>Passport entry smoke</title></head><body><div id='root'></div><script src='/bundle.js'></script></body></html>";
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/bundle.js") {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
      response.end(bundle);
      return;
    }
    if (url.pathname === "/favicon.ico") {
      response.writeHead(204);
      response.end();
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    response.end(html);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

async function launchChrome() {
  assert.ok(existsSync(chromeExecutable), `Chromium not found at ${chromeExecutable}`);
  userDataDir = mkdtempSync(path.join(os.tmpdir(), "linghao-passport-v4-entry-"));
  chromeLogFd = openSync(path.join(logDir, "chrome.log"), "a");
  chrome = spawn(chromeExecutable, [
    "--headless",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--disable-background-networking",
    "about:blank",
  ], {
    windowsHide: true,
    stdio: ["ignore", chromeLogFd, chromeLogFd],
  });
  chrome.once("error", (error) => { chromeSpawnError = error; });

  const activePortFile = path.join(userDataDir, "DevToolsActivePort");
  const deadline = Date.now() + 20_000;
  let activePort;
  while (Date.now() < deadline && !activePort) {
    if (chromeSpawnError) throw chromeSpawnError;
    if (chrome.exitCode !== null) throw new Error(`Chromium exited early: ${chrome.exitCode}`);
    try {
      const [port, socketPath] = readFileSync(activePortFile, "utf8").trim().split(/\r?\n/);
      if (Number(port) > 0 && socketPath) activePort = { port, socketPath };
    } catch {
      // The file is absent or mid-write; retry.
    }
    if (!activePort) await sleep(50);
  }
  assert.ok(activePort, "Chromium DevToolsActivePort was not created");

  const socket = new WebSocket(`ws://127.0.0.1:${activePort.port}${activePort.socketPath}`);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP connection timeout")), 10_000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP connection failed")); }, { once: true });
  });
  cdp = new CdpClient(socket);
}

async function evaluate(expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, sessionId);
  if (result.exceptionDetails) {
    throw new Error(`browser evaluation failed: ${JSON.stringify(result.exceptionDetails)}`);
  }
  return result.result?.value;
}

async function readSettledSnapshot() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const snapshot = await evaluate("window.__linghaoPassportV4EntrySmoke?.snapshot() ?? null");
    if (snapshot?.logoutAction && snapshot.notice) return snapshot;
    await sleep(50);
  }
  throw new Error("Passport entry fixture did not settle");
}

async function cleanup() {
  cdp?.close();
  if (chrome && chrome.exitCode === null) chrome.kill();
  if (chrome) {
    await Promise.race([
      chrome.exitCode === null
        ? new Promise((resolve) => chrome.once("exit", resolve))
        : Promise.resolve(),
      sleep(3_000),
    ]);
  }
  if (server) await new Promise((resolve) => server.close(resolve));
  if (chromeLogFd !== undefined) closeSync(chromeLogFd);
  if (userDataDir && path.dirname(userDataDir) === os.tmpdir()) {
    rmSync(userDataDir, { recursive: true, force: true });
  }
}

mkdirSync(logDir, { recursive: true });
try {
  const bundle = await buildBundle();
  const port = await startServer(bundle);
  await launchChrome();
  const created = await cdp.send("Target.createTarget", { url: "about:blank" });
  const attached = await cdp.send("Target.attachToTarget", {
    targetId: created.targetId,
    flatten: true,
  });
  sessionId = attached.sessionId;
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Page.navigate", {
    url: `http://127.0.0.1:${port}/auth/linghao-passport-v4?state=${logoutState}`,
  }, sessionId);
  const snapshot = await readSettledSnapshot();

  assert.equal(snapshot.loggedOutPosts, 1);
  assert.ok(snapshot.sessionGets >= 1);
  assert.ok(snapshot.capabilityGets >= 1);
  assert.equal(snapshot.unknownRequests, 0);
  assert.equal(snapshot.pathname, "/auth/linghao-passport-v4");
  assert.equal(snapshot.search, "");
  assert.match(snapshot.notice, /本地会话与上游令牌撤销已确认，并已从上游登出返回。/);
  assert.equal(snapshot.logoutAction, "/api/auth/linghao-passport-v4/logout");
  assert.equal(snapshot.closedEntryVisible, false);

  const report = path.join(logDir, "report.json");
  writeFileSync(report, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log("PASS_LINGHAO_PASSPORT_V4_ENTRY_BROWSER");
  console.log(JSON.stringify({ ...snapshot, report }));
} finally {
  await cleanup();
}
