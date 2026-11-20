import "server-only";

import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";

import {
  buildFixedBetaPricingCandidate,
  FIXED_BETA_CREDITS_PER_OPERATION,
  FIXED_BETA_OPERATION_CONTRACT,
  FIXED_BETA_PRICING_SCHEMA,
  FIXED_BETA_RUNTIME_BINDING_PROVIDER,
  type FixedBetaOperation,
  type FixedBetaOperationPin,
  type FixedBetaPricingCandidate,
} from "@/lib/billing/fixedBetaPricing";

export const FIXED_BETA_PROVIDER_COST_CATALOG_SCHEMA =
  "aistory.fixed-beta-provider-cost-catalog/v1" as const;
export const FIXED_BETA_PROVIDER_COST_CATALOG_ID =
  "fixed-beta-provider-cost-cn-beijing" as const;
export const FIXED_BETA_PROVIDER_COST_CATALOG_VERSION =
  "v1-2026-08-28" as const;
export const FIXED_BETA_PROVIDER_COST_CATALOG_STATUS =
  "LOCAL_COST_AUDIT_CANDIDATE_ONLY" as const;
export const FIXED_BETA_PROVIDER_COST_REGION = "cn-beijing" as const;
export const FIXED_BETA_PROVIDER_COST_CURRENCY = "CNY" as const;
export const FIXED_BETA_PROVIDER_COST_MINOR_UNIT_SCALE = 2 as const;
export const FIXED_BETA_PROVIDER_COST_FORMULA =
  "ceil(sum(ceil(maxQuantityPerAttempt*maxBillableAttempts*unitPriceMinor/unitQuantity))*(10000+bufferBasisPoints)/10000)" as const;
export const FIXED_BETA_PROVIDER_COST_CATALOG_FINGERPRINT =
  "sha256:350aafb82c76ba1c2a3ad81739fc85c67ce7c2398cc91151a86bc3d52938357e" as const;

const CATALOG_KEYS = [
  "candidateEffectiveOn",
  "catalogId",
  "catalogVersion",
  "collectedOn",
  "eligibleEnvelopeAuthorities",
  "fingerprint",
  "operations",
  "providerCurrency",
  "providerMinorUnitScale",
  "region",
  "review",
  "riskPolicy",
  "schema",
  "sources",
  "status",
  "userPricing",
] as const;
const ENVELOPE_AUTHORITY_KEYS = ["path", "sha256"] as const;
const REVIEW_KEYS = [
  "budgetRiskApproval",
  "founderBusinessAmountApproval",
  "technicalCoverage",
] as const;
const RISK_POLICY_KEYS = [
  "aggregationPolicy",
  "bufferBasisPoints",
  "cachePolicy",
  "formula",
  "retryPolicy",
  "roundingPolicy",
] as const;
const USER_PRICING_KEYS = [
  "fixedCreditsPerOperation",
  "pricingMode",
  "providerCostPurpose",
  "saveSchema",
] as const;
const SOURCE_KEYS = [
  "capturedOn",
  "currency",
  "model",
  "modelVersion",
  "modelVersionStatus",
  "officialUrl",
  "priceFacts",
  "protocol",
  "provider",
  "publisher",
  "region",
  "sourceEffectiveOn",
  "sourceEffectiveOnStatus",
  "sourceId",
] as const;
const PRICE_FACT_KEYS = [
  "condition",
  "factId",
  "metric",
  "unitPriceMinor",
  "unitQuantity",
] as const;
const OPERATION_KEYS = [
  "aggregationPolicy",
  "bufferBasisPoints",
  "cachePolicy",
  "eligibility",
  "formulaId",
  "limitEvidence",
  "modality",
  "operation",
  "pricingLines",
  "providerCostMinor",
  "reasonCodes",
  "requestLimits",
  "retryPolicy",
  "roundingPolicy",
  "runtimeBinding",
  "sourceIds",
  "technicalReviewStatus",
] as const;
const RUNTIME_BINDING_KEYS = ["model", "provider"] as const;
const REQUEST_LIMIT_KEYS = [
  "billableAttemptsMax",
  "inputImagesMax",
  "inputTokensMax",
  "outputImagesPerAttemptMax",
  "outputTokensMax",
  "providerInvocationsMax",
  "returnedArtifactsMax",
  "ttsCharactersMax",
] as const;
const LIMIT_EVIDENCE_KEYS = ["maximum", "metric", "reference"] as const;
const PRICING_LINE_KEYS = [
  "factId",
  "maxBillableAttempts",
  "maxQuantityPerAttempt",
  "sourceId",
] as const;

