import "server-only";

import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";

import type {
  BillingPolicy,
  PriceCatalogEntry,
  ServerCreditLedgerEntry,
} from "@/lib/admin/types";
import type { ProviderConfig, TtsConfig } from "@infiplot/types";
import { inferTtsProvider } from "@/lib/tts-client";

export const FIXED_BETA_PRICING_SCHEMA =
  "aistory.fixed-beta-pricing-candidate/v1" as const;
export const FIXED_BETA_PRICING_VERSION_PREFIX = "fixed-beta-v1." as const;
export const FIXED_BETA_CREDITS_PER_OPERATION = 1 as const;
export const FIXED_BETA_ORDINARY_REGISTRATION_GRANT = 1_000 as const;
export const FIXED_BETA_PRICING_AUDIENCE =
  "phone_authenticated_platform_managed_v1" as const;
export const FIXED_BETA_PRICING_MODE = "fixed_beta_credit_v1" as const;
export const FIXED_BETA_PRICING_MODE_CONFIG =
  "aistory-platform-billing-v1:fixed_beta_credit_v1" as const;
export const FIXED_BETA_PRICING_MODE_ENV =
  "AISTORY_PLATFORM_BILLING_POLICY_MODE" as const;
export const FIXED_BETA_PRICING_VERSION_ENV =
  "AISTORY_PLATFORM_BILLING_POLICY_VERSION" as const;
export const FIXED_BETA_RUNTIME_BINDING_PROVIDER =
  "aistory_runtime_binding_v1" as const;

type BillingModality = NonNullable<ServerCreditLedgerEntry["modality"]>;

export const FIXED_BETA_OPERATION_CONTRACT = [
  { operation: "story.start", modality: "mixed" },
  { operation: "story.scene", modality: "mixed" },
  { operation: "story.scene.prefetch", modality: "mixed" },
  { operation: "vision.decide", modality: "vision" },
  { operation: "story.classify-freeform", modality: "text" },
  { operation: "story.insert-beat", modality: "text" },
  { operation: "style.redraw", modality: "image" },
  { operation: "style.rewrite", modality: "text" },
  { operation: "vision.style-parse", modality: "vision" },
  { operation: "text.character-names", modality: "text" },
  { operation: "tts.beat", modality: "tts" },
] as const satisfies ReadonlyArray<{
  operation: string;
  modality: BillingModality;
}>;

export type FixedBetaOperation =
  (typeof FIXED_BETA_OPERATION_CONTRACT)[number]["operation"];

type FixedBetaRuntimeRole = "text" | "image" | "vision" | "tts" | "tts_optional";

const FIXED_BETA_RUNTIME_ROLE_CONTRACT = {
  "story.start": ["text", "image", "tts_optional"],
  "story.scene": ["text", "image", "tts_optional"],
  "story.scene.prefetch": ["text", "image", "tts_optional"],
  "vision.decide": ["vision"],
  "story.classify-freeform": ["text"],
  "story.insert-beat": ["text"],
  "style.redraw": ["image"],
  "style.rewrite": ["text"],
  "vision.style-parse": ["vision"],
  "text.character-names": ["text"],
  "tts.beat": ["tts"],
} as const satisfies Record<FixedBetaOperation, readonly FixedBetaRuntimeRole[]>;

export type FixedBetaRuntimeConfig = {
  text: Pick<ProviderConfig, "baseUrl" | "model" | "provider">;
  image: Pick<ProviderConfig, "baseUrl" | "model" | "provider">;
  vision: Pick<ProviderConfig, "baseUrl" | "model" | "provider">;
  tts?: Pick<TtsConfig, "baseUrl" | "provider" | "speechModel">;
  mockImage?: boolean;
};

export type FixedBetaRuntimeBinding = Readonly<{
  provider: typeof FIXED_BETA_RUNTIME_BINDING_PROVIDER;
  model: string;
}>;

export type FixedBetaOperationPin = {
  operation: FixedBetaOperation;
  provider: string;
  model: string;
  providerCostMinor: number;
};

