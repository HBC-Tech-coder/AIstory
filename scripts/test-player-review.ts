import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Beat, Scene } from "../lib/types/index.ts";
import {
  ALLOWED_RETURN_TO_PATHS,
  DEFAULT_PLAYER_VOLUME,
  PLAY_FIRST_LOAD_DEMO_LABEL,
  PLAY_FIRST_LOAD_SETTINGS_LABEL,
  STORY_ARCHIVE_EXPORT_DONE,
  STORY_ARCHIVE_EXPORT_LABEL,
  STORY_ARCHIVE_EXPORT_TITLE,
  buildPlayEndOfDemoNotice,
  buildPlayFirstLoadErrorCopy,
  buildPlaySceneErrorCopy,
  coerceSavedPlayerVolume,
  detectPlayTerminal,
  isAllowedReturnTo,
  isIncompleteStoryDataReason,
  resolveGalleryStageMetrics,
  resolveSafeReturn,
} from "../lib/playerReviewPolicy.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

let checks = 0;
function check(label: string, fn: () => void) {
  fn();
  checks += 1;
  console.log(`ok ${checks} - ${label}`);
}

function read(relativePath: string): string {
  return readFileSync(join(root, relativePath), "utf8");
}

function sceneWith(beats: Beat[]): Pick<Scene, "beats"> {
  return { beats };
}

function beat(partial: Partial<Beat> & Pick<Beat, "id" | "next">): Beat {
  return { id: partial.id, next: partial.next, line: partial.line ?? "line" };
}

// ── returnTo allowlist ─────────────────────────────────────────────────

check("allowlist contains exactly /mobile", () => {
  assert.deepEqual([...ALLOWED_RETURN_TO_PATHS], ["/mobile"]);
});

check("only exact /mobile is accepted", () => {
  assert.equal(isAllowedReturnTo("/mobile"), true);
  const rejected = [
    "/mobile/",
    "/mobile?x=1",
    "/mobile#x",
    "/Mobile",
    "/MOBILE",
    " /mobile",
    "/mobile ",
    "mobile",
    "//mobile",
    "//evil.example/mobile",
    "https://evil.example/mobile",
    "http://evil.example",
    "javascript:alert(1)",
    "/mobile/../admin",
    "/mobile/%2e%2e/admin",
    "",
    "/",
    null,
    undefined,
  ];
  for (const value of rejected) {
    assert.equal(isAllowedReturnTo(value), false, `expected reject: ${String(value)}`);
  }
});

check("safe return is locale-aware and never echoes raw returnTo", () => {
  const zhMobile = resolveSafeReturn({
    returnTo: "/mobile",
    homeHref: "/zh-CN",
    mobileHref: "/zh-CN/mobile",
  });
  assert.equal(zhMobile.href, "/zh-CN/mobile");
  assert.equal(zhMobile.fromReturnTo, true);

  const enHome = resolveSafeReturn({
    returnTo: "https://evil.example",
    homeHref: "/en",
    mobileHref: "/en/mobile",
  });
  assert.equal(enHome.href, "/en");
  assert.equal(enHome.fromReturnTo, false);

  for (const evil of ["//evil.example", "/mobile/", "javascript:alert(1)"]) {
    const resolved = resolveSafeReturn({
      returnTo: evil,
      homeHref: "/ja",
      mobileHref: "/ja/mobile",
    });
    assert.equal(resolved.href, "/ja");
  }
});

// ── terminal detection ────────────────────────────────────────────────

check("normal choice beat is not terminal", () => {
  const choices: Beat["next"] = {
    type: "choice",
    choices: [
      { id: "a", label: "A", effect: { kind: "advance-beat", targetBeatId: "b" } },
    ],
  };
  const scene = sceneWith([
    beat({ id: "a", next: choices }),
    beat({ id: "b", next: { type: "continue", nextBeatId: "a" } }),
  ]);
  assert.equal(
    detectPlayTerminal({ scene, beat: scene.beats[0]!, currentBeatId: "a" }),
    null,
  );
});

check("empty authored choice beat is a terminal, not a stuck screen", () => {
  const scene = sceneWith([beat({ id: "end", next: { type: "choice", choices: [] } })]);
  assert.equal(
    detectPlayTerminal({
      scene,
      beat: scene.beats[0]!,
      currentBeatId: "end",
      authoredLocked: true,
    }),
    "empty-choice",
  );
});

check("empty choice without author lock keeps freeform continuable (not terminal)", () => {
  const scene = sceneWith([beat({ id: "end", next: { type: "choice", choices: [] } })]);
  assert.equal(
    detectPlayTerminal({
      scene,
      beat: scene.beats[0]!,
      currentBeatId: "end",
      authoredLocked: false,
    }),
    null,
  );
});

