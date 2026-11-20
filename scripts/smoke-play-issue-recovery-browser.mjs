#!/usr/bin/env node
// Real-browser acceptance for the /play issue-recovery work.
//
// This script is deliberately self-contained:
//   * it talks raw CDP over Node's global WebSocket;
//   * it launches its own chrome-headless-shell with an isolated mkdtemp profile;
//   * it intercepts every request before navigation and mocks all /api routes;
//   * it writes screenshots plus one JSON result under the evidence directory.
//
// Usage:
//   node scripts/smoke-play-issue-recovery-browser.mjs
//   node scripts/smoke-play-issue-recovery-browser.mjs http://127.0.0.1:4330
//   node scripts/smoke-play-issue-recovery-browser.mjs --origin=http://127.0.0.1:4331
//
// Only a literal loopback origin is accepted. Production/remote origins are
// refused before Chrome is launched.

import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_ORIGIN = "http://127.0.0.1:4330";
const CHROME_EXECUTABLE =
  process.env.AISTORY_SMOKE_CHROME_EXECUTABLE || path.join(
    process.env.LOCALAPPDATA || path.join(homedir(), "AppData", "Local"),
    "ms-playwright", "chromium_headless_shell-1228",
    "chrome-headless-shell-win64", "chrome-headless-shell.exe",
  );
const EVIDENCE_PARENT =
  process.env.AISTORY_PLAY_SMOKE_EVIDENCE_ROOT ||
  path.join(tmpdir(), "aistory-play-browser-evidence");
const PLAY_PATH = "/zh-CN/play?custom=1";
const VIEWPORT = Object.freeze({ width: 1440, height: 900 });
const LOOPBACK_HOSTS = new Set([
  "127.0.0.1",
  "::1",
  "0:0:0:0:0:0:0:1",
  "::ffff:127.0.0.1",
  "localhost",
]);
const CUSTOM_DRAFT_TITLE_ZH = "当前标签页的自定义草稿已不可用";
const CUSTOM_DRAFT_MISSING_NOTE_ZH =
  "没有在当前标签页找到可用的自定义草稿。";
const CUSTOM_DRAFT_MALFORMED_NOTE_ZH =
  "当前标签页的自定义草稿无法安全解析。";
const AUTH_PAUSED_TITLE_ZH = "登录后才能继续生成";
const AUTH_REOPEN_LOGIN_ZH = "重新打开登录";
const FAKE_PHONE = "13800000000";
const FAKE_OTP = "123456";
const SMOKE_ACCOUNT_ID = "00000000-0000-4000-8000-000000000001";
const SAFE_START_503 = Object.freeze({
  error: "Browser smoke: generation intentionally unavailable",
  code: "SMOKE_GENERATION_DISABLED",
});
const SAFE_API_503 = Object.freeze({
  error: "Browser smoke: upstream API intentionally unavailable",
  code: "SMOKE_UPSTREAM_DISABLED",
});
const PHONE_ACCOUNT = Object.freeze({
  userId: SMOKE_ACCOUNT_ID,
  authType: "phone",
  phone: FAKE_PHONE,
  maskedPhone: "138****0000",
  maskedContact: "138****0000",
  phoneVerified: true,
  provider: "phone",
  displayName: "Browser Smoke",
  status: "active",
  balance: 0,
  ledger: [],
});
const VALID_DRAFT_SCRIPT = `(() => {
  try {
    sessionStorage.setItem(
      "infiplot:custom",
      JSON.stringify({
        worldSetting: "Browser smoke fictional test",
        styleGuide: "auto",
        audioEnabled: false
      })
    );
  } catch (error) {
    // The page will surface its own recovery UI if storage is unavailable.
  }
})();`;
const CORRUPT_DRAFT_SCRIPT = `(() => {
  try {
    sessionStorage.setItem("infiplot:custom", "{");
  } catch (error) {
    // The page will surface its own recovery UI if storage is unavailable.
  }
})();`;

const API_MOCK_HEADERS = [
  { name: "Content-Type", value: "application/json; charset=utf-8" },
  { name: "Cache-Control", value: "no-store" },
  { name: "X-Aistory-Smoke-Mock", value: "1" },
];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function childExited(child) {
  return (
    !child ||
    child.pid === undefined ||
    child.exitCode !== null ||
    child.signalCode !== null
  );
}

function waitForExit(child, timeoutMs) {
  if (childExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(exited);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const onExit = () => finish(true);
    child.once("exit", onExit);
    if (childExited(child)) finish(true);
  });
}

function pathWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function normalizeLoopbackOrigin(raw) {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error("Origin must be a non-empty loopback URL.");
  }
  let parsed;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error(`Invalid origin URL: ${raw}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Only http(s) loopback origins are allowed: ${parsed.href}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("Origin must not contain credentials.");
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("Origin must not include a path, query, or fragment.");
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new Error(
      `Refusing non-loopback/production origin (${parsed.hostname}); use http://127.0.0.1:4330.`,
    );
  }
  return parsed.origin;
}

function parseCli(argv) {
  let rawOrigin = DEFAULT_ORIGIN;
  let positionalSeen = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      console.log(
        "Usage: node scripts/smoke-play-issue-recovery-browser.mjs [http://127.0.0.1:4330] [--origin=URL]",
      );
      process.exit(0);
    }
    if (argument === "--origin") {
      rawOrigin = argv[index + 1] || "";
      index += 1;
    } else if (argument.startsWith("--origin=")) {
      rawOrigin = argument.slice("--origin=".length);
    } else if (!argument.startsWith("-") && !positionalSeen) {
      rawOrigin = argument;
      positionalSeen = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return normalizeLoopbackOrigin(rawOrigin);
}

