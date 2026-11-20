/**
 * Cost-envelope boundary tests for the two scene-producing routes:
 *
 *   app/api/start/route.ts
 *   app/api/scene/route.ts
 *
 * Zero network / zero provider / zero database. Each route is loaded from its
 * real source, transpiled to CommonJS with the repository TypeScript compiler,
 * and executed against a hand-written module registry. Only the pinned billing
 * APIs, engine clients, caches, guards, speculative-branch helpers and config
 * loaders are mocked.
 *
 * Both the JSON (POST JSON body) and SSE (drained `text/event-stream`) paths are
 * exercised, because the SSE path runs its generation work inside a
 * ReadableStream background callback that only starts when the response body is
 * read.
 *
 * The `clientTts` regressions additionally build the REAL exact v2 pricing
 * candidate from the authorized live runtime bindings and run the real
 * `costBetaRuntimeBindingForOperation` check inside the mocked billing gate.
 * That reproduces the production failure where stripping `config.tts` changed
 * the story.start runtime-binding hash and failed closed before reserve.
 *
 * Run with the repository script runner (tsx), e.g.:
 *   cross-env NODE_OPTIONS=--conditions=react-server \
 *     pnpm exec tsx scripts/test-cost-envelope-scene-routes.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { NextResponse } from "next/server";
import ts from "typescript";

import {
  buildCostBetaPricingCandidate,
  costBetaRuntimeBindingForOperation,
  type CostBetaPricingCandidate,
} from "../lib/billing/costBetaPricing";
import type { FixedBetaRuntimeConfig } from "../lib/billing/fixedBetaPricing";
import type { PlatformOperation } from "../lib/billing/platformCostEnvelope";
import {
  assertPlatformRuntimeConfig,
  PLATFORM_LIVE_PROVIDER_BINDINGS,
} from "../lib/billing/platformCostEnvelopeServer";

const root = process.cwd();
const SECRET = "RAW_PROVIDER_SECRET_7c1";
const CACHE_SECRET = "CACHE_PREP_SECRET_2d9";
const ENVELOPE_SECRET = "ENVELOPE_CAP_SECRET_4a2";
const SETTLE_SECRET = "DB_SETTLE_SECRET_8e5";

const ROUTE_FILES = {
  start: "app/api/start/route.ts",
  scene: "app/api/scene/route.ts",
} as const;

type RouteName = keyof typeof ROUTE_FILES;
type Pricing = "v2" | "v1" | "byok";
type Behavior = "success" | "throw" | "placeholder";

type CharacterFixture = {
  name: string;
  voiceDescription: string;
  voice?: {
    provider: "stepfun";
    voiceId: string;
    model: string;
    mimeType: string;
  };
};

type BeatNextFixture =
  | { type: "continue"; nextBeatId: string }
  | {
      type: "choice";
      choices: Array<{
        id: string;
        label: string;
        effect:
          | { kind: "advance-beat"; targetBeatId: string }
          | { kind: "change-scene"; nextSceneSeed: string };
      }>;
    };

type BeatFixture = {
  id: string;
  speaker?: string;
  narration?: string;
  line?: string;
  next: BeatNextFixture;
};

type SceneFixture = {
  id: string;
  scenePrompt: string;
  sceneKey?: string;
  entryBeatId: string;
  imageUuid?: string;
  imageUrl: string;
  beats: BeatFixture[];
};

type GeneratedResponse = {
  scene: SceneFixture;
  imageUrl: string;
  characters: CharacterFixture[];
  storyState: Record<string, string>;
  sessionId?: string;
};

type EnvelopeCall = {
  config: unknown;
  operation: string;
};

type PrepareInput = {
  operation: string;
  hasByok: boolean;
  runtimeConfig: unknown;
};

type RefundRecord = {
  reason: string;
  options?: unknown;
  outcome: string;
};

type BillingContext = {
  mode: "user_byok" | "platform_managed";
  reservation?: {
    id: string;
    catalogEntry: { pricingMode: string };
  };
  providerOutcome?: "not_started" | "outcome_unknown" | "succeeded";
};

type State = {
  route: RouteName;
  config: Record<string, unknown>;
  byokConfig: Record<string, unknown>;
  pricing: Pricing;
  behavior: Behavior;
  replay: boolean;
  preflightCached: GeneratedResponse | null;
  cacheFails: boolean;
  settleFails: boolean;
  envelopeThrowsAfterCallback: boolean;

  /** When set, the mocked billing gate re-runs the REAL v2 runtime-binding check. */
  v2Candidate?: CostBetaPricingCandidate;
  reservations: number;
  pricingRejections: number;
  /** Exact config objects handed to the engine (must be TTS-suppressed on clientTts). */
  engineConfigs: unknown[];
  /** Incremented whenever the engine is handed a config that still has TTS. */
  engineTtsCalls: number;

  prepareInputs: PrepareInput[];
  prepares: number;
  replayRejections: number;

  providerCalls: number;
  providerConfig: unknown;
  envelopeCalls: EnvelopeCall[];
  envelopeActive: boolean;
  envelopeActiveAtProvider: boolean;
  envelopeActiveAtValidation: boolean;
  envelopeCompleted: number;

  validationCalls: number;
  cacheCalls: number;
  cacheLabels: string[];
  peekCalls: number;
  speculativeWraps: number;
  observedEvents: Record<string, unknown>[];

  started: number;
  succeeded: number;
  failure: number;
  failureIntent: boolean;
  settleCalls: number;
  settleOutcomes: string[];
  refundCalls: RefundRecord[];
  refundOutcomes: string[];
  order: string[];
};

type MockModules = Record<string, unknown>;

