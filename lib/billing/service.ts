import "server-only";
import { isPlatformOperation } from "@/lib/billing/platformCostEnvelopeServer";

import { createHash, randomUUID } from "node:crypto";
import { types as utilTypes } from "node:util";

import type { AdminRepository } from "@/lib/admin/repositories";
import type {
  BillingPolicy,
  PriceCatalogEntry,
  ServerCreditLedgerEntry,
} from "@/lib/admin/types";
import {
  assertFixedBetaPricingPolicy,
  assertFixedBetaPricingActivation,
  fixedBetaRuntimeBindingForOperation,
  FixedBetaPricingActivationError,
  FixedBetaPricingContractError,
  isFixedBetaPricingModeRequested,
  requiresFixedBetaPricingValidation,
  type FixedBetaOperation,
  type FixedBetaRuntimeConfig,
} from "@/lib/billing/fixedBetaPricing";
import {
  assertCostBetaPricingActivation,
  assertCostBetaPricingPolicy,
  COST_BETA_PRICING_MODE,
  costBetaRuntimeBindingForOperation,
  isCostBetaPricingModeRequested,
} from "@/lib/billing/costBetaPricing";
import {
  inspectCapturedCostBetaReservation,
  inspectCostBetaPolicyCandidate,
  isSameBillingTerminalIntent,
  PROVIDER_COST_UNKNOWN_PLATFORM_ABSORBED_REASON,
} from "@/lib/billing/reconciliation";

const TENANT_ID = "platform";

export type PublicGenerationQuote = {
  operation: string;
  modalities: Array<"text" | "image" | "vision" | "tts" | "video" | "mixed">;
  estimatedCredits: number;
  pricePolicyVersion: string;
  costSource: "price_catalog";
  responsibility: "platform_credits";
};

export type CreditReservation = {
  entry: ServerCreditLedgerEntry;
  quote: PublicGenerationQuote;
  policy: BillingPolicy;
  catalogEntry: PriceCatalogEntry;
  replayed: boolean;
};

export type ProviderSettlementReceipt = {
  providerCostMinor: number;
  providerCurrency: string;
  providerMinorUnitScale: number;
};

const PLATFORM_BILLING_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9:_-]{8,152}$/;

export function isValidPlatformBillingIdempotencyKey(value: unknown): value is string {
  return typeof value === "string"
    && PLATFORM_BILLING_IDEMPOTENCY_KEY_PATTERN.test(value);
}

export class PricingUnavailableError extends Error {
  readonly code = "PLATFORM_PRICING_UNAVAILABLE";
  readonly status = 503;

  constructor(message = "平台定价尚未配置，未发起任何模型调用。") {
    super(message);
    this.name = "PricingUnavailableError";
  }
}

export class InsufficientCreditsError extends Error {
  readonly code = "INSUFFICIENT_CREDITS";
  readonly status = 402;
  readonly quote: PublicGenerationQuote;

  constructor(quote: PublicGenerationQuote) {
    super(`积分不足：本次预计需要 ${quote.estimatedCredits.toLocaleString("zh-CN")} 积分。`);
    this.name = "InsufficientCreditsError";
    this.quote = quote;
  }
}

function assertSafeNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PricingUnavailableError(`${field} 配置无效，未发起任何模型调用。`);
  }
}

export function creditsForProviderCost(
  providerCostMinor: number,
  policy: Pick<
    BillingPolicy,
    "markupBasisPoints" | "creditUnitsPerProviderMinor"
  >,
): number {
  assertSafeNonNegativeInteger(providerCostMinor, "供应商成本");
  assertSafeNonNegativeInteger(policy.markupBasisPoints, "定价倍数");
  assertSafeNonNegativeInteger(
    policy.creditUnitsPerProviderMinor,
    "积分换算单位",
  );
  if (providerCostMinor === 0) return 0;
  const numerator =
    providerCostMinor
    * policy.markupBasisPoints
    * policy.creditUnitsPerProviderMinor;
  if (!Number.isSafeInteger(numerator)) {
    throw new PricingUnavailableError("成本换算超出安全整数范围。");
  }
  return Math.max(1, Math.ceil(numerator / 10_000));
}

export type CatalogPricingMode =
  | "provider_cost_v1"
  | "fixed_beta_credit_v1"
  | "cost_beta_credit_v2";

