import { createHash, randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const scriptFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptFile), "..");
const evidenceParent = path.resolve(repoRoot, ".codex-logs");
const sharedPortsFile = "D:\\AIshare\\PORTS.md";
const chromeExecutable =
  "C:\\Users\\sunat\\AppData\\Local\\ms-playwright\\chromium_headless_shell-1228\\chrome-headless-shell-win64\\chrome-headless-shell.exe";
const ffmpegExecutable =
  "C:\\Users\\sunat\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.1.2-full_build\\bin\\ffmpeg.exe";
const nextCli = path.resolve(repoRoot, "node_modules", "next", "dist", "bin", "next");
const fixtureFiles = {
  harness: path.resolve(
    repoRoot,
    "scripts",
    "fixtures",
    "video-story-player-browser-harness.tsx",
  ),
  route: path.resolve(
    repoRoot,
    "scripts",
    "fixtures",
    "video-story-player-media-route.ts",
  ),
};

const P13_PINS = Object.freeze({
  "lib/sceneMedia.ts":
    "221b779fb27135475ec12e80e58acd08c8ed42ad376ce84b7e2332633ebf27e4",
  "components/VideoStoryPlayer.tsx":
    "933d4e88c33fc37a3247188e0e2564a3b2cad0d9083c84593082013dcad00a27",
  "scripts/test-video-story-runtime.ts":
    "8645e2c43b9d4eec6a98752bbe20f28678e8506b48d49962db1764c7ed3005c8",
  "tsconfig.video-story-player-safety.json":
    "f498c1bd3b227dc008470d05b5fb6b0d2264eadf79ffabfa062411623a59f220",
});
const CHROME_SHA256 =
  "28016df6864d302434c9231e1f9f1a8a7ecc512cb2fe3faabb2a36130b96bcf1";
const NEXT_CLI_SHA256 =
  "19337d5e1b3b82ff72a6cd28b06cc47a3e18979da4282b074321c5ba4085b385";
const FFMPEG_SHA256 =
  "ad8f211bc894755e0061c55ab280ae00e8d3d4f15a8cc4372b24cfa247b5942e";
const LEGAL_VIDEO_SOURCE = Object.freeze({
  id: "world-model-little-chef",
  relativePath: path.join(
    "public",
    "case-studies",
    "world-model-little-chef",
    "assets",
    "demo.mp4",
  ),
  bytes: 6_601_802,
  sha256: "aa9e676f730c1472ed10cc3f042d21587679d721bbbfaa1f4bf6854a264fe8dd",
});
const LEGAL_VIDEO_EXCERPT_MAX_BYTES = 2 * 1024 * 1024;
const ALWAYS_FORBIDDEN_PORTS = new Set([
  3000, 4107, 4200, 5173, 5174, 5679, 8000, 8080,
]);
const VIEWPORTS = Object.freeze([
  { name: "desktop", width: 1_440, height: 900 },
  { name: "exact-390x844", width: 390, height: 844 },
]);
const SCENARIOS = Object.freeze(["inline-vtt", "vtt-only", "corrupt-media"]);
const INLINE_TEXT = "P1.14 内联字幕唯一来源";
const INLINE_SPEAKER = "P1.14 内联讲述";
const FALLBACK_TEXT = "P1.14 错误回退正文";
const FALLBACK_SPEAKER = "P1.14 错误回退说话人";
const VTT_TEXT = "P1.14 受控 WebVTT 字幕";
const LOOPBACKS = new Set([
  "127.0.0.1",
  "::1",
  "0:0:0:0:0:0:0:1",
  "::ffff:127.0.0.1",
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeErrorCode(error) {
  const message = error instanceof Error ? error.message : "";
  return /^p114_[a-z0-9_]+$/.test(message) ? message : "p114_unavailable";
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pathWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function assertStagedEmpty() {
  const { stdout } = await execFileAsync(
    "git",
    ["diff", "--cached", "--name-only"],
    { cwd: repoRoot, windowsHide: true, timeout: 15_000 },
  );
  if (stdout.trim() !== "") throw new Error("p114_staged_changes_detected");
}

async function readPinnedFiles() {
  const result = {};
  for (const [relative, expected] of Object.entries(P13_PINS)) {
    const file = path.resolve(repoRoot, relative);
    const info = await stat(file);
    const bytes = await readFile(file);
    const digest = sha256(bytes);
    if (!info.isFile() || digest !== expected) {
      throw new Error("p114_p13_pin_drift");
    }
    result[relative] = {
      bytes: bytes.byteLength,
      sha256: digest,
      mtimeMs: info.mtimeMs,
    };
  }
  return result;
}

function parseRegisteredPorts(text) {
  const ports = new Set(ALWAYS_FORBIDDEN_PORTS);
  for (const line of text.split(/\r?\n/)) {
    const cell = /^\|\s*([^|]+?)\s*\|/.exec(line)?.[1] || "";
    for (const token of cell.split(",")) {
      const range = /^\s*(\d{2,5})\s*[-–]\s*(\d{2,5})\s*$/.exec(token);
      if (range) {
        const start = Number(range[1]);
        const end = Number(range[2]);
        if (start >= 1 && end <= 65_535 && end >= start && end - start <= 100) {
          for (let value = start; value <= end; value += 1) ports.add(value);
        }
        continue;
      }
      const single = /^\s*(\d{2,5})\s*$/.exec(token);
      if (single) {
        const value = Number(single[1]);
        if (value >= 1 && value <= 65_535) ports.add(value);
      }
    }
  }
  return ports;
}

async function reserveEphemeralPort(forbidden) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
        const address = server.address();
        const selected = typeof address === "object" && address ? address.port : 0;
        server.close((error) => (error ? reject(error) : resolve(selected)));
      });
    });
    if (Number.isInteger(port) && port > 0 && !forbidden.has(port)) return port;
  }
  throw new Error("p114_safe_port_unavailable");
}

async function canBindPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close((error) => resolve(!error));
    });
  });
}

function minimalChildEnvironment(nodeEnv) {
  const allowed = ["SystemRoot", "WINDIR", "ComSpec", "PATH", "PATHEXT", "TEMP", "TMP"];
  const environment = {
    NODE_ENV: nodeEnv,
    NEXT_TELEMETRY_DISABLED: "1",
    CI: "1",
    NO_PROXY: "127.0.0.1,localhost,::1",
    no_proxy: "127.0.0.1,localhost,::1",
  };
  for (const key of allowed) {
    if (typeof process.env[key] === "string") environment[key] = process.env[key];
  }
  return environment;
}

function captureChild(child) {
  const output = [];
  const collect = (chunk) => {
    const text = String(chunk);
    output.push(text);
    while (output.join("").length > 64 * 1024) output.shift();
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  return output;
}

function classifyNextBuildFailure(output) {
  const text = output.join("");
  const normalized = text.replaceAll("\\", "/").toLowerCase();
  if (normalized.includes("d:/aistory/components/")) {
    return "p114_next_build_component_junction_resolution_failed";
  }
  if (normalized.includes("d:/aistory/lib/")) {
    return "p114_next_build_library_junction_resolution_failed";
  }
  if (normalized.includes("d:/aistory/node_modules/next/")) {
    return "p114_next_build_next_cli_resolution_failed";
  }
  if (normalized.includes("d:/aistory/node_modules/react-dom/")) {
    return "p114_next_build_react_dom_resolution_failed";
  }
  if (normalized.includes("d:/aistory/node_modules/react/")) {
    return "p114_next_build_react_resolution_failed";
  }
  if (normalized.includes("d:/aistory/node_modules/server-only/")) {
    return "p114_next_build_server_only_resolution_failed";
  }
  if (normalized.includes("d:/aistory/node_modules/.pnpm/next@")) {
    return "p114_next_build_pnpm_next_resolution_failed";
  }
  if (normalized.includes("d:/aistory/node_modules/.pnpm/react-dom@")) {
    return "p114_next_build_pnpm_react_dom_resolution_failed";
  }
  if (normalized.includes("d:/aistory/node_modules/.pnpm/react@")) {
    return "p114_next_build_pnpm_react_resolution_failed";
  }
  if (normalized.includes("d:/aistory/node_modules/.pnpm/@next+swc")) {
    return "p114_next_build_pnpm_swc_resolution_failed";
  }
  if (normalized.includes("d:/aistory/node_modules/.pnpm/")) {
    return "p114_next_build_pnpm_store_resolution_failed";
  }
  if (normalized.includes("d:/aistory/node_modules/")) {
    return "p114_next_build_node_modules_resolution_failed";
  }
  if (/Can't resolve ['"].*[A-Za-z]:[\\/]/.test(text)) {
    return "p114_next_build_cross_drive_resolution_failed";
  }
  if (
    /SWC binary|@next[\\/]swc|next-swc|Failed to load SWC|bindings.*swc/i.test(
      text,
    )
  ) {
    return "p114_next_build_swc_unavailable";
  }
  if (/Module not found|Cannot find module|ERR_MODULE_NOT_FOUND|Can't resolve/i.test(text)) {
    return "p114_next_build_module_resolution_failed";
  }
  if (/unknown or unexpected option|bad option/i.test(text)) {
    return "p114_next_build_node_option_invalid";
  }
  if (/invalid project directory/i.test(text)) {
    return "p114_next_build_project_directory_invalid";
  }
  if (/Type error|Failed to compile/i.test(text)) {
    return "p114_next_build_compile_failed";
  }
  return "p114_next_build_failed";
}

async function waitForChild(child, timeoutMs, errorCode) {
  if (child.exitCode !== null) {
    if (child.exitCode !== 0) throw new Error(errorCode);
    return;
  }
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(errorCode)), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error(errorCode));
    });
  });
  if (exitCode !== 0) throw new Error(errorCode);
}

