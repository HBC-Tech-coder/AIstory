import "server-only";

import { types as nodeTypes } from "node:util";

/** Server-only failure telemetry. Emits only a fixed event plus an allowlisted
 * stage/category/code; never message, stack, file path or arbitrary text.
 * Hostile getters/proxies are never invoked and logging never throws. */
export const SCENE_FAILURE_EVENT = "scene_generation_failure" as const;

export const SCENE_FAILURE_STAGES = [
  "engine_generation",
  "core_validation",
  "cost_envelope",
] as const;

export type SceneFailureStage = (typeof SCENE_FAILURE_STAGES)[number];
export type SceneFailureCategory = "abort" | "billing" | "delivery" | "engine" | "envelope" | "pricing" | "unknown";

type SceneFailureLogEntry = Readonly<{ event: typeof SCENE_FAILURE_EVENT; stage: SceneFailureStage; category: SceneFailureCategory; code?: string }>;

const CATEGORY_BY_NAME: Readonly<Record<string, SceneFailureCategory>> =
  Object.freeze({
    Error: "engine", TypeError: "engine", RangeError: "engine",
    SyntaxError: "engine", AggregateError: "engine", AbortError: "abort",
    CostBetaGenerationDeliveryError: "delivery",
    PlatformCostEnvelopeError: "envelope",
    PricingUnavailableError: "billing", InsufficientCreditsError: "billing",
    BillingReconciliationError: "billing", CreditCardServerError: "billing",
    CostBetaPricingContractError: "pricing",
    CostBetaPricingActivationError: "pricing",
    FixedBetaPricingContractError: "pricing",
    FixedBetaPricingActivationError: "pricing",
    FixedBetaProviderCostCatalogError: "pricing",
  });

const ALLOWED_CODES: ReadonlySet<string> = new Set([
  "COST_BETA_GENERATION_NOT_DELIVERED",
  "PLATFORM_COST_ENVELOPE_NOT_INSTALLED",
  "PLATFORM_COST_ENVELOPE_UNKNOWN_OPERATION",
  "PLATFORM_COST_ENVELOPE_CONFIG_INVALID",
  "PLATFORM_COST_ENVELOPE_UNBOUND_CONFIG",
  "PLATFORM_COST_ENVELOPE_ROLE_MISMATCH",
  "PLATFORM_COST_ENVELOPE_CONFIG_MUTATED",
  "PLATFORM_COST_ENVELOPE_EXHAUSTED",
  "PLATFORM_COST_ENVELOPE_REQUEST_TOO_LARGE",
  "PLATFORM_COST_ENVELOPE_VOICE_MISMATCH",
  "PLATFORM_COST_ENVELOPE_NESTED_SCOPE",
  "PLATFORM_PRICING_UNAVAILABLE", "INSUFFICIENT_CREDITS",
  "BILLING_RECONCILIATION_INVALID",
  "COST_BETA_PRICING_CONTRACT_INVALID", "COST_BETA_PRICING_NOT_ENABLED",
  "FIXED_BETA_PRICING_CONTRACT_INVALID", "FIXED_BETA_PRICING_NOT_ENABLED",
  "FIXED_BETA_PROVIDER_COST_CATALOG_INVALID", "CREDIT_CARD_UNAVAILABLE",
]);

function isStage(value: unknown): value is SceneFailureStage {
  return typeof value === "string"
    && (SCENE_FAILURE_STAGES as readonly string[]).includes(value);
}

/** Own DATA property only: accessor descriptors are ignored, never invoked. */
function ownDataString(error: object, key: string): string | undefined {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, key);
    return descriptor !== undefined && "value" in descriptor
      && typeof descriptor.value === "string"
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function buildEntry(stage: unknown, error: unknown): SceneFailureLogEntry | null {
  try {
    if (!isStage(stage)) return null;
    if (nodeTypes.isProxy(error) || !nodeTypes.isNativeError(error)) {
      return Object.freeze({ event: SCENE_FAILURE_EVENT, stage, category: "unknown" as const });
    }
    const name = ownDataString(error, "name");
    // Own keys only: inherited names ("__proto__", "constructor", "toString",
    // ...) must never resolve through the fixed allowlist's prototype chain.
    const category = name !== undefined && Object.hasOwn(CATEGORY_BY_NAME, name)
      ? CATEGORY_BY_NAME[name] ?? "unknown"
      : "unknown";
    const rawCode = ownDataString(error, "code");
    const code = rawCode !== undefined && ALLOWED_CODES.has(rawCode) ? rawCode : undefined;
    return Object.freeze({ event: SCENE_FAILURE_EVENT, stage, category, ...(code === undefined ? {} : { code }) });
  } catch {
    return null;
  }
}

export function logSceneGenerationFailure(stage: unknown, error: unknown): void {
  try {
    const entry = buildEntry(stage, error);
    if (entry !== null) console.error(entry);
  } catch {
    // Diagnostics must never change the generation outcome.
  }
}