const EXPECTED_SOURCE_BINDINGS = {
  "qwen-image-2.0-pro-beijing-output-image": {
    officialUrl: "https://help.aliyun.com/zh/model-studio/model-pricing",
    provider: "alibaba_model_studio",
    protocol: "dashscope_multimodal_generation",
    model: "qwen-image-2.0-pro",
  },
  "qwen-plus-beijing-token-pricing": {
    officialUrl: "https://help.aliyun.com/zh/model-studio/qwen-plus",
    provider: "alibaba_model_studio",
    protocol: "openai_compatible",
    model: "qwen-plus",
  },
  "qwen-vl-plus-beijing-token-pricing": {
    officialUrl: "https://help.aliyun.com/zh/model-studio/qwen-vl-plus",
    provider: "alibaba_model_studio",
    protocol: "openai_compatible",
    model: "qwen-vl-plus",
  },
  "qwen3-tts-flash-beijing-character-pricing": {
    officialUrl: "https://help.aliyun.com/zh/model-studio/qwen3-tts-flash",
    provider: "alibaba_model_studio",
    protocol: "dashscope_multimodal_generation",
    model: "qwen3-tts-flash",
  },
} as const;

const EXPECTED_ELIGIBLE_ENVELOPE_AUTHORITY_PATHS = [
  "app/api/style-hot-swap/route.ts",
  "lib/ai-client/fetchWithRetry.ts",
  "lib/ai-client/image.ts",
  "lib/engine/agents/painter.ts",
  "lib/engine/styleHotSwapCache.ts",
] as const;

type SourceId = keyof typeof EXPECTED_SOURCE_BINDINGS;

const EXPECTED_RUNTIME_BINDINGS = {
  "story.start": "sha256:d72af0bdaef2adccbfc9dee94fcdbefd1a41a6f2dde1c49ccd780572fdabad3b",
  "story.scene": "sha256:986dc2f5c71f447b53b6b749258426777366bee4838600773a21e5482d36dda1",
  "story.scene.prefetch": "sha256:c394ccdb00be31851c3fb17d007db9b76670ea617cd88362ca7795773eb374a4",
  "vision.decide": "sha256:216cc94d79525a9ae4f78ea9c24f0e6d91995b028ab83b5bae6de08f2fdb09f6",
  "story.classify-freeform": "sha256:0f55061a0a8b5e44c6625bbf9eabc6d50b355f0163d0ffe2c0be7776488e075b",
  "story.insert-beat": "sha256:6f2d845663d0b199d6c6e3f69e744927333aad2c167e6312e62ec9d525c5095f",
  "style.redraw": "sha256:5414dfed2e938cf6476c65f85fe502906db2c7a498227f8dfe3cbfeb811116ce",
  "style.rewrite": "sha256:cda91ed6808c2b19c071efe93cfa9ddb0e2a769b721bcbd75334bb5a5eb3233a",
  "vision.style-parse": "sha256:de5b0a70fce11d07757ed3b937ca761f19122525b4de907e3c7c0db8abc6f521",
  "text.character-names": "sha256:4a3f8273d34cdfd68f78dac9963de4c63e6aec885054e934d9ba4f672e499fb4",
  "tts.beat": "sha256:057893112542c892fc67ac2ac4aa7807179412468f531be897683a94d462930a",
} as const satisfies Record<FixedBetaOperation, string>;

const EXPECTED_SOURCE_IDS = {
  "story.start": [
    "qwen-image-2.0-pro-beijing-output-image",
    "qwen-plus-beijing-token-pricing",
    "qwen3-tts-flash-beijing-character-pricing",
  ],
  "story.scene": [
    "qwen-image-2.0-pro-beijing-output-image",
    "qwen-plus-beijing-token-pricing",
    "qwen3-tts-flash-beijing-character-pricing",
  ],
  "story.scene.prefetch": [
    "qwen-image-2.0-pro-beijing-output-image",
    "qwen-plus-beijing-token-pricing",
    "qwen3-tts-flash-beijing-character-pricing",
  ],
  "vision.decide": ["qwen-vl-plus-beijing-token-pricing"],
  "story.classify-freeform": ["qwen-plus-beijing-token-pricing"],
  "story.insert-beat": ["qwen-plus-beijing-token-pricing"],
  "style.redraw": ["qwen-image-2.0-pro-beijing-output-image"],
  "style.rewrite": ["qwen-plus-beijing-token-pricing"],
  "vision.style-parse": ["qwen-vl-plus-beijing-token-pricing"],
  "text.character-names": ["qwen-plus-beijing-token-pricing"],
  "tts.beat": ["qwen3-tts-flash-beijing-character-pricing"],
} as const satisfies Record<FixedBetaOperation, readonly SourceId[]>;

const ALLOWED_NOT_ELIGIBLE_REASONS = new Set([
  "unbounded_provider_call_count",
  "unbounded_text_input_output_tokens",
  "unbounded_tts_billing_characters",
  "unbounded_vision_input_output_units",
]);

type BillingModality = (typeof FIXED_BETA_OPERATION_CONTRACT)[number]["modality"];

type PriceFact = Readonly<{
  condition: string;
  factId: string;
  metric: string;
  unitPriceMinor: number;
  unitQuantity: number;
}>;

