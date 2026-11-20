import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

import {
  canonicalPlatformCostEnvelopeSpec,
  installPlatformCostEnvelopeReader,
  PLATFORM_COST_ENVELOPE_SPEC,
  PlatformCostEnvelopeError,
  PLATFORM_COST_OPERATIONS,
  PLATFORM_COST_ROLE_ATTEMPT_CAPS,
  type PlatformBoundRole,
  type PlatformCostEnvelopeErrorCode,
  type PlatformCostEnvelopeScope,
  type PlatformCostRole,
  type PlatformOperation,
} from "./platformCostEnvelope";

// ── Canonical deployment allowlist ─────────────────────────────────────
// Root confirmed these non-secret local deployment bindings. No other
// provider/model/baseUrl is accepted inside a platform cost envelope.
// Exact string equality only — no URL normalization or model widening.

export const PLATFORM_CANONICAL_PROVIDER_BINDINGS = Object.freeze({
  text: Object.freeze({
    provider: "openai_compatible",
    model: "qwen-plus",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  }),
  image: Object.freeze({
    provider: "dashscope",
    model: "qwen-image-2.0-pro",
    baseUrl: "https://dashscope.aliyuncs.com/api/v1",
  }),
  vision: Object.freeze({
    provider: "openai_compatible",
    model: "qwen-vl-plus",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  }),
  tts: Object.freeze({
    provider: "bailian",
    model: "qwen3-tts-flash",
    baseUrl: "https://dashscope.aliyuncs.com/api/v1",
  }),
});

/**
 * Exact authorized live local-deployment hostname (non-secret, read by root).
 * Only the two exact suffixes below are accepted — no wildcard host matching.
 */
export const PLATFORM_LIVE_ENDPOINT_ORIGIN =
  "https://llm-ffwzh4xipfkithby.cn-beijing.maas.aliyuncs.com" as const;

export const PLATFORM_LIVE_PROVIDER_BINDINGS = Object.freeze({
  text: Object.freeze({
    provider: "openai_compatible",
    model: "qwen-plus",
    baseUrl: `${PLATFORM_LIVE_ENDPOINT_ORIGIN}/compatible-mode/v1`,
  }),
  image: Object.freeze({
    provider: "dashscope",
    model: "qwen-image-2.0-pro",
    baseUrl: `${PLATFORM_LIVE_ENDPOINT_ORIGIN}/api/v1`,
  }),
  vision: Object.freeze({
    provider: "openai_compatible",
    model: "qwen-vl-plus",
    baseUrl: `${PLATFORM_LIVE_ENDPOINT_ORIGIN}/compatible-mode/v1`,
  }),
  tts: Object.freeze({
    provider: "bailian",
    model: "qwen3-tts-flash",
    baseUrl: `${PLATFORM_LIVE_ENDPOINT_ORIGIN}/api/v1`,
  }),
});

export type PlatformRuntimeProviderConfig = {
  baseUrl: string;
  apiKey?: string;
  model: string;
  provider?: string;
};

export type PlatformRuntimeTtsConfig = {
  baseUrl: string;
  apiKey?: string;
  speechModel: string;
  provider?: string;
  voice?: string;
};

export type PlatformRuntimeConfig = {
  text: PlatformRuntimeProviderConfig;
  image: PlatformRuntimeProviderConfig;
  vision: PlatformRuntimeProviderConfig;
  tts?: PlatformRuntimeTtsConfig;
};

const envelopeStorage =
  new AsyncLocalStorage<PlatformCostEnvelopeScope>();

// Browser-safe module receives only a reader; budgets themselves live in ALS
// per request, never in a process-global counter.
installPlatformCostEnvelopeReader(() => envelopeStorage.getStore());

function fail(
  code: PlatformCostEnvelopeErrorCode,
  message: string,
): never {
  throw new PlatformCostEnvelopeError(code, message);
}

export function isPlatformOperation(value: unknown): value is PlatformOperation {
  return typeof value === "string"
    && (PLATFORM_COST_OPERATIONS as readonly string[]).includes(value);
}

/** Hash of the immutable envelope shape, pinned by every pricing candidate. */
export function platformCostEnvelopeFingerprint(
  spec: unknown = PLATFORM_COST_ENVELOPE_SPEC,
): string {
  return `sha256:${createHash("sha256")
    .update(canonicalPlatformCostEnvelopeSpec(spec), "utf8")
    .digest("hex")}`;
}

export const PLATFORM_COST_ENVELOPE_FINGERPRINT =
  platformCostEnvelopeFingerprint();

function assertConfigRecord(
  value: unknown,
  field: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(
      "PLATFORM_COST_ENVELOPE_CONFIG_INVALID",
      `${field} is not a config object.`,
    );
  }
}

function assertExactBinding(
  role: PlatformCostRole,
  config: unknown,
): asserts config is Record<string, unknown> {
  assertConfigRecord(config, `${role} config`);
  const expected = PLATFORM_CANONICAL_PROVIDER_BINDINGS[role];
  const live = PLATFORM_LIVE_PROVIDER_BINDINGS[role];
  const actualModel = role === "tts" ? config.speechModel : config.model;
  const authorizedBaseUrls = new Set<string>([
    expected.baseUrl,
    live.baseUrl,
  ]);
  if (
    config.provider !== expected.provider
    || !authorizedBaseUrls.has(config.baseUrl as string)
    || actualModel !== expected.model
  ) {
    fail(
      "PLATFORM_COST_ENVELOPE_CONFIG_INVALID",
      `${role} config does not match an authorized Beijing platform binding.`,
    );
  }
}

