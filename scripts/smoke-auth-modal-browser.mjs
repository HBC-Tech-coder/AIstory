#!/usr/bin/env node
/**
 * Executable browser smoke test for the REAL components/AuthModal.tsx.
 *
 * This intentionally runs from the full repo (D:/AIstory) because it needs the
 * existing esbuild, React, Tailwind and headless Chromium installations.
 *
 * Run from the repo root:
 *   node scripts/smoke-auth-modal-browser.mjs
 *
 * Only unrelated network/identity integrations are stubbed. The actual auth
 * modal, cooldown module and safe-presentation helper are bundled and exercised.
 */

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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const RUN_COMMAND = "node scripts/smoke-auth-modal-browser.mjs";
const FIXTURE_PATH = path.join(
  repoRoot,
  "scripts",
  "fixtures",
  "auth-modal-browser-harness.tsx",
);
const AUTH_MODAL_PATH = path.join(repoRoot, "components", "AuthModal.tsx");
const CHROME_EXECUTABLE =
  process.env.AUTH_MODAL_CHROME ||
  "C:\\Users\\sunat\\AppData\\Local\\ms-playwright\\chromium_headless_shell-1228\\chrome-headless-shell-win64\\chrome-headless-shell.exe";

const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 390, height: 420 },
  { width: 1280, height: 800 },
];

const DIALOG_SELECTOR = '[role="dialog"]';
const PHONE_INPUT_SELECTOR = '[role="dialog"] input[type="tel"]';
const OTP_INPUT_SELECTOR = '[role="dialog"] input[inputmode="numeric"]';
const CLOSE_BUTTON_SELECTOR = '[role="dialog"] button[aria-label]';
const PRIMARY_BUTTON_SELECTOR = '[role="dialog"] button.ui-button-primary';

const KEY_TAB = { key: "Tab", code: "Tab", vk: 9 };
const KEY_ESCAPE = { key: "Escape", code: "Escape", vk: 27 };
const KEY_ENTER = { key: "Enter", code: "Enter", vk: 13 };

const STUB_SOURCES = new Map([
  [
    "@/components/AiUserLoginButton",
    `
      export function AiUserLoginButton() {
        return <button type="button" data-testid="ai-user-login">AI user login</button>;
      }
    `,
  ],
  [
    "@/lib/i18n/client",
    `
      const LABELS: Record<string, string> = {
        "auth.steps.phone": "手机号",
        "auth.close": "关闭",
        "auth.ariaLabel": "登录",
        "auth.platformCostTitle": "平台消耗",
        "auth.platformCostDetail": "预计消耗 {credits} 积分 · 价格策略 {version}",
        "auth.phoneLogin": "手机号登录",
        "auth.registrationHint": "登录后会保留你的本地进度。",
        "auth.localProgressHint": "本地进度会合并到账号。",
        "auth.phonePlaceholder": "输入手机号",
        "auth.localSmsHint": "开发环境会使用模拟短信。",
        "auth.sending": "发送中…",
        "auth.resendCountdown": "{seconds}s 后可重新发送",
        "auth.resendCode": "重新获取验证码",
        "auth.sendCode": "获取验证码",
        "auth.phoneInvalid": "请输入有效的手机号。",
        "auth.smsRateLimited": "操作过于频繁，请稍后再试。",
        "auth.smsUnavailable": "短信服务暂时不可用，请稍后再试。",
        "auth.phoneCodeSent": "已收到 {phone} 的验证码请求。收到短信后，请输入验证码。",
        "auth.codePlaceholder": "输入 6 位验证码",
        "auth.verifying": "验证中…",
        "auth.verify": "验证",
        "auth.changePhone": "更换手机号",
        "auth.claimCompleteTitle": "本地进度已合并",
        "auth.claimNotFound": "没有找到可合并的本地进度。",
        "auth.claimSummary": "已合并 {stories} 个故事、{checkpoints} 个检查点，跳过 {skipped} 项。",
        "auth.claimSkipReasonSummary": "跳过原因：{reasons}",
        "auth.claimRetryHint": "本地进度合并失败，稍后可在设置中重试。",
        "auth.sameBrowserOnly": "仅限当前浏览器内的本地进度。",
        "auth.continue": "继续",
        "auth.claimSkipNotPublished": "故事未发布",
        "auth.claimSkipVersionMismatch": "版本不匹配",
        "auth.claimSkipNodeUnavailable": "节点不可用",
        "auth.claimSkipResourceUnavailable": "资源不可用",
        "auth.claimSkipAssignmentUnavailable": "分配不可用",
        "auth.claimSkipManifestInvalid": "清单无效"
      };

      function interpolate(template: string, params?: Record<string, unknown>): string {
        if (!params) return template;
        return template.split("{").map(function (part, index) {
          if (index === 0) return part;
          const close = part.indexOf("}");
          if (close === -1) return "{" + part;
          const name = part.slice(0, close);
          return String(params[name] ?? "") + part.slice(close + 1);
        }).join("");
      }

      export function useI18n() {
        return {
          locale: "zh-CN",
          t(key: string, params?: Record<string, unknown>) {
            return interpolate(LABELS[key] ?? key, params);
          },
        };
      }
    `,
  ],
  [
    "@/lib/analytics",
    `
      export function track(_event: string, _props?: Record<string, unknown>) {}
    `,
  ],
  [
    "@/lib/auth/anonymousClaimClient",
    `
      export type LocalClaimCommitResult = { migratedStories?: number };

      export async function prepareAnonymousClaimManifest() {
        const control = (window as unknown as {
          __authModalClaimControl?: {
            mode: "immediate" | "pending";
            started: number;
            resolved: number;
            pendingResolve: (() => void) | null;
            applyMode: "immediate" | "pending";
            applyStarted: number;
            applyResolved: number;
            pendingApplyResolve: (() => void) | null;
          };
        }).__authModalClaimControl;
        if (!control) throw new Error("claim control missing");
        control.started += 1;
        if (control.mode === "pending") {
          await new Promise<void>((resolve) => {
            control.pendingResolve = resolve;
          });
        }
        control.resolved += 1;
        return { generatedAt: "browser-smoke", stories: [] };
      }

      export async function applyAnonymousClaimResult(
        _userId: string,
        _claim: unknown,
      ): Promise<LocalClaimCommitResult> {
        const control = (window as unknown as {
          __authModalClaimControl?: {
            applyMode: "immediate" | "pending";
            applyStarted: number;
            applyResolved: number;
            pendingApplyResolve: (() => void) | null;
          };
        }).__authModalClaimControl;
        if (!control) throw new Error("claim control missing");
        control.applyStarted += 1;
        if (control.applyMode === "pending") {
          await new Promise<void>((resolve) => {
            control.pendingApplyResolve = resolve;
          });
        }
        control.applyResolved += 1;
        return { migratedStories: 2 };
      }
    `,
  ],
]);

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const logDir = path.join(
  repoRoot,
  ".codex-logs",
  `auth-modal-browser-${stamp}-${process.pid}`,
);
mkdirSync(logDir, { recursive: true });

