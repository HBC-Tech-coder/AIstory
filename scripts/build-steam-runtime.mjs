import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const projectRoot = path.resolve(process.cwd());
const target = String(
  process.env.AISTORY_STEAM_TARGET || "windows-x64",
).trim();
const canonicalOnly =
  process.env.AISTORY_STEAM_CANONICAL_ONLY === "true";

if (!new Set(["windows-x64", "linux-x64"]).has(target)) {
  throw new Error("steam_build_target_invalid");
}
const packageJson = JSON.parse(
  await readFile(path.resolve(projectRoot, "package.json"), "utf8"),
);
const appVersion = String(packageJson.version || "").trim();
const releaseId = String(
  process.env.AISTORY_STEAM_RELEASE_ID ||
    `steam-${target}-local-candidate`,
).trim();
if (!/^[a-z0-9][a-z0-9._-]{0,95}$/i.test(appVersion)) {
  throw new Error("steam_build_app_version_invalid");
}
if (!/^[a-z0-9][a-z0-9._-]{0,95}$/i.test(releaseId)) {
  throw new Error("steam_build_release_id_invalid");
}
if (/^(?:akia|ltai|sk[-_])/i.test(releaseId)) {
  throw new Error("steam_build_release_id_invalid");
}


const rootNames = await readdir(projectRoot);
if (rootNames.some((name) => name === ".env" || name.startsWith(".env."))) {
  throw new Error(
    "steam_build_env_file_forbidden:use_a_secret_free_isolated_source_root",
  );
}

const safeHostKeys = [
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
];
const buildEnv = {};
for (const key of safeHostKeys) {
  const value = process.env[key];
  if (typeof value === "string" && value) buildEnv[key] = value;
}
Object.assign(buildEnv, {
  NODE_ENV: "production",
  CI: "1",
  NEXT_TELEMETRY_DISABLED: "1",
  BUILD_STANDALONE: canonicalOnly ? "false" : "true",
  AISTORY_STEAM_OFFLINE_BUILD: "true",
  AISTORY_STEAM_TARGET: target,
  AISTORY_STEAM_APP_VERSION: appVersion,
  AISTORY_STEAM_RELEASE_ID: releaseId,
  NEXT_PUBLIC_AISTORY_APP_VERSION: appVersion,
  NEXT_PUBLIC_AISTORY_STEAM_RELEASE_ID: releaseId,
  NEXT_PUBLIC_BASE_URL: "",
  NEXT_PUBLIC_IMAGE_PROXY_ALLOWED_HOSTS: "",
  NEXT_PUBLIC_IMAGE_PROXY_URL: "",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "",
  NEXT_PUBLIC_SUPABASE_URL: "",
  NEXT_PUBLIC_UMAMI_DOMAINS: "",
  NEXT_PUBLIC_UMAMI_SRC: "",
  NEXT_PUBLIC_UMAMI_WEBSITE_ID: "",
  VERCEL_PROJECT_PRODUCTION_URL: "",
});
const steamDependencyRoot = process.env.AISTORY_STEAM_DEPENDENCY_ROOT
  ? path.resolve(process.env.AISTORY_STEAM_DEPENDENCY_ROOT)
  : path.resolve(projectRoot, "node_modules");
buildEnv.AISTORY_STEAM_DEPENDENCY_ROOT = steamDependencyRoot;
if (process.env.AISTORY_STEAM_DEPENDENCY_ROOT) {
  buildEnv.AISTORY_STEAM_DEPENDENCY_ROOT = path.resolve(
    process.env.AISTORY_STEAM_DEPENDENCY_ROOT,
  );
}
if (process.env.AISTORY_STEAM_TURBOPACK_ROOT) {
  buildEnv.AISTORY_STEAM_TURBOPACK_ROOT = path.resolve(
    process.env.AISTORY_STEAM_TURBOPACK_ROOT,
  );
}

function runNode(relativeEntry, args = []) {
  const entry = relativeEntry.startsWith("node_modules/")
    ? path.resolve(steamDependencyRoot, relativeEntry.slice("node_modules/".length))
    : path.resolve(projectRoot, relativeEntry);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: projectRoot,
      env: buildEnv,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 && signal === null) resolve();
      else reject(new Error(`steam_build_step_failed:${relativeEntry}:${code ?? signal}`));
    });
  });
}

await runNode("node_modules/tsx/dist/cli.mjs", [
  "scripts/test-local-font-offline-build.ts",
]);
await runNode("node_modules/next/dist/bin/next", ["build"]);
await runNode("node_modules/tsx/dist/cli.mjs", [
  "scripts/test-local-font-offline-build.ts",
  "--verify-build",
]);
if (!canonicalOnly) {
  await runNode("scripts/prepare-steam-runtime.mjs");
}