export type FixedBetaPricingCandidateInput = {
  providerCurrency: string;
  providerMinorUnitScale: number;
  operationPins: FixedBetaOperationPin[];
};

export type FixedBetaPricingCandidate = {
  schema: typeof FIXED_BETA_PRICING_SCHEMA;
  status: "LOCAL_POLICY_CANDIDATE_ONLY";
  pricingAudience: typeof FIXED_BETA_PRICING_AUDIENCE;
  fixedCreditsPerOperation: typeof FIXED_BETA_CREDITS_PER_OPERATION;
  operationCount: 11;
  ordinaryRegistrationGrantCredits:
    typeof FIXED_BETA_ORDINARY_REGISTRATION_GRANT;
  membershipGrantIncluded: false;
  productionWriteAllowed: false;
  providerContacted: false;
  networkCalls: 0;
  writesPerformed: 0;
  fingerprint: string;
  policy: Omit<BillingPolicy, "updatedAt" | "updatedBy">;
};

export class FixedBetaPricingContractError extends Error {
  readonly code = "FIXED_BETA_PRICING_CONTRACT_INVALID";

  constructor() {
    super("Fixed beta pricing candidate is invalid.");
    this.name = "FixedBetaPricingContractError";
  }
}

export class FixedBetaPricingActivationError extends Error {
  readonly code = "FIXED_BETA_PRICING_NOT_ENABLED";

  constructor() {
    super("Fixed beta pricing is not enabled for this policy version.");
    this.name = "FixedBetaPricingActivationError";
  }
}

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
const INPUT_KEYS = [
  "operationPins",
  "providerCurrency",
  "providerMinorUnitScale",
] as const;
const PIN_KEYS = [
  "model",
  "operation",
  "provider",
  "providerCostMinor",
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

function fail(): never {
  throw new FixedBetaPricingContractError();
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
    if (error instanceof FixedBetaPricingContractError) throw error;
    fail();
  }
}

function assertExactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): asserts value is Record<string, unknown> {
  assertDataRecord(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors).sort();
    const sortedExpectedKeys = [...expectedKeys].sort();
    if (
      keys.length !== expectedKeys.length
      || keys.some((key, index) => key !== sortedExpectedKeys[index])
    ) fail();
  } catch (error) {
    if (error instanceof FixedBetaPricingContractError) throw error;
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
        && (
          !/^(0|[1-9][0-9]*)$/.test(key)
          || !descriptor.enumerable
        )
      ) fail();
    }
  } catch (error) {
    if (error instanceof FixedBetaPricingContractError) throw error;
    fail();
  }
}

function safeIdentifier(value: unknown, maximumLength: number): string {
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

function safeModelIdentifier(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 160
    || !/^[A-Za-z0-9][A-Za-z0-9._/@:-]*$/.test(value)
    || value.includes("://")
    || value.includes("//")
    || value.includes("..")
  ) fail();
  return value;
}

