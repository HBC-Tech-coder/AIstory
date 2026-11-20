/**
 * Pure generation-readiness projection for A4.
 *
 * This module deliberately has no imports and no side effects. The route wires
 * real services into `resolveGenerationReadiness`; tests inject fakes.
 *
 * Readiness is visibility, not authorization. A `ready` projection never
 * grants credits, reserves credits, contacts a provider, or bypasses the
 * generation billing gate. The generation route must still enforce its own
 * authorization and credit checks.
 */

export const GENERATION_READINESS_SCOPE = "story.start" as const;

export type GenerationReadinessScope = typeof GENERATION_READINESS_SCOPE;

/**
 * Fixed reason allowlist. Do not add free-form values: every reason maps to a
 * fixed safe message below and can be rendered by the notice component.
 */
export type GenerationReadinessReason =
  | "billing_disabled"
  | "phone_verification_required"
  | "database_gate_unavailable"
  | "runtime_config_unavailable"
  | "account_inactive"
  | "pricing_unavailable"
  | "service_unavailable"
  | "ready";

/**
 * Public projection allowlist. No identifiers, environment values, raw errors,
 * tokens, runtime model/config details, or full price policy may be added.
 */
export type GenerationReadiness = {
  scope: GenerationReadinessScope;
  available: boolean;
  reason: GenerationReadinessReason;
  estimatedCredits?: number;
  message: string;
};

export type GenerationReadinessIdentity =
  | { kind: "phone"; userId: string }
  | null
  | undefined;

export type GenerationReadinessAccount =
  | { status?: string }
  | null
  | undefined;

export type GenerationReadinessQuote =
  | { estimatedCredits?: unknown }
  | null
  | undefined;

export type GenerationReadinessDependencies<RuntimeConfig = unknown> = {
  /** Must return true only when platform billing is explicitly enabled. */
  isBillingEnabled: () => boolean;
  /** Resolve the server-authorized phone debit account; return null otherwise. */
  authenticate: () => Promise<GenerationReadinessIdentity>;
  /** Production database gate for the billing subsystem. */
  assertDatabaseGateReady: () => void | Promise<void>;
  /** Load runtime model bindings (environment only; no provider request). */
  loadRuntimeConfig: () => RuntimeConfig | Promise<RuntimeConfig>;
  /** Read the account. No write, reserve, or balance mutation. */
  loadUser: (
    userId: string,
  ) => GenerationReadinessAccount | Promise<GenerationReadinessAccount>;
  /** Quote the operation from the active price catalog. No reserve/provider call. */
  quote: (
    runtimeConfig: RuntimeConfig,
  ) => GenerationReadinessQuote | Promise<GenerationReadinessQuote>;
};

const MESSAGES: Record<GenerationReadinessReason, string> = {
  billing_disabled:
    "平台积分生成暂未开启。你的积分仍会保留；已发布的故事仍可继续游玩，也可继续使用自己的 API Key（BYOK）。",
  phone_verification_required:
    "平台积分生成需要手机号登录。请先完成手机号验证码登录；已发布的故事和自己的 API Key（BYOK）仍可正常使用。",
  database_gate_unavailable:
    "平台计费服务暂时不可用，请稍后再试；已发布的故事仍可继续游玩。",
  runtime_config_unavailable:
    "平台生成配置暂时不可用，请稍后再试。",
  account_inactive:
    "当前账户状态暂时无法用于平台积分生成，请稍后再试。",
  pricing_unavailable:
    "平台定价尚未配置，暂时无法使用积分生成；未发起任何模型调用。已发布的故事仍可继续游玩。",
  service_unavailable:
    "平台生成状态暂时无法确认，请稍后再试。",
  ready:
    "开始新故事（story.start）的平台积分生成服务已就绪；其他操作会分别校验，实际生成仍会单独校验计费授权与积分。",
};

const REASONS: readonly GenerationReadinessReason[] = [
  "billing_disabled",
  "phone_verification_required",
  "database_gate_unavailable",
  "runtime_config_unavailable",
  "account_inactive",
  "pricing_unavailable",
  "service_unavailable",
  "ready",
];

/**
 * Exact-match platform billing switch. Only the literal string "true" enables
 * billing; "TRUE", "1", whitespace, undefined, and booleans are all disabled.
 * Pure so the route and tests share one rule.
 */
export function isPlatformBillingEnabledValue(value: unknown): boolean {
  return value === "true";
}

export function isGenerationReadinessReason(
  value: unknown,
): value is GenerationReadinessReason {
  return typeof value === "string"
    && (REASONS as readonly string[]).includes(value);
}

export function generationReadinessMessage(
  reason: GenerationReadinessReason,
): string {
  const message = MESSAGES[reason];
  return typeof message === "string" ? message : MESSAGES.service_unavailable;
}