async function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function waitForServer(origin) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/?scenario=invalid&run=probe`, {
        redirect: "error",
        signal: AbortSignal.timeout(1_500),
      });
      if (response.status === 200) return;
    } catch {
      // The production harness may still be starting.
    }
    await delay(150);
  }
  throw new Error("p114_next_start_timeout");
}

async function createVerifiedJunction(link, target) {
  const targetReal = await realpath(target);
  await symlink(targetReal, link, "junction");
  const info = await lstat(link);
  const linkedReal = await realpath(link);
  if (!info.isSymbolicLink() || linkedReal.toLowerCase() !== targetReal.toLowerCase()) {
    throw new Error("p114_junction_verification_failed");
  }
  return { link, targetReal };
}

async function writeExclusive(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, { encoding: "utf8", flag: "wx" });
}

async function copyFixture(source, destination) {
  const bytes = await readFile(source);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, bytes, { flag: "wx" });
  const copied = await readFile(destination);
  if (sha256(copied) !== sha256(bytes)) throw new Error("p114_fixture_copy_drift");
  return sha256(bytes);
}

async function prepareLegalCarrier(tempRoot) {
  const source = path.resolve(tempRoot, LEGAL_VIDEO_SOURCE.relativePath);
  const sourceReal = await realpath(source);
  const publicReal = await realpath(path.resolve(tempRoot, "public"));
  if (!pathWithin(publicReal, sourceReal)) {
    throw new Error("p114_legal_source_outside_public_root");
  }
  const sourceInfo = await stat(sourceReal);
  const sourceBytes = await readFile(sourceReal);
  if (
    !sourceInfo.isFile() ||
    sourceBytes.byteLength !== LEGAL_VIDEO_SOURCE.bytes ||
    sha256(sourceBytes) !== LEGAL_VIDEO_SOURCE.sha256
  ) {
    throw new Error("p114_legal_source_pin_drift");
  }

  const ffmpegInfo = await stat(ffmpegExecutable);
  const ffmpegBytes = await readFile(ffmpegExecutable);
  if (!ffmpegInfo.isFile() || sha256(ffmpegBytes) !== FFMPEG_SHA256) {
    throw new Error("p114_ffmpeg_pin_drift");
  }
  const versionResult = await execFileAsync(ffmpegExecutable, ["-version"], {
    windowsHide: true,
    timeout: 10_000,
    env: minimalChildEnvironment("production"),
  });
  const ffmpegVersion = String(versionResult.stdout || versionResult.stderr)
    .match(/^ffmpeg version ([^\s]+)/)?.[1];
  if (ffmpegVersion !== "8.1.2-full_build-www.gyan.dev") {
    throw new Error("p114_ffmpeg_version_invalid");
  }

  const mediaRoot = path.resolve(tempRoot, "harness-media");
  const excerpt = path.resolve(mediaRoot, "legal-world-model-excerpt.mp4");
  const manifest = path.resolve(
    mediaRoot,
    "legal-world-model-excerpt.manifest.json",
  );
  await mkdir(mediaRoot, { recursive: false });
  try {
    await execFileAsync(
      ffmpegExecutable,
      [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-hwaccel",
        "none",
        "-ss",
        "0",
        "-i",
        sourceReal,
        "-t",
        "2",
        "-map",
        "0:v:0",
        "-an",
        "-vf",
        "scale=320:-2",
        "-r",
        "15",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "35",
        "-pix_fmt",
        "yuv420p",
        "-threads",
        "1",
        "-movflags",
        "+faststart",
        "-map_metadata",
        "-1",
        "-map_chapters",
        "-1",
        "-fflags",
        "+bitexact",
        "-flags:v",
        "+bitexact",
        "-n",
        excerpt,
      ],
      {
        windowsHide: true,
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
        env: minimalChildEnvironment("production"),
      },
    );
  } catch {
    throw new Error("p114_legal_carrier_generation_failed");
  }

  const excerptInfo = await stat(excerpt);
  const excerptBytes = await readFile(excerpt);
  if (
    !excerptInfo.isFile() ||
    excerptBytes.byteLength <= 32 ||
    excerptBytes.byteLength > LEGAL_VIDEO_EXCERPT_MAX_BYTES ||
    excerptBytes.subarray(4, 8).toString("ascii") !== "ftyp"
  ) {
    throw new Error("p114_legal_carrier_invalid");
  }
  const derived = {
    kind: "local_browser_smoke_excerpt",
    bytes: excerptBytes.byteLength,
    sha256: sha256(excerptBytes),
  };
  await writeExclusive(
    manifest,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        source: {
          id: LEGAL_VIDEO_SOURCE.id,
          bytes: LEGAL_VIDEO_SOURCE.bytes,
          sha256: LEGAL_VIDEO_SOURCE.sha256,
        },
        derived,
      },
      null,
      2,
    )}\n`,
  );
  return {
    source: {
      id: LEGAL_VIDEO_SOURCE.id,
      bytes: LEGAL_VIDEO_SOURCE.bytes,
      sha256: LEGAL_VIDEO_SOURCE.sha256,
    },
    derived,
    derivation: {
      kind: "offline_software_encoded_browser_smoke_excerpt",
      ffmpegVersion,
      ffmpegSha256: FFMPEG_SHA256,
      durationSeconds: 2,
      width: 320,
      audioIncluded: false,
      gpuUsed: false,
    },
  };
}