type PricingSource = Readonly<{
  capturedOn: string;
  currency: typeof FIXED_BETA_PROVIDER_COST_CURRENCY;
  model: string;
  modelVersion: string | null;
  modelVersionStatus: string;
  officialUrl: string;
  priceFacts: readonly PriceFact[];
  protocol: string;
  provider: string;
  publisher: "Alibaba Cloud Model Studio";
  region: typeof FIXED_BETA_PROVIDER_COST_REGION;
  sourceEffectiveOn: string | null;
  sourceEffectiveOnStatus: "NOT_STATED_BY_SOURCE";
  sourceId: SourceId;
}>;

type RequestLimits = Readonly<{
  billableAttemptsMax: number | null;
  inputImagesMax: number | null;
  inputTokensMax: number | null;
  outputImagesPerAttemptMax: number | null;
  outputTokensMax: number | null;
  providerInvocationsMax: number | null;
  returnedArtifactsMax: number | null;
  ttsCharactersMax: number | null;
}>;

type LimitEvidence = Readonly<{
  maximum: number | null;
  metric: string;
  reference: string;
}>;

type PricingLine = Readonly<{
  factId: string;
  maxBillableAttempts: number;
  maxQuantityPerAttempt: number;
  sourceId: SourceId;
}>;

type CostOperation = Readonly<{
  aggregationPolicy: string;
  bufferBasisPoints: number;
  cachePolicy: string;
  eligibility: "eligible" | "not_eligible";
  formulaId: "minor_cost_v1" | null;
  limitEvidence: readonly LimitEvidence[];
  modality: BillingModality;
  operation: FixedBetaOperation;
  pricingLines: readonly PricingLine[];
  providerCostMinor: number | null;
  reasonCodes: readonly string[];
  requestLimits: RequestLimits;
  retryPolicy: string;
  roundingPolicy: string;
  runtimeBinding: Readonly<{
    model: string;
    provider: typeof FIXED_BETA_RUNTIME_BINDING_PROVIDER;
  }>;
  sourceIds: readonly SourceId[];
  technicalReviewStatus: string;
}>;

type ParsedCatalog = Readonly<{
  candidateEffectiveOn: string;
  catalogId: typeof FIXED_BETA_PROVIDER_COST_CATALOG_ID;
  catalogVersion: typeof FIXED_BETA_PROVIDER_COST_CATALOG_VERSION;
  collectedOn: string;
  eligibleEnvelopeAuthorities: readonly Readonly<{
    path: (typeof EXPECTED_ELIGIBLE_ENVELOPE_AUTHORITY_PATHS)[number];
    sha256: string;
  }>[];
  fingerprint: string;
  operations: readonly CostOperation[];
  providerCurrency: typeof FIXED_BETA_PROVIDER_COST_CURRENCY;
  providerMinorUnitScale: typeof FIXED_BETA_PROVIDER_COST_MINOR_UNIT_SCALE;
  region: typeof FIXED_BETA_PROVIDER_COST_REGION;
  review: Readonly<{
    budgetRiskApproval: "PENDING" | "APPROVED";
    founderBusinessAmountApproval: "PENDING" | "APPROVED";
    technicalCoverage: "PARTIAL" | "COMPLETE";
  }>;
  riskPolicy: Readonly<{
    aggregationPolicy: "SUM_ALL_POTENTIALLY_BILLABLE_ATTEMPTS";
    bufferBasisPoints: number;
    cachePolicy: "NO_CACHE_DISCOUNT_FOR_MISS_ENVELOPE";
    formula: typeof FIXED_BETA_PROVIDER_COST_FORMULA;
    retryPolicy: "COUNT_EVERY_POTENTIALLY_BILLABLE_ATTEMPT";
    roundingPolicy: "CEIL_EACH_LINE_THEN_CEIL_BUFFER_TO_MINOR";
  }>;
  schema: typeof FIXED_BETA_PROVIDER_COST_CATALOG_SCHEMA;
  sources: readonly PricingSource[];
  status: typeof FIXED_BETA_PROVIDER_COST_CATALOG_STATUS;
  userPricing: Readonly<{
    fixedCreditsPerOperation: typeof FIXED_BETA_CREDITS_PER_OPERATION;
    pricingMode: "fixed_beta_credit_v1";
    providerCostPurpose: "AUDIT_AND_RISK_CONTROL_ONLY";
    saveSchema: typeof FIXED_BETA_PRICING_SCHEMA;
  }>;
}>;

export type FixedBetaProviderCostCatalogAssessment = Readonly<{
  schema: typeof FIXED_BETA_PROVIDER_COST_CATALOG_SCHEMA;
  status:
    | "BLOCKED_INELIGIBLE_OPERATIONS"
    | "BLOCKED_REVIEW_APPROVALS"
    | "LOCAL_POLICY_PROJECTION_AVAILABLE";
  catalogId: typeof FIXED_BETA_PROVIDER_COST_CATALOG_ID;
  catalogVersion: typeof FIXED_BETA_PROVIDER_COST_CATALOG_VERSION;
  catalogFingerprint: string;
  operationCount: 11;
  eligibleCount: number;
  ineligibleCount: number;
  eligibleOperations: readonly FixedBetaOperation[];
  ineligibleOperations: readonly Readonly<{
    operation: FixedBetaOperation;
    reasonCodes: readonly string[];
  }>[];
  policyCandidateAvailable: boolean;
  policyCandidate: FixedBetaPricingCandidate | null;
  policySaveAllowed: false;
  activationAllowed: false;
  productionWriteAllowed: false;
  providerContacted: false;
  networkCalls: 0;
  writesPerformed: 0;
}>;

