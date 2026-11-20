import "server-only";

import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";

import type { BillingPolicy } from "../admin/types";
import {
  FIXED_BETA_OPERATION_CONTRACT,
  FIXED_BETA_PRICING_AUDIENCE,
  FIXED_BETA_PRICING_MODE_CONFIG,
  FIXED_BETA_ORDINARY_REGISTRATION_GRANT,
  fixedBetaRuntimeBindingForOperation,
  FixedBetaPricingContractError,
  type FixedBetaOperation,
  type FixedBetaRuntimeConfig,
} from "./fixedBetaPricing";
import {
  PLATFORM_COST_ENVELOPE_SPEC,
  PLATFORM_COST_ROLE_ATTEMPT_CAPS,
  PLATFORM_COST_OPERATIONS,
  PLATFORM_IMAGE_LIMITS,
  PLATFORM_TEXT_LIMITS,
  PLATFORM_TTS_LIMITS,
  PLATFORM_VISION_LIMITS,
  PlatformCostEnvelopeError,
  type PlatformCostRole,
  type PlatformOperation,
} from "./platformCostEnvelope";
import {
  assertPlatformRuntimeConfig,
  isPlatformOperation,
  PLATFORM_CANONICAL_PROVIDER_BINDINGS,
  PLATFORM_COST_ENVELOPE_FINGERPRINT,
  PLATFORM_LIVE_PROVIDER_BINDINGS,
} from "./platformCostEnvelopeServer";

// ──────────────────────────────────────────────────────────────────────
//  Cost-derived beta/formal pricing policy (cost_beta_credit_v2).
//
//  Business rule: 1000 credits ≈ 100 CNY of provider cost during beta.
//  CNY minor unit is fen (scale 2), so 1 credit = 10 fen:
//      betaCredits   = ceil(providerCostFen / 10)
//      formalCredits = 10 * ceil(providerCostFen / 10)
//
//  Costs are worst-case over the immutable platform envelope: every role's
//  attempt cap is exhausted, at the envelope's maximum request shape, using
//  the VERIFIED rate catalog below. No caching/free discount is applied.
//
//  The policy uses only the existing BillingPolicy/PriceCatalogEntry shape
//  (no extra DB fields). Phase, runtime bindings, rate catalog and envelope
//  are pinned inside the version string and the per-entry hashes.
// ──────────────────────────────────────────────────────────────────────

export const COST_BETA_PRICING_SCHEMA =
  "aistory.cost-beta-pricing/v1" as const;
export const COST_BETA_RATE_CATALOG_SCHEMA =
  "aistory.cost-beta-rate-catalog/v1" as const;
export const COST_BETA_PRICING_MODE = "cost_beta_credit_v2" as const;
export const COST_BETA_PRICING_VERSION_PREFIX = "cost-beta-v2." as const;
export const COST_BETA_RUNTIME_BINDING_PROVIDER =
  "aistory_runtime_binding_v2" as const;
export const COST_BETA_PRICING_MODE_CONFIG =
  "aistory-platform-billing-v2:cost_beta_credit_v2" as const;
export const COST_BETA_PRICING_MODE_ENV =
  "AISTORY_PLATFORM_BILLING_POLICY_MODE" as const;
export const COST_BETA_PRICING_VERSION_ENV =
  "AISTORY_PLATFORM_BILLING_POLICY_VERSION" as const;
export const COST_BETA_FEN_PER_CREDIT = 10 as const;
export const COST_BETA_FORMAL_MULTIPLIER = 10 as const;
/** Metadata only. This module never mutates accounts or grants credits. */
export const COST_BETA_ORDINARY_REGISTRATION_GRANT_CREDITS =
  FIXED_BETA_ORDINARY_REGISTRATION_GRANT;
/** Metadata only. Friend grants are expressly untouched by this module. */
export const COST_BETA_FRIEND_REGISTRATION_GRANT_CREDITS = 2_000 as const;

export type CostBetaPricingPhase = "beta" | "formal";

// Conservative text cost quantity. Tokenizer proof is still pending, so we
// price 1 UTF-8 input byte as one input token plus the per-message framing
// allowance. For mixed CJK/Latin text this is an upper bound, not a promise.
const TEXT_WORST_CASE_INPUT_TOKENS =
  PLATFORM_TEXT_LIMITS.maxInputBytes
  + PLATFORM_TEXT_LIMITS.messageOverheadBytes
    * PLATFORM_TEXT_LIMITS.maxMessages;
const TEXT_WORST_CASE_OUTPUT_TOKENS = PLATFORM_TEXT_LIMITS.maxOutputTokens;

const MILLION = 1_000_000n;
const TEN_THOUSAND = 10_000n;
const TEN = BigInt(COST_BETA_FEN_PER_CREDIT);

const INPUT_KEYS = [
  "providerCurrency",
  "providerMinorUnitScale",
  "rateCatalog",
  "runtime",
] as const;
const RATE_CATALOG_KEYS = [
  "currency",
  "effectiveOn",
  "minorUnitScale",
  "rates",
  "schema",
  "sourceIds",
  "status",
  "verifiedOn",
  "version",
] as const;
const RATE_KEYS = [
  "imageInputTokensMax",
  "imageMinorEach",
  "inputMinorPerMillionTokens",
  "outputMinorPerMillionTokens",
  "role",
  "ttsMinorPerTenThousandCharacters",
] as const;
const POLICY_KEYS = [
  "creditUnitsPerProviderMinor",
  "entries",
  "initialGrantCredits",
  "markupBasisPoints",
  "providerCurrency",
  "providerMinorUnitScale",
  "version",
] as const;
const POLICY_WITH_AUDIT_KEYS = [
  ...POLICY_KEYS,
  "updatedAt",
  "updatedBy",
] as const;
const ENTRY_KEYS = [
  "enabled",
  "fixedCredits",
  "modality",
  "model",
  "operation",
  "pricingMode",
  "provider",
  "providerCostMinor",
] as const;