let server = null;
let serverPort = 0;
let serverUrl = "";
let chromeProcess = null;
let chromeLogFd = null;
let chromeSpawnError = null;
let browserWsUrl = "";
let cdp = null;
let sessionId = "";
let userDataDir = null;
let tailwindProcess = null;

const checks = [];
const screenshots = [];
const blockedUrls = [];

const requireFromRepo = createRequire(path.join(repoRoot, "package.json"));

function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

function resolveFromRepo(specifier) {
  try {
    return requireFromRepo.resolve(specifier);
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnWithTimeout(command, args, options = {}) {
  const {
    timeoutMs = 60000,
    cwd = repoRoot,
    stdio = "ignore",
  } = options;
  const child = spawn(command, args, {
    cwd,
    windowsHide: true,
    stdio,
  });
  let settled = false;
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        // Owned child only.
      }
      reject(
        new Error(
          `Timed out after ${timeoutMs}ms: ${command} ${args.join(" ")}`,
        ),
      );
    }, timeoutMs);

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve({ code, signal });
      else {
        reject(
          new Error(
            `Exited with ${code ?? signal}: ${command} ${args.join(" ")}`,
          ),
        );
      }
    });
  });
  return { child, promise };
}

async function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(timeoutMs),
  ]);
}

function isLoopbackUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol === "data:" || url.protocol === "blob:") return true;
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
      return false;
    }
    const host = url.hostname.toLowerCase();
    return (
      host === "127.0.0.1" ||
      host === "localhost" ||
      host === "[::1]" ||
      host === "::1"
    );
  } catch {
    return false;
  }
}

class CdpClient {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.eventWaiters = new Set();
    this.eventListeners = new Set();

