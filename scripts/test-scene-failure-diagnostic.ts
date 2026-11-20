/**
 * Compact tests for the scene failure diagnostic helper and its `/api/scene`
 * integration. No database, provider or network: the route is transpiled from
 * its real source and executed against a hand-written module registry, while
 * the diagnostic module is the real helper (console.error captured, never
 * printed). Run with the react-server condition so `server-only` resolves:
 *
 *   cross-env NODE_OPTIONS=--conditions=react-server \
 *     pnpm exec tsx scripts/test-scene-failure-diagnostic.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { NextResponse } from "next/server";
import ts from "typescript";

import {
  SCENE_FAILURE_EVENT,
  SCENE_FAILURE_STAGES,
  logSceneGenerationFailure,
} from "../lib/engine/sceneFailureDiagnostic";

const root = process.cwd();
const SECRET = "RAW_SECRET_9f3c";
const MESSAGE_SECRET = "MESSAGE_SECRET_2a7b";
const STACK_SECRET = "STACK_SECRET_4d8e";

type Entry = Record<string, unknown>;

function nativeError(name?: string, code?: string): Error {
  const error = new Error(`${MESSAGE_SECRET} ${SECRET}`);
  error.stack = `${name ?? "Error"}: ${MESSAGE_SECRET}\n    at ${STACK_SECRET}`;
  if (name !== undefined) error.name = name;
  if (code !== undefined) {
    Object.defineProperty(error, "code", {
      value: code,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return error;
}

function capture(run: () => void): Entry[] {
  const entries: Entry[] = [];
  const prior = console.error;
  console.error = ((value: Entry) => {
    entries.push(value);
  }) as typeof console.error;
  try {
    run();
  } finally {
    console.error = prior;
  }
  return entries;
}

async function captureAsync(run: () => Promise<void>): Promise<Entry[]> {
  const entries: Entry[] = [];
  const prior = console.error;
  console.error = ((value: Entry) => {
    entries.push(value);
  }) as typeof console.error;
  try {
    await run();
  } finally {
    console.error = prior;
  }
  return entries;
}

function only(entries: Entry[]): Entry {
  assert.equal(entries.length, 1, "exactly one diagnostic entry must be emitted");
  return entries[0]!;
}

function assertNoSecret(value: unknown): void {
  const text = JSON.stringify(value);
  for (const secret of [SECRET, MESSAGE_SECRET, STACK_SECRET]) {
    assert.equal(text.includes(secret), false, "diagnostics must never emit secret text");
  }
}

function testHelper(): void {
  // Native error: allowlisted name/category and code are kept.
  {
    const entries = capture(() => {
      logSceneGenerationFailure(
        "cost_envelope",
        nativeError("PlatformCostEnvelopeError", "PLATFORM_COST_ENVELOPE_EXHAUSTED"),
      );
    });
    assert.deepEqual(only(entries), {
      event: SCENE_FAILURE_EVENT,
      stage: "cost_envelope",
      category: "envelope",
      code: "PLATFORM_COST_ENVELOPE_EXHAUSTED",
    });
  }

  // Message/stack never become output, even when they hold secrets.
  {
    const entry = only(
      capture(() => {
        logSceneGenerationFailure(
          "engine_generation",
          nativeError("CostBetaGenerationDeliveryError", "COST_BETA_GENERATION_NOT_DELIVERED"),
        );
      }),
    );
    assertNoSecret(entry);
    for (const forbidden of ["message", "stack", "frames", "path", "file", "name"]) {
      assert.equal(forbidden in entry, false, `${forbidden} must not be logged`);
    }
  }

  // Unknown name/code map to the fixed "unknown" category; code is omitted.
  {
    const entry = only(
      capture(() => {
        logSceneGenerationFailure(
          "engine_generation",
          nativeError("TotallyArbitraryName", "ARBITRARY_CODE_ZZZ"),
        );
      }),
    );
    assert.equal(entry.category, "unknown");
    assert.equal("code" in entry, false);
    assertNoSecret(entry);
    const entryText = JSON.stringify(entry);
    assert.equal(entryText.includes("TotallyArbitraryName"), false);
    assert.equal(entryText.includes("ARBITRARY_CODE_ZZZ"), false);

    // A known name with an unlisted code keeps its category but drops the code.
    const badCode = only(capture(() => {
      logSceneGenerationFailure(
        "engine_generation",
        nativeError("PlatformCostEnvelopeError", "ARBITRARY_CODE_ZZZ"),
      );
    }));
    assert.equal(badCode.category, "envelope");
    assert.equal("code" in badCode, false);

    // A plain Error only has an inherited name, so it is "unknown" too.
    const plain = only(capture(() => logSceneGenerationFailure("core_validation", new Error(SECRET))));
    assert.equal(plain.category, "unknown");
    assert.equal("code" in plain, false);
  }

  // Inherited Object.prototype keys never resolve through the category map: an
  // own name such as "__proto__", "constructor" or "toString" is not an
  // allowlisted key, so it stays "unknown" and adds no code or other fields.
  {
    for (const inheritedName of ["__proto__", "constructor", "toString"]) {
      const error = nativeError(inheritedName);
      assert.equal(
        Object.hasOwn(error, "name"),
        true,
        `${inheritedName} must be an own data name on the test error`,
      );
      const entry = only(capture(() => logSceneGenerationFailure("engine_generation", error)));
      assert.deepEqual(entry, {
        event: SCENE_FAILURE_EVENT,
        stage: "engine_generation",
        category: "unknown",
      });
      assertNoSecret(entry);
      assert.equal(
        JSON.stringify(entry).includes(inheritedName),
        false,
        "the raw inherited name must never be logged",
      );
    }
  }

  // Hostile own getters are never executed.
  {
    let getterCalls = 0;
    const hostile = new Error(SECRET);
    for (const key of ["name", "code"]) {
      Object.defineProperty(hostile, key, {
        configurable: true,
        get() {
          getterCalls += 1;
          throw new Error(`getter ${key}`);
        },
      });
    }
    const entry = only(capture(() => logSceneGenerationFailure("engine_generation", hostile)));
    assert.equal(getterCalls, 0, "getters must not run");
    assert.equal(entry.category, "unknown");
    assert.equal("code" in entry, false);
  }

  // Proxies are refused without touching any trap.
  {
    let traps = 0;
    const proxy = new Proxy(new Error(SECRET), {
      get() {
        traps += 1;
        throw new Error("get");
      },
      getOwnPropertyDescriptor() {
        traps += 1;
        throw new Error("getOwnPropertyDescriptor");
      },
      getPrototypeOf() {
        traps += 1;
        throw new Error("getPrototypeOf");
      },
    });
    const entry = only(capture(() => logSceneGenerationFailure("engine_generation", proxy)));
    assert.equal(traps, 0, "proxy traps must not run");
    assert.equal(entry.category, "unknown");
  }

  // A throwing console logger is swallowed and cannot escape.
  {
    let loggerCalls = 0;
    const prior = console.error;
    console.error = (() => {
      loggerCalls += 1;
      throw new Error("logger boom");
    }) as typeof console.error;
    try {
      assert.doesNotThrow(() => {
        logSceneGenerationFailure("core_validation", nativeError("Error", "PLATFORM_PRICING_UNAVAILABLE"));
      });
    } finally {
      console.error = prior;
    }
    assert.equal(loggerCalls, 1);
  }

  // Client-supplied or stale stage names are rejected, so nothing is emitted.
  {
    const entries = capture(() => {
      logSceneGenerationFailure("client_supplied", nativeError("Error"));
    });
    assert.equal(entries.length, 0);
    assert.deepEqual([...SCENE_FAILURE_STAGES], [
      "engine_generation",
      "core_validation",
      "cost_envelope",
    ]);
  }
}

// ---------------------------------------------------------------------------
// Route integration: real source + minimal mocks, real diagnostic helper.
// ---------------------------------------------------------------------------

type RouteState = {
  failAt: "engine" | "core" | "envelope";
  providerCalls: number;
  validationCalls: number;
  started: number;
  succeeded: number;
  failure: number;
  failureIntent: boolean;
  settleCalls: number;
  refunds: string[];
  order: string[];
  envelopeActive: boolean;
};

function createState(failAt: RouteState["failAt"]): RouteState {
  return {
    failAt,
    providerCalls: 0,
    validationCalls: 0,
    started: 0,
    succeeded: 0,
    failure: 0,
    failureIntent: false,
    settleCalls: 0,
    refunds: [],
    order: [],
    envelopeActive: false,
  };
}

function closeError(name: string, code: string): Error {
  return nativeError(name, code);
}

function routeMocks(state: RouteState): Record<string, unknown> {
  const config = {
    text: { model: "test-text", baseUrl: "https://text.invalid" },
    image: { model: "test-image", baseUrl: "https://image.invalid" },
    vision: { model: "test-vision", baseUrl: "https://vision.invalid" },
  };
  const billing = {
    mode: "platform_managed" as const,
    reservation: { id: "reservation-1", catalogEntry: { pricingMode: "cost_beta_credit_v2" } },
    providerOutcome: "not_started" as "not_started" | "outcome_unknown" | "succeeded",
  };
  return {
    "next/server": { NextResponse },
    "@infiplot/engine": {
      requestScene: async () => {
        state.providerCalls += 1;
        state.order.push("provider");
        if (state.failAt === "engine") {
          throw closeError("CostBetaGenerationDeliveryError", "COST_BETA_GENERATION_NOT_DELIVERED");
        }
        return {
          scene: { imageUuid: "uuid-1", imageUrl: "https://cdn.invalid/1.png", beats: [] },
          imageUrl: "https://cdn.invalid/1.png",
          characters: [],
          storyState: {},
        };
      },
    },
    "@infiplot/types": {},
    "@/lib/billing/platformCostEnvelope": {},
    "@/lib/config": {
      loadEngineConfig: () => config,
      buildByoEngineConfig: () => config,
    },
    "@/lib/credentials/serverPolicy": {
      assertCompleteByok: () => undefined,
      hasByokPayload: () => false,
    },
    "@/lib/supabase/guard": { requireUser: async () => ({ userId: "route-test-user" }) },
    "@/lib/engine/mediaCache": {
      cacheApiResponseImage: async (generated: unknown) => generated,
    },
    "@/lib/engine/sceneFailureDiagnostic": { logSceneGenerationFailure },
    "@/lib/engine/sceneCache": {
      nextSceneCacheKey: () => ({ key: "scene-key" }),
      peekSceneCache: async () => null,
      withSceneCache: async (
        _meta: unknown,
        _label: string,
        compute: () => Promise<unknown>,
      ) => compute(),
    },
    "@/lib/engine/speculativeBranchCache": {
      rejectSpeculativeRequest: () => undefined,
      getSpeculativeBranchContext: () => ({}),
      withSpeculativeBranchCache: async (
        _context: unknown,
        fn: (observe: (event: Record<string, unknown>) => void) => Promise<unknown>,
      ) => fn(() => undefined),
    },
    "@/lib/case-studies/schema": { isAuthoredAiContinuationAllowed: () => true },
    "@/lib/billing/generationGate": {
      prepareGenerationBilling: async () => billing,
      isCostBetaGenerationBilling: () => true,
      markGenerationBillingProviderStarted: () => {
        state.started += 1;
        state.order.push("started");
        if (billing.providerOutcome === "not_started") billing.providerOutcome = "outcome_unknown";
      },
      markGenerationBillingProviderSucceeded: () => {
        state.succeeded += 1;
        state.order.push("succeeded");
        billing.providerOutcome = "succeeded";
      },
      markGenerationBillingOperationFailed: () => {
        if (billing.providerOutcome === "succeeded") throw new Error("already succeeded");
        state.failure += 1;
        state.failureIntent = true;
        state.order.push("failure");
      },
      settleGenerationBilling: async () => {
        state.settleCalls += 1;
        state.order.push("settle");
        return "settle";
      },
      refundGenerationBilling: async () => {
        state.order.push("refund");
        const outcome = billing.providerOutcome === "succeeded"
          ? "settle"
          : state.failureIntent
            ? "refund"
            : "pending";
        state.refunds.push(outcome);
        return outcome;
      },
    },
    "@/lib/billing/generationDelivery": {
      assertCostBetaGeneratedCore: () => {
        state.validationCalls += 1;
        state.order.push("validate");
        if (state.failAt === "core") {
          throw closeError("CostBetaGenerationDeliveryError", "COST_BETA_GENERATION_NOT_DELIVERED");
        }
      },
    },
    "@/lib/billing/platformCostEnvelopeServer": {
      runInCostEnvelope: async (
        _config: unknown,
        _operation: string,
        fn: () => Promise<unknown>,
      ) => {
        state.order.push("envelope");
        state.envelopeActive = true;
        try {
          const value = await fn();
          if (state.failAt === "envelope") {
            state.order.push("envelope-reject");
            throw closeError("PlatformCostEnvelopeError", "PLATFORM_COST_ENVELOPE_EXHAUSTED");
          }
          return value;
        } finally {
          state.envelopeActive = false;
        }
      },
    },
    "@/lib/billing/service": {
      PricingUnavailableError: class extends Error {
        readonly code = "PLATFORM_PRICING_UNAVAILABLE";
        readonly status = 503;
      },
    },
  };
}

const routeFile = path.join(root, "app/api/scene/route.ts");
const routeSource = readFileSync(routeFile, "utf8");
let transpiled: string | undefined;

function loadRoute(state: RouteState): Record<string, unknown> {
  transpiled ??= ts.transpileModule(routeSource, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: "app/api/scene/route.ts",
  }).outputText;
  const modules = routeMocks(state);
  const moduleRecord = { exports: {} as Record<string, unknown> };
  const localRequire = (id: string) => {
    if (!(id in modules)) throw new Error(`unmocked route dependency "${id}"`);
    return modules[id];
  };
  new Function(
    "require",
    "module",
    "exports",
    "__filename",
    "__dirname",
    transpiled,
  )(
    localRequire,
    moduleRecord,
    moduleRecord.exports,
    routeFile,
    path.dirname(routeFile),
  );
  return moduleRecord.exports;
}

async function invoke(state: RouteState, sse: boolean): Promise<Response> {
  const route = loadRoute(state);
  assert.equal(
    "logSceneGenerationFailure" in route,
    false,
    "the diagnostic helper must not be exported through the Next route",
  );
  const headers = new Headers({ "content-type": "application/json" });
  if (sse) headers.set("accept", "text/event-stream");
  const request = new Request("https://aistory.test/api/scene", {
    method: "POST",
    headers,
    body: JSON.stringify({
      session: { id: "session-1", characters: [] },
      credentialMode: "platform_managed",
    }),
  });
  return (route.POST as (request: Request) => Promise<Response>)(request);
}

async function drain(response: Response): Promise<string> {
  assert.ok(response.body, "SSE response must have a body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function assertFailureOutcome(state: RouteState): void {
  assert.equal(state.succeeded, 0, "a failed generation must never mark success");
  assert.equal(state.failure, 1, "failed-delivery intent must be recorded");
  assert.equal(state.settleCalls, 0, "failed generation must not settle");
  assert.ok(state.refunds.length > 0, "refund helper must run");
  assert.equal(state.refunds.at(-1), "refund");
  assert.ok(state.order.indexOf("failure") < state.order.indexOf("refund"));
}

async function testRoute(): Promise<void> {
  // JSON engine failure: stage engine_generation, generic body, refund kept.
  {
    const state = createState("engine");
    const entries = await captureAsync(async () => {
      const response = await invoke(state, false);
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { error: "Generation failed." });
    });
    const entry = only(entries);
    assert.equal(entry.stage, "engine_generation");
    assert.equal(entry.category, "delivery");
    assertNoSecret(entry);
    assertFailureOutcome(state);
  }

  // SSE core-validation failure: stage core_validation, generic error event.
  {
    const state = createState("core");
    let text = "";
    const entries = await captureAsync(async () => {
      const response = await invoke(state, true);
      assert.equal(response.status, 200);
      text = await drain(response);
    });
    const entry = only(entries);
    assert.equal(entry.stage, "core_validation");
    assert.equal(entry.category, "delivery");
    assert.match(text, /event: error/);
    assert.match(text, /"message":"Generation failed\."/);
    assertNoSecret(text);
    assertFailureOutcome(state);
    assert.equal(state.providerCalls, 1);
    assert.equal(state.validationCalls, 1);
  }

  // Sticky post-callback envelope failure: stage cost_envelope.
  {
    const state = createState("envelope");
    const entries = await captureAsync(async () => {
      const response = await invoke(state, true);
      assert.equal(response.status, 200);
      const text = await drain(response);
      assert.match(text, /event: error/);
      assertNoSecret(text);
    });
    const entry = only(entries);
    assert.equal(entry.stage, "cost_envelope");
    assert.equal(entry.category, "envelope");
    assert.equal(entry.code, "PLATFORM_COST_ENVELOPE_EXHAUSTED");
    assertNoSecret(entry);
    assert.equal(state.validationCalls, 1);
    assertFailureOutcome(state);
  }
}

testHelper();
await testRoute();
console.log("scene failure diagnostic tests passed");