export class CostBetaPricingContractError extends Error {
  readonly code = "COST_BETA_PRICING_CONTRACT_INVALID";

  constructor() {
    super("Cost-derived beta pricing policy is invalid.");
    this.name = "CostBetaPricingContractError";
  }
}

export class CostBetaPricingActivationError extends Error {
  readonly code = "COST_BETA_PRICING_NOT_ENABLED";

  constructor() {
    super("Cost-derived beta pricing is not enabled for this policy version.");
    this.name = "CostBetaPricingActivationError";
  }
}

function fail(): never {
  throw new CostBetaPricingContractError();
}

function assertDataRecord(
  value: unknown,
): asserts value is Record<string, unknown> {
  try {
    if (
      value === null
      || typeof value !== "object"
      || Array.isArray(value)
      || utilTypes.isProxy(value)
      || Object.getPrototypeOf(value) !== Object.prototype
      || Object.getOwnPropertySymbols(value).length !== 0
    ) fail();
    for (const descriptor of Object.values(
      Object.getOwnPropertyDescriptors(value),
    )) {
      if (!("value" in descriptor) || !descriptor.enumerable) fail();
    }
  } catch (error) {
    if (error instanceof CostBetaPricingContractError) throw error;
    fail();
  }
}

function assertExactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): asserts value is Record<string, unknown> {
  assertDataRecord(value);
  try {
    const keys = Object.keys(Object.getOwnPropertyDescriptors(value)).sort();
    const sortedExpected = [...expectedKeys].sort();
    if (
      keys.length !== expectedKeys.length
      || keys.some((key, index) => key !== sortedExpected[index])
    ) fail();
  } catch (error) {
    if (error instanceof CostBetaPricingContractError) throw error;
    fail();
  }
}

function assertPlainDataArray(value: unknown): asserts value is unknown[] {
  try {
    if (
      !Array.isArray(value)
      || utilTypes.isProxy(value)
      || Object.getPrototypeOf(value) !== Array.prototype
      || Object.getOwnPropertySymbols(value).length !== 0
    ) fail();
    for (const [key, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(value),
    )) {
      if (!("value" in descriptor)) fail();
      if (
        key !== "length"
        && (!/^(0|[1-9][0-9]*)$/.test(key) || !descriptor.enumerable)
      ) fail();
    }
  } catch (error) {
    if (error instanceof CostBetaPricingContractError) throw error;
    fail();
  }
}

function safeIdentifier(value: unknown, maximumLength: number): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximumLength
    || !/^[A-Za-z0-9][A-Za-z0-9._/:-]*$/.test(value)
    || value.includes("..")
    || value.includes("//")
  ) fail();
  return value;
}

function safeDate(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail();
  return value;
}

function safeNonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail();
  return value as number;
}

function requirePositive(value: unknown): number {
  const parsed = safeNonNegativeInteger(value);
  if (parsed < 1) fail();
  return parsed;
}

type ValidatedRate = {
  role: PlatformCostRole;
  inputMinorPerMillionTokens: number;
  outputMinorPerMillionTokens: number;
  imageMinorEach: number;
  imageInputTokensMax: number;
  ttsMinorPerTenThousandCharacters: number;
};

type ValidatedRateCatalog = {
  version: string;
  effectiveOn: string;
  verifiedOn: string;
  fingerprint: string;
  rates: Record<PlatformCostRole, ValidatedRate>;
};

// ── Official verified rate catalog (captured 2026-10-21) ───────────────

export const COST_BETA_RATE_CATALOG_VERSION =
  "cost-beta-cny-rates-2026-10-21" as const;
export const COST_BETA_RATE_CATALOG_CAPTURED_ON = "2026-10-21" as const;

export const COST_BETA_OFFICIAL_RATE_SOURCES = Object.freeze([
  Object.freeze({
    id: "aliyun-qwen-plus",
    model: "qwen-plus",
    metric: "input/output tokens",
    unitFact: "Beijing ≤128k input tokens: input 0.8 CNY/1M = 80 fen/1M; non-thinking output 2 CNY/1M = 200 fen/1M",
    capturedOn: COST_BETA_RATE_CATALOG_CAPTURED_ON,
    officialUrl: "https://help.aliyun.com/zh/model-studio/qwen-plus",
    note: "No cache/free discount applied.",
  }),
  Object.freeze({
    id: "aliyun-model-pricing",
    model: "qwen-vl-plus / qwen-image-2.0-pro",
    metric: "tokens / image",
    unitFact: "qwen-vl-plus input 0.8 CNY/1M = 80 fen/1M, output 2 CNY/1M = 200 fen/1M; qwen-image-2.0-pro 0.5 CNY/image = 50 fen/image",
    capturedOn: COST_BETA_RATE_CATALOG_CAPTURED_ON,
    officialUrl: "https://help.aliyun.com/zh/model-studio/model-pricing",
    note: "qwen-vl-plus model URL now redirects to the models index; priced from the indexed model/pricing pages. No cache/free discount applied.",
  }),
  Object.freeze({
    id: "aliyun-qwen3-tts-flash",
    model: "qwen3-tts-flash",
    metric: "weighted characters",
    unitFact: "0.8 CNY/10,000 weighted chars = 80 fen/10,000",
    capturedOn: COST_BETA_RATE_CATALOG_CAPTURED_ON,
    officialUrl: "https://help.aliyun.com/zh/model-studio/qwen3-tts-flash",
    note: "No cache/free discount applied.",
  }),
]);