function runtimeRoleDescriptor(
  role: FixedBetaRuntimeRole,
  config: FixedBetaRuntimeConfig,
): {
  role: "text" | "image" | "vision" | "tts";
  provider: string;
  model: string;
  endpoint: string;
} {
  const endpointHash = (value: unknown): string => {
    if (
      typeof value !== "string"
      || value.length < 1
      || value.length > 2_048
      || value.trim() !== value
      || /[\s\\?#]/.test(value)
      || value.endsWith("/")
    ) fail();
    const parsed = new URL(value);
    const authority = /^https:\/\/([^/]+)(?:\/|$)/.exec(value)?.[1];
    if (
      parsed.protocol !== "https:"
      || parsed.username
      || parsed.password
      || !authority
      || authority.includes("@")
    ) fail();
    return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
  };
  if (role === "text") {
    if (config.text.provider !== "openai_compatible") fail();
    return {
      role,
      provider: config.text.provider,
      model: safeModelIdentifier(config.text.model),
      endpoint: endpointHash(config.text.baseUrl),
    };
  }
  if (role === "vision") {
    if (config.vision.provider !== "openai_compatible") fail();
    return {
      role,
      provider: config.vision.provider,
      model: safeModelIdentifier(config.vision.model),
      endpoint: endpointHash(config.vision.baseUrl),
    };
  }
  if (role === "image") {
    if (
      config.mockImage === true
      || !config.image.provider
      || !["openai", "openai_compatible", "runware", "dashscope"]
        .includes(config.image.provider)
    ) fail();
    return {
      role,
      provider: config.image.provider,
      model: safeModelIdentifier(config.image.model),
      endpoint: endpointHash(config.image.baseUrl),
    };
  }
  const tts = config.tts;
  if (!tts) {
    if (role !== "tts_optional") fail();
    return {
      role: "tts",
      provider: "disabled",
      model: "disabled",
      endpoint: "disabled",
    };
  }
  if (
    !tts.provider
    || !["xiaomi", "stepfun", "bailian"].includes(tts.provider)
    || inferTtsProvider(tts as TtsConfig) !== tts.provider
  ) fail();
  return {
    role: "tts",
    provider: tts.provider,
    model: safeModelIdentifier(tts.speechModel),
    endpoint: endpointHash(tts.baseUrl),
  };
}

export function assertFixedBetaRuntimeBinding(
  value: unknown,
): asserts value is FixedBetaRuntimeBinding {
  assertExactDataRecord(value, ["model", "provider"]);
  if (
    value.provider !== FIXED_BETA_RUNTIME_BINDING_PROVIDER
    || typeof value.model !== "string"
    || !/^sha256:[a-f0-9]{64}$/.test(value.model)
  ) fail();
}

export function fixedBetaRuntimeBindingForOperation(
  operation: FixedBetaOperation,
  config: FixedBetaRuntimeConfig,
): FixedBetaRuntimeBinding {
  try {
    const roles = FIXED_BETA_RUNTIME_ROLE_CONTRACT[operation];
    if (!roles) fail();
    const descriptor = {
      schema: "aistory.fixed-beta-runtime-binding/v1",
      operation,
      roles: roles.map((role) => runtimeRoleDescriptor(role, config)),
    };
    const model = `sha256:${createHash("sha256")
      .update(JSON.stringify(descriptor), "utf8")
      .digest("hex")}`;
    return Object.freeze({
      provider: FIXED_BETA_RUNTIME_BINDING_PROVIDER,
      model,
    });
  } catch (error) {
    if (error instanceof FixedBetaPricingContractError) throw error;
    fail();
  }
}

function safePositiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail();
  return value as number;
}

function safeScale(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 6) {
    fail();
  }
  return value as number;
}

function safeCurrency(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Z]{3}$/.test(value)) fail();
  return value;
}

function canonicalPolicyPayload(
  policy: Omit<BillingPolicy, "updatedAt" | "updatedBy" | "version">,
): string {
  return JSON.stringify({
    schema: FIXED_BETA_PRICING_SCHEMA,
    pricingAudience: FIXED_BETA_PRICING_AUDIENCE,
    fixedCreditsPerOperation: FIXED_BETA_CREDITS_PER_OPERATION,
    operationCount: FIXED_BETA_OPERATION_CONTRACT.length,
    ordinaryRegistrationGrantCredits:
      FIXED_BETA_ORDINARY_REGISTRATION_GRANT,
    policy,
  });
}

function buildPolicyFromPins(
  providerCurrency: string,
  providerMinorUnitScale: number,
  pins: Map<FixedBetaOperation, Omit<FixedBetaOperationPin, "operation">>,
): Omit<BillingPolicy, "updatedAt" | "updatedBy"> {
  const entries: PriceCatalogEntry[] = FIXED_BETA_OPERATION_CONTRACT.map(
    ({ operation, modality }) => {
      const pin = pins.get(operation);
      if (!pin) fail();
      return {
        operation,
        modality,
        provider: pin.provider,
        model: pin.model,
        providerCostMinor: pin.providerCostMinor,
        enabled: true,
        pricingMode: FIXED_BETA_PRICING_MODE,
        fixedCredits: FIXED_BETA_CREDITS_PER_OPERATION,
      };
    },
  );
  const versionlessPolicy = {
    markupBasisPoints: 10_000,
    initialGrantCredits: FIXED_BETA_ORDINARY_REGISTRATION_GRANT,
    providerCurrency,
    providerMinorUnitScale,
    creditUnitsPerProviderMinor: 1,
    entries,
  };
  const fingerprint = createHash("sha256")
    .update(canonicalPolicyPayload(versionlessPolicy), "utf8")
    .digest("hex");
  return {
    version: `${FIXED_BETA_PRICING_VERSION_PREFIX}${fingerprint}`,
    ...versionlessPolicy,
  };
}

