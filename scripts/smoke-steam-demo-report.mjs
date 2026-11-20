import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const cdpBase = new URL(
  process.env.AISTORY_STEAM_CDP_URL || "http://127.0.0.1:9333",
);
const evidenceRoot = path.resolve(
  process.env.AISTORY_STEAM_EVIDENCE_DIR ||
    path.resolve(".codex-logs", "steam-demo-report-smoke"),
);
const downloadRoot = path.resolve(evidenceRoot, "downloads");
const candidateRootValue = String(
  process.env.AISTORY_STEAM_CANDIDATE_DIR || "",
).trim();
if (!candidateRootValue) {
  throw new Error("steam_report_smoke_candidate_required");
}
const candidateRoot = path.resolve(candidateRootValue);
const releaseManifest = JSON.parse(
  await readFile(path.resolve(candidateRoot, "release-manifest.json"), "utf8"),
);
if (
  releaseManifest?.schemaVersion !== 1 ||
  releaseManifest?.product !== "AIstory" ||
  releaseManifest?.platform !== "windows-x64" ||
  typeof releaseManifest?.appVersion !== "string" ||
  typeof releaseManifest?.releaseId !== "string"
) {
  throw new Error("steam_report_smoke_release_manifest_invalid");
}

if (
  cdpBase.protocol !== "http:" ||
  cdpBase.hostname !== "127.0.0.1" ||
  cdpBase.username ||
  cdpBase.password ||
  cdpBase.search ||
  cdpBase.hash
) {
  throw new Error("steam_report_smoke_cdp_must_be_loopback_http");
}

