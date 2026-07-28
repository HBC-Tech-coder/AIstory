import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { EngineConfig, Session } from "../lib/types/index.ts";
import {
  buildSpeculativeBranchKeys,
  characterStateRevision,
  shouldSchedulePrefetch,
} from "../lib/speculativeBranch.ts";

const config: EngineConfig = {
  text: {
    baseUrl: "https://text.example/v1",
    apiKey: "test",
    model: "text-v1",
    provider: "openai_compatible",
  },
  image: {
    baseUrl: "https://image.example/v1",
    apiKey: "test",
    model: "image-v1",
    provider: "openai",
  },
  vision: {
    baseUrl: "https://vision.example/v1",
    apiKey: "test",
    model: "vision-v1",
    provider: "openai_compatible",
  },
};

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "session-private-a",
    createdAt: 1,
    worldSetting: "A city with {{PLAYER_NAME}} as the player.",
    styleGuide: "watercolor",
    language: "zh-CN",
    orientation: "landscape",
    playerName: "甲",
    cacheIdentity: {
      visibility: "public",
      storyId: "template-a",
      templateId: "template-a",
      version: "v1",
    },
    history: [
      {
        scene: {
          id: "source-1",
          scenePrompt: "source",
          entryBeatId: "b1",
          beats: [],
        },
        visitedBeatIds: ["b1"],
        exit: {
          kind: "choice",
          choiceId: "choice-a",
          label: "向左",
          nextSceneSeed: "target-left",
        },
      },
    ],
    characters: [
      {
        name: "林舟",
        voiceDescription: "男，青年",
        currentState: {
          name: "林舟",
          emotion: "calm",
          updatedAtSceneId: "source-1",
        },
      },
    ],
    ...overrides,
  };
}

function plannedCount(
  depth: 0 | 1 | 2,
  adminCap: 0 | 1 | 2,
  budget: number,
  branching: number,
): number {
  let used = 0;
  const walk = (level: number) => {
    for (let i = 0; i < branching; i++) {
      if (!shouldSchedulePrefetch(level, depth, adminCap, used, budget)) return;
      used += 1;
      walk(level + 1);
    }
  };
  walk(0);
  return used;
}

assert.equal(plannedCount(0, 2, 10, 3), 0, "depth 0 must enqueue nothing");
assert.equal(plannedCount(1, 2, 10, 3), 3, "depth 1 only schedules direct children");
assert.equal(plannedCount(2, 1, 10, 3), 3, "admin cap limits depth 2 to one level");
assert.equal(plannedCount(2, 2, 5, 3), 5, "branch budget bounds depth 2");

const base = buildSpeculativeBranchKeys(session(), config)!;
assert.deepEqual(
  buildSpeculativeBranchKeys(session(), config),
  base,
  "identical input must produce the same key",
);
assert.equal(
  buildSpeculativeBranchKeys(session({ playerName: "乙" }), config)!.key,
  base.key,
  "player rename must keep the canonical branch cache hit",
);
assert.notEqual(
  buildSpeculativeBranchKeys(session({ language: "en" }), config)!.textKey,
  base.textKey,
  "language must isolate text cache",
);
assert.notEqual(
  buildSpeculativeBranchKeys(session({ styleGuide: "oil painting" }), config)!.imageKey,
  base.imageKey,
  "visual style must isolate image cache",
);
assert.notEqual(
  buildSpeculativeBranchKeys(session({ orientation: "portrait" }), config)!.imageKey,
  base.imageKey,
  "orientation/aspect ratio must isolate image cache",
);
assert.notEqual(
  characterStateRevision(
    session({
      characters: [
        {
          name: "林舟",
          voiceDescription: "男，青年",
          currentState: {
            name: "林舟",
            emotion: "angry",
            updatedAtSceneId: "source-2",
          },
        },
      ],
    }),
  ),
  base.characterStateRevision,
  "character state revision must naturally invalidate predictions",
);

const cacheDir = await mkdtemp(path.join(tmpdir(), "aistory-speculative-test-"));
process.env.AISTORY_CACHE_DIR = cacheDir;
process.env.AISTORY_BRANCH_PREFETCH_MAX_DEPTH = "2";
process.env.AISTORY_BRANCH_PREFETCH_BRANCH_BUDGET = "4";
const server = await import("../lib/engine/speculativeBranchCache.ts");

assert.equal(
  server.rejectSpeculativeRequest({
    mode: "prefetch",
    requestedDepth: 0,
    branchOrdinal: 0,
    includeAudio: false,
  }),
  "prefetch-disabled",
  "server must hard reject depth 0 before queue/model work",
);
let disabledCalls = 0;
const disabledReason = server.rejectSpeculativeRequest({
  mode: "prefetch",
  requestedDepth: 0,
  branchOrdinal: 0,
});
if (!disabledReason) disabledCalls += 1;
assert.equal(disabledCalls, 0, "depth 0 must not call text/image/cloud/GPU work");

let calls = 0;
let release!: () => void;
const gate = new Promise<void>((resolve) => {
  release = resolve;
});
const first = server.runSpeculativeSingleFlight("same-key", "prefetch", async () => {
  calls += 1;
  await gate;
  return "ready";
});
const promoted = server.runSpeculativeSingleFlight("same-key", "foreground", async () => {
  calls += 1;
  return "duplicate";
});
release();
assert.equal(await first, "ready");
assert.equal(await promoted, "ready");
assert.equal(calls, 1, "foreground promotion must reuse the prediction single-flight");

const busyKeys = buildSpeculativeBranchKeys(session(), config)!;
await assert.rejects(
  server.withSpeculativeBranchCache(
    {
      keys: busyKeys,
      request: {
        mode: "prefetch",
        requestedDepth: 1,
        branchOrdinal: 0,
        includeAudio: false,
      },
    },
    async (observe) => {
      observe({
        type: "beat",
        beat: {
          id: "b1",
          narration: "{{PLAYER_NAME}} reaches the gate.",
          next: { type: "choice", choices: [] },
        },
      });
      throw new Error("HTTP 429 service busy");
    },
  ),
  /429/,
);
const busyRaw = await readFile(
  path.join(cacheDir, "speculative-branches", `${busyKeys.key}.json`),
  "utf8",
);
const busyEnvelope = JSON.parse(busyRaw) as { status: string; retryAt?: number };
assert.equal(busyEnvelope.status, "image_pending", "429 must remain pending");
assert.ok((busyEnvelope.retryAt ?? 0) > Date.now(), "429 must schedule exponential retry");

await rm(cacheDir, { recursive: true, force: true });
console.log("speculative branch cache tests: ok");