function parsePins(value: unknown): Map<
  FixedBetaOperation,
  Omit<FixedBetaOperationPin, "operation">
> {
  assertPlainDataArray(value);
  if (value.length !== FIXED_BETA_OPERATION_CONTRACT.length) fail();
  const operations = new Set(
    FIXED_BETA_OPERATION_CONTRACT.map(({ operation }) => operation),
  );
  const pins = new Map<
    FixedBetaOperation,
    Omit<FixedBetaOperationPin, "operation">
  >();
  for (const item of value) {
    assertExactDataRecord(item, PIN_KEYS);
    const operation = safeIdentifier(item.operation, 80) as FixedBetaOperation;
    if (!operations.has(operation) || pins.has(operation)) fail();
    const provider = safeIdentifier(item.provider, 80);
    const model = safeModelIdentifier(item.model);
    if (
      provider !== FIXED_BETA_RUNTIME_BINDING_PROVIDER
      || !/^sha256:[a-f0-9]{64}$/.test(model)
    ) fail();
    pins.set(operation, {
      provider,
      model,
      providerCostMinor: safePositiveInteger(item.providerCostMinor),
    });
  }
  if (pins.size !== operations.size) fail();
  return pins;
}

export function buildFixedBetaPricingCandidate(
  value: unknown,
): FixedBetaPricingCandidate {
  assertExactDataRecord(value, INPUT_KEYS);
  const providerCurrency = safeCurrency(value.providerCurrency);
  const providerMinorUnitScale = safeScale(value.providerMinorUnitScale);
  const policy = buildPolicyFromPins(
    providerCurrency,
    providerMinorUnitScale,
    parsePins(value.operationPins),
  );
  const fingerprint = policy.version.slice(
    FIXED_BETA_PRICING_VERSION_PREFIX.length,
  );
  const candidate: FixedBetaPricingCandidate = {
    schema: FIXED_BETA_PRICING_SCHEMA,
    status: "LOCAL_POLICY_CANDIDATE_ONLY",
    pricingAudience: FIXED_BETA_PRICING_AUDIENCE,
    fixedCreditsPerOperation: FIXED_BETA_CREDITS_PER_OPERATION,
    operationCount: 11,
    ordinaryRegistrationGrantCredits:
      FIXED_BETA_ORDINARY_REGISTRATION_GRANT,
    membershipGrantIncluded: false,
    productionWriteAllowed: false,
    providerContacted: false,
    networkCalls: 0,
    writesPerformed: 0,
    fingerprint,
    policy,
  };
  for (const entry of candidate.policy.entries) Object.freeze(entry);
  Object.freeze(candidate.policy.entries);
  Object.freeze(candidate.policy);
  return Object.freeze(candidate);
}

export function isFixedBetaPricingVersion(version: unknown): version is string {
  return typeof version === "string"
    && version.startsWith(FIXED_BETA_PRICING_VERSION_PREFIX)
    && /^[a-f0-9]{64}$/.test(
      version.slice(FIXED_BETA_PRICING_VERSION_PREFIX.length),
    );
}

export function isFixedBetaPricingVersionFamily(
  version: unknown,
): version is string {
  return typeof version === "string"
    && version.startsWith(FIXED_BETA_PRICING_VERSION_PREFIX);
}

