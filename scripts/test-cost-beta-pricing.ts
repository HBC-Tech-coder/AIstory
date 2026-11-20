import assert from "node:assert/strict";

import {
  assertCostBetaPricingActivation,
  assertCostBetaPricingPolicy,
  betaCreditsFromCostFen,
  buildCostBetaPricingCandidate,
  buildCostBetaPricingCandidateFromRates,
  COST_BETA_FRIEND_REGISTRATION_GRANT_CREDITS,
  COST_BETA_OFFICIAL_RATE_SOURCES,
  COST_BETA_ORDINARY_REGISTRATION_GRANT_CREDITS,
  COST_BETA_PRICING_MODE,
  COST_BETA_PRICING_MODE_CONFIG,
  COST_BETA_PRICING_MODE_ENV,
  COST_BETA_PRICING_VERSION_ENV,
  COST_BETA_PRICING_VERSION_PREFIX,
  COST_BETA_RATE_CATALOG_SCHEMA,
  COST_BETA_RUNTIME_BINDING_PROVIDER,
  CostBetaPricingContractError,
  costBetaPricingFingerprint,
  costBetaRuntimeBindingForOperation,
  formalCreditsFromCostFen,
  isCostBetaPricingModeRequested,
  isCostBetaPricingVersion,
  type CostBetaPricingCandidate,
} from "../lib/billing/costBetaPricing";
import { FIXED_BETA_PRICING_MODE_CONFIG, type FixedBetaRuntimeConfig } from "../lib/billing/fixedBetaPricing";
import { PLATFORM_COST_ENVELOPE_SPEC } from "../lib/billing/platformCostEnvelope";
import {
  PLATFORM_CANONICAL_PROVIDER_BINDINGS,
  PLATFORM_LIVE_PROVIDER_BINDINGS,
  platformCostEnvelopeFingerprint,
} from "../lib/billing/platformCostEnvelopeServer";

type BindingSet = {
  text: { provider: string; model: string; baseUrl: string };
  image: { provider: string; model: string; baseUrl: string };
  vision: { provider: string; model: string; baseUrl: string };
  tts: { provider: string; model: string; baseUrl: string };
};

function makeRuntime(
  bindings: BindingSet = PLATFORM_CANONICAL_PROVIDER_BINDINGS,
): FixedBetaRuntimeConfig {
  return {
    text: { ...bindings.text, apiKey: "test" },
    image: { ...bindings.image, apiKey: "test" },
    vision: { ...bindings.vision, apiKey: "test" },
    tts: {
      provider: bindings.tts.provider,
      speechModel: bindings.tts.model,
      baseUrl: bindings.tts.baseUrl,
      apiKey: "test",
    },
  };
}

type Rate = {
  role: "text" | "image" | "vision" | "tts";
  inputMinorPerMillionTokens: number;
  outputMinorPerMillionTokens: number;
  imageMinorEach: number;
  imageInputTokensMax: number;
  ttsMinorPerTenThousandCharacters: number;
};

function makeRates(): Rate[] {
  return [
    {
      role: "text",
      inputMinorPerMillionTokens: 1_000,
      outputMinorPerMillionTokens: 2_000,
      imageMinorEach: 0,
      imageInputTokensMax: 0,
      ttsMinorPerTenThousandCharacters: 0,
    },
    {
      role: "image",
      inputMinorPerMillionTokens: 0,
      outputMinorPerMillionTokens: 0,
      imageMinorEach: 2_500,
      imageInputTokensMax: 0,
      ttsMinorPerTenThousandCharacters: 0,
    },
    {
      role: "vision",
      inputMinorPerMillionTokens: 1_000,
      outputMinorPerMillionTokens: 2_000,
      // Vision is token-priced from the whole-request ceiling; no per-image
      // monetary or per-image-token rate is accepted.
      imageMinorEach: 0,
      imageInputTokensMax: 0,
      ttsMinorPerTenThousandCharacters: 0,
    },
    {
      role: "tts",
      inputMinorPerMillionTokens: 0,
      outputMinorPerMillionTokens: 0,
      imageMinorEach: 0,
      imageInputTokensMax: 0,
      ttsMinorPerTenThousandCharacters: 100,
    },
  ];
}