export const COST_BETA_PRICE_ASSUMPTIONS = Object.freeze([
  "text: 1 UTF-8 input byte is priced as 1 input token plus 64 bytes per message (≤64 messages); exact tokenizer proof is still pending and this is a conservative upper bound, not an official token fact.",
  `vision: one image per attempt, data URL ≤3 MiB, image content part max_pixels ${PLATFORM_VISION_LIMITS.maxPixels} with vl_high_resolution_images=false. Priced conservatively as the whole-request model input ceiling ${PLATFORM_VISION_LIMITS.maxBillableInputTokens} tokens (image + prompt together) at the verified input rate plus ${PLATFORM_VISION_LIMITS.maxOutputTokens} output tokens at the verified output rate; no separate per-image price is invented and prompt/image tokens are never counted twice.`,
  "tts: 2,000 priced characters = 1,000 accepted codepoints × worst-case weight 2.",
  "Worst case exhausts every role's attempt cap and applies no cache/free discount; the result is an upper-bound reserved estimate, not actual usage or a provider receipt.",
]);

/**
 * Injected verified catalog. Values are official prices captured on
 * 2026-10-21, expressed in CNY fen. Do not rewrite historical facts here;
 * a price change requires a new catalog version, not a silent edit.
 */
export const COST_BETA_RATE_CATALOG = Object.freeze({
  schema: COST_BETA_RATE_CATALOG_SCHEMA,
  version: COST_BETA_RATE_CATALOG_VERSION,
  status: "VERIFIED" as const,
  currency: "CNY" as const,
  minorUnitScale: 2 as const,
  effectiveOn: COST_BETA_RATE_CATALOG_CAPTURED_ON,
  verifiedOn: COST_BETA_RATE_CATALOG_CAPTURED_ON,
  sourceIds: Object.freeze(
    COST_BETA_OFFICIAL_RATE_SOURCES.map((source) => source.id),
  ),
  rates: Object.freeze([
    Object.freeze({
      role: "text" as const,
      inputMinorPerMillionTokens: 80,
      outputMinorPerMillionTokens: 200,
      imageMinorEach: 0,
      imageInputTokensMax: 0,
      ttsMinorPerTenThousandCharacters: 0,
    }),
    Object.freeze({
      role: "image" as const,
      inputMinorPerMillionTokens: 0,
      outputMinorPerMillionTokens: 0,
      imageMinorEach: 50,
      imageInputTokensMax: 0,
      ttsMinorPerTenThousandCharacters: 0,
    }),
    Object.freeze({
      role: "vision" as const,
      inputMinorPerMillionTokens: 80,
      outputMinorPerMillionTokens: 200,
      imageMinorEach: 0,
      // Vision is priced on the whole-request token ceiling; no per-image
      // monetary or per-image-token rate is assumed.
      imageInputTokensMax: 0,
      ttsMinorPerTenThousandCharacters: 0,
    }),
    Object.freeze({
      role: "tts" as const,
      inputMinorPerMillionTokens: 0,
      outputMinorPerMillionTokens: 0,
      imageMinorEach: 0,
      imageInputTokensMax: 0,
      ttsMinorPerTenThousandCharacters: 80,
    }),
  ]),
});

function validateRates(value: unknown): Record<PlatformCostRole, ValidatedRate> {
  assertPlainDataArray(value);
  if (value.length !== 4) fail();
  const byRole = new Map<PlatformCostRole, ValidatedRate>();
  for (const item of value) {
    assertExactDataRecord(item, RATE_KEYS);
    const role = item.role;
    if (
      role !== "text"
      && role !== "image"
      && role !== "vision"
      && role !== "tts"
    ) fail();
    if (byRole.has(role)) fail();
    const rate: ValidatedRate = {
      role,
      inputMinorPerMillionTokens: safeNonNegativeInteger(
        item.inputMinorPerMillionTokens,
      ),
      outputMinorPerMillionTokens: safeNonNegativeInteger(
        item.outputMinorPerMillionTokens,
      ),
      imageMinorEach: safeNonNegativeInteger(item.imageMinorEach),
      imageInputTokensMax: safeNonNegativeInteger(item.imageInputTokensMax),
      ttsMinorPerTenThousandCharacters: safeNonNegativeInteger(
        item.ttsMinorPerTenThousandCharacters,
      ),
    };
    // Every physical unit this role is priced on must have a provable rate.
    if (role === "text") {
      requirePositive(rate.inputMinorPerMillionTokens);
      requirePositive(rate.outputMinorPerMillionTokens);
    }
    if (role === "image" && rate.imageMinorEach < 1) fail();
    if (role === "vision") {
      // Vision is priced on the verified whole-request token ceiling. Any
      // per-image monetary or per-image-token rate would be invented cost, so
      // reject it instead of silently ignoring it.
      requirePositive(rate.inputMinorPerMillionTokens);
      requirePositive(rate.outputMinorPerMillionTokens);
      if (rate.imageMinorEach !== 0 || rate.imageInputTokensMax !== 0) fail();
    }
    if (role === "tts" && rate.ttsMinorPerTenThousandCharacters < 1) fail();
    byRole.set(role, rate);
  }
  if (byRole.size !== 4) fail();
  return {
    text: byRole.get("text")!,
    image: byRole.get("image")!,
    vision: byRole.get("vision")!,
    tts: byRole.get("tts")!,
  };
}

