import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { parseLoopbackHttpUrl } from "./security.mjs";

const START_TIMEOUT_MS = 30_000;
const RUNTIME_PORT_RECORD = "desktop-runtime.json";
const SAFE_HOST_ENV_KEYS = Object.freeze([
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
  "ComSpec",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TZ",
  "XDG_RUNTIME_DIR",
]);

export function resolveDesktopReleasePlatform(
  platform = process.platform,
  arch = process.arch,
) {
  if (arch !== "x64") return null;
  if (platform === "win32") return "windows-x64";
  if (platform === "linux") return "linux-x64";
  return null;
}

function absoluteStoragePath(value, name) {
  const normalized = String(value || "").trim();
  if (!normalized || !path.isAbsolute(normalized)) {
    throw new Error(`desktop_${name}_path_must_be_absolute`);
  }
  return path.resolve(normalized);
}

export function buildDesktopRuntimeEnvironment({
  sourceEnv = process.env,
  port,
  releasePlatform,
  userDataPath,
  cachePath,
  runtimeProof,
}) {
  const dataRoot = absoluteStoragePath(userDataPath, "user_data");
  const cacheRoot = absoluteStoragePath(cachePath, "cache");
  if (!/^[a-f0-9]{64}$/.test(String(runtimeProof || ""))) {
    throw new Error("desktop_runtime_proof_invalid");
  }
  const safeHostEnv = {};
  for (const key of SAFE_HOST_ENV_KEYS) {
    const value = sourceEnv[key];
    if (typeof value === "string" && value) safeHostEnv[key] = value;
  }
  return {
    ...safeHostEnv,
    ELECTRON_RUN_AS_NODE: "1",
    NODE_ENV: "production",
    HOSTNAME: "127.0.0.1",
    PORT: String(port),
    AUTH_ENABLED: "false",
    AISTORY_SMS_PROVIDER: "disabled",
    AISTORY_PLATFORM_MANAGED_ENABLED: "false",
    AISTORY_PLATFORM_BILLING_ENABLED: "false",
    AISTORY_PRODUCTION_IDENTITY_ENABLED: "false",
    AISTORY_STEAMWORKS_ENABLED: "false",
    AISTORY_BRANCH_PREFETCH_MAX_DEPTH: "0",
    COMFYUI_ENABLED: "false",
    AISTORY_GPU_LAN_LAB_ENABLED: "false",
    AISTORY_VIDEO_ASSET_ADAPTER: "disabled",
    AISTORY_VIDEO_STORY_ADAPTER: "disabled",
    AISTORY_VIDEO_AB_ADAPTER: "disabled",
    AISTORY_STEAM_DESKTOP: "true",
    AISTORY_DESKTOP_RUNTIME_PROOF: runtimeProof,
    AISTORY_DESKTOP_RELEASE_PLATFORM: releasePlatform,
    AISTORY_CACHE_DIR: path.join(cacheRoot, "runtime-cache"),
    AISTORY_GENERATION_JOB_DIR: path.join(dataRoot, "generation-jobs"),
    AISTORY_PROJECT_ASSET_DIR: path.join(dataRoot, "project-assets"),
    AISTORY_COMFYUI_REGISTRY_DIR: path.join(dataRoot, "comfyui-registry"),
    AISTORY_VIDEO_ASSET_DIR: path.join(dataRoot, "video-assets"),
    AISTORY_VIDEO_STORY_DIR: path.join(dataRoot, "video-stories"),
    AISTORY_VIDEO_AB_DIR: path.join(dataRoot, "video-workflow-ab"),
  };
}

async function findLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const address = server.address();
      const port =
        address && typeof address === "object" ? address.port : undefined;
      server.close((error) => {
        if (error) reject(error);
        else if (!port) reject(new Error("desktop_runtime_port_unavailable"));
        else resolve(port);
      });
    });
  });
}

export async function assertLoopbackPortAvailable(port) {
  if (!validRuntimePort(port)) {
    throw new Error("desktop_runtime_port_allocation_invalid");
  }
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => reject(new Error("desktop_runtime_port_in_use")));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close((error) => {
        if (error) reject(new Error("desktop_runtime_port_in_use"));
        else resolve();
      });
    });
  });
}

function validRuntimePort(value) {
  return Number.isSafeInteger(value) && value >= 1_024 && value <= 65_535;
}