async function fetchJson(relative) {
  const response = await fetch(new URL(relative, cdpBase), {
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error("steam_report_smoke_cdp_unavailable");
  return response.json();
}

let target;
const targetDeadline = Date.now() + 15_000;
while (!target && Date.now() < targetDeadline) {
  const targets = await fetchJson("/json/list");
  target = targets.find((item) => {
    try {
      const url = new URL(item.url);
      return (
        item.type === "page" &&
        url.protocol === "http:" &&
        url.hostname === "127.0.0.1" &&
        /\/steam\/?$/.test(url.pathname)
      );
    } catch {
      return false;
    }
  });
  if (!target) await new Promise((resolve) => setTimeout(resolve, 150));
}
if (!target || typeof target.webSocketDebuggerUrl !== "string") {
  throw new Error("steam_report_smoke_renderer_target_missing");
}

const targetUrl = new URL(target.url);
const runtimeOrigin = targetUrl.origin;
const websocketUrl = new URL(target.webSocketDebuggerUrl);
if (websocketUrl.protocol !== "ws:" || websocketUrl.hostname !== "127.0.0.1") {
  throw new Error("steam_report_smoke_debugger_not_loopback");
}

const socket = new WebSocket(websocketUrl);
await new Promise((resolve, reject) => {
  const timer = setTimeout(
    () => reject(new Error("steam_report_smoke_debugger_timeout")),
    5_000,
  );
  socket.addEventListener("open", () => {
    clearTimeout(timer);
    resolve();
  });
  socket.addEventListener("error", () => {
    clearTimeout(timer);
    reject(new Error("steam_report_smoke_debugger_failed"));
  });
});

let nextId = 1;
const pending = new Map();
const consoleErrors = [];
const runtimeExceptions = [];
const loadingFailures = [];
const requestUrls = new Set();
const pageWebSockets = [];
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) {
      reject(new Error(`steam_report_smoke_cdp_${message.error.code}`));
    } else {
      resolve(message.result || {});
    }
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
  if (message.method === "Runtime.exceptionThrown") {
    runtimeExceptions.push("runtime.exception");
  }
  if (message.method === "Inspector.targetCrashed") {
    runtimeExceptions.push("target.crashed");
  }
  if (message.method === "Network.loadingFailed") {
    loadingFailures.push(
      String(message.params?.errorText || "network.loadingFailed"),
    );
  }
  if (message.method === "Network.webSocketCreated") {
    pageWebSockets.push(String(message.params?.url || ""));
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
  if (result.exceptionDetails) {
    throw new Error("steam_report_smoke_page_evaluation_failed");
  }
  return result.result?.value;
}

async function navigate(url) {
  const parsed = new URL(url);
  if (parsed.origin !== runtimeOrigin) {
    throw new Error("steam_report_smoke_navigation_not_runtime");
  }
  await command("Page.navigate", { url: parsed.href });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const state = await evaluate("document.readyState");
    if (state === "complete" || state === "interactive") return;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error("steam_report_smoke_navigation_timeout");
}

async function waitFor(expression, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("steam_report_smoke_wait_timeout");
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
  return evaluate(`(() => {
    const panel = document.querySelector('[data-steam-report-panel]');
    const rect = panel?.getBoundingClientRect();
    const style = panel ? getComputedStyle(panel) : null;
    return {
      url: location.href,
      viewport: [innerWidth, innerHeight],
      htmlClientWidth: document.documentElement.clientWidth,
      htmlScrollWidth: document.documentElement.scrollWidth,
      bodyClientWidth: document.body.clientWidth,
      bodyScrollWidth: document.body.scrollWidth,
      reportVisible: Boolean(
        panel &&
        rect &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.top < innerHeight &&
        style?.display !== 'none' &&
        style?.visibility !== 'hidden'
      ),
      reportRect: rect
        ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
        : null
    };
  })()`);
}

try {
await mkdir(evidenceRoot, { recursive: true });
await mkdir(downloadRoot, { recursive: true });
if ((await readdir(downloadRoot)).length !== 0) {
  throw new Error("steam_report_smoke_download_directory_not_empty");
}
await Promise.all([
  command("Page.enable"),
  command("Runtime.enable"),
  command("Log.enable"),
  command("Network.enable"),
]);
await command("Browser.setDownloadBehavior", {
  behavior: "allow",
  downloadPath: downloadRoot,
  eventsEnabled: true,
});

const issueDescription = "合成测试：第二章选择后，字幕出现得比声音慢。";
await setViewport(1_440, 900);
await navigate(`${runtimeOrigin}/zh-CN/steam?view=settings`);
await waitFor("Boolean(document.querySelector('[data-steam-report-panel]'))");
await waitFor("!document.querySelector('[data-steam-report-download]')?.disabled");
await evaluate(
  "document.querySelector('[data-steam-report-panel]')?.scrollIntoView({ block: 'center' })",
);
const trustedRuntimeInfo = await evaluate("window.aistoryDesktop?.getRuntimeInfo()");
if (
  !trustedRuntimeInfo?.packaged ||
  trustedRuntimeInfo.releasePlatform !== "windows-x64" ||
  trustedRuntimeInfo.appVersion !== releaseManifest.appVersion
) {
  throw new Error("steam_report_smoke_runtime_info_invalid");
}
await evaluate(`(() => {
  const textarea = document.querySelector('[data-steam-report-description]');
  if (!(textarea instanceof HTMLTextAreaElement)) {
    throw new Error('report_description_missing');
  }
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  setter?.call(textarea, ${JSON.stringify(issueDescription)});
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await waitFor(
  `document.querySelector('[data-steam-report-description]')?.value === ${JSON.stringify(issueDescription)}`,
);
const desktop = await layoutFacts();
if (!desktop.reportVisible) {
  throw new Error("steam_report_smoke_report_not_visible_desktop");
}
const desktopScreenshot = await capture("steam-demo-report-1440x900.png");
const downloadStartedAt = Date.now();
await evaluate(`(() => {
  const button = document.querySelector('[data-steam-report-download]');
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error('report_download_missing');
  }
  button.click();
})()`);

const reportFilename = "aistory-steam-demo-test-report-v1.json";
const reportDeadline = Date.now() + 10_000;
let downloadedReportPath;
while (!downloadedReportPath && Date.now() < reportDeadline) {
  const names = await readdir(downloadRoot);
  if (
    names.includes(reportFilename) &&
    !names.some((name) => name.endsWith(".crdownload"))
  ) {
    downloadedReportPath = path.resolve(downloadRoot, reportFilename);
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}
if (!downloadedReportPath) {
  throw new Error("steam_report_smoke_download_missing");
}
const downloadedNames = await readdir(downloadRoot);
if (
  downloadedNames.length !== 1 ||
  downloadedNames[0] !== reportFilename
) {
  throw new Error("steam_report_smoke_download_set_invalid");
}

const downloadedBytes = await readFile(downloadedReportPath);
const downloadedText = downloadedBytes.toString("utf8");
const downloadedReport = JSON.parse(downloadedText);
const exactReportKeys = [
  "schema",
  "schemaVersion",
  "releaseId",
  "generatedAt",
  "app",
  "viewport",
  "publicContext",
  "steamCapabilities",
  "issueDescription",
];
if (
  JSON.stringify(Object.keys(downloadedReport)) !==
  JSON.stringify(exactReportKeys)
) {
  throw new Error("steam_report_smoke_fields_invalid");
}
if (
  downloadedReport.schema !== "aistory-steam-demo-test-report" ||
  downloadedReport.schemaVersion !== 1 ||
  downloadedReport.releaseId !== releaseManifest.releaseId ||
  downloadedReport.app?.version !== trustedRuntimeInfo.appVersion ||
  downloadedReport.app?.platform !== "windows" ||
  downloadedReport.app?.architecture !== "x64" ||
  downloadedReport.publicContext?.route !== "steam" ||
  downloadedReport.issueDescription !== issueDescription ||
  downloadedBytes.byteLength > 16 * 1024
) {
  throw new Error("steam_report_smoke_contract_invalid");
}
const generatedAt = Date.parse(downloadedReport.generatedAt);
if (
  !Number.isFinite(generatedAt) ||
  generatedAt < downloadStartedAt - 1_000 ||
  generatedAt > Date.now() + 5_000
) {
  throw new Error("steam_report_smoke_generated_at_invalid");
}
if (
  /(?:phone|uuid|session|cookie|localstorage|sessionstorage|byok|hosted.?key|api.?key|access.?key|secret|token|prompt|workflow|provider.?task|local.?path|user.?agent|stack|log.?file)/i.test(
    downloadedText,
  ) ||
  /(?:[A-Za-z]:\\|\\\\|\/home\/|13800138000|synthetic-secret-marker)/i.test(
    downloadedText,
  )
) {
  throw new Error("steam_report_smoke_sensitive_marker_detected");
}

await setViewport(960, 600);
await evaluate(
  "document.querySelector('[data-steam-report-panel]')?.scrollIntoView({ block: 'center' })",
);
const preCopyFeedback = await evaluate(
  "document.querySelector('[data-steam-report-feedback]')?.textContent || ''",
);
await evaluate(`(() => {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: (text) => {
        window.__aistorySteamReportClipboardAttempt = String(text);
        return Promise.reject(new DOMException('blocked', 'NotAllowedError'));
      }
    }
  });
  const button = document.querySelector('[data-steam-report-copy]');
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error('report_copy_missing');
  }
  button.click();
})()`);
await waitFor(
  `(() => {
    const text = document.querySelector('[data-steam-report-feedback]')?.textContent || '';
    return Boolean(text) && text !== ${JSON.stringify(preCopyFeedback)};
  })()`,
);
const copyFeedback = await evaluate(
  "document.querySelector('[data-steam-report-feedback]')?.textContent || ''",
);
await waitFor(
  "Boolean(document.querySelector('[data-steam-report-copy-fallback]')?.value)",
);
const clipboardAttempt = await evaluate(
  "window.__aistorySteamReportClipboardAttempt || ''",
);
const settledFallbackText = await evaluate(
  "document.querySelector('[data-steam-report-copy-fallback]')?.value || ''",
);
if (
  !copyFeedback ||
  !clipboardAttempt ||
  settledFallbackText !== clipboardAttempt
) {
  throw new Error("steam_report_smoke_copy_fallback_mismatch");
}
const compact = await layoutFacts();
if (!compact.reportVisible) {
  throw new Error("steam_report_smoke_report_not_visible_compact");
}
const compactScreenshot = await capture(
  "steam-demo-report-960x600-copy-feedback.png",
);

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
const uniqueOrigins = [...new Set(requestOrigins)].sort();
const externalRequestCount = uniqueOrigins.filter(
  (origin) => origin !== runtimeOrigin,
).length;
const hasOverflow = (facts) =>
  facts.htmlScrollWidth !== facts.htmlClientWidth ||
  facts.bodyScrollWidth !== facts.bodyClientWidth;
if (externalRequestCount !== 0) {
  throw new Error("steam_report_smoke_external_request_detected");
}
if (
  consoleErrors.length !== 0 ||
  runtimeExceptions.length !== 0 ||
  loadingFailures.length !== 0 ||
  pageWebSockets.length !== 0
) {
  throw new Error("steam_report_smoke_console_error_detected");
}
if (hasOverflow(desktop) || hasOverflow(compact)) {
  throw new Error("steam_report_smoke_overflow_detected");
}

const smokeReport = {
  schemaVersion: 1,
  runtimeOrigin,
  desktop,
  compact,
  desktopScreenshot,
  compactScreenshot,
  downloadedReport: {
    filename: reportFilename,
    bytes: downloadedBytes.byteLength,
    schema: downloadedReport.schema,
    schemaVersion: downloadedReport.schemaVersion,
    releaseId: downloadedReport.releaseId,
    appVersion: downloadedReport.app.version,
    sha256: createHash("sha256").update(downloadedBytes).digest("hex"),
    publicRoute: downloadedReport.publicContext.route,
    sensitiveMarkerCount: 0,
  },
  copyFeedback,
  copyFallback: {
    bytes: new TextEncoder().encode(settledFallbackText).byteLength,
    sha256: createHash("sha256").update(settledFallbackText).digest("hex"),
    equalsClipboardAttempt: true,
  },
  consoleErrorCount: consoleErrors.length,
  runtimeExceptionCount: runtimeExceptions.length,
  loadingFailureCount: loadingFailures.length,
  requestOrigins: uniqueOrigins,
  externalRequestCount,
};
const reportPath = path.resolve(evidenceRoot, "steam-demo-report-smoke.json");
await writeFile(reportPath, `${JSON.stringify(smokeReport, null, 2)}\n`, {
  encoding: "utf8",
  flag: "wx",
});
console.log(`Steam Demo report smoke passed: ${reportPath}`);
} finally {
  socket.close();
}
