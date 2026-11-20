import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const verifyBuild = process.argv.includes("--verify-build");
const thisFile = fileURLToPath(import.meta.url);
const ignoredDirectories = new Set([
  ".git",
  ".logs",
  ".next",
  ".tmp",
  "coverage",
  "dist",
  "node_modules",
]);
const ignoredRootDirectories = new Set(["experiments"]);
const ignoredShadowDirectories = new Set([
  "app/app",
  "components/components",
  "lib/lib",
]);
const textExtensions = new Set([
  ".css",
  ".cjs",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".less",
  ".mdx",
  ".mjs",
  ".sass",
  ".scss",
  ".svg",
  ".ts",
  ".tsx",
]);

async function collectTextFiles(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = join(path, entry.name);
    if (entry.isDirectory()) {
      const relativeDirectory = relative(repoRoot, entryPath).replaceAll("\\", "/");
      if (
        ignoredDirectories.has(entry.name)
        || entry.name.startsWith(".aistory-")
        || (path === repoRoot && ignoredRootDirectories.has(entry.name))
        || ignoredShadowDirectories.has(relativeDirectory)
      ) {
        continue;
      }
      files.push(...await collectTextFiles(entryPath));
    } else if (
      entry.isFile()
      && entryPath !== thisFile
      && textExtensions.has(extname(entry.name))
    ) {
      files.push(entryPath);
    }
  }

  return files;
}

async function collectBuildTextFiles(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  const buildTextExtensions = new Set([".css", ".html", ".js", ".json", ".map", ".txt"]);

  for (const entry of entries) {
    if (entry.isDirectory() && (entry.name === "dev" || entry.name.startsWith("dev-stale-"))) {
      continue;
    }

    const entryPath = join(path, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectBuildTextFiles(entryPath));
    } else if (entry.isFile() && buildTextExtensions.has(extname(entry.name))) {
      files.push(entryPath);
    }
  }

  return files;
}

const files = await collectTextFiles(repoRoot);

const forbiddenPatterns = [
  { label: "next/font/google", pattern: /next\/font\/google/i },
  { label: "Google Fonts stylesheet host", pattern: /fonts\.googleapis\.com/i },
  { label: "Google Fonts asset host", pattern: /fonts\.gstatic\.com/i },
];
const violations: string[] = [];

for (const file of files) {
  const source = await readFile(file, "utf8");
  for (const forbidden of forbiddenPatterns) {
    if (forbidden.pattern.test(source)) {
      violations.push(`${relative(repoRoot, file)}: ${forbidden.label}`);
    }
  }
}

assert.deepEqual(
  violations,
  [],
  `Production source must remain independent of Google Font build downloads:\n${violations.join("\n")}`,
);

const globals = await readFile(join(repoRoot, "app", "globals.css"), "utf8");
assert.match(globals, /--font-serif:\s*[^;]+;/, "The editorial serif fallback must be defined");
assert.match(globals, /--font-sans:\s*[^;]+;/, "The UI sans fallback must be defined");

if (verifyBuild) {
  const buildRoot = join(repoRoot, ".next");
  const buildId = (await readFile(join(buildRoot, "BUILD_ID"), "utf8")).trim();
  assert.ok(buildId.length > 0, "The production BUILD_ID must be present and non-empty");

  const appPathsManifest = JSON.parse(
    await readFile(join(buildRoot, "server", "app-paths-manifest.json"), "utf8"),
  ) as Record<string, unknown>;
  for (const appPath of [
    "/[locale]/page",
    "/[locale]/studio/page",
    "/[locale]/play/page",
    "/admin/login/page",
  ]) {
    assert.equal(typeof appPathsManifest[appPath], "string", `Missing production app path: ${appPath}`);
  }

  const nextFontManifestSource = await readFile(
    join(buildRoot, "server", "next-font-manifest.json"),
    "utf8",
  );
  JSON.parse(nextFontManifestSource);

  const buildFiles = await collectBuildTextFiles(buildRoot);
  const buildViolations: string[] = [];
  for (const file of buildFiles) {
    const source = await readFile(file, "utf8");
    for (const forbidden of forbiddenPatterns.slice(1)) {
      if (forbidden.pattern.test(source)) {
        buildViolations.push(`${relative(repoRoot, file)}: ${forbidden.label}`);
      }
    }
  }

  assert.deepEqual(
    buildViolations,
    [],
    `Production artifacts must not reference Google Font hosts:\n${buildViolations.join("\n")}`,
  );
  console.log(
    `local font production build gate: ok (${buildFiles.length} artifacts scanned, BUILD_ID ${buildId.length} chars)`,
  );
} else {
  console.log(`local font offline build gate: ok (${files.length} production source files scanned)`);
}