    ws.addEventListener("message", (event) => {
      let data;
      if (typeof event.data === "string") data = event.data;
      else if (event.data instanceof ArrayBuffer) {
        data = Buffer.from(event.data).toString("utf8");
      } else {
        data = String(event.data);
      }
      this.onMessage(data);
    });
    ws.addEventListener("close", () => {
      this.failAll(new Error("CDP websocket closed"));
    });
    ws.addEventListener("error", () => {
      this.failAll(new Error("CDP websocket error"));
    });
  }

  onMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      pending.clearTimer();
      if (message.error) {
        pending.reject(
          new Error(`${pending.method}: ${message.error.message}`),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    for (const waiter of [...this.eventWaiters]) {
      if (waiter.method !== message.method) continue;
      if (waiter.sessionId && waiter.sessionId !== message.sessionId) continue;
      this.eventWaiters.delete(waiter);
      waiter.clearTimer();
      waiter.resolve(message);
    }

    for (const listener of [...this.eventListeners]) {
      try {
        listener(message);
      } catch {
        // A listener failure must not break the CDP stream.
      }
    }
  }

  send(method, params = {}, options = {}) {
    const { sessionId: targetSession, timeoutMs = 10000 } = options;
    const id = this.nextId;
    this.nextId += 1;
    const message = { id, method, params };
    if (targetSession) message.sessionId = targetSession;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        clearTimer: () => clearTimeout(timer),
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.ws.send(JSON.stringify(message));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  waitForEvent(method, options = {}) {
    const { sessionId: targetSession, timeoutMs = 10000 } = options;
    return new Promise((resolve, reject) => {
      const waiter = {
        method,
        sessionId: targetSession,
        clearTimer: () => clearTimeout(timer),
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      const timer = setTimeout(() => {
        this.eventWaiters.delete(waiter);
        reject(new Error(`CDP event timeout after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      this.eventWaiters.add(waiter);
    });
  }

  onEvent(listener) {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  failAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const waiter of this.eventWaiters.values()) waiter.reject(error);
    this.eventWaiters.clear();
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // Best effort.
    }
  }
}

async function evaluate(expression, options = {}) {
  const { timeoutMs = 10000 } = options;
  const response = await cdp.send(
    "Runtime.evaluate",
    {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    },
    { sessionId, timeoutMs },
  );
  if (response.exceptionDetails) {
    const description =
      response.exceptionDetails.exception?.description ||
      response.exceptionDetails.text ||
      "page evaluation failed";
    throw new Error(description);
  }
  return response.result?.value;
}

async function waitForFunction(expression, options = {}) {
  const {
    label = expression,
    timeoutMs = 10000,
    intervalMs = 50,
  } = options;
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await evaluate(`Boolean(${expression})`);
      if (value) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`,
  );
}

async function waitForSelector(selector, options = {}) {
  const { present = true, timeoutMs = 10000 } = options;
  const quoted = JSON.stringify(selector);
  await waitForFunction(
    `document.querySelector(${quoted}) ${present ? "!==" : "==="} null`,
    {
      label: `${selector} ${present ? "present" : "absent"}`,
      timeoutMs,
    },
  );
}

async function queryText(selector) {
  const quoted = JSON.stringify(selector);
  return (
    (await evaluate(
      `document.querySelector(${quoted})?.innerText ?? ""`,
    )) ?? ""
  );
}

async function counters() {
  return evaluate(`(() => ({
    parent: Number(document.getElementById("parent-click-count")?.textContent ?? "0"),
    close: Number(document.getElementById("close-count")?.textContent ?? "0"),
    success: Number(document.getElementById("success-count")?.textContent ?? "0")
  }))()`);
}

async function bodyState() {
  return evaluate(`(() => ({
    overflow: document.body.style.overflow,
    activeId: document.activeElement?.id ?? "",
    activeTag: document.activeElement?.tagName ?? "",
    activeAriaLabel: document.activeElement?.getAttribute?.("aria-label") ?? ""
  }))()`);
}

async function elementBox(selector) {
  const quoted = JSON.stringify(selector);
  return evaluate(`(() => {
    const el = document.querySelector(${quoted});
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
      disabled: !!el.disabled,
      text: (el.innerText ?? "").trim(),
      ariaLabel: el.getAttribute("aria-label") ?? ""
    };
  })()`);
}

async function visibleAt(selector) {
  const quoted = JSON.stringify(selector);
  return evaluate(`(() => {
    const el = document.querySelector(${quoted});
    if (!el) return { found: false };
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      found: true,
      hit: !!hit && (hit === el || el.contains(hit)),
      x,
      y,
      width: rect.width,
      height: rect.height,
      disabled: !!el.disabled
    };
  })()`);
}

function setValueExpression(selector, value) {
  const quoted = JSON.stringify(selector);
  const quotedValue = JSON.stringify(value);
  return `(() => {
    const el = document.querySelector(${quoted});
    if (!el) return false;
    const proto = Object.getPrototypeOf(el);
    const descriptor =
      Object.getOwnPropertyDescriptor(proto, "value") ||
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    if (!descriptor || !descriptor.set) return false;
    descriptor.set.call(el, ${quotedValue});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`;
}

async function clickAt(x, y) {
  await cdp.send(
    "Input.dispatchMouseEvent",
    { type: "mouseMoved", x, y },
    { sessionId },
  );
  await cdp.send(
    "Input.dispatchMouseEvent",
    {
      type: "mousePressed",
      x,
      y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    },
    { sessionId },
  );
  await cdp.send(
    "Input.dispatchMouseEvent",
    {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    },
    { sessionId },
  );
}

async function clickSelector(selector) {
  const box = await elementBox(selector);
  assert.ok(box, `missing element ${selector}`);
  assert.ok(
    box.width > 0 && box.height > 0,
    `element ${selector} has no clickable box`,
  );
  await clickAt(box.x, box.y);
  return box;
}

async function pressKey(key, modifiers = 0) {
  const base = {
    key: key.key,
    code: key.code,
    windowsVirtualKeyCode: key.vk,
    nativeVirtualKeyCode: key.vk,
    modifiers,
  };
  await cdp.send(
    "Input.dispatchKeyEvent",
    { type: "rawKeyDown", ...base },
    { sessionId },
  );
  await cdp.send(
    "Input.dispatchKeyEvent",
    { type: "keyUp", ...base },
    { sessionId },
  );
}

async function screenshot(name) {
  const result = await cdp.send(
    "Page.captureScreenshot",
    { format: "png", fromSurface: true, captureBeyondViewport: false },
    { sessionId, timeoutMs: 15000 },
  );
  const file = path.join(logDir, name);
  writeFileSync(file, Buffer.from(result.data, "base64"));
  screenshots.push(file);
  return file;
}

async function setViewport(width, height) {
  await cdp.send(
    "Emulation.setDeviceMetricsOverride",
    {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: width,
      screenHeight: height,
    },
    { sessionId },
  );
}

async function navigate(url) {
  const loaded = cdp.waitForEvent("Page.loadEventFired", {
    sessionId,
    timeoutMs: 15000,
  });
  const result = await cdp.send(
    "Page.navigate",
    { url },
    { sessionId, timeoutMs: 15000 },
  );
  if (result?.errorText) {
    throw new Error(`Navigation failed: ${result.errorText}`);
  }
  await loaded;
}

async function openModal() {
  await evaluate('document.getElementById("open-auth-modal")?.focus()');
  await clickSelector("#open-auth-modal");
  await waitForSelector(DIALOG_SELECTOR);
  await sleep(150);
}

function createStubPlugin() {
  const namespace = "auth-modal-smoke-stub";
  const exactPaths = new Set(STUB_SOURCES.keys());
  return {
    name: "auth-modal-smoke-stubs",
    setup(build) {
      build.onResolve(
        {
          filter:
            /^@\/(components\/AiUserLoginButton|lib\/i18n\/client|lib\/analytics|lib\/auth\/anonymousClaimClient)$/,
        },
        (args) => {
          if (exactPaths.has(args.path)) {
            return { path: args.path, namespace };
          }
          return undefined;
        },
      );

      build.onLoad({ filter: /.*/, namespace }, (args) => {
        const contents = STUB_SOURCES.get(args.path);
        if (!contents) return undefined;
        return {
          contents,
          loader: "tsx",
          resolveDir: repoRoot,
        };
      });

      build.onResolve({ filter: /^@\// }, (args) => {
        if (exactPaths.has(args.path)) return undefined;
        const target = path.join(repoRoot, args.path.slice(2));
        const candidates = [
          target,
          `${target}.tsx`,
          `${target}.ts`,
          `${target}.jsx`,
          `${target}.js`,
          `${target}.mjs`,
          path.join(target, "index.tsx"),
          path.join(target, "index.ts"),
        ];
        for (const candidate of candidates) {
          try {
            if (existsSync(candidate) && statSync(candidate).isFile()) {
              return { path: candidate };
            }
          } catch {
            // Keep looking.
          }
        }
        return undefined;
      });
    },
  };
}

async function buildBundle() {
  const esbuildMain = firstExisting([
    path.join(
      repoRoot,
      "node_modules",
      ".pnpm",
      "esbuild@0.28.1",
      "node_modules",
      "esbuild",
      "lib",
      "main.js",
    ),
    path.join(repoRoot, "node_modules", "esbuild", "lib", "main.js"),
    resolveFromRepo("esbuild"),
  ]);
  assert.ok(
    esbuildMain,
    `esbuild not found. Expected ${path.join(repoRoot, "node_modules", ".pnpm", "esbuild@0.28.1", "node_modules", "esbuild", "lib", "main.js")}`,
  );
  const importedEsbuild = await import(pathToFileURL(esbuildMain).href);
  const esbuild = importedEsbuild.default ?? importedEsbuild;
  const esbuildBuild = esbuild.build ?? importedEsbuild.build;
  assert.equal(
    typeof esbuildBuild,
    "function",
    "esbuild did not expose a build() function",
  );
  const options = {
    absWorkingDir: repoRoot,
    entryPoints: [FIXTURE_PATH],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: ["chrome120"],
    jsx: "automatic",
    jsxImportSource: "react",
    sourcemap: false,
    legalComments: "none",
    logLevel: "silent",
    nodePaths: [path.join(repoRoot, "node_modules")],
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [createStubPlugin()],
  };
  const tsconfigPath = path.join(repoRoot, "tsconfig.json");
  if (existsSync(tsconfigPath)) options.tsconfig = tsconfigPath;

  const result = await esbuildBuild(options);
  const output =
    result.outputFiles?.find((file) => file.path.endsWith(".js")) ||
    result.outputFiles?.[0];
  assert.ok(output, "esbuild did not produce a browser bundle");
  return output.text;
}

async function buildTailwindCss() {
  const tailwindCli = firstExisting([
    path.join(repoRoot, "node_modules", "tailwindcss", "lib", "cli.js"),
    resolveFromRepo("tailwindcss/lib/cli.js"),
  ]);
  assert.ok(
    tailwindCli,
    `Tailwind CLI not found at ${path.join(repoRoot, "node_modules", "tailwindcss", "lib", "cli.js")}`,
  );

  const inputPath = path.join(logDir, "tailwind.input.css");
  const outputPath = path.join(logDir, "tailwind.output.css");
  const configPath = path.join(logDir, "tailwind.config.cjs");
  writeFileSync(
    inputPath,
    "@tailwind base;\n@tailwind components;\n@tailwind utilities;\n",
  );

  const content = [
    AUTH_MODAL_PATH,
    FIXTURE_PATH,
  ].map((file) => file.replace(/\\/g, "/"));
  writeFileSync(
    configPath,
    `module.exports = {\n  content: ${JSON.stringify(content)},\n  theme: { extend: {} },\n  plugins: [],\n};\n`,
  );

  const logFd = openSync(path.join(logDir, "tailwind.log"), "a");
  try {
    const { child, promise } = spawnWithTimeout(
      process.execPath,
      [
        tailwindCli,
        "--input",
        inputPath,
        "--output",
        outputPath,
        "--config",
        configPath,
        "--minify",
      ],
      {
        timeoutMs: 60000,
        stdio: ["ignore", logFd, logFd],
      },
    );
    tailwindProcess = child;
    await promise;
  } finally {
    tailwindProcess = null;
    try {
      closeSync(logFd);
    } catch {
      // Already closed.
    }
  }

  assert.ok(existsSync(outputPath), "Tailwind did not produce CSS");
  const css = readFileSync(outputPath, "utf8");
  assert.ok(css.length > 0, "Tailwind produced empty CSS");
  return css;
}

async function startServer(bundle, css) {
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AuthModal browser smoke</title>
  <link rel="stylesheet" href="/styles.css" />
  <style>
    html, body { margin: 0; min-height: 100%; }
    body { font-family: system-ui, sans-serif; background: #e2e8f0; }
    .smoke-page { min-height: 100vh; padding: 24px; box-sizing: border-box; }
  </style>
</head>
<body>
  <main class="smoke-page"><div id="root"></div></main>
  <script src="/bundle.js"></script>
</body>
</html>`;

  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/") {
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(html);
      return;
    }
    if (url.pathname === "/bundle.js") {
      response.writeHead(200, {
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(bundle);
      return;
    }
    if (url.pathname === "/styles.css") {
      response.writeHead(200, {
        "Content-Type": "text/css; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(css);
      return;
    }
    if (
      url.pathname === "/api/auth/phone/verify"
      && request.method === "POST"
    ) {
      let raw = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        if (raw.length < 32_768) raw += chunk;
      });
      request.on("end", () => {
        let payload = null;
        try {
          payload = JSON.parse(raw);
        } catch {
          // The assertion below returns a bounded fixture error.
        }
        if (
          !payload
          || payload.challengeId !== "challenge-browser-smoke"
          || payload.code !== "123456"
        ) {
          response.writeHead(400, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
          });
          response.end(JSON.stringify({ code: "OTP_INVALID_OR_EXPIRED" }));
          return;
        }
        response.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "Set-Cookie":
            "aistory_user_session=browser-smoke-session; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600",
        });
        response.end(JSON.stringify({
          account: { userId: "browser-smoke-user" },
          claim: {
            status: "applied",
            counts: {
              inheritedStories: 2,
              inheritedCheckpoints: 5,
              skipped: 1,
            },
            skippedByReason: { not_published: 1 },
          },
        }));
      });
      return;
    }
    if (url.pathname === "/api/account/me" && request.method === "GET") {
      const hasSession = String(request.headers.cookie ?? "")
        .split(";")
        .map((part) => part.trim())
        .includes("aistory_user_session=browser-smoke-session");
      response.writeHead(hasSession ? 200 : 401, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "private, no-store",
      });
      response.end(JSON.stringify(hasSession
        ? {
            authenticated: true,
            account: {
              authType: "phone",
              displayName: "Browser smoke phone user",
              balance: 1000,
            },
          }
        : { authenticated: false, account: null }));
      return;
    }
    if (url.pathname === "/favicon.ico") {
      response.writeHead(204);
      response.end();
      return;
    }
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("not found");
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  assert.ok(address && typeof address === "object", "server address missing");
  serverPort = address.port;
  serverUrl = `http://127.0.0.1:${serverPort}/`;
}

async function waitForDevToolsActivePort(timeoutMs) {
  const file = path.join(userDataDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (chromeSpawnError) throw chromeSpawnError;
    if (chromeProcess && chromeProcess.exitCode !== null) {
      throw new Error(
        `Chromium exited early with code ${chromeProcess.exitCode}; see ${path.join(logDir, "chrome.log")}`,
      );
    }
    try {
      if (existsSync(file)) {
        const lines = readFileSync(file, "utf8").trim().split(/\r?\n/);
        const port = Number(lines[0]);
        const wsPath = lines[1];
        if (Number.isInteger(port) && port > 0 && wsPath) {
          return { port, wsPath };
        }
      }
    } catch {
      // The file can be mid-write; retry.
    }
    await sleep(100);
  }
  throw new Error(
    `Timed out waiting for DevToolsActivePort; see ${path.join(logDir, "chrome.log")}`,
  );
}

async function launchChrome() {
  assert.ok(
    existsSync(CHROME_EXECUTABLE),
    `Chromium not found at ${CHROME_EXECUTABLE}`,
  );
  userDataDir = mkdtempSync(path.join(os.tmpdir(), "auth-modal-chrome-"));
  chromeLogFd = openSync(path.join(logDir, "chrome.log"), "a");
  chromeSpawnError = null;

  const args = [
    "--headless",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--hide-scrollbars",
    "--mute-audio",
    "about:blank",
  ];

  chromeProcess = spawn(CHROME_EXECUTABLE, args, {
    windowsHide: true,
    stdio: ["ignore", chromeLogFd, chromeLogFd],
  });
  chromeProcess.once("error", (error) => {
    chromeSpawnError = error;
  });

  const { port, wsPath } = await waitForDevToolsActivePort(20000);
  browserWsUrl = `ws://127.0.0.1:${port}${wsPath}`;
}

async function connectCdp() {
  assert.equal(
    typeof WebSocket,
    "function",
    "Node 22+ global WebSocket is required",
  );
  const ws = new WebSocket(browserWsUrl);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Timed out connecting to Chromium CDP"));
      }, 10000);
      ws.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      ws.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("Failed to connect to Chromium CDP"));
        },
        { once: true },
      );
    });
  } catch (error) {
    try {
      ws.close();
    } catch {
      // Best effort.
    }
    throw error;
  }
  cdp = new CdpClient(ws);
}

async function setupPage() {
  const created = await cdp.send("Target.createTarget", {
    url: "about:blank",
  });
  const attached = await cdp.send("Target.attachToTarget", {
    targetId: created.targetId,
    flatten: true,
  });
  sessionId = attached.sessionId;

  await cdp.send("Page.enable", {}, { sessionId });
  await cdp.send("Runtime.enable", {}, { sessionId });
  await cdp.send(
    "Page.addScriptToEvaluateOnNewDocument",
    {
      source:
        'try { window.localStorage.clear(); } catch (error) { void error; }',
    },
    { sessionId },
  );

  cdp.onEvent((event) => {
    if (event.method !== "Fetch.requestPaused" || event.sessionId !== sessionId) {
      return;
    }
    const { requestId, request } = event.params;
    if (isLoopbackUrl(request.url)) {
      void cdp
        .send(
          "Fetch.continueRequest",
          { requestId },
          { sessionId, timeoutMs: 10000 },
        )
        .catch(() => {});
      return;
    }
    blockedUrls.push(request.url);
    void cdp
      .send(
        "Fetch.failRequest",
        { requestId, errorReason: "BlockedByClient" },
        { sessionId, timeoutMs: 10000 },
      )
      .catch(() => {});
  });

  await cdp.send(
    "Fetch.enable",
    { patterns: [{ urlPattern: "*", requestStage: "Request" }] },
    { sessionId },
  );
}

async function check(name, run) {
  try {
    const detail = await run();
    checks.push({ name, ok: true, detail });
    console.log(`ok - ${name}`);
  } catch (error) {
    checks.push({ name, ok: false, error: error.message });
    throw error;
  }
}

async function runViewport(viewport) {
  const tag = `${viewport.width}x${viewport.height}`;

  await setViewport(viewport.width, viewport.height);
  await navigate(`${serverUrl}?viewport=${tag}&run=${Date.now()}`);
  await waitForSelector("#open-auth-modal");

  const initialBodyOverflow = await evaluate("document.body.style.overflow");

  await check(`${tag} fixture is a 130px clipped profile shell`, async () => {
    const shell = await evaluate(`(() => {
      const el = document.getElementById("profile-like-shell");
      if (!el) return null;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return {
        height: style.height,
        rectHeight: rect.height,
        overflow: style.overflow,
        backdropFilter: style.backdropFilter || style.webkitBackdropFilter || ""
      };
    })()`);
    assert.ok(shell, "profile-like shell missing");
    assert.equal(shell.height, "130px");
    assert.ok(Math.abs(shell.rectHeight - 130) <= 0.5);
    assert.equal(shell.overflow, "hidden");
    assert.match(shell.backdropFilter, /blur\(18px\)/);
    return shell;
  });

  await openModal();

  await check(`${tag} portals out of clipped shell into body`, async () => {
    const state = await evaluate(`(() => {
      const dialog = document.querySelector(${JSON.stringify(DIALOG_SELECTOR)});
      const portalRoot = dialog?.parentElement;
      const shell = document.getElementById("profile-like-shell");
      if (!dialog || !portalRoot || !shell) return null;
      return {
        portalParentIsBody: portalRoot.parentElement === document.body,
        dialogInsideShell: shell.contains(dialog),
        portalPosition: getComputedStyle(portalRoot).position,
        portalPadding: portalRoot.style.padding,
        bodyOverflow: document.body.style.overflow,
        dialogMaxHeight: dialog.style.maxHeight
      };
    })()`);
    assert.ok(state, "dialog or portal root missing");
    assert.equal(state.portalParentIsBody, true);
    assert.equal(state.dialogInsideShell, false);
    assert.equal(state.portalPosition, "fixed");
    assert.match(state.portalPadding, /safe-area-inset-top/);
    assert.match(state.dialogMaxHeight, /100dvh/);
    assert.equal(state.bodyOverflow, "hidden");
    return state;
  });

  await check(`${tag} dialog box fits viewport with scrollable body`, async () => {
    const layout = await evaluate(`(() => {
      const dialog = document.querySelector(${JSON.stringify(DIALOG_SELECTOR)});
      if (!dialog) return null;
      const rect = dialog.getBoundingClientRect();
      const scroller = dialog.children[1];
      return {
        bbox: {
          top: rect.top,
          left: rect.left,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height
        },
        viewport: { width: innerWidth, height: innerHeight },
        scroller: scroller
          ? {
              overflowY: getComputedStyle(scroller).overflowY,
              scrollHeight: scroller.scrollHeight,
              clientHeight: scroller.clientHeight
            }
          : null
      };
    })()`);
    assert.ok(layout, "dialog missing");
    assert.ok(layout.bbox.top >= -0.5, `top overflow: ${layout.bbox.top}`);
    assert.ok(layout.bbox.left >= -0.5, `left overflow: ${layout.bbox.left}`);
    assert.ok(
      layout.bbox.right <= layout.viewport.width + 0.5,
      `right overflow: ${layout.bbox.right} > ${layout.viewport.width}`,
    );
    assert.ok(
      layout.bbox.bottom <= layout.viewport.height + 0.5,
      `bottom overflow: ${layout.bbox.bottom} > ${layout.viewport.height}`,
    );
    assert.ok(layout.bbox.width > 0 && layout.bbox.height > 0);
    assert.ok(layout.scroller, "scrollable body missing");
    assert.equal(layout.scroller.overflowY, "auto");
    assert.ok(layout.scroller.scrollHeight >= layout.scroller.clientHeight);
    return layout;
  });

  await check(`${tag} close button is at least 44px`, async () => {
    const close = await elementBox(CLOSE_BUTTON_SELECTOR);
    assert.ok(close, "close button missing");
    assert.ok(
      close.width >= 44 - 0.5,
      `close width ${close.width} is below 44`,
    );
    assert.ok(
      close.height >= 44 - 0.5,
      `close height ${close.height} is below 44`,
    );
    return close;
  });

  await check(`${tag} phone input and send button are hit-testable`, async () => {
    const phone = await visibleAt(PHONE_INPUT_SELECTOR);
    assert.equal(phone.found, true, "phone input missing");
    assert.equal(phone.hit, true, "phone input is not hit-testable");
    const send = await visibleAt(PRIMARY_BUTTON_SELECTOR);
    assert.equal(send.found, true, "send button missing");
    assert.equal(send.hit, true, "send button is not hit-testable");
    return { phone, send };
  });

  await check(`${tag} initial focus lands on the phone input`, async () => {
    await waitForFunction(
      `document.activeElement === document.querySelector(${JSON.stringify(PHONE_INPUT_SELECTOR)})`,
      { label: "phone input focus" },
    );
    return bodyState();
  });

  await check(`${tag} Tab and Shift+Tab wrap inside the dialog`, async () => {
    await evaluate(
      `document.querySelector(${JSON.stringify(PHONE_INPUT_SELECTOR)})?.focus()`,
    );
    await pressKey(KEY_TAB);
    await waitForFunction(
      `document.activeElement === document.querySelector(${JSON.stringify(CLOSE_BUTTON_SELECTOR)})`,
      { label: "Tab wrap to close button" },
    );
    await pressKey(KEY_TAB, 8);
    await waitForFunction(
      `document.activeElement === document.querySelector(${JSON.stringify(PHONE_INPUT_SELECTOR)})`,
      { label: "Shift+Tab wrap to phone input" },
    );
    return bodyState();
  });

  await check(`${tag} Escape closes, restores focus and body overflow`, async () => {
    await pressKey(KEY_ESCAPE);
    await waitForSelector(DIALOG_SELECTOR, { present: false });
    await sleep(100);
    const state = await bodyState();
    const counts = await counters();
    assert.equal(state.activeId, "open-auth-modal");
    assert.equal(state.overflow, initialBodyOverflow);
    assert.equal(counts.close, 1);
    assert.equal(counts.parent, 0);
    return { state, counts };
  });

  await openModal();

  await check(`${tag} backdrop click closes exactly once without leakage`, async () => {
    const before = await counters();
    await clickAt(5, 5);
    await waitForSelector(DIALOG_SELECTOR, { present: false });
    await sleep(100);
    const after = await counters();
    assert.equal(after.close, before.close + 1);
    assert.equal(after.parent, before.parent);
    assert.equal(after.success, before.success);
    const state = await bodyState();
    assert.equal(state.overflow, initialBodyOverflow);
    assert.equal(
      await evaluate(
        `document.querySelector(${JSON.stringify(DIALOG_SELECTOR)}) === null`,
      ),
      true,
    );
    return { before, after, state };
  });

  await openModal();

  await check(`${tag} phone request advances to OTP with autofocus`, async () => {
    await evaluate('window.__authModalMock.setClaimMode("pending")');
    await evaluate(setValueExpression(PHONE_INPUT_SELECTOR, "13800138000"));
    await waitForFunction(
      `(() => {
        const button = document.querySelector(${JSON.stringify(PRIMARY_BUTTON_SELECTOR)});
        return !!button && !button.disabled;
      })()`,
      { label: "send button enabled" },
    );
    await screenshot(`phone-input-${tag}.png`);
    await clickSelector(PRIMARY_BUTTON_SELECTOR);
    await waitForSelector(OTP_INPUT_SELECTOR);
    await waitForFunction(
      `document.activeElement === document.querySelector(${JSON.stringify(OTP_INPUT_SELECTOR)})`,
      { label: "OTP autofocus" },
    );
    const counts = await evaluate("window.__authModalMock.getCounts()");
    assert.equal(counts.request, 1);
    assert.equal(counts.receiverMismatch, 0);
    assert.equal(counts.claimStarted, 1, "claim preparation was not prewarmed");
    assert.equal(counts.claimResolved, 0, "pending claim unexpectedly resolved");
    return counts;
  });

  await check(`${tag} phone switch and reopen clear stale verification state`, async () => {
    const changed = await evaluate(`(() => {
      const buttons = [...document.querySelectorAll(${JSON.stringify(DIALOG_SELECTOR + " button")})];
      const button = buttons.find((item) => item.textContent?.includes("更换手机号"));
      if (!button) return false;
      button.click();
      return true;
    })()`);
    assert.equal(changed, true, "change-phone button missing");
    await waitForSelector(PHONE_INPUT_SELECTOR);
    await waitForSelector(OTP_INPUT_SELECTOR, { present: false });
    const preservedPhone = await evaluate(
      `document.querySelector(${JSON.stringify(PHONE_INPUT_SELECTOR)})?.value ?? ""`,
    );
    assert.equal(preservedPhone, "13800138000");

    await pressKey(KEY_ESCAPE);
    await waitForSelector(DIALOG_SELECTOR, { present: false });
    await openModal();
    const reopenedPhone = await evaluate(
      `document.querySelector(${JSON.stringify(PHONE_INPUT_SELECTOR)})?.value ?? ""`,
    );
    assert.equal(reopenedPhone, "", "close/reopen retained a stale phone flow");
    await evaluate(`(() => {
      localStorage.clear();
      window.dispatchEvent(new Event("aistory:phone-otp-cooldown"));
      window.__authModalMock.resetCounts();
      window.__authModalMock.setClaimMode("pending");
    })()`);
    return { preservedPhone, reopenedPhone };
  });

  await check(`${tag} fresh request after reset gets a new active challenge`, async () => {
    await evaluate(setValueExpression(PHONE_INPUT_SELECTOR, "13800138000"));
    await waitForFunction(
      `(() => {
        const button = document.querySelector(${JSON.stringify(PRIMARY_BUTTON_SELECTOR)});
        return !!button && !button.disabled;
      })()`,
      { label: "fresh send button enabled" },
    );
    await clickSelector(PRIMARY_BUTTON_SELECTOR);
    await waitForSelector(OTP_INPUT_SELECTOR);
    const counts = await evaluate("window.__authModalMock.getCounts()");
    assert.equal(counts.request, 1);
    assert.equal(counts.claimStarted, 1);
    assert.equal(counts.claimResolved, 0);
    assert.equal(counts.receiverMismatch, 0);
    return counts;
  });

  await check(`${tag} duplicate verify is suppressed while pending`, async () => {
    await evaluate('window.__authModalMock.setVerifyMode("pending")');
    await evaluate(setValueExpression(OTP_INPUT_SELECTOR, "123456"));
    await waitForFunction(
      `(() => {
        const button = document.querySelector(${JSON.stringify(PRIMARY_BUTTON_SELECTOR)});
        return !!button && !button.disabled;
      })()`,
      { label: "verify button enabled" },
    );
    await evaluate(
      `document.querySelector(${JSON.stringify(OTP_INPUT_SELECTOR)})?.focus()`,
    );
    await pressKey(KEY_ENTER);
    await sleep(25);
    await pressKey(KEY_ENTER);
    await waitForFunction(
      "window.__authModalMock.getCounts().verify === 1",
      { label: "verify dispatch after bounded claim wait", timeoutMs: 2000 },
    );
    const counts = await evaluate("window.__authModalMock.getCounts()");
    assert.equal(counts.request, 1);
    assert.equal(
      counts.verify,
      1,
      "repeated Enter must not start a second verify",
    );
    assert.equal(counts.receiverMismatch, 0, "browser fetch receiver was lost");
    assert.equal(
      counts.claimResolved,
      0,
      "verify should dispatch after the claim deadline while claim stays pending",
    );
    const claimResolved = await evaluate(
      "window.__authModalMock.resolveClaim()",
    );
    assert.equal(claimResolved, true, "pending claim was not waiting");
    await sleep(50);
    const afterLateClaim = await evaluate(
      "window.__authModalMock.getCounts()",
    );
    assert.equal(afterLateClaim.claimResolved, 1);
    assert.equal(
      afterLateClaim.verify,
      1,
      "late claim resolution must not replay verify",
    );
    return afterLateClaim;
  });

  await check(`${tag} verify 403 shows safe copy, not raw Unauthorized`, async () => {
    const resolved = await evaluate(
      `window.__authModalMock.resolvePending(403, {
        error: "Unauthorized",
        code: "FORBIDDEN",
        message: "raw server text should never render"
      })`,
    );
    assert.equal(resolved, true, "pending verify was not waiting");
    await waitForFunction(
      `(() => {
        const dialog = document.querySelector(${JSON.stringify(DIALOG_SELECTOR)});
        return !!dialog && dialog.innerText.includes("登录服务暂时不可用");
      })()`,
      { label: "safe service-unavailable copy" },
    );
    await sleep(100);
    const text = await queryText(DIALOG_SELECTOR);
    assert.ok(text.includes("登录服务暂时不可用"));
    assert.ok(!text.includes("Unauthorized"));
    assert.ok(!text.toLowerCase().includes("forbidden"));
    assert.ok(!text.includes("raw server text"));
    assert.ok(!text.toLowerCase().includes("error"));
    return { safeCopy: true };
  });

  await check(`${tag} late 200 after close reconciles account exactly once`, async () => {
    await evaluate('window.__authModalMock.setVerifyMode("pending")');
    await evaluate(
      `document.querySelector(${JSON.stringify(OTP_INPUT_SELECTOR)})?.focus()`,
    );
    await pressKey(KEY_ENTER);
    await waitForFunction(
      "window.__authModalMock.getCounts().verify === 2",
      { label: "second pending verify before close" },
    );
    await pressKey(KEY_ESCAPE);
    await waitForSelector(DIALOG_SELECTOR, { present: false });
    const resolved = await evaluate(
      `window.__authModalMock.resolvePending(200, {
        account: { userId: "browser-smoke-user" }
      })`,
    );
    assert.equal(resolved, true);
    await waitForFunction(
      "window.__authModalMock.getCounts().accountChanged === 1",
      { label: "account reconciliation after close" },
    );
    await sleep(50);
    const counts = await evaluate("window.__authModalMock.getCounts()");
    assert.equal(counts.accountChanged, 1);
    assert.equal(counts.claimApplyStarted, 0);
    assert.equal(counts.verify, 2);
    assert.equal(
      await evaluate(
        `document.querySelector(${JSON.stringify(DIALOG_SELECTOR)}) === null`,
      ),
      true,
    );
    return counts;
  });

  await check(`${tag} fresh modal remains usable after close-race reconciliation`, async () => {
    await openModal();
    await evaluate(`(() => {
      localStorage.clear();
      window.dispatchEvent(new Event("aistory:phone-otp-cooldown"));
      window.__authModalMock.resetCounts();
    })()`);
    await evaluate(setValueExpression(PHONE_INPUT_SELECTOR, "13800138000"));
    await waitForFunction(
      `(() => {
        const button = document.querySelector(${JSON.stringify(PRIMARY_BUTTON_SELECTOR)});
        return !!button && !button.disabled;
      })()`,
      { label: "post-close-race send button enabled" },
    );
    await clickSelector(PRIMARY_BUTTON_SELECTOR);
    await waitForSelector(OTP_INPUT_SELECTOR);
    const counts = await evaluate("window.__authModalMock.getCounts()");
    assert.equal(counts.request, 1);
    assert.equal(counts.claimStarted, 1);
    assert.equal(counts.claimResolved, 1);
    assert.equal(counts.accountChanged, 0);
    return counts;
  });

  await check(`${tag} successful claim hides requirement and stale error`, async () => {
    await evaluate('window.__authModalMock.setVerifyMode("success")');
    await evaluate('window.__authModalMock.setClaimApplyMode("pending")');
    await evaluate(setValueExpression(OTP_INPUT_SELECTOR, "123456"));
    await evaluate(
      `document.querySelector(${JSON.stringify(OTP_INPUT_SELECTOR)})?.focus()`,
    );
    await pressKey(KEY_ENTER);
    await waitForFunction(
      'document.body.innerText.includes("本地进度已合并")',
      { label: "claim-result screen" },
    );
    await sleep(150);
    const text = await queryText(DIALOG_SELECTOR);
    assert.ok(text.includes("本地进度已合并"));
    assert.ok(text.includes("故事未发布"), "claim skip warning was lost");
    assert.ok(
      text.includes("本地进度合并失败"),
      "bounded pending local commit did not show its safe retry warning",
    );
    assert.ok(!text.includes("平台消耗"), "stale requirement is visible");
    assert.ok(!text.includes("Unauthorized"));
    assert.ok(!text.toLowerCase().includes("forbidden"));
    assert.ok(!text.includes("raw server text"));
    assert.ok(
      !text.includes("登录服务暂时不可用"),
      "stale verify error is visible",
    );
    const beforeLateApply = await evaluate(
      "window.__authModalMock.getCounts()",
    );
    assert.equal(beforeLateApply.claimApplyStarted, 1);
    assert.equal(beforeLateApply.claimApplyResolved, 0);
    assert.equal(beforeLateApply.accountChanged, 1);
    const applyResolved = await evaluate(
      "window.__authModalMock.resolveClaimApply()",
    );
    assert.equal(applyResolved, true, "pending local commit was not waiting");
    await sleep(50);
    const afterLateApply = await evaluate(
      "window.__authModalMock.getCounts()",
    );
    assert.equal(afterLateApply.claimApplyResolved, 1);
    assert.equal(afterLateApply.accountChanged, 1);
    assert.equal(afterLateApply.verify, beforeLateApply.verify);
    return { text, beforeLateApply, afterLateApply };
  });

  await check(`${tag} verify Set-Cookie survives account/me round trip`, async () => {
    const account = await evaluate(
      "window.__authModalMock.readAccount()",
    );
    assert.equal(account.authenticated, true);
    assert.equal(account.account?.authType, "phone");
    assert.equal(account.account?.balance, 1000);
    const visibleCookie = await evaluate(
      "window.__authModalMock.getDocumentCookie()",
    );
    assert.ok(
      !String(visibleCookie).includes("aistory_user_session"),
      "HttpOnly session cookie leaked to document.cookie",
    );
    return { account, httpOnly: true };
  });

  await check(`${tag} success content can scroll into view`, async () => {
    const result = await evaluate(`(() => {
      const dialog = document.querySelector(${JSON.stringify(DIALOG_SELECTOR)});
      const scroller = dialog?.children[1];
      const button = dialog?.querySelector(${JSON.stringify(PRIMARY_BUTTON_SELECTOR)});
      if (!dialog || !scroller || !button) return { found: false };
      const before = button.getBoundingClientRect();
      const bottomVisibleBefore = before.bottom <= innerHeight + 0.5;
      if (!bottomVisibleBefore) scroller.scrollTop = scroller.scrollHeight;
      const after = button.getBoundingClientRect();
      return {
        found: true,
        bottomVisibleBefore,
        bottomVisibleAfter: after.bottom <= innerHeight + 0.5,
        scrollTop: scroller.scrollTop,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
        overflowY: getComputedStyle(scroller).overflowY
      };
    })()`);
    assert.equal(result.found, true);
    assert.equal(result.overflowY, "auto");
    assert.equal(result.bottomVisibleAfter, true);
    await screenshot(`success-${tag}.png`);
    return result;
  });

  await check(`${tag} continue succeeds once and restores body overflow`, async () => {
    await clickSelector(PRIMARY_BUTTON_SELECTOR);
    await waitForSelector(DIALOG_SELECTOR, { present: false });
    await sleep(100);
    const counts = await counters();
    assert.equal(counts.success, 1);
    assert.equal(counts.parent, 0);
    assert.equal(
      await evaluate("document.body.style.overflow"),
      initialBodyOverflow,
    );
    return counts;
  });
}

function writeReport(ok, error) {
  const report = {
    ok,
    generatedAt: new Date().toISOString(),
    runCommand: RUN_COMMAND,
    repoRoot,
    logDir,
    viewports: VIEWPORTS.map(({ width, height }) => `${width}x${height}`),
    checks,
    screenshots,
    blockedNonLoopbackRequests: blockedUrls,
    attribution: {
      mockedApis:
        "The phone request and pending/error verify cases are mocked in-page; successful verify plus account/me use this test's loopback HTTP fixture and HttpOnly cookie. No live SMS is sent.",
      device:
        "Headless Chromium viewport emulation (390x844, 390x420, 1280x800), not a physical mobile device.",
      stubbedIntegrations: [
        "@/components/AiUserLoginButton",
        "@/lib/i18n/client",
        "@/lib/analytics",
        "@/lib/auth/anonymousClaimClient",
      ],
      actualModules: [
        "components/AuthModal.tsx",
        "lib/auth/authModalPresentation.ts",
        "lib/auth/phoneOtpCooldown.ts",
        "lib/auth/phoneOtpModalVerification.ts",
      ],
      tailwind:
        "Generated minimal config; content limited to AuthModal and the harness fixture.",
      network:
        "Non-loopback page network is denied with CDP Fetch interception.",
    },
    error: error
      ? {
          name: error.name,
          message: error.message,
          stack: error.stack,
        }
      : null,
  };

  writeFileSync(
    path.join(logDir, "report.json"),
    JSON.stringify(report, null, 2),
  );

  const failed = checks.filter((entry) => !entry.ok);
  const lines = [
    `# AuthModal browser smoke ${ok ? "passed" : "failed"}`,
    "",
    `- Run command: \`${RUN_COMMAND}\``,
    `- Generated: ${report.generatedAt}`,
    `- Viewports: ${report.viewports.join(", ")}`,
    `- Checks: ${checks.length - failed.length} passed, ${failed.length} failed`,
    "",
    "## Attribution",
    "",
    `- ${report.attribution.mockedApis}`,
    `- ${report.attribution.device}`,
    `- ${report.attribution.network}`,
    `- ${report.attribution.tailwind}`,
    `- Stubbed integrations: ${report.attribution.stubbedIntegrations.join(", ")}`,
    `- Actual modules: ${report.attribution.actualModules.join(", ")}`,
    "",
    "## Checks",
    "",
    ...checks.map(
      (entry) =>
        `- ${entry.ok ? "PASS" : "FAIL"} ${entry.name}${
          entry.error ? `: ${entry.error}` : ""
        }`,
    ),
    "",
    "## Screenshots",
    "",
    ...screenshots.map((file) => `- ${file}`),
  ];
  if (error) {
    lines.push("", "## Error", "", "```", error.stack || error.message, "```");
  }
  writeFileSync(path.join(logDir, "report.md"), `${lines.join("\n")}\n`);
}

async function cleanup() {
  if (cdp) {
    try {
      await cdp.send("Browser.close", {}, { timeoutMs: 3000 });
    } catch {
      // The browser often closes the websocket before replying.
    }
    cdp.close();
    cdp = null;
  }

  if (chromeProcess && chromeProcess.exitCode === null) {
    const pid = chromeProcess.pid;
    try {
      chromeProcess.kill();
    } catch {
      // Best effort on our own child.
    }
    await waitForExit(chromeProcess, 2000);
    if (chromeProcess.exitCode === null && pid) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Best effort on our own PID only.
      }
    }
  }

  if (chromeLogFd !== null) {
    try {
      closeSync(chromeLogFd);
    } catch {
      // Already closed.
    }
    chromeLogFd = null;
  }

  if (tailwindProcess && tailwindProcess.exitCode === null) {
    try {
      tailwindProcess.kill();
    } catch {
      // Best effort on our own child.
    }
  }
  tailwindProcess = null;

  if (server) {
    try {
      server.closeAllConnections?.();
    } catch {
      // Older Node.
    }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000);
      server.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    server = null;
  }

  if (userDataDir) {
    const tempRoot = path.join(os.tmpdir(), "auth-modal-chrome-");
    const resolvedDir = path.resolve(userDataDir);
    const resolvedTempRoot = path.resolve(tempRoot);
    if (
      resolvedDir
        .toLowerCase()
        .startsWith(resolvedTempRoot.toLowerCase())
    ) {
      try {
        rmSync(resolvedDir, { recursive: true, force: true });
      } catch {
        // Chromium may still hold a file; the directory is unique to this run.
      }
    }
    userDataDir = null;
  }
}