function timestampForPath(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function chromeEnvironment() {
  const allowed = [
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "PATH",
    "PATHEXT",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
  ];
  const environment = {
    NO_PROXY: "127.0.0.1,localhost,::1",
    no_proxy: "127.0.0.1,localhost,::1",
  };
  for (const key of allowed) {
    if (typeof process.env[key] === "string") environment[key] = process.env[key];
  }
  return environment;
}

class CdpClient {
  constructor(webSocketUrl, options = {}) {
    const parsed = new URL(webSocketUrl);
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (parsed.protocol !== "ws:" || !LOOPBACK_HOSTS.has(hostname)) {
      throw new Error(`Refusing non-loopback CDP WebSocket: ${webSocketUrl}`);
    }
    this.socket = new WebSocket(parsed);
    this.expectedOrigin = options.expectedOrigin || null;
    this.expectedHost = this.expectedOrigin
      ? new URL(this.expectedOrigin).host
      : null;
    this.onFetchPaused = options.onFetchPaused || null;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.consoleMessages = [];
    this.consoleErrors = 0;
    this.consoleWarnings = 0;
    this.runtimeExceptions = 0;
    this.externalWebSockets = [];
    this.handlerErrors = [];
    this.socket.addEventListener("message", (event) => this.onMessage(event));
    this.socket.addEventListener("close", () => {
      this.closed = true;
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(new Error(`CDP socket closed while waiting for ${pending.method}`));
      }
    });
  }

  async open() {
    await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("Timed out opening CDP WebSocket."));
      }, 15_000);
      this.socket.addEventListener(
        "open",
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      this.socket.addEventListener(
        "error",
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(new Error("CDP WebSocket failed to open."));
        },
        { once: true },
      );
    });
  }

  command(method, params = {}, timeoutMs = 30_000) {
    if (this.closed) {
      return Promise.reject(new Error(`CDP socket is closed; cannot call ${method}`));
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  onMessage(event) {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      this.runtimeExceptions += 1;
      this.consoleMessages.push({
        type: "protocol-error",
        text: "Received non-JSON CDP message.",
      });
      return;
    }

    if (message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(
          new Error(
            `CDP ${pending.method} failed: ${message.error.message || "unknown error"}`,
          ),
        );
      } else {
        pending.resolve(message.result || {});
      }
      return;
    }

    const method = message.method;
    const params = message.params || {};
    if (method === "Fetch.requestPaused") {
      if (this.onFetchPaused) {
        Promise.resolve(this.onFetchPaused(params)).catch((error) => {
          this.handlerErrors.push(`Fetch handler: ${errorMessage(error)}`);
        });
      } else {
        this.command("Fetch.failRequest", {
          requestId: params.requestId,
          errorReason: "BlockedByClient",
        }).catch(() => {});
      }
      return;
    }

    if (method === "Runtime.consoleAPICalled") {
      const type = String(params.type || "log");
      const text = (params.args || [])
        .map((argument) => {
          if (argument && typeof argument.value === "string") return argument.value;
          if (argument && argument.description) return argument.description;
          if (argument && argument.unserializableValue) {
            return argument.unserializableValue;
          }
          return "";
        })
        .filter(Boolean)
        .join(" ")
        .slice(0, 2_000);
      if (type === "error") this.consoleErrors += 1;
      if (type === "warning") this.consoleWarnings += 1;
      this.consoleMessages.push({ type, text });
      if (this.consoleMessages.length > 100) this.consoleMessages.shift();
      return;
    }

    if (method === "Runtime.exceptionThrown") {
      this.runtimeExceptions += 1;
      const details = params.exceptionDetails || {};
      console.error("[smoke runtime exception]", details.exception?.description || details.text);
      this.consoleMessages.push({
        type: "exception",
        text: String(
          details.exception?.description || details.text || "Uncaught page exception",
        ).slice(0, 2_000),
      });
      if (this.consoleMessages.length > 100) this.consoleMessages.shift();
      return;
    }

    if (method === "Log.entryAdded") {
      const entry = params.entry || {};
      const level = String(entry.level || "info");
      const text = String(entry.text || "").slice(0, 2_000);
      if (level === "error") this.consoleErrors += 1;
      if (level === "warning") this.consoleWarnings += 1;
      this.consoleMessages.push({ type: `log-${level}`, text });
      if (this.consoleMessages.length > 100) this.consoleMessages.shift();
      return;
    }

    if (method === "Network.webSocketCreated" && this.expectedHost) {
      try {
        const url = new URL(String(params.url || ""));
        if (
          (url.protocol === "ws:" || url.protocol === "wss:") &&
          url.host !== this.expectedHost
        ) {
          this.externalWebSockets.push(url.href);
        }
      } catch {
        // Ignore malformed diagnostics.
      }
    }
  }

  async evaluate(expression) {
    const result = await this.command("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      const description = String(
        result.exceptionDetails.exception?.description ||
          result.exceptionDetails.text ||
          "unknown exception",
      );
      throw new Error(`Page evaluation failed: ${description.slice(0, 1_000)}`);
    }
    return result.result?.value;
  }

  async waitFor(expression, label, timeoutMs = 120_000) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        if (await this.evaluate(expression)) return;
      } catch (error) {
        lastError = error;
      }
      await delay(200);
    }
    const suffix = lastError ? ` Last error: ${errorMessage(lastError)}` : "";
    throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}.${suffix}`);
  }

  close() {
    this.closed = true;
    try {
      this.socket.close();
    } catch {
      // The page target may already have been closed by Browser.close.
    }
  }
}

class MockController {
  constructor(runtimeOrigin) {
    this.runtimeOrigin = runtimeOrigin;
    this.startRequests = [];
    this.apiMockCounts = new Map();
    this.rejectedExternalCount = 0;
    this.rejectedExternalOrigins = new Set();
    this.rejectedExternalSamples = [];
    this.rejectedSameOriginNonAssetCount = 0;
    this.phoneRequestCount = 0;
    this.phoneVerifyCount = 0;
    this.phoneVerified = false;
  }

  async handle(client, params) {
    const request = params.request || {};
    const requestId = params.requestId;
    let url;
    try {
      url = new URL(String(request.url || ""));
    } catch {
      await this.fail(client, requestId);
      return;
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      await this.fail(client, requestId);
      return;
    }

    if (url.origin !== this.runtimeOrigin) {
      this.rejectedExternalCount += 1;
      this.rejectedExternalOrigins.add(url.origin);
      if (this.rejectedExternalSamples.length < 25) {
        this.rejectedExternalSamples.push({
          method: String(request.method || "GET"),
          url: url.href.slice(0, 500),
        });
      }
      await this.fail(client, requestId);
      return;
    }

    const method = String(request.method || "GET").toUpperCase();
    if (this.isApiPath(url.pathname)) {
      await this.fulfillApi(client, requestId, method, url);
      return;
    }

    if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
      await client.command("Fetch.continueRequest", { requestId });
      return;
    }

    // Same-origin non-asset mutations are not part of this acceptance and must
    // never reach the local backend.
    this.rejectedSameOriginNonAssetCount += 1;
    await this.fail(client, requestId);
  }

  isApiPath(pathname) {
    return pathname === "/api" || pathname.startsWith("/api/");
  }

  normalizedPath(pathname) {
    return pathname.replace(/\/+$/, "") || "/";
  }

  recordApi(method, pathname, status) {
    const key = `${method} ${pathname} ${status}`;
    this.apiMockCounts.set(key, (this.apiMockCounts.get(key) || 0) + 1);
  }

  async fulfillApi(client, requestId, method, url) {
    const pathname = this.normalizedPath(url.pathname);
    let status = 200;
    let body;

    if (pathname === "/api/start") {
      const afterPhoneVerify = this.phoneVerified;
      status = afterPhoneVerify ? 503 : 401;
      body = afterPhoneVerify
        ? SAFE_START_503
        : { error: "Unauthorized" };
      this.startRequests.push({
        sequence: this.startRequests.length + 1,
        method,
        pathname,
        afterPhoneVerify,
        mockStatus: status,
        at: new Date().toISOString(),
      });
    } else if (pathname === "/api/auth/phone/request") {
      this.phoneRequestCount += 1;
      body = {
        challengeId: "smoke",
        maskedPhone: "138****0000",
        retryAfterSeconds: 0,
      };
    } else if (pathname === "/api/auth/phone/verify") {
      this.phoneVerifyCount += 1;
      // The fake account is enabled only for this isolated browser smoke.
      this.phoneVerified = true;
      body = {
        account: {
          userId: SMOKE_ACCOUNT_ID,
        },
      };
    } else if (pathname === "/api/account/me") {
      body = this.phoneVerified
        ? {
            authenticated: true,
            userId: SMOKE_ACCOUNT_ID,
            account: PHONE_ACCOUNT,
            user: { id: SMOKE_ACCOUNT_ID, phone: FAKE_PHONE },
          }
        : { authenticated: false, account: null };
    } else if (pathname === "/api/tts-provider") {
      body = { provider: null };
    } else {
      status = 503;
      body = SAFE_API_503;
    }

    this.recordApi(method, pathname, status);
    await this.fulfill(client, requestId, status, body);
  }

  async fulfill(client, requestId, status, body) {
    await client.command("Fetch.fulfillRequest", {
      requestId,
      responseCode: status,
      responseHeaders: API_MOCK_HEADERS,
      body: Buffer.from(JSON.stringify(body), "utf8").toString("base64"),
    });
  }

  async fail(client, requestId) {
    await client.command("Fetch.failRequest", {
      requestId,
      errorReason: "BlockedByClient",
    });
  }

  report() {
    return {
      runtimeOrigin: this.runtimeOrigin,
      interception: "CDP Fetch.enable({urlPattern:'*'}) before navigation",
      policy: {
        sameOriginAssets: "GET/HEAD/OPTIONS are allowed",
        sameOriginApis: "all /api and /api/* are fulfilled by this mock",
        sameOriginOther: "blocked and counted",
        externalOrigins: "blocked with Fetch.failRequest(BlockedByClient)",
      },
      startRequestCount: this.startRequests.length,
      startRequests: this.startRequests,
      blockedExternalCount: this.rejectedExternalCount,
      blockedExternalOrigins: [...this.rejectedExternalOrigins].sort(),
      blockedExternalSamples: this.rejectedExternalSamples,
      blockedSameOriginNonAssetCount: this.rejectedSameOriginNonAssetCount,
      apiMockCounts: [...this.apiMockCounts.entries()]
        .map(([key, count]) => ({ key, count }))
        .sort((left, right) => left.key.localeCompare(right.key)),
      fakePhoneRequestCount: this.phoneRequestCount,
      fakePhoneVerifyCount: this.phoneVerifyCount,
      fakePhoneVerified: this.phoneVerified,
      credentialsUsed: false,
      realProviderTrafficAllowed: false,
    };
  }
}

async function cdpJson(port, pathname, init = {}) {
  const response = await fetch(new URL(pathname, `http://127.0.0.1:${port}`), {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`CDP HTTP ${pathname} failed with HTTP ${response.status}.`);
  }
  return response.json();
}

