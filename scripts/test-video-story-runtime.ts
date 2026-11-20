import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  activeVideoCue,
  coerceSceneMedia,
  createVideoCompletionGate,
  resolveVideoSkipControlMode,
  resolveVideoSubtitlePresentation,
  sceneHasRenderableMedia,
  sceneUsesEmbeddedAudio,
  videoAllowsSceneInteraction,
} from "../lib/sceneMedia";
import {
  createStoryShareDoc,
  parseStoryShareDoc,
} from "../lib/storyShare";
import type { Scene, Session } from "../lib/types";

const legacyScene: Scene = {
  id: "legacy-image",
  scenePrompt: "legacy",
  imageUrl: "/legacy-image.png",
  beats: [
    {
      id: "beat-1",
      narration: "旧图片场景",
      next: { type: "continue", nextBeatId: "beat-2" },
    },
    {
      id: "beat-2",
      narration: "结束",
      next: { type: "choice", choices: [] },
    },
  ],
  entryBeatId: "beat-1",
};
assert.deepEqual(coerceSceneMedia(legacyScene), {
  kind: "image",
  url: "/legacy-image.png",
});
assert.equal(sceneHasRenderableMedia(legacyScene), true);
assert.equal(sceneUsesEmbeddedAudio(legacyScene), false);

const videoScene: Scene = {
  ...legacyScene,
  id: "video-scene",
  imageUrl: "/case-studies/demo/poster.webp",
  media: {
    kind: "video",
    assetId: "video-asset-1",
    url: "/api/video-assets/video-asset-1/content",
    posterUrl: "/case-studies/demo/poster.webp",
    durationMs: 4000,
    hasAudio: true,
    subtitles: [
      { id: "c1", startMs: 0, endMs: 1500, speaker: "岚见", text: "早安。" },
      { id: "c2", startMs: 1500, endMs: 3500, text: "窗外开始下雨。" },
    ],
    endBehavior: "advance-beat",
    allowSkip: false,
    authoredTargetNodeId: "next-video-node",
    authoredVariableDelta: { trust: 1 },
  },
};
const projected = coerceSceneMedia(videoScene);
assert.equal(projected.kind, "video");
assert.equal(sceneUsesEmbeddedAudio(videoScene), true);
assert.equal(videoAllowsSceneInteraction(videoScene), false);
assert.equal(projected.kind === "video" ? projected.allowSkip : true, false);
assert.equal(
  projected.kind === "video" ? projected.authoredTargetNodeId : undefined,
  "next-video-node",
);
assert.equal(
  activeVideoCue(projected.kind === "video" ? projected.subtitles : [], 1200)
    ?.speaker,
  "岚见",
);
assert.equal(
  activeVideoCue(projected.kind === "video" ? projected.subtitles : [], 3600),
  null,
);

const projectedVideo = projected.kind === "video" ? projected : null;
assert.ok(projectedVideo);
const inlinePresentation = resolveVideoSubtitlePresentation({
  inlineCues: projectedVideo.subtitles,
  vttUrl: "/api/video-assets/video-asset-1/subtitles.vtt",
  fallbackSubtitle: { speaker: "错误回退", text: "不应显示" },
  currentTimeMs: 1200,
});
assert.equal(inlinePresentation.source, "inline");
assert.equal(inlinePresentation.trackUrl, null);
assert.equal(inlinePresentation.overlay?.speaker, "岚见");
assert.equal(inlinePresentation.overlay?.text, "早安。");

