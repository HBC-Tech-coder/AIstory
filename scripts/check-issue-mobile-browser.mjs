import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
// No hardcoded user-specific paths: evidence is opt-in via env or a temp dir,
// and Chromium comes from env or the local Playwright install of this machine.
const evidenceRoot =
  process.env.AISTORY_ISSUE_EVIDENCE_DIR ||
  path.join(tmpdir(), "aistory-issue-mobile-browser-evidence");
const candidateOrigin = "http://127.0.0.1:4330";
let chromeExecutable = null;
let chromeExecutableError = null;
try {
  if (process.env.AISTORY_CHROME_EXECUTABLE) {
    chromeExecutable = process.env.AISTORY_CHROME_EXECUTABLE;
  } else if (process.env.LOCALAPPDATA) {
    chromeExecutable = path.join(
      process.env.LOCALAPPDATA,
      "ms-playwright",
      "chromium_headless_shell-1228",
      "chrome-headless-shell-win64",
      "chrome-headless-shell.exe",
    );
  } else {
    chromeExecutableError =
      "LOCALAPPDATA is not set and AISTORY_CHROME_EXECUTABLE is absent; set AISTORY_CHROME_EXECUTABLE to a chrome-headless-shell executable path";
  }
} catch (error) {
  chromeExecutableError = String(error && error.message ? error.message : error);
}
const localVideoPath = path.join(
  repoRoot,
  "public",
  "case-studies",
  "world-model-little-chef",
  "assets",
  "demo.mp4",
);
const VIEWPORTS = Object.freeze([
  { width: 390, height: 844 },
  { width: 390, height: 420 },
]);
const WAIT_MS = 25_000;
const LOOPBACK_HOSTS = new Set([
  "127.0.0.1",
  "localhost",
  "::1",
  "[::1]",
  "0:0:0:0:0:0:0:1",
]);
const LONG_TEXT =
  "这是移动端验收使用的长文本输入，用于确认创作页面在窄屏和短屏下仍然可以滚动、聚焦并完整输入内容。".repeat(
    4,
  ) + "验收长文本结束标记-OK";
// Catalog outcome prefixes for the apple-dessert choice. A passing local
// outcome must reveal real catalog text, never just any DOM mutation.
const EXPECTED_OUTCOME_PREFIXES = Object.freeze([
  "你切好苹果",
  "小厨师认真守在烤箱前",
]);
const OUTCOME_WAIT_MS = 10_000;
// If the typewriter is still holding on audio after this, one click on the
// narration card completes it (the player's own skip behavior).
const OUTCOME_NARRATION_CLICK_MS = 3_000;
const runStamp = new Date().toISOString().replace(/[:.]/g, "-");
const report = {
  schemaVersion: 1,
  scenario: "issue-mobile-browser-acceptance",
  startedAt: new Date().toISOString(),
  candidateOrigin,
  chromium: {
    executable: chromeExecutable,
    executableError: chromeExecutableError,
    executableSource: chromeExecutable
      ? process.env.AISTORY_CHROME_EXECUTABLE
        ? "AISTORY_CHROME_EXECUTABLE"
        : "LOCALAPPDATA/ms-playwright/chromium_headless_shell-1228"
      : null,
    headlessShell: true,
  },
  viewports: VIEWPORTS,
  limits: {
    waitMs: WAIT_MS,
    keyboard: "focus + Input.insertText only; no real OS keyboard",
    fullscreen: "headless shell fullscreen may be unsupported; recorded, never passed silently",
  },
  checks: [],
  failures: [],
  blockers: [],
  blockedRequests: [],
  pageErrors: [],
  b7: [],
  a8: [],
  media: null,
  networkPolicy: {
    allowedOrigin: candidateOrigin,
    allowedMethods: ["GET", "HEAD", "OPTIONS"],
    blockedMethods: ["POST", "PUT", "PATCH", "DELETE"],
    external: "disabled via Fetch interception",
    websockets: "ws/wss blocked via Network.setBlockedURLs",
  },
  outcomeProof: {
    expectedPrefixes: [...EXPECTED_OUTCOME_PREFIXES],
    waitMs: OUTCOME_WAIT_MS,
  },
  cleanupPolicy: "owned process tree killed; temporary profile retained, never recursively deleted",
  cleanup: null,
};

const HELPERS = `(() => {
  if (window.__acc) return;
  const vis = (el) => {
    if (!(el instanceof Element)) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && r.bottom > 0 && r.top < innerHeight;
  };
  const txt = (el) => ((el.innerText || el.textContent || '')).replace(/\\s+/g, '');
  const clickable = (label) => {
    const nodes = [...document.querySelectorAll('button,a,[role="button"],[role="link"],[role="tab"],label')];
    const visible = nodes.filter(vis);
    return visible.find((el) => txt(el) === label || txt(el).includes(label) || String(el.getAttribute('aria-label') || '').includes(label)) || null;
  };
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
  };
  const scrollParent = (el) => {
    let p = el.parentElement;
    while (p && p !== document.body) {
      const s = getComputedStyle(p);
      if (/(auto|scroll)/.test(s.overflowY) && p.scrollHeight > p.clientHeight + 1) return p;
      p = p.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  };
  const reveal = (el, limit) => {
    const sp = scrollParent(el);
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    let r = el.getBoundingClientRect();
    if (r.bottom > limit - 1) sp.scrollTop += r.bottom - (limit - 4);
    r = el.getBoundingClientRect();
    if (r.top < 1) sp.scrollTop += r.top - 4;
    return { scrollTop: Math.round(sp.scrollTop), scroller: sp.tagName };
  };
  const hit = (el) => {
    const r = el.getBoundingClientRect();
    const x = Math.min(innerWidth - 1, Math.max(1, r.left + r.width / 2));
    const y = Math.min(innerHeight - 1, Math.max(1, r.top + r.height / 2));
    const h = document.elementFromPoint(x, y);
    return { x, y, hitTag: h ? h.tagName : null, hit: !!h && (h === el || el.contains(h)) };
  };
  const fullyAbove = (el, limit) => {
    const r = el.getBoundingClientRect();
    return r.top >= -0.5 && r.bottom <= limit + 0.5 && r.left >= -0.5 && r.right <= innerWidth + 0.5;
  };
  const bottomNav = () => {
    const navs = [...document.querySelectorAll('nav')].filter(vis);
    let pool = navs.filter((n) => txt(n).includes('创作'));
    if (!pool.length) pool = navs;
    if (!pool.length) {
      let el = clickable('创作');
      while (el && el !== document.body) {
        const s = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        if ((s.position === 'fixed' || s.position === 'sticky') && r.bottom > innerHeight * 0.6 && r.width > innerWidth * 0.5) return el;
        el = el.parentElement;
      }
      return null;
    }
    pool.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
    return pool[0];
  };
  const navCreate = () => {
    const nav = bottomNav();
    if (nav) {
      const nodes = [...nav.querySelectorAll('button,a,[role="button"],[role="link"],[role="tab"],label')].filter(vis);
      const el = nodes.find((item) => txt(item) === '创作' || txt(item).includes('创作') || String(item.getAttribute('aria-label') || '').includes('创作'));
      if (el) return el;
    }
    return clickable('创作');
  };
  const subtitle = () => {
    const known = ['[data-video-subtitle]','[data-subtitle-overlay]','[data-video-subtitle-overlay]','[data-video-captions]','[data-captions-overlay]'];
    const nodes = known.flatMap((sel) => [...document.querySelectorAll(sel)]);
    const beat = document.querySelector('[data-video-beat-overlay="true"]');
    const live = [...document.querySelectorAll('[aria-live="polite"]')].filter((el) => !(beat && beat.contains(el)));
    for (const el of [...nodes, ...live]) {
      if (vis(el) && txt(el).length > 0) return { present: true, text: txt(el).slice(0, 120), tag: el.tagName };
    }
    const v = document.querySelector('video');
    const active = v ? [...v.textTracks].filter((t) => t.mode === 'showing' && (t.activeCues?.length || 0) > 0).length : 0;
    return { present: active > 0, text: '', activeCueTracks: active };
  };
  window.__acc = { vis, txt, clickable, rect, reveal, hit, fullyAbove, bottomNav, navCreate, subtitle, scrollParent };
})();`;

