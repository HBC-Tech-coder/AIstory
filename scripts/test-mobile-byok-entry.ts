import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

async function main(): Promise<void> {
  const mobileSource = await readFile(
    path.join(process.cwd(), "components", "MobileDreamFrameApp.tsx"),
    "utf8",
  );
  const settingsSource = await readFile(
    path.join(process.cwd(), "components", "SettingsModal.tsx"),
    "utf8",
  );

assert.match(
  mobileSource,
  /import\s*\{[^}]*\bSettingsModal\b[^}]*\}\s*from "@\/components\/SettingsModal"/,
);
  assert.match(mobileSource, /我的 API（BYOK）/);
  assert.match(mobileSource, /打开我的 API 设置/);
  assert.match(mobileSource, /initialTab="models"/);
  assert.equal(mobileSource.includes("infiplot:model"), false);
  assert.equal(mobileSource.includes("infiplot:tts"), false);
  assert.equal(mobileSource.includes("platform_managed"), false);

  for (const modality of ["text", "image", "vision", "video"]) {
    assert.match(settingsSource, new RegExp(`key: "${modality}"`));
  }
  assert.match(settingsSource, /settings\.tts\.title/);
  assert.match(settingsSource, /\(\[0, 1\] as BranchPrefetchDepth\[\]\)/);
  assert.equal(
    settingsSource.includes("([0, 1, 2] as BranchPrefetchDepth[])"),
    false,
  );
  assert.match(settingsSource, /settings\.models\.costResponsibility/);
  assert.match(settingsSource, /settings\.models\.persistence/);

  console.log("mobile BYOK entry contract tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
