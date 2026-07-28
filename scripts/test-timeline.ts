import assert from "node:assert/strict";

import type { BeatChoice, Session } from "../lib/types/index.ts";
import {
  activateTimelineBranch,
  forkTimelineAtDecision,
  migrateLegacyDecisions,
  recordTimelineDecision,
  updateActiveTimelineSnapshot,
} from "../lib/timeline.ts";

const options: BeatChoice[] = [
  {
    id: "stay",
    label: "留下",
    effect: { kind: "change-scene", nextSceneSeed: "stay-path" },
  },
  {
    id: "leave",
    label: "离开",
    effect: { kind: "change-scene", nextSceneSeed: "leave-path" },
  },
];
const session: Session = {
  id: "timeline-story",
  createdAt: 1,
  worldSetting: "world",
  styleGuide: "watercolor",
  narrativeStyle: "电影化",
  orientation: "landscape",
  language: "zh-CN",
  history: [
    {
      scene: {
        id: "scene-1",
        scenePrompt: "room",
        entryBeatId: "decision",
        imageUrl: "scene-1.webp",
        beats: [
          {
            id: "decision",
            narration: "门正在关闭。",
            next: { type: "choice", choices: options },
          },
        ],
      },
      visitedBeatIds: ["decision"],
    },
  ],
  characters: [
    {
      name: "林舟",
      voiceDescription: "男声",
      currentState: { name: "林舟", condition: "healthy" },
    },
  ],
  storyState: {
    logline: "line",
    genreTags: "drama",
    protagonist: "你",
    synopsis: "before choice",
    openThreads: ["door"],
    relationships: ["林舟: stranger"],
    nextHook: "door",
  },
};

const scene = session.history[0]!.scene;
const beat = scene.beats[0]!;
const recorded = recordTimelineDecision(
  session,
  scene,
  beat,
  options[0]!,
  ["decision"],
);
assert.equal(recorded.timeline!.decisions.length, 1);
assert.deepEqual(
  recorded.timeline!.decisions[0]!.choices.map((choice) => choice.id),
  ["stay", "leave"],
  "history must retain all options visible at the decision",
);

const forked = forkTimelineAtDecision(
  recorded,
  recorded.timeline!.decisions[0]!.id,
  "leave",
);
assert.equal(forked.reused, false);
assert.equal(forked.session.timeline!.branches.length, 2, "fork must preserve old branch");
assert.equal(
  forked.session.storyState!.synopsis,
  "before choice",
  "fork must restore pre-choice world state",
);
assert.equal(
  forked.session.characters.length,
  1,
  "future characters from the abandoned branch must not leak",
);
assert.equal(
  forked.session.history.at(-1)!.exit?.kind,
  "choice",
  "new choice is applied after checkpoint restore",
);

const futureSession: Session = {
  ...forked.session,
  history: [
    ...forked.session.history,
    {
      scene: {
        id: "scene-leave",
        scenePrompt: "outside",
        entryBeatId: "b1",
        beats: [{ id: "b1", narration: "outside", next: { type: "choice", choices: [] } }],
      },
      visitedBeatIds: ["b1"],
    },
  ],
  characters: [
    ...forked.session.characters,
    { name: "未来角色", voiceDescription: "female" },
  ],
};
const progressed = updateActiveTimelineSnapshot(
  futureSession,
  "scene-leave",
  "b1",
  ["b1"],
);
const oldRoot = activateTimelineBranch(
  progressed,
  recorded.timeline!.activeBranchId,
);
assert.equal(oldRoot.history.length, 1, "switching back retains old branch progress");
assert.equal(
  oldRoot.characters.some((character) => character.name === "未来角色"),
  false,
  "old branch must not reveal future branch characters",
);
const restoredChild = activateTimelineBranch(progressed, forked.branch.id);
assert.equal(restoredChild.history.length, 2, "child branch progress is retained");

const serialized = JSON.stringify(progressed);
const refreshed = JSON.parse(serialized) as Session;
assert.equal(
  refreshed.timeline!.activeBranchId,
  progressed.timeline!.activeBranchId,
  "active branch must persist across refresh/restart serialization",
);

const legacy: Session = {
  ...session,
  history: [{ ...session.history[0]!, exit: {
    kind: "choice",
    choiceId: "stay",
    label: "留下",
    nextSceneSeed: "stay-path",
  } }],
};
const migrated = migrateLegacyDecisions(legacy);
assert.equal(migrated.length, 1);
assert.equal(migrated[0]!.restorable, false, "legacy nodes without checkpoint are view-only");

console.log("timeline tests: ok");
