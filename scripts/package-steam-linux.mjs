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
const ELECTRON_ZIP_NAME = `electron-v${ELECTRON_VERSION}-linux-x64.zip`;
const MAX_AUDIT_TEXT_BYTES = 8 * 1024 * 1024;
const projectRoot = path.resolve(process.cwd());
const steamRoot = path.resolve(projectRoot, "dist", "steam");
const stagingRoot = path.resolve(steamRoot, "staging");
const outputRoot = path.resolve(steamRoot, "linux-x64");
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
  ".map",
  ".md",
  ".desktop",
]);

function assertInside(parent, child) {
  const relative = path.relative(parent, child);
  if (!relative || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return;
  }
  throw new Error("steam_linux_package_path_outside_dist");
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
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    roots.push(path.join(process.env.LOCALAPPDATA, "electron", "Cache"));
  } else {
    roots.push(path.join(os.homedir(), ".cache", "electron"));
  }
  return [...new Set(roots)];
}

async function resolveCachedElectronZip() {
  for (const root of electronCacheRoots()) {
    const found = await findZip(root);
    if (!found) continue;
    const info = await lstat(found);
    if (!info.isFile() || info.isSymbolicLink()) continue;
    const handle = await open(found, "r");
    try {
      const header = Buffer.alloc(4);
      await handle.read(header, 0, header.length, 0);
      if (!header.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
        throw new Error("steam_linux_cached_electron_zip_magic_invalid");
      }
    } finally {
      await handle.close();
    }
    return found;
  }
  throw new Error(
    "BLOCKED_NATIVE_BINARY_NOT_BUILT:missing_cached_electron_linux_x64",
  );
}

async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
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
    /\b(?:AISTORY|ALIBABA_CLOUD|SUPABASE)_[A-Z0-9_]*(?:SECRET|KEY|TOKEN)\s*=\s*[^\s"']+/i.test(
      text,
    ) ||
    containsBuildAbsolutePath
  ) {
    throw new Error(`steam_linux_release_sensitive_text:${relative}`);
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
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        throw new Error(`steam_linux_release_symlink_rejected:${relative}`);
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
  if (runtimeManifest.platform !== "linux-x64") {
    throw new Error("steam_linux_runtime_manifest_target_mismatch");
  }

  // Supplying electronZipDir is the hard offline boundary. Packager cannot
  // fall through to @electron/get network downloads.
  const electronZip = await resolveCachedElectronZip();
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });
  const appPaths = await packager({
    dir: stagingRoot,
    out: outputRoot,
    name: "AIstory",
    executableName: "AIstory",
    platform: "linux",
    arch: "x64",
    electronVersion: ELECTRON_VERSION,
    electronZipDir: path.dirname(electronZip),
    overwrite: true,
    asar: false,
    prune: false,
  });
  if (appPaths.length !== 1) {
    throw new Error("steam_linux_packager_unexpected_output_count");
  }

  const files = await collectReleaseManifest(appPaths[0]);
  const releaseManifest = {
    schemaVersion: 1,
    product: "AIstory",
    platform: "linux-x64",
    artifactKind: "electron-directory",
    electronVersion: ELECTRON_VERSION,
    appDirectory: path.basename(appPaths[0]),
    runtimeManifestSha256: createHash("sha256")
      .update(runtimeManifestBytes)
      .digest("hex"),
    signed: false,
    appImageBuilt: false,
    steamDepotUploaded: false,
    steamworksConnected: false,
    nativeLinuxMechanicalTested: process.platform === "linux",
    steamDeckMechanicalTested: false,
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
  process.stdout.write(`Steam Linux directory package: ${appPaths[0]}\n`);
}

await main();