const inlineGapPresentation = resolveVideoSubtitlePresentation({
  inlineCues: projectedVideo.subtitles,
  vttUrl: "/api/video-assets/video-asset-1/subtitles.vtt",
  fallbackSubtitle: { speaker: "错误回退", text: "空档也不应显示" },
  currentTimeMs: 3600,
});
assert.deepEqual(inlineGapPresentation, {
  source: "inline",
  overlay: null,
  trackUrl: null,
});
const inlineBoundaryPresentation = resolveVideoSubtitlePresentation({
  inlineCues: projectedVideo.subtitles,
  vttUrl: undefined,
  fallbackSubtitle: { speaker: "错误回退", text: "不应混入" },
  currentTimeMs: 1500,
});
assert.equal(inlineBoundaryPresentation.source, "inline");
assert.equal(inlineBoundaryPresentation.overlay?.id, "c2");
assert.equal(inlineBoundaryPresentation.overlay?.text, "窗外开始下雨。");
assert.equal(
  inlineBoundaryPresentation.overlay
    ? Object.hasOwn(inlineBoundaryPresentation.overlay, "speaker")
    : true,
  false,
);
assert.equal(
  resolveVideoSubtitlePresentation({
    inlineCues: projectedVideo.subtitles,
    vttUrl: undefined,
    currentTimeMs: 3500,
  }).overlay,
  null,
);

const vttPresentation = resolveVideoSubtitlePresentation({
  inlineCues: [],
  vttUrl: "/api/video-assets/video-asset-1/subtitles.vtt",
  fallbackSubtitle: { text: "不应与 VTT 叠加" },
  currentTimeMs: 500,
});
assert.deepEqual(vttPresentation, {
  source: "vtt",
  overlay: null,
  trackUrl: "/api/video-assets/video-asset-1/subtitles.vtt",
});
assert.equal(
  resolveVideoSubtitlePresentation({
    inlineCues: [{ id: "invalid", startMs: 10, endMs: 10, text: "" }],
    vttUrl: "/api/video-assets/video-asset-1/subtitles.vtt",
    currentTimeMs: 0,
  }).source,
  "vtt",
);

const fallbackPresentation = resolveVideoSubtitlePresentation({
  inlineCues: [],
  vttUrl: "https://evil.example/subtitles.vtt",
  fallbackSubtitle: { speaker: "旁白", text: "  安全回退字幕  " },
  currentTimeMs: 0,
});
assert.deepEqual(fallbackPresentation, {
  source: "beat",
  overlay: { speaker: "旁白", text: "安全回退字幕" },
  trackUrl: null,
});
for (const unsafeVttUrl of [
  "//evil.example/subtitles.vtt",
  "\\\\evil.example\\subtitles.vtt",
  "/api/video-assets/%2e%2e/subtitles.vtt",
]) {
  const unsafeVttPresentation = resolveVideoSubtitlePresentation({
    inlineCues: [],
    vttUrl: unsafeVttUrl,
    fallbackSubtitle: { speaker: "旁白", text: "安全回退字幕" },
    currentTimeMs: 0,
  });
  assert.equal(unsafeVttPresentation.source, "beat");
  assert.equal(unsafeVttPresentation.trackUrl, null);
}
assert.deepEqual(
  resolveVideoSubtitlePresentation({
    inlineCues: undefined,
    vttUrl: undefined,
    fallbackSubtitle: { text: "   " },
    currentTimeMs: 0,
  }),
  { source: "none", overlay: null, trackUrl: null },
);
assert.deepEqual(
  resolveVideoSubtitlePresentation({
    inlineCues: undefined,
    vttUrl: undefined,
    currentTimeMs: Number.NaN,
  }),
  { source: "none", overlay: null, trackUrl: null },
);

assert.equal(resolveVideoSkipControlMode(false, false), "hidden");
assert.equal(resolveVideoSkipControlMode(true, false), "normal-skip");
assert.equal(resolveVideoSkipControlMode(undefined, false), "normal-skip");
assert.equal(resolveVideoSkipControlMode(false, true), "error-recovery");

const unsafeVideo: Scene = {
  ...legacyScene,
  media: {
    kind: "video",
    url: "https://evil.example/steal.mp4",
  },
};
assert.equal(coerceSceneMedia(unsafeVideo).kind, "image");

const completionReasons: string[] = [];
const complete = createVideoCompletionGate((reason) =>
  completionReasons.push(reason),
);
assert.equal(complete("skipped"), true);
assert.equal(complete("seeked"), false);
assert.equal(complete("completed"), false);
assert.deepEqual(completionReasons, ["skipped"]);