check("dangling continue is terminal; valid continue is not", () => {
  const dangling = sceneWith([
    beat({ id: "a", next: { type: "continue", nextBeatId: "missing" } }),
  ]);
  assert.equal(
    detectPlayTerminal({ scene: dangling, beat: dangling.beats[0]!, currentBeatId: "a" }),
    "dangling-continue",
  );
  const valid = sceneWith([
    beat({ id: "a", next: { type: "continue", nextBeatId: "b" } }),
    beat({ id: "b", next: { type: "choice", choices: [] } }),
  ]);
  assert.equal(
    detectPlayTerminal({ scene: valid, beat: valid.beats[0]!, currentBeatId: "a" }),
    null,
  );
});

check("authored ending node kind does NOT override a valid continue", () => {
  const scene = sceneWith([
    beat({ id: "a", next: { type: "continue", nextBeatId: "b" } }),
    beat({ id: "b", next: { type: "choice", choices: [] } }),
  ]);
  assert.equal(
    detectPlayTerminal({
      scene,
      beat: scene.beats[0]!,
      currentBeatId: "a",
      authoredNodeKind: "ending",
    }),
    null,
  );
});

check("authored ending node kind does NOT override nonempty choices", () => {
  const scene = sceneWith([
    beat({
      id: "a",
      next: {
        type: "choice",
        choices: [
          {
            id: "c1",
            label: "继续调查",
            effect: { kind: "advance-beat", targetBeatId: "b" },
          },
        ],
      },
    }),
    beat({ id: "b", next: { type: "continue", nextBeatId: "a" } }),
  ]);
  for (const kind of ["ending", "END", "demo-end", "end-of-demo"]) {
    assert.equal(
      detectPlayTerminal({
        scene,
        beat: scene.beats[0]!,
        currentBeatId: "a",
        authoredNodeKind: kind,
      }),
      null,
      `authored kind ${kind} must not override nonempty choices`,
    );
  }
});

check("authored ending node kind is terminal only with no forward path", () => {
  const dangling = sceneWith([
    beat({ id: "a", next: { type: "continue", nextBeatId: "missing" } }),
  ]);
  assert.equal(
    detectPlayTerminal({
      scene: dangling,
      beat: dangling.beats[0]!,
      currentBeatId: "a",
      authoredNodeKind: "ending",
    }),
    "authored-ending",
  );
  const emptyChoice = sceneWith([
    beat({ id: "a", next: { type: "choice", choices: [] } }),
  ]);
  assert.equal(
    detectPlayTerminal({
      scene: emptyChoice,
      beat: emptyChoice.beats[0]!,
      currentBeatId: "a",
      authoredNodeKind: "finale",
    }),
    "authored-ending",
  );
});

check("missing beat and dangling continue are detected as incomplete data", () => {
  const scene = sceneWith([
    beat({ id: "a", next: { type: "continue", nextBeatId: "a" } }),
  ]);
  assert.equal(
    detectPlayTerminal({ scene, beat: null, currentBeatId: "gone" }),
    "missing-beat",
  );
  assert.equal(detectPlayTerminal({ scene: null, beat: null }), null);
  assert.equal(isIncompleteStoryDataReason("missing-beat"), true);
  assert.equal(isIncompleteStoryDataReason("dangling-continue"), true);
  assert.equal(isIncompleteStoryDataReason("authored-ending"), false);
  assert.equal(isIncompleteStoryDataReason("empty-choice"), false);
});

// ── honest copy / no auto-generation ───────────────────────────────────

const localisedBack = resolveSafeReturn({
  returnTo: "/mobile",
  homeHref: "/en",
  mobileHref: "/en/mobile",
});

check("end-of-demo notice is honest and has safe back + replay", () => {
  const notice = buildPlayEndOfDemoNotice("empty-choice", localisedBack);
  assert.equal(notice.backHref, "/en/mobile");
  assert.ok(notice.replayLabel.length > 0);
  assert.match(notice.body, /不会自动生成/);
  assert.match(notice.safetyNote, /不是生成失败/);
  assert.match(notice.title, /终点|结束/);
  assert.equal(notice.incompleteStoryData, false);
});

check("missing beat / dangling pointer describe incomplete data, not success", () => {
  for (const reason of ["missing-beat", "dangling-continue"] as const) {
    const notice = buildPlayEndOfDemoNotice(reason, localisedBack);
    assert.equal(notice.incompleteStoryData, true);
    assert.match(notice.eyebrow, /不完整/);
    assert.match(notice.title, /缺失|不存在/);
    assert.match(notice.body, /不完整/);
    assert.match(notice.body, /不是.*正常结局|不代表.*正常/);
    // Must not be sold as a normal authored end-of-demo / successful ending.
    assert.doesNotMatch(notice.eyebrow, /演示终点/);
    assert.doesNotMatch(notice.title, /作者写好|走到终点/);
    assert.doesNotMatch(notice.body, /作者锁定/);
    assert.equal(notice.backHref, "/en/mobile");
  }
});

