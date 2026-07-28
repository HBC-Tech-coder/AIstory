import "server-only";

import { randomUUID } from "node:crypto";

import type { AdminRepository } from "@/lib/admin/repositories";
import type {
  BillingPolicy,
  PriceCatalogEntry,
  ServerCreditLedgerEntry,
} from "@/lib/admin/types";

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
};

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

export async function quotePlatformOperation(
  repository: AdminRepository,
  operation: string,
): Promise<{
  publicQuote: PublicGenerationQuote;
  policy: BillingPolicy;
  catalogEntry: PriceCatalogEntry;
}> {
  const policy = await repository.getBillingPolicy();
  if (!policy.version || policy.version === "unconfigured") {
    throw new PricingUnavailableError();
  }
  const entry = policy.entries.find(
    (candidate) => candidate.enabled && candidate.operation === operation,
  );
  if (!entry) {
    throw new PricingUnavailableError(`操作 ${operation} 尚无启用的版本化价目。`);
  }
  const estimatedCredits = creditsForProviderCost(
    entry.providerCostMinor,
    policy,
  );
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
  },
): Promise<CreditReservation> {
  const user = await repository.getUser(input.userId);
  if (!user || user.status !== "active") {
    throw new Error("ACCOUNT_UNAVAILABLE");
  }
  const { publicQuote, policy, catalogEntry } =
    await quotePlatformOperation(repository, input.operation);
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
  const billingOperationId = randomUUID();
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
    return {
      entry,
      quote: publicQuote,
      policy,
      catalogEntry,
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

export async function settlePlatformOperation(
  repository: AdminRepository,
  reservation: CreditReservation,
  actual?: {
    providerCostMinor: number;
    costSource: "provider_settlement" | "price_catalog";
  },
): Promise<ServerCreditLedgerEntry> {
  const providerCostMinor =
    actual?.providerCostMinor ?? reservation.catalogEntry.providerCostMinor;
  const settledCredits = creditsForProviderCost(
    providerCostMinor,
    reservation.policy,
  );
  const reservedCredits = reservation.quote.estimatedCredits;
  return repository.appendBillingTerminal({
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
    costSource: actual?.costSource ?? "price_catalog",
    providerCurrency: reservation.policy.providerCurrency,
    providerCostMinor,
    providerMinorUnitScale: reservation.policy.providerMinorUnitScale,
    reservedCredits,
    settledCredits,
    createdAt: new Date().toISOString(),
  });
}

export async function refundPlatformOperation(
  repository: AdminRepository,
  reservation: CreditReservation,
  reason: string,
): Promise<ServerCreditLedgerEntry> {
  return repository.appendBillingTerminal({
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
    costSource: reservation.entry.costSource,
    providerCurrency: reservation.policy.providerCurrency,
    providerCostMinor: 0,
    providerMinorUnitScale: reservation.policy.providerMinorUnitScale,
    reservedCredits: reservation.quote.estimatedCredits,
    settledCredits: 0,
    createdAt: new Date().toISOString(),
  });
}
