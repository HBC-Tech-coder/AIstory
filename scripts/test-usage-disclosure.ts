import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildUsageDisclosure,
  formatUsageDisclosure,
} from "../lib/usageDisclosure.ts";

const depthZero = buildUsageDisclosure({
  action: "start_custom",
  prefetchDepth: 0,
});
assert.deepEqual(
  depthZero.capabilities.map((item) => item.capability),
  ["text", "image"],
);
assert.deepEqual(depthZero.speculativeCapabilities, []);
assert.equal(depthZero.responsibility, "platform_internal");
assert.match(
  formatUsageDisclosure(depthZero, "zh-CN"),
  /预生成 0 层：不会提前请求下一分支/,
);

const depthOneByok = buildUsageDisclosure({
  action: "start_custom",
  audioEnabled: true,
  prefetchDepth: 1,
  byokReady: { text: true, image: true, tts: true },
});
assert.deepEqual(
  depthOneByok.capabilities.map((item) => item.capability),
  ["text", "image", "tts"],
);
assert.deepEqual(depthOneByok.speculativeCapabilities, ["text", "image"]);
assert.equal(depthOneByok.responsibility, "user_provider");
assert.match(
  formatUsageDisclosure(depthOneByok, "zh-CN"),
  /费用由你的服务商账户承担，不扣平台积分/,
);
assert.match(
  formatUsageDisclosure(depthOneByok, "en"),
  /only the next text and image layer/,
);

const mixed = buildUsageDisclosure({
  action: "continue_choice",
  audioEnabled: true,
  prefetchDepth: 1,
  byokReady: { text: true, image: false, tts: true },
});
assert.equal(mixed.responsibility, "mixed");

const applyWithoutPrefetch = buildUsageDisclosure({
  action: "apply_next_style",
  prefetchDepth: 0,
  byokReady: { text: true, image: true },
});
assert.deepEqual(applyWithoutPrefetch.capabilities, []);
assert.equal(applyWithoutPrefetch.responsibility, "none");
assert.match(
  formatUsageDisclosure(applyWithoutPrefetch, "zh-CN"),
  /保存设置本身不调用模型/,
);

const redraw = buildUsageDisclosure({
  action: "redraw_current",
  byokReady: { image: true },
});
assert.deepEqual(
  redraw.capabilities.map((item) => item.capability),
  ["image"],
);
assert.equal(redraw.responsibility, "user_provider");

const rewrite = buildUsageDisclosure({
  action: "rewrite_current",
  byokReady: { text: true },
});
assert.deepEqual(
  rewrite.capabilities.map((item) => item.capability),
  ["text"],
);

for (const disclosure of [
  depthZero,
  depthOneByok,
  mixed,
  applyWithoutPrefetch,
  redraw,
  rewrite,
]) {
  const serialized = JSON.stringify(disclosure);
  assert.doesNotMatch(serialized, /apiKey|baseUrl|model|sk-/i);
  const copy = formatUsageDisclosure(disclosure, "zh-CN");
  assert.doesNotMatch(copy, /(?:￥|¥|\$)\s*\d|\d+\s*(?:元|积分)/);
}

const home = readFileSync(
  new URL("../app/[locale]/page.tsx", import.meta.url),
  "utf8",
);
const play = readFileSync(
  new URL("../app/[locale]/play/page.tsx", import.meta.url),
  "utf8",
);
const style = readFileSync(
  new URL("../components/StyleSwitcherDrawer.tsx", import.meta.url),
  "utf8",
);
assert.match(home, /action="start_custom"/);
assert.match(play, /formatUsageDisclosure/);
assert.match(style, /action="redraw_current"/);
assert.match(style, /action="rewrite_current"/);
assert.match(style, /action="apply_next_style"/);

console.log("usage disclosure contract tests passed");