async function run() {
  assert.ok(
    existsSync(AUTH_MODAL_PATH),
    `AuthModal not found at ${AUTH_MODAL_PATH}`,
  );
  assert.ok(existsSync(FIXTURE_PATH), `Fixture not found at ${FIXTURE_PATH}`);
  assert.ok(
    firstExisting([
      path.join(repoRoot, "lib", "auth", "authModalPresentation.ts"),
      path.join(repoRoot, "lib", "auth", "authModalPresentation.tsx"),
    ]),
    "authModalPresentation module not found",
  );
  assert.ok(
    firstExisting([
      path.join(repoRoot, "lib", "auth", "phoneOtpCooldown.ts"),
      path.join(repoRoot, "lib", "auth", "phoneOtpCooldown.tsx"),
    ]),
    "phoneOtpCooldown module not found",
  );

  const bundle = await buildBundle();
  const css = await buildTailwindCss();
  await startServer(bundle, css);
  await launchChrome();
  await connectCdp();
  await setupPage();

  for (const viewport of VIEWPORTS) {
    await runViewport(viewport);
  }
}

let failure = null;
try {
  await run();
} catch (error) {
  failure = error;
  console.error(error);
} finally {
  try {
    writeReport(!failure, failure);
  } catch (error) {
    console.error("Failed to write report:", error);
    if (!failure) failure = error;
  }
  try {
    await cleanup();
  } catch (error) {
    console.error("Cleanup failed:", error);
    if (!failure) failure = error;
  }
}

console.log(
  failure
    ? `\nAuthModal browser smoke FAILED. Report: ${path.join(logDir, "report.json")}`
    : `\nAuthModal browser smoke passed. Report: ${path.join(logDir, "report.json")}`,
);

process.exitCode = failure ? 1 : 0;