export class FixedBetaProviderCostCatalogError extends Error {
  readonly code = "FIXED_BETA_PROVIDER_COST_CATALOG_INVALID";

  constructor() {
    super("Fixed beta provider cost catalog is invalid.");
    this.name = "FixedBetaProviderCostCatalogError";
  }
}

function fail(): never {
  throw new FixedBetaProviderCostCatalogError();
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
    if (error instanceof FixedBetaProviderCostCatalogError) throw error;
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
    const expected = [...expectedKeys].sort();
    if (
      keys.length !== expected.length
      || keys.some((key, index) => key !== expected[index])
    ) fail();
  } catch (error) {
    if (error instanceof FixedBetaProviderCostCatalogError) throw error;
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
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!("value" in descriptor)) fail();
      if (
        key !== "length"
        && (!/^(0|[1-9][0-9]*)$/.test(key) || !descriptor.enumerable)
      ) fail();
    }
    if (Object.keys(descriptors).length !== value.length + 1) fail();
  } catch (error) {
    if (error instanceof FixedBetaProviderCostCatalogError) throw error;
    fail();
  }
}

function safeIdentifier(value: unknown, maximumLength = 120): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximumLength
    || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)
    || value.includes("..")
    || value.includes("//")
  ) fail();
  return value;
}

function safeReviewValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) fail();
  return value as T;
}

function safeDate(value: unknown): string {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}$/.test(value)
  ) fail();
  const [year, month, day] = value.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) fail();
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.toISOString().slice(0, 10) !== value) fail();
  return value;
}

function safeInteger(value: unknown, minimum: number, maximum: number): number {
  if (
    !Number.isSafeInteger(value)
    || (value as number) < minimum
    || (value as number) > maximum
  ) fail();
  return value as number;
}

function safeNullableInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number | null {
  return value === null ? null : safeInteger(value, minimum, maximum);
}

function safeOfficialUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 512) fail();
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:"
      || parsed.hostname !== "help.aliyun.com"
      || parsed.port
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
      || !parsed.pathname.startsWith("/zh/model-studio/")
      || parsed.toString() !== value
    ) fail();
  } catch (error) {
    if (error instanceof FixedBetaProviderCostCatalogError) throw error;
    fail();
  }
  return value;
}

function safeReference(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 3
    || value.length > 240
    || !/^[A-Za-z0-9_./\[\]-]+\.tsx?:[1-9][0-9]*$/.test(value)
    || value.includes("..")
    || value.startsWith("/")
    || /^[A-Za-z]:/.test(value)
  ) fail();
  return value;
}

