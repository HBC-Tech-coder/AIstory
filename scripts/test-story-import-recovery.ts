// Regression checks for the ?share=1 story-import recovery path.
//
// Pure helper cases run against lib/storyImportRecovery.ts; a source audit
// makes sure /play wires the dedicated recovery screen in the right order
// (before the generic provider error, before any image-loading request).
//
// Run with: tsx scripts/test-story-import-recovery.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  STORY_IMPORT_RECOVERY_COPY,
  readStoryImportDoc,
} from "../lib/storyImportRecovery";

const PAGE_PATH = fileURLToPath(
  new URL("../app/[locale]/play/page.tsx", import.meta.url),
);

const KEY = "infiplot:story-import";

function section(name: string) {
  console.log(`- ${name}`);
}

// ── Pure helper: classification ──────────────────────────────────────────

section("helper: missing storage / key / empty value");

assert.deepEqual(
  readStoryImportDoc<unknown>(() => null, KEY, JSON.parse),
  { status: "missing" },
);
assert.deepEqual(
  readStoryImportDoc<unknown>(() => undefined, KEY, JSON.parse),
  { status: "missing" },
);

for (const raw of [null, "", "   ", "\n\t "]) {
  assert.deepEqual(
    readStoryImportDoc<unknown>(() => ({ getItem: () => raw }), KEY, JSON.parse),
    { status: "missing" },
    `raw ${JSON.stringify(raw)} must classify as missing`,
  );
}

section("helper: storage access throws -> unavailable, no raw error");

const throwingGetter = readStoryImportDoc<unknown>(
  () => {
    throw new Error("SecurityError: storage blocked");
  },
  KEY,
  JSON.parse,
);
assert.deepEqual(throwingGetter, { status: "unavailable" });

const throwingGetItem = readStoryImportDoc<unknown>(
  () => ({
    getItem: () => {
      throw new Error("SecurityError: getItem blocked");
    },
  }),
  KEY,
  JSON.parse,
);
assert.deepEqual(throwingGetItem, { status: "unavailable" });
// The raw message must not leak through the result object.
assert.equal(JSON.stringify(throwingGetItem).includes("SecurityError"), false);

section("helper: malformed JSON / parser rejection -> malformed");

assert.deepEqual(
  readStoryImportDoc<unknown>(
    () => ({ getItem: () => "{not json" }),
    KEY,
    JSON.parse,
  ),
  { status: "malformed" },
);
assert.deepEqual(
  readStoryImportDoc<unknown>(
    () => ({ getItem: () => '{"kind":"not-a-story"}' }),
    KEY,
    () => {
      throw new Error("剧情分享文件格式不支持");
    },
  ),
  { status: "malformed" },
);

section("helper: valid payload passes through unchanged");

const payload = { kind: "infiplot-story", v: 1, nested: { a: [1, 2] } };
const seenKeys: string[] = [];
const ok = readStoryImportDoc(
  () => ({
    getItem: (key: string) => {
      seenKeys.push(key);
      return JSON.stringify(payload);
    },
  }),
  KEY,
  (raw) => JSON.parse(raw) as unknown,
);
assert.equal(ok.status, "ok");
assert.deepEqual(seenKeys, [KEY]);
if (ok.status === "ok") {
  assert.deepEqual(ok.doc, payload);
}

section("helper: recovery copy stays Chinese and never advises providers");

const copy = STORY_IMPORT_RECOVERY_COPY;
assert.equal(copy.missingTitle, "当前标签没有已导入故事");
assert.equal(copy.malformedTitle, "剧情存档无法载入");
assert.ok(copy.body.startsWith("此入口需先从首页载入剧情文件"));
assert.ok(copy.body.includes(".infiplot"));
assert.ok(copy.body.includes("标签页"));
assert.equal(copy.homeImport, "返回首页载入剧情");
// A new tab / reopened browser may still keep the imported copy (opener
// cloning, session restore), so the body must not claim it is always lost.
assert.equal(
  copy.body.includes("重新打开浏览器后，需要回到首页重新载入"),
  false,
  "body must not claim a browser restart always loses the imported copy",
);
for (const field of [
  copy.eyebrow,
  copy.missingTitle,
  copy.malformedTitle,
  copy.body,
  copy.missingNote,
  copy.malformedNote,
  copy.unavailableNote,
  copy.homeImport,
]) {
  assert.ok(field.trim().length > 0, "copy fields must not be empty");
}
const copyText = Object.values(copy).join("\n").toLowerCase();
for (const forbidden of ["provider", "model", "api key", "密钥", "重试生成"]) {
  assert.equal(
    copyText.includes(forbidden),
    false,
    `import recovery copy must not mention ${forbidden}`,
  );
}