export function pricingModeForCatalogEntry(
  entry: PriceCatalogEntry,
): CatalogPricingMode {
  const mode = entry.pricingMode ?? "provider_cost_v1";
  if (
    mode !== "provider_cost_v1"
    && mode !== "fixed_beta_credit_v1"
    && mode !== COST_BETA_PRICING_MODE
  ) {
    throw new PricingUnavailableError("价目模式无效，未发起任何模型调用。");
  }
  return mode;
}

export function creditsForCatalogEntry(
  entry: PriceCatalogEntry,
  policy: Pick<
    BillingPolicy,
    "markupBasisPoints" | "creditUnitsPerProviderMinor"
  >,
): number {
  const mode = pricingModeForCatalogEntry(entry);
  assertSafeNonNegativeInteger(entry.providerCostMinor, "供应商成本");
  if (mode === "fixed_beta_credit_v1" || mode === COST_BETA_PRICING_MODE) {
    if (!Number.isSafeInteger(entry.fixedCredits) || (entry.fixedCredits ?? 0) <= 0) {
      throw new PricingUnavailableError("固定积分配置无效，未发起任何模型调用。");
    }
    return entry.fixedCredits as number;
  }
  if (entry.fixedCredits !== undefined) {
    throw new PricingUnavailableError("价目模式字段冲突，未发起任何模型调用。");
  }
  return creditsForProviderCost(entry.providerCostMinor, policy);
}

function assertFixedPolicyIfPresent(
  policy: BillingPolicy,
  requireCurrentActivation: boolean,
): boolean {
  let fixedModeRequested = false;
  if (requireCurrentActivation) {
    try {
      fixedModeRequested = isFixedBetaPricingModeRequested();
    } catch (error) {
      if (!(error instanceof FixedBetaPricingActivationError)) throw error;
      throw new PricingUnavailableError(
        "版本化定价模式配置无效，未发起任何模型调用。",
      );
    }
  }
  let requiresValidation = false;
  try {
    requiresValidation = requiresFixedBetaPricingValidation(policy);
  } catch (error) {
    if (!(error instanceof FixedBetaPricingContractError)) throw error;
    throw new PricingUnavailableError(
      "版本化定价合同校验失败，未发起任何模型调用。",
    );
  }
  if (!requiresValidation) {
    if (fixedModeRequested) {
      throw new PricingUnavailableError(
        "固定测试定价配置与当前策略不一致，未发起任何模型调用。",
      );
    }
    return false;
  }
  try {
    assertFixedBetaPricingPolicy(policy);
    if (requireCurrentActivation) assertFixedBetaPricingActivation(policy);
  } catch (error) {
    if (
      error instanceof FixedBetaPricingContractError
      || error instanceof FixedBetaPricingActivationError
    ) {
      throw new PricingUnavailableError(
        "固定测试定价合同校验失败，未发起任何模型调用。",
      );
    }
    throw error;
  }
  return true;
}

export function normalizeProviderSettlementReceipt(
  value: ProviderSettlementReceipt | undefined,
): ProviderSettlementReceipt | undefined {
  if (value === undefined) return undefined;
  try {
    if (
      value === null
      || typeof value !== "object"
      || Array.isArray(value)
      || utilTypes.isProxy(value)
      || Object.getPrototypeOf(value) !== Object.prototype
      || Object.getOwnPropertySymbols(value).length !== 0
    ) throw new PricingUnavailableError("供应商结算回执格式无效。");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const expectedKeys = [
      "providerCostMinor",
      "providerCurrency",
      "providerMinorUnitScale",
    ];
    const keys = Object.keys(descriptors).sort();
    if (
      keys.length !== expectedKeys.length
      || keys.some((key, index) => key !== expectedKeys[index])
      || Object.values(descriptors).some(
        (descriptor) => !("value" in descriptor) || !descriptor.enumerable,
      )
    ) throw new PricingUnavailableError("供应商结算回执格式无效。");
    return {
      providerCostMinor: value.providerCostMinor,
      providerCurrency: value.providerCurrency,
      providerMinorUnitScale: value.providerMinorUnitScale,
    };
  } catch (error) {
    if (error instanceof PricingUnavailableError) throw error;
    throw new PricingUnavailableError("供应商结算回执格式无效。");
  }
}

function costBetaModeRequested(): boolean {
  try {
    return isCostBetaPricingModeRequested(process.env);
  } catch {
    // A malformed selector is treated as "not requested" here; a v2 policy
    // then fails closed below, while legacy policies keep their own selector
    // validation unchanged.
    return false;
  }
}

