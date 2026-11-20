import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { packager } from "@electron/packager";

const ELECTRON_VERSION = "43.2.0";
const ELECTRON_ZIP_NAME = `electron-v${ELECTRON_VERSION}-win32-x64.zip`;
const ELECTRON_ZIP_BYTES = 144_326_439;
const ELECTRON_ZIP_SHA256 =
  "eba5f5088af40ecb364fe258809c79a5234c6ece5a75c64722772eba01b02786";
const MAX_AUDIT_TEXT_BYTES = 8 * 1024 * 1024;
const projectRoot = path.resolve(process.cwd());
const steamRoot = path.resolve(projectRoot, "dist", "steam");
const stagingRoot = path.resolve(steamRoot, "staging");
const outputRoot = path.resolve(steamRoot, "windows-x64");
const sensitiveBuildRoots = [projectRoot, os.homedir()]
  .map((value) => path.resolve(value).replaceAll("\\", "/").replace(/\/+$/, ""))
  .filter((value) => value.length > 3);
const textExtensions = new Set([
  ".js",
  ".cjs",
  ".mjs",
  ".json",
  ".txt",
  ".html",
  ".css",
  ".md",
]);

function assertInside(parent, child) {
  const relative = path.relative(parent, child);
  if (!relative || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return;
  }
  throw new Error("steam_windows_package_path_outside_dist");
}

async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function findZip(directory, depth = 0) {
  if (!path.isAbsolute(directory) || depth > 3) return null;
  let entries;
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) return null;
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return null;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === ELECTRON_ZIP_NAME) return absolute;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const found = await findZip(path.join(directory, entry.name), depth + 1);
    if (found) return found;
  }
  return null;
}

function electronCacheRoots() {
  const roots = [];
  const explicit = String(
    process.env.AISTORY_STEAM_ELECTRON_ZIP_DIR || "",
  ).trim();
  const standard = String(process.env.ELECTRON_CACHE || "").trim();
  if (explicit) roots.push(path.resolve(explicit));
  if (standard) roots.push(path.resolve(standard));
  if (process.env.LOCALAPPDATA) {
    roots.push(path.join(process.env.LOCALAPPDATA, "electron", "Cache"));
  }
  return [...new Set(roots)];
}

async function resolveCachedElectronZip() {
  for (const root of electronCacheRoots()) {
    const found = await findZip(root);
    if (!found) continue;
    const info = await lstat(found);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size !== ELECTRON_ZIP_BYTES
    ) {
      continue;
    }
    const handle = await open(found, "r");
    try {
      const header = Buffer.alloc(4);
      await handle.read(header, 0, header.length, 0);
      if (!header.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) continue;
    } finally {
      await handle.close();
    }
    if ((await sha256File(found)) !== ELECTRON_ZIP_SHA256) continue;
    return found;
  }
  throw new Error(
    "BLOCKED_NATIVE_BINARY_NOT_BUILT:missing_or_invalid_cached_electron_windows_x64",
  );
}

function assertSafeReleasePath(relative) {
  const normalized = relative.replaceAll("\\", "/").toLowerCase();
  const segments = normalized.split("/");
  if (
    segments.includes(".git") ||
    segments.includes(".tmp") ||
    segments.some((segment) => segment === ".env" || segment.startsWith(".env.")) ||
    segments.some((segment) => segment.startsWith(".aistory-")) ||
    normalized.includes("/.next/dev/") ||
    normalized.endsWith("/.next/dev") ||
    normalized.includes("/app/app/") ||
    normalized.includes("/components/components/") ||
    normalized.includes("/lib/lib/") ||
    normalized.endsWith("/public/home/prompts.json") ||
    normalized.endsWith(".map") ||
    normalized.endsWith(".log")
  ) {
    throw new Error(`steam_windows_release_forbidden_path:${relative}`);
  }
}

function assertSafeText(relative, text) {
  const normalizedText = text.replaceAll("\\\\", "\\").replaceAll("\\", "/");
  const containsBuildAbsolutePath = sensitiveBuildRoots.some(
    (root) =>
      normalizedText.includes(`${root}/`) || normalizedText.includes(`${root}\"`),
  );
  if (
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\s+[A-Za-z0-9+/=\r\n]{128,}\s+-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(
      text,
    ) ||
    /\bAKIA[0-9A-Z]{16}\b/.test(text) ||
    /\bLTAI[A-Za-z0-9]{16,}\b/.test(text) ||
    /\bsk-[A-Za-z0-9_-]{24,}\b/.test(text) ||
    /\bBearer\s+[A-Za-z0-9._~+\/-]{24,}={0,2}\b/i.test(text) ||
    containsBuildAbsolutePath
  ) {
    throw new Error(`steam_windows_release_sensitive_text:${relative}`);
  }
}

async function collectReleaseManifest(root) {
  const files = [];
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      assertSafeReleasePath(relative);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        throw new Error(`steam_windows_release_symlink_rejected:${relative}`);
      }
      if (info.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!info.isFile()) continue;
      if (
        textExtensions.has(path.extname(entry.name).toLowerCase()) &&
        info.size <= MAX_AUDIT_TEXT_BYTES
      ) {
        assertSafeText(relative, await readFile(absolute, "utf8"));
      }
      files.push({
        path: relative,
        bytes: info.size,
        sha256: await sha256File(absolute),
      });
    }
  }
  await walk(root);
  return files;
}