function makeRateCatalog(rates: Rate[] = makeRates()) {
  return {
    schema: COST_BETA_RATE_CATALOG_SCHEMA,
    version: "test-cny-rates-v1",
    status: "VERIFIED",
    currency: "CNY",
    minorUnitScale: 2,
    effectiveOn: "2026-10-21",
    verifiedOn: "2026-10-21",
    sourceIds: ["test-official-price-evidence"],
    rates,
  };
}

function buildFromRates(
  rateCatalog: unknown = makeRateCatalog(),
  runtime: FixedBetaRuntimeConfig = makeRuntime(),
  phase: "beta" | "formal" = "beta",
): CostBetaPricingCandidate {
  return buildCostBetaPricingCandidateFromRates(
    {
      providerCurrency: "CNY",
      providerMinorUnitScale: 2,
      rateCatalog,
      runtime,
    },
    phase,
  );
}

function pin(candidate: CostBetaPricingCandidate, operation: string) {
  const found = candidate.operations.find(
    (entry) => entry.operation === operation,
  );
  assert.ok(found, `missing operation pin ${operation}`);
  return found;
}

function entry(candidate: CostBetaPricingCandidate, operation: string) {
  const found = candidate.policy.entries.find(
    (candidateEntry) => candidateEntry.operation === operation,
  );
  assert.ok(found, `missing policy entry ${operation}`);
  return found;
}

type Test = readonly [name: string, fn: () => Promise<void> | void];