function translateCostBetaContract<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (error instanceof PricingUnavailableError) throw error;
    throw new PricingUnavailableError(
      "成本 β 定价合同校验失败，未发起任何模型调用。",
    );
  }
}

function quoteCostBetaOperation(
  policy: BillingPolicy,
  operation: string,
  runtimeConfig: FixedBetaRuntimeConfig | undefined,
): {
  publicQuote: PublicGenerationQuote;
  policy: BillingPolicy;
  catalogEntry: PriceCatalogEntry;
} {
  // A version prefix is never approval on its own: the whole v2 policy is
  // asserted again before activation/quote, and malformed content fails closed.
  translateCostBetaContract(() => assertCostBetaPricingPolicy(policy));
  translateCostBetaContract(() =>
    assertCostBetaPricingActivation(policy, process.env)
  );
  const entry = policy.entries.find(
    (candidate) => candidate.enabled && candidate.operation === operation,
  );
  if (!entry) {
    throw new PricingUnavailableError(`操作 ${operation} 尚无启用的版本化价目。`);
  }
  if (pricingModeForCatalogEntry(entry) !== COST_BETA_PRICING_MODE) {
    throw new PricingUnavailableError(
      "成本 β 价目模式无效，未发起任何模型调用。",
    );
  }
  if (!runtimeConfig) {
    throw new PricingUnavailableError(
      "缺少平台运行时模型绑定，未发起任何模型调用。",
    );
  }
  if (!isPlatformOperation(operation)) {
    throw new PricingUnavailableError("成本 β 操作不受支持，未发起任何模型调用。");
  }
  const binding = translateCostBetaContract(() =>
    costBetaRuntimeBindingForOperation(operation, runtimeConfig)
  );
  if (
    binding.provider !== entry.provider
    || binding.model !== entry.model
  ) {
    throw new PricingUnavailableError(
      "平台运行时模型绑定与成本 β 定价策略不一致，未发起任何模型调用。",
    );
  }
  const estimatedCredits = creditsForCatalogEntry(entry, policy);
  return {
    publicQuote: {
      operation,
      modalities: [entry.modality || "mixed"],
      estimatedCredits,
      pricePolicyVersion: policy.version,
      costSource: "price_catalog",
      responsibility: "platform_credits",
    },
    policy,
    catalogEntry: entry,
  };
}

export async function quotePlatformOperation(
  repository: AdminRepository,
  operation: string,
  runtimeConfig?: FixedBetaRuntimeConfig,
): Promise<{
  publicQuote: PublicGenerationQuote;
  policy: BillingPolicy;
  catalogEntry: PriceCatalogEntry;
}> {
  const policy = await repository.getBillingPolicy();
  const costBetaRequested = costBetaModeRequested();
  const inspection = inspectCostBetaPolicyCandidate(policy);
  if (inspection.mode === "cost_beta_credit_v2") {
    // Recognized v2 dispatches before the legacy fixed-mode selector so that a
    // v2 selector is never misread as an unknown fixed-beta mode.
    if (!costBetaRequested) {
      throw new PricingUnavailableError(
        "成本 β 定价模式未启用，未发起任何模型调用。",
      );
    }
    return quoteCostBetaOperation(inspection.policy, operation, runtimeConfig);
  }
  if (inspection.mode === "invalid") {
    throw new PricingUnavailableError(
      "成本 β 定价合同校验失败，未发起任何模型调用。",
    );
  }
  if (inspection.mode === "unreadable") {
    throw new PricingUnavailableError(
      "定价策略格式无效，未发起任何模型调用。",
    );
  }
  if (costBetaRequested) {
    throw new PricingUnavailableError(
      "成本 β 定价模式与当前策略不一致，未发起任何模型调用。",
    );
  }
  assertFixedPolicyIfPresent(policy, true);
  if (!policy.version || policy.version === "unconfigured") {
    throw new PricingUnavailableError();
  }
  const entry = policy.entries.find(
    (candidate) => candidate.enabled && candidate.operation === operation,
  );
  if (!entry) {
    throw new PricingUnavailableError(`操作 ${operation} 尚无启用的版本化价目。`);
  }
  if (pricingModeForCatalogEntry(entry) === "fixed_beta_credit_v1") {
    try {
      if (!runtimeConfig) throw new FixedBetaPricingContractError();
      const binding = fixedBetaRuntimeBindingForOperation(
        operation as FixedBetaOperation,
        runtimeConfig,
      );
      if (
        binding.provider !== entry.provider
        || binding.model !== entry.model
      ) throw new FixedBetaPricingContractError();
    } catch (error) {
      if (!(error instanceof FixedBetaPricingContractError)) throw error;
      throw new PricingUnavailableError(
        "平台运行时模型绑定与固定定价策略不一致，未发起任何模型调用。",
      );
    }
  }
  const estimatedCredits = creditsForCatalogEntry(entry, policy);
  return {
    publicQuote: {
      operation,
      modalities: [entry.modality || "mixed"],
      estimatedCredits,
      pricePolicyVersion: policy.version,
      costSource: "price_catalog",
      responsibility: "platform_credits",
    },
    policy,
    catalogEntry: entry,
  };
}

