import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const MAX_RUNTIME_FILE_BYTES = 256 * 1024 * 1024;
const projectRoot = path.resolve(process.cwd());
const steamRoot = path.resolve(projectRoot, "dist", "steam");
const stagingRoot = path.resolve(steamRoot, "staging");
const runtimeRoot = path.resolve(stagingRoot, "runtime");
const targetPlatform = String(
  process.env.AISTORY_STEAM_TARGET || "windows-x64",
).trim();
const dependencyRoot = process.env.AISTORY_STEAM_DEPENDENCY_ROOT
  ? path.resolve(process.env.AISTORY_STEAM_DEPENDENCY_ROOT)
  : path.resolve(projectRoot, "node_modules");
const appVersion = String(process.env.AISTORY_STEAM_APP_VERSION || "").trim();
const releaseId = String(process.env.AISTORY_STEAM_RELEASE_ID || "").trim();

if (!new Set(["windows-x64", "linux-x64"]).has(targetPlatform)) {
  throw new Error("steam_stage_target_platform_invalid");
}
if (!/^[a-z0-9][a-z0-9._-]{0,95}$/i.test(appVersion)) {
  throw new Error("steam_stage_app_version_invalid");
}
if (
  !/^[a-z0-9][a-z0-9._-]{0,95}$/i.test(releaseId) ||
  /^(?:akia|ltai|sk[-_])/i.test(releaseId)
) {
  throw new Error("steam_stage_release_id_invalid");
}


const forbiddenNames = new Set([
  ".next/cache",
  ".next/dev",
  "node_modules/.pnpm",
  "node_modules/.cache",
  "node_modules/.package-map.json",
  "node_modules/.pnpm-workspace-state-v1.json",
  "public/home/prompts.json",
  "app/app",
  "components/components",
  "lib/lib",
]);
const forbiddenRuntimeRoots = new Set([
  ".git",
  ".codex-logs",
  ".logs",
  ".tmp",
  "build",
  "content",
  "dist",
  "docs",
  "downloads",
  "experiments",
  "logs",
  "out",
  "pids",
  "tmp",
  "@cloudflare",
  "@electron",
  "@opennextjs",
  "@types",
  "autoprefixer",
  "cross-env",
  "electron",
  "eslint",
  "eslint-config-next",
  "postcss",
  "tailwindcss",
  "tsx",
  "typescript",
  "wrangler",
]);
const forbiddenNodeModuleRoots = new Set([
  "@cloudflare",
  "@electron",
  "@opennextjs",
  "@types",
  "autoprefixer",
  "cross-env",
  "electron",
  "eslint",
  "eslint-config-next",
  "postcss",
  "tailwindcss",
  "tsx",
  "typescript",
  "wrangler",
]);
const forbiddenExtensions = new Set([
  ".rar",
  ".7z",
  ".zip",
  ".pem",
  ".p12",
  ".pfx",
  ".key",
  ".map",
  ".md",
  ".ts",
  ".tsx",
]);
const textExtensions = new Set([
  ".js",
  ".cjs",
  ".mjs",
  ".json",
  ".txt",
  ".html",
  ".css",
  ".map",
  ".md",
]);

function assertInside(parent, child) {
  const relative = path.relative(parent, child);
  if (!relative || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return;
  }
  throw new Error("steam_stage_path_outside_project");
}

function normalizedRelative(relativePath) {
  return relativePath.split(path.sep).join("/").toLowerCase();
}

function forbidden(relativePath) {
  const normalized = normalizedRelative(relativePath);
  const basename = path.basename(normalized);
  const runtimeRelative = normalized.startsWith("runtime/")
    ? normalized.slice("runtime/".length)
    : normalized;
  const rootSegment = runtimeRelative.split("/")[0] || "";
  if (forbiddenRuntimeRoots.has(rootSegment)) return true;
  const moduleRelative = runtimeRelative.startsWith("node_modules/")
    ? runtimeRelative.slice("node_modules/".length)
    : "";
  if (
    moduleRelative &&
    forbiddenNodeModuleRoots.has(moduleRelative.split("/")[0] || "")
  ) {
    return true;
  }
  if (
    runtimeRelative.startsWith("node_modules/.pnpm/") &&
    /(?:^|\/)(?:miniflare|wrangler|@cloudflare\+|@electron\+|@opennextjs\+|eslint(?:@|\+|-)|typescript@|tsx@|tailwindcss@|autoprefixer@|postcss@)/.test(
      runtimeRelative,
    )
  ) {
    return true;
  }
  if (
    basename === ".env" ||
    basename.startsWith(".env.") ||
    basename.startsWith(".aistory-")
  ) {
    return true;
  }
  if (forbiddenExtensions.has(path.extname(basename))) return true;
  return [...forbiddenNames].some(
    (name) =>
      runtimeRelative === name || runtimeRelative.startsWith(`${name}/`),
  );
}