// Injected into the page for A8. Resolves the beat overlay's scrollport by
// computed overflow-y only (auto/scroll), never by requiring actual overflow;
// short scenes with fitting content are still valid scrollports.
const SCROLLPORT_RESOLVER = `function resolveScrollport() {
  const beat = document.querySelector('[data-video-beat-overlay="true"]');
  if (!beat) return { found: false, reason: 'beat_missing' };
  const auto = (el) => /(auto|scroll)/.test(getComputedStyle(el).overflowY);
  let el = null;
  let source = null;
  if (auto(beat)) {
    el = beat;
    source = 'beat';
  } else {
    let p = beat.parentElement;
    while (p && p !== document.body) {
      if (auto(p)) {
        el = p;
        source = 'ancestor';
        break;
      }
      p = p.parentElement;
    }
  }
  if (!el) {
    return { found: false, reason: 'no_auto_scrollport', beatOverflowY: getComputedStyle(beat).overflowY };
  }
  return {
    found: true,
    source,
    el,
    tag: el.tagName,
    className: String(el.className || '').slice(0, 140),
    overflowY: getComputedStyle(el).overflowY,
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    overflowExtent: Math.max(0, el.scrollHeight - el.clientHeight),
    maxScrollTop: Math.max(0, el.scrollHeight - el.clientHeight)
  };
}`;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageOf(error) {
  return String(error && error.message ? error.message : error).slice(0, 500);
}