const tests: Test[] = [
  [
    "beta/formal conversion: 1 fen -> 1 vs 10, 10000 fen -> 1000 vs 10000",
    () => {
      assert.equal(betaCreditsFromCostFen(1), 1);
      assert.equal(formalCreditsFromCostFen(1), 10);
      assert.equal(betaCreditsFromCostFen(10_000), 1_000);
      assert.equal(formalCreditsFromCostFen(10_000), 10_000);
      assert.equal(betaCreditsFromCostFen(0), 0);
      assert.equal(formalCreditsFromCostFen(0), 0);
      assert.throws(() => betaCreditsFromCostFen(-1), CostBetaPricingContractError);
      assert.throws(() => betaCreditsFromCostFen(1.5), CostBetaPricingContractError);
    },
  ],
  [
    "official beta candidate: 11 immutable entries with pinned official costs",
    () => {
      const candidate = buildCostBetaPricingCandidate(makeRuntime(), "beta");
      assert.ok(Object.isFrozen(candidate));
      assert.ok(Object.isFrozen(candidate.policy));
      assert.ok(Object.isFrozen(candidate.policy.entries));
      assert.ok(Object.isFrozen(candidate.operations));
      assert.equal(candidate.operationCount, 11);
      assert.equal(candidate.policy.entries.length, 11);
      assert.equal(candidate.pricingMode, COST_BETA_PRICING_MODE);
      assert.equal(candidate.phase, "beta");
      assert.equal(candidate.policy.initialGrantCredits, 1_000);
      assert.match(candidate.fingerprint, /^[a-f0-9]{64}$/);
      assert.match(candidate.envelopeFingerprint, /^sha256:[a-f0-9]{64}$/);
      assert.equal(
        candidate.rateCatalog.sources,
        COST_BETA_OFFICIAL_RATE_SOURCES,
      );

      // Official rate facts (fen): text 80/200 per 1M, image 50 each,
      // vision 80/200 per 1M, tts 80 per 10k.
      assert.equal(pin(candidate, "style.redraw").providerCostMinor, 200);
      assert.equal(pin(candidate, "style.redraw").betaCredits, 20);
      assert.equal(pin(candidate, "style.rewrite").providerCostMinor, 8);
      assert.equal(pin(candidate, "style.rewrite").betaCredits, 1);
      assert.equal(pin(candidate, "tts.beat").providerCostMinor, 16);
      assert.equal(pin(candidate, "tts.beat").betaCredits, 2);
      // Whole-request vision pricing: 129,024 input tokens at 80 fen/1M
      // (ceil 11) + 4,096 output tokens at 200 fen/1M (ceil 1) = 12 fen.
      // 12 fen -> ceil(12/10) = 2 beta credits -> 20 formal credits.
      assert.equal(pin(candidate, "vision.decide").providerCostMinor, 12);
      assert.equal(pin(candidate, "vision.decide").betaCredits, 2);
      assert.equal(pin(candidate, "vision.decide").formalCredits, 20);
      assert.equal(pin(candidate, "vision.style-parse").betaCredits, 2);
      assert.equal(pin(candidate, "story.start").providerCostMinor, 396);
      assert.equal(pin(candidate, "story.start").betaCredits, 40);
      assert.equal(
        pin(candidate, "story.scene").providerCostMinor,
        380,
      );
    },
  ],
  [
    "policy uses only standard BillingPolicy fields and pinned entry hashes",
    () => {
      const candidate = buildCostBetaPricingCandidate(makeRuntime(), "beta");
      const policy = candidate.policy;
      assert.deepEqual(
        Object.keys(policy).sort(),
        [
          "creditUnitsPerProviderMinor",
          "entries",
          "initialGrantCredits",
          "markupBasisPoints",
          "providerCurrency",
          "providerMinorUnitScale",
          "version",
        ],
      );
      assert.ok(isCostBetaPricingVersion(policy.version));
      assert.ok(policy.version.startsWith(COST_BETA_PRICING_VERSION_PREFIX));
      for (const item of policy.entries) {
        assert.deepEqual(
          Object.keys(item).sort(),
          [
            "enabled",
            "fixedCredits",
            "modality",
            "model",
            "operation",
            "pricingMode",
            "provider",
            "providerCostMinor",
          ],
        );
        assert.equal(item.provider, COST_BETA_RUNTIME_BINDING_PROVIDER);
        assert.match(item.model, /^sha256:[a-f0-9]{64}$/);
        assert.equal(item.pricingMode, COST_BETA_PRICING_MODE);
        assert.equal(item.fixedCredits, betaCreditsFromCostFen(item.providerCostMinor));
        assert.equal(
          item.model,
          costBetaRuntimeBindingForOperation(
            item.operation,
            makeRuntime(),
          ).model,
        );
      }
    },
  ],
  [
    "formal policy consumes exactly 10x beta per operation",
    () => {
      const beta = buildCostBetaPricingCandidate(makeRuntime(), "beta");
      const formal = buildCostBetaPricingCandidate(makeRuntime(), "formal");
      assert.equal(formal.phase, "formal");
      assert.ok(formal.policy.version.startsWith(`${COST_BETA_PRICING_VERSION_PREFIX}formal.`));
      assert.notEqual(formal.policy.version, beta.policy.version);
      for (const betaEntry of beta.policy.entries) {
        const formalEntry = entry(formal, betaEntry.operation);
        assert.equal(formalEntry.providerCostMinor, betaEntry.providerCostMinor);
        assert.equal(formalEntry.fixedCredits, betaEntry.fixedCredits * 10);
        assert.equal(formalEntry.fixedCredits, formalCreditsFromCostFen(betaEntry.providerCostMinor));
      }
    },
  ],
  [
    "policy assertion accepts rebuilt policies and rejects mutations",
    () => {
      const beta = buildCostBetaPricingCandidate(makeRuntime(), "beta");
      const formal = buildCostBetaPricingCandidate(makeRuntime(), "formal");
      assert.doesNotThrow(() => assertCostBetaPricingPolicy(beta.policy));
      assert.doesNotThrow(() => assertCostBetaPricingPolicy(formal.policy));

      const clone = JSON.parse(JSON.stringify(beta.policy)) as {
        entries: Array<{ providerCostMinor: number }>;
      };
      clone.entries[0]!.providerCostMinor += 1;
      assert.throws(
        () => assertCostBetaPricingPolicy(clone),
        CostBetaPricingContractError,
      );

      const fixedChanged = JSON.parse(JSON.stringify(beta.policy)) as {
        entries: Array<{ fixedCredits: number }>;
      };
      fixedChanged.entries[0]!.fixedCredits += 1;
      assert.throws(
        () => assertCostBetaPricingPolicy(fixedChanged),
        CostBetaPricingContractError,
      );

      const versionChanged = JSON.parse(JSON.stringify(beta.policy)) as {
        version: string;
      };
      versionChanged.version = `${COST_BETA_PRICING_VERSION_PREFIX}beta.${"0".repeat(64)}`;
      assert.throws(
        () => assertCostBetaPricingPolicy(versionChanged),
        CostBetaPricingContractError,
      );

      // Strong runtime pin: a well-formed but un-authorized binding hash is
      // rejected, even if the version string is unchanged.
      const unknownRuntime = JSON.parse(JSON.stringify(beta.policy)) as {
        entries: Array<{ model: string }>;
      };
      unknownRuntime.entries[0]!.model = `sha256:${"a".repeat(64)}`;
      assert.throws(
        () => assertCostBetaPricingPolicy(unknownRuntime),
        CostBetaPricingContractError,
      );

      const extraField = JSON.parse(JSON.stringify(beta.policy)) as Record<string, unknown>;
      extraField.rateCatalog = "nope";
      assert.throws(
        () => assertCostBetaPricingPolicy(extraField),
        CostBetaPricingContractError,
      );
    },
  ],
  [
    "version helpers and env activation",
    () => {
      const candidate = buildCostBetaPricingCandidate(makeRuntime(), "beta");
      assert.ok(isCostBetaPricingVersion(candidate.policy.version));
      assert.equal(isCostBetaPricingVersion("fixed-beta-v1.x"), false);
      assert.equal(isCostBetaPricingVersion(`${COST_BETA_PRICING_VERSION_PREFIX}beta.short`), false);

      const env = {
        AISTORY_PLATFORM_BILLING_ENABLED: "true",
        [COST_BETA_PRICING_MODE_ENV]: COST_BETA_PRICING_MODE_CONFIG,
        [COST_BETA_PRICING_VERSION_ENV]: candidate.policy.version,
      };
      assert.doesNotThrow(() => assertCostBetaPricingActivation(candidate.policy, env));
      assert.equal(isCostBetaPricingModeRequested(env), true);
      assert.equal(
        isCostBetaPricingModeRequested({ [COST_BETA_PRICING_MODE_ENV]: "" }),
        false,
      );
      // Recognized legacy v1 selector belongs to the fixed-beta lane.
      assert.equal(
        isCostBetaPricingModeRequested({
          [COST_BETA_PRICING_MODE_ENV]: FIXED_BETA_PRICING_MODE_CONFIG,
        }),
        false,
      );
      assert.throws(
        () => assertCostBetaPricingActivation(candidate.policy, {
          ...env,
          [COST_BETA_PRICING_VERSION_ENV]: `${candidate.policy.version}0`,
        }),
        Error,
      );
      assert.throws(
        () => isCostBetaPricingModeRequested({
          [COST_BETA_PRICING_MODE_ENV]: "wrong",
        }),
        Error,
      );
    },
  ],
  [
    "injected rate catalog: 4 x 2500 fen image = 10000 fen -> 1000 / 10000",
    () => {
      const beta = buildFromRates(makeRateCatalog(), makeRuntime(), "beta");
      const formal = buildFromRates(makeRateCatalog(), makeRuntime(), "formal");
      assert.equal(pin(beta, "style.redraw").providerCostMinor, 10_000);
      assert.equal(pin(beta, "style.redraw").betaCredits, 1_000);
      assert.equal(entry(formal, "style.redraw").fixedCredits, 10_000);
      assert.equal(entry(beta, "style.redraw").fixedCredits, 1_000);
      // 129,024 input @ 1000 fen/1M = 130 + 4,096 output @ 2000 fen/1M = 9.
      assert.equal(pin(beta, "vision.decide").providerCostMinor, 139);
      assert.equal(pin(beta, "vision.decide").betaCredits, 14);
      assert.equal(pin(beta, "style.rewrite").providerCostMinor, 86);
      assert.equal(pin(beta, "tts.beat").providerCostMinor, 20);
    },
  ],
  [
    "fingerprint changes when rates, runtime or envelope pins change",
    () => {
      const baseline = buildFromRates();
      const rates = makeRates();
      rates[1]!.imageMinorEach = 2_501;
      const changedRates = buildFromRates(makeRateCatalog(rates));
      assert.notEqual(changedRates.fingerprint, baseline.fingerprint);
      assert.notEqual(changedRates.policy.version, baseline.policy.version);

      // The runtime pin changes when the authorized endpoint set changes; an
      // unknown model/endpoint is rejected outright (covered separately).
      const changedRuntime = buildFromRates(
        makeRateCatalog(),
        makeRuntime(PLATFORM_LIVE_PROVIDER_BINDINGS),
      );
      assert.notEqual(changedRuntime.fingerprint, baseline.fingerprint);

      const alteredSpec = {
        ...PLATFORM_COST_ENVELOPE_SPEC,
        image: {
          ...PLATFORM_COST_ENVELOPE_SPEC.image,
          maxPixels: 1_000_000,
        },
      };
      assert.notEqual(
        platformCostEnvelopeFingerprint(alteredSpec),
        baseline.envelopeFingerprint,
      );
    },
  ],
  [
    "live authorized endpoint and canonical endpoint both bind",
    () => {
      const canonical = buildCostBetaPricingCandidate(makeRuntime(), "beta");
      const live = buildCostBetaPricingCandidate(
        makeRuntime(PLATFORM_LIVE_PROVIDER_BINDINGS),
        "beta",
      );
      assert.notEqual(live.fingerprint, canonical.fingerprint);
      assert.equal(live.policy.entries.length, 11);
      assert.doesNotThrow(() => assertCostBetaPricingPolicy(live.policy));
      assert.doesNotThrow(() => assertCostBetaPricingPolicy(canonical.policy));
    },
  ],
  [
    "grants are metadata only; no writes/network",
    () => {
      const candidate = buildCostBetaPricingCandidate(makeRuntime(), "beta");
      assert.equal(
        candidate.ordinaryRegistrationGrantCredits,
        COST_BETA_ORDINARY_REGISTRATION_GRANT_CREDITS,
      );
      assert.equal(candidate.ordinaryRegistrationGrantCredits, 1_000);
      assert.equal(
        candidate.friendRegistrationGrantCredits,
        COST_BETA_FRIEND_REGISTRATION_GRANT_CREDITS,
      );
      assert.equal(candidate.friendRegistrationGrantCredits, 2_000);
      assert.equal(candidate.grantsAreMetadataOnly, true);
      assert.equal(candidate.productionWriteAllowed, false);
      assert.equal(candidate.networkCalls, 0);
      assert.equal(candidate.writesPerformed, 0);
      assert.equal(candidate.providerContacted, false);
    },
  ],
  [
    "missing rate role / unverified / zero rates fail closed",
    () => {
      assert.throws(
        () => buildFromRates(makeRateCatalog(makeRates().slice(0, 3))),
        CostBetaPricingContractError,
      );

      const draft = makeRateCatalog() as { status: string };
      draft.status = "DRAFT";
      assert.throws(() => buildFromRates(draft), CostBetaPricingContractError);

      const zero = makeRates();
      zero[0]!.inputMinorPerMillionTokens = 0;
      assert.throws(
        () => buildFromRates(makeRateCatalog(zero)),
        CostBetaPricingContractError,
      );

      const noVisionInput = makeRates();
      noVisionInput[2]!.inputMinorPerMillionTokens = 0;
      assert.throws(
        () => buildFromRates(makeRateCatalog(noVisionInput)),
        CostBetaPricingContractError,
      );

      // Vision is token-priced; a per-image monetary/token rate is rejected
      // rather than silently ignored.
      const visionPerImage = makeRates();
      visionPerImage[2]!.imageMinorEach = 3_000;
      assert.throws(
        () => buildFromRates(makeRateCatalog(visionPerImage)),
        CostBetaPricingContractError,
      );
    },
  ],
  [
    "unknown runtime binding/model fails closed; missing TTS fails tts.beat",
    () => {
      const runtime = makeRuntime();
      runtime.vision.model = "qwen-vl-plus with spaces";
      assert.throws(
        () => buildCostBetaPricingCandidate(runtime, "beta"),
        CostBetaPricingContractError,
      );

      const missingTts = makeRuntime();
      delete missingTts.tts;
      assert.throws(
        () => buildCostBetaPricingCandidate(missingTts, "beta"),
        CostBetaPricingContractError,
      );
    },
  ],
  [
    "big integer arithmetic fails safely instead of overflowing",
    () => {
      const rates = makeRates();
      rates[1]!.imageMinorEach = Number.MAX_SAFE_INTEGER;
      assert.throws(
        () => buildFromRates(makeRateCatalog(rates)),
        CostBetaPricingContractError,
      );
    },
  ],
  [
    "external records with getters/proxies/extra keys are rejected",
    () => {
      const input = {
        providerCurrency: "CNY" as const,
        providerMinorUnitScale: 2 as const,
        rateCatalog: makeRateCatalog(),
        runtime: makeRuntime(),
      };
      Object.defineProperty(input, "providerCurrency", {
        enumerable: true,
        configurable: true,
        get: () => "CNY",
      });
      assert.throws(
        () => buildCostBetaPricingCandidateFromRates(input),
        CostBetaPricingContractError,
      );

      assert.throws(
        () => buildFromRates(new Proxy(makeRateCatalog(), {})),
        CostBetaPricingContractError,
      );

      const trustedCost = {
        providerCurrency: "CNY",
        providerMinorUnitScale: 2,
        rateCatalog: makeRateCatalog(),
        runtime: makeRuntime(),
        providerCostMinor: 1,
      };
      assert.throws(
        () => buildCostBetaPricingCandidateFromRates(trustedCost),
        CostBetaPricingContractError,
      );
    },
  ],
  [
    "candidate fingerprint accessor and deterministic rebuild",
    () => {
      const candidate = buildCostBetaPricingCandidate(makeRuntime(), "beta");
      assert.equal(
        costBetaPricingFingerprint(candidate),
        candidate.fingerprint,
      );
      assert.equal(
        costBetaPricingFingerprint(candidate.policy),
        candidate.fingerprint,
      );
      assert.equal(
        buildCostBetaPricingCandidate(makeRuntime(), "beta").fingerprint,
        candidate.fingerprint,
      );
      assert.equal(
        buildCostBetaPricingCandidate(makeRuntime(), "beta").policy.version,
        candidate.policy.version,
      );
    },
  ],
];

async function main(): Promise<void> {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`ok - ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`not ok - ${name}`);
      console.error(error);
    }
  }
  if (failed > 0) {
    console.error(`\n${failed} cost-beta pricing test(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log(`\n${tests.length} cost-beta pricing test(s) passed.`);
  }
}

void main();