async function copySafeTree(
  sourceRoot,
  destinationRoot,
  prefix = "",
  allowedSourceRoots = [sourceRoot],
) {
  const sourceInfo = await lstat(sourceRoot);
  if (sourceInfo.isSymbolicLink()) {
    throw new Error(`steam_stage_symlink_rejected:${prefix || "."}`);
  }
  if (!sourceInfo.isDirectory()) {
    throw new Error(`steam_stage_source_not_directory:${prefix || "."}`);
  }
  await mkdir(destinationRoot, { recursive: true });
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const relative = path.join(prefix, entry.name);
    if (forbidden(relative)) continue;
    const source = path.join(sourceRoot, entry.name);
    const destination = path.join(destinationRoot, entry.name);
    let effectiveSource = source;
    let info = await lstat(source);
    if (info.isSymbolicLink()) {
      try {
        effectiveSource = await realpath(source);
      } catch (error) {
        if (error && typeof error === "object" && error.code === "ENOENT") {
          continue;
        }
        throw error;
      }
      const allowed = allowedSourceRoots.some((root) => {
        try {
          assertInside(path.resolve(root), effectiveSource);
          return true;
        } catch {
          return false;
        }
      });
      if (!allowed) {
        throw new Error(`steam_stage_symlink_rejected:${relative}`);
      }
      info = await stat(effectiveSource);
    }
    if (info.isDirectory()) {
      await copySafeTree(
        effectiveSource,
        destination,
        relative,
        allowedSourceRoots,
      );
      continue;
    }
    if (!info.isFile()) continue;
    if (info.size > MAX_RUNTIME_FILE_BYTES) {
      throw new Error(`steam_stage_file_too_large:${relative}`);
    }
    await mkdir(path.dirname(destination), { recursive: true });
    const bytes = await readFile(effectiveSource);
    try {
      await writeFile(destination, bytes, { flag: "wx" });
    } catch (error) {
      if (
        !(error && typeof error === "object" && "code" in error) ||
        error.code !== "EEXIST"
      ) {
        throw error;
      }
      const existing = await readFile(destination);
      if (!existing.equals(bytes)) {
        throw new Error(`steam_stage_duplicate_conflict:${relative}`);
      }
    }
  }
}

async function collectManifest(root) {
  const files = [];
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        throw new Error(`steam_manifest_symlink_rejected:${relative}`);
      }
      if (info.isDirectory()) {
        await walk(absolute);
        continue;
      }
      const bytes = await readFile(absolute);
      if (
        textExtensions.has(path.extname(entry.name).toLowerCase()) &&
        bytes.length <= 8 * 1024 * 1024
      ) {
        const text = bytes.toString("utf8");
        if (
          /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\s+[A-Za-z0-9+/=\r\n]{128,}\s+-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(
            text,
          ) ||
          /\bAKIA[0-9A-Z]{16}\b/.test(text)
        ) {
          throw new Error(`steam_stage_secret_signature:${relative}`);
        }
      }
      files.push({
        path: relative,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  }
  await walk(root);
  return files;
}

function sanitizePortableNextConfig(config) {
  if (!config || typeof config !== "object") {
    throw new Error("steam_stage_next_config_invalid");
  }
  config.outputFileTracingRoot = ".";
  config.allowedDevOrigins = ["localhost", "127.0.0.1"];
  if (config.turbopack && typeof config.turbopack === "object") {
    config.turbopack.root = ".";
  }
  return config;
}

async function sanitizeStandaloneMetadata() {
  const requiredFilesPath = path.resolve(
    runtimeRoot,
    ".next",
    "required-server-files.json",
  );
  const requiredFiles = JSON.parse(
    await readFile(requiredFilesPath, "utf8"),
  );
  requiredFiles.appDir = ".";
  sanitizePortableNextConfig(requiredFiles.config);
  await writeFile(
    requiredFilesPath,
    `${JSON.stringify(requiredFiles)}\n`,
    "utf8",
  );

  const serverPath = path.resolve(runtimeRoot, "server.js");
  const serverSource = await readFile(serverPath, "utf8");
  const marker = "const nextConfig = ";
  const start = serverSource.indexOf(marker);
  const end = start < 0 ? -1 : serverSource.indexOf("\n", start);
  if (start < 0 || end < 0) {
    throw new Error("steam_stage_standalone_config_marker_missing");
  }
  const serializedConfig = serverSource
    .slice(start + marker.length, end)
    .trim();
  const portableConfig = sanitizePortableNextConfig(
    JSON.parse(serializedConfig),
  );
  await writeFile(
    serverPath,
    `${serverSource.slice(0, start)}${marker}${JSON.stringify(portableConfig)}${serverSource.slice(end)}`,
    "utf8",
  );
}