const failedCompletionReasons: string[] = [];
const failedComplete = createVideoCompletionGate((reason) =>
  failedCompletionReasons.push(reason),
);
assert.equal(failedComplete.state(), "active");
assert.equal(failedComplete.markFailed(), true);
assert.equal(failedComplete.markFailed(), false);
assert.equal(failedComplete.state(), "failed");
assert.equal(failedComplete("completed"), false);
assert.equal(failedComplete("seeked"), false);
assert.deepEqual(failedCompletionReasons, []);
assert.equal(failedComplete("skipped"), true);
assert.equal(failedComplete.state(), "completed");
assert.equal(failedComplete("skipped"), false);
assert.equal(failedComplete("completed"), false);
assert.equal(failedComplete("seeked"), false);
assert.equal(failedComplete.markFailed(), false);
assert.deepEqual(failedCompletionReasons, ["skipped"]);

const nextMediaReasons: string[] = [];
const nextMediaComplete = createVideoCompletionGate((reason) =>
  nextMediaReasons.push(reason),
);
assert.equal(nextMediaComplete("completed"), true);
assert.deepEqual(nextMediaReasons, ["completed"]);

const session: Session = {
  id: "video-session",
  createdAt: 1,
  worldSetting: "test",
  styleGuide: "test",
  history: [{ scene: videoScene, visitedBeatIds: ["beat-1"] }],
  characters: [],
  storyState: {
    logline: "test",
    genreTags: "test",
    protagonist: "你",
    synopsis: "test",
  },
};
const share = parseStoryShareDoc(
  createStoryShareDoc(session, { sceneIndex: 0, beatId: "beat-1" }),
);
assert.equal(share.session.history[0]?.scene.media?.kind, "video");
assert.equal(
  share.session.history[0]?.scene.media?.kind === "video"
    ? share.session.history[0].scene.media.assetId
    : undefined,
  "video-asset-1",
);
assert.equal(
  share.session.history[0]?.scene.media?.kind === "video"
    ? share.session.history[0].scene.media.authoredVariableDelta?.trust
    : undefined,
  1,
);
assert.throws(
  () =>
    parseStoryShareDoc({
      ...share,
      session: {
        ...share.session,
        history: [
          {
            scene: unsafeVideo,
            visitedBeatIds: ["beat-1"],
          },
        ],
      },
    }),
  /场景数据不合法/,
);

const playSource = await readFile(
  path.join(process.cwd(), "app", "[locale]", "play", "page.tsx"),
  "utf8",
);
assert.match(playSource, /sceneUsesEmbeddedAudio\(currentSceneRef\.current\)/);
assert.match(playSource, /videoAllowsSceneInteraction\(currentScene\)/);
assert.match(playSource, /completion_reason: event\.reason/);
const playerSource = await readFile(
  path.join(process.cwd(), "components", "VideoStoryPlayer.tsx"),
  "utf8",
);
for (const control of [
  "跳到结尾",
  "显示亮度",
  "点击播放并开启声音",
  "requestFullscreen",
  "PLAYBACK_RATES",
]) {
  assert.match(playerSource, new RegExp(control));
}
assert.match(playerSource, /createVideoCompletionGate/);
assert.match(playerSource, /onTimeChange/);
assert.match(playerSource, /resolveVideoSubtitlePresentation/);
assert.match(playerSource, /resolveVideoSkipControlMode/);
assert.match(playerSource, /subtitlePresentation\.source === "vtt"/);
assert.match(playerSource, /srcLang="zh-CN"/);
assert.equal(playerSource.match(/<track\b/g)?.length, 1);
assert.doesNotMatch(playerSource, /media\.vttUrl\s*&&/);
assert.doesNotMatch(playerSource, /cue\s*\|\|\s*fallbackSubtitle/);
assert.doesNotMatch(
  playerSource,
  /cue\?\.speaker\s*\|\|\s*fallbackSubtitle/,
);
assert.match(playerSource, /onError=\{handleMediaError\}/);
assert.match(playerSource, /data-video-media-failed/);
assert.match(playerSource, /role="alert"/);
assert.match(playerSource, /视频加载失败/);
assert.match(playerSource, /data-video-error-recovery/);
assert.match(playerSource, /跳过并继续/);
assert.match(playerSource, /skipControlMode === "normal-skip"/);
assert.match(playerSource, /skipControlMode === "error-recovery"/);
assert.match(playerSource, /completionGate\.markFailed\(\)/);
assert.match(playerSource, /completionGate\.state\(\) !== "active"/);
assert.match(
  playerSource,
  /autoplayBlocked\s*&&\s*!mediaFailed\s*&&\s*completionGate\.state\(\) === "active"/,
);
assert.doesNotMatch(playerSource, /\[duration, media\.url, onComplete\]/);
assert.match(
  playerSource,
  /<VideoStoryPlayerSession key=\{props\.media\.url\}/,
);
assert.doesNotMatch(playerSource, /completionRef/);

