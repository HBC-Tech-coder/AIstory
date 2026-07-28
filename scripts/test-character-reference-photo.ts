import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  CHARACTER_PORTRAIT_MAX_OUTPUT_BYTES,
  CHARACTER_PORTRAIT_MAX_SOURCE_BYTES,
  estimateDataUrlBytes,
  isSafeStoredCharacterPortrait,
  matchesCharacterPortraitSignature,
  validateCharacterPortraitFile,
  writeCharacterRolesToStorage,
} from "../lib/clientCharacterPortrait";

function fixtureDataUrl(bytes: number): string {
  return `data:image/jpeg;base64,${Buffer.alloc(bytes, 0x41).toString("base64")}`;
}

assert.equal(
  validateCharacterPortraitFile({ type: "image/jpeg", size: 1024 }),
  null,
);
assert.equal(
  validateCharacterPortraitFile({ type: "image/png", size: 1024 }),
  null,
);
assert.match(
  validateCharacterPortraitFile({ type: "image/svg+xml", size: 1024 }) ?? "",
  /不支持 SVG/,
);
assert.match(
  validateCharacterPortraitFile({
    type: "image/webp",
    size: CHARACTER_PORTRAIT_MAX_SOURCE_BYTES + 1,
  }) ?? "",
  /8 MB/,
);

assert.equal(
  matchesCharacterPortraitSignature(
    "image/jpeg",
    new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
  ),
  true,
);
assert.equal(
  matchesCharacterPortraitSignature(
    "image/png",
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  ),
  true,
);
assert.equal(
  matchesCharacterPortraitSignature(
    "image/webp",
    new TextEncoder().encode("RIFF0000WEBP"),
  ),
  true,
);
assert.equal(
  matchesCharacterPortraitSignature(
    "image/png",
    new TextEncoder().encode("<svg></svg>"),
  ),
  false,
);

const safeDataUrl = fixtureDataUrl(32 * 1024);
assert.equal(estimateDataUrlBytes(safeDataUrl), 32 * 1024);
assert.equal(isSafeStoredCharacterPortrait(safeDataUrl), true);
assert.equal(
  isSafeStoredCharacterPortrait(
    fixtureDataUrl(CHARACTER_PORTRAIT_MAX_OUTPUT_BYTES + 1),
  ),
  false,
);
assert.equal(
  isSafeStoredCharacterPortrait("https://example.com/portrait.jpg"),
  false,
);

const writes = new Map<string, string>();
assert.deepEqual(
  writeCharacterRolesToStorage(
    {
      setItem(key, value) {
        writes.set(key, value);
      },
    },
    "roles",
    [{ id: "role-1", portraitUrl: safeDataUrl }],
  ),
  { ok: true },
);
assert.equal(writes.has("roles"), true);
const failedWrite = writeCharacterRolesToStorage(
  {
    setItem() {
      throw new Error("QuotaExceededError");
    },
  },
  "roles",
  [{ id: "role-1" }],
);
assert.equal(failedWrite.ok, false);
if (!failedWrite.ok) {
  assert.match(failedWrite.message, /尚未保存/);
}

const root = process.cwd();
const mobileSource = fs.readFileSync(
  path.join(root, "components", "MobileDreamFrameApp.tsx"),
  "utf8",
);
assert.equal(mobileSource.includes("进入编辑台"), false);
assert.equal(mobileSource.includes("/studio?seed="), false);
assert.match(mobileSource, /mobile-df-single-action/);

const characterSource = fs.readFileSync(
  path.join(root, "components", "StoryCharacterModal.tsx"),
  "utf8",
);
assert.match(characterSource, /角色性别：\{characterGenderLabel\(voiceProfile\)\}/);
assert.match(characterSource, /导入参考照片（本机）/);
assert.match(characterSource, /portraitUrl: form\.portraitUrl/);
assert.match(characterSource, /roleWithoutLocalPortrait/);
assert.match(characterSource, /费用报价、手机号登录及真人素材授权门禁/);

console.log("character reference photo tests passed");