function balance(entries: ServerCreditLedgerEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.amount, 0);
}

function deterministicBillingOperationId(input: {
  userId: string;
  operation: string;
  idempotencyKey: string;
}): string {
  const bytes = createHash("sha256")
    .update("aistory.billing-operation.v1\0", "utf8")
    .update(input.userId, "utf8")
    .update("\0", "utf8")
    .update(input.operation, "utf8")
    .update("\0", "utf8")
    .update(input.idempotencyKey, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

function assertReservationSnapshot(
  actual: ServerCreditLedgerEntry,
  expected: ServerCreditLedgerEntry,
): void {
  const fields = [
    "accountId",
    "tenantId",
    "userId",
    "kind",
    "amount",
    "reason",
    "idempotencyKey",
    "billingOperationId",
    "modality",
    "provider",
    "model",
    "pricePolicyVersion",
    "costSource",
    "providerCurrency",
    "providerCostMinor",
    "providerMinorUnitScale",
    "reservedCredits",
  ] as const satisfies ReadonlyArray<keyof ServerCreditLedgerEntry>;
  if (fields.some((field) => actual[field] !== expected[field])) {
    throw new PricingUnavailableError(
      "计费幂等预留与原始快照不一致，未发起任何模型调用。",
    );
  }
}

function assertReservationForTerminal(
  reservation: CreditReservation,
): boolean {
  // The captured v2 snapshot is validated by content only. Terminals must keep
  // working after the live activation kill switch is turned off.
  const costBetaInspection = inspectCapturedCostBetaReservation(reservation);
  if (costBetaInspection.mode === "invalid") {
    throw new PricingUnavailableError(costBetaInspection.message);
  }
  if (costBetaInspection.mode === "legacy") {
    assertFixedPolicyIfPresent(reservation.policy, false);
  }
  const costBeta = costBetaInspection.mode === "cost_beta_credit_v2";
  const policyEntry = reservation.policy.entries.find(
    (entry) => entry.operation === reservation.quote.operation,
  );
  const catalogFields = [
    "operation",
    "modality",
    "provider",
    "model",
    "providerCostMinor",
    "enabled",
    "pricingMode",
    "fixedCredits",
  ] as const satisfies ReadonlyArray<keyof PriceCatalogEntry>;
  if (
    !policyEntry
    || catalogFields.some(
      (field) => policyEntry[field] !== reservation.catalogEntry[field],
    )
    || reservation.entry.kind !== "reserve"
    || reservation.entry.amount !== -reservation.quote.estimatedCredits
    || reservation.entry.reservedCredits !== reservation.quote.estimatedCredits
    || reservation.entry.pricePolicyVersion !== reservation.policy.version
    || reservation.quote.pricePolicyVersion !== reservation.policy.version
    || reservation.entry.modality !== reservation.catalogEntry.modality
    || reservation.entry.provider !== reservation.catalogEntry.provider
    || reservation.entry.model !== reservation.catalogEntry.model
    || reservation.entry.providerCurrency !== reservation.policy.providerCurrency
    || reservation.entry.providerCostMinor
      !== reservation.catalogEntry.providerCostMinor
    || reservation.entry.providerMinorUnitScale
      !== reservation.policy.providerMinorUnitScale
    || reservation.entry.costSource !== "price_catalog"
  ) {
    throw new PricingUnavailableError("计费预留快照不一致。");
  }
  const catalogCredits = creditsForCatalogEntry(
    reservation.catalogEntry,
    reservation.policy,
  );
  if (catalogCredits !== reservation.quote.estimatedCredits) {
    throw new PricingUnavailableError("计费预留快照不一致。");
  }
  return costBeta;
}

export async function getServerCreditBalance(
  repository: AdminRepository,
  userId: string,
): Promise<number> {
  return balance(
    (await repository.listLedger(userId)).filter(
      (entry) => entry.tenantId === TENANT_ID,
    ),
  );
}

export async function reservePlatformOperation(
  repository: AdminRepository,
  input: {
    userId: string;
    operation: string;
    idempotencyKey: string;
    runtimeConfig?: FixedBetaRuntimeConfig;
  },
): Promise<CreditReservation> {
  if (!isValidPlatformBillingIdempotencyKey(input.idempotencyKey)) {
    throw new PricingUnavailableError("平台计费幂等键格式无效。");
  }
  const user = await repository.getUser(input.userId);
  if (!user || user.status !== "active") {
    throw new Error("ACCOUNT_UNAVAILABLE");
  }
  const { publicQuote, policy, catalogEntry } =
    await quotePlatformOperation(repository, input.operation, input.runtimeConfig);
  let account = await repository.getAccount(input.userId, TENANT_ID);
  if (!account) {
    if (repository.source === "supabase") {
      throw new Error("ACCOUNT_UNAVAILABLE");
    }
    account = {
      id: randomUUID(),
      tenantId: TENANT_ID,
      userId: input.userId,
      currency: "credit",
      createdAt: new Date().toISOString(),
    };
    await repository.createAccount(account);
    account = await repository.getAccount(input.userId, TENANT_ID) ?? account;
  }
  const billingOperationId = deterministicBillingOperationId(input);
  const reservation: ServerCreditLedgerEntry = {
    id: randomUUID(),
    accountId: account.id,
    tenantId: TENANT_ID,
    userId: input.userId,
    kind: "reserve",
    amount: -publicQuote.estimatedCredits,
    reason: `Platform generation reserve: ${input.operation}`,
    idempotencyKey: `${input.idempotencyKey}:reserve`,
    billingOperationId,
    modality: catalogEntry.modality,
    provider: catalogEntry.provider,
    model: catalogEntry.model,
    pricePolicyVersion: policy.version,
    costSource: "price_catalog",
    providerCurrency: policy.providerCurrency,
    providerCostMinor: catalogEntry.providerCostMinor,
    providerMinorUnitScale: policy.providerMinorUnitScale,
    reservedCredits: publicQuote.estimatedCredits,
    createdAt: new Date().toISOString(),
  };
  try {
    const entry = await repository.reserveLedger(reservation);
    assertReservationSnapshot(entry, reservation);
    return {
      entry,
      quote: publicQuote,
      policy,
      catalogEntry,
      replayed: entry.id !== reservation.id,
    };
  } catch (error) {
    if (
      error instanceof Error
      && error.message.includes("INSUFFICIENT_CREDITS")
    ) {
      throw new InsufficientCreditsError(publicQuote);
    }
    throw error;
  }
}

async function appendBillingTerminalResilient(
  repository: AdminRepository,
  intended: ServerCreditLedgerEntry,
  requireExactIntent: boolean,
): Promise<ServerCreditLedgerEntry> {
  let persisted: ServerCreditLedgerEntry;
  try {
    persisted = await repository.appendBillingTerminal(intended);
  } catch (error) {
    // The atomic append may have committed even though the response was lost.
    // Only an exact same-intent durable terminal may be adopted; a missing,
    // duplicate or opposite/conflicting terminal propagates the original error.
    let reread: ServerCreditLedgerEntry[];
    try {
      reread = await repository.listLedger(intended.userId);
    } catch {
      throw error;
    }
    const terminals = reread.filter(
      (entry) =>
        entry.userId === intended.userId
        && entry.tenantId === intended.tenantId
        && entry.billingOperationId === intended.billingOperationId
        && (entry.kind === "settle" || entry.kind === "refund"),
    );
    if (
      terminals.length !== 1
      || !isSameBillingTerminalIntent(terminals[0], intended)
    ) {
      throw error;
    }
    return terminals[0]!;
  }
  // Validated v2 service requests must also prove on a normal return that the
  // durable terminal has the exact same billing intent. The atomic RPC returns
  // the first winner, so a repeated settle/refund is accepted only while it is
  // byte-for-byte the same intent; an opposite kind or different evidence
  // (reason/cost/receipt) fails closed instead of silently adopting it.
  if (
    requireExactIntent
    && !isSameBillingTerminalIntent(persisted, intended)
  ) {
    throw new PricingUnavailableError(
      "计费终态与当前请求意图冲突，已拒绝覆盖既有终态。",
    );
  }
  return persisted;
}

export async function settlePlatformOperation(
  repository: AdminRepository,
  reservation: CreditReservation,
  receipt?: ProviderSettlementReceipt,
): Promise<ServerCreditLedgerEntry> {
  const costBeta = assertReservationForTerminal(reservation);
  const parsedReceipt = normalizeProviderSettlementReceipt(receipt);
  if (
    parsedReceipt
    && (
      parsedReceipt.providerCurrency !== reservation.policy.providerCurrency
      || parsedReceipt.providerMinorUnitScale
        !== reservation.policy.providerMinorUnitScale
    )
  ) {
    throw new PricingUnavailableError(
      "供应商结算回执币种或精度与价格策略不一致。",
    );
  }
  const providerCostMinor =
    parsedReceipt?.providerCostMinor
    ?? reservation.catalogEntry.providerCostMinor;
  assertSafeNonNegativeInteger(providerCostMinor, "供应商成本");
  const catalogCredits = reservation.quote.estimatedCredits;
  const pricingMode = pricingModeForCatalogEntry(reservation.catalogEntry);
  // Both fixed-beta v1 and cost_beta_credit_v2 always settle the original
  // reserved credits; a different provider receipt cost never reprices them.
  const settledCredits = pricingMode === "provider_cost_v1"
    ? creditsForProviderCost(providerCostMinor, reservation.policy)
    : catalogCredits;
  const reservedCredits = reservation.quote.estimatedCredits;
  return appendBillingTerminalResilient(repository, {
    id: randomUUID(),
    accountId: reservation.entry.accountId,
    tenantId: reservation.entry.tenantId,
    userId: reservation.entry.userId,
    kind: "settle",
    amount: reservedCredits - settledCredits,
    reason: `Platform generation settled: ${reservation.quote.operation}`,
    idempotencyKey: `${reservation.entry.idempotencyKey}:settle`,
    billingOperationId: reservation.entry.billingOperationId,
    modality: reservation.entry.modality,
    provider: reservation.entry.provider,
    model: reservation.entry.model,
    pricePolicyVersion: reservation.policy.version,
    costSource: parsedReceipt ? "provider_settlement" : "price_catalog",
    providerCurrency: reservation.policy.providerCurrency,
    providerCostMinor,
    providerMinorUnitScale: reservation.policy.providerMinorUnitScale,
    reservedCredits,
    settledCredits,
    createdAt: new Date().toISOString(),
  }, costBeta);
}

export async function refundPlatformOperation(
  repository: AdminRepository,
  reservation: CreditReservation,
  reason: string,
): Promise<ServerCreditLedgerEntry> {
  const costBeta = assertReservationForTerminal(reservation);
  // Exact bounded v2 trusted-operation failure refunds the user even though the
  // vendor MAY have charged. The platform absorbs that bounded loss: keep the
  // immutable catalog cost as metadata (never fake an actual 0 / provider
  // receipt) and keep costSource=price_catalog. Cache-hit/no-start refunds and
  // all legacy v1 semantics keep their original zero-provider-cost behavior.
  const absorbedUnknownProviderCost =
    costBeta && reason === PROVIDER_COST_UNKNOWN_PLATFORM_ABSORBED_REASON;
  return appendBillingTerminalResilient(repository, {
    id: randomUUID(),
    accountId: reservation.entry.accountId,
    tenantId: reservation.entry.tenantId,
    userId: reservation.entry.userId,
    kind: "refund",
    amount: reservation.quote.estimatedCredits,
    reason: reason.slice(0, 300),
    idempotencyKey: `${reservation.entry.idempotencyKey}:refund`,
    billingOperationId: reservation.entry.billingOperationId,
    modality: reservation.entry.modality,
    provider: reservation.entry.provider,
    model: reservation.entry.model,
    pricePolicyVersion: reservation.policy.version,
    costSource: absorbedUnknownProviderCost
      ? "price_catalog"
      : reservation.entry.costSource,
    providerCurrency: reservation.policy.providerCurrency,
    providerCostMinor: absorbedUnknownProviderCost
      ? reservation.catalogEntry.providerCostMinor
      : 0,
    providerMinorUnitScale: reservation.policy.providerMinorUnitScale,
    reservedCredits: reservation.quote.estimatedCredits,
    settledCredits: 0,
    createdAt: new Date().toISOString(),
  }, costBeta);
}
