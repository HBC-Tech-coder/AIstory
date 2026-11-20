import assert from "node:assert/strict";

import {
  MOBILE_RETURN_TO,
  formatPlaybackTime,
  isSafeLocalHref,
  previewFeatureState,
  previewMetricLabel,
  progressSegments,
  resolvePreviewProgress,
  resolveRoleCard,
  rewriteDraftNotice,
  withMobileReturnTo,
} from "../lib/mobilePreviewPolicy";

let failures = 0;
function check(name: string, run: () => void): void {
  try {
    run();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`not ok - ${name}`);
    console.error(error);
  }
}

check("withMobileReturnTo appends returnTo to a bare path", () => {
  assert.equal(withMobileReturnTo("/play"), `/play?returnTo=%2Fmobile`);
  assert.equal(withMobileReturnTo("/play?card=f6"), `/play?card=f6&returnTo=%2Fmobile`);
});

check("withMobileReturnTo preserves query and hash", () => {
  assert.equal(
    withMobileReturnTo("/play?case=world-model-anime-sunset#scene-2"),
    "/play?case=world-model-anime-sunset&returnTo=%2Fmobile#scene-2",
  );
});

check("withMobileReturnTo replaces an existing returnTo instead of duplicating", () => {
  const result = withMobileReturnTo("/play?card=f6&returnTo=%2Fpc&lang=zh");
  assert.equal(result, "/play?card=f6&lang=zh&returnTo=%2Fmobile");
  assert.equal(result.match(/returnTo=/g)?.length, 1);
});

check("withMobileReturnTo keeps locale-prefixed playable paths local", () => {
  assert.equal(
    withMobileReturnTo("/zh/play?card=m18"),
    "/zh/play?card=m18&returnTo=%2Fmobile",
  );
});

check("withMobileReturnTo leaves unsafe hrefs untouched", () => {
  for (const unsafe of [
    "//evil.example/play",
    "https://evil.example/play",
    "javascript:alert(1)",
    " /play",
    "/play\\x",
    "/play with space",
  ]) {
    assert.equal(withMobileReturnTo(unsafe), unsafe);
    assert.equal(isSafeLocalHref(unsafe), false);
  }
  assert.equal(isSafeLocalHref("/play?card=f6"), true);
  assert.equal(withMobileReturnTo("/play", "https://evil.example"), `/play?returnTo=%2Fmobile`);
});

check("formatPlaybackTime renders mm:ss and rejects invalid input", () => {
  assert.equal(formatPlaybackTime(0), "0:00");
  assert.equal(formatPlaybackTime(92), "1:32");
  assert.equal(formatPlaybackTime(78.34), "1:18");
  assert.equal(formatPlaybackTime(-1), "--:--");
  assert.equal(formatPlaybackTime(Number.NaN), "--:--");
  assert.equal(formatPlaybackTime(null), "--:--");
});

check("resolvePreviewProgress reports real video time when suitable", () => {
  const progress = resolvePreviewProgress({
    hasVideo: true,
    currentTimeSeconds: 30,
    durationSeconds: 120,
  });
  assert.equal(progress.mode, "video");
  if (progress.mode === "video") {
    assert.equal(progress.percent, 25);
    assert.equal(progress.label, "0:30 / 2:00");
  }
});

check("resolvePreviewProgress clamps out-of-range video time", () => {
  const progress = resolvePreviewProgress({
    hasVideo: true,
    currentTimeSeconds: 500,
    durationSeconds: 100,
  });
  assert.equal(progress.mode, "video");
  if (progress.mode === "video") assert.equal(progress.percent, 100);
});

check("resolvePreviewProgress labels preview instead of faking chapters", () => {
  assert.deepEqual(resolvePreviewProgress({ hasVideo: false }), {
    mode: "preview",
    percent: null,
    label: "预览 · 无播放进度",
    reason: "no-video",
  });
  assert.equal(
    resolvePreviewProgress({ hasVideo: true, currentTimeSeconds: 3, durationSeconds: 0 }).mode,
    "preview",
  );
  assert.equal(
    resolvePreviewProgress({ hasVideo: true, currentTimeSeconds: Number.NaN, durationSeconds: 60 }).mode,
    "preview",
  );
});

check("progressSegments maps only real percentages", () => {
  assert.deepEqual(progressSegments(0), ["rest", "rest", "rest", "rest", "rest"]);
  assert.deepEqual(progressSegments(100), ["done", "done", "done", "done", "done"]);
  assert.deepEqual(progressSegments(35), ["done", "now", "rest", "rest", "rest"]);
  assert.deepEqual(progressSegments(null), ["rest", "rest", "rest", "rest", "rest"]);
  assert.deepEqual(progressSegments(25, 4), ["done", "rest", "rest", "rest"]);
});

check("unimplemented features are unavailable and use truthful wording", () => {
  for (const feature of ["follow", "nearby", "like", "comment"] as const) {
    const state = previewFeatureState(feature);
    assert.equal(state.available, false);
    assert.match(state.notice, /尚未上线/);
  }
  assert.equal(previewMetricLabel("like"), "待上线");
  assert.equal(previewMetricLabel("comment"), "待上线");
  assert.doesNotMatch(previewFeatureState("like").notice, /已|成功/);
});

check("resolveRoleCard never fabricates a character", () => {
  const missing = resolveRoleCard();
  assert.equal(missing.available, false);
  if (!missing.available) {
    assert.equal(missing.title, "暂无已发布的角色卡");
    assert.match(missing.description, /不会用其他故事的角色代替/);
  }
  const present = resolveRoleCard({
    name: "林夏",
    description: "在旧档案里找线索。",
    traits: ["声线：低语", "  "],
  });
  assert.deepEqual(present, {
    available: true,
    name: "林夏",
    description: "在旧档案里找线索。",
    traits: ["声线：低语"],
  });
});

check("rewrite draft never claims generation or charges", () => {
  const draft = rewriteDraftNotice("我想改写第二幕");
  assert.equal(draft.status, "draft");
  assert.equal(draft.executed, false);
  assert.equal(draft.charged, false);
  assert.match(draft.message, /未生成分支/);
  assert.doesNotMatch(draft.message, /已生成/);
  assert.match(draft.message, /当前页面/);
  assert.doesNotMatch(draft.message, /已保存|保存草稿|本地草稿|localStorage/);
  assert.doesNotMatch(previewFeatureState("rewrite").notice, /已保存|保存草稿|本地草稿/);
  assert.match(rewriteDraftNotice("   ").message, /草稿为空/);
});

check("public returnTo constant is the mobile route", () => {
  assert.equal(MOBILE_RETURN_TO, "/mobile");
});

if (failures > 0) {
  console.error(`\n${failures} policy test(s) failed`);
  process.exitCode = 1;
} else {
  console.log("\nall mobile preview policy tests passed");
}