function validateRateCatalog(value: unknown): ValidatedRateCatalog {
  assertExactDataRecord(value, RATE_CATALOG_KEYS);
  if (
    value.schema !== COST_BETA_RATE_CATALOG_SCHEMA
    || value.status !== "VERIFIED"
    || value.currency !== "CNY"
    || value.minorUnitScale !== 2
  ) fail();
  const version = safeIdentifier(value.version, 80);
  const effectiveOn = safeDate(value.effectiveOn);
  const verifiedOn = safeDate(value.verifiedOn);
  assertPlainDataArray(value.sourceIds);
  if (value.sourceIds.length < 1 || value.sourceIds.length > 16) fail();
  const sourceIds = value.sourceIds.map((sourceId) =>
    safeIdentifier(sourceId, 160)
  );
  const rates = validateRates(value.rates);
  const fingerprint = createHash("sha256")
    .update("aistory.cost-beta-rate-catalog/v1\0", "utf8")
    .update(JSON.stringify({
      version,
      effectiveOn,
      verifiedOn,
      sourceIds,
      rates: {
        text: rates.text,
        image: rates.image,
        vision: rates.vision,
        tts: rates.tts,
      },
    }), "utf8")
    .digest("hex");
  return { version, effectiveOn, verifiedOn, fingerprint, rates };
}

let cachedOfficialCatalog: ValidatedRateCatalog | undefined;

function officialRateCatalog(): ValidatedRateCatalog {
  cachedOfficialCatalog ??= validateRateCatalog(COST_BETA_RATE_CATALOG);
  return cachedOfficialCatalog;
}

export function getCostBetaRateCatalogFingerprint(): string {
  return officialRateCatalog().fingerprint;
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) fail();
  return (numerator + denominator - 1n) / denominator;
}

function toSafeNumber(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) fail();
  return Number(value);
}

/**
 * Unit-cost lines are ceil'd per metric line, then multiplied by the role's
 * worst-case attempt cap. All arithmetic is bigint, so no intermediate
 * overflow can occur.
 */
function worstCaseRoleFen(
  role: PlatformCostRole,
  rate: ValidatedRate,
  attempts: number,
): bigint {
  if (attempts === 0) return 0n;
  let perAttempt = 0n;
  switch (role) {
    case "text": {
      perAttempt =
        ceilDiv(
          BigInt(TEXT_WORST_CASE_INPUT_TOKENS)
            * BigInt(rate.inputMinorPerMillionTokens),
          MILLION,
        )
        + ceilDiv(
          BigInt(TEXT_WORST_CASE_OUTPUT_TOKENS)
            * BigInt(rate.outputMinorPerMillionTokens),
          MILLION,
        );
      break;
    }
    case "image": {
      perAttempt =
        BigInt(rate.imageMinorEach) * BigInt(PLATFORM_IMAGE_LIMITS.maxOutputImages);
      break;
    }
    case "vision": {
      // Price the WHOLE request: the model's input ceiling already includes
      // the image and the prompt, so they must not be added again.
      perAttempt =
        ceilDiv(
          BigInt(PLATFORM_VISION_LIMITS.maxBillableInputTokens)
            * BigInt(rate.inputMinorPerMillionTokens),
          MILLION,
        )
        + ceilDiv(
          BigInt(PLATFORM_VISION_LIMITS.maxOutputTokens)
            * BigInt(rate.outputMinorPerMillionTokens),
          MILLION,
        );
      break;
    }
    case "tts": {
      perAttempt = ceilDiv(
        BigInt(PLATFORM_TTS_LIMITS.maxPricedCharacters)
          * BigInt(rate.ttsMinorPerTenThousandCharacters),
        TEN_THOUSAND,
      );
      break;
    }
  }
  return perAttempt * BigInt(attempts);
}

export function betaCreditsFromCostFen(costFen: number): number {
  const parsed = safeNonNegativeInteger(costFen);
  return toSafeNumber(ceilDiv(BigInt(parsed), TEN));
}

export function formalCreditsFromCostFen(costFen: number): number {
  return toSafeNumber(
    ceilDiv(BigInt(safeNonNegativeInteger(costFen)), TEN)
      * BigInt(COST_BETA_FORMAL_MULTIPLIER),
  );
}

// ── Policy / binding types ─────────────────────────────────────────────

export type CostBetaRuntimeBinding = Readonly<{
  provider: typeof COST_BETA_RUNTIME_BINDING_PROVIDER;
  model: string;
}>;

export type CostBetaCatalogEntry = Readonly<{
  operation: PlatformOperation;
  modality: string;
  provider: typeof COST_BETA_RUNTIME_BINDING_PROVIDER;
  model: string;
  providerCostMinor: number;
  enabled: true;
  pricingMode: typeof COST_BETA_PRICING_MODE;
  fixedCredits: number;
}>;

/** Same fields as BillingPolicy, without requiring audit timestamps. */
export type CostBetaPolicy = Readonly<{
  version: string;
  markupBasisPoints: 10_000;
  initialGrantCredits: typeof COST_BETA_ORDINARY_REGISTRATION_GRANT_CREDITS;
  providerCurrency: "CNY";
  providerMinorUnitScale: 2;
  creditUnitsPerProviderMinor: 1;
  entries: readonly CostBetaCatalogEntry[];
}>;

