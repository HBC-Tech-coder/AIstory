import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const cdpBase = new URL(
  process.env.AISTORY_STEAM_CDP_URL || "http://127.0.0.1:9333",
);
const evidenceRoot = path.resolve(
  process.env.AISTORY_STEAM_EVIDENCE_DIR ||
    path.resolve(".codex-logs", "steam-electron-smoke"),
);
const mode = process.argv[2] || "primary";

if (
  cdpBase.protocol !== "http:" ||
  cdpBase.hostname !== "127.0.0.1" ||
  cdpBase.username ||
  cdpBase.password ||
  cdpBase.search ||
  cdpBase.hash
) {
  throw new Error("steam_smoke_cdp_must_be_loopback_http");
}
if (!new Set(["primary", "restart"]).has(mode)) {
  throw new Error("steam_smoke_mode_invalid");
}

async function fetchJson(relative) {
  const response = await fetch(new URL(relative, cdpBase), {
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error("steam_smoke_cdp_unavailable");
  return response.json();
}

let target;
const targetDeadline = Date.now() + 15_000;
while (!target && Date.now() < targetDeadline) {
  const targets = await fetchJson("/json/list");
  target = targets.find((item) => {
    try {
      const url = new URL(item.url);
      return url.protocol === "http:" && url.hostname === "127.0.0.1";
    } catch {
      return false;
    }
  });
  if (!target) await new Promise((resolve) => setTimeout(resolve, 150));
}
if (!target || typeof target.webSocketDebuggerUrl !== "string") {
  throw new Error("steam_smoke_renderer_target_missing");
}
const targetUrl = new URL(target.url);
const runtimeOrigin = targetUrl.origin;
const websocketUrl = new URL(target.webSocketDebuggerUrl);
if (websocketUrl.protocol !== "ws:" || websocketUrl.hostname !== "127.0.0.1") {
  throw new Error("steam_smoke_debugger_not_loopback");
}

const socket = new WebSocket(websocketUrl);
await new Promise((resolve, reject) => {
  const timer = setTimeout(
    () => reject(new Error("steam_smoke_debugger_timeout")),
    5_000,
  );
  socket.addEventListener("open", () => {
    clearTimeout(timer);
    resolve();
  });
  socket.addEventListener("error", () => {
    clearTimeout(timer);
    reject(new Error("steam_smoke_debugger_failed"));
  });
});

let nextId = 1;
const pending = new Map();
const consoleErrors = [];
const requestUrls = new Set();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(`steam_smoke_cdp_${message.error.code}`));
    else resolve(message.result || {});
    return;
  }
  if (
    message.method === "Runtime.consoleAPICalled" &&
    message.params?.type === "error"
  ) {
    consoleErrors.push("console.error");
  }
  if (
    message.method === "Log.entryAdded" &&
    message.params?.entry?.level === "error"
  ) {
    consoleErrors.push("log.error");
  }
  if (message.method === "Network.requestWillBeSent") {
    const url = message.params?.request?.url;
    if (typeof url === "string") requestUrls.add(url);
  }
});