check("scene error copy is Chinese, dismissible and actionable", () => {
  const copy = buildPlaySceneErrorCopy(localisedBack);
  assert.ok(copy.dismissLabel.length > 0);
  assert.ok(copy.backLabel.length > 0);
  assert.match(copy.body, /当前画面/);
  assert.doesNotMatch(copy.body, /GenerationRequestError|HTTP \d{3}/);
});

check("scene error never promises a failed generation cost zero", () => {
  const copy = buildPlaySceneErrorCopy(localisedBack);
  for (const text of [copy.body, copy.safetyNote]) {
    assert.doesNotMatch(text, /计费|费用|免费|零成本|不额外|0\s*元/);
  }
  // Closing only stops the failed step from re-running.
  assert.match(copy.safetyNote, /关闭/);
  assert.match(copy.safetyNote, /不会重新生成|不会再次生成/);
});

check("first-load copy is safe, actionable Chinese with no governance copy", () => {
  const copy = buildPlayFirstLoadErrorCopy(localisedBack);
  assert.match(copy.title, /没有加载出来/);
  // Actionable: check settings/model, or select an available demo.
  assert.match(copy.body, /设置/);
  assert.match(copy.body, /模型/);
  assert.match(copy.body, /演示/);
  assert.match(copy.safetyNote, /设置/);
  assert.match(copy.safetyNote, /演示/);
  assert.equal(PLAY_FIRST_LOAD_SETTINGS_LABEL, "检查设置与模型");
  assert.equal(PLAY_FIRST_LOAD_DEMO_LABEL, "选择一个可用演示");
  // Internal governance / placeholder copy must be gone.
  const serialized = JSON.stringify(copy);
  assert.doesNotMatch(serialized, /不放宽|计费限制|占位/);
  assert.doesNotMatch(serialized, /GenerationRequestError|HTTP \d{3}|provider/i);
});

check("saved volume preserves explicit 0 and validates finite 0..1", () => {
  assert.equal(coerceSavedPlayerVolume(0), 0);
  assert.equal(coerceSavedPlayerVolume(0.35), 0.35);
  assert.equal(coerceSavedPlayerVolume(1), 1);
  assert.equal(coerceSavedPlayerVolume("0"), 0);
  assert.equal(coerceSavedPlayerVolume("0.5"), 0.5);
  for (const invalid of [
    undefined,
    null,
    "",
    "abc",
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    -0.1,
    1.1,
    true,
    {},
  ]) {
    assert.equal(
      coerceSavedPlayerVolume(invalid),
      DEFAULT_PLAYER_VOLUME,
      `expected default for ${String(invalid)}`,
    );
  }
  assert.equal(DEFAULT_PLAYER_VOLUME, 1);
});

// ── gallery stage ─────────────────────────────────────────────────────