/**
 * Validate the full runtime config object against the canonical allowlist.
 * Exported so the root lane can check before it reserves credits / wraps work.
 */
export function assertPlatformRuntimeConfig(
  config: unknown,
): asserts config is PlatformRuntimeConfig {
  assertConfigRecord(config, "runtime config");
  assertExactBinding("text", config.text);
  assertExactBinding("image", config.image);
  assertExactBinding("vision", config.vision);
  if (config.tts !== undefined) assertExactBinding("tts", config.tts);

  const usedConfigs: unknown[] = [config.text, config.image, config.vision];
  if (config.tts !== undefined) usedConfigs.push(config.tts);
  if (new Set(usedConfigs).size !== usedConfigs.length) {
    fail(
      "PLATFORM_COST_ENVELOPE_CONFIG_INVALID",
      "One config object is bound to multiple roles; role identity is ambiguous.",
    );
  }
}

function roleConfig(
  config: PlatformRuntimeConfig,
  role: PlatformCostRole,
): PlatformRuntimeProviderConfig | PlatformRuntimeTtsConfig | undefined {
  if (role === "tts") return config.tts;
  return config[role];
}

function buildScope(
  config: PlatformRuntimeConfig,
  operation: PlatformOperation,
): PlatformCostEnvelopeScope {
  const caps = PLATFORM_COST_ROLE_ATTEMPT_CAPS[operation];
  if (!caps) {
    fail(
      "PLATFORM_COST_ENVELOPE_UNKNOWN_OPERATION",
      `Unknown platform operation: ${String(operation)}`,
    );
  }

  const roles: Partial<Record<PlatformCostRole, PlatformBoundRole>> = {};
  for (const role of Object.keys(caps) as PlatformCostRole[]) {
    const maxAttempts = caps[role];
    if (maxAttempts === undefined) continue;
    const roleRuntimeConfig = roleConfig(config, role);
    if (!roleRuntimeConfig) {
      if (role === "tts" && maxAttempts === 0) continue;
      fail(
        "PLATFORM_COST_ENVELOPE_CONFIG_INVALID",
        `${role} config is required for platform operation ${operation}.`,
      );
    }
    const expected = PLATFORM_CANONICAL_PROVIDER_BINDINGS[role];
    roles[role] = {
      role,
      config: roleRuntimeConfig,
      provider: expected.provider,
      baseUrl: roleRuntimeConfig.baseUrl,
      model: expected.model,
      maxAttempts,
      used: 0,
    };
  }

  // The scope itself is intentionally NOT frozen: sticky violations are
  // attached to it after this point. Roles are frozen, attempt counters inside
  // them remain mutable, and no live role object is exported.
  return {
    operation,
    envelopeHash: PLATFORM_COST_ENVELOPE_FINGERPRINT,
    roles: Object.freeze(roles),
  };
}

/**
 * The mandatory platform wrapper. Root MUST wrap every platform-managed
 * operation in this callback so budgets exist for the whole async operation,
 * including parallel awaited calls and stream callbacks.
 *
 * Nested calls are rejected: there is no way to re-bind or reset a budget.
 */
export async function runInCostEnvelope<T>(
  config: PlatformRuntimeConfig,
  operation: PlatformOperation,
  fn: () => T | Promise<T>,
): Promise<T> {
  if (typeof fn !== "function") {
    fail(
      "PLATFORM_COST_ENVELOPE_CONFIG_INVALID",
      "runInCostEnvelope requires a callback.",
    );
  }
  if (envelopeStorage.getStore()) {
    fail(
      "PLATFORM_COST_ENVELOPE_NESTED_SCOPE",
      "runInCostEnvelope cannot be nested or re-bound.",
    );
  }
  if (!isPlatformOperation(operation)) {
    fail(
      "PLATFORM_COST_ENVELOPE_UNKNOWN_OPERATION",
      `Unknown platform operation: ${String(operation)}`,
    );
  }
  assertPlatformRuntimeConfig(config);
  const scope = buildScope(config, operation);
  return envelopeStorage.run(scope, async () => {
    let result: T | undefined;
    let thrown: unknown;
    let failed = false;
    try {
      result = await fn();
    } catch (error) {
      failed = true;
      thrown = error;
    }
    // Sticky postcheck: even if the engine swallowed a budget/config guard
    // error and produced a fallback, the operation cannot be delivered or
    // billed. The first violation is re-thrown.
    if (scope.violation) {
      throw new PlatformCostEnvelopeError(
        scope.violation.code,
        scope.violation.message,
      );
    }
    if (failed) throw thrown;
    return result as T;
  });
}

/**
 * Root guard for a single platform operation: verifies an envelope is active
 * for the expected operation. Call it before issuing cross-cutting work that
 * is not itself an adapter call.
 */
export function assertPlatformOperationEnvelope(
  operation: PlatformOperation,
): PlatformCostEnvelopeScope {
  const scope = envelopeStorage.getStore();
  if (!scope) {
    fail(
      "PLATFORM_COST_ENVELOPE_NOT_INSTALLED",
      `No platform cost envelope is active for ${operation}.`,
    );
  }
  if (scope.operation !== operation) {
    fail(
      "PLATFORM_COST_ENVELOPE_ROLE_MISMATCH",
      `Active platform cost envelope is ${scope.operation}, not ${operation}.`,
    );
  }
  return scope;
}

// Delivery-gate helpers are re-exported for root/billing callers that should
// only import the server module.
export {
  assertCostEnvelopeDeliverable,
  assertPlatformCostEnvelopeDeliverable,
  platformCostEnvelopeSnapshot,
  platformCostEnvelopeViolation,
} from "./platformCostEnvelope";