export async function resolveDesktopRuntimePort({
  userDataPath,
  allocatePort = findLoopbackPort,
}) {
  const dataRoot = absoluteStoragePath(userDataPath, "user_data");
  const recordPath = path.join(dataRoot, RUNTIME_PORT_RECORD);
  await mkdir(dataRoot, { recursive: true });
  try {
    const info = await stat(recordPath);
    if (!info.isFile() || info.size > 1_024) {
      throw new Error("desktop_runtime_port_record_invalid");
    }
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    if (
      !record ||
      typeof record !== "object" ||
      Array.isArray(record) ||
      Object.keys(record).sort().join(",") !== "hostname,port,schemaVersion" ||
      record.schemaVersion !== 1 ||
      record.hostname !== "127.0.0.1" ||
      !validRuntimePort(record.port)
    ) {
      throw new Error("desktop_runtime_port_record_invalid");
    }
    return record.port;
  } catch (error) {
    if (
      !(error && typeof error === "object" && "code" in error) ||
      error.code !== "ENOENT"
    ) {
      if (
        error instanceof Error &&
        error.message === "desktop_runtime_port_record_invalid"
      ) {
        throw error;
      }
      throw new Error("desktop_runtime_port_record_invalid");
    }
  }

  const port = await allocatePort();
  if (!validRuntimePort(port)) {
    throw new Error("desktop_runtime_port_allocation_invalid");
  }
  const temporaryPath = `${recordPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify({
        schemaVersion: 1,
        hostname: "127.0.0.1",
        port,
      })}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    await rename(temporaryPath, recordPath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
  return port;
}

function childIsRunning(child) {
  return child && child.exitCode === null && child.signalCode === null;
}

async function stopRuntimeChild(child) {
  if (!childIsRunning(child)) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) =>
      setTimeout(() => {
        if (childIsRunning(child)) child.kill("SIGKILL");
        resolve();
      }, 4_000),
    ),
  ]);
}

async function waitForRuntime(baseUrl, child, runtimeProof) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  let lastError = null;
  while (Date.now() < deadline) {
    if (!childIsRunning(child)) {
      throw new Error("desktop_runtime_exited_before_ready");
    }
    try {
      const response = await fetch(`${baseUrl}/api/desktop-runtime/health`, {
        redirect: "error",
        signal: AbortSignal.timeout(1_500),
        headers: { "x-aistory-desktop-runtime-proof": runtimeProof },
      });
      if (response.status === 204) return;
      lastError = new Error(`desktop_runtime_http_${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 180));
  }
  throw new Error(
    lastError instanceof Error
      ? `desktop_runtime_start_timeout:${lastError.message}`
      : "desktop_runtime_start_timeout",
  );
}

export async function startDesktopRuntime({
  appPath,
  env = process.env,
  releasePlatform,
  userDataPath,
  cachePath,
  allowExternalLoopback = false,
}) {
  const configuredDevUrl = allowExternalLoopback
    ? env.AISTORY_DESKTOP_SERVER_URL
    : undefined;
  if (configuredDevUrl) {
    const parsed = parseLoopbackHttpUrl(configuredDevUrl);
    if (!parsed) throw new Error("desktop_runtime_url_must_be_loopback_http");
    return {
      baseUrl: parsed.origin,
      stop: async () => {},
      child: null,
      mode: "external-loopback",
    };
  }

  const serverPath = path.resolve(appPath, "runtime", "server.js");
  await access(serverPath);
  await mkdir(absoluteStoragePath(userDataPath, "user_data"), {
    recursive: true,
  });
  await mkdir(absoluteStoragePath(cachePath, "cache"), { recursive: true });
  const port = await resolveDesktopRuntimePort({ userDataPath });
  await assertLoopbackPortAvailable(port);
  const runtimeProof = randomBytes(32).toString("hex");
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [serverPath], {
    cwd: path.dirname(serverPath),
    windowsHide: true,
    stdio: "ignore",
    env: buildDesktopRuntimeEnvironment({
      sourceEnv: env,
      port,
      releasePlatform,
      userDataPath,
      cachePath,
      runtimeProof,
    }),
  });
  child.unref();
  try {
    await waitForRuntime(baseUrl, child, runtimeProof);
  } catch (error) {
    await stopRuntimeChild(child);
    throw error;
  }

  let stopped = false;
  return {
    baseUrl,
    child,
    mode: "bundled-standalone",
    async stop() {
      if (stopped || !childIsRunning(child)) return;
      stopped = true;
      await stopRuntimeChild(child);
    },
  };
}