export function normalizeEstimatedCredits(value: unknown): number | undefined {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    ? value
    : undefined;
}

export function unavailableGenerationReadiness(
  reason: Exclude<GenerationReadinessReason, "ready">,
): GenerationReadiness {
  return {
    scope: GENERATION_READINESS_SCOPE,
    available: false,
    reason,
    message: generationReadinessMessage(reason),
  };
}

export function readyGenerationReadiness(
  estimatedCredits: number,
): GenerationReadiness {
  const safeCredits = normalizeEstimatedCredits(estimatedCredits);
  if (safeCredits === undefined) {
    return unavailableGenerationReadiness("service_unavailable");
  }
  return {
    scope: GENERATION_READINESS_SCOPE,
    available: true,
    reason: "ready",
    estimatedCredits: safeCredits,
    message: generationReadinessMessage("ready"),
  };
}

/**
 * Rebuild the response from the fixed allowlist. Defensive: even if a caller
 * accidentally spreads extra data into a projection, only `scope`,
 * `available`, `reason`, optional `estimatedCredits`, and `message` cross the
 * route boundary.
 */
export function toPublicGenerationReadiness(value: unknown): GenerationReadiness {
  if (!value || typeof value !== "object") {
    return unavailableGenerationReadiness("service_unavailable");
  }

  const record = value as Partial<GenerationReadiness>;
  const reason = isGenerationReadinessReason(record.reason)
    ? record.reason
    : "service_unavailable";

  if (reason === "ready") {
    // `available` and `reason` must agree, or the projection is untrustworthy.
    if (record.available !== true) {
      return unavailableGenerationReadiness("service_unavailable");
    }
    const estimatedCredits = normalizeEstimatedCredits(record.estimatedCredits);
    return estimatedCredits === undefined
      ? unavailableGenerationReadiness("service_unavailable")
      : readyGenerationReadiness(estimatedCredits);
  }

  return unavailableGenerationReadiness(reason);
}

/**
 * Resolve a safe readiness projection from injectable dependencies.
 *
 * Order matters:
 * 1. Billing switch first. When disabled, no auth/database/config/price call.
 * 2. Phone identity only (no AIUser fallback).
 * 3. Production database gate for billing.
 * 4. Runtime model bindings (environment only).
 * 5. Active account read (no ledger write and no balance-sufficiency check).
 * 6. Read-only price quote for `story.start` (no reserve/provider call).
 *
 * `available` means the service is ready; it does not mean the caller has
 * enough credits. Zero or low balances still produce `ready`.
 */
export async function resolveGenerationReadiness<RuntimeConfig>(
  deps: GenerationReadinessDependencies<RuntimeConfig>,
): Promise<GenerationReadiness> {
  let billingEnabled: boolean;
  try {
    billingEnabled = deps.isBillingEnabled() === true;
  } catch {
    return unavailableGenerationReadiness("service_unavailable");
  }

  // First and cheapest check. Never touch auth, database, engine config, or
  // the price catalog while platform billing is disabled.
  if (!billingEnabled) {
    return unavailableGenerationReadiness("billing_disabled");
  }

  let identity: GenerationReadinessIdentity;
  try {
    identity = await deps.authenticate();
  } catch {
    return unavailableGenerationReadiness("service_unavailable");
  }

  // Platform credits debit a verified phone account. A linked AIUser session
  // reaches this point only after the route resolves its explicit mapping.
  if (
    !identity
    || identity.kind !== "phone"
    || typeof identity.userId !== "string"
    || identity.userId.length === 0
    || identity.userId === "anonymous"
  ) {
    return unavailableGenerationReadiness("phone_verification_required");
  }

  try {
    await deps.assertDatabaseGateReady();
  } catch {
    return unavailableGenerationReadiness("database_gate_unavailable");
  }

  let runtimeConfig: RuntimeConfig;
  try {
    runtimeConfig = await deps.loadRuntimeConfig();
  } catch {
    return unavailableGenerationReadiness("runtime_config_unavailable");
  }

  try {
    const user = await deps.loadUser(identity.userId);
    if (!user || user.status !== "active") {
      return unavailableGenerationReadiness("account_inactive");
    }
  } catch {
    return unavailableGenerationReadiness("service_unavailable");
  }

  let quote: GenerationReadinessQuote;
  try {
    quote = await deps.quote(runtimeConfig);
  } catch {
    // PricingUnavailableError and fixed-beta binding mismatches are all a
    // safe "pricing unavailable" projection. Raw errors are never exposed.
    return unavailableGenerationReadiness("pricing_unavailable");
  }

  const estimatedCredits = normalizeEstimatedCredits(quote?.estimatedCredits);
  // A malformed quote must not leak raw values or imply availability.
  if (estimatedCredits === undefined) {
    return unavailableGenerationReadiness("service_unavailable");
  }

  return readyGenerationReadiness(estimatedCredits);
}