function redactUrl(raw) {
  try {
    const parsed = new URL(String(raw));
    parsed.username = "";
    parsed.password = "";
    if (parsed.search) parsed.search = "?redacted";
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search}`;
  } catch {
    return String(raw)
      .replace(/\/\/[^/@\s]+@/g, "//<redacted>@")
      .slice(0, 300);
  }
}

function isCandidateUrl(raw) {
  try {
    return new URL(String(raw)).origin === candidateOrigin;
  } catch {
    return false;
  }
}

function recordCheck(name, pass, detail = null) {
  const entry = { name, pass: Boolean(pass), detail };
  report.checks.push(entry);
  if (!pass) report.failures.push({ name, detail });
  return entry.pass;
}

function requireCheck(name, pass, detail = null) {
  if (!recordCheck(name, pass, detail)) throw new Error(name);
}

async function screenshot(client, filename, row) {
  const result = await client.command("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  const bytes = Buffer.from(result.data, "base64");
  const file = path.join(evidenceRoot, filename);
  await writeFile(file, bytes);
  row.screenshots.push({ filename, bytes: bytes.byteLength });
  return file;
}

// Reset candidate-origin demo state before a fresh scenario navigation. This
// only ever touches the runner's own temporary Chromium profile (a fresh,
// isolated test browser), never a developer's real browser or profile.
async function clearCandidateStorage(client) {
  const detail = {
    origin: candidateOrigin,
    methods: [],
    runtime: null,
    storageClear: null,
    errors: [],
  };
  let onCandidateOrigin = false;
  try {
    onCandidateOrigin = await client.evaluate(
      `location.origin === ${JSON.stringify(candidateOrigin)}`,
    );
  } catch {
    onCandidateOrigin = false;
  }
  if (onCandidateOrigin) {
    try {
      detail.runtime = await client.evaluate(`(() => {
        const before = { localStorageKeys: localStorage.length, sessionStorageKeys: sessionStorage.length };
        localStorage.clear();
        sessionStorage.clear();
        return { origin: location.origin, ...before, localStorageKeysAfter: localStorage.length, sessionStorageKeysAfter: sessionStorage.length };
      })()`);
      detail.methods.push(
        "Runtime.evaluate localStorage.clear()+sessionStorage.clear()",
      );
    } catch (error) {
      detail.errors.push(`runtime:${messageOf(error)}`);
    }
  }
  try {
    const storageTypes = "local_storage,indexeddb,websql,cache_storage";
    await client.command("Storage.clearDataForOrigin", {
      origin: candidateOrigin,
      storageTypes,
    });
    detail.storageClear = {
      origin: candidateOrigin,
      storageTypes,
      scope: "isolated_test_browser_profile_only",
    };
    detail.methods.push("Storage.clearDataForOrigin");
  } catch (error) {
    detail.errors.push(`storage:${messageOf(error)}`);
  }
  return detail;
}

class CdpClient {
  constructor(webSocketUrl, origin) {
    const parsed = new URL(webSocketUrl);
    if (parsed.protocol !== "ws:" || !LOOPBACK_HOSTS.has(parsed.hostname)) {
      throw new Error("cdp_websocket_not_loopback");
    }
    this.origin = origin;
    this.socket = new WebSocket(parsed);
    this.nextId = 1;
    this.pending = new Map();
    this.requests = [];
    this.blocked = [];
    this.pageErrors = [];
    this.mutationBlockedCount = 0;
    this.externalBlockedCount = 0;
    this.localMediaFallback = false;
    this.localMediaBytes = null;
    this.mockFulfilled = 0;
    this.mockedUrls = [];
    this.socket.addEventListener("message", (event) => this.onMessage(event));
    this.socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error("cdp_closed"));
      }
      this.pending.clear();
    });
  }

  async open() {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("cdp_open_timeout")), 10_000);
      this.socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      this.socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("cdp_open_failed"));
        },
        { once: true },
      );
    });
  }

  command(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async evaluate(expression) {
    const result = await this.command("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      const description =
        result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        "evaluation_failed";
      throw new Error(String(description).slice(0, 400));
    }
    return result.result?.value;
  }

  async waitFor(expression, label, timeoutMs = WAIT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        if (await this.evaluate(expression)) return;
      } catch {
        // Execution contexts are destroyed during navigation; keep polling.
      }
      await delay(150);
    }
    throw new Error(label);
  }

  classify(rawUrl, method) {
    let parsed;
    try {
      parsed = new URL(String(rawUrl));
    } catch {
      return { allowed: false, reason: "invalid_url" };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { allowed: false, reason: "non_http" };
    }
    if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
      return { allowed: false, reason: "non_loopback" };
    }
    // Exact candidate origin only: http://127.0.0.1:4330. Other loopback
    // ports/hosts and every external origin stay blocked.
    if (parsed.origin !== candidateOrigin) {
      return { allowed: false, reason: "non_candidate_origin" };
    }
    // All mutating methods are blocked so no account/generation state can be
    // changed even on the candidate origin.
    if (!["GET", "HEAD", "OPTIONS"].includes(String(method).toUpperCase())) {
      return { allowed: false, reason: "mutation_method" };
    }
    return { allowed: true, reason: null };
  }

  async onPaused(params) {
    const request = params.request || {};
    const url = String(request.url || "");
    const method = String(request.method || "GET");
    if (
      this.localMediaFallback &&
      ["GET", "HEAD"].includes(method.toUpperCase()) &&
      isCandidateUrl(url) &&
      /\.mp4(?:$|\?)/i.test(url)
    ) {
      try {
        await this.fulfillLocalMedia(params);
        return;
      } catch (error) {
        this.pageErrors.push({
          kind: "local_media_mock_failed",
          text: messageOf(error),
        });
      }
    }
    const decision = this.classify(url, method);
    if (decision.allowed) {
      await this.command("Fetch.continueRequest", {
        requestId: params.requestId,
      }).catch(() => {});
      return;
    }
    if (decision.reason === "mutation_method") this.mutationBlockedCount += 1;
    if (decision.reason === "non_loopback") this.externalBlockedCount += 1;
    this.blocked.push({
      url: redactUrl(url),
      method,
      reason: decision.reason,
      at: new Date().toISOString(),
    });
    if (this.blocked.length > 200) this.blocked.shift();
    await this.command("Fetch.failRequest", {
      requestId: params.requestId,
      errorReason: "BlockedByClient",
    }).catch(() => {});
  }

  async fulfillLocalMedia(params) {
    if (!this.localMediaBytes) {
      this.localMediaBytes = await readFile(localVideoPath);
    }
    this.mockFulfilled += 1;
    this.mockedUrls.push(redactUrl(params.request.url));
    await this.command("Fetch.fulfillRequest", {
      requestId: params.requestId,
      responseCode: 200,
      responseHeaders: [
        { name: "Content-Type", value: "video/mp4" },
        { name: "Cache-Control", value: "no-store" },
      ],
      body: this.localMediaBytes.toString("base64"),
    });
  }

  onMessage(event) {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error(
            `${message.error.code || ""} ${message.error.message || "cdp_error"}`.trim(),
          ),
        );
      } else {
        pending.resolve(message.result || {});
      }
      return;
    }
    if (message.method === "Fetch.requestPaused") {
      void this.onPaused(message.params || {}).catch((error) => {
        this.pageErrors.push({
          kind: "fetch_interception_failed",
          text: messageOf(error),
        });
      });
      return;
    }
    if (message.method === "Runtime.exceptionThrown") {
      const details = message.params?.exceptionDetails;
      this.pageErrors.push({
        kind: "exception",
        text: String(
          details?.exception?.description || details?.text || "",
        ).slice(0, 500),
      });
    } else if (message.method === "Log.entryAdded") {
      const entry = message.params?.entry || {};
      if (entry.level === "error" || entry.level === "warning") {
        this.pageErrors.push({
          kind: "log",
          level: entry.level,
          text: String(entry.text || "").slice(0, 500),
        });
      }
    } else if (message.method === "Runtime.consoleAPICalled") {
      if (message.params?.type === "error") {
        this.pageErrors.push({
          kind: "console",
          text: (message.params.args || [])
            .map((arg) => String(arg.value ?? arg.description ?? ""))
            .join(" ")
            .slice(0, 500),
        });
      }
    } else if (message.method === "Network.loadingFailed") {
      this.pageErrors.push({
        kind: "loadingFailed",
        error: String(message.params?.errorText || "").slice(0, 200),
        blockedReason: message.params?.blockedReason || null,
      });
    } else if (message.method === "Network.webSocketCreated") {
      this.pageErrors.push({
        kind: "websocket",
        url: redactUrl(message.params?.url || ""),
      });
    } else if (message.method === "Network.requestWillBeSent") {
      this.requests.push({
        url: redactUrl(message.params?.request?.url || ""),
        method: message.params?.request?.method || "",
        type: message.params?.type || "",
      });
    }
  }

  close() {
    try {
      this.socket.close();
    } catch {
      // Closing an already-closed socket is harmless.
    }
  }
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`http_${response.status}`);
  return response.json();
}

async function launchChrome(profileDir) {
  const args = [
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    "--remote-allow-origins=*",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-sync",
    "--disable-breakpad",
    "--metrics-recording-only",
    "--no-first-run",
    "--no-default-browser-check",
    "--password-store=basic",
    "--use-mock-keychain",
    "--autoplay-policy=no-user-gesture-required",
    "--mute-audio",
    "--window-size=390,844",
    "about:blank",
  ];
  const child = spawn(chromeExecutable, args, {
    stdio: "ignore",
    windowsHide: true,
  });
  let launchError = null;
  child.on("error", (error) => {
    launchError = error;
  });
  try {
    const portFile = path.join(profileDir, "DevToolsActivePort");
    const deadline = Date.now() + 20_000;
    let port = null;
    while (Date.now() < deadline) {
      if (launchError) throw new Error(`chromium_spawn_failed_${messageOf(launchError)}`);
      if (child.exitCode !== null) {
        throw new Error(`chromium_exited_${child.exitCode}`);
      }
      try {
        const text = await readFile(portFile, "utf8");
        const first = text.trim().split(/\r?\n/)[0];
        const value = Number(first);
        if (Number.isInteger(value) && value > 0) {
          port = value;
          break;
        }
      } catch {
        // DevToolsActivePort is written after startup.
      }
      await delay(100);
    }
    if (!port) throw new Error("devtools_active_port_timeout");
    const list = await fetchJson(`http://127.0.0.1:${port}/json/list`);
    let target = Array.isArray(list)
      ? list.find((item) => item.type === "page")
      : null;
    if (!target) {
      target = await fetchJson(
        `http://127.0.0.1:${port}/json/new?${encodeURIComponent("about:blank")}`,
        { method: "PUT" },
      );
    }
    if (
      !target ||
      target.type !== "page" ||
      typeof target.webSocketDebuggerUrl !== "string"
    ) {
      throw new Error("page_target_invalid");
    }
    return { child, port, targetWs: target.webSocketDebuggerUrl };
  } catch (error) {
    try {
      await execFileAsync(
        "taskkill.exe",
        ["/PID", String(child.pid), "/T", "/F"],
        { windowsHide: true, timeout: 15_000 },
      );
    } catch {
      // Launch failure cleanup is best effort.
    }
    throw error;
  }
}

