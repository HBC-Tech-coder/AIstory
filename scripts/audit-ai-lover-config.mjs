import fs from "node:fs";
import path from "node:path";

const defaultRoots = [
  "D:/AI-Lover",
  "D:/AIstory/experiments/ai-lover-hermes-ui-copy",
  "D:/AIstory/lib/ai-lover-control",
  "D:/AIstory/docs",
];

const roots = process.argv.slice(2);
const scanRoots = roots.length ? roots : defaultRoots;

const skipDirs = new Set([
  ".git",
  ".next",
  "node_modules",
  "dist",
  "build",
  "out",
  ".turbo",
  ".venv",
  "venv",
  "__pycache__",
]);

const allowedExts = new Set([
  ".env",
  ".json",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".py",
  ".ps1",
  ".md",
  ".yaml",
  ".yml",
]);

const retiredEndpoints = ["47.95.119.182"];
const secretKeyPattern = /(api[_-]?key|secret|token|password|passwd|pwd|access[_-]?key|group[_-]?id|authorization)/i;
const secretValuePattern = /(sk-[A-Za-z0-9._=\-]{10,}|ak-[A-Za-z0-9._=\-]{10,}|Bearer\s+[A-Za-z0-9._=\-]{10,}|AKIA[0-9A-Z]{12,})/i;
const placeholderPattern = /(your_|YOUR_|example|placeholder|change_me|changeme|xxx|test|optional-|sample-|dummy)/i;
const envAssignmentPattern = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=/;
const jsonStringPropertyPattern = /^\s*["']([^"']+)["']\s*:\s*["']([^"']*)["']/;
const envRefPattern = /(\$\{env:|process\.env\.|import\.meta\.env\.|os\.getenv|os\.environ|getenv\()/i;

function shouldScan(filePath) {
  const name = path.basename(filePath);
  if (name === "audit-ai-lover-config.mjs") return false;
  if (name.startsWith(".env")) return true;
  return allowedExts.has(path.extname(filePath));
}

function* walk(root) {
  if (!fs.existsSync(root)) return;
  const stat = fs.statSync(root);
  if (stat.isFile()) {
    if (shouldScan(root)) yield root;
    return;
  }
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (skipDirs.has(entry.name)) continue;
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walk(fullPath);
    } else if (entry.isFile() && shouldScan(fullPath)) {
      yield fullPath;
    }
  }
}

function lineHasSecretKeyAssignment(line) {
  if (envAssignmentPattern.test(line)) {
    const key = line.match(envAssignmentPattern)?.[1] ?? "";
    if (!isSecretEnvKey(key)) return false;
    const value = line.split("=", 2)[1]?.trim() ?? "";
    return Boolean(value) && !placeholderPattern.test(value) && !envRefPattern.test(value);
  }
  const jsonMatch = line.match(jsonStringPropertyPattern);
  if (jsonMatch) {
    const key = jsonMatch[1] ?? "";
    const value = jsonMatch[2] ?? "";
    if (!isSecretJsonKey(key)) return false;
    return Boolean(value) && !placeholderPattern.test(value) && !envRefPattern.test(value);
  }
  return false;
}

function isSecretJsonKey(key) {
  const value = key.toLowerCase();
  return (
    value.includes("api_key") ||
    value.includes("apikey") ||
    value.includes("secret") ||
    value.includes("token") ||
    value.includes("password") ||
    value.includes("passwd") ||
    value === "pwd" ||
    value.includes("access_key") ||
    value === "authorization" ||
    value === "group_id" ||
    value.endsWith("_group_id")
  );
}

function isSecretEnvKey(key) {
  const value = key.toUpperCase();
  if (value.endsWith("_URL") || value.endsWith("_URI") || value.endsWith("_PATH") || value.endsWith("_FILE")) {
    return false;
  }
  return (
    value.includes("API_KEY") ||
    value.endsWith("_KEY") ||
    value.includes("ACCESS_KEY") ||
    value.includes("SECRET") ||
    value.endsWith("_TOKEN") ||
    value.includes("PASSWORD") ||
    value.includes("PASSWD") ||
    value === "PWD" ||
    value === "AUTHORIZATION" ||
    value === "GROUP_ID" ||
    value.endsWith("_GROUP_ID")
  );
}

const findings = [];
let scannedFiles = 0;

for (const root of scanRoots) {
  for (const filePath of walk(root)) {
    scannedFiles += 1;
    let text = "";
    try {
      text = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (retiredEndpoints.some((endpoint) => line.includes(endpoint))) {
        findings.push({
          severity: "high",
          kind: "retired_endpoint",
          path: filePath,
          line: index + 1,
          detail: "retired endpoint reference",
        });
      }
      if ((secretValuePattern.test(line) || lineHasSecretKeyAssignment(line)) && !placeholderPattern.test(line)) {
        findings.push({
          severity: "high",
          kind: "secret_like_literal",
          path: filePath,
          line: index + 1,
          detail: "possible secret value; content withheld",
        });
      }
    });
  }
}

const summary = {
  scannedFiles,
  findingCount: findings.length,
  findings,
};

console.log(JSON.stringify(summary, null, 2));

if (findings.length) {
  process.exitCode = 1;
}