function command(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression, awaitPromise = true) {
  const result = await command("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) throw new Error("steam_smoke_page_evaluation_failed");
  return result.result?.value;
}

async function navigate(url) {
  const parsed = new URL(url);
  if (parsed.origin !== runtimeOrigin) {
    throw new Error("steam_smoke_navigation_not_loopback_runtime");
  }
  await command("Page.navigate", { url: parsed.href });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const state = await evaluate("document.readyState");
    if (state === "complete" || state === "interactive") return;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error("steam_smoke_navigation_timeout");
}

async function waitFor(expression, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("steam_smoke_wait_timeout");
}

async function setViewport(width, height) {
  await command("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
}

async function capture(name) {
  const result = await command("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  const destination = path.resolve(evidenceRoot, name);
  await writeFile(destination, Buffer.from(result.data, "base64"), {
    flag: "wx",
  });
  return destination;
}

async function layoutFacts() {
  return evaluate(`(() => ({
    url: location.href,
    title: document.title,
    viewport: [innerWidth, innerHeight],
    htmlClientWidth: document.documentElement.clientWidth,
    htmlScrollWidth: document.documentElement.scrollWidth,
    bodyClientWidth: document.body.clientWidth,
    bodyScrollWidth: document.body.scrollWidth,
    hasSteamShell: Boolean(document.querySelector('[data-steam-shell]'))
  }))()`);
}

await mkdir(evidenceRoot, { recursive: true });
await Promise.all([
  command("Page.enable"),
  command("Runtime.enable"),
  command("Log.enable"),
  command("Network.enable"),
]);

const preferenceKey = "aistory:steam-powered-splash-enabled:v1";
const report = {
  mode,
  runtimeOrigin,
  consoleErrorCount: 0,
  externalRequestCount: 0,
};

if (mode === "primary") {
  await evaluate(
    `localStorage.setItem(${JSON.stringify(preferenceKey)}, "1")`,
  );
  await setViewport(1_440, 900);
  await navigate(`${runtimeOrigin}/zh-CN/steam`);
  await waitFor("Boolean(document.querySelector('[data-steam-shell]'))");
  await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find(
      (item) => item.getAttribute('aria-label') === '跳过启动品牌画面'
    );
    button?.click();
  })()`);
  report.desktop = await layoutFacts();
  report.desktopScreenshot = await capture("steam-demo-1440x900.png");

  await setViewport(960, 600);
  report.compact = await layoutFacts();
  report.compactScreenshot = await capture("steam-demo-960x600.png");

  await evaluate(`(() => {
    const button = document.querySelectorAll('main section button')[0];
    if (!button) throw new Error('settings_button_missing');
    button.click();
  })()`);
  await waitFor("document.querySelectorAll('main section button').length >= 3");
  await evaluate(`(() => {
    const button = document.querySelector('main section button');
    if (!button) throw new Error('preference_button_missing');
    button.click();
  })()`);
  report.savedPreference = await evaluate(
    `localStorage.getItem(${JSON.stringify(preferenceKey)})`,
  );
  if (report.savedPreference !== "0") {
    throw new Error("steam_smoke_preference_not_saved");
  }

  await setViewport(1_440, 900);
  await navigate(`${runtimeOrigin}/play?case=world-model-anime-sunset&channel=steam`);
  await waitFor("Boolean(document.querySelector('video'))", 45_000);
  report.video = await evaluate(`(async () => {
    const video = document.querySelector('video');
    if (!video) throw new Error('video_missing');
    video.muted = true;
    await new Promise((resolve, reject) => {
      if (video.readyState >= 1) return resolve();
      const timer = setTimeout(() => reject(new Error('metadata_timeout')), 15000);
      video.addEventListener('loadedmetadata', () => { clearTimeout(timer); resolve(); }, { once: true });
      video.addEventListener('error', () => { clearTimeout(timer); reject(new Error('video_error')); }, { once: true });
    });
    await video.play();
    await new Promise((resolve) => setTimeout(resolve, 650));
    const playedTime = video.currentTime;
    const target = Math.min(Math.max(1, video.duration / 3), Math.max(1, video.duration - 0.5));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('seek_timeout')), 10000);
      video.addEventListener('seeked', () => { clearTimeout(timer); resolve(); }, { once: true });
      video.currentTime = target;
    });
    return {
      src: video.currentSrc || video.src,
      readyState: video.readyState,
      duration: video.duration,
      playedTime,
      seekedTime: video.currentTime,
      error: video.error ? video.error.code : null
    };
  })()`);
  report.videoScreenshot = await capture("steam-world-model-playback.png");
} else {
  await setViewport(1_280, 800);
  await navigate(`${runtimeOrigin}/zh-CN/steam`);
  await waitFor("Boolean(document.querySelector('[data-steam-shell]'))");
  report.savedPreference = await evaluate(
    `localStorage.getItem(${JSON.stringify(preferenceKey)})`,
  );
  report.splashVisible = await evaluate(
    `Boolean(document.querySelector('button[aria-label="跳过启动品牌画面"]'))`,
  );
  if (report.savedPreference !== "0" || report.splashVisible) {
    throw new Error("steam_smoke_preference_not_restored");
  }
  report.restart = await layoutFacts();
  report.restartScreenshot = await capture("steam-demo-restart.png");
}

const requestOrigins = [];
for (const value of requestUrls) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      requestOrigins.push(parsed.origin);
    }
  } catch {
    // Internal browser URLs do not represent network egress.
  }
}
report.requestOrigins = [...new Set(requestOrigins)].sort();
report.externalRequestCount = report.requestOrigins.filter(
  (origin) => origin !== runtimeOrigin,
).length;
report.consoleErrorCount = consoleErrors.length;
if (report.externalRequestCount !== 0) {
  throw new Error("steam_smoke_external_request_detected");
}
if (report.consoleErrorCount !== 0) {
  throw new Error("steam_smoke_console_error_detected");
}
if (
  report.desktop &&
  (report.desktop.htmlScrollWidth !== report.desktop.htmlClientWidth ||
    report.desktop.bodyScrollWidth !== report.desktop.bodyClientWidth)
) {
  throw new Error("steam_smoke_desktop_overflow");
}
if (
  report.compact &&
  (report.compact.htmlScrollWidth !== report.compact.htmlClientWidth ||
    report.compact.bodyScrollWidth !== report.compact.bodyClientWidth)
) {
  throw new Error("steam_smoke_compact_overflow");
}

const reportPath = path.resolve(evidenceRoot, `steam-electron-${mode}.json`);
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
  encoding: "utf8",
  flag: "wx",
});
socket.close();
console.log(`Steam Electron ${mode} smoke passed: ${reportPath}`);