async function scaffoldHarness(tempRoot, junctions) {
  for (const name of ["node_modules", "components", "lib", "public"]) {
    junctions.push(
      await createVerifiedJunction(
        path.resolve(tempRoot, name),
        path.resolve(repoRoot, name),
      ),
    );
  }

  const fixturePins = {
    harness: await copyFixture(
      fixtureFiles.harness,
      path.resolve(tempRoot, "app", "harness.tsx"),
    ),
    route: await copyFixture(
      fixtureFiles.route,
      path.resolve(
        tempRoot,
        "app",
        "case-studies",
        "p1-14",
        "[asset]",
        "route.ts",
      ),
    ),
  };

  await writeExclusive(
    path.resolve(tempRoot, "app", "layout.tsx"),
    `import type { ReactNode } from "react";\n\nexport default function Layout({ children }: { children: ReactNode }) {\n  return <html lang="zh-CN"><body>{children}</body></html>;\n}\n`,
  );
  await writeExclusive(
    path.resolve(tempRoot, "app", "page.tsx"),
    `import { VideoStoryPlayerBrowserHarness } from "./harness";\n\ntype Search = Record<string, string | string[] | undefined>;\nconst SCENARIOS = ["inline-vtt", "vtt-only", "corrupt-media"] as const;\n\nexport default async function Page({ searchParams }: { searchParams: Promise<Search> }) {\n  const values = await searchParams;\n  const rawScenario = values.scenario;\n  const rawRun = values.run;\n  const scenario = typeof rawScenario === "string"\n    ? SCENARIOS.find((value) => value === rawScenario)\n    : undefined;\n  const runId = typeof rawRun === "string" && /^[a-z0-9-]{8,80}$/.test(rawRun)\n    ? rawRun\n    : null;\n  if (!scenario || !runId) {\n    return <main data-p114-invalid-request>invalid harness request</main>;\n  }\n  return <VideoStoryPlayerBrowserHarness scenario={scenario} runId={runId} />;\n}\n`,
  );
  await writeExclusive(
    path.resolve(tempRoot, "app", "icon.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#05070c"/></svg>\n`,
  );
  await writeExclusive(
    path.resolve(tempRoot, "next-env.d.ts"),
    `/// <reference types="next" />\n/// <reference types="next/image-types/global" />\n`,
  );
  await writeExclusive(
    path.resolve(tempRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "aistory-p114-isolated-player-harness",
        version: "1.0.0",
        private: true,
      },
      null,
      2,
    )}\n`,
  );
  await writeExclusive(
    path.resolve(tempRoot, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          lib: ["DOM", "DOM.Iterable", "ES2022"],
          allowJs: false,
          skipLibCheck: true,
          strict: true,
          noEmit: true,
          esModuleInterop: true,
          module: "ESNext",
          moduleResolution: "Bundler",
          resolveJsonModule: true,
          isolatedModules: true,
          jsx: "preserve",
          incremental: false,
          plugins: [{ name: "next" }],
          paths: {
            "@/*": ["./*"],
            "@infiplot/types": ["./lib/types/index.ts"],
          },
        },
        include: [
          "next-env.d.ts",
          "app/**/*.ts",
          "app/**/*.tsx",
          ".next/types/**/*.ts",
        ],
        exclude: [
          "node_modules",
          ".next/cache",
          "components/components",
          "lib/lib",
        ],
      },
      null,
      2,
    )}\n`,
  );
  await writeExclusive(
    path.resolve(tempRoot, "next.config.mjs"),
    `const csp = [\n  "default-src 'self'",\n  "base-uri 'none'",\n  "connect-src 'self'",\n  "font-src 'none'",\n  "frame-src 'none'",\n  "img-src 'self' data:",\n  "media-src 'self'",\n  "object-src 'none'",\n  "script-src 'self' 'unsafe-inline'",\n  "style-src 'self' 'unsafe-inline'",\n  "worker-src 'none'",\n].join("; ");\n\nexport default {\n  poweredByHeader: false,\n  reactStrictMode: false,\n  experimental: { externalDir: true },\n  webpack(config) {\n    config.resolve.symlinks = false;\n    return config;\n  },\n  async headers() {\n    return [{ source: "/:path*", headers: [\n      { key: "Content-Security-Policy", value: csp },\n      { key: "Referrer-Policy", value: "no-referrer" },\n      { key: "X-Content-Type-Options", value: "nosniff" },\n      { key: "X-Frame-Options", value: "DENY" },\n    ] }];\n  },\n};\n`,
  );
  return { junctions, fixturePins };
}

class CdpClient {
  constructor(webSocketUrl, runtimeOrigin, scenario) {
    const parsed = new URL(webSocketUrl);
    if (parsed.protocol !== "ws:" || parsed.hostname !== "127.0.0.1") {
      throw new Error("p114_cdp_websocket_not_loopback");
    }
    this.socket = new WebSocket(parsed);
    this.runtimeOrigin = runtimeOrigin;
    this.scenario = scenario;
    this.nextId = 1;
    this.pending = new Map();
    this.requests = [];
    this.requestById = new Map();
    this.activeRequestIds = new Set();
    this.blockedRequests = 0;
    this.consoleErrors = 0;
    this.consoleWarnings = 0;
    this.runtimeExceptions = 0;
    this.targetCrashes = 0;
    this.loadingFailures = 0;
    this.webSockets = 0;
    this.unexpectedLogs = 0;
  }

  async open() {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("p114_cdp_open_timeout")),
        5_000,
      );
      this.socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("p114_cdp_open_failed"));
      });
    });
    this.socket.addEventListener("message", (event) => this.onMessage(event));
  }

  onMessage(event) {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      this.runtimeExceptions += 1;
      return;
    }
    if (message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error("p114_cdp_command_failed"));
      else pending.resolve(message.result || {});
      return;
    }
    if (message.method === "Fetch.requestPaused") {
      const request = message.params?.request || {};
      let allowed = false;
      try {
        const parsed = new URL(String(request.url || ""));
        allowed =
          parsed.origin === this.runtimeOrigin &&
          new Set(["GET", "HEAD", "OPTIONS"]).has(String(request.method || ""));
      } catch {
        allowed = false;
      }
      if (!allowed) this.blockedRequests += 1;
      void this.command(
        allowed ? "Fetch.continueRequest" : "Fetch.failRequest",
        allowed
          ? { requestId: message.params.requestId }
          : { requestId: message.params.requestId, errorReason: "BlockedByClient" },
      ).catch(() => {
        this.runtimeExceptions += 1;
      });
      return;
    }
    if (message.method === "Network.requestWillBeSent") {
      const request = {
        url: String(message.params?.request?.url || ""),
        method: String(message.params?.request?.method || ""),
        type: String(message.params?.type || ""),
      };
      this.requests.push(request);
      this.requestById.set(message.params?.requestId, request);
      this.activeRequestIds.add(message.params?.requestId);
    } else if (message.method === "Network.loadingFinished") {
      this.activeRequestIds.delete(message.params?.requestId);
    } else if (message.method === "Network.loadingFailed") {
      this.loadingFailures += 1;
      this.activeRequestIds.delete(message.params?.requestId);
    } else if (message.method === "Network.webSocketCreated") {
      this.webSockets += 1;
    } else if (message.method === "Runtime.exceptionThrown") {
      this.runtimeExceptions += 1;
    } else if (message.method === "Inspector.targetCrashed") {
      this.targetCrashes += 1;
    } else if (message.method === "Runtime.consoleAPICalled") {
      const type = String(message.params?.type || "");
      if (type === "error") this.consoleErrors += 1;
      if (type === "warning") this.consoleWarnings += 1;
    } else if (message.method === "Log.entryAdded") {
      const entry = message.params?.entry || {};
      const level = String(entry.level || "");
      if (level === "error" || level === "warning") {
        this.unexpectedLogs += 1;
      }
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
    if (result.exceptionDetails) throw new Error("p114_page_evaluation_failed");
    return result.result?.value;
  }

  async waitFor(expression, errorCode, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.evaluate(expression)) return;
      await delay(100);
    }
    throw new Error(errorCode);
  }

  async waitForPathIdle(pathname, errorCode, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    let stableSince = 0;
    while (Date.now() < deadline) {
      const matchingRequestIds = [...this.requestById.entries()]
        .filter(([, request]) => {
          try {
            return new URL(request.url).pathname === pathname;
          } catch {
            return false;
          }
        })
        .map(([requestId]) => requestId);
      const active = matchingRequestIds.some((requestId) =>
        this.activeRequestIds.has(requestId),
      );
      if (matchingRequestIds.length > 0 && !active) {
        if (stableSince === 0) stableSince = Date.now();
        if (Date.now() - stableSince >= 400) return;
      } else {
        stableSince = 0;
      }
      await delay(100);
    }
    throw new Error(errorCode);
  }

  diagnostics() {
    return {
      consoleErrorCount: this.consoleErrors,
      consoleWarningCount: this.consoleWarnings,
      runtimeExceptionCount: this.runtimeExceptions,
      targetCrashCount: this.targetCrashes,
      loadingFailureCount: this.loadingFailures,
      rendererWebSocketCount: this.webSockets,
      blockedExternalAttemptCount: this.blockedRequests,
      unexpectedLogCount: this.unexpectedLogs,
    };
  }

  close() {
    this.socket.close();
  }
}

