import path from "node:path";

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  session,
  shell,
} from "electron";

import {
  resolveDesktopReleasePlatform,
  startDesktopRuntime,
} from "./runtime.mjs";
import {
  decideExternalTarget,
  isTrustedRendererUrl,
} from "./security.mjs";
import { createSteamworksAdapter } from "./steamworks-adapter.mjs";

app.commandLine.appendSwitch("proxy-server", "http://127.0.0.1:9");
app.commandLine.appendSwitch(
  "proxy-bypass-list",
  "127.0.0.1;localhost;[::1]",
);
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("disable-component-update");
app.commandLine.appendSwitch("disable-domain-reliability");
app.commandLine.appendSwitch("disable-sync");
app.commandLine.appendSwitch(
  "host-resolver-rules",
  "MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE ::1, EXCLUDE localhost",
);
app.enableSandbox();
app.setName("AIstory");

const releasePlatform = resolveDesktopReleasePlatform();

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
}

let mainWindow = null;
let runtime = null;
let runtimeOrigin = "";
let runtimeShutdownStarted = false;
const steamworks = createSteamworksAdapter(process.env);

function trustedSender(event) {
  return isTrustedRendererUrl(event.senderFrame?.url, runtimeOrigin);
}

function registerIpc() {
  ipcMain.handle("aistory:runtime-info", (event) => {
    if (!trustedSender(event)) return null;
    return {
      appVersion: app.getVersion(),
      platform: "steam-desktop",
      releasePlatform,
      packaged: app.isPackaged,
      steamworks: steamworks.status,
    };
  });

  ipcMain.handle("aistory:open-external", async (event, requestedUrl) => {
    if (!trustedSender(event)) {
      return { status: "denied", reason: "untrusted-renderer" };
    }
    const decision = decideExternalTarget(requestedUrl);
    if (!decision.allowed) {
      return { status: "denied", reason: decision.reason };
    }
    try {
      await shell.openExternal(decision.url, { activate: true });
      return { status: "opened", domain: decision.domain };
    } catch {
      return { status: "failed", reason: "system-browser-unavailable" };
    }
  });

  ipcMain.handle("aistory:soft-keyboard", (event, bounds) => {
    if (!trustedSender(event)) return { status: "failed" };
    return steamworks.requestSoftKeyboard(bounds);
  });

  ipcMain.handle("aistory:set-fullscreen", (event, enabled) => {
    if (!trustedSender(event) || !mainWindow) return { fullscreen: false };
    mainWindow.setFullScreen(enabled === true);
    return { fullscreen: mainWindow.isFullScreen() };
  });

  ipcMain.handle("aistory:toggle-fullscreen", (event) => {
    if (!trustedSender(event) || !mainWindow) return { fullscreen: false };
    mainWindow.setFullScreen(!mainWindow.isFullScreen());
    return { fullscreen: mainWindow.isFullScreen() };
  });
}

function installSessionSecurity() {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    let networkProtocol = false;
    try {
      networkProtocol = ["http:", "https:", "ws:", "wss:"].includes(
        new URL(details.url).protocol,
      );
    } catch {
      networkProtocol = true;
    }
    callback({
      cancel:
        networkProtocol &&
        !isTrustedRendererUrl(details.url, runtimeOrigin),
    });
  });
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (!isTrustedRendererUrl(details.url, runtimeOrigin)) {
      callback({ cancel: true });
      return;
    }
    const responseHeaders = { ...(details.responseHeaders || {}) };
    responseHeaders["Content-Security-Policy"] = [
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'",
    ];
    callback({ responseHeaders });
  });
}

function installNavigationSecurity(window) {
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, targetUrl) => {
    if (!isTrustedRendererUrl(targetUrl, runtimeOrigin)) {
      event.preventDefault();
    }
  });
  window.webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });
}

async function createWindow() {
  if (!releasePlatform) {
    throw new Error("desktop_release_platform_unsupported");
  }
  const userDataPath = app.getPath("userData");
  const cachePath = path.join(userDataPath, "cache");
  app.setAppLogsPath(path.join(userDataPath, "logs"));
  runtime = await startDesktopRuntime({
    appPath: app.getAppPath(),
    env: process.env,
    releasePlatform,
    userDataPath,
    cachePath,
    allowExternalLoopback: !app.isPackaged,
  });
  runtimeOrigin = new URL(runtime.baseUrl).origin;
  registerIpc();
  installSessionSecurity();

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: "#010511",
    autoHideMenuBar: true,
    title: "AIstory",
    webPreferences: {
      preload: path.join(app.getAppPath(), "desktop", "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools:
        !app.isPackaged && process.env.AISTORY_DESKTOP_DEVTOOLS === "true",
    },
  });
  installNavigationSecurity(mainWindow);
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  await mainWindow.loadURL(`${runtime.baseUrl}/zh-CN/steam`);
}

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.on("before-quit", (event) => {
  if (!runtime || runtimeShutdownStarted) return;
  event.preventDefault();
  runtimeShutdownStarted = true;
  void runtime.stop().finally(() => app.quit());
});

app.on("window-all-closed", () => {
  app.quit();
});

function requestSignalShutdown() {
  app.quit();
}

process.once("SIGTERM", requestSignalShutdown);
process.once("SIGINT", requestSignalShutdown);

if (singleInstanceLock) {
  app.whenReady().then(createWindow).catch((error) => {
    const message =
      error instanceof Error && error.message.includes("loopback")
        ? "AIstory 桌面运行时只允许本机 loopback 地址。"
        : "AIstory 桌面运行时启动失败，请重新安装或联系测试负责人。";
    dialog.showErrorBox("AIstory 无法启动", message);
    app.quit();
  });
}