async function killOwnedProcessTree(child) {
  const result = {
    pid: child?.pid ?? null,
    method: "taskkill /PID <owned-pid> /T /F",
    attempts: 0,
    killed: false,
    exitCode: null,
  };
  if (!child || child.pid == null) return result;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    result.attempts += 1;
    try {
      await execFileAsync(
        "taskkill.exe",
        ["/PID", String(child.pid), "/T", "/F"],
        { windowsHide: true, timeout: 15_000 },
      );
    } catch {
      // The owned tree may already be gone.
    }
    await delay(400);
    if (child.exitCode !== null) break;
  }
  result.exitCode = child.exitCode;
  result.killed = child.exitCode !== null;
  return result;
}

async function setViewport(client, viewport) {
  await client.command("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    screenWidth: viewport.width,
    screenHeight: viewport.height,
    deviceScaleFactor: 1,
    mobile: true,
    screenOrientation: { type: "portraitPrimary", angle: 0 },
  });
  await client.command("Emulation.setTouchEmulationEnabled", {
    enabled: true,
    maxTouchPoints: 5,
  });
}

async function navigate(client, url) {
  const result = await client.command("Page.navigate", { url });
  if (result.errorText) throw new Error(`navigate_failed_${result.errorText}`);
  await client.waitFor(
    `document.readyState === 'complete'`,
    "navigation_complete_timeout",
  );
}