function createState(overrides: Partial<State> = {}): State {
  const config = {
    text: { model: "platform-text", baseUrl: "https://text.invalid" },
    vision: { model: "platform-vision", baseUrl: "https://vision.invalid" },
    image: { model: "platform-image", baseUrl: "https://image.invalid" },
    tts: { speechModel: "platform-tts", baseUrl: "https://tts.invalid" },
  };
  const byokConfig = {
    text: { model: "byok-text", baseUrl: "https://byok.invalid" },
    vision: { model: "byok-vision", baseUrl: "https://byok.invalid" },
    image: { model: "byok-image", baseUrl: "https://byok.invalid" },
  };
  return {
    route: "start",
    config,
    byokConfig,
    pricing: "v2",
    behavior: "success",
    replay: false,
    preflightCached: null,
    cacheFails: false,
    settleFails: false,
    envelopeThrowsAfterCallback: false,
    v2Candidate: undefined,
    reservations: 0,
    pricingRejections: 0,
    engineConfigs: [],
    engineTtsCalls: 0,
    prepareInputs: [],
    prepares: 0,
    replayRejections: 0,
    providerCalls: 0,
    providerConfig: undefined,
    envelopeCalls: [],
    envelopeActive: false,
    envelopeActiveAtProvider: false,
    envelopeActiveAtValidation: false,
    envelopeCompleted: 0,
    validationCalls: 0,
    cacheCalls: 0,
    cacheLabels: [],
    peekCalls: 0,
    speculativeWraps: 0,
    observedEvents: [],
    started: 0,
    succeeded: 0,
    failure: 0,
    failureIntent: false,
    settleCalls: 0,
    settleOutcomes: [],
    refundCalls: [],
    refundOutcomes: [],
    order: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Exact v2 candidate + trusted full runtime bindings.
//
// The live host bindings are the authorized non-secret runtime confirmed for
// this deployment. Building the candidate here (rather than hardcoding a hash)
// means the route regression exercises the SAME runtime-binding identity the
// pricing gate computes from the full text/image/vision/TTS role set.
// ---------------------------------------------------------------------------

function liveRuntimeConfig(): FixedBetaRuntimeConfig {
  const bindings = PLATFORM_LIVE_PROVIDER_BINDINGS;
  return {
    text: { ...bindings.text, apiKey: "test-key" },
    image: { ...bindings.image, apiKey: "test-key" },
    vision: { ...bindings.vision, apiKey: "test-key" },
    tts: {
      provider: bindings.tts.provider,
      speechModel: bindings.tts.model,
      baseUrl: bindings.tts.baseUrl,
      apiKey: "test-key",
    },
    mockImage: false,
  };
}

const EXACT_V2_CANDIDATE = buildCostBetaPricingCandidate(
  liveRuntimeConfig(),
  "beta",
);

function v2Entry(operation: PlatformOperation) {
  const found = EXACT_V2_CANDIDATE.policy.entries.find(
    (entry) => entry.operation === operation,
  );
  assert.ok(found, `exact v2 candidate is missing ${operation}`);
  return found;
}

// ---------------------------------------------------------------------------
// Controlled generated core: a real Scene + Beat graph with a real image UUID.
// ---------------------------------------------------------------------------

function buildScene(withImageUuid: boolean): SceneFixture {
  const scene: SceneFixture = {
    id: "scene-live-1",
    scenePrompt: "Rain-soaked rooftop at dusk, neon reflecting in puddles.",
    sceneKey: "rooftop-night",
    entryBeatId: "beat-1",
    imageUrl: "https://cdn.aistory.test/scenes/rooftop-night.png",
    beats: [
      {
        id: "beat-1",
        speaker: "Lin",
        line: "You're late.",
        next: { type: "continue", nextBeatId: "beat-2" },
      },
      {
        id: "beat-2",
        narration: "Rain needles the rooftop. Lin does not turn around.",
        next: {
          type: "choice",
          choices: [
            {
              id: "choice-leave",
              label: "Walk into the rain",
              effect: { kind: "change-scene", nextSceneSeed: "rainy alley" },
            },
          ],
        },
      },
    ],
  };
  if (withImageUuid) scene.imageUuid = "runware-image-uuid-real-1";
  return scene;
}

function generatedResponse(state: State): GeneratedResponse {
  const scene = buildScene(state.behavior !== "placeholder");
  const characters: CharacterFixture[] = [
    {
      name: "Lin",
      voiceDescription: "female, calm, low timbre",
      voice: {
        provider: "stepfun",
        voiceId: "lin-voice",
        model: "step-tts-2",
        mimeType: "audio/mpeg",
      },
    },
    {
      name: "Mei",
      voiceDescription: "female, bright, quick",
      voice: {
        provider: "stepfun",
        voiceId: "mei-voice",
        model: "step-tts-2",
        mimeType: "audio/mpeg",
      },
    },
  ];
  const base = {
    scene,
    imageUrl: scene.imageUrl,
    characters,
    storyState: {
      logline: "A rooftop confession interrupted by rain.",
      genreTags: "urban / slow-burn",
      protagonist: "You, a courier with one last delivery.",
      synopsis: "Lin waits on the roof with a secret.",
    },
  };
  if (state.route === "start") {
    return { sessionId: "s_live_generated_1", ...base };
  }
  return base;
}

// ---------------------------------------------------------------------------
// Mocked core-delivery validation (mirrors the real essential-core contract).
// ---------------------------------------------------------------------------

class CoreDeliveryError extends Error {
  readonly code = "COST_BETA_GENERATION_NOT_DELIVERED";

  constructor(message = "generated core rejected") {
    super(message);
    this.name = "CoreDeliveryError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function usableText(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function parseBeatNext(
  value: unknown,
  beatIds: ReadonlySet<string>,
): { targets: string[]; changeScene: boolean } | null {
  if (!isRecord(value)) return null;
  if (value.type === "continue") {
    return typeof value.nextBeatId === "string" && beatIds.has(value.nextBeatId)
      ? { targets: [value.nextBeatId], changeScene: false }
      : null;
  }
  if (value.type === "choice") {
    if (!Array.isArray(value.choices) || value.choices.length === 0) return null;
    const targets: string[] = [];
    const choiceIds = new Set<string>();
    let changeScene = false;
    for (const choice of value.choices) {
      if (
        !isRecord(choice)
        || !usableText(choice.id)
        || !usableText(choice.label)
        || choiceIds.has(choice.id as string)
      ) return null;
      choiceIds.add(choice.id as string);
      const effect = choice.effect;
      if (!isRecord(effect)) return null;
      if (effect.kind === "change-scene") {
        if (!usableText(effect.nextSceneSeed)) return null;
        changeScene = true;
      } else if (effect.kind === "advance-beat") {
        if (
          typeof effect.targetBeatId !== "string"
          || !beatIds.has(effect.targetBeatId)
        ) return null;
        targets.push(effect.targetBeatId);
      } else {
        return null;
      }
    }
    return { targets, changeScene };
  }
  return null;
}

function assertCoreShape(value: unknown): void {
  if (!isRecord(value)) throw new CoreDeliveryError();
  const scene = value.scene;
  if (!isRecord(scene)) throw new CoreDeliveryError();

  if (!usableText(scene.imageUuid)) throw new CoreDeliveryError();
  if (!usableText(scene.imageUrl)) throw new CoreDeliveryError();

  const beats = scene.beats;
  if (!Array.isArray(beats) || beats.length === 0) throw new CoreDeliveryError();

  const beatIds = new Set<string>();
  for (const beat of beats) {
    if (!isRecord(beat) || !usableText(beat.id)) throw new CoreDeliveryError();
    if (beatIds.has(beat.id as string)) throw new CoreDeliveryError();
    beatIds.add(beat.id as string);
    if (!usableText(beat.narration) && !usableText(beat.line)) {
      throw new CoreDeliveryError();
    }
  }

  if (
    typeof scene.entryBeatId !== "string"
    || !beatIds.has(scene.entryBeatId)
  ) throw new CoreDeliveryError();

  const nextById = new Map<string, { targets: string[]; changeScene: boolean }>();
  for (const beat of beats) {
    if (!isRecord(beat)) throw new CoreDeliveryError();
    const parsed = parseBeatNext(beat.next, beatIds);
    if (!parsed) throw new CoreDeliveryError();
    nextById.set(beat.id as string, parsed);
  }

  const pending: string[] = [scene.entryBeatId];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const beatId = pending.pop()!;
    if (visited.has(beatId)) continue;
    visited.add(beatId);
    const next = nextById.get(beatId);
    if (!next) continue;
    if (next.changeScene) return;
    pending.push(...next.targets);
  }
  throw new CoreDeliveryError();
}

// ---------------------------------------------------------------------------
// Module registry: every runtime import used by either route is mocked.
// ---------------------------------------------------------------------------

function routeMocks(state: State): MockModules {
  const PricingUnavailableError = class extends Error {
    readonly code = "PRICING_UNAVAILABLE";
    readonly status = 503;

    constructor(message = "pricing unavailable") {
      super(message);
      this.name = "PricingUnavailableError";
    }
  };

  function providerEntry(config: unknown): void {
    state.providerCalls += 1;
    state.providerConfig = config;
    state.engineConfigs.push(config);
    if (isRecord(config) && config.tts !== undefined) state.engineTtsCalls += 1;
    state.envelopeActiveAtProvider = state.envelopeActive;
    state.order.push("provider");
  }

  const engine = {
    startSession: async (
      config: unknown,
      _body: unknown,
      emit?: (event: Record<string, unknown>) => void,
    ): Promise<GeneratedResponse> => {
      providerEntry(config);
      if (state.behavior === "throw") throw new Error(SECRET);
      const result = generatedResponse(state);
      emit?.({ type: "background", imageUrl: result.imageUrl });
      return result;
    },
    requestScene: async (
      config: unknown,
      _body: unknown,
      emit?: (event: Record<string, unknown>) => void,
    ): Promise<GeneratedResponse> => {
      providerEntry(config);
      if (state.behavior === "throw") throw new Error(SECRET);
      const result = generatedResponse(state);
      emit?.({ type: "beat", beat: result.scene.beats[0] });
      return result;
    },
  };
  return {
    "next/server": { NextResponse },
    "@infiplot/engine": engine,
    // Erased type-only imports are stubbed so a future value import fails loudly
    // instead of reaching for a real package.
    "@infiplot/types": {},
    "@/lib/billing/platformCostEnvelope": {},
    "@/lib/config": {
      loadEngineConfig: () => state.config,
      buildByoEngineConfig: () => state.byokConfig,
    },
    "@/lib/credentials/serverPolicy": {
      assertCompleteByok: () => undefined,
      hasByokPayload: (byo: unknown) =>
        state.pricing === "byok" && byo !== null && byo !== undefined,
    },
    "@/lib/supabase/guard": {
      requireUser: async () => ({
        userId: "route-boundary-user",
        authType: "phone",
      }),
    },
    "@/lib/engine/mediaCache": {
      cacheApiResponseImage: async (generated: Record<string, unknown>) => {
        state.cacheCalls += 1;
        state.order.push("cache");
        if (state.cacheFails) throw new Error(CACHE_SECRET);
        return { ...generated, imageCachePrepared: true };
      },
    },
    "@/lib/engine/sceneCache": {
      startSceneCacheKey: () => ({ key: "start-key" }),
      nextSceneCacheKey: (_session: unknown, hasByo: boolean) => ({
        key: hasByo ? "scene-byok-key" : "scene-key",
      }),
      peekSceneCache: async () => {
        state.peekCalls += 1;
        return state.preflightCached;
      },
      withSceneCache: async (
        meta: { key: string },
        label: string,
        compute: () => Promise<Record<string, unknown>>,
        emit?: (event: Record<string, unknown>) => void,
      ) => {
        state.cacheLabels.push(label);
        emit?.({ type: "cache", status: "miss", key: meta.key });
        const value = await compute();
        return { ...value, cache: { status: "miss", key: meta.key } };
      },
    },
    "@/lib/engine/speculativeBranchCache": {
      rejectSpeculativeRequest: () => undefined,
      getSpeculativeBranchContext: (
        session: unknown,
        config: unknown,
        speculation: unknown,
      ) => ({ session, config, speculation }),
      withSpeculativeBranchCache: async (
        _context: unknown,
        fn: (observe: (event: Record<string, unknown>) => void) => Promise<Record<string, unknown>>,
      ) => {
        state.speculativeWraps += 1;
        const observe = (event: Record<string, unknown>) => {
          state.observedEvents.push(event);
        };
        return fn(observe);
      },
    },
    "@/lib/case-studies/schema": {
      isAuthoredAiContinuationAllowed: () => true,
    },
    // Static diagnostic import: the route's narrow failure path is not under
    // test here, so it is a side-effect-free no-op.
    "@/lib/engine/sceneFailureDiagnostic": {
      logSceneGenerationFailure: () => undefined,
    },
    "@/lib/billing/generationGate": {
      prepareGenerationBilling: async (input: {
        operation: string;
        hasByok: boolean;
        runtimeConfig?: unknown;
      }): Promise<BillingContext | NextResponse> => {
        if (state.replay) {
          state.replayRejections += 1;
          return NextResponse.json(
            {
              error: "该计费幂等请求已存在，未重复发起模型调用。",
              code: "BILLING_OPERATION_REPLAYED",
            },
            { status: 409 },
          );
        }
        state.prepares += 1;
        state.order.push("prepare");
        state.prepareInputs.push({
          operation: input.operation,
          hasByok: input.hasByok,
          runtimeConfig: input.runtimeConfig,
        });
        if (state.v2Candidate) {
          // Mirrors reservePlatformOperation -> quoteCostBetaOperation: the
          // exact v2 policy entry pins the runtime-binding hash computed from
          // the FULL trusted config. A stripped role set fails closed BEFORE
          // any reservation or provider call.
          try {
            assertPlatformRuntimeConfig(input.runtimeConfig);
            const operation = input.operation as PlatformOperation;
            const binding = costBetaRuntimeBindingForOperation(
              operation,
              input.runtimeConfig as FixedBetaRuntimeConfig,
            );
            const expected = state.v2Candidate.policy.entries.find(
              (entry) => entry.operation === operation,
            );
            if (
              !expected
              || binding.provider !== expected.provider
              || binding.model !== expected.model
            ) {
              throw new Error("runtime binding does not match the v2 candidate");
            }
          } catch {
            state.pricingRejections += 1;
            state.order.push("pricing-reject");
            return NextResponse.json(
              {
                error: "平台定价暂不可用，未发起任何模型调用。",
                code: "PLATFORM_PRICING_UNAVAILABLE",
              },
              { status: 503 },
            );
          }
        }
        if (state.pricing === "byok") return { mode: "user_byok" };
        state.reservations += 1;
        return {
          mode: "platform_managed",
          reservation: {
            id: "reservation-1",
            catalogEntry: {
              pricingMode: state.pricing === "v2"
                ? "cost_beta_credit_v2"
                : "fixed_beta_credit_v1",
            },
          },
          providerOutcome: "not_started",
        };
      },
      isCostBetaGenerationBilling: (context: BillingContext) =>
        context.reservation?.catalogEntry.pricingMode === "cost_beta_credit_v2",
      markGenerationBillingProviderStarted: (context: BillingContext) => {
        state.started += 1;
        state.order.push("started");
        if (
          context.reservation
          && context.providerOutcome === "not_started"
        ) {
          context.providerOutcome = "outcome_unknown";
        }
      },
      markGenerationBillingProviderSucceeded: (context: BillingContext) => {
        state.succeeded += 1;
        state.order.push("succeeded");
        if (context.reservation) context.providerOutcome = "succeeded";
      },
      markGenerationBillingOperationFailed: (context: BillingContext) => {
        if (!context.reservation) return;
        if (
          context.reservation.catalogEntry.pricingMode
          !== "cost_beta_credit_v2"
        ) return;
        if (context.providerOutcome === "succeeded") {
          throw new PricingUnavailableError("生成已成功，不能记录失败终态。");
        }
        state.failure += 1;
        state.failureIntent = true;
        state.order.push("failure");
      },
      settleGenerationBilling: async (context: BillingContext) => {
        state.settleCalls += 1;
        state.order.push("settle");
        if (state.settleFails) throw new Error(SETTLE_SECRET);
        let outcome = "settle";
        if (!context.reservation) outcome = "none";
        else if (context.providerOutcome !== "succeeded") outcome = "pending";
        state.settleOutcomes.push(outcome);
        return outcome;
      },
      refundGenerationBilling: async (
        context: BillingContext,
        reason: string,
        options?: unknown,
      ) => {
        state.order.push("refund");
        let outcome: string;
        if (!context.reservation) outcome = "none";
        else if (context.providerOutcome === "succeeded") outcome = "settle";
        else if (state.failureIntent) outcome = "refund";
        else if (context.providerOutcome !== "not_started") outcome = "pending";
        else outcome = "refund";
        state.refundCalls.push({ reason, options, outcome });
        state.refundOutcomes.push(outcome);
        return outcome;
      },
    },
    "@/lib/billing/generationDelivery": {
      assertCostBetaGeneratedCore: (value: unknown) => {
        state.validationCalls += 1;
        state.envelopeActiveAtValidation = state.envelopeActive;
        state.order.push("validate");
        assertCoreShape(value);
      },
    },
    "@/lib/billing/platformCostEnvelopeServer": {
      runInCostEnvelope: async <T>(
        config: unknown,
        operation: string,
        fn: () => Promise<T>,
      ): Promise<T> => {
        state.envelopeCalls.push({ config, operation });
        state.order.push("envelope");
        state.envelopeActive = true;
        try {
          const value = await fn();
          state.envelopeCompleted += 1;
          state.order.push("envelope-complete");
          if (state.envelopeThrowsAfterCallback) {
            state.order.push("envelope-reject");
            throw new Error(ENVELOPE_SECRET);
          }
          state.order.push("envelope-return");
          return value;
        } finally {
          state.envelopeActive = false;
        }
      },
    },
    "@/lib/billing/service": { PricingUnavailableError },
  };
}

// ---------------------------------------------------------------------------
// Real-route loading: source -> TypeScript CommonJS -> function + mock requires.
// ---------------------------------------------------------------------------

const sourceCache = new Map<string, string>();
const transpiledCache = new Map<string, string>();

function readRoute(file: string): string {
  const cached = sourceCache.get(file);
  if (cached !== undefined) return cached;
  const source = readFileSync(path.join(root, file), "utf8");
  sourceCache.set(file, source);
  return source;
}

function transpileRoute(file: string): string {
  const cached = transpiledCache.get(file);
  if (cached !== undefined) return cached;
  const transpiled = ts.transpileModule(readRoute(file), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: file,
  }).outputText;
  transpiledCache.set(file, transpiled);
  return transpiled;
}

function loadRoute(file: string, modules: MockModules): Record<string, unknown> {
  const routeModule = { exports: {} as Record<string, unknown> };
  const localRequire = (id: string) => {
    if (!(id in modules)) {
      throw new Error(
        `unmocked route dependency "${id}" required by ${file}; add it to routeMocks()`,
      );
    }
    return modules[id];
  };
  const factory = new Function(
    "require",
    "module",
    "exports",
    "__filename",
    "__dirname",
    transpileRoute(file),
  );
  const absolute = path.join(root, file);
  factory(
    localRequire,
    routeModule,
    routeModule.exports,
    absolute,
    path.dirname(absolute),
  );
  return routeModule.exports;
}

async function invokeRoute(
  state: State,
  body: Record<string, unknown>,
  sse: boolean,
): Promise<Response> {
  const file = ROUTE_FILES[state.route];
  const route = loadRoute(file, routeMocks(state));
  const handler = route.POST;
  assert.equal(typeof handler, "function", `${file} must export POST`);

  const headers = new Headers({
    "content-type": "application/json",
    "x-idempotency-key": `route-test-${state.route}-idempotency`,
  });
  if (sse) headers.set("accept", "text/event-stream");
  const request = new Request(`https://aistory.test/api/${state.route}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return (handler as (request: Request) => Promise<Response>)(request);
}

async function drainResponse(response: Response): Promise<string> {
  if (!response.body) throw new Error("SSE response has no body to drain");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

type SseEvent = {
  event?: string;
  data?: Record<string, unknown>;
};

function parseSse(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const block of text.split("\n\n")) {
    const lines = block.split("\n").filter((line) => line.length > 0);
    if (lines.length === 0) continue;
    const eventLine = lines.find((line) => line.startsWith("event: "));
    const dataLine = lines.find((line) => line.startsWith("data: "));
    events.push({
      event: eventLine?.slice("event: ".length),
      data: dataLine
        ? (JSON.parse(dataLine.slice("data: ".length)) as Record<string, unknown>)
        : undefined,
    });
  }
  return events;
}

async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function assertNoSecret(text: string): void {
  for (const secret of [SECRET, CACHE_SECRET, ENVELOPE_SECRET, SETTLE_SECRET]) {
    assert.equal(
      text.includes(secret),
      false,
      "route responses must never leak internal exception text",
    );
  }
}

function orderIndex(state: State, entry: string): number {
  return state.order.indexOf(entry);
}

function assertFailureIntentBeforeRefund(state: State, label: string): void {
  const failureIndex = orderIndex(state, "failure");
  const refundIndex = orderIndex(state, "refund");
  assert.ok(failureIndex >= 0, `${label}: failed-delivery intent must be recorded`);
  assert.ok(refundIndex >= 0, `${label}: refund helper must run`);
  assert.ok(
    failureIndex < refundIndex,
    `${label}: failed-delivery intent must precede the refund helper`,
  );
}

// ---------------------------------------------------------------------------
// Shared assertions
// ---------------------------------------------------------------------------

function assertV2Success(
  state: State,
  operation: string,
  providerConfig: unknown,
): void {
  assert.equal(state.envelopeCalls.length, 1, "v2 must wrap exactly once");
  assert.equal(state.envelopeCalls[0]!.operation, operation);
  assert.equal(state.envelopeCalls[0]!.config, state.config);
  assert.equal(state.prepares, 1);
  assert.equal(state.prepareInputs.length, 1);
  assert.equal(state.prepareInputs[0]!.operation, operation);
  assert.equal(state.prepareInputs[0]!.hasByok, false);
  assert.equal(state.prepareInputs[0]!.runtimeConfig, state.config);
  assert.equal(state.providerCalls, 1, "exactly one actual generation call");
  assert.equal(state.providerConfig, providerConfig);
  assert.equal(
    state.envelopeActiveAtProvider,
    true,
    "provider callback must run inside the envelope",
  );
  assert.equal(
    state.envelopeActiveAtValidation,
    true,
    "essential-core validation must run inside the envelope",
  );
  assert.equal(state.validationCalls, 1);
  assert.equal(state.cacheCalls, 1);
  assert.equal(state.started, 1);
  assert.equal(state.succeeded, 1);
  assert.equal(state.failure, 0);
  assert.equal(state.settleCalls, 1);
  assert.deepEqual(state.refundOutcomes, []);
  assert.equal(state.settleOutcomes.at(-1), "settle");

  assert.ok(
    orderIndex(state, "started") < orderIndex(state, "envelope"),
    "provider-started marker must precede the envelope callback",
  );
  assert.ok(
    orderIndex(state, "envelope") < orderIndex(state, "provider"),
    "generation must run inside the envelope",
  );
  assert.ok(
    orderIndex(state, "provider") < orderIndex(state, "validate"),
    "essential core must be validated after generation",
  );
  assert.ok(
    orderIndex(state, "validate") < orderIndex(state, "envelope-complete"),
    "validation must stay inside the envelope",
  );
  assert.ok(
    orderIndex(state, "envelope-complete") < orderIndex(state, "envelope-return"),
    "the envelope must complete before it returns",
  );
  assert.ok(
    orderIndex(state, "envelope-return") < orderIndex(state, "cache"),
    "image cache preparation must happen only after the envelope returns",
  );
  assert.ok(
    orderIndex(state, "cache") < orderIndex(state, "succeeded"),
    "success may be marked only after the image cache preparation",
  );
  assert.ok(
    orderIndex(state, "succeeded") < orderIndex(state, "settle"),
    "settlement must follow the success marker",
  );
}

function assertLegacyOrByokSuccess(state: State, providerConfig: unknown): void {
  assert.equal(state.envelopeCalls.length, 0, "legacy/BYOK must bypass the envelope");
  assert.equal(state.validationCalls, 0);
  assert.equal(state.prepares, 1);
  assert.equal(state.providerCalls, 1);
  assert.equal(state.providerConfig, providerConfig);
  assert.equal(state.envelopeActiveAtProvider, false);
  assert.equal(state.started, 1);
  assert.equal(state.succeeded, 1);
  assert.equal(state.failure, 0);
  assert.equal(state.cacheCalls, 1);
  assert.equal(state.settleCalls, 1);
  assert.ok(
    orderIndex(state, "provider") < orderIndex(state, "succeeded"),
    "provider must produce the result before success is marked",
  );
  assert.ok(
    orderIndex(state, "succeeded") < orderIndex(state, "cache"),
    "legacy/BYOK keep the original success-before-cache order",
  );
}

function assertPreflightCacheBypass(state: State): void {
  assert.equal(state.peekCalls, 1);
  assert.equal(state.prepares, 0, "cache preflight must precede reservation");
  assert.equal(state.providerCalls, 0);
  assert.equal(state.envelopeCalls.length, 0);
  assert.equal(state.validationCalls, 0);
  assert.equal(state.cacheCalls, 0);
  assert.equal(state.settleCalls, 0);
  assert.equal(state.refundCalls.length, 0);
}

function assertReplayBypass(
  state: State,
  response: Response,
  payload: Record<string, unknown>,
): void {
  assert.equal(response.status, 409);
  assert.equal(payload.code, "BILLING_OPERATION_REPLAYED");
  assert.equal(state.replayRejections, 1);
  assert.equal(state.providerCalls, 0, "replay rejection must never call a provider");
  assert.equal(state.envelopeCalls.length, 0);
  assert.equal(state.validationCalls, 0);
  assert.equal(state.cacheCalls, 0);
  assert.equal(state.settleCalls, 0);
  assert.equal(state.refundCalls.length, 0);
}

function assertRejectedGeneration(
  state: State,
  label: string,
  validated: boolean,
): void {
  assert.equal(state.envelopeCalls.length, 1);
  assert.equal(state.providerCalls, 1);
  assert.equal(state.started, 1);
  assert.equal(state.validationCalls, validated ? 1 : 0);
  assert.equal(state.succeeded, 0, `${label}: must never mark success`);
  assert.equal(state.failure, 1, `${label}: failed-delivery intent must be recorded`);
  assert.equal(state.cacheCalls, 0, `${label}: rejected core must never be cached`);
  assert.ok(state.refundOutcomes.length > 0, `${label}: refund helper must run`);
  assert.equal(state.refundOutcomes.at(-1), "refund");
  assertFailureIntentBeforeRefund(state, label);
}

function assertPendingImageCacheFailure(state: State): void {
  assert.equal(state.envelopeCalls.length, 1);
  assert.equal(state.providerCalls, 1);
  assert.equal(state.started, 1);
  assert.equal(state.validationCalls, 1);
  assert.equal(state.cacheCalls, 1, "image cache preparation was attempted");
  assert.equal(
    state.failure,
    0,
    "an image cache preparation failure is not a provider failure marker",
  );
  assert.equal(state.failureIntent, false);
  assert.equal(state.succeeded, 0);
  assert.equal(state.settleCalls, 0, "failed image cache prep must not settle");
  assert.ok(state.refundOutcomes.length > 0);
  for (const outcome of state.refundOutcomes) {
    assert.equal(
      outcome,
      "pending",
      "provider outcome remains unknown, so the operation stays pending",
    );
  }
}

function assertSettleFailureAfterSuccess(state: State): void {
  assert.equal(state.envelopeCalls.length, 1);
  assert.equal(state.providerCalls, 1);
  assert.equal(state.validationCalls, 1);
  assert.equal(state.cacheCalls, 1);
  assert.equal(state.succeeded, 1);
  assert.equal(
    state.failure,
    0,
    "a settlement write failure after success must not record a failure intent",
  );
  assert.equal(state.failureIntent, false);
  assert.equal(state.settleCalls, 1);
  assert.ok(state.refundOutcomes.length > 0, "outer refund helper may still run");
  assert.equal(state.refundOutcomes.at(-1), "settle");
  assert.ok(
    orderIndex(state, "settle") < orderIndex(state, "refund"),
    "refund helper runs only after the settlement attempt threw",
  );
}

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

function startBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    worldSetting: "A rain-soaked near-future city.",
    styleGuide: "Moody neo-noir watercolor.",
    credentialMode: "platform_managed",
    ...overrides,
  };
}

function sceneBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session: {
      id: "session-live-1",
      worldSetting: "A rain-soaked near-future city.",
      styleGuide: "Moody neo-noir watercolor.",
      history: [],
      characters: [
        {
          name: "Lin",
          voiceDescription: "female, calm, low timbre",
          voice: {
            provider: "stepfun",
            voiceId: "lin-voice",
            model: "step-tts-2",
            mimeType: "audio/mpeg",
          },
        },
      ],
    },
    credentialMode: "platform_managed",
    ...overrides,
  };
}

function byokBody(body: Record<string, unknown>): Record<string, unknown> {
  return {
    ...body,
    credentialMode: "user_byok",
    byo: {
      text: {
        provider: "openai_compatible",
        apiKey: "sk-test-only",
        model: "byok-model",
      },
    },
  };
}

function cachedStartResponse(): GeneratedResponse {
  return {
    ...generatedResponse(createState({ route: "start" })),
    sessionId: "s_cached_original",
    cache: { status: "hit", key: "start-key" },
  } as GeneratedResponse;
}

function cachedSceneResponse(): GeneratedResponse {
  return {
    ...generatedResponse(createState({ route: "scene" })),
    cache: { status: "hit", key: "scene-key" },
  } as GeneratedResponse;
}

// ---------------------------------------------------------------------------
// /api/start
// ---------------------------------------------------------------------------

async function testStartRoute(): Promise<void> {
  // Plain POST JSON, v2 platform-managed generation.
  {
    const state = createState({ route: "start" });
    const response = await invokeRoute(state, startBody(), false);
    assert.equal(response.status, 200);
    const payload = await jsonOf(response);
    const scene = payload.scene as SceneFixture;
    assert.equal(payload.sessionId, "s_live_generated_1");
    assert.equal(scene.imageUuid, "runware-image-uuid-real-1");
    assert.equal(scene.beats[0]!.line, "You're late.");
    assert.equal(scene.beats[1]!.narration?.includes("Rain needles"), true);
    assert.equal(state.cacheLabels[0], "api/start");
    const characters = payload.characters as CharacterFixture[];
    assert.ok(characters[0]!.voice, "start keeps generated voices");
    assert.equal(payload.imageCachePrepared, true);
    assertV2Success(state, "story.start", state.config);
    assertNoSecret(JSON.stringify(payload));
  }

  // SSE generation: the background stream callback only runs when drained.
  {
    const state = createState({ route: "start" });
    const response = await invokeRoute(state, startBody(), true);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    const text = await drainResponse(response);
    assertNoSecret(text);
    const events = parseSse(text);
    assert.ok(
      events.some((event) => event.event === "cache"),
      "scene cache diagnostics must stream",
    );
    assert.ok(
      events.some((event) => event.event === "background"),
      "engine stream events must be forwarded",
    );
    const done = events.find((event) => event.event === "done");
    assert.ok(done, "SSE must end with a done event");
    const doneResponse = done.data!.response as Record<string, unknown>;
    const doneScene = doneResponse.scene as SceneFixture;
    assert.equal(doneScene.imageUuid, "runware-image-uuid-real-1");
    assertV2Success(state, "story.start", state.config);
    assert.equal(state.settleCalls, 1);
  }

  // Legacy fixed-beta v1: original generate -> mark -> cache -> settle flow.
  {
    const state = createState({ route: "start", pricing: "v1" });
    const response = await invokeRoute(state, startBody(), false);
    assert.equal(response.status, 200);
    assertLegacyOrByokSuccess(state, state.config);
    assert.equal(state.settleOutcomes.at(-1), "settle");
    assert.equal(state.prepareInputs[0]!.operation, "story.start");
  }

  // BYOK: no reservation, no envelope, original behavior.
  {
    const state = createState({ route: "start", pricing: "byok" });
    const response = await invokeRoute(state, startBody(byokBody(startBody())), false);
    assert.equal(response.status, 200);
    assertLegacyOrByokSuccess(state, state.byokConfig);
    assert.equal(state.prepareInputs[0]!.hasByok, true);
    assert.equal(state.prepareInputs[0]!.runtimeConfig, state.byokConfig);
    assert.equal(state.settleOutcomes.at(-1), "none");
  }

  // Cache preflight: no reservation, no provider, no envelope.
  {
    const state = createState({
      route: "start",
      preflightCached: cachedStartResponse(),
    });
    const response = await invokeRoute(state, startBody(), false);
    assert.equal(response.status, 200);
    const payload = await jsonOf(response);
    assert.notEqual(payload.sessionId, "s_cached_original");
    assert.equal((payload.cache as Record<string, unknown>).status, "hit");
    assertPreflightCacheBypass(state);
  }

  // prepareGenerationBilling replay rejection: no provider work.
  {
    const state = createState({ route: "start", replay: true });
    const response = await invokeRoute(state, startBody(), false);
    const payload = await jsonOf(response);
    assertReplayBypass(state, response, payload);
    assertNoSecret(JSON.stringify(payload));
  }

  // Provider throw: failed intent, refund, never success/cache.
  {
    const state = createState({ route: "start", behavior: "throw" });
    const response = await invokeRoute(state, startBody(), false);
    assert.equal(response.status, 500);
    const payload = await jsonOf(response);
    assert.equal(payload.error, "Generation failed.");
    assertNoSecret(JSON.stringify(payload));
    assertRejectedGeneration(state, "start provider throw", false);
    assert.equal(state.envelopeCompleted, 0);
  }

  // Placeholder image (no real image UUID): core validation rejects it.
  {
    const state = createState({ route: "start", behavior: "placeholder" });
    const response = await invokeRoute(state, startBody(), false);
    assert.equal(response.status, 500);
    const payload = await jsonOf(response);
    assertNoSecret(JSON.stringify(payload));
    assertRejectedGeneration(state, "start placeholder", true);
  }

  // Sticky post-callback cap violation on the SSE path.
  {
    const state = createState({
      route: "start",
      envelopeThrowsAfterCallback: true,
    });
    const response = await invokeRoute(state, startBody(), true);
    assert.equal(response.status, 200);
    const text = await drainResponse(response);
    assertNoSecret(text);
    const events = parseSse(text);
    const error = events.find((event) => event.event === "error");
    assert.ok(error, "SSE must stream an error event");
    assert.equal(error.data!.message, "Generation failed.");
    assertRejectedGeneration(state, "start envelope post-callback rejection", true);
    assert.equal(state.envelopeCompleted, 1);
    assert.equal(
      state.order.includes("envelope-return"),
      false,
      "cap rejection must not report a completed envelope return",
    );
    assert.equal(state.settleCalls, 0);
  }

  // Settlement write failure after a successful generation.
  {
    const state = createState({ route: "start", settleFails: true });
    const response = await invokeRoute(state, startBody(), false);
    assert.equal(response.status, 500);
    const payload = await jsonOf(response);
    assertNoSecret(JSON.stringify(payload));
    assertSettleFailureAfterSuccess(state);
  }

  // Image cache preparation failure: not a provider failure, stays pending.
  {
    const state = createState({ route: "start", cacheFails: true });
    const response = await invokeRoute(state, startBody(), false);
    assert.equal(response.status, 500);
    const payload = await jsonOf(response);
    assertNoSecret(JSON.stringify(payload));
    assertPendingImageCacheFailure(state);
  }
}

// ---------------------------------------------------------------------------
// /api/scene
// ---------------------------------------------------------------------------

async function testSceneRoute(): Promise<void> {
  // Plain POST JSON, v2 platform-managed generation.
  {
    const state = createState({ route: "scene" });
    const response = await invokeRoute(state, sceneBody(), false);
    assert.equal(response.status, 200);
    const payload = await jsonOf(response);
    const scene = payload.scene as SceneFixture;
    assert.equal(scene.imageUuid, "runware-image-uuid-real-1");
    assert.equal(scene.beats[0]!.line, "You're late.");
    assert.equal(state.cacheLabels[0], "api/scene");
    assert.equal(state.speculativeWraps, 1);
    assert.equal(state.observedEvents.length, 1);
    assert.equal(state.observedEvents[0]!.type, "beat");
    const characters = payload.characters as CharacterFixture[];
    assert.equal(
      characters[0]!.voice,
      undefined,
      "known session voices must be stripped from scene responses",
    );
    assert.ok(characters[1]!.voice, "unknown characters keep their voices");
    assertV2Success(state, "story.scene", state.config);
    assertNoSecret(JSON.stringify(payload));
  }

  // SSE generation, drained so the stream background callback executes.
  {
    const state = createState({ route: "scene" });
    const response = await invokeRoute(state, sceneBody(), true);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    const text = await drainResponse(response);
    assertNoSecret(text);
    const events = parseSse(text);
    assert.ok(events.some((event) => event.event === "beat"));
    const done = events.find((event) => event.event === "done");
    assert.ok(done);
    const doneResponse = done.data!.response as Record<string, unknown>;
    const doneScene = doneResponse.scene as SceneFixture;
    assert.equal(doneScene.imageUuid, "runware-image-uuid-real-1");
    assert.equal(state.observedEvents.length, 1, "speculative observer must run");
    assertV2Success(state, "story.scene", state.config);
    assert.equal(state.settleCalls, 1);
  }

  // Speculative prefetch uses the prefetch operation for billing and envelope.
  {
    const state = createState({ route: "scene" });
    const response = await invokeRoute(
      state,
      sceneBody({
        speculation: { mode: "prefetch", requestedDepth: 0, branchOrdinal: 0 },
      }),
      false,
    );
    assert.equal(response.status, 200);
    assertV2Success(state, "story.scene.prefetch", state.config);
  }

  // Legacy fixed-beta v1: no envelope, original flow.
  {
    const state = createState({ route: "scene", pricing: "v1" });
    const response = await invokeRoute(state, sceneBody(), false);
    assert.equal(response.status, 200);
    assertLegacyOrByokSuccess(state, state.config);
    assert.equal(state.settleOutcomes.at(-1), "settle");
    assert.equal(state.prepareInputs[0]!.operation, "story.scene");
  }

  // BYOK: no reservation, no envelope, original flow.
  {
    const state = createState({ route: "scene", pricing: "byok" });
    const response = await invokeRoute(state, sceneBody(byokBody(sceneBody())), false);
    assert.equal(response.status, 200);
    assertLegacyOrByokSuccess(state, state.byokConfig);
    assert.equal(state.prepareInputs[0]!.hasByok, true);
    assert.equal(state.prepareInputs[0]!.runtimeConfig, state.byokConfig);
    assert.equal(state.settleOutcomes.at(-1), "none");
  }

  // Cache preflight: strip known voices and bypass reserve/provider entirely.
  {
    const state = createState({
      route: "scene",
      preflightCached: cachedSceneResponse(),
    });
    const response = await invokeRoute(state, sceneBody(), false);
    assert.equal(response.status, 200);
    const payload = await jsonOf(response);
    const characters = payload.characters as CharacterFixture[];
    assert.equal(characters[0]!.voice, undefined);
    assert.ok(characters[1]!.voice);
    assertPreflightCacheBypass(state);
  }

  // prepareGenerationBilling replay rejection: no provider work.
  {
    const state = createState({ route: "scene", replay: true });
    const response = await invokeRoute(state, sceneBody(), false);
    const payload = await jsonOf(response);
    assertReplayBypass(state, response, payload);
    assertNoSecret(JSON.stringify(payload));
  }

  // Provider throw: failed intent before refund, never success/cache.
  {
    const state = createState({ route: "scene", behavior: "throw" });
    const response = await invokeRoute(state, sceneBody(), false);
    assert.equal(response.status, 500);
    const payload = await jsonOf(response);
    assert.equal(payload.error, "Generation failed.");
    assertNoSecret(JSON.stringify(payload));
    assertRejectedGeneration(state, "scene provider throw", false);
    assert.equal(state.envelopeCompleted, 0);
  }

  // Placeholder scene (no real image UUID): essential core rejected.
  {
    const state = createState({ route: "scene", behavior: "placeholder" });
    const response = await invokeRoute(state, sceneBody(), false);
    assert.equal(response.status, 500);
    const payload = await jsonOf(response);
    assertNoSecret(JSON.stringify(payload));
    assertRejectedGeneration(state, "scene placeholder", true);
  }

  // Sticky post-callback cap violation on the SSE path.
  {
    const state = createState({
      route: "scene",
      envelopeThrowsAfterCallback: true,
    });
    const response = await invokeRoute(state, sceneBody(), true);
    assert.equal(response.status, 200);
    const text = await drainResponse(response);
    assertNoSecret(text);
    const events = parseSse(text);
    const error = events.find((event) => event.event === "error");
    assert.ok(error);
    assert.equal(error.data!.message, "Generation failed.");
    assertRejectedGeneration(state, "scene envelope post-callback rejection", true);
    assert.equal(state.envelopeCompleted, 1);
    assert.equal(state.order.includes("envelope-return"), false);
    assert.equal(state.settleCalls, 0);
  }

  // Settlement write failure after success.
  {
    const state = createState({ route: "scene", settleFails: true });
    const response = await invokeRoute(state, sceneBody(), false);
    assert.equal(response.status, 500);
    const payload = await jsonOf(response);
    assertNoSecret(JSON.stringify(payload));
    assertSettleFailureAfterSuccess(state);
  }

  // Image cache preparation failure: pending, no fake provider failure.
  {
    const state = createState({ route: "scene", cacheFails: true });
    const response = await invokeRoute(state, sceneBody(), false);
    assert.equal(response.status, 500);
    const payload = await jsonOf(response);
    assertNoSecret(JSON.stringify(payload));
    assertPendingImageCacheFailure(state);
  }
}

// ---------------------------------------------------------------------------
// clientTts separation: platform pricing + cost envelope keep the FULL trusted
// server runtime config (including TTS), while the engine receives a
// TTS-suppressed config so no server-side speech work happens. Before this
// fix the route passed `{...base, tts: undefined}` to BOTH pricing and the
// engine; for story.start the runtime-binding hash covers `tts_optional`, so
// pricing failed closed with 503 before reserve.
// ---------------------------------------------------------------------------

function engineConfigAfter(state: State): Record<string, unknown> {
  const config = state.engineConfigs.at(-1);
  assert.ok(isRecord(config), "the engine must receive a config object");
  return config;
}

function assertSuppressedEngineConfig(
  state: State,
  fullConfig: Record<string, unknown>,
  label: string,
): void {
  const engineConfig = engineConfigAfter(state);
  assert.notEqual(
    engineConfig,
    fullConfig,
    `${label}: engine must not receive the trusted pricing config object`,
  );
  assert.equal(
    engineConfig.tts,
    undefined,
    `${label}: clientTts=true must suppress server TTS for the engine`,
  );
  // Only the optional TTS role may be removed; the text/image/vision objects
  // stay reference-identical so cost-envelope adapter identity still matches.
  assert.equal(engineConfig.text, fullConfig.text);
  assert.equal(engineConfig.image, fullConfig.image);
  assert.equal(engineConfig.vision, fullConfig.vision);
  assert.equal(
    state.engineTtsCalls,
    0,
    `${label}: clientTts=true must never request server-side TTS`,
  );
}

function assertFullConfigWasPriced(
  state: State,
  fullConfig: Record<string, unknown>,
  label: string,
): void {
  assert.equal(
    state.prepareInputs[0]!.runtimeConfig,
    fullConfig,
    `${label}: platform pricing must receive the FULL trusted runtime config`,
  );
  assert.notEqual(
    (state.prepareInputs[0]!.runtimeConfig as Record<string, unknown>).tts,
    undefined,
    `${label}: pricing config must keep the configured TTS role`,
  );
}

function assertBindingFailureBeforeReserve(
  state: State,
  label: string,
): void {
  assert.equal(state.prepares, 1, `${label}: pricing was attempted`);
  assert.equal(state.pricingRejections, 1, `${label}: binding must fail closed`);
  assert.equal(state.reservations, 0, `${label}: no reservation may be created`);
  assert.equal(state.envelopeCalls.length, 0, `${label}: no envelope may open`);
  assert.equal(state.providerCalls, 0, `${label}: no provider call may run`);
  assert.equal(state.cacheCalls, 0);
  assert.equal(state.settleCalls, 0);
  assert.equal(state.refundCalls.length, 0);
}

async function testClientTtsFixes(): Promise<void> {
  const fullConfig = liveRuntimeConfig();
  const startEntry = v2Entry("story.start");
  const sceneEntry = v2Entry("story.scene");

  // The exact v2 candidate pins the full four-role runtime binding.
  assert.equal(
    costBetaRuntimeBindingForOperation("story.start", fullConfig).model,
    startEntry.model,
  );
  assert.equal(
    costBetaRuntimeBindingForOperation("story.scene", fullConfig).model,
    sceneEntry.model,
  );

  // Old-code reproduction: the start/scene route used to pass this stripped
  // object to pricing, which hashes to the `tts: disabled` descriptor and no
  // longer matches the candidate.
  const oldRouteStripped = { ...fullConfig, tts: undefined };
  assert.notEqual(
    costBetaRuntimeBindingForOperation("story.start", oldRouteStripped).model,
    startEntry.model,
    "stripping tts must change the story.start runtime binding (old failure)",
  );
  assert.notEqual(
    costBetaRuntimeBindingForOperation("story.scene", oldRouteStripped).model,
    sceneEntry.model,
    "stripping tts must change the story.scene runtime binding (old failure)",
  );

  // /api/start JSON: successful text + image, full config priced, engine silent.
  {
    const state = createState({
      route: "start",
      config: fullConfig,
      v2Candidate: EXACT_V2_CANDIDATE,
    });
    const response = await invokeRoute(state, startBody({ clientTts: true }), false);
    assert.equal(response.status, 200);
    const payload = await jsonOf(response);
    const scene = payload.scene as SceneFixture;
    assert.equal(payload.sessionId, "s_live_generated_1");
    assert.equal(scene.imageUuid, "runware-image-uuid-real-1");
    assert.equal(scene.imageUrl, "https://cdn.aistory.test/scenes/rooftop-night.png");
    assert.equal(scene.beats[0]!.line, "You're late.");
    assert.equal(scene.beats[1]!.narration?.includes("Rain needles"), true);
    const engineConfig = engineConfigAfter(state);
    assertV2Success(state, "story.start", engineConfig);
    assertFullConfigWasPriced(state, fullConfig, "start clientTts JSON");
    assertSuppressedEngineConfig(state, fullConfig, "start clientTts JSON");
    assert.equal(state.envelopeCalls[0]!.config, fullConfig);
    assert.notEqual(state.envelopeCalls[0]!.config, engineConfig);
    assert.equal(state.reservations, 1);
    assert.equal(state.pricingRejections, 0);
    assertNoSecret(JSON.stringify(payload));
  }

  // /api/start SSE: same separation inside the stream callback.
  {
    const state = createState({
      route: "start",
      config: fullConfig,
      v2Candidate: EXACT_V2_CANDIDATE,
    });
    const response = await invokeRoute(state, startBody({ clientTts: true }), true);
    assert.equal(response.status, 200);
    const text = await drainResponse(response);
    assertNoSecret(text);
    const events = parseSse(text);
    const done = events.find((event) => event.event === "done");
    assert.ok(done, "SSE must end with a done event");
    const doneResponse = done.data!.response as Record<string, unknown>;
    const doneScene = doneResponse.scene as SceneFixture;
    assert.equal(doneScene.imageUuid, "runware-image-uuid-real-1");
    assert.equal(doneScene.beats[0]!.line, "You're late.");
    const engineConfig = engineConfigAfter(state);
    assertV2Success(state, "story.start", engineConfig);
    assertFullConfigWasPriced(state, fullConfig, "start clientTts SSE");
    assertSuppressedEngineConfig(state, fullConfig, "start clientTts SSE");
    assert.equal(state.envelopeCalls[0]!.config, fullConfig);
    assert.equal(state.pricingRejections, 0);
  }

  // /api/scene JSON: same fix, same trusted identity.
  {
    const state = createState({
      route: "scene",
      config: fullConfig,
      v2Candidate: EXACT_V2_CANDIDATE,
    });
    const response = await invokeRoute(state, sceneBody({ clientTts: true }), false);
    assert.equal(response.status, 200);
    const payload = await jsonOf(response);
    const scene = payload.scene as SceneFixture;
    assert.equal(scene.imageUuid, "runware-image-uuid-real-1");
    assert.equal(scene.beats[0]!.line, "You're late.");
    const engineConfig = engineConfigAfter(state);
    assertV2Success(state, "story.scene", engineConfig);
    assertFullConfigWasPriced(state, fullConfig, "scene clientTts JSON");
    assertSuppressedEngineConfig(state, fullConfig, "scene clientTts JSON");
    assert.equal(state.envelopeCalls[0]!.config, fullConfig);
    assert.equal(state.speculativeWraps, 1);
    assert.equal(state.pricingRejections, 0);
    assertNoSecret(JSON.stringify(payload));
  }

  // /api/scene SSE: stream callback keeps the same separation.
  {
    const state = createState({
      route: "scene",
      config: fullConfig,
      v2Candidate: EXACT_V2_CANDIDATE,
    });
    const response = await invokeRoute(state, sceneBody({ clientTts: true }), true);
    assert.equal(response.status, 200);
    const text = await drainResponse(response);
    assertNoSecret(text);
    const events = parseSse(text);
    const done = events.find((event) => event.event === "done");
    assert.ok(done);
    const doneResponse = done.data!.response as Record<string, unknown>;
    const doneScene = doneResponse.scene as SceneFixture;
    assert.equal(doneScene.imageUuid, "runware-image-uuid-real-1");
    const engineConfig = engineConfigAfter(state);
    assertV2Success(state, "story.scene", engineConfig);
    assertFullConfigWasPriced(state, fullConfig, "scene clientTts SSE");
    assertSuppressedEngineConfig(state, fullConfig, "scene clientTts SSE");
    assert.equal(state.pricingRejections, 0);
  }

  // Legacy v1 still suppresses engine TTS without touching the pricing config.
  {
    const state = createState({ route: "start", pricing: "v1" });
    const response = await invokeRoute(state, startBody({ clientTts: true }), false);
    assert.equal(response.status, 200);
    assertLegacyOrByokSuccess(state, engineConfigAfter(state));
    assertSuppressedEngineConfig(state, state.config, "start clientTts v1");
    assertFullConfigWasPriced(state, state.config, "start clientTts v1");
  }

  // BYOK stays compatible, and clientTts only suppresses the engine TTS.
  {
    const state = createState({ route: "start", pricing: "byok" });
    const response = await invokeRoute(
      state,
      byokBody(startBody({ clientTts: true })),
      false,
    );
    assert.equal(response.status, 200);
    assertLegacyOrByokSuccess(state, engineConfigAfter(state));
    assertSuppressedEngineConfig(state, state.byokConfig, "start clientTts BYOK");
    assert.equal(state.prepareInputs[0]!.hasByok, true);
    assert.equal(state.prepareInputs[0]!.runtimeConfig, state.byokConfig);
    assert.equal(state.settleOutcomes.at(-1), "none");
  }

  // Known-missing real binding: a config without the TTS role must be rejected
  // by the exact v2 candidate before reserve (this is the old-code 503 shape).
  {
    const missingTts = { ...liveRuntimeConfig(), tts: undefined };
    const state = createState({
      route: "start",
      config: missingTts,
      v2Candidate: EXACT_V2_CANDIDATE,
    });
    const response = await invokeRoute(state, startBody({ clientTts: true }), false);
    const payload = await jsonOf(response);
    assert.equal(response.status, 503);
    assert.equal(payload.code, "PLATFORM_PRICING_UNAVAILABLE");
    assertNoSecret(JSON.stringify(payload));
    assertBindingFailureBeforeReserve(state, "start missing TTS binding");
  }

  // Known-missing real binding on the scene counterpart too.
  {
    const missingTts = { ...liveRuntimeConfig(), tts: undefined };
    const state = createState({
      route: "scene",
      config: missingTts,
      v2Candidate: EXACT_V2_CANDIDATE,
    });
    const response = await invokeRoute(state, sceneBody({ clientTts: true }), false);
    const payload = await jsonOf(response);
    assert.equal(response.status, 503);
    assert.equal(payload.code, "PLATFORM_PRICING_UNAVAILABLE");
    assertBindingFailureBeforeReserve(state, "scene missing TTS binding");
  }

  // Unknown real server binding: a model outside the authorized allowlist can
  // never produce a v2 binding, so it must also fail closed before reserve.
  {
    const unknown = liveRuntimeConfig();
    unknown.text = { ...unknown.text, model: "qwen-not-an-authorized-model" };
    assert.throws(
      () => costBetaRuntimeBindingForOperation("story.start", unknown),
      "an unknown text model must not produce a v2 runtime binding",
    );
    const state = createState({
      route: "start",
      config: unknown,
      v2Candidate: EXACT_V2_CANDIDATE,
    });
    const response = await invokeRoute(state, startBody({ clientTts: true }), false);
    const payload = await jsonOf(response);
    assert.equal(response.status, 503);
    assert.equal(payload.code, "PLATFORM_PRICING_UNAVAILABLE");
    assertNoSecret(JSON.stringify(payload));
    assertBindingFailureBeforeReserve(state, "start unknown text binding");
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

await testStartRoute();
await testSceneRoute();
await testClientTtsFixes();

console.log("cost envelope start/scene route boundary tests passed");