export type CostBetaRoleCostPin = Readonly<{
  role: PlatformCostRole;
  maxAttempts: number;
  worstCaseProviderCostMinor: number;
}>;

export type CostBetaOperationPin = Readonly<{
  operation: PlatformOperation;
  modality: string;
  providerCostMinor: number;
  betaCredits: number;
  formalCredits: number;
  envelopeFingerprint: string;
  rateCatalogVersion: string;
  rateCatalogFingerprint: string;
  runtimeBinding: CostBetaRuntimeBinding;
  roleCosts: readonly CostBetaRoleCostPin[];
}>;

export type CostBetaPricingCandidate = Readonly<{
  schema: typeof COST_BETA_PRICING_SCHEMA;
  status: "LOCAL_PRICING_CANDIDATE_ONLY";
  pricingMode: typeof COST_BETA_PRICING_MODE;
  phase: CostBetaPricingPhase;
  pricingAudience: typeof FIXED_BETA_PRICING_AUDIENCE;
  providerCurrency: "CNY";
  providerMinorUnitScale: 2;
  fenPerCredit: typeof COST_BETA_FEN_PER_CREDIT;
  formalMultiplier: typeof COST_BETA_FORMAL_MULTIPLIER;
  ordinaryRegistrationGrantCredits:
    typeof COST_BETA_ORDINARY_REGISTRATION_GRANT_CREDITS;
  friendRegistrationGrantCredits:
    typeof COST_BETA_FRIEND_REGISTRATION_GRANT_CREDITS;
  grantsAreMetadataOnly: true;
  membershipGrantIncluded: false;
  productionWriteAllowed: false;
  providerContacted: false;
  networkCalls: 0;
  writesPerformed: 0;
  operationCount: 11;
  envelopeFingerprint: string;
  rateCatalog: Readonly<{
    version: string;
    effectiveOn: string;
    verifiedOn: string;
    fingerprint: string;
    sources: readonly (typeof COST_BETA_OFFICIAL_RATE_SOURCES)[number][];
  }>;
  assumptions: readonly string[];
  policy: CostBetaPolicy;
  operations: readonly CostBetaOperationPin[];
  fingerprint: string;
}>;

export type CostBetaPricingInput = {
  providerCurrency: "CNY";
  providerMinorUnitScale: 2;
  rateCatalog: unknown;
  runtime: FixedBetaRuntimeConfig;
};

const MODALITY_BY_OPERATION = new Map<string, string>(
  FIXED_BETA_OPERATION_CONTRACT.map(({ operation, modality }) =>
    [operation, modality] as const
  ),
);

export function costBetaRuntimeBindingForOperation(
  operation: PlatformOperation,
  config: FixedBetaRuntimeConfig,
): CostBetaRuntimeBinding {
  try {
    // Unknown models/endpoints must never produce a valid v2 binding. This is
    // the exact canonical/live allowlist check, re-run on every call so config
    // drift is caught while hashing.
    assertPlatformRuntimeConfig(config);
    const binding = fixedBetaRuntimeBindingForOperation(
      operation as FixedBetaOperation,
      config,
    );
    return Object.freeze({
      provider: COST_BETA_RUNTIME_BINDING_PROVIDER,
      model: binding.model,
    });
  } catch (error) {
    if (
      error instanceof FixedBetaPricingContractError
      || error instanceof PlatformCostEnvelopeError
    ) fail();
    throw error;
  }
}

function assertPhase(value: unknown): CostBetaPricingPhase {
  if (value !== "beta" && value !== "formal") fail();
  return value;
}

/**
 * The ONE authorized mixed runtime profile: the confirmed live host for
 * text/image/vision plus the canonical DashScope host for TTS.
 *
 * This is a complete controlled profile, not a role-by-role Cartesian product:
 * root confirmed the canonical baseUrl `https://dashscope.aliyuncs.com/api/v1`
 * is required for working voice TTS (valid WAV downloaded), while text, image
 * and vision stay on the existing live host. No other baseUrl, model or
 * per-role substitution is authorized, and adding one here would silently
 * widen the endpoint contract.
 */
export const COST_BETA_MIXED_PROVIDER_BINDINGS = Object.freeze({
  text: PLATFORM_LIVE_PROVIDER_BINDINGS.text,
  image: PLATFORM_LIVE_PROVIDER_BINDINGS.image,
  vision: PLATFORM_LIVE_PROVIDER_BINDINGS.vision,
  tts: PLATFORM_CANONICAL_PROVIDER_BINDINGS.tts,
});

/**
 * Runtime-binding hashes a policy entry may legitimately carry: exactly the
 * hashes derived from the three authorized endpoint sets (all-canonical, the
 * confirmed all-live custom host, and the single confirmed live text/image/
 * vision + canonical TTS profile). Any other hash fails validation even if it
 * is a well-formed sha256.
 *
 * Operation-specific role descriptors mean single-role operations naturally
 * share a hash across profiles (e.g. `tts.beat` is identical for the
 * all-canonical and mixed profiles). That is expected; multi-role operations
 * like `story.start` pin the whole role set and therefore only accept the
 * complete profiles above.
 */
let cachedAllowedBindingModels:
  | ReadonlyMap<PlatformOperation, ReadonlySet<string>>
  | undefined;

function allowedBindingModels(): ReadonlyMap<
  PlatformOperation,
  ReadonlySet<string>
