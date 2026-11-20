import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  classifyFreeform,
  requestBeatAudio,
  requestInsertBeat,
  visionDecide,
} from "@infiplot/engine";
import type {
  BeatAudioRequest,
  Character,
  EngineConfig,
  FreeformClassifyRequest,
  InsertBeatRequest,
  VisionRequest,
} from "@infiplot/types";
import { POST as beatAudioPost } from "@/app/api/beat-audio/route";
import { POST as classifyFreeformPost } from "@/app/api/classify-freeform/route";
import { POST as insertBeatPost } from "@/app/api/insert-beat/route";
import { POST as startPost } from "@/app/api/start/route";
import { POST as visionPost } from "@/app/api/vision/route";
import { LocalAdminRepository } from "@/lib/admin/localRepository";
import type { AdminRepository } from "@/lib/admin/repositories";
import {
  adjustCredits,
  createUserWithInitialGrant,
  saveBillingPolicy,
} from "@/lib/admin/service";
import type { AdminActor, BillingPolicy } from "@/lib/admin/types";
import {
  assertFixedBetaPricingPolicy,
  buildFixedBetaPricingCandidate,
  FIXED_BETA_OPERATION_CONTRACT,
  FIXED_BETA_ORDINARY_REGISTRATION_GRANT,
  FIXED_BETA_PRICING_MODE_CONFIG,
  FIXED_BETA_PRICING_MODE_ENV,
  FIXED_BETA_PRICING_VERSION_ENV,
  fixedBetaRuntimeBindingForOperation,
  fixedBetaPricingFingerprint,
  type FixedBetaOperationPin,
  type FixedBetaRuntimeConfig,
} from "@/lib/billing/fixedBetaPricing";
import {
  creditsForCatalogEntry,
  getServerCreditBalance,
  InsufficientCreditsError,
  isValidPlatformBillingIdempotencyKey,
  PricingUnavailableError,
  quotePlatformOperation,
  refundPlatformOperation,
  reservePlatformOperation,
  settlePlatformOperation,
  type ProviderSettlementReceipt,
} from "@/lib/billing/service";
import {
  markGenerationBillingProviderStarted,
  markGenerationBillingProviderSucceeded,
  prepareGenerationBilling,
  refundGenerationBilling,
  settleGenerationBilling,
  type GenerationBillingContext,
} from "@/lib/billing/generationGate";
import { runPainter } from "@/lib/engine/agents/painter";

const originalFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = (async () => {
  fetchCalls += 1;
  throw new Error("NETWORK_FORBIDDEN");
}) as typeof fetch;

const runtimeConfig: FixedBetaRuntimeConfig = {
  text: {
    baseUrl: "https://text.fixture.invalid/v1",
    provider: "openai_compatible",
    model: "fixture-text-v1",
  },
  image: {
    baseUrl: "https://image.fixture.invalid/v1",
    provider: "runware",
    model: "runware:400@6",
  },
  vision: {
    baseUrl: "https://vision.fixture.invalid/v1",
    provider: "openai_compatible",
    model: "fixture-vision-v1",
  },
  tts: {
    baseUrl: "https://api.stepfun.com/v1",
    provider: "stepfun",
    speechModel: "step-tts-mini",
  },
  mockImage: false,
};

const ttsAttemptConfig: EngineConfig = {
  text: {
    apiKey: "synthetic-text-key",
    baseUrl: runtimeConfig.text.baseUrl,
    model: runtimeConfig.text.model,
    provider: runtimeConfig.text.provider,
  },
  image: {
    apiKey: "synthetic-image-key",
    baseUrl: runtimeConfig.image.baseUrl,
    model: runtimeConfig.image.model,
    provider: runtimeConfig.image.provider,
  },
  vision: {
    apiKey: "synthetic-vision-key",
    baseUrl: runtimeConfig.vision.baseUrl,
    model: runtimeConfig.vision.model,
    provider: runtimeConfig.vision.provider,
  },
  tts: {
    apiKey: "synthetic-tts-key",
    baseUrl: runtimeConfig.tts!.baseUrl,
    speechModel: runtimeConfig.tts!.speechModel,
    provider: runtimeConfig.tts!.provider,
  },
  mockImage: false,
};

for (const request of [
  {
    beat: { id: "tts-no-fallback", line: "synthetic line" },
    voice: {
      provider: "xiaomi",
      referenceAudioBase64: "synthetic-reference",
      mimeType: "audio/wav",
    },
  },
  {
    beat: { id: "tts-invalid-stepfun-id", line: "synthetic line" },
    voice: {
      provider: "xiaomi",
      referenceAudioBase64: "synthetic-reference",
      mimeType: "audio/wav",
    },
    stepfunVoiceId: "invalid-but-truthy-stepfun-id",
  },
] satisfies BeatAudioRequest[]) {
  const fetchCallsBefore = fetchCalls;
  let providerStarted = 0;
  const generated = await requestBeatAudio(ttsAttemptConfig, request, {
    onProviderStarted: () => {
      providerStarted += 1;
    },
  });
  assert.equal(generated.audio, null);
  assert.equal(providerStarted, 0, "unresolvable TTS input must remain provider-not-started");
  assert.equal(fetchCalls, fetchCallsBefore, "unresolvable TTS input must not call fetch");
}

for (const invalidBody of [
  {
    worldSetting: "synthetic world",
    styleGuide: "synthetic style",
    playerName: 1,
  },
  {
    worldSetting: "synthetic world",
    styleGuide: "synthetic style",
    styleReferenceImage: 1,
  },
]) {
  const fetchCallsBefore = fetchCalls;
  const response = await startPost(new Request("http://localhost/api/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(invalidBody),
  }));
  assert.equal(response.status, 400, "invalid optional start fields must fail before billing");
  assert.equal(fetchCalls, fetchCallsBefore);
}

{
  const fetchCallsBefore = fetchCalls;
  const response = await beatAudioPost(new Request("http://localhost/api/beat-audio", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      beat: {
        id: "tts-invalid-delivery",
        line: "synthetic line",
        lineDelivery: 1,
      },
      voice: {
        provider: "xiaomi",
        referenceAudioBase64: "synthetic-reference",
        mimeType: "audio/wav",
      },
    }),
  }));
  assert.equal(response.status, 400, "invalid local TTS fields must fail before billing");
  assert.equal(fetchCalls, fetchCallsBefore);
}

