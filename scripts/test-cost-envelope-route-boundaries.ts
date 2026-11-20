/**
 * Cost-envelope route boundary tests.
 *
 * Zero network / zero provider / zero database. Every route module is loaded
 * from its real `app/api/**\/route.ts` source, transpiled to CommonJS with the
 * repository TypeScript compiler, and executed against a hand-written module
 * registry. Only the pinned billing APIs, provider clients, caches, guards and
 * request/config dependencies are mocked.
 *
 * These tests intentionally exercise the route `POST` handlers rather than
 * only grepping source text, so they catch regressions in ordering (failure
 * intent before refund), envelope scoping (one envelope per reservation), and
 * cache hits bypassing both the provider and the envelope.
 *
 * Run with the repository's normal script runner (tsx), e.g.:
 *   pnpm exec tsx scripts/test-cost-envelope-route-boundaries.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { NextResponse } from "next/server";
import ts from "typescript";

const root = process.cwd();
const SECRET = "RAW_PROVIDER_SECRET_9f3";

type Pricing = "v2" | "v1" | "byok";
type Behavior =
  | "success"
  | "throw"
  | "empty"
  | "mock"
  | "invalid"
  | "nonmatching"
  | "unchanged"
  | "whitespace"
  | "malformed"
  | "duplicate";

type EnvelopeCall = {
  config: unknown;
  operation: string;
};

type State = {
  config: Record<string, unknown>;
  byokConfig: Record<string, unknown>;
  pricing: Pricing;
  behavior: Behavior;
  cacheHit: boolean;
  innerCacheHit: boolean;
  settleFails: boolean;
  parseThrows: boolean;
  envelopeThrowsAfterCallback: boolean;
  succeededThrows: boolean;
  invalidJson: boolean;
  envelopeCalls: EnvelopeCall[];
  envelopeActive: boolean;
  envelopeActiveAtProvider: boolean;
  providerCalls: number;
  providerConfig: unknown;
  started: number;
  succeeded: number;
  failure: number;
  prepares: number;
  refunds: Array<{ reason: string; options?: unknown }>;
  settlements: number;
  cacheWrites: number;
  order: string[];
};

type MockModules = Record<string, unknown>;
type MockBuilder = (state: State) => MockModules;

const routes = {
  beatAudio: "app/api/beat-audio/route.ts",
  characterNames: "app/api/character-names/route.ts",
  classifyFreeform: "app/api/classify-freeform/route.ts",
  insertBeat: "app/api/insert-beat/route.ts",
  parseStyleImage: "app/api/parse-style-image/route.ts",
  styleHotSwap: "app/api/style-hot-swap/route.ts",
  vision: "app/api/vision/route.ts",
} as const;

function createState(overrides: Partial<State> = {}): State {
  const config = {
    text: { model: "platform-text" },
    vision: { model: "platform-vision" },
    tts: { speechModel: "platform-tts" },
    image: { model: "platform-image" },
  };
  const byokConfig = {
    text: { model: "byok-text" },
    vision: { model: "byok-vision" },
  };
  return {
    config,
    byokConfig,
    pricing: "v2",
    behavior: "success",
    cacheHit: false,
    innerCacheHit: false,
    settleFails: false,
    parseThrows: false,
    envelopeThrowsAfterCallback: false,
    succeededThrows: false,
    invalidJson: false,
    envelopeCalls: [],
    envelopeActive: false,
    envelopeActiveAtProvider: false,
    providerCalls: 0,
    providerConfig: undefined,
    started: 0,
    succeeded: 0,
    failure: 0,
    prepares: 0,
    refunds: [],
    settlements: 0,
    cacheWrites: 0,
    order: [],
    ...overrides,
  };
}

function providerEntry(state: State, config: unknown): void {
  state.providerCalls += 1;
  state.providerConfig = config;
  state.envelopeActiveAtProvider = state.envelopeActive;
  state.order.push("provider");
}

function baseMocks(state: State): MockModules {
  return {
    "next/server": { NextResponse },
    "@/lib/config": {
      loadEngineConfig: () => state.config,
      buildByoEngineConfig: () => state.byokConfig,
    },
    "@/lib/supabase/guard": {
      requireUser: async () => ({ userId: "boundary-user", authType: "phone" }),
    },
    "@/lib/billing/generationGate": {
      prepareGenerationBilling: async () => {
        state.prepares += 1;
        if (state.pricing === "byok") return { mode: "user_byok" };
        return {
          mode: "platform_managed",
          reservation: {
            catalogEntry: {
              pricingMode:
                state.pricing === "v2"
                  ? "cost_beta_credit_v2"
                  : "fixed_beta_credit_v1",
            },
          },
          providerOutcome: "not_started",
        };
      },
      markGenerationBillingProviderStarted: () => {
        state.started += 1;
        state.order.push("started");
      },
      markGenerationBillingProviderSucceeded: () => {
        state.succeeded += 1;
        state.order.push("succeeded");
        if (state.succeededThrows) throw new Error("SUCCEEDED_SECRET");
      },
      markGenerationBillingOperationFailed: () => {
        state.failure += 1;
        state.order.push("failure");
      },
      refundGenerationBilling: async (
        _context: unknown,
        reason: string,
        options?: unknown,
      ) => {
        state.refunds.push({ reason, options });
        state.order.push("refund");
        return "refund";
      },
      settleGenerationBilling: async () => {
        state.settlements += 1;
        state.order.push("settle");
        if (state.settleFails) throw new Error("DB_SETTLE_SECRET");
        return "settle";
      },
    },
    "@/lib/billing/platformCostEnvelopeServer": {
      runInCostEnvelope: async (
        config: unknown,
        operation: string,
        fn: () => Promise<unknown>,
      ) => {
        state.envelopeCalls.push({ config, operation });
        state.order.push("envelope");
        state.envelopeActive = true;
        try {
          const value = await fn();
          if (state.envelopeThrowsAfterCallback) {
            throw new Error("ENVELOPE_SECRET");
          }
          return value;
        } finally {
          state.envelopeActive = false;
        }
      },
    },
  };
}

const sourceCache = new Map<string, string>();

function readRoute(file: string): string {
  const cached = sourceCache.get(file);
  if (cached !== undefined) return cached;
  const text = readFileSync(path.join(root, file), "utf8");
  sourceCache.set(file, text);
  return text;
}

function loadRoute(file: string, modules: MockModules): Record<string, unknown> {
  const transpiled = ts.transpileModule(readRoute(file), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: file,
  });
  const routeModule = { exports: {} as Record<string, unknown> };
  const localRequire = (id: string) => {
    if (!(id in modules)) {
      throw new Error(`unmocked module "${id}" required by ${file}`);
    }
    return modules[id];
  };
  const factory = new Function(
    "require",
    "module",
    "exports",
    "__filename",
    "__dirname",
    transpiled.outputText,
  );
  factory(
    localRequire,
    routeModule,
    routeModule.exports,
    path.join(root, file),
    path.dirname(path.join(root, file)),
  );
  return routeModule.exports;
}

async function invoke(
  file: string,
  state: State,
  body: unknown,
  buildMocks: MockBuilder,
): Promise<Response> {
  const route = loadRoute(file, buildMocks(state));
  const handler = route.POST;
  assert.equal(typeof handler, "function", `${file} must export POST`);
  return (handler as (request: unknown) => Promise<Response>)({
    json: async () => {
      if (state.invalidJson) throw new Error("INVALID_JSON_SECRET");
      return body;
    },
    signal: undefined,
  });
}

function assertFailureBeforeRefund(state: State, label: string): void {
  const failureIndex = state.order.indexOf("failure");
  const refundIndex = state.order.indexOf("refund");
  assert.ok(failureIndex >= 0, `${label}: failure intent must be recorded`);
  assert.ok(refundIndex >= 0, `${label}: refund must be recorded`);
  assert.ok(
    failureIndex < refundIndex,
    `${label}: failure intent must be recorded before refund`,
  );
}

async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Route-specific module registries
// ---------------------------------------------------------------------------

function beatAudioMocks(state: State): MockModules {
  const mocks = baseMocks(state);
  mocks["@infiplot/engine"] = {
    requestBeatAudio: async (
      config: unknown,
      _body: unknown,
      hooks?: { onProviderStarted?: () => void },
    ) => {
      providerEntry(state, config);
      hooks?.onProviderStarted?.();
      if (state.behavior === "throw") throw new Error(SECRET);
      if (state.behavior === "empty") return { audio: null };
      return {
        audio: {
          mime: "audio/mpeg",
          base64: Buffer.from("audio").toString("base64"),
        },
      };
    },
  };
  mocks["@/lib/engine/ttsCache"] = {
    beatAudioCacheKey: () => ({ status: "miss", key: "tts-key" }),
    peekTtsCache: async () =>
      state.cacheHit
        ? {
            audio: {
              mime: "audio/mpeg",
              base64: Buffer.from("cached").toString("base64"),
            },
            cache: { status: "hit", key: "tts-key" },
          }
        : null,
    withTtsCache: async (
      meta: { key?: string },
      _label: string,
      compute: () => Promise<{ audio: unknown }>,
    ) => {
      if (state.innerCacheHit) {
        return {
          audio: {
            mime: "audio/mpeg",
            base64: Buffer.from("inner").toString("base64"),
          },
          cache: { status: "hit", key: meta.key },
        };
      }
      const value = await compute();
      return {
        ...value,
        cache: value.audio
          ? { status: "write", key: meta.key }
          : { status: "skip", key: meta.key, reason: "empty-audio" },
      };
    },
  };
  return mocks;
}

function beatAudioBody(): Record<string, unknown> {
  return {
    beat: { id: "beat-1", line: "hello" },
    voice: { provider: "stepfun" },
    stepfunVoiceId: "voice-1",
  };
}

function characterNamesMocks(state: State): MockModules {
  const mocks = baseMocks(state);
  mocks["@infiplot/ai-client"] = {
    chat: async (config: unknown) => {
      providerEntry(state, config);
      if (state.behavior === "throw") throw new Error(SECRET);
      if (state.behavior === "empty") {
        return JSON.stringify({ candidates: [] });
      }
      if (state.behavior === "invalid") {
        return JSON.stringify({ candidates: [{ meaning: "forest" }] });
      }
      return JSON.stringify({
        candidates: [{ name: "Lin", meaning: "forest" }],
      });
    },
  };
  mocks["@/lib/engine/jsonParser"] = {
    parseJsonLoose: (raw: string) => {
      if (state.parseThrows) throw new Error("PARSE_SECRET");
      return JSON.parse(raw) as unknown;
    },
  };
  mocks["@/lib/character-names"] = {
    areNamesTooSimilar: (left: string, right: string) =>
      left.trim().toLowerCase() === right.trim().toLowerCase(),
    generateLocalNames: () => [{ name: "Fallback", meaning: "fallback" }],
    sanitizeCharacterName: (name: string) => name,
  };
  return mocks;
}

function byokBody(base: Record<string, unknown>): Record<string, unknown> {
  return { ...base, byo: { text: { model: "byok" } } };
}

function directMocks(
  state: State,
  moduleId: string,
  exportName: string,
  result: Record<string, unknown>,
): MockModules {
  const mocks = baseMocks(state);
  mocks[moduleId] = {
    [exportName]: async (
      config: unknown,
      _body: unknown,
      hooks?: { onProviderStarted?: () => void },
    ) => {
      providerEntry(state, config);
      hooks?.onProviderStarted?.();
      if (state.behavior === "throw") throw new Error(SECRET);
      return result;
    },
  };
  mocks["@/lib/credentials/serverPolicy"] = {
    assertCompleteByok: () => undefined,
    hasByokPayload: () => state.pricing === "byok",
  };
  mocks["@/lib/case-studies/schema"] = {
    isAuthoredAiContinuationAllowed: () => true,
  };
  return mocks;
}

function parseStyleImageMocks(state: State): MockModules {
  const mocks = baseMocks(state);
  mocks["@infiplot/ai-client"] = {
    analyzeImageDataUrl: async (visionConfig: unknown) => {
      providerEntry(state, visionConfig);
      if (state.behavior === "throw") throw new Error(SECRET);
      if (state.behavior === "empty") return "{}";
      if (state.behavior === "invalid") {
        return JSON.stringify({ stylePrompt: 42 });
      }
      return JSON.stringify({ stylePrompt: "watercolor" });
    },
  };
  mocks["@/lib/styleExtraction"] = { STYLE_EXTRACTION_PROMPT: "extract" };
  return mocks;
}

function styleHotSwapMocks(state: State): MockModules {
  const mocks = baseMocks(state);
  const imageCache = { imageUrl: "https://img.example/x.png", imageUuid: "uuid-1" };
  const textCache = [{ id: "beat-1", narration: "cached", line: "line" }];
  mocks["@/lib/engine/agents/painter"] = {
    runPainter: async (
      config: unknown,
      _input: unknown,
      _beat: unknown,
      hooks?: { onProviderStarted?: () => void },
    ) => {
      providerEntry(state, config);
      hooks?.onProviderStarted?.();
      if (state.behavior === "throw") throw new Error(SECRET);
      if (state.behavior === "mock") {
        return { kind: "mock", imageUrl: "data:image/svg+xml;base64,AAAA" };
      }
      return {
        kind: "real",
        imageUrl: "https://img.example/x.png",
        imageUuid: "uuid-1",
      };
    },
  };
  mocks["@infiplot/ai-client"] = {
    chat: async (textConfig: unknown) => {
      providerEntry(state, textConfig);
      if (state.behavior === "throw") throw new Error(SECRET);
      if (state.behavior === "nonmatching") {
        return JSON.stringify({
          beats: [{ id: "missing-beat", narration: "rewritten" }],
        });
      }
      if (state.behavior === "unchanged") {
        return JSON.stringify({ beats: [{ id: "beat-1", narration: "n" }] });
      }
      if (state.behavior === "whitespace") {
        return JSON.stringify({ beats: [{ id: "beat-1", narration: "   " }] });
      }
      if (state.behavior === "malformed") {
        return JSON.stringify({ beats: [{ id: "beat-1", narration: 42 }] });
      }
      if (state.behavior === "duplicate") {
        // applyExpressionRewrite is a Map: the last duplicate wins. The first
        // entry changes the prose, the last entry leaves it unchanged, so the
        // delivered rewrite would be a no-op.
        return JSON.stringify({
          beats: [
            { id: "beat-1", narration: "rewritten" },
            { id: "beat-1", narration: "n" },
          ],
        });
      }
      return JSON.stringify({ beats: [{ id: "beat-1", narration: "rewritten" }] });
    },
  };
  mocks["@/lib/engine/jsonParser"] = {
    parseJsonLoose: (raw: string) => {
      if (state.parseThrows) throw new Error("PARSE_SECRET");
      return JSON.parse(raw) as unknown;
    },
  };
  mocks["@/lib/engine/mockImage"] = {
    isMockImageDataUri: (url: string) => url.startsWith("data:"),
  };
  mocks["@/lib/engine/styleHotSwapCache"] = {
    peekStyleHotSwapCache: async (key: string) => {
      if (!state.cacheHit) return null;
      return key === "image-key" ? imageCache : textCache;
    },
    withStyleHotSwapCache: async (
      key: string,
      compute: () => Promise<unknown>,
    ) => {
      if (state.innerCacheHit) {
        return {
          data: key === "image-key" ? imageCache : textCache,
          cacheStatus: "hit",
        };
      }
      const data = await compute();
      state.cacheWrites += 1;
      return { data, cacheStatus: "write" };
    },
  };
  mocks["@/lib/styleHotSwap"] = {
    applyExpressionRewrite: (source: unknown[], rewritten: unknown[]) => {
      type BeatLike = {
        id: string;
        narration?: string;
        line?: string;
        lineDelivery?: string;
      };
      const byId = new Map(
        (rewritten as BeatLike[]).map((beat) => [beat.id, beat]),
      );
      return (source as BeatLike[]).map((beat) => {
        const replacement = byId.get(beat.id);
        if (!replacement) return { ...beat };
        return {
          ...beat,
          narration: replacement.narration?.trim() || beat.narration,
          line: replacement.line?.trim() || beat.line,
          lineDelivery: replacement.lineDelivery?.trim() || beat.lineDelivery,
        };
      });
    },
    canonicalBeats: () => [
      { id: "beat-1", narration: "n", activeCharacters: [], speaker: "你" },
    ],
    currentStyleCacheKeys: () => ({
      imageKey: "image-key",
      textKey: "text-key",
    }),
  };
  mocks["@infiplot/types"] = { coerceOrientation: (value: unknown) => value };
  mocks["@/lib/case-studies/schema"] = {
    isAuthoredAiContinuationAllowed: () => true,
  };
  return mocks;
}

function styleBody(action: "redraw-current" | "rewrite-current"): Record<string, unknown> {
  return {
    action,
    sceneId: "scene-1",
    session: {
      history: [
        {
          scene: {
            id: "scene-1",
            scenePrompt: "prompt",
            entryBeatId: "beat-1",
          },
        },
      ],
      characters: [],
      styleGuide: "guide",
      orientation: "landscape",
    },
  };
}

// ---------------------------------------------------------------------------
// Shared scenario assertions
// ---------------------------------------------------------------------------

function assertV2Envelope(
  state: State,
  operation: string,
  providerConfig: unknown,
): void {
  assert.equal(state.envelopeCalls.length, 1, "v2 must wrap exactly once");
  assert.equal(state.envelopeCalls[0]!.operation, operation);
  assert.equal(state.envelopeCalls[0]!.config, state.config);
  assert.equal(state.providerCalls, 1, "one actual provider call");
  assert.equal(state.providerConfig, providerConfig, "provider config identity");
  assert.equal(
    state.envelopeActiveAtProvider,
    true,
    "provider callback must run inside the envelope",
  );
  assert.equal(state.started, 1);
  assert.equal(state.succeeded, 1);
  assert.equal(state.failure, 0);
}

function assertBypassEnvelope(state: State, providerConfig: unknown): void {
  assert.equal(state.envelopeCalls.length, 0, "legacy/BYOK must bypass envelope");
  assert.equal(state.providerCalls, 1);
  assert.equal(state.providerConfig, providerConfig, "provider config identity");
  assert.equal(state.envelopeActiveAtProvider, false);
}

// ---------------------------------------------------------------------------
// beat-audio
// ---------------------------------------------------------------------------

async function testBeatAudio(): Promise<void> {
  {
    const state = createState();
    const response = await invoke(
      routes.beatAudio,
      state,
      beatAudioBody(),
      beatAudioMocks,
    );
    assert.equal(response.status, 200);
    assertV2Envelope(state, "tts.beat", state.config);
    assert.equal(state.settlements, 1);
  }

  {
    const state = createState({ envelopeThrowsAfterCallback: true });
    const response = await invoke(
      routes.beatAudio,
      state,
      beatAudioBody(),
      beatAudioMocks,
    );
    assert.equal(response.status, 503);
    assert.equal(state.envelopeCalls.length, 1);
    assert.equal(state.providerCalls, 1);
    assert.equal(state.envelopeActiveAtProvider, true);
    assert.equal(state.started, 1);
    assert.equal(
      state.succeeded,
      0,
      "envelope rejection after callback must precede any success marker",
    );
    assert.equal(state.failure, 1);
    assertFailureBeforeRefund(state, "beat-audio envelope post-callback rejection");
    assert.equal(state.refunds.length, 1);
  }

  {
    const state = createState({ succeededThrows: true });
    const response = await invoke(
      routes.beatAudio,
      state,
      beatAudioBody(),
      beatAudioMocks,
    );
    assert.equal(response.status, 503);
    assert.equal(state.succeeded, 1);
    assert.equal(
      state.failure,
      0,
      "success-marker throw after a completed envelope must not mark failure",
    );
    assert.equal(state.refunds.length, 1);
  }

  {
    const state = createState({ pricing: "v1" });
    const response = await invoke(
      routes.beatAudio,
      state,
      beatAudioBody(),
      beatAudioMocks,
    );
    assert.equal(response.status, 200);
    assertBypassEnvelope(state, state.config);
    assert.equal(state.settlements, 1);
  }

  {
    const state = createState({ cacheHit: true });
    const response = await invoke(
      routes.beatAudio,
      state,
      beatAudioBody(),
      beatAudioMocks,
    );
    assert.equal(response.headers.get("X-AIstory-TTS-Cache"), "hit");
    assert.equal(state.prepares, 0, "cache preflight must precede reserve");
    assert.equal(state.envelopeCalls.length, 0);
    assert.equal(state.providerCalls, 0);
  }

  {
    const state = createState({ innerCacheHit: true });
    const response = await invoke(
      routes.beatAudio,
      state,
      beatAudioBody(),
      beatAudioMocks,
    );
    assert.equal(response.status, 200);
    assert.equal(state.envelopeCalls.length, 0, "inner cache hit bypasses envelope");
    assert.equal(state.providerCalls, 0, "inner cache hit bypasses provider");
    assert.equal(state.refunds.length, 1);
    assert.deepEqual(
      state.refunds[0]!.options,
      { providerNotStarted: true },
      "cache hit refund must not claim a provider start",
    );
    assert.equal(state.failure, 0, "cache hit is not a failed delivery");
  }

  {
    const state = createState({ behavior: "empty" });
    const response = await invoke(
      routes.beatAudio,
      state,
      beatAudioBody(),
      beatAudioMocks,
    );
    assert.equal(response.status, 204);
    assert.equal(state.providerCalls, 1);
    assert.equal(state.failure, 1, "null audio is explicit failed delivery");
    assert.equal(state.succeeded, 0, "null audio must not mark success");
    assertFailureBeforeRefund(state, "beat-audio null audio");
  }

  {
    const state = createState({ behavior: "throw" });
    const response = await invoke(
      routes.beatAudio,
      state,
      beatAudioBody(),
      beatAudioMocks,
    );
    assert.equal(response.status, 503);
    const body = await jsonOf(response);
    assert.equal(body.error, "TTS unavailable.");
    assert.equal(JSON.stringify(body).includes(SECRET), false);
    assert.equal(state.failure, 1);
    assertFailureBeforeRefund(state, "beat-audio provider rejection");
  }

  {
    const state = createState({ settleFails: true });
    const response = await invoke(
      routes.beatAudio,
      state,
      beatAudioBody(),
      beatAudioMocks,
    );
    assert.equal(response.status, 503);
    assert.equal(state.succeeded, 1);
    assert.equal(state.failure, 0, "settle failure after success is not a provider failure");
    assert.equal(state.refunds.length, 1);
  }
}

// ---------------------------------------------------------------------------
// character-names
// ---------------------------------------------------------------------------

async function testCharacterNames(): Promise<void> {
  const body = { count: 1, existingNames: [] };

  {
    const state = createState();
    const response = await invoke(
      routes.characterNames,
      state,
      body,
      characterNamesMocks,
    );
    assert.equal(response.status, 200);
    const payload = await jsonOf(response);
    assert.equal(payload.fallback, false);
    assertV2Envelope(state, "text.character-names", state.config.text);
    assert.equal(state.settlements, 1);
  }

  {
    const state = createState({ envelopeThrowsAfterCallback: true });
    const response = await invoke(
      routes.characterNames,
      state,
      body,
      characterNamesMocks,
    );
    assert.equal(response.status, 200);
    const payload = await jsonOf(response);
    assert.equal(payload.fallback, true);
    assert.equal(state.envelopeCalls.length, 1);
    assert.equal(state.started, 1);
    assert.equal(state.succeeded, 0);
    assert.equal(state.failure, 1);
    assertFailureBeforeRefund(state, "character-names envelope post-callback rejection");
    assert.equal(state.refunds.length, 1);
  }

  {
    const state = createState({ succeededThrows: true });
    const response = await invoke(
      routes.characterNames,
      state,
      body,
      characterNamesMocks,
    );
    assert.equal(response.status, 200);
    assert.equal(state.succeeded, 1);
    assert.equal(
      state.failure,
      0,
      "success-marker throw after a completed envelope must not mark failure",
    );
    assert.equal(state.refunds.length, 1);
  }

  {
    const state = createState({ pricing: "v1" });
    const response = await invoke(
      routes.characterNames,
      state,
      body,
      characterNamesMocks,
    );
    assert.equal(response.status, 200);
    assertBypassEnvelope(state, state.config.text);
    assert.equal(state.settlements, 1);
  }

  {
    const state = createState({ behavior: "throw" });
    const response = await invoke(
      routes.characterNames,
      state,
      body,
      characterNamesMocks,
    );
    assert.equal(response.status, 200);
    const payload = await jsonOf(response);
    assert.equal(payload.fallback, true);
    assert.equal(JSON.stringify(payload).includes(SECRET), false);
    assert.equal(state.failure, 1);
    assertFailureBeforeRefund(state, "character-names provider rejection");
  }

  {
    const state = createState({ settleFails: true });
    const response = await invoke(
      routes.characterNames,
      state,
      body,
      characterNamesMocks,
    );
    assert.equal(response.status, 200);
    assert.equal(state.succeeded, 1);
    assert.equal(state.failure, 0, "settle failure after success is not a provider failure");
    assert.equal(state.refunds.length, 1);
  }

  {
    // v2: a parse exception is unusable output. It must carry failure proof,
    // refund, and must never settle or mark success.
    const state = createState({ parseThrows: true });
    const response = await invoke(
      routes.characterNames,
      state,
      body,
      characterNamesMocks,
    );
    assert.equal(response.status, 200);
    const payload = await jsonOf(response);
    assert.equal(payload.fallback, true);
    assert.equal(state.succeeded, 0, "v2 parse failure must not mark success");
    assert.equal(state.failure, 1, "v2 parse failure requires failure intent");
    assertFailureBeforeRefund(state, "character-names v2 parse failure");
    assert.equal(state.refunds.length, 1);
    assert.equal(state.settlements, 0, "v2 parse failure must not settle");
  }

  {
    // legacy: the success marker still precedes parsing and the broad catch
    // refunds after a post-success parse exception.
    const state = createState({ parseThrows: true, pricing: "v1" });
    const response = await invoke(
      routes.characterNames,
      state,
      body,
      characterNamesMocks,
    );
    assert.equal(response.status, 200);
    assert.equal(state.succeeded, 1, "legacy raw success mark stays before parse");
    assert.equal(
      state.failure,
      0,
      "legacy post-success parse failure is not a failed delivery",
    );
    assert.equal(state.refunds.length, 1);
    assert.equal(state.settlements, 0);
  }

  {
    // v2: no candidate at all is not a usable result.
    const state = createState({ behavior: "empty" });
    const response = await invoke(
      routes.characterNames,
      state,
      body,
      characterNamesMocks,
    );
    assert.equal(response.status, 200);
    const payload = await jsonOf(response);
    assert.equal(payload.fallback, true);
    assert.equal(payload.reason, "invalid_or_similar_ai_output");
    assert.equal(state.succeeded, 0, "v2 empty output must not mark success");
    assert.equal(state.failure, 1);
    assertFailureBeforeRefund(state, "character-names v2 empty output");
    assert.equal(state.refunds.length, 1);
    assert.equal(state.settlements, 0, "v2 empty output must not settle");
  }

  {
    // v2: a candidate that duplicates the existing cast is not useful.
    const state = createState();
    const response = await invoke(
      routes.characterNames,
      state,
      { count: 1, existingNames: ["Lin"] },
      characterNamesMocks,
    );
    assert.equal(response.status, 200);
    const payload = await jsonOf(response);
    assert.equal(payload.fallback, true);
    assert.equal(payload.reason, "invalid_or_similar_ai_output");
    assert.equal(state.succeeded, 0, "v2 duplicate candidate must not mark success");
    assert.equal(state.failure, 1);
    assertFailureBeforeRefund(state, "character-names v2 duplicate output");
    assert.equal(state.settlements, 0);
  }

  {
    // v2: a candidate with a missing/invalid name field is not usable.
    const state = createState({ behavior: "invalid" });
    const response = await invoke(
      routes.characterNames,
      state,
      body,
      characterNamesMocks,
    );
    assert.equal(response.status, 200);
    const payload = await jsonOf(response);
    assert.equal(payload.fallback, true);
    assert.equal(payload.reason, "invalid_or_similar_ai_output");
    assert.equal(state.succeeded, 0, "v2 invalid candidate must not mark success");
    assert.equal(state.failure, 1);
    assertFailureBeforeRefund(state, "character-names v2 invalid candidate");
    assert.equal(state.settlements, 0);
  }

  {
    // legacy: unusable output still settles and returns the existing fallback.
    const state = createState({ behavior: "empty", pricing: "v1" });
    const response = await invoke(
      routes.characterNames,
      state,
      body,
      characterNamesMocks,
    );
    assert.equal(response.status, 200);
    const payload = await jsonOf(response);
    assert.equal(payload.fallback, true);
    assert.equal(payload.reason, "invalid_or_similar_ai_output");
    assert.equal(state.succeeded, 1);
    assert.equal(state.failure, 0);
    assert.equal(state.refunds.length, 0);
    assert.equal(state.settlements, 1);
  }

  {
    const state = createState({ invalidJson: true });
    const response = await invoke(
      routes.characterNames,
      state,
      body,
      characterNamesMocks,
    );
    assert.equal(response.status, 400);
    assert.equal(state.prepares, 0);
    assert.equal(state.providerCalls, 0);
  }
}

// ---------------------------------------------------------------------------
// vision / classify-freeform / insert-beat share the direct-provider shape
// ---------------------------------------------------------------------------

async function testDirectEngineRoute(options: {
  file: string;
  operation: string;
  body: Record<string, unknown>;
  buildMocks: MockBuilder;
  label: string;
}): Promise<void> {
  const { file, operation, body, buildMocks, label } = options;

  {
    const state = createState();
    const response = await invoke(file, state, body, buildMocks);
    assert.equal(response.status, 200, `${label}: v2 response`);
    assertV2Envelope(state, operation, state.config);
    assert.equal(state.settlements, 1);
  }

  {
    const state = createState({ envelopeThrowsAfterCallback: true });
    const response = await invoke(file, state, body, buildMocks);
    assert.equal(response.status, 500, `${label}: envelope post-callback rejection`);
    assert.equal(state.envelopeCalls.length, 1);
    assert.equal(state.started, 1);
    assert.equal(state.succeeded, 0);
    assert.equal(state.failure, 1);
    assertFailureBeforeRefund(state, `${label} envelope post-callback rejection`);
    assert.equal(state.refunds.length, 1);
  }

  {
    const state = createState({ succeededThrows: true });
    const response = await invoke(file, state, body, buildMocks);
    assert.equal(response.status, 500, `${label}: success-marker throw`);
    assert.equal(state.succeeded, 1);
    assert.equal(
      state.failure,
      0,
      `${label}: success-marker throw must not mark failure`,
    );
    assert.equal(state.refunds.length, 1);
  }

  {
    const state = createState({ pricing: "v1" });
    const response = await invoke(file, state, body, buildMocks);
    assert.equal(response.status, 200, `${label}: v1 response`);
    assertBypassEnvelope(state, state.config);
    assert.equal(state.settlements, 1);
  }

  {
    const state = createState({ pricing: "byok" });
    const response = await invoke(file, state, byokBody(body), buildMocks);
    assert.equal(response.status, 200, `${label}: byok response`);
    assertBypassEnvelope(state, state.byokConfig);
    assert.equal(state.settlements, 1);
  }

  {
    const state = createState({ behavior: "throw" });
    const response = await invoke(file, state, body, buildMocks);
    assert.equal(response.status, 500, `${label}: rejection response`);
    const payload = await jsonOf(response);
    assert.equal(JSON.stringify(payload).includes(SECRET), false);
    assert.equal(state.failure, 1);
    assertFailureBeforeRefund(state, `${label} provider rejection`);
  }

  {
    const state = createState({ settleFails: true });
    const response = await invoke(file, state, body, buildMocks);
    assert.equal(response.status, 500, `${label}: settle failure response`);
    assert.equal(state.succeeded, 1);
    assert.equal(state.failure, 0, `${label}: settle failure after success`);
    assert.equal(state.refunds.length, 1);
  }
}

async function testDirectEngineRoutes(): Promise<void> {
  await testDirectEngineRoute({
    file: routes.classifyFreeform,
    operation: "story.classify-freeform",
    body: {
      session: { history: [], characters: [] },
      freeformText: "open the door",
    },
    buildMocks: (state) =>
      directMocks(state, "@infiplot/engine", "classifyFreeform", {
        classify: "insert-beat",
        freeformAction: "act",
      }),
    label: "classify-freeform",
  });

  await testDirectEngineRoute({
    file: routes.insertBeat,
    operation: "story.insert-beat",
    body: {
      session: { history: [], characters: [], worldSetting: "world" },
      freeformAction: "act",
    },
    buildMocks: (state) =>
      directMocks(state, "@infiplot/engine", "requestInsertBeat", {
        characters: [{ name: "Lin", voice: { id: "v" } }],
        partial: { narration: "n" },
      }),
    label: "insert-beat",
  });

  await testDirectEngineRoute({
    file: routes.vision,
    operation: "vision.decide",
    body: {
      session: { history: [], characters: [] },
      annotatedImageBase64: "abc",
    },
    buildMocks: (state) =>
      directMocks(state, "@infiplot/engine", "visionDecide", {
        decision: "advance",
      }),
    label: "vision",
  });
}

// ---------------------------------------------------------------------------
// parse-style-image
// ---------------------------------------------------------------------------

async function testParseStyleImage(): Promise<void> {
  const body = { imageDataUrl: "data:image/png;base64,AAAA" };

  {
    const state = createState();
    const response = await invoke(
      routes.parseStyleImage,
      state,
      body,
      parseStyleImageMocks,
    );
    assert.equal(response.status, 200);
    const payload = await jsonOf(response);
    assert.equal(payload.stylePrompt, "watercolor");
    assertV2Envelope(state, "vision.style-parse", state.config.vision);
    assert.equal(state.settlements, 1);
  }

  {
    const state = createState({ envelopeThrowsAfterCallback: true });
    const response = await invoke(
      routes.parseStyleImage,
      state,
      body,
      parseStyleImageMocks,
    );
    assert.equal(response.status, 500);
    assert.equal(state.envelopeCalls.length, 1);
    assert.equal(state.started, 1);
    assert.equal(state.succeeded, 0);
    assert.equal(state.failure, 1);
    assertFailureBeforeRefund(state, "parse-style-image envelope post-callback rejection");
    assert.equal(state.refunds.length, 1);
  }

  {
    const state = createState({ succeededThrows: true });
    const response = await invoke(
      routes.parseStyleImage,
      state,
      body,
      parseStyleImageMocks,
    );
    assert.equal(response.status, 500);
    assert.equal(state.succeeded, 1);
    assert.equal(
      state.failure,
      0,
      "success-marker throw after a completed envelope must not mark failure",
    );
    assert.equal(state.refunds.length, 1);
  }

  {
    const state = createState({ pricing: "v1" });
    const response = await invoke(
      routes.parseStyleImage,
      state,
      body,
      parseStyleImageMocks,
    );
    assert.equal(response.status, 200);
    assertBypassEnvelope(state, state.config.vision);
    assert.equal(state.settlements, 1);
  }

  {
    const state = createState({ behavior: "throw" });
    const response = await invoke(
      routes.parseStyleImage,
      state,
      body,
      parseStyleImageMocks,
    );
    assert.equal(response.status, 500);
    const payload = await jsonOf(response);
    assert.equal(JSON.stringify(payload).includes(SECRET), false);
    assert.equal(state.failure, 1);
    assertFailureBeforeRefund(state, "parse-style-image provider rejection");
  }

  {
    const state = createState({ settleFails: true });
    const response = await invoke(
      routes.parseStyleImage,
      state,
      body,
      parseStyleImageMocks,
    );
    assert.equal(response.status, 500);
    assert.equal(state.succeeded, 1);
    assert.equal(state.failure, 0, "settle failure after success is not a provider failure");
    assert.equal(state.refunds.length, 1);
  }

  {
    // v2: an empty style prompt is unusable. Failure proof and refund must
    // happen, and the credit must not settle.
    const state = createState({ behavior: "empty" });
    const response = await invoke(
      routes.parseStyleImage,
      state,
      body,
      parseStyleImageMocks,
    );
    assert.equal(response.status, 502);
    assert.equal(state.succeeded, 0, "v2 empty stylePrompt must not mark success");
    assert.equal(state.failure, 1, "v2 empty stylePrompt requires failure intent");
    assertFailureBeforeRefund(state, "parse-style-image v2 empty output");
    assert.equal(state.refunds.length, 1);
    assert.equal(state.settlements, 0, "v2 empty stylePrompt must not settle");
  }

  {
    // v2: a non-string style prompt is invalid, not usable.
    const state = createState({ behavior: "invalid" });
    const response = await invoke(
      routes.parseStyleImage,
      state,
      body,
      parseStyleImageMocks,
    );
    assert.equal(response.status, 502);
    assert.equal(state.succeeded, 0, "v2 invalid stylePrompt must not mark success");
    assert.equal(state.failure, 1);
    assertFailureBeforeRefund(state, "parse-style-image v2 invalid output");
    assert.equal(state.refunds.length, 1);
    assert.equal(state.settlements, 0);
  }

  {
    // legacy: success-before-parse and settle-before-502 stay unchanged.
    const state = createState({ behavior: "empty", pricing: "v1" });
    const response = await invoke(
      routes.parseStyleImage,
      state,
      body,
      parseStyleImageMocks,
    );
    assert.equal(response.status, 502);
    assert.equal(state.succeeded, 1, "legacy raw success mark stays before parse");
    assert.equal(state.failure, 0, "legacy empty output is not a failed delivery");
    assert.equal(state.settlements, 1, "legacy empty output still settles");
    assert.equal(state.refunds.length, 0);
  }

  {
    const state = createState({ invalidJson: true });
    const response = await invoke(
      routes.parseStyleImage,
      state,
      body,
      parseStyleImageMocks,
    );
    assert.equal(response.status, 400);
    assert.equal(state.prepares, 0);
    assert.equal(state.providerCalls, 0);
  }

  {
    const state = createState();
    const response = await invoke(
      routes.parseStyleImage,
      state,
      {},
      parseStyleImageMocks,
    );
    assert.equal(response.status, 400);
    assert.equal(state.prepares, 0);
    assert.equal(state.providerCalls, 0);
  }
}

// ---------------------------------------------------------------------------
// style-hot-swap (redraw + rewrite)
// ---------------------------------------------------------------------------

async function testStyleHotSwap(): Promise<void> {
  // redraw-current
  {
    const state = createState();
    const response = await invoke(
      routes.styleHotSwap,
      state,
      styleBody("redraw-current"),
      styleHotSwapMocks,
    );
    assert.equal(response.status, 200);
    const payload = await jsonOf(response);
    assert.equal(payload.status, "ready");
    assertV2Envelope(state, "style.redraw", state.config);
    assert.equal(state.settlements, 1);
  }

  {
    const state = createState({ envelopeThrowsAfterCallback: true });
    const response = await invoke(
      routes.styleHotSwap,
      state,
      styleBody("redraw-current"),
      styleHotSwapMocks,
    );
    assert.equal(response.status, 500);
    assert.equal(state.envelopeCalls.length, 1);
    assert.equal(state.started, 1);
    assert.equal(state.succeeded, 0);
    assert.equal(state.failure, 1);
    assertFailureBeforeRefund(state, "style redraw envelope post-callback rejection");
    assert.equal(state.refunds.length, 1);
  }

  {
    const state = createState({ succeededThrows: true });
    const response = await invoke(
      routes.styleHotSwap,
      state,
      styleBody("redraw-current"),
      styleHotSwapMocks,
    );
    assert.equal(response.status, 500);
    assert.equal(state.succeeded, 1);
    assert.equal(
      state.failure,
      0,
      "redraw success-marker throw must not mark failure",
    );
    assert.equal(state.refunds.length, 1);
  }

  {
    const state = createState({ pricing: "v1" });
    const response = await invoke(
      routes.styleHotSwap,
      state,
      styleBody("redraw-current"),
      styleHotSwapMocks,
    );
    assert.equal(response.status, 200);
    assertBypassEnvelope(state, state.config);
    assert.equal(state.settlements, 1);
  }

  {
    const state = createState({ cacheHit: true });
    const response = await invoke(
      routes.styleHotSwap,
      state,
      styleBody("redraw-current"),
      styleHotSwapMocks,
    );
    assert.equal(response.status, 200);
    const payload = await jsonOf(response);
    assert.equal(payload.cacheStatus, "hit");
    assert.equal(state.prepares, 0, "redraw cache preflight must precede reserve");
    assert.equal(state.envelopeCalls.length, 0);
    assert.equal(state.providerCalls, 0);
  }

  {
    const state = createState({ innerCacheHit: true });
    const response = await invoke(
      routes.styleHotSwap,
      state,
      styleBody("redraw-current"),
      styleHotSwapMocks,
    );
    assert.equal(response.status, 200);
    const payload = await jsonOf(response);
    assert.equal(payload.cacheStatus, "hit");
    assert.equal(state.envelopeCalls.length, 0, "inner redraw cache hit bypasses envelope");
    assert.equal(state.providerCalls, 0, "inner redraw cache hit bypasses provider");
    assert.equal(state.failure, 0);
    assert.equal(state.refunds.length, 1);
    assert.deepEqual(state.refunds[0]!.options, { providerNotStarted: true });
  }

  {
    const state = createState({ behavior: "mock" });
    const response = await invoke(
      routes.styleHotSwap,
      state,
      styleBody("redraw-current"),
      styleHotSwapMocks,
    );
    assert.equal(response.status, 202);
    assert.equal(state.providerCalls, 1);
    assert.equal(state.failure, 1, "mock redraw is explicit failed delivery");
    assert.equal(state.succeeded, 0, "mock redraw must not mark success");
    assertFailureBeforeRefund(state, "style mock redraw");
  }

  {
    const state = createState({ behavior: "throw" });
    const response = await invoke(
      routes.styleHotSwap,
      state,
      styleBody("redraw-current"),
      styleHotSwapMocks,
    );
    assert.equal(response.status, 500);
    const payload = await jsonOf(response);
    assert.equal(JSON.stringify(payload).includes(SECRET), false);
    assert.equal(state.failure, 1);
    assertFailureBeforeRefund(state, "style redraw provider rejection");
  }

  {
    const state = createState({ settleFails: true });
    const response = await invoke(
      routes.styleHotSwap,
      state,
      styleBody("redraw-current"),
      styleHotSwapMocks,
    );
    assert.equal(response.status, 500);
    assert.equal(state.succeeded, 1);
    assert.equal(state.failure, 0, "redraw settle failure after success");
    assert.equal(state.refunds.length, 1);
  }

  // rewrite-current
  {
    const state = createState();
    const response = await invoke(
      routes.styleHotSwap,
      state,
      styleBody("rewrite-current"),
      styleHotSwapMocks,
    );
    assert.equal(response.status, 200);
    const payload = await jsonOf(response);
    assert.equal(payload.status, "ready");
    assertV2Envelope(state, "style.rewrite", state.config.text);
    assert.equal(state.settlements, 1);
  }

  {
    const state = createState({ envelopeThrowsAfterCallback: true });
    const response = await invoke(
      routes.styleHotSwap,
      state,
      styleBody("rewrite-current"),
      styleHotSwapMocks,
    );
    assert.equal(response.status, 500);
    assert.equal(state.envelopeCalls.length, 1);
    assert.equal(state.started, 1);
    assert.equal(state.succeeded, 0);
    assert.equal(state.failure, 1);
    assertFailureBeforeRefund(state, "style rewrite envelope post-callback rejection");
    assert.equal(state.refunds.length, 1);
  }

  {
    const state = createState({ succeededThrows: true });
    const response = await invoke(
      routes.styleHotSwap,
      state,
      styleBody("rewrite-current"),
      styleHotSwapMocks,
    );
    assert.equal(response.status, 500);
    assert.equal(state.succeeded, 1);
    assert.equal(
      state.failure,
      0,
      "rewrite success-marker throw must not mark failure",
    );
    assert.equal(state.refunds.length, 1);
  }

  {
    const state = createState({ pricing: "v1" });
    const response = await invoke(
      routes.styleHotSwap,
      state,
      styleBody("rewrite-current"),
      styleHotSwapMocks,
    );
    assert.equal(response.status, 200);
    assertBypassEnvelope(state, state.config.text);
    assert.equal(state.settlements, 1);
  }

  {
    const state = createState({ cacheHit: true });
    const response = await invoke(
      routes.styleHotSwap,
      state,
      styleBody("rewrite-current"),
      styleHotSwapMocks,
    );
    assert.equal(response.status, 200);
    const payload = await jsonOf(response);
    assert.equal(payload.cacheStatus, "hit");
    assert.equal(state.prepares, 0, "rewrite cache preflight must precede reserve");
    assert.equal(state.envelopeCalls.length, 0);
    assert.equal(state.providerCalls, 0);
  }

  {
    const state = createState({ innerCacheHit: true });
    const response = await invoke(
      routes.styleHotSwap,
      state,
      styleBody("rewrite-current"),
      styleHotSwapMocks,
    );
    assert.equal(response.status, 200);
    const payload = await jsonOf(response);
    assert.equal(payload.cacheStatus, "hit");
    assert.equal(state.envelopeCalls.length, 0, "inner rewrite cache hit bypasses envelope");
    assert.equal(state.providerCalls, 0, "inner rewrite cache hit bypasses provider");
    assert.equal(state.failure, 0);
    assert.equal(state.refunds.length, 1);
    assert.deepEqual(state.refunds[0]!.options, { providerNotStarted: true });
  }

  {
    const state = createState({ behavior: "throw" });
    const response = await invoke(
      routes.styleHotSwap,
      state,
      styleBody("rewrite-current"),
      styleHotSwapMocks,
    );
    assert.equal(response.status, 500);
    const payload = await jsonOf(response);
    assert.equal(JSON.stringify(payload).includes(SECRET), false);
    assert.equal(state.failure, 1);
    assertFailureBeforeRefund(state, "style rewrite provider rejection");
  }

  {
    const state = createState({ settleFails: true });
    const response = await invoke(
      routes.styleHotSwap,
      state,
      styleBody("rewrite-current"),
      styleHotSwapMocks,
    );
    assert.equal(response.status, 500);
    assert.equal(state.succeeded, 1);
    assert.equal(state.failure, 0, "rewrite settle failure after success");
    assert.equal(state.refunds.length, 1);
  }

  {
    // v2: a parse exception is unusable output; it must not succeed, settle or
    // be cached, and failure proof must precede the refund.
    const state = createState({ parseThrows: true });
    const response = await invoke(
      routes.styleHotSwap,
      state,
      styleBody("rewrite-current"),
      styleHotSwapMocks,
    );
    assert.equal(response.status, 500);
    assert.equal(state.succeeded, 0, "v2 rewrite parse failure must not mark success");
    assert.equal(state.failure, 1);
    assertFailureBeforeRefund(state, "style rewrite v2 parse failure");
    assert.equal(state.refunds.length, 1);
    assert.equal(state.settlements, 0, "v2 rewrite parse failure must not settle");
    assert.equal(state.cacheWrites, 0, "unusable v2 rewrite must not be cached");
  }

  {
    // legacy: success-before-parse stays; the broad catch refunds.
    const state = createState({ parseThrows: true, pricing: "v1" });
    const response = await invoke(
      routes.styleHotSwap,
      state,
      styleBody("rewrite-current"),
      styleHotSwapMocks,
    );
    assert.equal(response.status, 500);
    assert.equal(state.succeeded, 1, "legacy rewrite success mark stays before parse");
    assert.equal(state.failure, 0);
    assert.equal(state.refunds.length, 1);
    assert.equal(state.cacheWrites, 0);
  }

  for (const behavior of [
    "nonmatching",
    "unchanged",
    "whitespace",
    "malformed",
  ] as const) {
    {
      // v2: malformed / no-matching-canonical / same-value / whitespace-only
      // output is unusable and must never be cached or settled.
      const state = createState({ behavior });
      const response = await invoke(
        routes.styleHotSwap,
        state,
        styleBody("rewrite-current"),
        styleHotSwapMocks,
      );
      assert.equal(response.status, 500, `v2 rewrite ${behavior} response`);
      const payload = await jsonOf(response);
      assert.equal(JSON.stringify(payload).includes(SECRET), false);
      assert.equal(
        state.succeeded,
        0,
        `v2 rewrite ${behavior} must not mark success`,
      );
      assert.equal(
        state.failure,
        1,
        `v2 rewrite ${behavior} requires failure intent`,
      );
      assertFailureBeforeRefund(state, `style rewrite v2 ${behavior}`);
      assert.equal(state.refunds.length, 1);
      assert.equal(
        state.settlements,
        0,
        `v2 rewrite ${behavior} must not settle`,
      );
      assert.equal(
        state.cacheWrites,
        0,
        `v2 rewrite ${behavior} must not be cached`,
      );
    }
  }

  for (const behavior of ["nonmatching", "unchanged", "whitespace"] as const) {
    {
      // legacy: unusable-but-successful output still settles and is cached.
      const state = createState({ behavior, pricing: "v1" });
      const response = await invoke(
        routes.styleHotSwap,
        state,
        styleBody("rewrite-current"),
        styleHotSwapMocks,
      );
      assert.equal(response.status, 200, `legacy rewrite ${behavior} response`);
      assert.equal(state.succeeded, 1);
      assert.equal(state.failure, 0);
      assert.equal(state.refunds.length, 0);
      assert.equal(state.settlements, 1);
      assert.equal(state.cacheWrites, 1, `legacy rewrite ${behavior} cached`);
    }
  }

  {
    // legacy malformed field types still flow through the legacy parser and
    // fail only when the real rewrite helper rejects them (broad catch).
    const state = createState({ behavior: "malformed", pricing: "v1" });
    const response = await invoke(
      routes.styleHotSwap,
      state,
      styleBody("rewrite-current"),
      styleHotSwapMocks,
    );
    assert.equal(response.status, 500);
    assert.equal(state.succeeded, 1, "legacy success mark still precedes parse");
    assert.equal(state.failure, 0);
    assert.equal(state.refunds.length, 1);
    assert.equal(state.cacheWrites, 0);
  }

  {
    // Counterexample for the last-wins Map in applyExpressionRewrite: a changed
    // duplicate followed by the original prose is still an unchanged result.
    // v2 must reject duplicate ids, so this unusable output cannot settle or
    // be written into the rewrite cache.
    const state = createState({ behavior: "duplicate" });
    const response = await invoke(
      routes.styleHotSwap,
      state,
      styleBody("rewrite-current"),
      styleHotSwapMocks,
    );
    assert.equal(response.status, 500);
    const payload = await jsonOf(response);
    assert.equal(JSON.stringify(payload).includes(SECRET), false);
    assert.equal(
      state.succeeded,
      0,
      "v2 duplicate-id last-wins rewrite must not mark success",
    );
    assert.equal(
      state.failure,
      1,
      "v2 duplicate-id last-wins rewrite requires failure intent",
    );
    assertFailureBeforeRefund(state, "style rewrite v2 duplicate-id last-wins");
    assert.equal(state.refunds.length, 1);
    assert.equal(
      state.settlements,
      0,
      "v2 duplicate-id last-wins rewrite must not settle",
    );
    assert.equal(
      state.cacheWrites,
      0,
      "v2 duplicate-id last-wins rewrite must not be cached",
    );
  }

  {
    // Legacy keeps the historical last-wins rewrite path and still settles and
    // caches the unchanged delivered beats.
    const state = createState({ behavior: "duplicate", pricing: "v1" });
    const response = await invoke(
      routes.styleHotSwap,
      state,
      styleBody("rewrite-current"),
      styleHotSwapMocks,
    );
    assert.equal(response.status, 200);
    const payload = await jsonOf(response);
    const beats = payload.beats as Array<{ id: string; narration?: string }>;
    assert.equal(
      beats[0]?.narration,
      "n",
      "legacy duplicate ids still resolve last-wins to the original prose",
    );
    assert.equal(state.succeeded, 1);
    assert.equal(state.failure, 0);
    assert.equal(state.settlements, 1);
    assert.equal(state.cacheWrites, 1, "legacy duplicate-id rewrite is cached");
  }

  {
    const state = createState({ invalidJson: true });
    const response = await invoke(
      routes.styleHotSwap,
      state,
      styleBody("rewrite-current"),
      styleHotSwapMocks,
    );
    assert.equal(response.status, 400);
    assert.equal(state.prepares, 0);
    assert.equal(state.providerCalls, 0);
  }

  {
    const state = createState();
    const response = await invoke(
      routes.styleHotSwap,
      state,
      {},
      styleHotSwapMocks,
    );
    assert.equal(response.status, 400);
    assert.equal(state.prepares, 0);
    assert.equal(state.providerCalls, 0);
  }
}

// ---------------------------------------------------------------------------
// Source-shaped regression guards (complement the executable scenarios)
// ---------------------------------------------------------------------------

function countOccurrences(source: string, needle: string): number {
  let count = 0;
  let index = 0;
  while (index < source.length) {
    const found = source.indexOf(needle, index);
    if (found < 0) break;
    count += 1;
    index = found + needle.length;
  }
  return count;
}

function assertSourceBoundaries(): void {
  const predicate =
    'billing.reservation?.catalogEntry.pricingMode === "cost_beta_credit_v2"';
  const operations: Array<[string, string[]]> = [
    [routes.beatAudio, ["tts.beat"]],
    [routes.characterNames, ["text.character-names"]],
    [routes.classifyFreeform, ["story.classify-freeform"]],
    [routes.insertBeat, ["story.insert-beat"]],
    [routes.parseStyleImage, ["vision.style-parse"]],
    [routes.vision, ["vision.decide"]],
    [routes.styleHotSwap, ["style.redraw", "style.rewrite"]],
  ];

  for (const [file, expectedOperations] of operations) {
    const source = readRoute(file);
    assert.equal(
      countOccurrences(source, predicate),
      expectedOperations.length,
      `${file}: exact v2 predicate per generation branch`,
    );
    for (const operation of expectedOperations) {
      assert.ok(
        source.includes(`runInCostEnvelope(config, "${operation}"`),
        `${file}: envelope must use the ${operation} operation`,
      );
    }
    assert.ok(
      source.includes("markGenerationBillingOperationFailed("),
      `${file}: failed-delivery intent helper must be wired`,
    );
    assert.equal(
      (source.match(/export\s+(?:async\s+)?function\s+/g) ?? []).length,
      1,
      `${file}: only the route POST handler may be exported`,
    );
  }

  assert.equal(
    countOccurrences(readRoute(routes.characterNames), "await chat("),
    1,
    "character-names must keep exactly one literal provider call",
  );
  const styleSource = readRoute(routes.styleHotSwap);
  assert.equal(
    countOccurrences(styleSource, "await chat("),
    1,
    "style-hot-swap rewrite must keep exactly one literal provider call",
  );
  assert.equal(
    countOccurrences(styleSource, "runPainter("),
    1,
    "style-hot-swap redraw must keep exactly one literal provider call",
  );
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

assertSourceBoundaries();
await testBeatAudio();
await testCharacterNames();
await testDirectEngineRoutes();
await testParseStyleImage();
await testStyleHotSwap();

console.log("cost envelope route boundary tests passed");