> {
  if (cachedAllowedBindingModels) return cachedAllowedBindingModels;
  const runtimeConfigs = [
    PLATFORM_CANONICAL_PROVIDER_BINDINGS,
    PLATFORM_LIVE_PROVIDER_BINDINGS,
    COST_BETA_MIXED_PROVIDER_BINDINGS,
  ].map((bindings) => ({
    text: { ...bindings.text },
    image: { ...bindings.image },
    vision: { ...bindings.vision },
    tts: {
      provider: bindings.tts.provider,
      speechModel: bindings.tts.model,
      baseUrl: bindings.tts.baseUrl,
    },
  } as FixedBetaRuntimeConfig));
  const byOperation = new Map<PlatformOperation, Set<string>>();
  for (const runtime of runtimeConfigs) {
    for (const operation of PLATFORM_COST_OPERATIONS) {
      const { model } = costBetaRuntimeBindingForOperation(operation, runtime);
      const models = byOperation.get(operation) ?? new Set<string>();
      models.add(model);
      byOperation.set(operation, models);
    }
  }
  cachedAllowedBindingModels = byOperation;
  return cachedAllowedBindingModels;
}

function policyVersion(
  phase: CostBetaPricingPhase,
  rateFingerprint: string,
  versionlessPolicy: Omit<CostBetaPolicy, "version">,
): string {
  const digest = createHash("sha256")
    .update("aistory.cost-beta-policy/v1\0", "utf8")
    .update(JSON.stringify({
      schema: COST_BETA_PRICING_SCHEMA,
      phase,
      envelopeFingerprint: PLATFORM_COST_ENVELOPE_FINGERPRINT,
      rateCatalogFingerprint: rateFingerprint,
      policy: versionlessPolicy,
    }), "utf8")
    .digest("hex");
  return `${COST_BETA_PRICING_VERSION_PREFIX}${phase}.${digest}`;
}

function buildFromValidatedCatalog(
  runtime: FixedBetaRuntimeConfig,
  phase: CostBetaPricingPhase,
  rateCatalog: ValidatedRateCatalog,
): CostBetaPricingCandidate {
  const operations: CostBetaOperationPin[] = [];
  const entries: CostBetaCatalogEntry[] = [];

  for (const operation of PLATFORM_COST_OPERATIONS) {
    if (!MODALITY_BY_OPERATION.has(operation)) fail();
    const caps = PLATFORM_COST_ROLE_ATTEMPT_CAPS[operation];
    const roleCosts: CostBetaRoleCostPin[] = [];
    let totalFen = 0n;
    for (const role of Object.keys(caps) as PlatformCostRole[]) {
      const maxAttempts = caps[role];
      if (maxAttempts === undefined) continue;
      const roleFen = worstCaseRoleFen(
        role,
        rateCatalog.rates[role],
        maxAttempts,
      );
      totalFen += roleFen;
      roleCosts.push(Object.freeze({
        role,
        maxAttempts,
        worstCaseProviderCostMinor: toSafeNumber(roleFen),
      }));
    }
    const providerCostMinor = toSafeNumber(totalFen);
    const betaCredits = toSafeNumber(ceilDiv(totalFen, TEN));
    const formalCredits = toSafeNumber(
      BigInt(betaCredits) * BigInt(COST_BETA_FORMAL_MULTIPLIER),
    );
    const runtimeBinding = costBetaRuntimeBindingForOperation(operation, runtime);
    const modality = MODALITY_BY_OPERATION.get(operation)!;

    operations.push(Object.freeze({
      operation,
      modality,
      providerCostMinor,
      betaCredits,
      formalCredits,
      envelopeFingerprint: PLATFORM_COST_ENVELOPE_FINGERPRINT,
      rateCatalogVersion: rateCatalog.version,
      rateCatalogFingerprint: rateCatalog.fingerprint,
      runtimeBinding,
      roleCosts: Object.freeze(roleCosts),
    }));
    entries.push(Object.freeze({
      operation,
      modality,
      provider: COST_BETA_RUNTIME_BINDING_PROVIDER,
      model: runtimeBinding.model,
      providerCostMinor,
      enabled: true as const,
      pricingMode: COST_BETA_PRICING_MODE,
      fixedCredits: phase === "formal" ? formalCredits : betaCredits,
    }));
  }

  if (entries.length !== 11 || operations.length !== 11) fail();

  const versionlessPolicy: Omit<CostBetaPolicy, "version"> = {
    markupBasisPoints: 10_000,
    initialGrantCredits: COST_BETA_ORDINARY_REGISTRATION_GRANT_CREDITS,
    providerCurrency: "CNY",
    providerMinorUnitScale: 2,
    creditUnitsPerProviderMinor: 1,
    entries,
  };
  const version = policyVersion(
    phase,
    rateCatalog.fingerprint,
    versionlessPolicy,
  );
  const fingerprint = version.slice(
    `${COST_BETA_PRICING_VERSION_PREFIX}${phase}.`.length,
  );
  const policy: CostBetaPolicy = Object.freeze({
    version,
    ...versionlessPolicy,
    entries: Object.freeze(entries),
  });

  return Object.freeze({
    schema: COST_BETA_PRICING_SCHEMA,
    status: "LOCAL_PRICING_CANDIDATE_ONLY",
    pricingMode: COST_BETA_PRICING_MODE,
    phase,
    pricingAudience: FIXED_BETA_PRICING_AUDIENCE,
    providerCurrency: "CNY",
    providerMinorUnitScale: 2,
    fenPerCredit: COST_BETA_FEN_PER_CREDIT,
    formalMultiplier: COST_BETA_FORMAL_MULTIPLIER,
    ordinaryRegistrationGrantCredits:
      COST_BETA_ORDINARY_REGISTRATION_GRANT_CREDITS,
    friendRegistrationGrantCredits:
      COST_BETA_FRIEND_REGISTRATION_GRANT_CREDITS,
    grantsAreMetadataOnly: true,
    membershipGrantIncluded: false,
    productionWriteAllowed: false,
    providerContacted: false,
    networkCalls: 0,
    writesPerformed: 0,
    operationCount: 11,
    envelopeFingerprint: PLATFORM_COST_ENVELOPE_FINGERPRINT,
    rateCatalog: Object.freeze({
      version: rateCatalog.version,
      effectiveOn: rateCatalog.effectiveOn,
      verifiedOn: rateCatalog.verifiedOn,
      fingerprint: rateCatalog.fingerprint,
      sources: COST_BETA_OFFICIAL_RATE_SOURCES,
    }),
    assumptions: COST_BETA_PRICE_ASSUMPTIONS,
    policy,
    operations: Object.freeze(operations),
    fingerprint,
  });
}