function readme(appDirectory) {
  return `AIstory Windows x64 Demo - local test candidate\r\n\r\nLaunch\r\n  ${appDirectory}\\AIstory.exe\r\n\r\nRequirements\r\n  Windows 10/11 x64. This directory candidate is unsigned; Windows may show a warning.\r\n\r\nIncluded\r\n  Offline author-locked chapters, published world-model demos, subtitles, choices, and browser-local saves/settings.\r\n  The bundled server binds only 127.0.0.1. The first assigned random port is reused inside the same userData profile so IndexedDB/localStorage remain available after restart.\r\n\r\nLocal test report\r\n  Open Settings and choose Export test report. The UTF-8 JSON is generated only in the renderer and is never uploaded.\r\n  Download is the primary action. If the browser blocks it, use Copy the same redacted content and send it yourself.\r\n  The report never automatically reads accounts, phone numbers, saves/story prose, BYOK or hosted keys, endpoints, prompts, workflows, provider tasks, local paths, logs, or raw errors. The issue description is manually entered; do not paste sensitive data. Delete the downloaded JSON to remove it.\r\n\r\nNot included\r\n  Steamworks/AppID, Steam Cloud/Input/Overlay/Wallet, code signing, depot upload, SMS, platform-paid generation, OSS/Supabase/IMDS, ComfyUI/4090, or model execution. BYOK and hosted credentials are not copied from browsers.\r\n\r\nExit and removal\r\n  Close the AIstory window and wait for all AIstory processes to exit. Delete this whole directory to remove the Demo.\r\n  To also clear this Demo's local saves/settings, delete %APPDATA%\\AIstory after AIstory has fully exited.\r\n`;
}

async function main() {
  assertInside(steamRoot, stagingRoot);
  assertInside(steamRoot, outputRoot);
  const stagingInfo = await lstat(stagingRoot);
  if (!stagingInfo.isDirectory() || stagingInfo.isSymbolicLink()) {
    throw new Error("steam_staging_directory_invalid");
  }
  const runtimeManifestBytes = await readFile(
    path.resolve(stagingRoot, "steam-runtime-manifest.json"),
  );
  const runtimeManifest = JSON.parse(runtimeManifestBytes.toString("utf8"));
  if (runtimeManifest.platform !== "windows-x64") {
    throw new Error("steam_windows_runtime_manifest_target_mismatch");
  }
  if (
    typeof runtimeManifest.appVersion !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{0,95}$/i.test(runtimeManifest.appVersion) ||
    typeof runtimeManifest.releaseId !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{0,95}$/i.test(runtimeManifest.releaseId) ||
    /^(?:akia|ltai|sk[-_])/i.test(runtimeManifest.releaseId)
  ) {
    throw new Error("steam_windows_runtime_manifest_identity_invalid");
  }


  const stagedPackage = JSON.parse(
    await readFile(path.resolve(stagingRoot, "package.json"), "utf8"),
  );
  if (
    stagedPackage.name !== "aistory-steam-desktop" ||
    stagedPackage.productName !== "AIstory" ||
    stagedPackage.main !== "desktop/main.mjs" ||
    stagedPackage.type !== "module" ||
    stagedPackage.version !== runtimeManifest.appVersion
  ) {
    throw new Error("steam_windows_staged_package_identity_mismatch");
  }
  const electronZip = await resolveCachedElectronZip();
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });
  const appPaths = await packager({
    dir: stagingRoot,
    out: outputRoot,
    name: "AIstory",
    executableName: "AIstory",
    platform: "win32",
    arch: "x64",
    electronVersion: ELECTRON_VERSION,
    electronZipDir: path.dirname(electronZip),
    overwrite: true,
    asar: false,
    prune: false,
    win32metadata: {
      CompanyName: "AIstory",
      FileDescription: "AIstory interactive story Demo",
      InternalName: "AIstory",
      OriginalFilename: "AIstory.exe",
      ProductName: "AIstory",
    },
  });
  if (appPaths.length !== 1) {
    throw new Error("steam_packager_unexpected_output_count");
  }
  const appDirectory = path.basename(appPaths[0]);
  const readmePath = path.resolve(outputRoot, "README-TESTING.txt");
  await writeFile(readmePath, readme(appDirectory), "utf8");
  const files = await collectReleaseManifest(outputRoot);
  const releaseManifest = {
    schemaVersion: 1,
    product: "AIstory",
    platform: "windows-x64",
    artifactKind: "electron-directory",
    electronVersion: ELECTRON_VERSION,
    appVersion: runtimeManifest.appVersion,
    releaseId: runtimeManifest.releaseId,
    electronZip: {
      name: ELECTRON_ZIP_NAME,
      bytes: ELECTRON_ZIP_BYTES,
      sha256: ELECTRON_ZIP_SHA256,
    },
    appDirectory,
    runtimeManifestSha256: createHash("sha256")
      .update(runtimeManifestBytes)
      .digest("hex"),
    signed: false,
    steamDepotUploaded: false,
    steamworksConnected: false,
    files,
    totals: {
      files: files.length,
      bytes: files.reduce((total, file) => total + file.bytes, 0),
    },
    generatedAt: new Date().toISOString(),
  };
  await writeFile(
    path.resolve(outputRoot, "release-manifest.json"),
    `${JSON.stringify(releaseManifest, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(`Steam Windows directory package: ${appPaths[0]}\n`);
}

await main();