for (const [post, body] of [
  [visionPost, { session: {}, annotatedImageBase64: "AA==" }],
  [classifyFreeformPost, { session: {}, freeformText: "synthetic action" }],
  [insertBeatPost, { session: {}, freeformAction: "synthetic action" }],
] as const) {
  const fetchCallsBefore = fetchCalls;
  const response = await post(new Request("http://localhost/api/synthetic", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
  assert.equal(response.status, 400, "incomplete session must fail before billing");
  assert.equal(fetchCalls, fetchCallsBefore);
}

for (const invoke of [
  (onProviderStarted: () => void) => visionDecide(
    ttsAttemptConfig,
    { session: {}, annotatedImageBase64: "AA==" } as unknown as VisionRequest,
    { onProviderStarted },
  ),
  (onProviderStarted: () => void) => classifyFreeform(
    ttsAttemptConfig,
    { session: {}, freeformText: "synthetic action" } as unknown as FreeformClassifyRequest,
    { onProviderStarted },
  ),
  (onProviderStarted: () => void) => requestInsertBeat(
    ttsAttemptConfig,
    { session: {}, freeformAction: "synthetic action" } as unknown as InsertBeatRequest,
    { onProviderStarted },
  ),
]) {
  const fetchCallsBefore = fetchCalls;
  let providerStarted = 0;
  await assert.rejects(
    invoke(() => {
      providerStarted += 1;
    }),
    TypeError,
  );
  assert.equal(providerStarted, 0, "local session failure must remain provider-not-started");
  assert.equal(fetchCalls, fetchCallsBefore, "local session failure must not call fetch");
}

{
  const fetchCallsBefore = fetchCalls;
  let providerStarted = 0;
  await assert.rejects(
    runPainter(
      ttsAttemptConfig,
      {
        integratedPrompt: "synthetic prompt",
        styleGuide: "synthetic style",
        onStageCharacters: [{
          name: "synthetic-character",
          visualDescription: "synthetic visual",
          spriteStates: {},
        } as unknown as Character],
      },
      undefined,
      {
        onProviderStarted: () => {
          providerStarted += 1;
        },
      },
    ),
    TypeError,
  );
  assert.equal(providerStarted, 0, "painter local validation failure must remain provider-not-started");
  assert.equal(fetchCalls, fetchCallsBefore, "painter local validation failure must not call fetch");
}

{
  const fetchCallsBefore = fetchCalls;
  let providerStarted = 0;
  await assert.rejects(
    runPainter(
      {
        ...ttsAttemptConfig,
        image: {
          ...ttsAttemptConfig.image,
          provider: "openai",
          model: "gpt-image-1",
        },
        imageTimeoutMs: undefined,
      },
      {
        integratedPrompt: "synthetic prompt",
        styleGuide: "synthetic style",
        onStageCharacters: [],
        styleReferenceImage: {} as unknown as string,
      },
      undefined,
      {
        onProviderStarted: () => {
          providerStarted += 1;
        },
      },
    ),
    TypeError,
  );
  assert.equal(providerStarted, 0, "invalid image reference must fail before provider start");
  assert.equal(fetchCalls, fetchCallsBefore, "invalid image reference must not call fetch");
}

{
  const blockedFetch = globalThis.fetch;
  let syntheticAdapterFetches = 0;
  let providerStarted = 0;
  globalThis.fetch = (async () => {
    syntheticAdapterFetches += 1;
    throw new Error("SYNTHETIC_IMAGE_PROVIDER_UNAVAILABLE");
  }) as typeof fetch;
  try {
    const generated = await runPainter(
      {
        ...ttsAttemptConfig,
        image: {
          ...ttsAttemptConfig.image,
          provider: "openai",
          model: "gpt-image-1",
        },
        imageTimeoutMs: undefined,
      },
      {
        integratedPrompt: "synthetic prompt",
        styleGuide: "synthetic style",
        onStageCharacters: [],
      },
      undefined,
      {
        onProviderStarted: () => {
          providerStarted += 1;
        },
      },
    );
    assert.equal(generated.kind, "mock");
  } finally {
    globalThis.fetch = blockedFetch;
  }
  assert.equal(providerStarted, 1, "provider hook must be idempotent across SDK retries");
  assert.ok(syntheticAdapterFetches > 0, "undefined timeout must not block the actual SDK fetch boundary");
  assert.equal(fetchCalls, 0, "no external-network trap should be reached");
}

const pins: FixedBetaOperationPin[] = FIXED_BETA_OPERATION_CONTRACT.map(
  ({ operation }, index) => ({
    operation,
    ...fixedBetaRuntimeBindingForOperation(operation, runtimeConfig),
    providerCostMinor: 100 + index,
  }),
);

type FixedReserveInput = Omit<
  Parameters<typeof reservePlatformOperation>[1],
  "runtimeConfig"
>;

function reserveFixed(
  targetRepository: AdminRepository,
  input: FixedReserveInput,
) {
  return reservePlatformOperation(targetRepository, {
    ...input,
    runtimeConfig,
  });
}

function quoteFixed(
  targetRepository: AdminRepository,
  operation: (typeof FIXED_BETA_OPERATION_CONTRACT)[number]["operation"],
) {
  return quotePlatformOperation(targetRepository, operation, runtimeConfig);
}

function candidateFrom(operationPins: FixedBetaOperationPin[] = pins) {
  return buildFixedBetaPricingCandidate({
    providerCurrency: "CNY",
    providerMinorUnitScale: 2,
    operationPins,
  });
}

function clonePolicy(
  policy: Omit<BillingPolicy, "updatedAt" | "updatedBy">,
): Omit<BillingPolicy, "updatedAt" | "updatedBy"> {
  return JSON.parse(JSON.stringify(policy)) as Omit<
    BillingPolicy,
    "updatedAt" | "updatedBy"
  >;
}

function expectContractBlocked(value: unknown): void {
  assert.throws(
    () => assertFixedBetaPricingPolicy(value),
    /Fixed beta pricing candidate is invalid/,
  );
}

const first = candidateFrom();
const second = candidateFrom([...pins].reverse());
const platformCoverageSource = await readFile(
  path.join(process.cwd(), "scripts", "test-platform-billing-coverage.ts"),
  "utf8",
);
const coverageOperations = [...platformCoverageSource.matchAll(
  /operations:\s*\[([^\]]+)\]/g,
)].flatMap((match) => [...(match[1] ?? "").matchAll(/"([^"]+)"/g)])
  .map((match) => match[1]);
assert.deepEqual(
  coverageOperations,
  FIXED_BETA_OPERATION_CONTRACT.map(({ operation }) => operation),
  "fixed candidate must equal the complete platform-paid route inventory",
);
assert.equal(/comfyui|gpu|video\./i.test(JSON.stringify(first.policy.entries)), false);
assert.equal(first.status, "LOCAL_POLICY_CANDIDATE_ONLY");
assert.equal(first.pricingAudience, "phone_authenticated_platform_managed_v1");
assert.equal(first.fixedCreditsPerOperation, 1);
assert.equal(first.operationCount, 11);
assert.equal(first.ordinaryRegistrationGrantCredits, 1_000);
assert.equal(first.membershipGrantIncluded, false);
assert.equal(first.productionWriteAllowed, false);
assert.equal(first.providerContacted, false);
assert.equal(first.networkCalls, 0);
assert.equal(first.writesPerformed, 0);
assert.equal(Object.isFrozen(first), true);
assert.equal(Object.isFrozen(first.policy), true);
assert.equal(Object.isFrozen(first.policy.entries), true);
assert.equal(first.policy.entries.every((entry) => Object.isFrozen(entry)), true);
assert.equal(first.policy.entries.length, 11);
assert.equal(first.policy.initialGrantCredits, FIXED_BETA_ORDINARY_REGISTRATION_GRANT);
assert.notEqual(first.policy.initialGrantCredits, 100_000);
assert.match(first.policy.version, /^fixed-beta-v1\.[a-f0-9]{64}$/);
assert.equal(first.fingerprint, fixedBetaPricingFingerprint(first.policy));
assert.equal(JSON.stringify(first), JSON.stringify(second), "input order must be canonical");
assert.equal(isValidPlatformBillingIdempotencyKey("a".repeat(8)), true);
assert.equal(isValidPlatformBillingIdempotencyKey("b".repeat(152)), true);
assert.equal(isValidPlatformBillingIdempotencyKey("c".repeat(7)), false);
assert.equal(isValidPlatformBillingIdempotencyKey("d".repeat(153)), false);
const runtimeBindings = FIXED_BETA_OPERATION_CONTRACT.map(({ operation }) => ({
  operation,
  ...fixedBetaRuntimeBindingForOperation(operation, runtimeConfig),
}));
assert.equal(runtimeBindings.length, 11);
assert.equal(runtimeBindings.every((binding) => binding.provider === "aistory_runtime_binding_v1"), true);
assert.equal(runtimeBindings.every((binding) => /^sha256:[a-f0-9]{64}$/.test(binding.model)), true);
assert.equal(
  JSON.stringify(runtimeBindings),
  JSON.stringify(FIXED_BETA_OPERATION_CONTRACT.map(({ operation }) => ({
    operation,
    ...fixedBetaRuntimeBindingForOperation(operation, runtimeConfig),
  }))),
);
assert.equal(
  /stepfun|runware|fixture-text|fixture-vision|https?:/i.test(
    JSON.stringify(runtimeBindings),
  ),
  false,
  "runtime binding output must expose only a logical provider and canonical hash",
);
assert.notEqual(
  fixedBetaRuntimeBindingForOperation("story.start", runtimeConfig).model,
  fixedBetaRuntimeBindingForOperation("story.start", {
    ...runtimeConfig,
    text: { ...runtimeConfig.text, model: "fixture-text-v2" },
  }).model,
);
assert.notEqual(
  fixedBetaRuntimeBindingForOperation("story.start", runtimeConfig).model,
  fixedBetaRuntimeBindingForOperation("story.start", {
    ...runtimeConfig,
    text: { ...runtimeConfig.text, baseUrl: "https://text-2.fixture.invalid/v1" },
  }).model,
  "endpoint drift must change the private runtime binding without exposing the URL",
);
assert.notEqual(
  fixedBetaRuntimeBindingForOperation("style.redraw", runtimeConfig).model,
  fixedBetaRuntimeBindingForOperation("style.redraw", {
    ...runtimeConfig,
    image: { ...runtimeConfig.image, model: "runware:401@6" },
  }).model,
);
assert.notEqual(
  fixedBetaRuntimeBindingForOperation("vision.decide", runtimeConfig).model,
  fixedBetaRuntimeBindingForOperation("vision.decide", {
    ...runtimeConfig,
    vision: { ...runtimeConfig.vision, model: "fixture-vision-v2" },
  }).model,
);
assert.notEqual(
  fixedBetaRuntimeBindingForOperation("tts.beat", runtimeConfig).model,
  fixedBetaRuntimeBindingForOperation("tts.beat", {
    ...runtimeConfig,
    tts: { ...runtimeConfig.tts!, speechModel: "step-tts-v2" },
  }).model,
);
assert.notEqual(
  fixedBetaRuntimeBindingForOperation("story.scene", runtimeConfig).model,
  fixedBetaRuntimeBindingForOperation("story.scene", {
    ...runtimeConfig,
    tts: undefined,
  }).model,
  "mixed operations must pin whether server TTS is enabled",
);
assert.throws(() => fixedBetaRuntimeBindingForOperation("tts.beat", {
  ...runtimeConfig,
  tts: undefined,
}));
assert.throws(() => fixedBetaRuntimeBindingForOperation("story.start", {
  ...runtimeConfig,
  text: { ...runtimeConfig.text, provider: undefined },
}));
assert.throws(() => fixedBetaRuntimeBindingForOperation("style.redraw", {
  ...runtimeConfig,
  image: { ...runtimeConfig.image, provider: undefined },
}));
assert.throws(() => fixedBetaRuntimeBindingForOperation("vision.decide", {
  ...runtimeConfig,
  vision: { ...runtimeConfig.vision, provider: "openai" },
}));
assert.throws(() => fixedBetaRuntimeBindingForOperation("tts.beat", {
  ...runtimeConfig,
  tts: {
    ...runtimeConfig.tts!,
    baseUrl: "https://tts.invalid/v1",
    provider: "stepfun",
  },
}));
assert.throws(() => fixedBetaRuntimeBindingForOperation("story.scene", {
  ...runtimeConfig,
  mockImage: true,
}));
assert.throws(() => fixedBetaRuntimeBindingForOperation("story.start", {
  ...runtimeConfig,
  text: { ...runtimeConfig.text, baseUrl: "http://text.fixture.invalid/v1" },
}));
for (const hostileBaseUrl of [
  "https://text.fixture.invalid/v1?",
  "https://text.fixture.invalid/v1#",
  "https://@text.fixture.invalid/v1",
  "https://:@text.fixture.invalid/v1",
  "https://text.fixture.invalid/v1/",
  "https://text.fixture.invalid/v1//",
  " https://text.fixture.invalid/v1",
  "https:\\text.fixture.invalid\\v1",
]) {
  assert.throws(() => fixedBetaRuntimeBindingForOperation("story.start", {
    ...runtimeConfig,
    text: { ...runtimeConfig.text, baseUrl: hostileBaseUrl },
  }));
}
assert.deepEqual(
  first.policy.entries.map((entry) => entry.operation),
  FIXED_BETA_OPERATION_CONTRACT.map(({ operation }) => operation),
);
for (const entry of first.policy.entries) {
  assert.equal(entry.enabled, true);
  assert.equal(entry.pricingMode, "fixed_beta_credit_v1");
  assert.equal(entry.fixedCredits, 1);
  assert.equal(creditsForCatalogEntry(entry, first.policy), 1);
}

const reorderedPolicy = clonePolicy(first.policy);
reorderedPolicy.entries.reverse();
assertFixedBetaPricingPolicy(reorderedPolicy);
assert.equal(fixedBetaPricingFingerprint(reorderedPolicy), first.fingerprint);

for (const mutate of [
  (policy: ReturnType<typeof clonePolicy>) => { policy.version = "fixed-beta-v1.".padEnd(78, "0"); },
  (policy: ReturnType<typeof clonePolicy>) => { policy.initialGrantCredits = 100_000; },
  (policy: ReturnType<typeof clonePolicy>) => { policy.entries.pop(); },
  (policy: ReturnType<typeof clonePolicy>) => { policy.entries.push({ ...policy.entries[0]! }); },
  (policy: ReturnType<typeof clonePolicy>) => { policy.entries[0]!.operation = "story.scene"; },
  (policy: ReturnType<typeof clonePolicy>) => { policy.entries[0]!.modality = "video"; },
  (policy: ReturnType<typeof clonePolicy>) => { policy.entries[0]!.provider = "changed-provider"; },
  (policy: ReturnType<typeof clonePolicy>) => { policy.entries[0]!.model = "changed-model"; },
  (policy: ReturnType<typeof clonePolicy>) => { policy.entries[0]!.providerCostMinor += 1; },
  (policy: ReturnType<typeof clonePolicy>) => { policy.entries[0]!.enabled = false; },
  (policy: ReturnType<typeof clonePolicy>) => { policy.entries[0]!.pricingMode = "provider_cost_v1"; },
  (policy: ReturnType<typeof clonePolicy>) => { policy.entries[0]!.fixedCredits = 2; },
  (policy: ReturnType<typeof clonePolicy>) => {
    Object.assign(policy.entries[0]!, { unexpected: true });
  },
] as const) {
  const hostile = clonePolicy(first.policy);
  mutate(hostile);
  expectContractBlocked(hostile);
}

const extraInput = {
  providerCurrency: "CNY",
  providerMinorUnitScale: 2,
  operationPins: pins,
  secret: "forbidden",
};
assert.throws(() => buildFixedBetaPricingCandidate(extraInput));
assert.throws(() => buildFixedBetaPricingCandidate(Object.assign(
  Object.create({ inherited: true }) as object,
  {
    providerCurrency: "CNY",
    providerMinorUnitScale: 2,
    operationPins: pins,
  },
)));
const accessorInput: Record<string, unknown> = {
  providerCurrency: "CNY",
  providerMinorUnitScale: 2,
};
Object.defineProperty(accessorInput, "operationPins", {
  enumerable: true,
  get: () => pins,
});
assert.throws(() => buildFixedBetaPricingCandidate(accessorInput));
const symbolInput: Record<PropertyKey, unknown> = {
  providerCurrency: "CNY",
  providerMinorUnitScale: 2,
  operationPins: pins,
};
symbolInput[Symbol("hidden")] = true;
assert.throws(() => buildFixedBetaPricingCandidate(symbolInput));
assert.throws(() => buildFixedBetaPricingCandidate(new Proxy({
  providerCurrency: "CNY",
  providerMinorUnitScale: 2,
  operationPins: pins,
}, {})));
const nonEnumerablePins = [...pins];
Object.defineProperty(nonEnumerablePins, "0", {
  value: nonEnumerablePins[0],
  enumerable: false,
  writable: true,
  configurable: true,
});
assert.throws(() => buildFixedBetaPricingCandidate({
  providerCurrency: "CNY",
  providerMinorUnitScale: 2,
  operationPins: nonEnumerablePins,
}));

const root = await mkdtemp(path.join(os.tmpdir(), "aistory-fixed-beta-pricing-"));
const storePath = path.join(root, "admin.json");
const repository = new LocalAdminRepository(storePath);
const actor: AdminActor = {
  userId: "fixed-beta-test-admin",
  roles: ["super_admin"],
  mode: "local",
};
const previousBillingFlag = process.env.AISTORY_PLATFORM_BILLING_ENABLED;
const previousLegacyPlatformFlag = process.env.AISTORY_PLATFORM_MANAGED_ENABLED;
const previousFixedPricingMode = process.env[FIXED_BETA_PRICING_MODE_ENV];
const previousFixedPricingVersion = process.env[FIXED_BETA_PRICING_VERSION_ENV];

try {
  let policyAccessorReads = 0;
  const accessorPolicy = clonePolicy(first.policy);
  Object.defineProperty(accessorPolicy.entries[0]!, "pricingMode", {
    enumerable: true,
    configurable: true,
    get: () => {
      policyAccessorReads += 1;
      return "fixed_beta_credit_v1";
    },
  });
  await assert.rejects(
    saveBillingPolicy(
      repository,
      actor,
      accessorPolicy,
      "拒绝访问器策略",
      "fixed-beta-accessor-policy",
    ),
    /固定测试定价合同无效/,
  );
  await assert.rejects(
    quotePlatformOperation({
      getBillingPolicy: async () => accessorPolicy as BillingPolicy,
    } as never, "story.start"),
    PricingUnavailableError,
  );
  assert.equal(policyAccessorReads, 0, "policy accessors must never execute");

  let policyProxyReads = 0;
  const proxyPolicy = new Proxy(clonePolicy(first.policy), {
    get(target, property, receiver) {
      // Promise resolution performs a mandatory thenable check on returned values.
      if (property === "then") return undefined;
      policyProxyReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  await assert.rejects(
    saveBillingPolicy(
      repository,
      actor,
      proxyPolicy,
      "拒绝代理策略",
      "fixed-beta-proxy-policy",
    ),
    /固定测试定价合同无效/,
  );
  await assert.rejects(
    quotePlatformOperation({
      getBillingPolicy: async () => proxyPolicy as BillingPolicy,
    } as never, "story.start"),
    PricingUnavailableError,
  );
  assert.equal(policyProxyReads, 0, "policy proxies must never execute traps");

  const policyWithSymbol = clonePolicy(first.policy) as Record<PropertyKey, unknown>;
  policyWithSymbol[Symbol("hidden")] = true;
  await assert.rejects(
    saveBillingPolicy(
      repository,
      actor,
      policyWithSymbol as never,
      "拒绝符号策略",
      "fixed-beta-symbol-policy",
    ),
    /固定测试定价合同无效/,
  );

  const providerCostEntries = first.policy.entries.map((entry) => ({
    operation: entry.operation,
    modality: entry.modality,
    provider: entry.provider,
    model: entry.model,
    providerCostMinor: entry.providerCostMinor,
    enabled: entry.enabled,
  }));
  const providerCostPolicy: BillingPolicy = {
    ...first.policy,
    version: "provider-cost-test-v1",
    entries: providerCostEntries,
    updatedAt: "2026-08-27T00:00:00.000Z",
    updatedBy: actor.userId,
  };
  process.env[FIXED_BETA_PRICING_MODE_ENV] = "unknown";
  await assert.rejects(
    quotePlatformOperation({
      getBillingPolicy: async () => providerCostPolicy,
    } as never, "story.start"),
    PricingUnavailableError,
    "an unknown global pricing mode must not fall back to provider-cost pricing",
  );
  process.env[FIXED_BETA_PRICING_MODE_ENV] = "disabled";
  assert.equal(
    (await quotePlatformOperation({
      getBillingPolicy: async () => providerCostPolicy,
    } as never, "story.start")).publicQuote.estimatedCredits,
    providerCostEntries[0]!.providerCostMinor,
  );
  for (const [index, malformedVersion] of [
    "fixed-beta-v1.BAD",
    `fixed-beta-v1.${"A".repeat(64)}`,
    `fixed-beta-v1.${"0".repeat(63)}`,
  ].entries()) {
    const downgradePolicy = {
      ...first.policy,
      version: malformedVersion,
      entries: providerCostEntries,
    };
    await assert.rejects(
      saveBillingPolicy(
        repository,
        actor,
        downgradePolicy,
        "拒绝固定定价族降级",
        `fixed-beta-downgrade-save-${index}`,
      ),
      /固定测试定价合同无效/,
    );
    const downgradeRepository = new LocalAdminRepository(
      path.join(root, `downgrade-${index}.json`),
    );
    await downgradeRepository.saveBillingPolicy({
      ...downgradePolicy,
      updatedAt: "2026-08-27T00:00:00.000Z",
      updatedBy: actor.userId,
    });
    await assert.rejects(
      quotePlatformOperation(downgradeRepository, "story.start"),
      PricingUnavailableError,
    );
  }

  process.env.AISTORY_PLATFORM_BILLING_ENABLED = "true";
  process.env.AISTORY_PLATFORM_MANAGED_ENABLED = "false";
  await assert.rejects(
    saveBillingPolicy(
      repository,
      actor,
      first.policy,
      "拒绝计费开启时写入",
      "fixed-beta-policy-save-blocked-formal",
    ),
    /只能在平台计费开关关闭时写入/,
  );
  process.env.AISTORY_PLATFORM_BILLING_ENABLED = "false";
  process.env.AISTORY_PLATFORM_MANAGED_ENABLED = "true";
  await assert.rejects(
    saveBillingPolicy(
      repository,
      actor,
      first.policy,
      "拒绝旧开关开启时写入",
      "fixed-beta-policy-save-blocked-legacy",
    ),
    /只能在平台计费开关关闭时写入/,
  );
  process.env.AISTORY_PLATFORM_MANAGED_ENABLED = "false";
  assert.equal((await repository.getBillingPolicy()).version, "unconfigured");
  await saveBillingPolicy(
    repository,
    actor,
    first.policy,
    "发布固定一积分本地候选",
    "fixed-beta-policy-save-1",
  );
  process.env.AISTORY_PLATFORM_BILLING_ENABLED = "true";
  delete process.env[FIXED_BETA_PRICING_MODE_ENV];
  delete process.env[FIXED_BETA_PRICING_VERSION_ENV];
  await assert.rejects(
    quoteFixed(repository, "story.start"),
    PricingUnavailableError,
    "missing fixed beta activation must fail before provider work",
  );
  process.env[FIXED_BETA_PRICING_MODE_ENV] = "unknown";
  process.env[FIXED_BETA_PRICING_VERSION_ENV] = first.policy.version;
  await assert.rejects(
    quoteFixed(repository, "story.start"),
    PricingUnavailableError,
    "unknown fixed beta mode must fail closed",
  );
  process.env[FIXED_BETA_PRICING_MODE_ENV] = FIXED_BETA_PRICING_MODE_CONFIG;
  process.env[FIXED_BETA_PRICING_VERSION_ENV] = `${first.policy.version}-drift`;
  await assert.rejects(
    quoteFixed(repository, "story.start"),
    PricingUnavailableError,
    "activation version must equal the content-addressed policy",
  );
  process.env[FIXED_BETA_PRICING_VERSION_ENV] = first.policy.version;
  process.env.AISTORY_PLATFORM_BILLING_ENABLED = "false";
  await assert.rejects(
    quoteFixed(repository, "story.start"),
    PricingUnavailableError,
    "the formal billing kill switch must remain an independent activation gate",
  );
  process.env.AISTORY_PLATFORM_BILLING_ENABLED = "true";
  await createUserWithInitialGrant(repository, {
    userId: "fixed-beta-test-user",
    tenantId: "platform",
    displayName: "Test User",
    status: "active",
    userType: "player",
  });
  await assert.rejects(
    quotePlatformOperation(repository, "story.start"),
    PricingUnavailableError,
    "fixed quote must reject a missing runtime binding",
  );
  await assert.rejects(
    reservePlatformOperation(repository, {
      userId: "fixed-beta-test-user",
      operation: "story.start",
      idempotencyKey: "fixed-beta-runtime-missing",
    }),
    PricingUnavailableError,
    "fixed pricing must reject a missing runtime binding before reserve",
  );
  await assert.rejects(
    reservePlatformOperation(repository, {
      userId: "fixed-beta-test-user",
      operation: "story.start",
      idempotencyKey: "fixed-beta-runtime-drift",
      runtimeConfig: {
        ...runtimeConfig,
        text: { ...runtimeConfig.text, model: "fixture-text-drift" },
      },
    }),
    PricingUnavailableError,
    "runtime model drift must fail closed before reserve",
  );
  assert.equal(
    (await repository.listLedger("fixed-beta-test-user"))
      .filter((entry) => entry.kind === "reserve").length,
    0,
  );
  assert.equal(
    await getServerCreditBalance(repository, "fixed-beta-test-user"),
    1_000,
    "fixed pricing must not change the ordinary registration grant",
  );
  assert.equal(
    (await repository.listLedger("fixed-beta-test-user"))
      .filter((entry) => entry.kind === "initial_grant").length,
    1,
  );

  for (const { operation, modality } of FIXED_BETA_OPERATION_CONTRACT) {
    const quote = await quoteFixed(repository, operation);
    assert.equal(quote.publicQuote.estimatedCredits, 1);
    assert.equal(quote.publicQuote.pricePolicyVersion, first.policy.version);
    assert.deepEqual(quote.publicQuote.modalities, [modality]);
    assert.equal(quote.publicQuote.responsibility, "platform_credits");
    assert.equal(
      /"(provider|model|providerCostMinor|receipt)"/i.test(
        JSON.stringify(quote.publicQuote),
      ),
      false,
      "public quote must remain provider/cost redacted",
    );
  }

  const reservation = await reserveFixed(repository, {
    userId: "fixed-beta-test-user",
    operation: "story.start",
    idempotencyKey: "fixed-beta-generation-001",
  });
  assert.equal(reservation.entry.amount, -1);
  assert.equal(reservation.replayed, false);
  assert.equal(reservation.entry.reservedCredits, 1);
  assert.match(reservation.entry.billingOperationId ?? "", /^[a-f0-9-]{36}$/);
  const replay = await reserveFixed(repository, {
    userId: "fixed-beta-test-user",
    operation: "story.start",
    idempotencyKey: "fixed-beta-generation-001",
  });
  assert.equal(replay.entry.id, reservation.entry.id);
  assert.equal(replay.replayed, true);
  assert.equal(replay.entry.billingOperationId, reservation.entry.billingOperationId);
  assert.equal(
    (await repository.listLedger("fixed-beta-test-user"))
      .filter((entry) => entry.kind === "reserve").length,
    1,
  );
  await assert.rejects(
    reserveFixed(repository, {
      userId: "fixed-beta-test-user",
      operation: "story.scene",
      idempotencyKey: "fixed-beta-generation-001",
    }),
    PricingUnavailableError,
    "the same idempotency key cannot be rebound to another operation",
  );

  const highCostSettlement = await settlePlatformOperation(
    repository,
    reservation,
    {
      providerCostMinor: 900_000,
      providerCurrency: "CNY",
      providerMinorUnitScale: 2,
    },
  );
  assert.equal(highCostSettlement.kind, "settle");
  assert.equal(highCostSettlement.amount, 0);
  assert.equal(highCostSettlement.reservedCredits, 1);
  assert.equal(highCostSettlement.settledCredits, 1);
  assert.equal(highCostSettlement.providerCostMinor, 900_000);
  assert.equal(highCostSettlement.costSource, "provider_settlement");
  assert.equal(
    await getServerCreditBalance(repository, "fixed-beta-test-user"),
    999,
    "provider receipt cost must not reprice fixed beta credits",
  );
  const terminalReplay = await settlePlatformOperation(
    repository,
    reservation,
    {
      providerCostMinor: 0,
      providerCurrency: "CNY",
      providerMinorUnitScale: 2,
    },
  );
  assert.equal(terminalReplay.id, highCostSettlement.id);
  assert.equal(terminalReplay.providerCostMinor, 900_000);

  for (const [operation, idempotencyKey, providerCostMinor] of [
    ["story.scene", "fixed-beta-generation-receipt-zero", 0],
    ["story.scene.prefetch", "fixed-beta-generation-receipt-low", 1],
  ] as const) {
    const receiptReservation = await reserveFixed(repository, {
      userId: "fixed-beta-test-user",
      operation,
      idempotencyKey,
    });
    const receiptSettlement = await settlePlatformOperation(
      repository,
      receiptReservation,
      {
        providerCostMinor,
        providerCurrency: "CNY",
        providerMinorUnitScale: 2,
      },
    );
    assert.equal(receiptSettlement.amount, 0);
    assert.equal(receiptSettlement.reservedCredits, 1);
    assert.equal(receiptSettlement.settledCredits, 1);
    assert.equal(receiptSettlement.providerCostMinor, providerCostMinor);
    assert.equal(receiptSettlement.costSource, "provider_settlement");
  }

  const catalogReservation = await reserveFixed(repository, {
    userId: "fixed-beta-test-user",
    operation: "tts.beat",
    idempotencyKey: "fixed-beta-generation-002",
  });
  const catalogSettlement = await settlePlatformOperation(
    repository,
    catalogReservation,
  );
  assert.equal(catalogSettlement.settledCredits, 1);
  assert.equal(catalogSettlement.amount, 0);
  assert.equal(catalogSettlement.costSource, "price_catalog");

  const refundedReservation = await reserveFixed(repository, {
    userId: "fixed-beta-test-user",
    operation: "vision.decide",
    idempotencyKey: "fixed-beta-generation-003",
  });
  const refund = await refundPlatformOperation(
    repository,
    refundedReservation,
    "synthetic provider did not start",
  );
  assert.equal(refund.kind, "refund");
  assert.equal(refund.amount, 1);
  assert.equal(refund.reservedCredits, 1);
  assert.equal(refund.settledCredits, 0);

  const invalidReceiptReservation = await reserveFixed(repository, {
    userId: "fixed-beta-test-user",
    operation: "style.redraw",
    idempotencyKey: "fixed-beta-generation-004",
  });
  const baseReceipt = {
    providerCostMinor: 1,
    providerCurrency: "CNY",
    providerMinorUnitScale: 2,
  };
  await assert.rejects(
    settlePlatformOperation(repository, invalidReceiptReservation, {
      ...baseReceipt,
      unexpected: true,
    } as unknown as ProviderSettlementReceipt),
    PricingUnavailableError,
  );
  let receiptAccessorReads = 0;
  const accessorReceipt: Record<string, unknown> = {
    providerCurrency: "CNY",
    providerMinorUnitScale: 2,
  };
  Object.defineProperty(accessorReceipt, "providerCostMinor", {
    enumerable: true,
    get: () => {
      receiptAccessorReads += 1;
      return 1;
    },
  });
  await assert.rejects(
    settlePlatformOperation(
      repository,
      invalidReceiptReservation,
      accessorReceipt as ProviderSettlementReceipt,
    ),
    PricingUnavailableError,
  );
  assert.equal(receiptAccessorReads, 0, "receipt accessors must never execute");
  let receiptProxyReads = 0;
  const proxyReceipt = new Proxy(baseReceipt, {
    get(target, property, receiver) {
      receiptProxyReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  await assert.rejects(
    settlePlatformOperation(repository, invalidReceiptReservation, proxyReceipt),
    PricingUnavailableError,
  );
  assert.equal(receiptProxyReads, 0, "receipt proxies must never execute traps");
  const symbolReceipt = { ...baseReceipt } as Record<PropertyKey, unknown>;
  symbolReceipt[Symbol("hidden")] = true;
  await assert.rejects(
    settlePlatformOperation(
      repository,
      invalidReceiptReservation,
      symbolReceipt as ProviderSettlementReceipt,
    ),
    PricingUnavailableError,
  );
  await assert.rejects(
    settlePlatformOperation(repository, invalidReceiptReservation, {
      providerCostMinor: -1,
      providerCurrency: "CNY",
      providerMinorUnitScale: 2,
    }),
    PricingUnavailableError,
  );
  await assert.rejects(
    settlePlatformOperation(repository, invalidReceiptReservation, {
      providerCostMinor: 1,
      providerCurrency: "USD",
      providerMinorUnitScale: 2,
    }),
    PricingUnavailableError,
  );
  await refundPlatformOperation(
    repository,
    invalidReceiptReservation,
    "synthetic receipt rejected",
  );

  await createUserWithInitialGrant(repository, {
    userId: "fixed-beta-receipt-replay-user",
    tenantId: "platform",
    displayName: "Receipt Replay User",
    status: "active",
    userType: "player",
  });
  const uncertainReceiptReservation = await reserveFixed(repository, {
    userId: "fixed-beta-receipt-replay-user",
    operation: "story.start",
    idempotencyKey: "fixed-beta-receipt-uncertain",
  });
  const uncertainReceiptContext: GenerationBillingContext = {
    mode: "platform_managed",
    reservation: uncertainReceiptReservation,
    providerOutcome: "not_started",
  };
  const uncertainReceipt = {
    providerCostMinor: 456_789,
    providerCurrency: "CNY",
    providerMinorUnitScale: 2,
  };
  markGenerationBillingProviderStarted(uncertainReceiptContext);
  markGenerationBillingProviderSucceeded(
    uncertainReceiptContext,
    uncertainReceipt,
  );
  await assert.rejects(
    settleGenerationBilling(uncertainReceiptContext, {
      providerReceipt: {
        ...uncertainReceipt,
        providerCostMinor: uncertainReceipt.providerCostMinor + 1,
      },
      repository,
    }),
    PricingUnavailableError,
    "a pinned provider receipt cannot be replaced before terminal persistence",
  );
  let uncertainTerminalAttempts = 0;
  const uncertainRepository = new Proxy(repository, {
    get(target, property, receiver) {
      if (property === "appendBillingTerminal") {
        return async () => {
          uncertainTerminalAttempts += 1;
          throw new Error("SYNTHETIC_UNCERTAIN_TERMINAL");
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as AdminRepository;
  await assert.rejects(
    settleGenerationBilling(uncertainReceiptContext, {
      repository: uncertainRepository,
    }),
    /SYNTHETIC_UNCERTAIN_TERMINAL/,
  );
  assert.equal(uncertainTerminalAttempts, 1);
  assert.equal(
    await refundGenerationBilling(
      uncertainReceiptContext,
      "synthetic post-provider local failure",
      { repository },
    ),
    "settle",
    "a succeeded retry must preserve the pinned receipt and never refund",
  );
  const uncertainReceiptTerminal = (await repository.listLedger(
    "fixed-beta-receipt-replay-user",
  )).find((entry) => entry.kind === "settle");
  assert.equal(uncertainReceiptTerminal?.providerCostMinor, 456_789);
  assert.equal(uncertainReceiptTerminal?.costSource, "provider_settlement");
  assert.equal(uncertainReceiptTerminal?.settledCredits, 1);

  const contextFor = (
    fixedReservation: Awaited<ReturnType<typeof reservePlatformOperation>>,
  ): GenerationBillingContext => ({
    mode: "platform_managed",
    reservation: fixedReservation,
    providerOutcome: "not_started",
  });

  const knownNotStartedReservation = await reserveFixed(repository, {
    userId: "fixed-beta-test-user",
    operation: "story.classify-freeform",
    idempotencyKey: "fixed-beta-known-not-started",
  });
  process.env.AISTORY_PLATFORM_BILLING_ENABLED = "false";
  process.env[FIXED_BETA_PRICING_MODE_ENV] = "disabled";
  delete process.env[FIXED_BETA_PRICING_VERSION_ENV];
  assert.equal(
    await refundGenerationBilling(
      contextFor(knownNotStartedReservation),
      "synthetic callback was not entered",
      { providerNotStarted: true, repository },
    ),
    "refund",
  );
  process.env.AISTORY_PLATFORM_BILLING_ENABLED = "true";
  process.env[FIXED_BETA_PRICING_MODE_ENV] = FIXED_BETA_PRICING_MODE_CONFIG;
  process.env[FIXED_BETA_PRICING_VERSION_ENV] = first.policy.version;

  const unknownReservation = await reserveFixed(repository, {
    userId: "fixed-beta-test-user",
    operation: "story.insert-beat",
    idempotencyKey: "fixed-beta-provider-unknown",
  });
  const unknownContext = contextFor(unknownReservation);
  markGenerationBillingProviderStarted(unknownContext);
  assert.equal(
    await refundGenerationBilling(
      unknownContext,
      "synthetic provider timeout",
      { providerNotStarted: true, repository },
    ),
    "pending",
    "a caller assertion must not overwrite provider-started state",
  );
  assert.equal(
    await settleGenerationBilling(unknownContext, { repository }),
    "pending",
  );
  assert.equal(
    (await repository.listLedger("fixed-beta-test-user")).filter(
      (entry) =>
        entry.billingOperationId === unknownReservation.entry.billingOperationId
        && (entry.kind === "settle" || entry.kind === "refund"),
    ).length,
    0,
    "unknown provider outcome must remain reserve-only pending",
  );

  const succeededReservation = await reserveFixed(repository, {
    userId: "fixed-beta-test-user",
    operation: "vision.style-parse",
    idempotencyKey: "fixed-beta-provider-succeeded",
  });
  const succeededContext = contextFor(succeededReservation);
  markGenerationBillingProviderStarted(succeededContext);
  markGenerationBillingProviderSucceeded(succeededContext);
  process.env.AISTORY_PLATFORM_BILLING_ENABLED = "false";
  process.env[FIXED_BETA_PRICING_MODE_ENV] = "disabled";
  delete process.env[FIXED_BETA_PRICING_VERSION_ENV];
  const aborted = new AbortController();
  aborted.abort();
  assert.equal(
    await settleGenerationBilling(succeededContext, {
      requestSignal: aborted.signal,
      repository,
    }),
    "settle",
    "a late client abort must not refund a trusted provider result",
  );
  process.env.AISTORY_PLATFORM_BILLING_ENABLED = "true";
  process.env[FIXED_BETA_PRICING_MODE_ENV] = FIXED_BETA_PRICING_MODE_CONFIG;
  process.env[FIXED_BETA_PRICING_VERSION_ENV] = first.policy.version;

  const postProviderFailureReservation = await reserveFixed(repository, {
    userId: "fixed-beta-test-user",
    operation: "text.character-names",
    idempotencyKey: "fixed-beta-post-provider-failure",
  });
  const postProviderFailureContext = contextFor(postProviderFailureReservation);
  markGenerationBillingProviderStarted(postProviderFailureContext);
  markGenerationBillingProviderSucceeded(postProviderFailureContext);
  assert.equal(
    await refundGenerationBilling(
      postProviderFailureContext,
      "synthetic local parser failure after provider result",
      { repository },
    ),
    "settle",
    "local post-processing failure must not erase a completed provider charge",
  );

  const concurrentKey = "fixed-beta-concurrent-reserve";
  const concurrentReservations = await Promise.all([
    reserveFixed(repository, {
      userId: "fixed-beta-test-user",
      operation: "style.rewrite",
      idempotencyKey: concurrentKey,
    }),
    reserveFixed(repository, {
      userId: "fixed-beta-test-user",
      operation: "style.rewrite",
      idempotencyKey: concurrentKey,
    }),
  ]);
  assert.equal(concurrentReservations.filter(({ replayed }) => !replayed).length, 1);
  assert.equal(concurrentReservations.filter(({ replayed }) => replayed).length, 1);
  const concurrentCreated = concurrentReservations.find(({ replayed }) => !replayed)!;
  assert.equal(
    await refundGenerationBilling(
      contextFor(concurrentCreated),
      "synthetic single-flight follower test cleanup",
      { providerNotStarted: true, repository },
    ),
    "refund",
  );

  await createUserWithInitialGrant(repository, {
    userId: "fixed-beta-low-balance-user",
    tenantId: "platform",
    displayName: "Low Balance User",
    status: "active",
    userType: "player",
  });
  await adjustCredits(repository, actor, {
    userId: "fixed-beta-low-balance-user",
    amount: -999,
    reason: "synthetic low balance setup",
    idempotencyKey: "fixed-beta-low-balance-adjustment",
    requestId: "fixed-beta-low-balance-request",
  });
  const lastCreditReservation = await reserveFixed(repository, {
    userId: "fixed-beta-low-balance-user",
    operation: "story.start",
    idempotencyKey: "fixed-beta-last-credit",
  });
  await assert.rejects(
    reserveFixed(repository, {
      userId: "fixed-beta-low-balance-user",
      operation: "story.scene",
      idempotencyKey: "fixed-beta-insufficient-credit",
    }),
    InsufficientCreditsError,
  );
  await refundGenerationBilling(
    contextFor(lastCreditReservation),
    "synthetic low balance cleanup",
    { providerNotStarted: true, repository },
  );
  const racedReservation = await reserveFixed(repository, {
    userId: "fixed-beta-low-balance-user",
    operation: "story.scene",
    idempotencyKey: "fixed-beta-terminal-race",
  });
  const racedSucceeded = contextFor(racedReservation);
  markGenerationBillingProviderStarted(racedSucceeded);
  markGenerationBillingProviderSucceeded(racedSucceeded);
  const [racedSettle, racedRefund] = await Promise.all([
    settleGenerationBilling(racedSucceeded, { repository }),
    refundGenerationBilling(
      contextFor(racedReservation),
      "synthetic conflicting terminal race",
      { providerNotStarted: true, repository },
    ),
  ]);
  assert.equal(racedSettle, racedRefund);
  assert.equal(
    (await repository.listLedger("fixed-beta-low-balance-user")).filter(
      (entry) =>
        entry.billingOperationId === racedReservation.entry.billingOperationId
        && (entry.kind === "settle" || entry.kind === "refund"),
    ).length,
    1,
    "concurrent opposite terminals must preserve first-wins atomicity",
  );

  const changedPins = pins.map((pin, index) => index === 0
    ? { ...pin, providerCostMinor: pin.providerCostMinor + 1 }
    : pin);
  const changedCandidate = candidateFrom(changedPins);
  assert.notEqual(changedCandidate.policy.version, first.policy.version);
  await repository.saveBillingPolicy({
    ...changedCandidate.policy,
    updatedAt: "9999-12-31T23:59:59.999Z",
    updatedBy: actor.userId,
  });
  process.env[FIXED_BETA_PRICING_VERSION_ENV] = changedCandidate.policy.version;
  await assert.rejects(
    reserveFixed(repository, {
      userId: "fixed-beta-test-user",
      operation: "story.start",
      idempotencyKey: "fixed-beta-generation-001",
    }),
    PricingUnavailableError,
    "an idempotency replay cannot be rebound to a new policy snapshot",
  );
  assert.equal(
    (await repository.listLedger("fixed-beta-test-user"))
      .filter((entry) => entry.kind === "reserve").length,
    11,
  );
  assert.equal(await getServerCreditBalance(repository, "fixed-beta-test-user"), 993);

  process.env.AISTORY_PLATFORM_BILLING_ENABLED = "false";
  process.env.AISTORY_PLATFORM_MANAGED_ENABLED = "false";
  const disabledPlatform = await prepareGenerationBilling({
    request: new Request("https://aistory.invalid/api/start", {
      method: "POST",
      headers: { "X-Idempotency-Key": "fixed-beta-disabled-001" },
    }),
    auth: { userId: "fixed-beta-test-user", authType: "phone" },
    requestedMode: "platform_managed",
    hasByok: false,
    operation: "story.start",
  });
  assert.ok(disabledPlatform instanceof Response);
  assert.equal(
    (await disabledPlatform.json() as { code?: string }).code,
    "PLATFORM_MANAGED_DISABLED",
  );

  process.env.AISTORY_PLATFORM_BILLING_ENABLED = "true";
  const byok = await prepareGenerationBilling({
    request: new Request("https://aistory.invalid/api/start", {
      method: "POST",
    }),
    auth: { userId: "anonymous", authType: "anonymous" },
    requestedMode: "user_byok",
    hasByok: true,
    operation: "story.start",
  });
  assert.equal(byok instanceof Response, false);
  if (!(byok instanceof Response)) {
    assert.equal(byok.mode, "user_byok");
    assert.equal(byok.reservation, undefined);
  }

  const ledgerCountBeforeCredentialConflict = (
    await repository.listLedger("fixed-beta-test-user")
  ).length;
  const credentialConflict = await prepareGenerationBilling({
    request: new Request("https://aistory.invalid/api/start", {
      method: "POST",
      headers: { "X-Idempotency-Key": "fixed-beta-mode-conflict" },
    }),
    auth: { userId: "fixed-beta-test-user", authType: "phone" },
    requestedMode: "platform_managed",
    hasByok: true,
    operation: "story.start",
  });
  assert.ok(credentialConflict instanceof Response);
  assert.equal(credentialConflict.status, 400);
  assert.equal(
    (await credentialConflict.json() as { code?: string }).code,
    "CREDENTIAL_MODE_CONFLICT",
  );
  assert.equal(
    (await repository.listLedger("fixed-beta-test-user")).length,
    ledgerCountBeforeCredentialConflict,
    "a BYOK/platform conflict must not reserve platform credits",
  );

  const persisted = await readFile(storePath, "utf8");
  assert.equal(/100000/.test(persisted), false, "membership grant must not enter policy/store");
  assert.equal(
    /secret|token|api[_-]?key|1[3-9][0-9]{9}/i.test(JSON.stringify(first)),
    false,
  );
} finally {
  if (previousBillingFlag === undefined) {
    delete process.env.AISTORY_PLATFORM_BILLING_ENABLED;
  } else {
    process.env.AISTORY_PLATFORM_BILLING_ENABLED = previousBillingFlag;
  }
  if (previousLegacyPlatformFlag === undefined) {
    delete process.env.AISTORY_PLATFORM_MANAGED_ENABLED;
  } else {
    process.env.AISTORY_PLATFORM_MANAGED_ENABLED = previousLegacyPlatformFlag;
  }
  if (previousFixedPricingMode === undefined) {
    delete process.env[FIXED_BETA_PRICING_MODE_ENV];
  } else {
    process.env[FIXED_BETA_PRICING_MODE_ENV] = previousFixedPricingMode;
  }
  if (previousFixedPricingVersion === undefined) {
    delete process.env[FIXED_BETA_PRICING_VERSION_ENV];
  } else {
    process.env[FIXED_BETA_PRICING_VERSION_ENV] = previousFixedPricingVersion;
  }
  globalThis.fetch = originalFetch;
  await rm(root, { recursive: true, force: true });
}

const emptyRepository = new LocalAdminRepository(
  path.join(os.tmpdir(), `aistory-fixed-beta-missing-${process.pid}.json`),
);
await assert.rejects(
  quotePlatformOperation(emptyRepository, "story.start"),
  PricingUnavailableError,
);
assert.equal(fetchCalls, 0);

console.log("fixed beta pricing candidate tests passed");