check("gallery stage is bounded with a real aspect ratio and fallback note", () => {
  const landscape = resolveGalleryStageMetrics("landscape");
  assert.equal(landscape.style.aspectRatio, "16 / 9");
  assert.match(landscape.style.width, /min\(/);
  assert.match(landscape.style.height, /min\(/);
  assert.equal(landscape.style.maxWidth, "100vw");
  assert.equal(landscape.style.maxHeight, "100dvh");
  assert.equal(landscape.imageFit, "contain");
  assert.match(landscape.missingImageNote, /无法显示/);

  const portrait = resolveGalleryStageMetrics("portrait");
  assert.equal(portrait.style.width, "100vw");
  assert.equal(portrait.imageFit, "cover");
});

// ── integration invariants (thin-copy source audit) ───────────────────

check("play page wires safe returnTo + terminal notice + preserved canvas error", () => {
  const source = read(join("app", "[locale]", "play", "page.tsx"));
  assert.match(source, /params\.get\("returnTo"\)/);
  assert.match(source, /resolveSafeReturn\(/);
  assert.match(source, /endOfDemo=\{endOfDemoNotice\}/);
  assert.match(source, /data-play-canvas-error/);
  assert.match(source, /setError\(null\)/);
  // The old full-page English error interpolation must be gone.
  assert.doesNotMatch(source, /leading-\[1\.7\] mb-6">\s*\{error\}/);
  // Both PlayCanvas render paths pass the end-of-demo notice.
  assert.equal((source.match(/endOfDemo=\{endOfDemoNotice\}/g) ?? []).length, 2);
});

check("authored terminal detection preserves author locks and never generates", () => {
  const source = read(join("app", "[locale]", "play", "page.tsx"));
  assert.match(source, /authoredLocked: isAuthorLockedScene\(session\)/);
  assert.match(source, /authoredNodeKind: currentAuthoredNode\?\.kind/);
  // No new generation call may be introduced by the terminal notice.
  assert.match(source, /NEVER generates|不会自动生成/);
  // The terminal dialog must not cover an authored video before it finishes.
  assert.match(source, /currentSceneMedia\.kind !== "video" \|\| videoInteractionUnlocked/);
});

check("export .infiplot button says 导出剧情存档 and explains homepage import", () => {
  const source = read(join("app", "[locale]", "play", "page.tsx"));
  assert.match(source, /STORY_ARCHIVE_EXPORT_LABEL/);
  assert.match(source, /STORY_ARCHIVE_EXPORT_TITLE/);
  assert.match(source, /STORY_ARCHIVE_EXPORT_DONE/);
  assert.equal(STORY_ARCHIVE_EXPORT_LABEL, "导出剧情存档");
  assert.match(STORY_ARCHIVE_EXPORT_TITLE, /载入剧情/);
  assert.match(STORY_ARCHIVE_EXPORT_TITLE, /视频播放器不能导入/);
  assert.match(STORY_ARCHIVE_EXPORT_DONE, /载入剧情/);
});

check("PlayCanvas renders the terminal notice as an in-flow back link only", () => {
  const source = read(join("components", "PlayCanvas.tsx"));
  assert.match(source, /data-play-end-of-demo/);
  assert.match(source, /endOfDemo\.backHref/);
  // The notice must not obscure the ending: no fullscreen overlay, backdrop,
  // modal dialog semantics or focus trapping.
  assert.doesNotMatch(source, /fixed inset-0 z-\[60\]/);
  assert.doesNotMatch(source, /aria-modal/);
  assert.doesNotMatch(source, /role="dialog"/);
  assert.doesNotMatch(source, /backdrop-blur/);
  // The ineffective replay button is gone (the entry beat loops into this
  // same notice), while the optional prop remains for compatibility.
  assert.doesNotMatch(source, /endOfDemo\.replayLabel/);
  assert.match(source, /onReplayEndOfDemo\?: \(\) => void/);
});

check("first-load failure renders actionable settings / demo controls", () => {
  const source = read(join("app", "[locale]", "play", "page.tsx"));
  assert.match(source, /PLAY_FIRST_LOAD_SETTINGS_LABEL/);
  assert.match(source, /PLAY_FIRST_LOAD_DEMO_LABEL/);
  assert.match(source, /data-first-load-action="settings"/);
  assert.match(source, /data-first-load-action="demo"/);
  assert.match(source, /onClick=\{\(\) => setSettingsOpen\(true\)\}/);
  // Settings must be reachable from both unavailable first-load branches.
  assert.ok(
    (source.match(/<SettingsModal/g) ?? []).length >= 2,
    "expected SettingsModal in both first-load failure branches",
  );
});

check("VideoStoryPlayer does not latch global mute and preserves saved volume 0", () => {
  const source = read(join("components", "VideoStoryPlayer.tsx"));
  // Local mute state starts from the SAVED preference only; the page-level
  // muted prop is combined by the sync effect.
  assert.match(source, /useState\(prefs\.muted\)/);
  assert.doesNotMatch(source, /useState\(muted \|\| prefs\.muted\)/);
  assert.match(source, /coerceSavedPlayerVolume\(parsed\.volume\)/);
  assert.doesNotMatch(source, /Number\(parsed\.volume\) \|\| 1/);
});

check("VideoStoryPlayer reports a blocked local mute instead of faking unmute", () => {
  const source = read(join("components", "VideoStoryPlayer.tsx"));
  assert.match(source, /const localMuteBlocked = muted/);
  assert.match(source, /data-local-mute-blocked/);
  assert.match(source, /data-video-local-mute-note/);
  assert.match(source, /disabled=\{localMuteBlocked\}/);
  assert.match(source, /无法单独开启声音/);
  // The mute toggle must not claim "取消静音" while the page mute blocks it.
  assert.match(source, /本页已静音，播放器内的静音开关无法单独开启声音/);
});

check("gallery enforces bounded responsive stage and missing-image fallback", () => {
  const source = read(join("app", "[locale]", "gallery", "page.tsx"));
  assert.match(source, /resolveGalleryStageMetrics\(orientation\)/);
  assert.match(source, /style=\{stage\.style\}/);
  assert.match(source, /objectFit: stage\.imageFit/);
  assert.match(source, /onError=\{\(\) => setImageFailed\(true\)\}/);
  assert.match(source, /离线图集 · 画面缺失/);
  // The old auto-sized w-auto/h-auto image path must be gone.
  assert.doesNotMatch(source, /w-auto h-auto/);
});

console.log(`\nplayer review policy: ${checks} checks passed`);