const completionGateStart = playerSource.indexOf(
  "const [completionGate] = useState<VideoCompletionGate>",
);
const completionGateEnd = playerSource.indexOf(
  "const mediaFailed =",
  completionGateStart,
);
assert.ok(completionGateStart >= 0 && completionGateEnd > completionGateStart);
const completionGateSource = playerSource.slice(
  completionGateStart,
  completionGateEnd,
);
assert.match(completionGateSource, /try \{/);
assert.match(completionGateSource, /onCompleteRef\.current\(/);
assert.match(completionGateSource, /catch \{/);

const attemptPlayStart = playerSource.indexOf(
  "const attemptPlay = useCallback",
);
const attemptPlayEnd = playerSource.indexOf(
  "const togglePlayback = useCallback",
  attemptPlayStart,
);
assert.ok(attemptPlayStart >= 0 && attemptPlayEnd > attemptPlayStart);
const attemptPlaySource = playerSource.slice(attemptPlayStart, attemptPlayEnd);
assert.ok(
  (attemptPlaySource.match(/completionGate\.state\(\) !== "active"/g) ?? [])
    .length >= 3,
);

const recoveryStart = playerSource.indexOf(
  "const recoverFromMediaFailure = useCallback",
);
const recoveryEnd = playerSource.indexOf(
  "const handleMediaError = useCallback",
  recoveryStart,
);
assert.ok(recoveryStart >= 0 && recoveryEnd > recoveryStart);
const recoverySource = playerSource.slice(recoveryStart, recoveryEnd);
assert.match(recoverySource, /complete\("skipped"\)/);
assert.doesNotMatch(recoverySource, /currentTime|duration|allowSkip/);

const errorStart = recoveryEnd;
const errorEnd = playerSource.indexOf("const seekTo = useCallback", errorStart);
assert.ok(errorEnd > errorStart);
const errorSource = playerSource.slice(errorStart, errorEnd);
assert.match(errorSource, /setMediaState\("failed"\)/);
assert.match(errorSource, /setPlaying\(false\)/);
assert.match(errorSource, /setAutoplayBlocked\(false\)/);
assert.doesNotMatch(errorSource, /\bcomplete\(|onCompleteRef\.current/);
assert.doesNotMatch(
  playerSource,
  /media\.error|currentTarget\.error|MediaError\.(?:message|code)|console\.(?:log|warn|error)/,
);
const previewSource = await readFile(
  path.join(process.cwd(), "components", "VideoStoryDraftPreview.tsx"),
  "utf8",
);
assert.match(previewSource, /onVideoTimeChange/);
assert.match(previewSource, /onPlaybackTimeChange/);
assert.doesNotMatch(
  JSON.stringify(projected),
  /(providerTaskId|workflow|localPath|prompt)/i,
);

console.log("video story runtime tests passed");
