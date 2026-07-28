import assert from "node:assert/strict";
import type { Session, StyleHotSwapRequest } from "../lib/types/index.ts";
import type { StoredModelConfig } from "../lib/clientModelConfig.ts";
import { diagnoseByokCapabilities } from "../lib/credentials/byokDiagnostics.ts";
import { currentStyleCacheKeys } from "../lib/styleHotSwap.ts";

const textKey = "sk-text-secret-value";
const imageKey = "sk-image-secret-value";
const config: StoredModelConfig = {
  settingsMode: "split",
  textBaseUrl: "https://mock.invalid/v1",
  textApiKey: textKey,
  textModel: "mock-text",
  textProvider: "openai_compatible",
  imageBaseUrl: "https://mock.invalid/v1",
  imageApiKey: imageKey,
  imageModel: "mock-image",
  imageProvider: "openai_compatible",
  visionBaseUrl: "",
  visionApiKey: "",
  visionModel: "",
  videoBaseUrl: "",
  videoApiKey: "",
  videoModel: "",
};

const diagnostics = diagnoseByokCapabilities(config, null);
assert.equal(diagnostics.coreStoryReady, true);
assert.equal(
  diagnostics.capabilities.find((item) => item.capability === "vision")?.status,
  "optional",
);
assert.equal(
  diagnostics.capabilities.find((item) => item.capability === "tts")?.status,
  "optional",
);
assert.equal(
  diagnostics.capabilities.find((item) => item.capability === "video")?.status,
  "optional",
);
const serializedDiagnostics = JSON.stringify(diagnostics);
assert.equal(serializedDiagnostics.includes(textKey), false);
assert.equal(serializedDiagnostics.includes(imageKey), false);
assert.equal(serializedDiagnostics.includes("mock.invalid"), false);
assert.equal(serializedDiagnostics.includes("mock-text"), false);

const partial = diagnoseByokCapabilities(
  { ...config, imageApiKey: "", imageModel: "" },
  null,
);
assert.equal(partial.coreStoryReady, false);
assert.deepEqual(
  partial.capabilities.find((item) => item.capability === "image")?.missingFields,
  ["apiKey", "model"],
);

const unified = diagnoseByokCapabilities(
  {
    ...config,
    settingsMode: "unified",
    unifiedBaseUrl: "https://mock.invalid/v1",
    unifiedApiKey: "sk-unified-secret",
    unifiedProvider: "openai_compatible",
    visionBaseUrl: "https://mock.invalid/v1",
    visionApiKey: "sk-unified-secret",
    visionModel: "mock-vision",
  },
  { presetId: "payg", apiKey: "sk-tts-secret" },
);
assert.equal(unified.coreStoryReady, true);
assert.equal(
  unified.capabilities.find((item) => item.capability === "vision")?.status,
  "ready",
);
assert.equal(
  unified.capabilities.find((item) => item.capability === "tts")?.status,
  "ready",
);
assert.equal(JSON.stringify(unified).includes("sk-unified-secret"), false);

const session: Session = {
  id: "byok-p2",
  createdAt: 1,
  worldSetting: "world",
  styleGuide: "cinematic watercolor",
  orientation: "landscape",
  language: "zh-CN",
  narrativeStyle: "简洁明快",
  history: [
    {
      scene: {
        id: "scene-1",
        scenePrompt: "a quiet room",
        entryBeatId: "beat-1",
        imageUrl: "old-image",
        beats: [
          {
            id: "beat-1",
            narration: "旧文本",
            speaker: "岚见",
            line: "早上好。",
            next: { type: "end" },
          },
        ],
      },
      visitedBeatIds: ["beat-1"],
      storyStateAfter: {
        logline: "line",
        genreTags: "drama",
        protagonist: "你",
        synopsis: "facts",
        openThreads: [],
        relationships: [],
        nextHook: "next",
      },
    },
  ],
  characters: [],
  storyState: {
    logline: "line",
    genreTags: "drama",
    protagonist: "你",
    synopsis: "facts",
    openThreads: [],
    relationships: [],
    nextHook: "next",
  },
};