/**
 * Build the immutable v2 policy from INJECTED verified rates. Exposed for
 * tests/future catalog injection; the root path should use
 * `buildCostBetaPricingCandidate(runtimeConfig, phase)`.
 */
export function buildCostBetaPricingCandidateFromRates(
  value: unknown,
  phaseInput: CostBetaPricingPhase = "beta",
): CostBetaPricingCandidate {
  const phase = assertPhase(phaseInput);
  assertExactDataRecord(value, INPUT_KEYS);
  if (
    value.providerCurrency !== "CNY"
    || value.providerMinorUnitScale !== 2
  ) fail();
  const rateCatalog = validateRateCatalog(value.rateCatalog);
  if (value.runtime === null || typeof value.runtime !== "object") fail();
  return buildFromValidatedCatalog(
    value.runtime as FixedBetaRuntimeConfig,
    phase,
    rateCatalog,
  );
}

/**
 * Root entry point: build the immutable policy for the official verified
 * catalog and the exact runtime config. Returns `{ policy, fingerprint, ... }`.
 */
export function buildCostBetaPricingCandidate(
  config: FixedBetaRuntimeConfig,
  phase: CostBetaPricingPhase = "beta",
): CostBetaPricingCandidate {
  return buildCostBetaPricingCandidateFromRates(
    {
      providerCurrency: "CNY",
      providerMinorUnitScale: 2,
      rateCatalog: COST_BETA_RATE_CATALOG,
      runtime: config,
    },
    phase,
  );
}

export function isCostBetaPricingVersion(value: unknown): value is string {
  if (
    typeof value !== "string"
    || !value.startsWith(COST_BETA_PRICING_VERSION_PREFIX)
  ) return false;
  return /^(beta|formal)\.[a-f0-9]{64}$/.test(
    value.slice(COST_BETA_PRICING_VERSION_PREFIX.length),
  );
}

function parseCostBetaPricingVersion(value: unknown): {
  phase: CostBetaPricingPhase;
  fingerprint: string;
} {
  if (!isCostBetaPricingVersion(value)) fail();
  const rest = value.slice(COST_BETA_PRICING_VERSION_PREFIX.length);
  const phase = assertPhase(rest.slice(0, rest.indexOf(".")));
  return { phase, fingerprint: rest.slice(rest.indexOf(".") + 1) };
}

function expectedProviderCostMinor(
  rateCatalog: ValidatedRateCatalog,
): Map<PlatformOperation, number> {
  const result = new Map<PlatformOperation, number>();
  for (const operation of PLATFORM_COST_OPERATIONS) {
    const caps = PLATFORM_COST_ROLE_ATTEMPT_CAPS[operation];
    let totalFen = 0n;
    for (const role of Object.keys(caps) as PlatformCostRole[]) {
      const maxAttempts = caps[role];
      if (maxAttempts === undefined) continue;
      totalFen += worstCaseRoleFen(
        role,
        rateCatalog.rates[role],
        maxAttempts,
      );
    }
    result.set(operation, toSafeNumber(totalFen));
  }
  return result;
}

/**
 * Rebuild-free policy validation against the official catalog. Verifies the
 * phase and every derived credit from the pinned cost, then recomputes the
 * version fingerprint (which pins envelope + rate catalog + entries).
 */