export function requiresFixedBetaPricingValidation(value: unknown): boolean {
  assertDataRecord(value);
  if (typeof value.version !== "string") fail();
  assertPlainDataArray(value.entries);
  let hasFixedEntry = false;
  for (const entry of value.entries) {
    assertDataRecord(entry);
    const mode = entry.pricingMode;
    if (mode === FIXED_BETA_PRICING_MODE) {
      hasFixedEntry = true;
    } else if (mode !== undefined && mode !== "provider_cost_v1") {
      fail();
    }
    if (mode !== FIXED_BETA_PRICING_MODE && entry.fixedCredits !== undefined) {
      fail();
    }
  }
  return hasFixedEntry || isFixedBetaPricingVersionFamily(value.version);
}

export function assertFixedBetaPricingPolicy(
  value: unknown,
): asserts value is BillingPolicy {
  if (
    value === null
    || typeof value !== "object"
    || utilTypes.isProxy(value)
  ) fail();
  const rawKeys = Object.keys(value);
  const hasAuditFields = rawKeys.includes("updatedAt") || rawKeys.includes("updatedBy");
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
  if (
    value.markupBasisPoints !== 10_000
    || value.initialGrantCredits !== FIXED_BETA_ORDINARY_REGISTRATION_GRANT
    || value.creditUnitsPerProviderMinor !== 1
  ) fail();
  const providerCurrency = safeCurrency(value.providerCurrency);
  const providerMinorUnitScale = safeScale(value.providerMinorUnitScale);
  assertPlainDataArray(value.entries);
  if (value.entries.length !== FIXED_BETA_OPERATION_CONTRACT.length) fail();
  const pins: FixedBetaOperationPin[] = [];
  const definitionByOperation = new Map(
    FIXED_BETA_OPERATION_CONTRACT.map((definition) => [
      definition.operation,
      definition,
    ]),
  );
  const seen = new Set<string>();
  for (const rawEntry of value.entries) {
    assertExactDataRecord(rawEntry, ENTRY_KEYS);
    const operation = safeIdentifier(rawEntry.operation, 80) as FixedBetaOperation;
    const definition = definitionByOperation.get(operation);
    if (!definition || seen.has(operation)) fail();
    seen.add(operation);
    if (
      rawEntry.modality !== definition.modality
      || rawEntry.enabled !== true
      || rawEntry.pricingMode !== FIXED_BETA_PRICING_MODE
      || rawEntry.fixedCredits !== FIXED_BETA_CREDITS_PER_OPERATION
    ) fail();
    pins.push({
      operation,
      provider: safeIdentifier(rawEntry.provider, 80),
      model: safeModelIdentifier(rawEntry.model),
      providerCostMinor: safePositiveInteger(rawEntry.providerCostMinor),
    });
  }
  if (seen.size !== definitionByOperation.size) fail();
  const rebuilt = buildFixedBetaPricingCandidate({
    providerCurrency,
    providerMinorUnitScale,
    operationPins: pins,
  });
  if (value.version !== rebuilt.policy.version) fail();
}

export function fixedBetaPricingFingerprint(policy: unknown): string {
  assertFixedBetaPricingPolicy(policy);
  return policy.version.slice(FIXED_BETA_PRICING_VERSION_PREFIX.length);
}

export function assertFixedBetaPricingActivation(
  policy: BillingPolicy,
  env: Record<string, string | undefined> = process.env,
): void {
  if (
    env.AISTORY_PLATFORM_BILLING_ENABLED !== "true"
    || env[FIXED_BETA_PRICING_MODE_ENV] !== FIXED_BETA_PRICING_MODE_CONFIG
    || env[FIXED_BETA_PRICING_VERSION_ENV] !== policy.version
  ) {
    throw new FixedBetaPricingActivationError();
  }
}

export function isFixedBetaPricingModeRequested(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const configured = env[FIXED_BETA_PRICING_MODE_ENV];
  if (configured === undefined || configured === "" || configured === "disabled") {
    return false;
  }
  if (configured === FIXED_BETA_PRICING_MODE_CONFIG) return true;
  throw new FixedBetaPricingActivationError();
}