function parseEligibleEnvelopeAuthorities(value: unknown): Array<{
  path: (typeof EXPECTED_ELIGIBLE_ENVELOPE_AUTHORITY_PATHS)[number];
  sha256: string;
}> {
  assertPlainDataArray(value);
  if (value.length !== EXPECTED_ELIGIBLE_ENVELOPE_AUTHORITY_PATHS.length) fail();
  const expectedPaths = new Set<string>(EXPECTED_ELIGIBLE_ENVELOPE_AUTHORITY_PATHS);
  const seen = new Set<string>();
  const parsed = value.map((item) => {
    assertExactDataRecord(item, ENVELOPE_AUTHORITY_KEYS);
    const authorityPath = safeIdentifier(item.path, 240);
    if (
      !expectedPaths.has(authorityPath)
      || seen.has(authorityPath)
      || typeof item.sha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(item.sha256)
    ) fail();
    seen.add(authorityPath);
    return {
      path: authorityPath as (typeof EXPECTED_ELIGIBLE_ENVELOPE_AUTHORITY_PATHS)[number],
      sha256: item.sha256,
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
  if (seen.size !== expectedPaths.size) fail();
  return parsed;
}

function safeStringArray(value: unknown, maximumItems: number): string[] {
  assertPlainDataArray(value);
  if (value.length > maximumItems) fail();
  return value.map((item) => safeIdentifier(item));
}

function parsePriceFacts(value: unknown): PriceFact[] {
  assertPlainDataArray(value);
  if (value.length < 1 || value.length > 16) fail();
  const seen = new Set<string>();
  return value.map((item) => {
    assertExactDataRecord(item, PRICE_FACT_KEYS);
    const factId = safeIdentifier(item.factId);
    if (seen.has(factId)) fail();
    seen.add(factId);
    return {
      condition: safeIdentifier(item.condition, 160),
      factId,
      metric: safeIdentifier(item.metric),
      unitPriceMinor: safeInteger(item.unitPriceMinor, 1, 1_000_000),
      unitQuantity: safeInteger(item.unitQuantity, 1, 10_000_000),
    };
  }).sort((left, right) => left.factId.localeCompare(right.factId));
}

function parseSources(value: unknown): PricingSource[] {
  assertPlainDataArray(value);
  const sourceIds = Object.keys(EXPECTED_SOURCE_BINDINGS) as SourceId[];
  if (value.length !== sourceIds.length) fail();
  const seen = new Set<string>();
  const sources = value.map((item) => {
    assertExactDataRecord(item, SOURCE_KEYS);
    const sourceId = safeIdentifier(item.sourceId) as SourceId;
    const expected = EXPECTED_SOURCE_BINDINGS[sourceId];
    if (!expected || seen.has(sourceId)) fail();
    seen.add(sourceId);
    const officialUrl = safeOfficialUrl(item.officialUrl);
    const provider = safeIdentifier(item.provider);
    const protocol = safeIdentifier(item.protocol);
    const model = safeIdentifier(item.model);
    if (
      officialUrl !== expected.officialUrl
      || provider !== expected.provider
      || protocol !== expected.protocol
      || model !== expected.model
      || item.publisher !== "Alibaba Cloud Model Studio"
      || item.region !== FIXED_BETA_PROVIDER_COST_REGION
      || item.currency !== FIXED_BETA_PROVIDER_COST_CURRENCY
      || item.sourceEffectiveOn !== null
      || item.sourceEffectiveOnStatus !== "NOT_STATED_BY_SOURCE"
    ) fail();
    const modelVersion = item.modelVersion === null
      ? null
      : safeIdentifier(item.modelVersion, 160);
    const modelVersionStatus = safeReviewValue(item.modelVersionStatus, [
      "OFFICIAL_ALIAS_SNAPSHOT",
      "ALIAS_VERSION_CONFLICT_REQUIRES_REVIEW",
    ] as const);
    if (
      (modelVersion === null)
        !== (modelVersionStatus === "ALIAS_VERSION_CONFLICT_REQUIRES_REVIEW")
    ) fail();
    return {
      capturedOn: safeDate(item.capturedOn),
      currency: FIXED_BETA_PROVIDER_COST_CURRENCY,
      model,
      modelVersion,
      modelVersionStatus,
      officialUrl,
      priceFacts: parsePriceFacts(item.priceFacts),
      protocol,
      provider,
      publisher: "Alibaba Cloud Model Studio" as const,
      region: FIXED_BETA_PROVIDER_COST_REGION,
      sourceEffectiveOn: null,
      sourceEffectiveOnStatus: "NOT_STATED_BY_SOURCE" as const,
      sourceId,
    };
  }).sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  if (seen.size !== sourceIds.length) fail();
  return sources;
}

function parseRequestLimits(value: unknown): RequestLimits {
  assertExactDataRecord(value, REQUEST_LIMIT_KEYS);
  return {
    billableAttemptsMax: safeNullableInteger(value.billableAttemptsMax, 1, 1_000),
    inputImagesMax: safeNullableInteger(value.inputImagesMax, 0, 1_000),
    inputTokensMax: safeNullableInteger(value.inputTokensMax, 1, 10_000_000),
    outputImagesPerAttemptMax: safeNullableInteger(
      value.outputImagesPerAttemptMax,
      1,
      1_000,
    ),
    outputTokensMax: safeNullableInteger(value.outputTokensMax, 1, 10_000_000),
    providerInvocationsMax: safeNullableInteger(
      value.providerInvocationsMax,
      1,
      1_000,
    ),
    returnedArtifactsMax: safeNullableInteger(value.returnedArtifactsMax, 0, 1_000),
    ttsCharactersMax: safeNullableInteger(value.ttsCharactersMax, 1, 10_000_000),
  };
}

function parseLimitEvidence(value: unknown): LimitEvidence[] {
  assertPlainDataArray(value);
  if (value.length < 1 || value.length > 24) fail();
  const seen = new Set<string>();
  return value.map((item) => {
    assertExactDataRecord(item, LIMIT_EVIDENCE_KEYS);
    const metric = safeIdentifier(item.metric);
    const reference = safeReference(item.reference);
    const key = `${metric}\u0000${reference}`;
    if (seen.has(key)) fail();
    seen.add(key);
    return {
      maximum: safeNullableInteger(item.maximum, 0, 10_000_000),
      metric,
      reference,
    };
  }).sort((left, right) => (
    left.metric.localeCompare(right.metric)
    || left.reference.localeCompare(right.reference)
  ));
}

function parsePricingLines(value: unknown): PricingLine[] {
  assertPlainDataArray(value);
  if (value.length > 16) fail();
  const seen = new Set<string>();
  return value.map((item) => {
    assertExactDataRecord(item, PRICING_LINE_KEYS);
    const sourceId = safeIdentifier(item.sourceId) as SourceId;
    if (!EXPECTED_SOURCE_BINDINGS[sourceId]) fail();
    const factId = safeIdentifier(item.factId);
    const key = `${sourceId}\u0000${factId}`;
    if (seen.has(key)) fail();
    seen.add(key);
    return {
      factId,
      maxBillableAttempts: safeInteger(item.maxBillableAttempts, 1, 1_000),
      maxQuantityPerAttempt: safeInteger(
        item.maxQuantityPerAttempt,
        1,
        10_000_000,
      ),
      sourceId,
    };
  }).sort((left, right) => (
    left.sourceId.localeCompare(right.sourceId)
    || left.factId.localeCompare(right.factId)
  ));
}

function ceilDivide(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n || numerator < 0n) fail();
  return (numerator + denominator - 1n) / denominator;
}

function calculateProviderCostMinor(
  operation: CostOperation,
  sources: ReadonlyMap<SourceId, PricingSource>,
): number {
  let subtotal = 0n;
  for (const line of operation.pricingLines) {
    const source = sources.get(line.sourceId);
    const fact = source?.priceFacts.find((candidate) => candidate.factId === line.factId);
    if (!source || !fact || !operation.sourceIds.includes(line.sourceId)) fail();
    const numerator = BigInt(line.maxQuantityPerAttempt)
      * BigInt(line.maxBillableAttempts)
      * BigInt(fact.unitPriceMinor);
    subtotal += ceilDivide(numerator, BigInt(fact.unitQuantity));
  }
  const buffered = ceilDivide(
    subtotal * BigInt(10_000 + operation.bufferBasisPoints),
    10_000n,
  );
  if (buffered < 1n || buffered > BigInt(Number.MAX_SAFE_INTEGER)) fail();
  return Number(buffered);
}

function parseOperations(
  value: unknown,
  sources: readonly PricingSource[],
): CostOperation[] {
  assertPlainDataArray(value);
  if (value.length !== FIXED_BETA_OPERATION_CONTRACT.length) fail();
  const definitions = new Map(
    FIXED_BETA_OPERATION_CONTRACT.map((definition, index) => [
      definition.operation,
      { ...definition, index },
    ]),
  );
  const sourceMap = new Map(sources.map((source) => [source.sourceId, source]));
  const seen = new Set<string>();
  const operations = value.map((item) => {
    assertExactDataRecord(item, OPERATION_KEYS);
    const operation = safeIdentifier(item.operation) as FixedBetaOperation;
    const definition = definitions.get(operation);
    if (!definition || seen.has(operation) || item.modality !== definition.modality) fail();
    seen.add(operation);
    assertExactDataRecord(item.runtimeBinding, RUNTIME_BINDING_KEYS);
    if (
      item.runtimeBinding.provider !== FIXED_BETA_RUNTIME_BINDING_PROVIDER
      || item.runtimeBinding.model !== EXPECTED_RUNTIME_BINDINGS[operation]
    ) fail();
    const sourceIds = safeStringArray(item.sourceIds, 4).sort() as SourceId[];
    const expectedSourceIds = [...EXPECTED_SOURCE_IDS[operation]].sort();
    if (
      sourceIds.length !== expectedSourceIds.length
      || sourceIds.some((sourceId, index) => (
        sourceId !== expectedSourceIds[index] || !sourceMap.has(sourceId)
      ))
    ) fail();
    const eligibility = safeReviewValue(item.eligibility, [
      "eligible",
      "not_eligible",
    ] as const);
    const reasonCodes = safeStringArray(item.reasonCodes, 8).sort();
    if (new Set(reasonCodes).size !== reasonCodes.length) fail();
    const requestLimits = parseRequestLimits(item.requestLimits);
    const limitEvidence = parseLimitEvidence(item.limitEvidence);
    const pricingLines = parsePricingLines(item.pricingLines);
    const bufferBasisPoints = safeInteger(item.bufferBasisPoints, 0, 100_000);
    const formulaId = item.formulaId === null
      ? null
      : safeReviewValue(item.formulaId, ["minor_cost_v1"] as const);
    const providerCostMinor = item.providerCostMinor === null
      ? null
      : safeInteger(item.providerCostMinor, 1, Number.MAX_SAFE_INTEGER);
    const parsed: CostOperation = {
      aggregationPolicy: safeIdentifier(item.aggregationPolicy, 160),
      bufferBasisPoints,
      cachePolicy: safeIdentifier(item.cachePolicy, 160),
      eligibility,
      formulaId,
      limitEvidence,
      modality: definition.modality,
      operation,
      pricingLines,
      providerCostMinor,
      reasonCodes,
      requestLimits,
      retryPolicy: safeIdentifier(item.retryPolicy, 160),
      roundingPolicy: safeIdentifier(item.roundingPolicy, 160),
      runtimeBinding: {
        model: EXPECTED_RUNTIME_BINDINGS[operation],
        provider: FIXED_BETA_RUNTIME_BINDING_PROVIDER,
      },
      sourceIds,
      technicalReviewStatus: safeIdentifier(item.technicalReviewStatus, 160),
    };
    if (eligibility === "not_eligible") {
      if (
        reasonCodes.length < 1
        || reasonCodes.some((reason) => !ALLOWED_NOT_ELIGIBLE_REASONS.has(reason))
        || formulaId !== null
        || pricingLines.length !== 0
        || providerCostMinor !== null
        || parsed.technicalReviewStatus !== "BLOCKED_MISSING_REQUEST_CAP"
      ) fail();
    } else {
      if (
        reasonCodes.length !== 0
        || formulaId !== "minor_cost_v1"
        || pricingLines.length < 1
        || providerCostMinor === null
        || requestLimits.billableAttemptsMax === null
        || requestLimits.providerInvocationsMax === null
        || parsed.technicalReviewStatus !== "MECHANICALLY_VERIFIED"
        || parsed.aggregationPolicy !== "sum_all_potentially_billable_attempts"
        || parsed.cachePolicy !== "cache_hit_zero_cost_miss_uses_full_envelope"
        || parsed.retryPolicy !== "global_worst_case_billable_attempt_bound"
        || parsed.roundingPolicy !== "ceil_each_line_then_ceil_buffer_to_minor"
      ) fail();
      if (
        pricingLines.some((line) => (
          line.maxBillableAttempts > requestLimits.billableAttemptsMax!
        ))
        || calculateProviderCostMinor(parsed, sourceMap) !== providerCostMinor
      ) fail();
    }
    return parsed;
  });
  if (seen.size !== definitions.size) fail();
  operations.sort((left, right) => (
    definitions.get(left.operation)!.index - definitions.get(right.operation)!.index
  ));
  return operations;
}

function canonicalPayload(catalog: Omit<ParsedCatalog, "fingerprint">): string {
  return JSON.stringify(catalog);
}

function parseCatalog(
  value: unknown,
  verifyDeclaredFingerprint = true,
): ParsedCatalog {
  assertExactDataRecord(value, CATALOG_KEYS);
  if (
    value.schema !== FIXED_BETA_PROVIDER_COST_CATALOG_SCHEMA
    || value.catalogId !== FIXED_BETA_PROVIDER_COST_CATALOG_ID
    || value.catalogVersion !== FIXED_BETA_PROVIDER_COST_CATALOG_VERSION
    || value.status !== FIXED_BETA_PROVIDER_COST_CATALOG_STATUS
    || value.providerCurrency !== FIXED_BETA_PROVIDER_COST_CURRENCY
    || value.providerMinorUnitScale !== FIXED_BETA_PROVIDER_COST_MINOR_UNIT_SCALE
    || value.region !== FIXED_BETA_PROVIDER_COST_REGION
    || typeof value.fingerprint !== "string"
    || !/^sha256:[a-f0-9]{64}$/.test(value.fingerprint)
  ) fail();
  assertExactDataRecord(value.review, REVIEW_KEYS);
  const review = {
    budgetRiskApproval: safeReviewValue(value.review.budgetRiskApproval, [
      "PENDING",
      "APPROVED",
    ] as const),
    founderBusinessAmountApproval: safeReviewValue(
      value.review.founderBusinessAmountApproval,
      ["PENDING", "APPROVED"] as const,
    ),
    technicalCoverage: safeReviewValue(value.review.technicalCoverage, [
      "PARTIAL",
      "COMPLETE",
    ] as const),
  };
  assertExactDataRecord(value.riskPolicy, RISK_POLICY_KEYS);
  const riskPolicy = {
    aggregationPolicy: safeReviewValue(value.riskPolicy.aggregationPolicy, [
      "SUM_ALL_POTENTIALLY_BILLABLE_ATTEMPTS",
    ] as const),
    bufferBasisPoints: safeInteger(value.riskPolicy.bufferBasisPoints, 0, 100_000),
    cachePolicy: safeReviewValue(value.riskPolicy.cachePolicy, [
      "NO_CACHE_DISCOUNT_FOR_MISS_ENVELOPE",
    ] as const),
    formula: safeReviewValue(value.riskPolicy.formula, [
      FIXED_BETA_PROVIDER_COST_FORMULA,
    ] as const),
    retryPolicy: safeReviewValue(value.riskPolicy.retryPolicy, [
      "COUNT_EVERY_POTENTIALLY_BILLABLE_ATTEMPT",
    ] as const),
    roundingPolicy: safeReviewValue(value.riskPolicy.roundingPolicy, [
      "CEIL_EACH_LINE_THEN_CEIL_BUFFER_TO_MINOR",
    ] as const),
  };
  assertExactDataRecord(value.userPricing, USER_PRICING_KEYS);
  if (
    value.userPricing.fixedCreditsPerOperation !== FIXED_BETA_CREDITS_PER_OPERATION
    || value.userPricing.pricingMode !== "fixed_beta_credit_v1"
    || value.userPricing.providerCostPurpose !== "AUDIT_AND_RISK_CONTROL_ONLY"
    || value.userPricing.saveSchema !== FIXED_BETA_PRICING_SCHEMA
  ) fail();
  const collectedOn = safeDate(value.collectedOn);
  const candidateEffectiveOn = safeDate(value.candidateEffectiveOn);
  const eligibleEnvelopeAuthorities = parseEligibleEnvelopeAuthorities(
    value.eligibleEnvelopeAuthorities,
  );
  const sources = parseSources(value.sources);
  if (sources.some((source) => source.capturedOn !== collectedOn)) fail();
  const operations = parseOperations(value.operations, sources);
  const eligibleCount = operations.filter(
    (operation) => operation.eligibility === "eligible",
  ).length;
  if (
    (eligibleCount === operations.length) !== (review.technicalCoverage === "COMPLETE")
    || operations.some((operation) => operation.bufferBasisPoints !== riskPolicy.bufferBasisPoints)
  ) fail();
  const normalizedWithoutFingerprint: Omit<ParsedCatalog, "fingerprint"> = {
    candidateEffectiveOn,
    catalogId: FIXED_BETA_PROVIDER_COST_CATALOG_ID,
    catalogVersion: FIXED_BETA_PROVIDER_COST_CATALOG_VERSION,
    collectedOn,
    eligibleEnvelopeAuthorities,
    operations,
    providerCurrency: FIXED_BETA_PROVIDER_COST_CURRENCY,
    providerMinorUnitScale: FIXED_BETA_PROVIDER_COST_MINOR_UNIT_SCALE,
    region: FIXED_BETA_PROVIDER_COST_REGION,
    review,
    riskPolicy,
    schema: FIXED_BETA_PROVIDER_COST_CATALOG_SCHEMA,
    sources,
    status: FIXED_BETA_PROVIDER_COST_CATALOG_STATUS,
    userPricing: {
      fixedCreditsPerOperation: FIXED_BETA_CREDITS_PER_OPERATION,
      pricingMode: "fixed_beta_credit_v1",
      providerCostPurpose: "AUDIT_AND_RISK_CONTROL_ONLY",
      saveSchema: FIXED_BETA_PRICING_SCHEMA,
    },
  };
  const fingerprint = `sha256:${createHash("sha256")
    .update(canonicalPayload(normalizedWithoutFingerprint), "utf8")
    .digest("hex")}`;
  if (
    verifyDeclaredFingerprint
    && (
      value.fingerprint !== fingerprint
      || fingerprint !== FIXED_BETA_PROVIDER_COST_CATALOG_FINGERPRINT
    )
  ) fail();
  return { ...normalizedWithoutFingerprint, fingerprint };
}

function buildPolicyProjection(catalog: ParsedCatalog): FixedBetaPricingCandidate | null {
  if (
    catalog.operations.some((operation) => operation.eligibility !== "eligible")
    || catalog.review.technicalCoverage !== "COMPLETE"
    || catalog.review.founderBusinessAmountApproval !== "APPROVED"
    || catalog.review.budgetRiskApproval !== "APPROVED"
  ) return null;
  const operationPins: FixedBetaOperationPin[] = catalog.operations.map(
    (operation) => {
      if (operation.providerCostMinor === null) fail();
      return {
        operation: operation.operation,
        provider: operation.runtimeBinding.provider,
        model: operation.runtimeBinding.model,
        providerCostMinor: operation.providerCostMinor,
      };
    },
  );
  return buildFixedBetaPricingCandidate({
    providerCurrency: catalog.providerCurrency,
    providerMinorUnitScale: catalog.providerMinorUnitScale,
    operationPins,
  });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}

export function inspectFixedBetaProviderCostCatalog(
  value: unknown,
): FixedBetaProviderCostCatalogAssessment {
  const catalog = parseCatalog(value);
  const eligibleOperations = catalog.operations
    .filter((operation) => operation.eligibility === "eligible")
    .map((operation) => operation.operation);
  const ineligibleOperations = catalog.operations
    .filter((operation) => operation.eligibility === "not_eligible")
    .map((operation) => ({
      operation: operation.operation,
      reasonCodes: [...operation.reasonCodes],
    }));
  const policyCandidate = buildPolicyProjection(catalog);
  const status = ineligibleOperations.length > 0
    ? "BLOCKED_INELIGIBLE_OPERATIONS"
    : policyCandidate
      ? "LOCAL_POLICY_PROJECTION_AVAILABLE"
      : "BLOCKED_REVIEW_APPROVALS";
  return deepFreeze({
    schema: FIXED_BETA_PROVIDER_COST_CATALOG_SCHEMA,
    status,
    catalogId: catalog.catalogId,
    catalogVersion: catalog.catalogVersion,
    catalogFingerprint: catalog.fingerprint,
    operationCount: 11,
    eligibleCount: eligibleOperations.length,
    ineligibleCount: ineligibleOperations.length,
    eligibleOperations,
    ineligibleOperations,
    policyCandidateAvailable: policyCandidate !== null,
    policyCandidate,
    policySaveAllowed: false,
    activationAllowed: false,
    productionWriteAllowed: false,
    providerContacted: false,
    networkCalls: 0,
    writesPerformed: 0,
  });
}

export function fingerprintFixedBetaProviderCostCatalogDraft(
  value: unknown,
): string {
  return parseCatalog(value, false).fingerprint;
}
