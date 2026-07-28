import assert from "node:assert/strict";

import type { Beat, EngineConfig, Session } from "../lib/types/index.ts";
import {
  applyExpressionRewrite,
  applyStyleToSession,
  currentStyleCacheKeys,
  shouldReplaceCurrentImage,
} from "../lib/styleHotSwap.ts";

const choices = [
  {
    id: "c1",
    label: "留下",
    effect: { kind: "change-scene" as const, nextSceneSeed: "stay" },
  },
  {
    id: "c2",
    label: "离开",
    effect: { kind: "change-scene" as const, nextSceneSeed: "leave" },
  },
];
const beats: Beat[] = [
  {
    id: "b1",
    speaker: "林舟",
    line: "{{PLAYER_NAME}}，你决定了吗？",
    lineDelivery: "克制",
    activeCharacters: [{ name: "林舟", pose: "受伤但站立" }],
    next: { type: "choice", choices },
  },
];
const session: Session = {
  id: "s1",
  createdAt: 1,
  worldSetting: "world",
  styleGuide: "watercolor",
  orientation: "landscape",
  language: "zh-CN",
  playerName: "甲",
  history: [
    {
      scene: {
        id: "scene-1",
        scenePrompt: "a gate at night",
        entryBeatId: "b1",
        beats,
        imageUrl: "old-image",
      },
      visitedBeatIds: ["b1"],
      storyStateAfter: {
        logline: "line",
        genreTags: "drama",
        protagonist: "你",
        synopsis: "facts",
        openThreads: [],
        relationships: ["林舟: ally"],
        nextHook: "gate",
      },
    },
  ],
  characters: [
    {
      name: "林舟",
      voiceDescription: "男，青年",
      voiceProfile: {
        id: "male-young-calm",
        label: "青年沉稳男声",
        gender: "male",
        ageRange: "young",
        style: "calm",
        timbre: "清晰",
      },
      currentState: {
        name: "林舟",
        condition: "受伤",
        outfit: "黑色外套",
        emotion: "克制",
      },
    },
  ],
  storyState: {
    logline: "line",
    genreTags: "drama",
    protagonist: "你",
    synopsis: "facts",
    openThreads: [],
    relationships: ["林舟: ally"],
    nextHook: "gate",
  },
};
const config: EngineConfig = {
  text: { baseUrl: "", apiKey: "", model: "text-v1" },
  image: { baseUrl: "", apiKey: "", model: "image-v1" },
  vision: { baseUrl: "", apiKey: "", model: "vision-v1" },
};

const visual = applyStyleToSession(session, { styleGuide: "ink wash" });
assert.deepEqual(visual.history, session.history, "visual switch must preserve progress/text");
assert.deepEqual(visual.storyState, session.storyState, "visual switch must preserve world state");
assert.deepEqual(
  visual.characters,
  session.characters,
  "visual switch must preserve identity, injury, outfit and voice",
);

const narrative = applyStyleToSession(session, { narrativeStyle: "简洁明快" });
assert.deepEqual(narrative.history, session.history, "narrative switch must preserve choices");
assert.deepEqual(narrative.storyState, session.storyState, "narrative switch must preserve state");
assert.deepEqual(
  narrative.characters[0]!.voiceProfile,
  session.characters[0]!.voiceProfile,
  "narrative style must not change voiceProfile",
);

const baseKeys = currentStyleCacheKeys(session, "scene-1", config);
const visualKeys = currentStyleCacheKeys(visual, "scene-1", config);
assert.equal(visualKeys.textKey, baseKeys.textKey, "visual style must not invalidate text key");
assert.notEqual(visualKeys.imageKey, baseKeys.imageKey, "visual style must invalidate image key");
const narrativeKeys = currentStyleCacheKeys(narrative, "scene-1", config);
assert.notEqual(narrativeKeys.textKey, baseKeys.textKey, "narrative style must invalidate text key");
assert.equal(narrativeKeys.imageKey, baseKeys.imageKey, "narrative style must not invalidate image key");
assert.notEqual(
  currentStyleCacheKeys({ ...session, orientation: "portrait" }, "scene-1", config).imageKey,
  baseKeys.imageKey,
  "portrait and landscape image keys must be isolated",
);
assert.equal(
  currentStyleCacheKeys(
    applyStyleToSession(visual, { styleGuide: session.styleGuide }),
    "scene-1",
    config,
  ).imageKey,
  baseKeys.imageKey,
  "switching back must recover the old cache key",
);

const rewritten = applyExpressionRewrite(beats, [
  { id: "b1", line: "{{PLAYER_NAME}}，想好了吗？", lineDelivery: "轻快" },
]);
assert.equal(rewritten[0]!.line, "{{PLAYER_NAME}}，想好了吗？");
assert.equal(rewritten[0]!.speaker, beats[0]!.speaker);
assert.deepEqual(rewritten[0]!.next, beats[0]!.next, "rewrite must preserve choices");
assert.deepEqual(
  rewritten[0]!.activeCharacters,
  beats[0]!.activeCharacters,
  "rewrite must preserve character state",
);
assert.equal(shouldReplaceCurrentImage("image_pending"), false, "429/pending must keep old image");
assert.equal(shouldReplaceCurrentImage("ready"), true);

console.log("style hot swap tests: ok");