async function clickPoint(client, point) {
  const rawX = point.cx ?? point.x;
  const rawY = point.cy ?? point.y;
  if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) {
    throw new Error(
      `clickPoint requires finite cx/x and cy/y, got ${JSON.stringify(point)}`,
    );
  }
  const x = Math.round(rawX);
  const y = Math.round(rawY);
  await client.command("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: "none",
  });
  await client.command("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await delay(60);
  await client.command("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  await delay(300);
}

function screenshotName(tag, state) {
  return `${tag}-${state}-${runStamp}.png`;
}

async function runB7(client, viewport) {
  const tag = `b7-${viewport.width}x${viewport.height}`;
  const row = { viewport, screenshots: [], states: {} };
  try {
    await setViewport(client, viewport);
    // Fresh authored demo for this viewport: never inherit saved progress.
    row.storageCleared = await clearCandidateStorage(client);
    recordCheck(
      `${tag}_fresh_storage_before_navigation`,
      row.storageCleared.methods.length > 0,
      row.storageCleared,
    );
    await navigate(client, `${candidateOrigin}/`);
    await client.waitFor(
      `(() => window.__acc && window.__acc.navCreate() !== null)()`,
      `${tag}_create_nav_missing`,
    );
    await delay(500);
    const navPoint = await client.evaluate(
      `(() => { const el = window.__acc.navCreate(); return el ? window.__acc.rect(el) : null; })()`,
    );
    requireCheck(`${tag}_create_nav_present`, Boolean(navPoint), navPoint);
    row.states.navPoint = navPoint;
    await screenshot(client, screenshotName(tag, "home"), row);

    let screenVisible = false;
    for (let attempt = 0; attempt < 2 && !screenVisible; attempt += 1) {
      const point = await client.evaluate(
        `(() => { const el = window.__acc.navCreate(); return el ? window.__acc.rect(el) : null; })()`,
      );
      if (!point) break;
      await clickPoint(client, point);
      try {
        await client.waitFor(
          `(() => { const el = document.querySelector('.mobile-df-create-screen'); return el !== null && window.__acc.vis(el); })()`,
          `${tag}_create_screen_visible_timeout`,
          8_000,
        );
        screenVisible = true;
      } catch {
        await delay(400);
      }
    }
    requireCheck(`${tag}_create_screen_visible`, screenVisible);

    const layout = await client.evaluate(`(() => {
      const screen = document.querySelector('.mobile-df-create-screen');
      const nav = window.__acc.bottomNav();
      return {
        screen: screen ? window.__acc.rect(screen) : null,
        nav: nav ? window.__acc.rect(nav) : null,
        screenVisible: screen ? window.__acc.vis(screen) : false,
        navVisible: nav ? window.__acc.vis(nav) : false,
        navText: nav ? window.__acc.txt(nav).slice(0, 40) : ''
      };
    })()`);
    row.states.layout = layout;
    recordCheck(
      `${tag}_create_screen_above_nav`,
      Boolean(
        layout.screen &&
          layout.nav &&
          layout.screen.bottom <= layout.nav.top + 1,
      ),
      layout,
    );

    const scrolled = await client.evaluate(`(() => {
      const screen = document.querySelector('.mobile-df-create-screen');
      if (!screen) return null;
      const isScrollable = (el) => el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowY);
      let sp = isScrollable(screen) ? screen : window.__acc.scrollParent(screen);
      sp.scrollTop = sp.scrollHeight;
      return { scroller: sp.tagName, scrollTop: sp.scrollTop, scrollHeight: sp.scrollHeight, clientHeight: sp.clientHeight };
    })()`);
    row.states.createBottom = scrolled;
    await screenshot(client, screenshotName(tag, "create-bottom"), row);

    const textarea = await client.evaluate(`(() => {
      const screen = document.querySelector('.mobile-df-create-screen');
      const ta = screen ? screen.querySelector('textarea') : null;
      if (!ta) return null;
      const nav = window.__acc.bottomNav();
      const limit = nav ? nav.getBoundingClientRect().top : innerHeight;
      const reveal = window.__acc.reveal(ta, limit);
      const rect = window.__acc.rect(ta);
      const hit = window.__acc.hit(ta);
      return { reveal, rect, hit, fullyAbove: window.__acc.fullyAbove(ta, limit), limit };
    })()`);
    row.states.textarea = textarea;
    requireCheck(`${tag}_textarea_present`, Boolean(textarea));
    recordCheck(
      `${tag}_textarea_scroll_visible_above_nav`,
      Boolean(
        textarea.fullyAbove &&
          textarea.hit.hit &&
          textarea.rect.top >= 0 &&
          textarea.rect.bottom <= textarea.limit,
      ),
      textarea,
    );
    await clickPoint(client, textarea.hit);
    await client.command("Input.insertText", { text: LONG_TEXT });
    await delay(400);
    const value = await client.evaluate(
      `(() => { const el = document.querySelector('.mobile-df-create-screen textarea'); return el ? el.value : ''; })()`,
    );
    recordCheck(
      `${tag}_long_text_inserted`,
      value.length >= LONG_TEXT.length && value.includes("验收长文本结束标记-OK"),
      { length: value.length, tail: value.slice(-40) },
    );
    await screenshot(client, screenshotName(tag, "textarea-filled"), row);

    const cta = await client.evaluate(`(() => {
      const screen = document.querySelector('.mobile-df-create-screen');
      const el = window.__acc.clickable('上传文档');
      if (!screen || !el || !screen.contains(el)) return null;
      const nav = window.__acc.bottomNav();
      const limit = nav ? nav.getBoundingClientRect().top : innerHeight;
      const reveal = window.__acc.reveal(el, limit);
      const rect = window.__acc.rect(el);
      const hit = window.__acc.hit(el);
      return { reveal, rect, hit, limit, fullyAbove: window.__acc.fullyAbove(el, limit), disabled: Boolean(el.disabled) };
    })()`);
    row.states.cta = cta;
    requireCheck(`${tag}_upload_cta_present`, Boolean(cta));
    recordCheck(
      `${tag}_upload_cta_scroll_visible_above_nav`,
      Boolean(cta.fullyAbove && cta.hit.hit),
      cta,
    );
    recordCheck(
      `${tag}_upload_cta_min_44px`,
      cta.rect.height >= 44 && cta.rect.width >= 44,
      { width: cta.rect.width, height: cta.rect.height },
    );
    await screenshot(client, screenshotName(tag, "upload-cta"), row);

    recordCheck(
      `${tag}_real_touch_targeting`,
      Boolean(textarea.hit.hit && cta.hit.hit),
      { textareaHitTag: textarea.hit.hitTag, ctaHitTag: cta.hit.hitTag },
    );
  } catch (error) {
    row.error = messageOf(error);
    recordCheck(`${tag}_flow`, false, row.error);
  }
  report.b7.push(row);
}

async function videoFacts(client) {
  return client.evaluate(`(() => {
    const v = document.querySelector('video');
    const f = document.fullscreenElement;
    return {
      present: v instanceof HTMLVideoElement,
      src: v ? v.currentSrc : null,
      duration: v ? v.duration : null,
      currentTime: v ? v.currentTime : null,
      readyState: v ? v.readyState : -1,
      networkState: v ? v.networkState : -1,
      paused: v ? v.paused : null,
      ended: v ? v.ended : null,
      muted: v ? v.muted : null,
      videoWidth: v ? v.videoWidth : 0,
      videoHeight: v ? v.videoHeight : 0,
      error: v && v.error ? { code: v.error.code, message: v.error.message } : null,
      buffered: v ? [...Array(v.buffered.length)].map((_, i) => ({ start: v.buffered.start(i), end: v.buffered.end(i) })) : [],
      fullscreen: {
        present: Boolean(f),
        tag: f ? f.tagName : null,
        className: f ? String(f.className || '').slice(0, 120) : '',
        containsVideo: Boolean(f && v && f.contains(v)),
        isVideo: f === v,
        isBody: f === document.body,
        isHtml: f === document.documentElement
      },
      documentFullscreenEnabled: document.fullscreenEnabled,
      beats: document.querySelectorAll('[data-video-beat-overlay="true"]').length
    };
  })()`);
}

async function waitVideoReady(client, tag) {
  await client.waitFor(
    `(() => {
      const v = document.querySelector('video');
      return v instanceof HTMLVideoElement && v.readyState >= 2 && Number.isFinite(v.duration) && v.duration > 0;
    })()`,
    `${tag}_video_ready_timeout`,
  );
}

async function runA8(client, viewport) {
  const tag = `a8-${viewport.width}x${viewport.height}`;
  const row = {
    viewport,
    screenshots: [],
    media: null,
    fullscreen: null,
    completion: null,
    localOutcome: null,
    blockedGenerationCount: 0,
    storageCleared: [],
  };
  try {
    await setViewport(client, viewport);
    client.localMediaFallback = false;
    try {
      await client.evaluate(
        `document.fullscreenElement ? document.exitFullscreen().catch(() => {}) : true`,
      );
    } catch {
      // A fresh navigation also clears fullscreen.
    }
    // Each A8 viewport starts from a clean demo state so a previous run can
    // never advance saved progress and resume straight to the outcome.
    const freshStorage = await clearCandidateStorage(client);
    row.storageCleared.push(freshStorage);
    recordCheck(
      `${tag}_fresh_storage_before_navigation`,
      freshStorage.methods.length > 0,
      freshStorage,
    );
    await navigate(client, `${candidateOrigin}/play?case=world-model-little-chef`);

    let ready = false;
    try {
      await waitVideoReady(client, tag);
      ready = true;
      row.media = { source: "candidate_route", mocked: false };
    } catch {
      const failureFacts = await videoFacts(client).catch(() => null);
      row.media = {
        source: "local_reviewed_file_mock",
        mocked: true,
        path: localVideoPath,
        firstAttemptFacts: failureFacts,
      };
      client.localMediaFallback = true;
      const retryStorage = await clearCandidateStorage(client);
      row.storageCleared.push(retryStorage);
      recordCheck(
        `${tag}_fresh_storage_before_mock_navigation`,
        retryStorage.methods.length > 0,
        retryStorage,
      );
      await navigate(client, `${candidateOrigin}/play?case=world-model-little-chef`);
      try {
        await waitVideoReady(client, tag);
        ready = true;
        row.media.mockFulfilled = client.mockFulfilled;
        row.media.mockedUrls = [...client.mockedUrls];
        recordCheck(`${tag}_video_ready_via_local_mock`, true, {
          mocked: true,
          path: localVideoPath,
          note: "candidate media route failed; local reviewed video used and reported as mocked",
        });
      } catch {
        ready = false;
      }
    }

    if (!ready) {
      const facts = await videoFacts(client).catch(() => null);
      row.media.failureFacts = facts;
      row.media = { ...row.media, source: "unavailable", mocked: Boolean(row.media.mocked) };
      report.media = row.media;
      report.blockers.push({
        name: `${tag}_media_unavailable`,
        reason: "candidate_media_route_failed_and_local_video_not_playable",
        facts,
      });
      recordCheck(`${tag}_video_ready`, false, facts);
      return;
    }
    recordCheck(`${tag}_video_ready`, true, { mocked: Boolean(row.media.mocked) });
    report.media = row.media;
    row.videoBefore = await videoFacts(client);
    await screenshot(client, screenshotName(tag, "playing"), row);

    let fullscreenButton = await client.evaluate(
      `(() => { const el = window.__acc.clickable('全屏'); return el ? window.__acc.rect(el) : null; })()`,
    );
    if (!fullscreenButton) {
      const center = await client.evaluate(
        `(() => { const v = document.querySelector('video'); if (!v) return null; const r = v.getBoundingClientRect(); return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; })()`,
      );
      if (center) {
        await client.command("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: Math.round(center.cx),
          y: Math.round(center.cy),
          button: "none",
        });
        await delay(600);
        fullscreenButton = await client.evaluate(
          `(() => { const el = window.__acc.clickable('全屏'); return el ? window.__acc.rect(el) : null; })()`,
        );
      }
    }

    if (!fullscreenButton) {
      row.fullscreen = { status: "unsupported", reason: "fullscreen_button_not_found" };
      recordCheck(`${tag}_fullscreen_entered`, false, {
        status: "unsupported",
        reason: "fullscreen_button_not_found",
      });
    } else {
      await clickPoint(client, fullscreenButton);
      await delay(800);
      const entered = await videoFacts(client);
      row.fullscreen = { status: "clicked", entered: entered.fullscreen };
      recordCheck(
        `${tag}_fullscreen_entered`,
        Boolean(
          entered.fullscreen.present &&
            entered.fullscreen.containsVideo &&
            !entered.fullscreen.isVideo &&
            !entered.fullscreen.isBody &&
            !entered.fullscreen.isHtml,
        ),
        entered.fullscreen,
      );
      if (entered.fullscreen.present) {
        await screenshot(client, screenshotName(tag, "fullscreen"), row);
      }
    }

    const seek = await client.evaluate(`(() => {
      const v = document.querySelector('video');
      if (!(v instanceof HTMLVideoElement)) return { ok: false, reason: 'video_missing' };
      window.__accEnded = { count: 0, at: null, playError: null };
      v.addEventListener('ended', () => { window.__accEnded.count += 1; window.__accEnded.at = performance.now(); }, { once: true });
      v.muted = true;
      try { v.currentTime = Math.max(0, v.duration - 0.1); } catch (error) { return { ok: false, reason: 'seek_failed', message: String(error) }; }
      const promise = v.play();
      if (promise && promise.catch) promise.catch((error) => { window.__accEnded.playError = String(error); });
      return { ok: true, currentTime: v.currentTime, duration: v.duration, muted: v.muted };
    })()`);
    row.completion = { seek };
    recordCheck(`${tag}_native_seek_started`, Boolean(seek && seek.ok), seek);

    let ended = false;
    try {
      await client.waitFor(
        `(() => window.__accEnded && window.__accEnded.count >= 1)()`,
        `${tag}_ended_event_timeout`,
      );
      ended = true;
      row.completion.method = "native_ended_event";
    } catch {
      const skipButton = await client.evaluate(
        `(() => { const el = window.__acc.clickable('跳到结尾'); return el ? window.__acc.rect(el) : null; })()`,
      );
      if (!skipButton) throw new Error(`${tag}_ended_event_timeout_no_skip_button`);
      await clickPoint(client, skipButton);
      await client.waitFor(
        `(() => { const b = document.querySelector('[data-video-beat-overlay="true"]'); return b !== null && window.__acc.vis(b); })()`,
        `${tag}_skip_completion_timeout`,
      );
      row.completion.method = "skip_button_click";
      recordCheck(
        `${tag}_skip_button_completion`,
        true,
        { clickPoint: skipButton, note: "native ended event not observed; used transport skip" },
      );
    }
    if (ended) recordCheck(`${tag}_genuine_ended_event`, true, row.completion);
    row.completion.endedCount = await client.evaluate(
      `window.__accEnded ? window.__accEnded.count : 0`,
    );
    row.completion.playError = await client.evaluate(
      `window.__accEnded ? window.__accEnded.playError : null`,
    );

    try {
      await client.waitFor(
        `document.fullscreenElement === null`,
        `${tag}_fullscreen_release_timeout`,
        5_000,
      );
    } catch {
      // The assertion below records the observed ownership.
    }
    await delay(300);
    row.videoAfter = await videoFacts(client);
    row.completion.after = row.videoAfter;
    recordCheck(
      `${tag}_fullscreen_released_after_end`,
      row.videoAfter.fullscreen.present === false,
      row.videoAfter.fullscreen,
    );

    await client.waitFor(
      `(() => { const b = document.querySelector('[data-video-beat-overlay="true"]'); return b !== null && window.__acc.vis(b); })()`,
      `${tag}_beat_overlay_missing`,
    );
    const afterCompletion = await client.evaluate(`(() => {
      ${SCROLLPORT_RESOLVER}
      const beat = document.querySelector('[data-video-beat-overlay="true"]');
      const visibleRanges = [...document.querySelectorAll('input[type="range"],[role="slider"]')].filter(window.__acc.vis);
      const subtitle = window.__acc.subtitle();
      const sp = resolveScrollport();
      return {
        beat: beat ? window.__acc.rect(beat) : null,
        beatVisible: beat ? window.__acc.vis(beat) : false,
        beatText: beat ? window.__acc.txt(beat).slice(0, 200) : '',
        visibleRangeInputs: visibleRanges.map((el) => ({ type: el.type, ariaLabel: el.getAttribute('aria-label') || '', value: el.value })),
        subtitle,
        scrollport: sp.found
          ? {
              found: true,
              source: sp.source,
              tag: sp.tag,
              className: sp.className,
              overflowY: sp.overflowY,
              scrollTop: sp.scrollTop,
              scrollHeight: sp.scrollHeight,
              clientHeight: sp.clientHeight,
              overflowExtent: sp.overflowExtent,
              maxScrollTop: sp.maxScrollTop
            }
          : sp
      };
    })()`);
    row.afterCompletion = afterCompletion;
    recordCheck(
      `${tag}_transport_progress_input_gone`,
      afterCompletion.visibleRangeInputs.length === 0,
      afterCompletion.visibleRangeInputs,
    );
    recordCheck(
      `${tag}_subtitle_overlay_gone`,
      afterCompletion.subtitle.present === false,
      afterCompletion.subtitle,
    );
    // Acceptance is the computed overflow-y contract, not whether content
    // currently overflows: a valid short choice scene may fit entirely.
    recordCheck(
      `${tag}_beat_overlay_scrollport`,
      Boolean(
        afterCompletion.beatVisible &&
          afterCompletion.scrollport &&
          afterCompletion.scrollport.found &&
          /(auto|scroll)/.test(afterCompletion.scrollport.overflowY),
      ),
      afterCompletion.scrollport,
    );

    const scrollTop = await client.evaluate(`(() => {
      ${SCROLLPORT_RESOLVER}
      const sp = resolveScrollport();
      if (!sp.found) return sp;
      sp.el.scrollTop = 0;
      return {
        found: true,
        tag: sp.tag,
        className: sp.className,
        overflowY: sp.overflowY,
        scrollTop: sp.el.scrollTop,
        scrollHeight: sp.scrollHeight,
        clientHeight: sp.clientHeight,
        overflowExtent: sp.overflowExtent,
        maxScrollTop: sp.maxScrollTop,
        naturalOverflow: sp.overflowExtent > 1,
        topReachable: sp.el.scrollTop === 0
      };
    })()`);
    row.states = { scrollTop };
    recordCheck(
      `${tag}_scroll_top_reachable`,
      Boolean(
        scrollTop.found &&
          scrollTop.topReachable &&
          /(auto|scroll)/.test(scrollTop.overflowY),
      ),
      scrollTop,
    );
    await screenshot(client, screenshotName(tag, "complete-top"), row);
    const scrollBottom = await client.evaluate(`(() => {
      ${SCROLLPORT_RESOLVER}
      const sp = resolveScrollport();
      if (!sp.found) return sp;
      sp.el.scrollTop = sp.scrollHeight;
      const atBottom = sp.el.scrollTop;
      return {
        found: true,
        tag: sp.tag,
        className: sp.className,
        overflowY: sp.overflowY,
        scrollTop: atBottom,
        scrollHeight: sp.scrollHeight,
        clientHeight: sp.clientHeight,
        overflowExtent: sp.overflowExtent,
        maxScrollTop: sp.maxScrollTop,
        naturalOverflow: sp.overflowExtent > 1,
        bottomReachable: sp.maxScrollTop <= 1 || atBottom > 0,
        clamped: atBottom <= sp.maxScrollTop + 1
      };
    })()`);
    row.states.scrollBottom = scrollBottom;
    recordCheck(
      `${tag}_scroll_bottom_reachable`,
      Boolean(
        scrollBottom.found &&
          scrollBottom.bottomReachable &&
          scrollBottom.clamped &&
          /(auto|scroll)/.test(scrollBottom.overflowY),
      ),
      scrollBottom,
    );
    // At 420px an actual scroll is required only if natural content overflows;
    // fitting content must not be failed for having no scroll range.
    if (viewport.height <= 420) {
      recordCheck(
        `${tag}_short_viewport_scroll_when_overflowing`,
        !scrollBottom.naturalOverflow ||
          (scrollBottom.scrollTop > 0 && scrollBottom.clamped),
        {
          naturalOverflow: scrollBottom.naturalOverflow,
          overflowExtent: scrollBottom.overflowExtent,
          scrollTop: scrollBottom.scrollTop,
          maxScrollTop: scrollBottom.maxScrollTop,
          note: "no failure when natural content fits a valid short choice scene",
        },
      );
    }
    await screenshot(client, screenshotName(tag, "complete-bottom"), row);

    const choice = await client.evaluate(`(() => {
      const beat = document.querySelector('[data-video-beat-overlay="true"]');
      if (!beat) return null;
      const nodes = [...beat.querySelectorAll('button,[role="button"]')].filter((el) => window.__acc.vis(el) && window.__acc.txt(el).includes('做一份苹果点心'));
      const el = nodes[0];
      if (!el) return null;
      const nav = window.__acc.bottomNav();
      const limit = nav ? nav.getBoundingClientRect().top : innerHeight;
      const reveal = window.__acc.reveal(el, limit);
      const rect = window.__acc.rect(el);
      const hit = window.__acc.hit(el);
      return { reveal, rect, hit, disabled: Boolean(el.disabled), text: window.__acc.txt(el), fullyAbove: window.__acc.fullyAbove(el, limit) };
    })()`);
    row.choice = choice;
    requireCheck(`${tag}_choice_present`, Boolean(choice));
    recordCheck(
      `${tag}_choice_hit_testable`,
      Boolean(choice.hit.hit && choice.fullyAbove && !choice.disabled),
      choice,
    );

    const bodyBefore = await client.evaluate(
      `document.body.innerText.replace(/\\s+/g, '').slice(0, 6000)`,
    );
    const prefixesBeforeClick = EXPECTED_OUTCOME_PREFIXES.filter((prefix) =>
      bodyBefore.includes(prefix),
    );
    const mutationsBefore = client.mutationBlockedCount;
    const blockedBefore = client.blocked.length;
    await clickPoint(client, choice.hit);

    // Actual outcome proof: real catalog text must appear (typewriter or click
    // narration), not an arbitrary mutation. Poll up to 10s so a slow
    // typewriter can finish; a loading spinner alone can never pass.
    const outcomeDeadline = Date.now() + OUTCOME_WAIT_MS;
    const outcomeStartedAt = Date.now();
    let outcome = null;
    let matchedPrefixes = [];
    let waitedMs = 0;
    let narrationClick = null;
    while (Date.now() < outcomeDeadline) {
      outcome = await client.evaluate(`(() => {
        const text = document.body.innerText.replace(/\\s+/g, '');
        const loading = [...document.querySelectorAll('[role="status"],[role="alert"],[aria-busy="true"],.animate-spin,[data-loading="true"],[class*="spinner"]')].filter(window.__acc.vis);
        return {
          bodyAfter: text.slice(0, 6000),
          loadingVisible: loading.length,
          loadingTexts: loading.map((el) => window.__acc.txt(el).slice(0, 80)).filter(Boolean)
        };
      })()`);
      matchedPrefixes = EXPECTED_OUTCOME_PREFIXES.filter(
        (prefix) =>
          outcome.bodyAfter.includes(prefix) && !bodyBefore.includes(prefix),
      );
      if (matchedPrefixes.length > 0) break;
      waitedMs = Date.now() - outcomeStartedAt;
      if (!narrationClick && waitedMs >= OUTCOME_NARRATION_CLICK_MS) {
        const point = await client.evaluate(`(() => {
          const beat = document.querySelector('[data-video-beat-overlay="true"]');
          if (!beat) return null;
          const paragraphs = [...beat.querySelectorAll('p')]
            .filter((el) => window.__acc.vis(el) && window.__acc.txt(el).length > 0)
            .sort((a, b) => window.__acc.txt(b).length - window.__acc.txt(a).length);
          for (const p of paragraphs) {
            const r = p.getBoundingClientRect();
            const x = Math.min(innerWidth - 1, Math.max(1, r.left + r.width / 2));
            const y = Math.min(innerHeight - 1, Math.max(1, r.top + r.height / 2));
            const hit = document.elementFromPoint(x, y);
            if (!hit || !beat.contains(hit)) continue;
            if (hit.closest('button,a,input,textarea,select,[role="button"],[role="slider"]')) continue;
            return { cx: x, cy: y, text: window.__acc.txt(p).slice(0, 40) };
          }
          return null;
        })()`);
        if (point) {
          await clickPoint(client, point);
          narrationClick = { ...point, waitedMs };
        }
      }
      await delay(200);
    }
    if (!outcome) {
      outcome = { bodyAfter: "", loadingVisible: 0, loadingTexts: [] };
    }
    const newMutationBlocked = client.mutationBlockedCount - mutationsBefore;
    const newBlocked = client.blocked.slice(blockedBefore);
    const newGenerationBlocked = newBlocked.filter(
      (entry) => entry.reason === "mutation_method",
    );
    row.blockedGenerationCount = newMutationBlocked;
    row.localOutcome = {
      expectedPrefixes: [...EXPECTED_OUTCOME_PREFIXES],
      matchedPrefixes,
      prefixesBeforeClick,
      waitedMs,
      narrationClick,
      loadingVisible: outcome.loadingVisible,
      loadingTexts: outcome.loadingTexts,
      bodyChanged: outcome.bodyAfter !== bodyBefore,
      newBlocked,
    };
    recordCheck(
      `${tag}_choice_no_generation_post`,
      newMutationBlocked === 0 && newGenerationBlocked.length === 0,
      { newMutationBlocked, newGenerationBlocked, newBlocked },
    );
    recordCheck(
      `${tag}_local_outcome_shown`,
      matchedPrefixes.length > 0,
      {
        matchedPrefixes,
        expectedPrefixes: [...EXPECTED_OUTCOME_PREFIXES],
        prefixesBeforeClick,
        waitedMs,
        narrationClick,
        loadingVisible: outcome.loadingVisible,
        loadingTexts: outcome.loadingTexts,
        bodyChanged: outcome.bodyAfter !== bodyBefore,
        bodyTail: outcome.bodyAfter.slice(-160),
      },
    );
    await screenshot(client, screenshotName(tag, "local-outcome"), row);
  } catch (error) {
    row.error = messageOf(error);
    recordCheck(`${tag}_flow`, false, row.error);
    try {
      row.videoFailure = await videoFacts(client);
    } catch {
      // Page may be gone.
    }
  }
  report.a8.push(row);
}