const keyA = currentStyleCacheKeys(session, "scene-1", {
  text: {
    baseUrl: config.textBaseUrl,
    apiKey: textKey,
    model: config.textModel,
    provider: config.textProvider,
  },
  image: {
    baseUrl: config.imageBaseUrl,
    apiKey: imageKey,
    model: config.imageModel,
    provider: config.imageProvider,
  },
});
const keyB = currentStyleCacheKeys(session, "scene-1", {
  text: {
    baseUrl: config.textBaseUrl,
    apiKey: "different-text-key",
    model: config.textModel,
    provider: config.textProvider,
  },
  image: {
    baseUrl: config.imageBaseUrl,
    apiKey: "different-image-key",
    model: config.imageModel,
    provider: config.imageProvider,
  },
});
assert.deepEqual(keyA, keyB, "style cache fingerprints must not include API keys");
assert.equal(JSON.stringify(keyA).includes("secret"), false);

class MemoryStorage {
  #values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.#values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.#values.set(key, value);
  }
  removeItem(key: string): void {
    this.#values.delete(key);
  }
}

const sessionStorage = new MemoryStorage();
const localStorage = new MemoryStorage();
sessionStorage.setItem("infiplot:model", JSON.stringify(config));
Object.defineProperty(globalThis, "window", {
  value: { sessionStorage, localStorage },
  configurable: true,
});
Object.defineProperty(globalThis, "localStorage", {
  value: localStorage,
  configurable: true,
});
Object.defineProperty(globalThis, "sessionStorage", {
  value: sessionStorage,
  configurable: true,
});

const requests: Array<{ url: string; authorization: string; body: string }> = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  const headers = new Headers(init?.headers);
  requests.push({
    url,
    authorization: headers.get("authorization") ?? "",
    body: typeof init?.body === "string" ? init.body : "",
  });
  if (url.includes("/images/generations")) {
    return new Response(
      JSON.stringify({ data: [{ url: "https://assets.invalid/redraw.png" }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }
  if (url.includes("/chat/completions")) {
    return new Response(
      JSON.stringify({
        id: "mock-chat",
        object: "chat.completion",
        created: 1,
        model: "mock-text",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content:
                '{"beats":[{"id":"beat-1","narration":"新文本","line":"你好。","lineDelivery":"平静"}]}',
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }
  throw new Error(`Unexpected request: ${url}`);
};

try {
  const { applyStyleHotSwap } = await import("../lib/engineClient.ts");
  const redraw: StyleHotSwapRequest = {
    action: "redraw-current",
    session,
    sceneId: "scene-1",
  };
  const redrawResult = await applyStyleHotSwap(redraw);
  assert.equal(redrawResult.action, "redraw-current");
  assert.equal(requests.length, 1);
  assert.match(requests[0]!.url, /mock\.invalid\/v1\/images\/generations$/);
  assert.equal(requests[0]!.authorization, `Bearer ${imageKey}`);
  assert.equal(requests[0]!.authorization.includes(textKey), false);
  assert.equal(requests.some((item) => item.url === "/api/style-hot-swap"), false);
  assert.equal(requests.some((item) => item.url === "/api/llm/user-proxy"), false);

  const rewrite: StyleHotSwapRequest = {
    action: "rewrite-current",
    session,
    sceneId: "scene-1",
  };
  const rewriteResult = await applyStyleHotSwap(rewrite);
  assert.equal(rewriteResult.action, "rewrite-current");
  assert.equal(requests.length, 2);
  assert.match(requests[1]!.url, /mock\.invalid\/v1\/chat\/completions$/);
  assert.equal(requests[1]!.authorization, `Bearer ${textKey}`);
  assert.equal(requests[1]!.authorization.includes(imageKey), false);
  assert.equal(requests.some((item) => item.url === "/api/style-hot-swap"), false);
  assert.equal(requests.some((item) => item.url === "/api/llm/user-proxy"), false);

  const beforeLocked = requests.length;
  await assert.rejects(
    applyStyleHotSwap({
      action: "rewrite-current",
      sceneId: "scene-1",
      session: {
        ...session,
        authoredStory: {
          caseStudyId: "locked",
          version: "v1",
          authorLocked: true,
          aiContinuationBoundary: { afterNodeId: "future-node" },
          currentNodeId: "opening",
          currentBeatId: "beat-1",
          visitedNodeIds: ["opening"],
          variables: {},
          variableDefinitions: [],
          nodes: [],
        },
      },
    }),
    /作者锁定章节不允许 AI 改写原稿/,
  );
  assert.equal(requests.length, beforeLocked, "locked rewrite must not call a provider");
} finally {
  globalThis.fetch = originalFetch;
}

console.log("BYOK external-test P2 tests passed");