async function createPageTarget(port) {
  const target = await cdpJson(
    port,
    `/json/new?${encodeURIComponent("about:blank")}`,
    { method: "PUT" },
  );
  if (
    target.type !== "page" ||
    typeof target.id !== "string" ||
    typeof target.webSocketDebuggerUrl !== "string"
  ) {
    throw new Error("Chrome did not return a valid page target.");
  }
  return target;
}

async function closePageTarget(port, targetId) {
  try {
    await cdpJson(port, `/json/close/${encodeURIComponent(targetId)}`);
  } catch {
    // Closing the page WebSocket can race the target-close response.
  }
}

async function launchChrome() {
  await access(CHROME_EXECUTABLE);
  const profileRoot = await mkdtemp(
    path.join(tmpdir(), "aistory-play-browser-smoke-"),
  );
  let launchError = null;
  const child = spawn(
    CHROME_EXECUTABLE,
    [
      "--headless=new",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      "--remote-allow-origins=*",
      `--user-data-dir=${profileRoot}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--no-proxy-server",
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost, EXCLUDE ::1",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-domain-reliability",
      "--disable-sync",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-client-side-phishing-detection",
      "--disable-breakpad",
      "--disable-crash-reporter",
      "--disable-features=MediaRouter,OptimizationHints,Translate,NetworkTimeServiceQuerying",
      "--disable-gpu",
      "--mute-audio",
      "--autoplay-policy=no-user-gesture-required",
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      "about:blank",
    ],
    {
      env: chromeEnvironment(),
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
    },
  );
  child.once("error", (error) => {
    launchError = error;
  });

  let port = 0;
  let browserWebSocketPath = "";
  try {
    const activePortFile = path.join(profileRoot, "DevToolsActivePort");
    const deadline = Date.now() + 20_000;
    let activePortText = "";
    while (Date.now() < deadline) {
      if (launchError) throw launchError;
      if (childExited(child)) {
        throw new Error(
          `Chrome exited before DevToolsActivePort was available (exit ${child.exitCode ?? "signal"}).`,
        );
      }
      try {
        activePortText = await readFile(activePortFile, "utf8");
      } catch {
        // Chrome has not written the file yet.
      }
      if (activePortText.trim()) break;
      await delay(100);
    }

    const lines = activePortText.trim().split(/\r?\n/);
    port = Number(lines[0]);
    browserWebSocketPath = lines[1] || "";
    if (
      !Number.isInteger(port) ||
      port <= 0 ||
      port > 65_535 ||
      !browserWebSocketPath.startsWith("/devtools/browser/")
    ) {
      throw new Error("Chrome DevToolsActivePort was invalid.");
    }

    const version = await cdpJson(port, "/json/version");
    return {
      child,
      profileRoot,
      port,
      browserWebSocketPath,
      browserVersion: String(version.Browser || "unknown"),
    };
  } catch (error) {
    // launchChrome owns this child/profile until it returns a usable state.
    // Clean it here so a late startup failure cannot leak an orphan browser.
    await stopChrome({ child, profileRoot, port, browserWebSocketPath });
    throw error;
  }
}

async function requestBrowserClose(port, browserWebSocketPath) {
  if (!port || !browserWebSocketPath) return false;
  const client = new CdpClient(
    `ws://127.0.0.1:${port}${browserWebSocketPath}`,
  );
  try {
    await client.open();
    await Promise.race([
      client.command("Browser.close").catch(() => {}),
      delay(1_500),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    client.close();
  }
}

async function removeOwnedProfile(profileRoot) {
  const systemTemp = await realpath(tmpdir());
  const resolved = await realpath(profileRoot);
  if (
    !pathWithin(systemTemp, resolved) ||
    !path.basename(resolved).startsWith("aistory-play-browser-smoke-")
  ) {
    throw new Error("Refusing to remove a profile outside the owned mkdtemp path.");
  }
  await rm(resolved, { recursive: true, force: false, maxRetries: 2, retryDelay: 200 });
}

async function stopChrome(state) {
  const cleanup = {
    browserCloseRequested: false,
    browserClosed: false,
    profileRemoved: false,
    error: null,
  };
  if (!state) {
    cleanup.browserClosed = true;
    cleanup.profileRemoved = true;
    return cleanup;
  }

  try {
    cleanup.browserCloseRequested = await requestBrowserClose(
      state.port,
      state.browserWebSocketPath,
    );
    if (!(await waitForExit(state.child, 5_000))) {
      state.child.kill();
    }
    if (!(await waitForExit(state.child, 3_000))) {
      if (process.platform === "win32") {
        try {
          await execFileAsync(
            "taskkill.exe",
            ["/PID", String(state.child.pid), "/T", "/F"],
            { windowsHide: true, timeout: 10_000 },
          );
        } catch {
          // The owned child may have exited between the wait and taskkill.
        }
      }
    }
    cleanup.browserClosed = await waitForExit(state.child, 3_000);
    if (!cleanup.browserClosed && process.platform !== "win32") {
      state.child.kill("SIGKILL");
      cleanup.browserClosed = await waitForExit(state.child, 3_000);
    }
  } catch (error) {
    cleanup.error = errorMessage(error);
  }

  if (cleanup.browserClosed) {
    try {
      await removeOwnedProfile(state.profileRoot);
      cleanup.profileRemoved = true;
    } catch (error) {
      cleanup.error ||= errorMessage(error);
    }
  }
  return cleanup;
}

async function captureScreenshot(client, evidenceRoot, filename) {
  await delay(200);
  const result = await client.command("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  const bytes = Buffer.from(String(result.data || ""), "base64");
  if (bytes.byteLength === 0) throw new Error("Screenshot returned no bytes.");
  await writeFile(path.join(evidenceRoot, filename), bytes, { flag: "wx" });
  return {
    filename,
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
  };
}

async function readBodyText(client) {
  return String(
    (await client.evaluate(
      "document.body ? (document.body.innerText || document.body.textContent || '') : ''",
    )) || "",
  );
}

async function readPageUrl(client) {
  return String(await client.evaluate("location.href"));
}

async function waitForText(client, expected, label) {
  await client.waitFor(
    `(document.body && ((document.body.innerText || document.body.textContent || '').includes(${JSON.stringify(
      expected,
    )})))`,
    label,
  );
}

async function waitForPredicate(predicate, label, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await delay(200);
  }
  const suffix = lastError ? ` Last error: ${errorMessage(lastError)}` : "";
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}.${suffix}`);
}

async function setNativeInputValue(client, selector, value) {
  const changed = await client.evaluate(`(() => {
    const input = ${selector};
    if (!(input instanceof HTMLInputElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;
    if (!setter) return false;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return input.value === ${JSON.stringify(value)};
  })()`);
  if (!changed) throw new Error(`Could not set native input value for ${selector}.`);
}

async function clickDialogPrimary(client) {
  const clicked = await client.evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
    if (!dialog) return false;
    const button = [...dialog.querySelectorAll("button.ui-button-primary")]
      .find((candidate) => !candidate.disabled);
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!clicked) throw new Error("Could not click the auth dialog primary button.");
}

async function closeAuthDialog(client) {
  const clicked = await client.evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
    if (!dialog) return false;
    const labelled = [...dialog.querySelectorAll("button[aria-label]")];
    const button =
      labelled.find((candidate) => candidate.querySelector("i.fa-xmark")) ||
      labelled[0];
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!clicked) throw new Error("Could not find the auth dialog close button.");
}

async function readStorageKeys(client, storageName) {
  try {
    return await client.evaluate(`(() => {
      try {
        return Object.keys(window[${JSON.stringify(storageName)}]);
      } catch {
        return [];
      }
    })()`);
  } catch {
    return [];
  }
}

async function captureFailure(client, evidenceRoot, label, mock) {
  const diagnostic = {
    label,
    at: new Date().toISOString(),
    url: null,
    title: null,
    readyState: null,
    bodyText: "",
    dialogs: [],
    sessionStorageKeys: [],
    localStorageKeys: [],
    consoleMessages: [],
    consoleErrors: 0,
    runtimeExceptions: 0,
    screenshot: null,
    pageReadError: null,
  };
  if (!client) return diagnostic;

  diagnostic.consoleMessages = client.consoleMessages.slice(-80);
  diagnostic.consoleErrors = client.consoleErrors;
  diagnostic.runtimeExceptions = client.runtimeExceptions;
  diagnostic.fetchHandlerErrors = client.handlerErrors.slice(-20);
  try {
    const page = await client.evaluate(`(() => {
      const text = document.body
        ? (document.body.innerText || document.body.textContent || "")
        : "";
      return {
        url: location.href,
        title: document.title,
        readyState: document.readyState,
        bodyText: text.slice(0, 200_000),
        dialogs: [...document.querySelectorAll('[role="dialog"]')]
          .map((dialog) => (dialog.innerText || dialog.textContent || "").slice(0, 10_000))
      };
    })()`);
    Object.assign(diagnostic, page);
  } catch (error) {
    diagnostic.pageReadError = errorMessage(error);
  }
  diagnostic.sessionStorageKeys = await readStorageKeys(client, "sessionStorage");
  diagnostic.localStorageKeys = await readStorageKeys(client, "localStorage");
  if (mock) {
    diagnostic.startRequests = mock.startRequests.slice(-10);
    diagnostic.blockedExternalCount = mock.rejectedExternalCount;
    diagnostic.blockedExternalSamples = mock.rejectedExternalSamples.slice(-10);
  }
  try {
    diagnostic.screenshot = await captureScreenshot(
      client,
      evidenceRoot,
      `failure-${label}.png`,
    );
  } catch (error) {
    diagnostic.screenshotError = errorMessage(error);
  }
  return diagnostic;
}

async function withFreshPage({
  label,
  initScript,
  evidenceRoot,
  cdpPort,
  runtimeOrigin,
  mock,
}, fn) {
  const target = await createPageTarget(cdpPort);
  let client = null;
  try {
    client = new CdpClient(target.webSocketDebuggerUrl, {
      expectedOrigin: runtimeOrigin,
      onFetchPaused: (params) => mock.handle(client, params),
    });
    await client.open();
    await Promise.all([
      client.command("Page.enable"),
      client.command("Runtime.enable"),
      client.command("Log.enable"),
      client.command("Network.enable"),
    ]);
    await client.command("Network.setCacheDisabled", { cacheDisabled: true });
    await client.command("Network.setBypassServiceWorker", { bypass: true });
    await client.command("Emulation.setDeviceMetricsOverride", {
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      screenWidth: VIEWPORT.width,
      screenHeight: VIEWPORT.height,
      deviceScaleFactor: 1,
      mobile: false,
    });

    // Interception is armed before the first navigation. Any request that is
    // not a same-origin asset or a mocked /api call is rejected at the network
    // layer, including external TTS/provider/SMS traffic.
    await client.command("Fetch.enable", {
      patterns: [{ urlPattern: "*", requestStage: "Request" }],
    });

    if (initScript) {
      await client.command("Page.addScriptToEvaluateOnNewDocument", {
        source: initScript,
      });
    }

    const navigationUrl = new URL(PLAY_PATH, runtimeOrigin).href;
    const navigation = await client.command("Page.navigate", {
      url: navigationUrl,
    });
    if (navigation.errorText) {
      throw new Error(`Navigation failed: ${navigation.errorText}`);
    }

    return await fn(client);
  } catch (error) {
    const diagnostic = await captureFailure(client, evidenceRoot, label, mock);
    const wrapped = new Error(`${label}: ${errorMessage(error)}`);
    wrapped.diagnostic = diagnostic;
    throw wrapped;
  } finally {
    if (client) client.close();
    await closePageTarget(cdpPort, target.id);
  }
}

async function scenarioA6Missing({
  evidenceRoot,
  cdpPort,
  runtimeOrigin,
  mock,
}) {
  const startsBefore = mock.startRequests.length;
  const externalBefore = mock.rejectedExternalCount;
  const state = await withFreshPage(
    {
      label: "a6-missing-draft",
      initScript: null,
      evidenceRoot,
      cdpPort,
      runtimeOrigin,
      mock,
    },
    async (client) => {
      await waitForText(
        client,
        CUSTOM_DRAFT_TITLE_ZH,
        "A6 missing-draft recovery title",
      );
      await waitForText(
        client,
        CUSTOM_DRAFT_MISSING_NOTE_ZH,
        "A6 missing-draft recovery note",
      );
      await delay(700);

      const body = await readBodyText(client);
      const pageUrl = await readPageUrl(client);
      const parsedUrl = new URL(pageUrl);
      if (parsedUrl.origin !== runtimeOrigin) {
        throw new Error(`Unexpected recovery origin: ${parsedUrl.origin}`);
      }
      if (!parsedUrl.pathname.endsWith("/play")) {
        throw new Error(`The recovery screen navigated away from /play: ${parsedUrl.pathname}`);
      }
      if (parsedUrl.searchParams.get("custom") !== "1") {
        throw new Error("The recovery screen no longer retains custom=1.");
      }
      if (!body.includes(CUSTOM_DRAFT_MISSING_NOTE_ZH)) {
        throw new Error("Missing-draft recovery note is not visible.");
      }
      const startCount = mock.startRequests.length - startsBefore;
      if (startCount !== 0) {
        throw new Error(`A6 missing draft issued ${startCount} /api/start call(s).`);
      }
      const screenshot = await captureScreenshot(
        client,
        evidenceRoot,
        "a6-missing-draft.png",
      );
      return {
        name: "A6_missing_custom_draft",
        status: "PASS",
        url: pageUrl,
        retainsCustomQuery: true,
        recoveryTitleExact: true,
        recoveryNoteExact: true,
        startCount,
        blockedExternalCount:
          mock.rejectedExternalCount - externalBefore,
        screenshot,
        sessionStorageKeys: await readStorageKeys(client, "sessionStorage"),
        consoleErrors: client.consoleErrors,
        runtimeExceptions: client.runtimeExceptions,
      };
    },
  );
  return state;
}

async function scenarioA6Corrupt({
  evidenceRoot,
  cdpPort,
  runtimeOrigin,
  mock,
}) {
  const startsBefore = mock.startRequests.length;
  const externalBefore = mock.rejectedExternalCount;
  const state = await withFreshPage(
    {
      label: "a6-corrupt-draft",
      initScript: CORRUPT_DRAFT_SCRIPT,
      evidenceRoot,
      cdpPort,
      runtimeOrigin,
      mock,
    },
    async (client) => {
      await waitForText(
        client,
        CUSTOM_DRAFT_TITLE_ZH,
        "A6 corrupt-draft recovery title",
      );
      await waitForText(
        client,
        CUSTOM_DRAFT_MALFORMED_NOTE_ZH,
        "A6 corrupt-draft parse-failure notice",
      );
      await delay(700);

      const body = await readBodyText(client);
      const pageUrl = await readPageUrl(client);
      const storageValue = await client.evaluate(
        `sessionStorage.getItem("infiplot:custom")`,
      );
      if (storageValue !== "{") {
        throw new Error(`Corrupt draft storage probe returned ${JSON.stringify(storageValue)}.`);
      }
      if (!body.includes(CUSTOM_DRAFT_MALFORMED_NOTE_ZH)) {
        throw new Error("Malformed-draft parse-failure notice is not visible.");
      }
      const startCount = mock.startRequests.length - startsBefore;
      if (startCount !== 0) {
        throw new Error(`A6 corrupt draft issued ${startCount} /api/start call(s).`);
      }
      const screenshot = await captureScreenshot(
        client,
        evidenceRoot,
        "a6-corrupt-draft.png",
      );
      return {
        name: "A6_corrupt_custom_draft",
        status: "PASS",
        url: pageUrl,
        corruptDraftRetained: storageValue === "{",
        parseFailureNoticeExact: true,
        startCount,
        blockedExternalCount:
          mock.rejectedExternalCount - externalBefore,
        screenshot,
        consoleErrors: client.consoleErrors,
        runtimeExceptions: client.runtimeExceptions,
      };
    },
  );
  return state;
}

async function scenarioA2FirstLoadAuth({
  evidenceRoot,
  cdpPort,
  runtimeOrigin,
  mock,
}) {
  const startsBefore = mock.startRequests.length;
  const externalBefore = mock.rejectedExternalCount;
  const phoneRequestsBefore = mock.phoneRequestCount;
  const phoneVerifyBefore = mock.phoneVerifyCount;
  return withFreshPage(
    {
      label: "a2-first-load-auth",
      initScript: VALID_DRAFT_SCRIPT,
      evidenceRoot,
      cdpPort,
      runtimeOrigin,
      mock,
    },
    async (client) => {
      await waitForPredicate(
        () => mock.startRequests.length === startsBefore + 1,
        "first /api/start attempt",
      );
      await client.waitFor(
        `Boolean(document.querySelector('[role="dialog"][aria-modal="true"]'))`,
        "first-load auth dialog",
      );
      const dialogScreenshot = await captureScreenshot(
        client,
        evidenceRoot,
        "a2-auth-dialog.png",
      );

      await closeAuthDialog(client);
      await client.waitFor(
        `!document.querySelector('[role="dialog"][aria-modal="true"]')`,
        "auth dialog close",
      );
      await waitForText(
        client,
        AUTH_PAUSED_TITLE_ZH,
        "A2 paused recovery title",
      );

      const pausedBody = await readBodyText(client);
      if (/100\s*[%％]/.test(pausedBody)) {
        throw new Error("The paused recovery screen rendered 100% progress.");
      }
      if (pausedBody.includes("Unauthorized")) {
        throw new Error("The paused recovery screen rendered raw Unauthorized text.");
      }
      const startAfterClose = mock.startRequests.length - startsBefore;
      if (startAfterClose !== 1) {
        throw new Error(`Closing the auth dialog changed start count to ${startAfterClose}.`);
      }
      await delay(1_000);
      const startAfterWait = mock.startRequests.length - startsBefore;
      if (startAfterWait !== 1) {
        throw new Error(`Dismissing login retriggered /api/start (${startAfterWait} calls).`);
      }
      const pausedScreenshot = await captureScreenshot(
        client,
        evidenceRoot,
        "a2-auth-paused.png",
      );

      await client.waitFor(
        `(() => [...document.querySelectorAll("button")].some(
          (button) => (button.textContent || "").includes(${JSON.stringify(
            AUTH_REOPEN_LOGIN_ZH,
          )})
        ))()`,
        "reopen-login button",
      );
      const reopened = await client.evaluate(`(() => {
        const button = [...document.querySelectorAll("button")].find(
          (candidate) => (candidate.textContent || "").includes(${JSON.stringify(
            AUTH_REOPEN_LOGIN_ZH,
          )})
        );
        if (!button) return false;
        button.click();
        return true;
      })()`);
      if (!reopened) throw new Error("Could not reopen the auth dialog.");

      await client.waitFor(
        `Boolean(document.querySelector('[role="dialog"] input[type="tel"]'))`,
        "phone input",
      );
      await setNativeInputValue(
        client,
        `document.querySelector('[role="dialog"] input[type="tel"]')`,
        FAKE_PHONE,
      );
      await client.waitFor(
        `(() => {
          const dialog = document.querySelector('[role="dialog"]');
          if (!dialog) return false;
          const phone = dialog.querySelector('input[type="tel"]');
          const button = [...dialog.querySelectorAll("button.ui-button-primary")]
            .find((candidate) => !candidate.disabled);
          return Boolean(phone && phone.value === ${JSON.stringify(FAKE_PHONE)} && button);
        })()`,
        "enabled send-code button",
      );
      await clickDialogPrimary(client);

      await client.waitFor(
        `Boolean(document.querySelector('[role="dialog"] input[inputmode="numeric"]'))`,
        "OTP input after mocked phone request",
      );
      await setNativeInputValue(
        client,
        `document.querySelector('[role="dialog"] input[inputmode="numeric"]')`,
        FAKE_OTP,
      );
      await client.waitFor(
        `(() => {
          const dialog = document.querySelector('[role="dialog"]');
          if (!dialog) return false;
          const otp = dialog.querySelector('input[inputmode="numeric"]');
          const button = [...dialog.querySelectorAll("button.ui-button-primary")]
            .find((candidate) => !candidate.disabled);
          return Boolean(otp && otp.value === ${JSON.stringify(FAKE_OTP)} && button);
        })()`,
        "enabled verify button",
      );
      await clickDialogPrimary(client);

      await client.waitFor(
        `(() => {
          const dialog = document.querySelector('[role="dialog"]');
          return Boolean(
            dialog &&
            !dialog.querySelector("input") &&
            [...dialog.querySelectorAll("button.ui-button-primary")]
              .some((button) => !button.disabled)
          );
        })()`,
        "claim-result continue screen",
      );
      const claimScreenshot = await captureScreenshot(
        client,
        evidenceRoot,
        "a2-claim-result.png",
      );
      await clickDialogPrimary(client);

      await waitForPredicate(
        () => mock.startRequests.length >= startsBefore + 2,
        "single post-login /api/start retry",
      );
      await waitForText(
        client,
        SAFE_START_503.error,
        "controlled 503 after the single auth retry",
      );
      await delay(1_000);

      const starts = mock.startRequests.slice(startsBefore);
      if (starts.length !== 2) {
        throw new Error(`Expected exactly 2 /api/start attempts, observed ${starts.length}.`);
      }
      if (starts[0]?.mockStatus !== 401 || starts[1]?.mockStatus !== 503) {
        throw new Error(
          `Unexpected start mock statuses: ${starts.map((item) => item.mockStatus).join(",")}.`,
        );
      }
      if (mock.phoneRequestCount - phoneRequestsBefore !== 1) {
        throw new Error("Expected exactly one mocked phone OTP request.");
      }
      if (mock.phoneVerifyCount - phoneVerifyBefore !== 1) {
        throw new Error("Expected exactly one mocked phone OTP verify.");
      }

      const finalBody = await readBodyText(client);
      if (finalBody.includes("Unauthorized")) {
        throw new Error("The final page rendered raw Unauthorized text.");
      }
      const finalScreenshot = await captureScreenshot(
        client,
        evidenceRoot,
        "a2-after-login-retry.png",
      );

      return {
        name: "A2_first_load_auth_required",
        status: "PASS",
        url: await readPageUrl(client),
        initialStartCount: 1,
        startsAfterDismiss: 1,
        totalStartCount: starts.length,
        startStatuses: starts.map((item) => item.mockStatus),
        postLoginRetryExactlyOnce: starts.length === 2,
        pausedScreen: {
          titleExact: true,
          no100Percent: !/100\s*[%％]/.test(pausedBody),
          noRawUnauthorized: !pausedBody.includes("Unauthorized"),
        },
        authDialog: {
          closedWithRenderedCloseButton: true,
          reopenedFromPausedButton: true,
          phoneInputSetWithNativeSetter: true,
          otpInputSetWithNativeSetter: true,
          mockedPhoneRequestCount: 1,
          mockedPhoneVerifyCount: 1,
        },
        finalScreen: {
          safe503NoticeExact: true,
          noRawUnauthorized: true,
          noAuthDialog: !(await client.evaluate(
            `Boolean(document.querySelector('[role="dialog"]'))`,
          )),
        },
        blockedExternalCount:
          mock.rejectedExternalCount - externalBefore,
        screenshots: {
          authDialog: dialogScreenshot,
          paused: pausedScreenshot,
          claim: claimScreenshot,
          afterRetry: finalScreenshot,
        },
        consoleErrors: client.consoleErrors,
        runtimeExceptions: client.runtimeExceptions,
        externalWebSockets: client.externalWebSockets.slice(-10),
      };
    },
  );
}

async function writeEvidenceResult(evidenceRoot, report) {
  const resultFile = path.join(
    evidenceRoot,
    "play-issue-recovery-browser-smoke.json",
  );
  await writeFile(resultFile, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  return resultFile;
}

async function main() {
  const runtimeOrigin = parseCli(process.argv.slice(2));
  const startedAt = new Date();
  const evidenceRoot = path.join(
    EVIDENCE_PARENT,
    `play-browser-${timestampForPath(startedAt)}`,
  );
  await mkdir(evidenceRoot, { recursive: true });

  if (typeof WebSocket !== "function") {
    throw new Error("This smoke requires Node's global WebSocket implementation.");
  }

  let chromeState = null;
  let mock = null;
  let resultFile = null;
  const scenarios = [];
  let failure = null;
  const report = {
    schema: "aistory-play-issue-recovery-browser-smoke",
    schemaVersion: 1,
    status: "FAIL",
    evidenceLevel:
      "LOCAL_CHROMIUM_DOM_ACCEPTANCE_WITH_CDP_NETWORK_INTERCEPTION_ONLY",
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    origin: runtimeOrigin,
    route: PLAY_PATH,
    viewport: VIEWPORT,
    browser: null,
    coveredScenarios: [],
    scenarios,
    a3: {
      status: "not_covered",
      covered: false,
      reason:
        "Optional authored-locked/local-media scenario was intentionally omitted; no controlled authored media fixture was added. This is not a pass.",
    },
    network: null,
    cleanup: null,
    failure: null,
    limitations: [
      "Runs only against a loopback Next dev origin; production and non-loopback origins are refused.",
      "All backend behavior is mocked at CDP Fetch; no real provider, SMS, account, billing, or TTS traffic is allowed.",
      "The first /api/start is a mocked 401 {error:'Unauthorized'}; after the fake phone verify, /api/start is a controlled 503 to prevent further retries.",
      "Phone number and OTP are fixed fake values; real credentials and sessions are never used.",
      "A3 (authored-locked / cached local media) is not covered and must not be reported as passed.",
      "Screenshots are local DOM evidence only; this is not a visual-regression or production-readiness check.",
    ],
  };

  try {
    chromeState = await launchChrome();
    report.browser = {
      executable: CHROME_EXECUTABLE,
      version: chromeState.browserVersion,
      isolatedProfile: true,
      profileRoot: chromeState.profileRoot,
      remoteDebuggingPort: 0,
      discoveredCdpPort: chromeState.port,
    };
    mock = new MockController(runtimeOrigin);
    console.log(`[smoke] Chrome ready on loopback CDP port ${chromeState.port}`);
    console.log(`[smoke] Evidence: ${evidenceRoot}`);

    console.log("[smoke] A6 missing custom draft...");
    scenarios.push(
      await scenarioA6Missing({
        evidenceRoot,
        cdpPort: chromeState.port,
        runtimeOrigin,
        mock,
      }),
    );

    console.log("[smoke] A6 corrupt custom draft...");
    scenarios.push(
      await scenarioA6Corrupt({
        evidenceRoot,
        cdpPort: chromeState.port,
        runtimeOrigin,
        mock,
      }),
    );

    console.log("[smoke] A2 first-load auth-required recovery...");
    scenarios.push(
      await scenarioA2FirstLoadAuth({
        evidenceRoot,
        cdpPort: chromeState.port,
        runtimeOrigin,
        mock,
      }),
    );

    report.coveredScenarios = scenarios.map((scenario) => scenario.name);
    report.status = "PASS";
  } catch (error) {
    failure = {
      label: error?.diagnostic?.label || "setup",
      message: errorMessage(error),
      diagnostic: error?.diagnostic || null,
    };
    report.status = "FAIL";
    console.error(`[smoke] FAIL: ${errorMessage(error)}`);
  } finally {
    report.coveredScenarios = scenarios.map((scenario) => scenario.name);
    report.network = mock
      ? mock.report()
      : {
          runtimeOrigin,
          interception: "not_started",
          startRequestCount: 0,
          startRequests: [],
          blockedExternalCount: 0,
        };
    report.failure = failure;
    const cleanup = await stopChrome(chromeState);
    report.cleanup = cleanup;
    if (!failure && !cleanup.browserClosed) {
      report.status = "FAIL";
      report.failure = {
        message: "The owned Chrome child did not exit during cleanup.",
        diagnostic: null,
      };
    }
    report.finishedAt = new Date().toISOString();
    resultFile = await writeEvidenceResult(evidenceRoot, report);
  }

  if (report.status !== "PASS") {
    console.error(`[smoke] Evidence JSON: ${resultFile}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `[smoke] PASS: A6 missing/corrupt draft recovery + A2 auth-required recovery`,
  );
  console.log(`[smoke] JSON: ${resultFile}`);
  console.log("[smoke] A3 is NOT COVERED by this script.");
}

await main();