async function main() {
  let profileDir = null;
  let client = null;
  let child = null;
  try {
    if (!chromeExecutable) {
      throw new Error(chromeExecutableError || "chrome_executable_unresolved");
    }
    await mkdir(evidenceRoot, { recursive: true });
    profileDir = await mkdtemp(path.join(tmpdir(), "issue-mobile-browser-"));
    const launched = await launchChrome(profileDir);
    child = launched.child;
    report.chromium.pid = child.pid;
    report.chromium.devToolsPort = launched.port;
    client = new CdpClient(launched.targetWs, candidateOrigin);
    await client.open();
    report.chromium.connected = true;
    await Promise.all([
      client.command("Page.enable"),
      client.command("Runtime.enable"),
      client.command("Log.enable"),
      client.command("Network.enable"),
    ]);
    await client.command("Network.setCacheDisabled", { cacheDisabled: true });
    // Fetch handles http(s); WebSocket handshakes bypass Fetch, so block
    // ws/wss explicitly to keep external network disabled.
    await client.command("Network.setBlockedURLs", {
      urls: ["ws://*/*", "wss://*/*"],
    });
    await client.command("Page.addScriptToEvaluateOnNewDocument", {
      source: HELPERS,
    });
    await client.command("Fetch.enable", {
      patterns: [
        { urlPattern: "http://*/*", requestStage: "Request" },
        { urlPattern: "https://*/*", requestStage: "Request" },
      ],
    });

    for (const viewport of VIEWPORTS) await runB7(client, viewport);
    for (const viewport of VIEWPORTS) await runA8(client, viewport);
  } catch (error) {
    report.blockers.push({
      name: "runner_error",
      message: messageOf(error),
    });
  } finally {
    if (client) {
      report.blockedRequests = [...client.blocked];
      report.pageErrors = [...client.pageErrors].slice(-300);
      report.candidateRequestCount = client.requests.length;
      report.externalBlockedCount = client.externalBlockedCount;
      report.mutationBlockedCount = client.mutationBlockedCount;
      report.mockFulfilledCount = client.mockFulfilled;
      report.mockedUrls = [...client.mockedUrls];
      client.close();
    }
    report.cleanup = await killOwnedProcessTree(child);
    if (profileDir) {
      // Verify the runtime profile path, then retain it. No recursive delete is
      // ever derived here, so no arbitrary directory can be removed.
      const resolvedProfile = path.resolve(profileDir);
      const resolvedTmp = path.resolve(tmpdir());
      report.cleanup.profileRetained = true;
      report.cleanup.profilePath = resolvedProfile;
      report.cleanup.profileAbsolute = path.isAbsolute(profileDir);
      report.cleanup.profileWithinTmpdir =
        resolvedProfile === resolvedTmp ||
        resolvedProfile.startsWith(resolvedTmp + path.sep);
      report.cleanup.profilePrefix = path.basename(resolvedProfile).startsWith(
        "issue-mobile-browser-",
      );
      report.cleanup.profileNote =
        "temporary Chromium profile retained by policy; no recursive delete performed";
    }
    report.finishedAt = new Date().toISOString();
    report.pass = report.failures.length === 0 && report.blockers.length === 0;
    const reportFile = path.join(
      evidenceRoot,
      `browser-acceptance-report-${runStamp}.json`,
    );
    await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
    console.log(
      JSON.stringify(
        {
          pass: report.pass,
          reportFile,
          checkCount: report.checks.length,
          failures: report.failures.length,
          blockers: report.blockers.length,
          blockedRequests: report.blockedRequests.length,
          media: report.media,
          cleanup: {
            profileRetained: Boolean(report.cleanup?.profileRetained),
            profilePath: report.cleanup?.profilePath ?? null,
          },
        },
        null,
        2,
      ),
    );
    process.exitCode = report.pass ? 0 : 1;
  }
}

main().catch((error) => {
  console.error(messageOf(error));
  process.exitCode = 1;
});