// ── Source audit: /play wiring ───────────────────────────────────────────

section("page: dedicated importIssue recovery is wired");

const page = readFileSync(PAGE_PATH, "utf8");

assert.ok(page.includes('from "@/lib/storyImportRecovery"'));
assert.ok(page.includes("readStoryImportDoc("));
assert.ok(page.includes("STORY_IMPORT_RECOVERY_COPY"));
assert.ok(page.includes("const [importIssue, setImportIssue]"));

const importBlockStart = page.indexOf("if (importIssue) {");
assert.notEqual(importBlockStart, -1, "importIssue recovery block missing");
const authBlockStart = page.indexOf("if (firstLoadAuthRequirement) {");
assert.ok(
  authBlockStart > importBlockStart,
  "importIssue block must sit before the auth screen",
);
const genericErrorStart = page.indexOf("if (error && !hasPreservedCanvas) {");
assert.ok(
  genericErrorStart > importBlockStart,
  "importIssue recovery must precede the generic first-load error",
);

const importBlock = page.slice(importBlockStart, authBlockStart);
assert.ok(
  importBlock.includes('href={lp("/")}'),
  "import recovery must link to the localized home, not an arbitrary returnTo",
);
assert.ok(!importBlock.includes("safeReturn.href"));
assert.equal(importBlock.includes("SettingsModal"), false);
assert.equal(importBlock.includes("setSettingsOpen"), false);
assert.equal(importBlock.includes('fa-key"'), false);
assert.equal(importBlock.includes("importRecoveryCopy.homeImport"), true);

section("page: invalid import returns before any media generation");

const shareStart = page.indexOf("if (isShare) {");
assert.notEqual(shareStart, -1);
const shareEnd = page.indexOf("let liveAudioEnabled = false;");
assert.ok(shareEnd > shareStart);
const shareBranch = page.slice(shareStart, shareEnd);

assert.ok(shareBranch.includes("readStoryImportDoc("));
assert.ok(shareBranch.includes("setImportIssue(importRead.status)"));
assert.ok(shareBranch.includes('setImportIssue("malformed")'));
assert.ok(shareBranch.includes("sceneHasRenderableMedia(first.scene)"));
assert.ok(shareBranch.includes("initialStoryState"));

const issueStatusIndex = shareBranch.indexOf("setImportIssue(importRead.status)");
const malformedIndex = shareBranch.indexOf('setImportIssue("malformed")');
const mediaFetchIndex = shareBranch.indexOf("getOrCreateBlobUrl");
assert.ok(mediaFetchIndex > issueStatusIndex, "storage validation must precede media fetch");
assert.ok(mediaFetchIndex > malformedIndex, "doc validation must precede media fetch");
assert.ok(
  shareBranch.indexOf("await getOrCreateBlobUrl") > malformedIndex,
  "no imported doc check may run after the image fetch starts",
);

for (const obsolete of [
  "play.shareErrors.notFound",
  "play.shareErrors.invalid",
  "play.shareErrors.noImage",
  "play.shareErrors.noMemory",
]) {
  assert.equal(
    shareBranch.includes(obsolete),
    false,
    `${obsolete} must no longer be thrown by the isShare branch`,
  );
}

// Playback/media failures still belong to the existing generic error path and
// must not be reclassified as a malformed import.
assert.ok(shareBranch.includes("handleAuthError(e)"));

console.log("\nstory-import recovery: all checks passed");