export function assertCostBetaPricingPolicy(
  value: unknown,
): asserts value is BillingPolicy {
  if (
    value === null
    || typeof value !== "object"
    || utilTypes.isProxy(value)
  ) fail();
  const rawKeys = Object.keys(value);
  const hasAuditFields =
    rawKeys.includes("updatedAt") || rawKeys.includes("updatedBy");
  assertExactDataRecord(
    value,
    hasAuditFields ? POLICY_WITH_AUDIT_KEYS : POLICY_KEYS,
  );
  if (hasAuditFields) {
    if (
      typeof value.updatedAt !== "string"
      || value.updatedAt.length < 1
      || typeof value.updatedBy !== "string"
      || value.updatedBy.length < 1
    ) fail();
  }
  const { phase } = parseCostBetaPricingVersion(value.version);
  if (
    value.markupBasisPoints !== 10_000
    || value.initialGrantCredits !== COST_BETA_ORDINARY_REGISTRATION_GRANT_CREDITS
    || value.providerCurrency !== "CNY"
    || value.providerMinorUnitScale !== 2
    || value.creditUnitsPerProviderMinor !== 1
  ) fail();
  assertPlainDataArray(value.entries);
  if (value.entries.length !== PLATFORM_COST_OPERATIONS.length) fail();

  const catalog = officialRateCatalog();
  const expectedCosts = expectedProviderCostMinor(catalog);
  const definitions = new Map(
    FIXED_BETA_OPERATION_CONTRACT.map((definition) => [
      definition.operation,
      definition,
    ]),
  );
  const entriesByOperation = new Map<string, CostBetaCatalogEntry>();
  const allowedModels = allowedBindingModels();
  for (const rawEntry of value.entries) {
    assertExactDataRecord(rawEntry, ENTRY_KEYS);
    const operation = safeIdentifier(rawEntry.operation, 80);
    if (!isPlatformOperation(operation)) fail();
    const definition = definitions.get(operation);
    if (!definition || entriesByOperation.has(operation)) fail();
    if (
      rawEntry.modality !== definition.modality
      || rawEntry.enabled !== true
      || rawEntry.pricingMode !== COST_BETA_PRICING_MODE
      || rawEntry.provider !== COST_BETA_RUNTIME_BINDING_PROVIDER
    ) fail();
    const model = rawEntry.model;
    if (
      typeof model !== "string"
      || !/^sha256:[a-f0-9]{64}$/.test(model)
    ) fail();
    // Strong runtime pin: only the exact hashes of the authorized canonical or
    // live endpoint sets are accepted, per operation.
    if (
      !allowedModels
        .get(operation as PlatformOperation)
        ?.has(model)
    ) fail();
    const providerCostMinor = safeNonNegativeInteger(rawEntry.providerCostMinor);
    if (providerCostMinor !== expectedCosts.get(operation as PlatformOperation)) {
      fail();
    }
    const betaCredits = betaCreditsFromCostFen(providerCostMinor);
    const expectedFixed = phase === "formal"
      ? betaCredits * COST_BETA_FORMAL_MULTIPLIER
      : betaCredits;
    if (rawEntry.fixedCredits !== expectedFixed) fail();
    // Rebuild the entry in the EXACT field order used by
    // `buildFromValidatedCatalog` before it is hashed. PostgreSQL JSONB
    // reorders object keys on readback, but the approved policy version was
    // hashed over the builder's insertion order, so the raw entry key order
    // must never reach `policyVersion`. This is not a global key sort: only
    // these already-validated fields are emitted, in the builder's order.
    entriesByOperation.set(operation as PlatformOperation, {
      operation: operation as PlatformOperation,
      modality: definition.modality,
      provider: COST_BETA_RUNTIME_BINDING_PROVIDER,
      model,
      providerCostMinor,
      enabled: true,
      pricingMode: COST_BETA_PRICING_MODE,
      fixedCredits: expectedFixed,
    });
  }
  if (entriesByOperation.size !== definitions.size) fail();

  // Existing canonical contract: entries are hashed in
  // `PLATFORM_COST_OPERATIONS` order regardless of stored array order.
  const canonicalEntries = PLATFORM_COST_OPERATIONS.map(
    (operation) => entriesByOperation.get(operation)!,
  );
  const versionlessPolicy: Omit<CostBetaPolicy, "version"> = {
    markupBasisPoints: 10_000,
    initialGrantCredits: COST_BETA_ORDINARY_REGISTRATION_GRANT_CREDITS,
    providerCurrency: "CNY",
    providerMinorUnitScale: 2,
    creditUnitsPerProviderMinor: 1,
    entries: canonicalEntries,
  };
  if (
    value.version
    !== policyVersion(phase, catalog.fingerprint, versionlessPolicy)
  ) fail();
}

export function costBetaPricingFingerprint(value: unknown): string {
  if (typeof value === "string") {
    return parseCostBetaPricingVersion(value).fingerprint;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const policy = record.policy;
    if (policy !== null && typeof policy === "object") {
      return parseCostBetaPricingVersion(
        (policy as Record<string, unknown>).version,
      ).fingerprint;
    }
    return parseCostBetaPricingVersion(record.version).fingerprint;
  }
  fail();
}

export function assertCostBetaPricingActivation(
  policy: Pick<CostBetaPolicy, "version">,
  env: Record<string, string | undefined> = process.env,
): void {
  if (
    env.AISTORY_PLATFORM_BILLING_ENABLED !== "true"
    || env[COST_BETA_PRICING_MODE_ENV] !== COST_BETA_PRICING_MODE_CONFIG
    || env[COST_BETA_PRICING_VERSION_ENV] !== policy.version
  ) {
    throw new CostBetaPricingActivationError();
  }
}

export function isCostBetaPricingModeRequested(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const configured = env[COST_BETA_PRICING_MODE_ENV];
  if (
    configured === undefined
    || configured === ""
    || configured === "disabled"
  ) {
    return false;
  }
  if (configured === COST_BETA_PRICING_MODE_CONFIG) return true;
  // Recognized legacy selector: the v1 fixed-beta lane owns it, so v2 is not
  // requested (it must not throw and break older deployment envs).
  if (configured === FIXED_BETA_PRICING_MODE_CONFIG) return false;
  // Unknown non-empty selector: misconfiguration, fail closed.
  throw new CostBetaPricingActivationError();
}

export function costBetaPricingPolicyEnvelopeFingerprint(): string {
  return PLATFORM_COST_ENVELOPE_FINGERPRINT;
}

export function costBetaPricingEnvelopeSpec(): unknown {
  return PLATFORM_COST_ENVELOPE_SPEC;
}