async function cdpJson(cdpPort, pathname, init) {
  const url = new URL(pathname, `http://127.0.0.1:${cdpPort}`);
  const response = await fetch(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error("p114_cdp_http_failed");
  return response.json();
}

function requestsForPath(requests, pathname) {
  return requests.filter((request) => {
    try {
      const parsed = new URL(request.url);
      return parsed.pathname === pathname;
    } catch {
      return false;
    }
  });
}

function requestOrigins(requests) {
  return [
    ...new Set(
      requests.flatMap((request) => {
        try {
          const parsed = new URL(request.url);
          return parsed.protocol === "http:" || parsed.protocol === "https:"
            ? [parsed.origin]
            : [];
        } catch {
          return [];
        }
      }),
    ),
  ].sort();
}

function externalRequestCount(requests, runtimeOrigin) {
  return requests.filter((request) => {
    try {
      const parsed = new URL(request.url);
      return (
        (parsed.protocol === "http:" || parsed.protocol === "https:") &&
        parsed.origin !== runtimeOrigin
      );
    } catch {
      return false;
    }
  }).length;
}

async function captureScreenshot(client, evidenceRoot, filename) {
  const result = await client.command("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  const bytes = Buffer.from(result.data, "base64");
  await writeFile(path.resolve(evidenceRoot, filename), bytes, { flag: "wx" });
  return { filename, bytes: bytes.byteLength, sha256: sha256(bytes) };
}

async function assertLayout(client, viewport) {
  const facts = await client.evaluate(`(() => ({
    innerWidth,
    innerHeight,
    htmlClientWidth: document.documentElement.clientWidth,
    htmlScrollWidth: document.documentElement.scrollWidth,
    bodyClientWidth: document.body.clientWidth,
    bodyScrollWidth: document.body.scrollWidth
  }))()`);
  if (
    facts.innerWidth !== viewport.width ||
    facts.innerHeight !== viewport.height ||
    facts.htmlScrollWidth !== facts.htmlClientWidth ||
    facts.bodyScrollWidth !== facts.bodyClientWidth
  ) {
    throw new Error("p114_viewport_or_overflow_invalid");
  }
  return facts;
}

function assertDiagnostics(diagnostics) {
  if (
    diagnostics.consoleErrorCount !== 0 ||
    diagnostics.consoleWarningCount !== 0 ||
    diagnostics.runtimeExceptionCount !== 0 ||
    diagnostics.targetCrashCount !== 0 ||
    diagnostics.loadingFailureCount !== 0 ||
    diagnostics.rendererWebSocketCount !== 0 ||
    diagnostics.blockedExternalAttemptCount !== 0 ||
    diagnostics.unexpectedLogCount !== 0
  ) {
    throw new Error("p114_browser_diagnostics_failed");
  }
}

async function seekVideoWithTrustedEvents(client, targetSeconds, errorCode) {
  const before = await client.evaluate(`(() => {
    const video = document.querySelector('video');
    const harness = window.__AISTORY_P114_PLAYER_HARNESS__;
    if (!(video instanceof HTMLVideoElement) || !harness) return null;
    video.pause();
    video.currentTime = ${JSON.stringify(targetSeconds)};
    return {
      duration: video.duration,
      trustedSeeked: harness.nativeTrustedSeekedCount,
      trustedTimeUpdate: harness.nativeTrustedTimeUpdateCount
    };
  })()`);
  if (
    !before ||
    !Number.isFinite(before.duration) ||
    before.duration <= targetSeconds
  ) {
    throw new Error("p114_native_seek_target_invalid");
  }
  await client.waitFor(
    `(() => {
      const video = document.querySelector('video');
      const harness = window.__AISTORY_P114_PLAYER_HARNESS__;
      return video instanceof HTMLVideoElement && harness && !video.seeking &&
        Math.abs(video.currentTime - ${JSON.stringify(targetSeconds)}) < 0.075 &&
        harness.nativeTrustedSeekedCount > ${JSON.stringify(before.trustedSeeked)} &&
        harness.nativeTrustedTimeUpdateCount > ${JSON.stringify(before.trustedTimeUpdate)};
    })()`,
    errorCode,
  );
  return client.evaluate(`(() => {
    const video = document.querySelector('video');
    const harness = window.__AISTORY_P114_PLAYER_HARNESS__;
    return {
      requestedSeconds: ${JSON.stringify(targetSeconds)},
      observedSeconds: video.currentTime,
      durationSeconds: video.duration,
      trustedSeekedDelta: harness.nativeTrustedSeekedCount - ${JSON.stringify(before.trustedSeeked)},
      trustedTimeUpdateDelta: harness.nativeTrustedTimeUpdateCount - ${JSON.stringify(before.trustedTimeUpdate)}
    };
  })()`);
}

async function runInlineScenario(client, evidenceRoot, viewport, runId) {
  await client.waitFor(
    `(() => { const v = document.querySelector('video'); return v instanceof HTMLVideoElement && v.readyState >= 1; })()`,
    "p114_inline_metadata_timeout",
  );
  await client.evaluate(`(() => {
    const video = document.querySelector('video');
    if (!(video instanceof HTMLVideoElement)) return false;
    video.pause();
    return true;
  })()`);
  await client.waitForPathIdle(
    "/case-studies/p1-14/legal.mp4",
    "p114_inline_initial_media_not_idle",
  );
  const activeSeek = await seekVideoWithTrustedEvents(
    client,
    0.4,
    "p114_inline_active_native_seek_timeout",
  );
  await client.waitFor(
    `(() => {
      const live = document.querySelector('[aria-live="polite"]');
      const spans = live ? [...live.querySelectorAll('span')].map((item) => item.textContent || '') : [];
      return spans.length === 2 && spans[0] === ${JSON.stringify(INLINE_SPEAKER)} && spans[1] === ${JSON.stringify(INLINE_TEXT)};
    })()`,
    "p114_inline_cue_missing",
  );
  const active = await client.evaluate(`(() => ({
    trackCount: document.querySelectorAll('video > track').length,
    fallbackTextPresent: document.body.textContent?.includes(${JSON.stringify(FALLBACK_TEXT)}) === true,
    fallbackSpeakerPresent: document.body.textContent?.includes(${JSON.stringify(FALLBACK_SPEAKER)}) === true,
    completionCount: window.__AISTORY_P114_PLAYER_HARNESS__?.completions.length ?? -1
  }))()`);
  if (
    active.trackCount !== 0 ||
    active.fallbackTextPresent ||
    active.fallbackSpeakerPresent ||
    active.completionCount !== 0
  ) {
    throw new Error("p114_inline_authority_conflict");
  }
  const screenshot = await captureScreenshot(
    client,
    evidenceRoot,
    `${runId}-inline-active.png`,
  );

  const duration = activeSeek.durationSeconds;
  const gapTarget = 1.1;
  const nearEndTarget = Math.round((duration - 0.08) * 1_000) / 1_000;
  if (
    nearEndTarget <= gapTarget + 0.25 ||
    nearEndTarget >= duration ||
    gapTarget <= 0.9
  ) {
    throw new Error("p114_inline_distinct_seek_targets_invalid");
  }
  const emptySubtitleObservations = [];
  for (const [label, target] of [
    ["gap", gapTarget],
    ["near_end", nearEndTarget],
  ]) {
    const observation = await seekVideoWithTrustedEvents(
      client,
      target,
      `p114_inline_${label}_native_seek_timeout`,
    );
    await client.waitFor(
      `document.querySelector('[aria-live="polite"]') === null`,
      "p114_inline_gap_fallback_detected",
    );
    await client.waitForPathIdle(
      "/case-studies/p1-14/legal.mp4",
      "p114_inline_seek_media_not_idle",
    );
    emptySubtitleObservations.push({ label, ...observation, subtitleCount: 0 });
  }
  const vttRequests = requestsForPath(
    client.requests,
    "/case-studies/p1-14/subtitles.vtt",
  );
  if (vttRequests.length !== 0) {
    throw new Error("p114_inline_requested_vtt");
  }
  return {
    authority: "inline",
    nativeTrackCount: 0,
    vttRequestCount: 0,
    activeCueExact: true,
    activeCueNativeSeek: activeSeek,
    emptySubtitleObservations,
    gapSubtitleCount: 0,
    endSubtitleCount: 0,
    fallbackUsed: false,
    completionCount: 0,
    screenshot,
  };
}

async function runVttScenario(client, evidenceRoot, viewport, runId) {
  await client.waitFor(
    `(() => {
      const track = document.querySelector('video > track');
      return track instanceof HTMLTrackElement && track.readyState === 2 && (track.track.cues?.length || 0) > 0;
    })()`,
    "p114_vtt_track_timeout",
  );
  await client.evaluate(`document.querySelector('video')?.pause()`);
  await client.waitForPathIdle(
    "/case-studies/p1-14/legal.mp4",
    "p114_vtt_media_not_idle",
  );
  const facts = await client.evaluate(`(() => {
    const tracks = [...document.querySelectorAll('video > track')];
    const track = tracks[0];
    const firstCue = track instanceof HTMLTrackElement ? track.track.cues?.[0] : null;
    return {
      trackCount: tracks.length,
      kind: track?.getAttribute('kind'),
      srcLang: track?.getAttribute('srclang'),
      defaultAttribute: track?.hasAttribute('default') === true,
      readyState: track instanceof HTMLTrackElement ? track.readyState : -1,
      cueCount: track instanceof HTMLTrackElement ? track.track.cues?.length || 0 : -1,
      firstCueText: firstCue && 'text' in firstCue ? firstCue.text : '',
      overlayCount: document.querySelectorAll('[aria-live="polite"]').length,
      fallbackTextPresent: document.body.textContent?.includes(${JSON.stringify(FALLBACK_TEXT)}) === true,
      completionCount: window.__AISTORY_P114_PLAYER_HARNESS__?.completions.length ?? -1
    };
  })()`);
  const vttRequests = requestsForPath(
    client.requests,
    "/case-studies/p1-14/subtitles.vtt",
  );
  const vttRequestCount = vttRequests.length;
  if (
    facts.trackCount !== 1 ||
    facts.kind !== "subtitles" ||
    facts.srcLang !== "zh-CN" ||
    !facts.defaultAttribute ||
    facts.readyState !== 2 ||
    facts.cueCount < 1 ||
    facts.firstCueText !== VTT_TEXT ||
    facts.overlayCount !== 0 ||
    facts.fallbackTextPresent ||
    facts.completionCount !== 0 ||
    vttRequestCount !== 1 ||
    vttRequests[0]?.method !== "GET"
  ) {
    throw new Error("p114_vtt_contract_invalid");
  }
  const screenshot = await captureScreenshot(
    client,
    evidenceRoot,
    `${runId}-vtt-only.png`,
  );
  return {
    authority: "controlled_vtt",
    nativeTrackCount: 1,
    trackKindExact: true,
    trackLanguageExact: true,
    trackDefault: true,
    trackReadyState: facts.readyState,
    cueCount: facts.cueCount,
    cueTextExact: true,
    overlayCount: 0,
    fallbackUsed: false,
    vttRequestCount,
    vttRequestMethods: vttRequests.map((request) => request.method),
    completionCount: 0,
    screenshot,
  };
}

async function runCorruptScenario(client, evidenceRoot, viewport, runId) {
  try {
    await client.waitFor(
      `(() => {
        const video = document.querySelector('video');
        const failed = document.querySelector('[data-video-media-failed][role="alert"]');
        const recovery = document.querySelector('[data-video-error-recovery]');
        return video instanceof HTMLVideoElement && video.error !== null && failed !== null && recovery instanceof HTMLButtonElement && !recovery.disabled && (window.__AISTORY_P114_PLAYER_HARNESS__?.nativeMediaErrorCount || 0) === 1;
      })()`,
      "p114_corrupt_media_error_timeout",
    );
  } catch (error) {
    const diagnostic = await client.evaluate(`(() => {
      const video = document.querySelector('video');
      return {
        videoPresent: video instanceof HTMLVideoElement,
        mediaErrorCode: video instanceof HTMLVideoElement ? video.error?.code || 0 : -1,
        networkState: video instanceof HTMLVideoElement ? video.networkState : -1,
        readyState: video instanceof HTMLVideoElement ? video.readyState : -1,
        failedUiPresent: document.querySelector('[data-video-media-failed][role="alert"]') !== null,
        recoveryPresent: document.querySelector('[data-video-error-recovery]') !== null,
        nativeMediaErrorCount: window.__AISTORY_P114_PLAYER_HARNESS__?.nativeMediaErrorCount || 0,
        completionCount: window.__AISTORY_P114_PLAYER_HARNESS__?.completions.length || 0
      };
    })()`);
    await writeFile(
      path.resolve(evidenceRoot, `${runId}-corrupt-timeout-diagnostic.json`),
      `${JSON.stringify(diagnostic, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    throw error;
  }
  const before = await client.evaluate(`(() => {
    const failed = document.querySelector('[data-video-media-failed][role="alert"]');
    const recovery = document.querySelector('[data-video-error-recovery]');
    const rect = recovery?.getBoundingClientRect();
    return {
      mediaErrorCode: document.querySelector('video')?.error?.code || 0,
      completionCount: window.__AISTORY_P114_PLAYER_HARNESS__?.completions.length ?? -1,
      recoveryVisible: Boolean(rect && rect.width > 0 && rect.height > 0),
      failureTitle: failed?.querySelector('p')?.textContent || '',
      recoveryText: recovery?.textContent || '',
      ordinarySkipCount: [...document.querySelectorAll('button')].filter((button) => button.textContent?.includes('跳到结尾')).length
    };
  })()`);
  if (
    before.mediaErrorCode <= 0 ||
    before.completionCount !== 0 ||
    !before.recoveryVisible ||
    before.failureTitle !== "视频加载失败" ||
    before.recoveryText !== "跳过并继续" ||
    before.ordinarySkipCount !== 0
  ) {
    throw new Error("p114_corrupt_initial_state_invalid");
  }
  const screenshot = await captureScreenshot(
    client,
    evidenceRoot,
    `${runId}-corrupt-failed.png`,
  );

  await client.evaluate(`(() => {
    const button = document.querySelector('[data-video-error-recovery]');
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    button.click();
    return true;
  })()`);
  await client.waitFor(
    `(window.__AISTORY_P114_PLAYER_HARNESS__?.completions.length || 0) === 1`,
    "p114_corrupt_recovery_completion_timeout",
  );
  await client.evaluate(`(() => {
    const button = document.querySelector('[data-video-error-recovery]');
    if (button instanceof HTMLButtonElement) button.click();
    const video = document.querySelector('video');
    if (!(video instanceof HTMLVideoElement)) return false;
    const group = document.querySelector('[role="group"]');
    group?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    for (const type of ['loadedmetadata', 'play', 'timeupdate', 'ended', 'error']) {
      video.dispatchEvent(new Event(type, { bubbles: true }));
    }
    return true;
  })()`);
  await delay(300);
  const after = await client.evaluate(`(() => ({
    completions: window.__AISTORY_P114_PLAYER_HARNESS__?.completions || [],
    nativeMediaErrorCount: window.__AISTORY_P114_PLAYER_HARNESS__?.nativeMediaErrorCount || 0,
    recoveryDisabled: document.querySelector('[data-video-error-recovery]')?.disabled === true
  }))()`);
  if (
    after.completions.length !== 1 ||
    after.completions[0]?.reason !== "skipped" ||
    !Number.isSafeInteger(after.completions[0]?.currentTimeMs) ||
    !Number.isSafeInteger(after.completions[0]?.durationMs) ||
    after.nativeMediaErrorCount !== 1 ||
    !after.recoveryDisabled
  ) {
    throw new Error("p114_corrupt_recovery_not_idempotent");
  }
  return {
    authority: "real_html_media_error_then_synthetic_late_events",
    mediaErrorObserved: true,
    mediaErrorCode: before.mediaErrorCode,
    completionCountBeforeRecovery: 0,
    recoveryVisibleWithAllowSkipFalse: true,
    failureTitleExact: true,
    recoveryButtonTextExact: true,
    ordinarySkipCount: 0,
    completionCountAfterRecovery: 1,
    completionReason: "skipped",
    recoveryDisabledAfterCompletion: true,
    syntheticLateEvents: [
      "loadedmetadata",
      "play",
      "timeupdate",
      "seek_action_arrow_right",
      "ended",
      "error",
    ],
    screenshot,
  };
}

async function runBrowserCell({
  cdpPort,
  runtimeOrigin,
  scenario,
  viewport,
  evidenceRoot,
  socketAudit,
}) {
  const runId = `${scenario}-${viewport.width}x${viewport.height}-${randomBytes(4).toString("hex")}`;
  const target = await cdpJson(
    cdpPort,
    `/json/new?${encodeURIComponent("about:blank")}`,
    { method: "PUT" },
  );
  if (
    target.type !== "page" ||
    typeof target.id !== "string" ||
    typeof target.webSocketDebuggerUrl !== "string"
  ) {
    throw new Error("p114_page_target_invalid");
  }
  const client = new CdpClient(target.webSocketDebuggerUrl, runtimeOrigin, scenario);
  await client.open();
  try {
    await Promise.all([
      client.command("Page.enable"),
      client.command("Runtime.enable"),
      client.command("Log.enable"),
      client.command("Network.enable"),
    ]);
    await client.command("Network.setCacheDisabled", { cacheDisabled: true });
    await client.command("Network.setBypassServiceWorker", { bypass: true });
    await client.command("Fetch.enable", {
      patterns: [
        { urlPattern: "http://*/*", requestStage: "Request" },
        { urlPattern: "https://*/*", requestStage: "Request" },
      ],
    });
    await client.command("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      screenWidth: viewport.width,
      screenHeight: viewport.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const navigationUrl = `${runtimeOrigin}/?scenario=${encodeURIComponent(scenario)}&run=${encodeURIComponent(runId)}`;
    const navigation = await client.command("Page.navigate", { url: navigationUrl });
    if (navigation.errorText) throw new Error("p114_navigation_failed");
    await client.waitFor(
      `document.readyState === 'complete' && Boolean(document.querySelector('[data-p114-harness][data-p114-scenario="${scenario}"]')) && window.__AISTORY_P114_PLAYER_HARNESS__?.runId === ${JSON.stringify(runId)}`,
      "p114_harness_mount_timeout",
      30_000,
    );
    const layout = await assertLayout(client, viewport);
    const scenarioFacts =
      scenario === "inline-vtt"
        ? await runInlineScenario(client, evidenceRoot, viewport, runId)
        : scenario === "vtt-only"
          ? await runVttScenario(client, evidenceRoot, viewport, runId)
          : await runCorruptScenario(client, evidenceRoot, viewport, runId);

    await delay(500);
    const diagnostics = client.diagnostics();
    assertDiagnostics(diagnostics);
    if (externalRequestCount(client.requests, runtimeOrigin) !== 0) {
      throw new Error("p114_external_request_detected");
    }
    const mediaPath =
      scenario === "corrupt-media"
        ? "/case-studies/p1-14/corrupt.mp4"
        : "/case-studies/p1-14/legal.mp4";
    const mediaRequests = requestsForPath(client.requests, mediaPath);
    if (!mediaRequests.some((request) => request.method === "GET")) {
      throw new Error("p114_media_request_missing");
    }
    const origins = requestOrigins(client.requests);
    if (origins.length !== 1 || origins[0] !== runtimeOrigin) {
      throw new Error("p114_request_origin_inventory_invalid");
    }
    await socketAudit();
    return {
      scenario,
      viewport: { name: viewport.name, width: viewport.width, height: viewport.height },
      layout,
      ...scenarioFacts,
      diagnostics,
      externalRequestCount: 0,
      requestOriginCount: origins.length,
      requestOriginsExactRuntimeOrigin: true,
    };
  } finally {
    client.close();
    try {
      await cdpJson(cdpPort, `/json/close/${encodeURIComponent(target.id)}`);
    } catch {
      // Closing the page WebSocket can race the target-close HTTP response.
    }
  }
}

async function readJsonPowerShell(command) {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { windowsHide: true, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 },
  );
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function processRows() {
  return readJsonPowerShell(
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CreationDate | ConvertTo-Json -Compress",
  );
}

function descendantPids(rows, roots) {
  const selected = new Set(roots.filter((value) => Number.isInteger(value) && value > 0));
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      const pid = Number(row.ProcessId);
      const parent = Number(row.ParentProcessId);
      if (!selected.has(pid) && selected.has(parent)) {
        selected.add(pid);
        changed = true;
      }
    }
  }
  return selected;
}

function processIdentity(row) {
  const pid = Number(row.ProcessId);
  const creationDate = String(row.CreationDate || "");
  return Number.isInteger(pid) && pid > 0 && creationDate
    ? `${pid}:${creationDate}`
    : null;
}

function rememberOwnedProcessIdentities(rows, roots, identities) {
  const owned = descendantPids(rows, roots);
  for (const row of rows) {
    const pid = Number(row.ProcessId);
    const identity = processIdentity(row);
    if (pid !== process.pid && owned.has(pid) && identity) {
      identities.set(identity, { pid, creationDate: String(row.CreationDate) });
    }
  }
  return owned;
}

async function tcpRows(state) {
  return readJsonPowerShell(
    `Get-NetTCPConnection -State ${state} -ErrorAction SilentlyContinue | Select-Object OwningProcess,LocalAddress,LocalPort,RemoteAddress,RemotePort | ConvertTo-Json -Compress`,
  );
}

function createProcessTreeNetworkMonitor(rootPid, identities) {
  let stopping = false;
  let failureCode = null;
  const stats = {
    samples: 0,
    maximumOwnedProcessCount: 0,
    nonLoopbackEstablishedCount: 0,
  };
  const promise = (async () => {
    while (!stopping) {
      try {
        const rows = await processRows();
        const owned = rememberOwnedProcessIdentities(
          rows,
          [rootPid],
          identities,
        );
        const established = (await tcpRows("Established")).filter((row) =>
          owned.has(Number(row.OwningProcess)),
        );
        const nonLoopback = established.filter(
          (row) => !LOOPBACKS.has(String(row.RemoteAddress).toLowerCase()),
        );
        stats.samples += 1;
        stats.maximumOwnedProcessCount = Math.max(
          stats.maximumOwnedProcessCount,
          owned.size,
        );
        stats.nonLoopbackEstablishedCount += nonLoopback.length;
        if (nonLoopback.length !== 0) {
          failureCode = "p114_non_loopback_socket_detected";
          stopping = true;
        }
      } catch {
        failureCode = "p114_process_tree_network_audit_failed";
        stopping = true;
      }
      if (!stopping) await delay(250);
    }
  })();
  return {
    stats,
    async stop() {
      stopping = true;
      await promise;
      if (failureCode) throw new Error(failureCode);
      return stats;
    },
  };
}

async function liveRecordedProcessRows(identities) {
  const rows = await processRows();
  return rows.filter((row) => {
    const identity = processIdentity(row);
    return identity !== null && identities.has(identity);
  });
}

async function terminateRecordedProcessTrees(identities) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const rows = await liveRecordedProcessRows(identities);
    if (rows.length === 0) return;
    const livePids = new Set(rows.map((row) => Number(row.ProcessId)));
    const depth = (row) => {
      let value = 0;
      let parent = Number(row.ParentProcessId);
      const seen = new Set();
      while (livePids.has(parent) && !seen.has(parent)) {
        seen.add(parent);
        value += 1;
        parent = Number(
          rows.find((candidate) => Number(candidate.ProcessId) === parent)
            ?.ParentProcessId || 0,
        );
      }
      return value;
    };
    rows.sort((left, right) => depth(right) - depth(left));
    for (const row of rows) {
      const identity = processIdentity(row);
      if (!identity || !identities.has(identity)) continue;
      try {
        await execFileAsync(
          "taskkill.exe",
          ["/PID", String(row.ProcessId), "/T", "/F"],
          { windowsHide: true, timeout: 10_000 },
        );
      } catch {
        // The exact process identity may exit between the re-read and taskkill.
      }
    }
    await delay(300);
  }
  if ((await liveRecordedProcessRows(identities)).length !== 0) {
    throw new Error("p114_owned_process_cleanup_failed");
  }
}

async function auditOwnedSockets(
  nextPid,
  chromePid,
  runtimePort,
  cdpPort,
  identities,
) {
  const processes = await processRows();
  const owned = rememberOwnedProcessIdentities(
    processes,
    [nextPid, chromePid],
    identities,
  );
  const established = (await tcpRows("Established")).filter((row) =>
    owned.has(Number(row.OwningProcess)),
  );
  const nonLoopback = established.filter(
    (row) => !LOOPBACKS.has(String(row.RemoteAddress).toLowerCase()),
  );
  if (nonLoopback.length !== 0) {
    throw new Error("p114_non_loopback_socket_detected");
  }
  const listeners = (await tcpRows("Listen")).filter((row) =>
    owned.has(Number(row.OwningProcess)),
  );
  for (const listener of listeners) {
    const local = String(listener.LocalAddress).toLowerCase();
    const port = Number(listener.LocalPort);
    if (!LOOPBACKS.has(local) || !new Set([runtimePort, cdpPort]).has(port)) {
      throw new Error("p114_unexpected_listener_detected");
    }
  }
  return {
    ownedProcessCount: owned.size,
    establishedLoopbackCount: established.length,
    nonLoopbackEstablishedCount: 0,
    listenerCount: listeners.length,
  };
}

async function terminateExactProcessTree(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  if (await waitForExit(child, 5_000)) return;
  try {
    await execFileAsync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      timeout: 10_000,
    });
  } catch {
    // A process that exits between the bounded wait and taskkill is already clean.
  }
  if (!(await waitForExit(child, 5_000))) {
    throw new Error("p114_process_cleanup_failed");
  }
}

async function processIsPresent(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  return (await processRows()).some((row) => Number(row.ProcessId) === pid);
}

async function closeBrowser(cdpPort, browserWebSocketPath) {
  if (!cdpPort || !browserWebSocketPath) return;
  const client = new CdpClient(
    `ws://127.0.0.1:${cdpPort}${browserWebSocketPath}`,
    "http://127.0.0.1",
    "browser-close",
  );
  try {
    await client.open();
    await client.command("Browser.close");
  } catch {
    // Precise PID cleanup remains the bounded fallback.
  } finally {
    client.close();
  }
}

async function removeJunctions(junctions) {
  for (const item of [...junctions].reverse()) {
    const info = await lstat(item.link);
    const linkedReal = await realpath(item.link);
    if (
      !info.isSymbolicLink() ||
      linkedReal.toLowerCase() !== item.targetReal.toLowerCase()
    ) {
      throw new Error("p114_junction_cleanup_verification_failed");
    }
    await unlink(item.link);
    try {
      await lstat(item.link);
      throw new Error("p114_junction_cleanup_failed");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

async function assertNoReparse(root) {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const candidate = path.resolve(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error("p114_temp_reparse_remaining");
      if (entry.isDirectory()) pending.push(candidate);
    }
  }
}

async function removeOwnedTempRoot(tempRoot, ownershipToken) {
  const systemTemp = await realpath(tmpdir());
  const resolved = path.resolve(tempRoot);
  if (
    !pathWithin(systemTemp, resolved) ||
    !path.basename(resolved).startsWith("aistory-p114-video-player-")
  ) {
    throw new Error("p114_temp_root_not_owned");
  }
  const marker = await readFile(path.resolve(resolved, ".p114-owner"), "utf8");
  if (marker !== `${ownershipToken}\n`) throw new Error("p114_temp_owner_invalid");
  await assertNoReparse(resolved);
  let lastError;
  for (const wait of [0, 250, 750, 1_500]) {
    if (wait) await delay(wait);
    try {
      await rm(resolved, { recursive: true, force: false, maxRetries: 0 });
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw new Error("p114_temp_cleanup_failed");
  try {
    await access(resolved);
    throw new Error("p114_temp_cleanup_failed");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

await mkdir(evidenceParent, { recursive: true });
const evidenceRoot = await mkdtemp(
  path.join(evidenceParent, "p1.14-video-player-browser-"),
);
const ownershipToken = randomBytes(16).toString("hex");
const systemTempRoot = await realpath(tmpdir());
const tempRoot = await mkdtemp(
  path.join(systemTempRoot, "aistory-p114-video-player-"),
);
await writeFile(path.resolve(tempRoot, ".p114-owner"), `${ownershipToken}\n`, {
  encoding: "utf8",
  flag: "wx",
});

let nextServer = null;
let buildProcess = null;
let chrome = null;
let cdpPort = null;
let browserWebSocketPath = null;
let runtimePort = null;
let junctions = [];
let report = null;
let failureCode = null;
const ownedProcessIdentities = new Map();
let processTreeNetworkMonitor = null;
let processTreeNetworkStats = {
  samples: 0,
  maximumOwnedProcessCount: 0,
  nonLoopbackEstablishedCount: 0,
};
let cleanup = {
  buildExited: false,
  browserExited: false,
  nextExited: false,
  ownedProcessTreeExited: false,
  portsReleased: false,
  junctionsUnlinked: false,
  tempRootRemoved: false,
  profileRemoved: false,
};

try {
  await assertStagedEmpty();
  const p13Before = await readPinnedFiles();
  const sharedPorts = parseRegisteredPorts(
    await readFile(sharedPortsFile, "utf8"),
  );
  const chromeBytes = await readFile(chromeExecutable);
  const nextBytes = await readFile(nextCli);
  if (sha256(chromeBytes) !== CHROME_SHA256) {
    throw new Error("p114_chromium_pin_drift");
  }
  if (sha256(nextBytes) !== NEXT_CLI_SHA256) {
    throw new Error("p114_next_cli_pin_drift");
  }
  const chromeVersionResult = await execFileAsync(chromeExecutable, ["--version"], {
    windowsHide: true,
    timeout: 10_000,
  });
  const chromiumVersion = String(chromeVersionResult.stdout || chromeVersionResult.stderr)
    .trim()
    .match(/\d+\.\d+\.\d+\.\d+/)?.[0];
  if (!chromiumVersion) throw new Error("p114_chromium_version_invalid");

  processTreeNetworkMonitor = createProcessTreeNetworkMonitor(
    process.pid,
    ownedProcessIdentities,
  );
  const scaffold = await scaffoldHarness(tempRoot, junctions);
  const legalCarrier = await prepareLegalCarrier(tempRoot);
  const harnessNextCli = path.resolve(
    tempRoot,
    "node_modules",
    "next",
    "dist",
    "bin",
    "next",
  );
  const harnessNextCliReal = await realpath(harnessNextCli);
  if (harnessNextCliReal.toLowerCase() !== (await realpath(nextCli)).toLowerCase()) {
    throw new Error("p114_temp_next_cli_mismatch");
  }
  const nextModuleRoot = path.resolve(
    path.dirname(harnessNextCliReal),
    "..",
    "..",
  );
  const nextEnvironment = {
    ...minimalChildEnvironment("production"),
    NODE_PATH: [
      path.resolve(repoRoot, "node_modules"),
      path.dirname(nextModuleRoot),
      path.resolve(
        repoRoot,
        "node_modules",
        ".pnpm",
        "picocolors@1.1.1",
        "node_modules",
      ),
      path.resolve(
        repoRoot,
        "node_modules",
        ".pnpm",
        "nanoid@3.3.12",
        "node_modules",
      ),
      path.resolve(
        repoRoot,
        "node_modules",
        ".pnpm",
        "source-map-js@1.2.1",
        "node_modules",
      ),
      path.resolve(
        repoRoot,
        "node_modules",
        ".pnpm",
        "scheduler@0.27.0",
        "node_modules",
      ),
    ].join(path.delimiter),
  };
  buildProcess = spawn(
    process.execPath,
    [
      "--preserve-symlinks",
      "--preserve-symlinks-main",
      harnessNextCli,
      "build",
      "--webpack",
    ],
    {
    cwd: tempRoot,
    env: nextEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    },
  );
  const buildOutput = captureChild(buildProcess);
  try {
    await waitForChild(buildProcess, 180_000, "p114_next_build_failed");
  } catch {
    throw new Error(classifyNextBuildFailure(buildOutput));
  }

  runtimePort = await reserveEphemeralPort(sharedPorts);
  if (sharedPorts.has(runtimePort)) throw new Error("p114_reserved_port_selected");
  nextServer = spawn(
    process.execPath,
    [
      "--preserve-symlinks-main",
      "--preserve-symlinks",
      harnessNextCli,
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(runtimePort),
    ],
    {
      cwd: tempRoot,
      env: nextEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  captureChild(nextServer);
  const runtimeOrigin = `http://127.0.0.1:${runtimePort}`;
  await waitForServer(runtimeOrigin);

  const profileRoot = path.resolve(tempRoot, "chrome-profile");
  await mkdir(profileRoot, { recursive: false });
  chrome = spawn(
    chromeExecutable,
    [
      "--headless=new",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
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
      "--disable-features=MediaRouter,OptimizationHints,Translate,NetworkTimeServiceQuerying",
      "--disable-gpu",
      "--disable-breakpad",
      "--mute-audio",
      "--autoplay-policy=no-user-gesture-required",
      "--window-size=1440,900",
      "about:blank",
    ],
    {
      cwd: tempRoot,
      env: minimalChildEnvironment("production"),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  captureChild(chrome);
  const activePortFile = path.resolve(profileRoot, "DevToolsActivePort");
  const activePortDeadline = Date.now() + 20_000;
  let activePortText = "";
  while (!activePortText && Date.now() < activePortDeadline) {
    try {
      activePortText = await readFile(activePortFile, "utf8");
    } catch {
      await delay(100);
    }
  }
  const activePortLines = activePortText.trim().split(/\r?\n/);
  cdpPort = Number(activePortLines[0]);
  browserWebSocketPath = activePortLines[1] || null;
  if (
    !Number.isInteger(cdpPort) ||
    cdpPort <= 0 ||
    sharedPorts.has(cdpPort) ||
    !browserWebSocketPath?.startsWith("/devtools/browser/")
  ) {
    throw new Error("p114_cdp_port_invalid");
  }
  const version = await cdpJson(cdpPort, "/json/version");
  if (
    typeof version.Browser !== "string" ||
    !version.Browser.includes(chromiumVersion) ||
    version["Protocol-Version"] !== "1.3"
  ) {
    throw new Error("p114_cdp_version_invalid");
  }

  const socketSamples = [];
  const socketAudit = async () => {
    const sample = await auditOwnedSockets(
      nextServer.pid,
      chrome.pid,
      runtimePort,
      cdpPort,
      ownedProcessIdentities,
    );
    socketSamples.push(sample);
  };
  const matrix = [];
  for (const scenario of SCENARIOS) {
    for (const viewport of VIEWPORTS) {
      matrix.push(
        await runBrowserCell({
          cdpPort,
          runtimeOrigin,
          scenario,
          viewport,
          evidenceRoot,
          socketAudit,
        }),
      );
    }
  }
  if (matrix.length !== 6 || socketSamples.length !== 6) {
    throw new Error("p114_matrix_incomplete");
  }

  const p13During = await readPinnedFiles();
  if (JSON.stringify(p13During) !== JSON.stringify(p13Before)) {
    throw new Error("p114_p13_pin_drift");
  }
  await assertStagedEmpty();
  report = {
    schema: "aistory-video-story-player-browser-smoke",
    schemaVersion: 1,
    status: "PASS_LOCAL_ISOLATED_CHROMIUM_PLAYER_SMOKE_ONLY",
    evidenceLevel: "LOCAL_CHROMIUM_DOM_MEDIA_EVENT_PATH_OBSERVED_ONLY",
    isolatedHarness: {
      productionBuild: true,
      canonicalRepositoryBuild: false,
      nextCliSha256: NEXT_CLI_SHA256,
      chromiumVersion,
      chromiumSha256: CHROME_SHA256,
      runtimePort,
      cdpPort,
      osTempRootUsed: true,
      freshProfile: true,
      noLogin: true,
    },
    fixturePins: scaffold.fixturePins,
    legalCarrier,
    p13PinsBeforeAfter: Object.fromEntries(
      Object.entries(p13Before).map(([file, value]) => [
        file,
        { ...value, unchanged: JSON.stringify(value) === JSON.stringify(p13During[file]) },
      ]),
    ),
    matrix,
    network: {
      matrixSamples: socketSamples.length,
      nonLoopbackEstablishedCount: 0,
      externalRequestCount: 0,
      blockedExternalAttemptCount: 0,
      rendererWebSocketCount: 0,
      processTreeSamples: 0,
      maximumOwnedProcessCount: 0,
      loopbackOnly: true,
    },
    boundaries: {
      worldModelMp4IsLaunchFootage: false,
      malformedFixtureProvesReviewedMp4Recovery: false,
      audioVideoSyncVerified: false,
      allSteamElectronOsVariantsVerified: false,
      accessibilityVerified: false,
      steamReady: false,
      p112MaterializedAssetCount: 0,
      p112PlaybackReady: false,
      productionEnabled: false,
      p026FounderDecisionPresent: false,
      p034FounderDecisionPresent: false,
    },
  };
} catch (error) {
  failureCode = safeErrorCode(error);
} finally {
  try {
    if (processTreeNetworkMonitor) {
      processTreeNetworkStats = await processTreeNetworkMonitor.stop();
    }
    const rows = await processRows();
    rememberOwnedProcessIdentities(
      rows,
      [process.pid],
      ownedProcessIdentities,
    );
    if (report) {
      report.network.processTreeSamples = processTreeNetworkStats.samples;
      report.network.maximumOwnedProcessCount =
        processTreeNetworkStats.maximumOwnedProcessCount;
      report.network.nonLoopbackEstablishedCount =
        processTreeNetworkStats.nonLoopbackEstablishedCount;
    }
  } catch (error) {
    failureCode ||= safeErrorCode(error);
  }
  try {
    await terminateExactProcessTree(buildProcess);
    cleanup.buildExited =
      !buildProcess || !(await processIsPresent(buildProcess.pid));
    if (!cleanup.buildExited) throw new Error("p114_build_cleanup_failed");
  } catch {
    failureCode ||= "p114_build_cleanup_failed";
  }
  try {
    await closeBrowser(cdpPort, browserWebSocketPath);
    await terminateExactProcessTree(chrome);
    cleanup.browserExited = !chrome || !(await processIsPresent(chrome.pid));
    if (!cleanup.browserExited) throw new Error("p114_browser_cleanup_failed");
  } catch {
    failureCode ||= "p114_browser_cleanup_failed";
  }
  try {
    await terminateExactProcessTree(nextServer);
    cleanup.nextExited = !nextServer || !(await processIsPresent(nextServer.pid));
    if (!cleanup.nextExited) throw new Error("p114_next_cleanup_failed");
  } catch {
    failureCode ||= "p114_next_cleanup_failed";
  }
  try {
    await terminateRecordedProcessTrees(ownedProcessIdentities);
    cleanup.ownedProcessTreeExited =
      (await liveRecordedProcessRows(ownedProcessIdentities)).length === 0;
    if (!cleanup.ownedProcessTreeExited) {
      throw new Error("p114_owned_process_cleanup_failed");
    }
  } catch {
    failureCode ||= "p114_owned_process_cleanup_failed";
  }
  try {
    cleanup.portsReleased =
      (!runtimePort || (await canBindPort(runtimePort))) &&
      (!cdpPort || (await canBindPort(cdpPort)));
    if (!cleanup.portsReleased) throw new Error("p114_port_cleanup_failed");
  } catch {
    failureCode ||= "p114_port_cleanup_failed";
  }
  try {
    if (
      !cleanup.buildExited ||
      !cleanup.browserExited ||
      !cleanup.nextExited ||
      !cleanup.ownedProcessTreeExited ||
      !cleanup.portsReleased
    ) {
      throw new Error("p114_process_or_port_cleanup_incomplete");
    }
    await removeJunctions(junctions);
    cleanup.junctionsUnlinked = true;
  } catch {
    failureCode ||= "p114_junction_cleanup_failed";
  }
  try {
    if (cleanup.junctionsUnlinked) {
      await removeOwnedTempRoot(tempRoot, ownershipToken);
      cleanup.tempRootRemoved = true;
      cleanup.profileRemoved = true;
    }
  } catch {
    failureCode ||= "p114_temp_cleanup_failed";
  }
}

try {
  const p13After = await readPinnedFiles();
  await assertStagedEmpty();
  if (report) {
    for (const [file, pin] of Object.entries(report.p13PinsBeforeAfter)) {
      if (JSON.stringify({ bytes: pin.bytes, sha256: pin.sha256, mtimeMs: pin.mtimeMs }) !== JSON.stringify(p13After[file])) {
        failureCode ||= "p114_p13_pin_drift";
      }
    }
  }
} catch (error) {
  failureCode ||= safeErrorCode(error);
}

const finalReport = report
  ? {
      ...report,
      status: failureCode ? "BLOCKED" : report.status,
      ...(failureCode ? { failureCode } : {}),
      cleanup,
    }
  : {
      schema: "aistory-video-story-player-browser-smoke",
      schemaVersion: 1,
      status: "BLOCKED",
      failureCode: failureCode || "p114_unavailable",
      cleanup,
      boundaries: {
        worldModelMp4IsLaunchFootage: false,
        malformedFixtureProvesReviewedMp4Recovery: false,
        audioVideoSyncVerified: false,
        steamReady: false,
        p112MaterializedAssetCount: 0,
        p112PlaybackReady: false,
        productionEnabled: false,
      },
    };
const reportFile = path.resolve(evidenceRoot, "video-story-player-browser-smoke.json");
await writeFile(reportFile, `${JSON.stringify(finalReport, null, 2)}\n`, {
  encoding: "utf8",
  flag: "wx",
});

if (failureCode) throw new Error(failureCode);
console.log(`P1.14 browser smoke passed: ${reportFile}`);