async function main() {
  assertInside(projectRoot, steamRoot);
  assertInside(steamRoot, stagingRoot);
  const standaloneContainer = path.resolve(projectRoot, ".next", "standalone");
  const tracingRoot = process.env.AISTORY_STEAM_TURBOPACK_ROOT
    ? path.resolve(process.env.AISTORY_STEAM_TURBOPACK_ROOT)
    : projectRoot;
  const nestedProjectRelative = path.relative(tracingRoot, projectRoot);
  const nestedStandaloneRoot = path.resolve(
    standaloneContainer,
    nestedProjectRelative,
  );
  const standaloneRoot = await stat(
    path.resolve(standaloneContainer, "server.js"),
  )
    .then(() => standaloneContainer)
    .catch(() => nestedStandaloneRoot);
  const standaloneServer = path.resolve(standaloneRoot, "server.js");
  await stat(standaloneServer).catch(() => {
    throw new Error(
      "缺少 .next/standalone/server.js；请先使用 BUILD_STANDALONE=true 构建。",
    );
  });

  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(stagingRoot, { recursive: true });
  await copySafeTree(standaloneRoot, runtimeRoot, "runtime", [
    standaloneRoot,
    dependencyRoot,
  ]);
  const tracedPnpmNodeModules = path.resolve(
    standaloneRoot,
    "node_modules",
    ".pnpm",
    "node_modules",
  );
  for (const packageName of [
    "@next/env",
    "@next/swc-win32-x64-msvc",
    "@swc",
    "baseline-browser-mapping",
    "busboy",
    "caniuse-lite",
    "client-only",
    "nanoid",
    "picocolors",
    "postcss",
    "source-map-js",
    "styled-jsx",
  ]) {
    const sourceLink = path.resolve(tracedPnpmNodeModules, packageName);
    await stat(sourceLink)
      .then(async () => {
        const source = await realpath(sourceLink);
        return (
        copySafeTree(
          source,
          path.resolve(runtimeRoot, "node_modules", packageName),
          `runtime/node_modules/${packageName}`,
          [standaloneRoot, dependencyRoot],
        )
        );
      })
      .catch((error) => {
        if (error && typeof error === "object" && error.code === "ENOENT") return;
        throw error;
      });
  }
  await copySafeTree(
    path.resolve(projectRoot, ".next", "static"),
    path.resolve(runtimeRoot, ".next", "static"),
    "runtime/.next/static",
  );
  await copySafeTree(
    path.resolve(projectRoot, "public"),
    path.resolve(runtimeRoot, "public"),
    "runtime/public",
  );
  await copySafeTree(
    path.resolve(projectRoot, "desktop"),
    path.resolve(stagingRoot, "desktop"),
    "desktop",
  );
  await sanitizeStandaloneMetadata();

  const packageJson = {
    name: "aistory-steam-desktop",
    productName: "AIstory",
    version: appVersion,
    private: true,
    type: "module",
    main: "desktop/main.mjs",
  };
  await writeFile(
    path.resolve(stagingRoot, "package.json"),
    `${JSON.stringify(packageJson, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );

  const files = await collectManifest(stagingRoot);
  const manifest = {
    schemaVersion: 1,
    product: "AIstory",
    platform: targetPlatform,
    appVersion,
    releaseId,
    steamDeckRuntime:
      targetPlatform === "linux-x64"
        ? "native-linux-candidate"
        : "proton-planned",
    generatedAt: new Date().toISOString(),
    files,
    totals: {
      files: files.length,
      bytes: files.reduce((total, file) => total + file.bytes, 0),
    },
    productionClaims: {
      steamworksConnected: false,
      steamWalletConnected: false,
      nativeLinuxVerified: false,
      protonVerified: false,
      steamDeckVerified: false,
    },
  };
  await writeFile(
    path.resolve(stagingRoot, "steam-runtime-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(
    `Steam runtime staged: ${manifest.totals.files} files, ${manifest.totals.bytes} bytes\n`,
  );
}

await main();
