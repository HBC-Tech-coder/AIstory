import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { LocalAdminRepository } from "@/lib/admin/localRepository";
import type { AdminRepository } from "@/lib/admin/repositories";
import {
  createUserWithInitialGrant,
  saveBillingPolicy,
} from "@/lib/admin/service";
import type {
  AdminActor,
  BillingPolicy,
  PriceCatalogEntry,
  ServerCreditLedgerEntry,
} from "@/lib/admin/types";
import {
  buildCostBetaPricingCandidate,
  COST_BETA_PRICING_MODE,
  COST_BETA_PRICING_MODE_CONFIG,
  COST_BETA_PRICING_MODE_ENV,
  COST_BETA_PRICING_VERSION_ENV,
  isCostBetaPricingModeRequested,
} from "@/lib/billing/costBetaPricing";
import { PLATFORM_CANONICAL_PROVIDER_BINDINGS } from "@/lib/billing/platformCostEnvelopeServer";
import {
  markGenerationBillingOperationFailed,
  markGenerationBillingProviderStarted,
  markGenerationBillingProviderSucceeded,
  refundGenerationBilling,
  settleGenerationBilling,
  type GenerationBillingContext,
} from "@/lib/billing/generationGate";
import {
  assertCostBetaGeneratedCore,
  isCostBetaGeneratedCore,
} from "@/lib/billing/generationDelivery";
import {
  BillingReconciliationError,
  discoverPendingBillingReservations,
  PROVIDER_COST_UNKNOWN_PLATFORM_ABSORBED_REASON,
  reconcilePendingBillingOperation,
  type BillingCompletionEvidence,
  type BillingCompletionOutcome,
  type FrozenBillingReservation,
} from "@/lib/billing/reconciliation";
import {
  getServerCreditBalance,
  PricingUnavailableError,
  quotePlatformOperation,
  refundPlatformOperation,
  settlePlatformOperation,
  type CreditReservation,
} from "@/lib/billing/service";
import {
  FIXED_BETA_PRICING_MODE_CONFIG,
  FIXED_BETA_PRICING_MODE_ENV,
  FIXED_BETA_PRICING_VERSION_ENV,
  isFixedBetaPricingModeRequested,
  type FixedBetaRuntimeConfig,
} from "@/lib/billing/fixedBetaPricing";

// Canonical public deployment bindings from the read-only platform envelope.
// These are the only runtime models/endpoints the v2 pricing contract accepts.
// No API key is needed: this script never performs network I/O.
const runtimeConfig: FixedBetaRuntimeConfig = {
  text: { ...PLATFORM_CANONICAL_PROVIDER_BINDINGS.text },
  vision: { ...PLATFORM_CANONICAL_PROVIDER_BINDINGS.vision },
  image: { ...PLATFORM_CANONICAL_PROVIDER_BINDINGS.image },
  tts: {
    provider: PLATFORM_CANONICAL_PROVIDER_BINDINGS.tts.provider,
    speechModel: PLATFORM_CANONICAL_PROVIDER_BINDINGS.tts.model,
    baseUrl: PLATFORM_CANONICAL_PROVIDER_BINDINGS.tts.baseUrl,
  },
  mockImage: false,
};

const originalFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = (async () => {
  fetchCalls += 1;
  throw new Error("NETWORK_FORBIDDEN");
}) as typeof fetch;

const actor: AdminActor = {
  userId: "cost-beta-test-admin",
  roles: ["super_admin"],
  mode: "local",
};

function catalogEntryFor(policy: BillingPolicy): PriceCatalogEntry {
  const entry = policy.entries.find(
    (candidate) =>
      candidate.enabled === true
      && candidate.pricingMode === COST_BETA_PRICING_MODE
      && Number.isSafeInteger(candidate.fixedCredits)
      && (candidate.fixedCredits ?? 0) > 0,
  );
  assert.ok(entry, "cost beta candidate must contain an enabled v2 entry");
  return entry;
}

async function makeReservation(
  repository: AdminRepository,
  policy: BillingPolicy,
  userId: string,
  operation: string,
  idempotencyKey: string,
): Promise<CreditReservation> {
  const catalogEntry = policy.entries.find(
    (entry) => entry.operation === operation && entry.enabled === true,
  );
  assert.ok(catalogEntry, `missing catalog entry for ${operation}`);
  assert.equal(catalogEntry.pricingMode, COST_BETA_PRICING_MODE);
  const fixedCredits = catalogEntry.fixedCredits;
  assert.ok(
    Number.isSafeInteger(fixedCredits) && (fixedCredits ?? 0) > 0,
    "v2 fixedCredits must be a positive integer",
  );
  const account = await repository.getAccount(userId, "platform");
  assert.ok(account, "fixture user must own a platform credit account");
  const reservedCredits = fixedCredits as number;
  const reservationEntry: ServerCreditLedgerEntry = {
    id: randomUUID(),
    accountId: account.id,
    tenantId: "platform",
    userId,
    kind: "reserve",
    amount: -reservedCredits,
    reason: `Platform generation reserve: ${operation}`,
    idempotencyKey: `${idempotencyKey}:reserve`,
    billingOperationId: randomUUID(),
    modality: catalogEntry.modality,
    provider: catalogEntry.provider,
    model: catalogEntry.model,
    pricePolicyVersion: policy.version,
    costSource: "price_catalog",
    providerCurrency: policy.providerCurrency,
    providerCostMinor: catalogEntry.providerCostMinor,
    providerMinorUnitScale: policy.providerMinorUnitScale,
    reservedCredits,
    createdAt: new Date().toISOString(),
  };
  const persisted = await repository.reserveLedger(reservationEntry);
  return {
    entry: persisted,
    quote: {
      operation,
      modalities: [catalogEntry.modality ?? "mixed"],
      estimatedCredits: reservedCredits,
      pricePolicyVersion: policy.version,
      costSource: "price_catalog",
      responsibility: "platform_credits",
    },
    policy,
    catalogEntry,
    replayed: false,
  };
}

function contextFor(reservation: CreditReservation): GenerationBillingContext {
  return {
    mode: "platform_managed",
    reservation,
    providerOutcome: "not_started",
  };
}

function evidenceFor(
  reservation: FrozenBillingReservation,
  outcome: BillingCompletionOutcome,
  evidenceId: string,
): BillingCompletionEvidence {
  return {
    reservationId: reservation.reservationId,
    billingOperationId: reservation.billingOperationId,
    accountId: reservation.accountId,
    userId: reservation.userId,
    tenantId: reservation.tenantId,
    provider: reservation.provider,
    model: reservation.model,
    pricePolicyVersion: reservation.pricePolicyVersion,
    outcome,
    scope: "whole_operation",
    evidenceId,
  };
}

async function freezableReservation(
  repository: AdminRepository,
  policy: BillingPolicy,
  userId: string,
  operation: string,
  idempotencyKey: string,
): Promise<FrozenBillingReservation> {
  const reservation = await makeReservation(
    repository,
    policy,
    userId,
    operation,
    idempotencyKey,
  );
  const discovered = await discoverPendingBillingReservations(repository, {
    userId,
    billingOperationId: reservation.entry.billingOperationId,
  });
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0]!.costBeta, true);
  return discovered[0]!.reservation;
}

type FakeRepositoryOptions = {
  loseResponse?: boolean;
  loseResponseOnReturn?: boolean;
};

function createFakeRepository(
  initial: ServerCreditLedgerEntry[],
  options: FakeRepositoryOptions = {},
): { repository: AdminRepository; ledger: ServerCreditLedgerEntry[] } {
  const ledger = initial.map((entry) => ({ ...entry }));
  const repository = {
    source: "local_development" as const,
    async listLedger(userId?: string): Promise<ServerCreditLedgerEntry[]> {
      return ledger
        .filter((entry) => !userId || entry.userId === userId)
        .map((entry) => ({ ...entry }));
    },
    async appendBillingTerminal(
      entry: ServerCreditLedgerEntry,
    ): Promise<ServerCreditLedgerEntry> {
      // Atomic first-wins: check + insert without an intervening await.
      const existing = ledger.find(
        (candidate) =>
          candidate.tenantId === entry.tenantId
          && candidate.userId === entry.userId
          && candidate.billingOperationId === entry.billingOperationId
          && (candidate.kind === "settle" || candidate.kind === "refund"),
      );
      if (existing) {
        const result = { ...existing };
        if (options.loseResponseOnReturn) {
          throw new Error("SYNTHETIC_RESPONSE_LOSS_ON_RETURN");
        }
        return result;
      }
      ledger.push({ ...entry });
      if (options.loseResponse) throw new Error("SYNTHETIC_RESPONSE_LOSS");
      return { ...entry };
    },
  };
  return { repository: repository as unknown as AdminRepository, ledger };
}

function fakeReserveEntry(
  policy: BillingPolicy,
  operation: string,
  userId: string,
  idempotencyKey: string,
): ServerCreditLedgerEntry {
  const catalogEntry = policy.entries.find(
    (entry) => entry.operation === operation && entry.enabled === true,
  );
  assert.ok(catalogEntry);
  const fixedCredits = catalogEntry.fixedCredits;
  assert.ok(Number.isSafeInteger(fixedCredits) && (fixedCredits ?? 0) > 0);
  const reservedCredits = fixedCredits as number;
  return {
    id: randomUUID(),
    accountId: `fake-account-${userId}`,
    tenantId: "platform",
    userId,
    kind: "reserve",
    amount: -reservedCredits,
    reason: `Platform generation reserve: ${operation}`,
    idempotencyKey: `${idempotencyKey}:reserve`,
    billingOperationId: randomUUID(),
    modality: catalogEntry.modality,
    provider: catalogEntry.provider,
    model: catalogEntry.model,
    pricePolicyVersion: policy.version,
    costSource: "price_catalog",
    providerCurrency: policy.providerCurrency,
    providerCostMinor: catalogEntry.providerCostMinor,
    providerMinorUnitScale: policy.providerMinorUnitScale,
    reservedCredits,
    createdAt: new Date().toISOString(),
  };
}

const root = await mkdtemp(path.join(os.tmpdir(), "aistory-cost-beta-v2-"));
const storePath = path.join(root, "admin.json");
const previousBillingFlag = process.env.AISTORY_PLATFORM_BILLING_ENABLED;
const previousLegacyPlatformFlag = process.env.AISTORY_PLATFORM_MANAGED_ENABLED;
const previousCostBetaMode = process.env[COST_BETA_PRICING_MODE_ENV];
const previousCostBetaVersion = process.env[COST_BETA_PRICING_VERSION_ENV];
const previousFixedMode = process.env[FIXED_BETA_PRICING_MODE_ENV];
const previousFixedVersion = process.env[FIXED_BETA_PRICING_VERSION_ENV];

try {
  const candidate = buildCostBetaPricingCandidate(runtimeConfig);
  const policy = candidate.policy;
  const operation = catalogEntryFor(policy).operation;

  delete process.env.AISTORY_PLATFORM_BILLING_ENABLED;
  delete process.env.AISTORY_PLATFORM_MANAGED_ENABLED;

  // Kill-switch-on installation is rejected exactly like the fixed candidate.
  process.env.AISTORY_PLATFORM_BILLING_ENABLED = "true";
  await assert.rejects(
    saveBillingPolicy(
      new LocalAdminRepository(storePath),
      actor,
      policy,
      "拒绝计费开启时写入成本β定价",
      "cost-beta-save-blocked",
    ),
    /只能在平台计费开关关闭时写入/,
  );
  delete process.env.AISTORY_PLATFORM_BILLING_ENABLED;

  // Malformed v2 version/entry combinations fail closed.
  const malformedVersionPolicy = {
    ...policy,
    version: "cost-beta-v2.NOT-A-DIGEST",
  };
  await assert.rejects(
    saveBillingPolicy(
      new LocalAdminRepository(storePath),
      actor,
      malformedVersionPolicy,
      "拒绝畸形成本β版本",
      "cost-beta-save-malformed-version",
    ),
    /成本 β 定价合同无效/,
  );
  const downgradedEntriesPolicy = {
    ...policy,
    entries: policy.entries.map((entry) => {
      const downgraded: PriceCatalogEntry = {
        operation: entry.operation,
        modality: entry.modality,
        provider: entry.provider,
        model: entry.model,
        providerCostMinor: entry.providerCostMinor,
        enabled: entry.enabled,
      };
      return downgraded;
    }),
  };
  await assert.rejects(
    saveBillingPolicy(
      new LocalAdminRepository(storePath),
      actor,
      downgradedEntriesPolicy,
      "拒绝成本β版本降级",
      "cost-beta-save-downgrade",
    ),
    /成本 β 定价合同无效/,
  );

  // Actual durable save -> fresh repository restart -> read.
  const repository = new LocalAdminRepository(storePath);
  await saveBillingPolicy(
    repository,
    actor,
    policy,
    "发布成本β本地测试定价候选",
    "cost-beta-save-1",
  );
  const restarted = new LocalAdminRepository(storePath);
  const persistedPolicy = await restarted.getBillingPolicy();
  assert.equal(persistedPolicy.version, policy.version);
  assert.equal(persistedPolicy.entries.length, policy.entries.length);
  assert.ok(
    persistedPolicy.entries.every(
      (entry) => entry.pricingMode === COST_BETA_PRICING_MODE,
    ),
  );

  // Cost beta activation is required for a quote; this script never turns the
  // selector on, so an unactivated v2 policy must fail closed before provider work.
  let selectorRequested = false;
  try {
    selectorRequested = isCostBetaPricingModeRequested(process.env);
  } catch {
    selectorRequested = false;
  }
  if (!selectorRequested) {
    await assert.rejects(
      quotePlatformOperation(restarted, operation, runtimeConfig),
      PricingUnavailableError,
    );
  }

  const failureUser = "cost-beta-failure-user";
  await createUserWithInitialGrant(restarted, {
    userId: failureUser,
    tenantId: "platform",
    displayName: "Cost Beta Failure User",
    status: "active",
    userType: "player",
  });
  const failureBalance = await getServerCreditBalance(restarted, failureUser);

  // Trusted internal failed_not_delivered intent -> full user refund even
  // though the vendor cost is unknown. Fixture balance is restored exactly.
  const failureReservation = await makeReservation(
    restarted,
    persistedPolicy,
    failureUser,
    operation,
    "cost-beta-failure",
  );
  const failureContext = contextFor(failureReservation);
  markGenerationBillingProviderStarted(failureContext);
  markGenerationBillingOperationFailed(failureContext);
  assert.throws(
    () => markGenerationBillingProviderSucceeded(failureContext),
    PricingUnavailableError,
    "a failed completion must reject success before mutating provider state",
  );
  assert.equal(failureContext.providerOutcome, "outcome_unknown");
  assert.equal(
    await refundGenerationBilling(failureContext, "internal pipeline failure", {
      repository: restarted,
    }),
    "refund",
  );
  assert.equal(
    await getServerCreditBalance(restarted, failureUser),
    failureBalance,
    "bounded v2 failure refund must restore the fixture balance",
  );
  const failureTerminals = (
    await restarted.listLedger(failureUser)
  ).filter(
    (entry) =>
      entry.billingOperationId === failureReservation.entry.billingOperationId
      && (entry.kind === "settle" || entry.kind === "refund"),
  );
  assert.equal(failureTerminals.length, 1);
  assert.equal(failureTerminals[0]!.kind, "refund");
  assert.equal(failureTerminals[0]!.amount, failureReservation.quote.estimatedCredits);
  assert.equal(failureTerminals[0]!.settledCredits, 0);
  assert.equal(failureTerminals[0]!.costSource, "price_catalog");
  assert.equal(
    failureTerminals[0]!.providerCostMinor,
    failureReservation.catalogEntry.providerCostMinor,
    "trusted v2 failure refund must retain the immutable catalog cost",
  );
  assert.equal(
    failureTerminals[0]!.reason,
    PROVIDER_COST_UNKNOWN_PLATFORM_ABSORBED_REASON,
  );
  assert.equal(
    await refundGenerationBilling(failureContext, "repeated same intent", {
      repository: restarted,
    }),
    "refund",
  );
  assert.equal(
    (await restarted.listLedger(failureUser)).filter(
      (entry) =>
        entry.billingOperationId === failureReservation.entry.billingOperationId
        && (entry.kind === "settle" || entry.kind === "refund"),
    ).length,
    1,
    "repeated identical failure intent must stay idempotent",
  );

  // Successful generation settles the original reserved credits; a late client
  // abort never turns a completed provider result into a refund.
  const successUser = "cost-beta-success-user";
  await createUserWithInitialGrant(restarted, {
    userId: successUser,
    tenantId: "platform",
    displayName: "Cost Beta Success User",
    status: "active",
    userType: "player",
  });
  const successBalance = await getServerCreditBalance(restarted, successUser);
  const successReservation = await makeReservation(
    restarted,
    persistedPolicy,
    successUser,
    operation,
    "cost-beta-success",
  );
  const successContext = contextFor(successReservation);
  markGenerationBillingProviderStarted(successContext);
  markGenerationBillingProviderSucceeded(successContext);
  const aborted = new AbortController();
  aborted.abort();
  delete process.env.AISTORY_PLATFORM_BILLING_ENABLED;
  assert.equal(
    await settleGenerationBilling(successContext, {
      requestSignal: aborted.signal,
      repository: restarted,
    }),
    "settle",
    "terminals must work while the activation kill switch is off",
  );
  assert.equal(
    await getServerCreditBalance(restarted, successUser),
    successBalance - successReservation.quote.estimatedCredits,
  );
  const successTerminal = (
    await restarted.listLedger(successUser)
  ).find(
    (entry) =>
      entry.billingOperationId === successReservation.entry.billingOperationId
      && entry.kind === "settle",
  );
  assert.ok(successTerminal);
  assert.equal(successTerminal.amount, 0);
  assert.equal(
    successTerminal.settledCredits,
    successReservation.quote.estimatedCredits,
  );
  assert.equal(successTerminal.costSource, "price_catalog");

  // A provider receipt cannot reprice v2 fixed credits.
  const receiptReservation = await makeReservation(
    restarted,
    persistedPolicy,
    successUser,
    operation,
    "cost-beta-receipt",
  );
  const receiptSettlement = await settlePlatformOperation(
    restarted,
    receiptReservation,
    {
      providerCostMinor: 999_999,
      providerCurrency: persistedPolicy.providerCurrency,
      providerMinorUnitScale: persistedPolicy.providerMinorUnitScale,
    },
  );
  assert.equal(receiptSettlement.kind, "settle");
  assert.equal(receiptSettlement.amount, 0);
  assert.equal(
    receiptSettlement.settledCredits,
    receiptReservation.quote.estimatedCredits,
  );
  assert.equal(receiptSettlement.costSource, "provider_settlement");

  // Original provider-not-started refund semantics are unchanged.
  const notStartedReservation = await makeReservation(
    restarted,
    persistedPolicy,
    successUser,
    operation,
    "cost-beta-not-started",
  );
  assert.equal(
    await refundGenerationBilling(
      contextFor(notStartedReservation),
      "Cache hit; reservation released.",
      { providerNotStarted: true, repository: restarted },
    ),
    "refund",
  );
  const notStartedTerminal = (
    await restarted.listLedger(successUser)
  ).find(
    (entry) =>
      entry.billingOperationId === notStartedReservation.entry.billingOperationId
      && entry.kind === "refund",
  );
  assert.equal(notStartedTerminal?.reason, "Cache hit; reservation released.");
  assert.equal(
    notStartedTerminal?.providerCostMinor,
    0,
    "cache/no-start refund semantics keep zero provider cost",
  );

  // Provider-started unknown outcome without an explicit v2 failure intent
  // remains pending; age never authorizes a refund.
  const pendingReservation = await makeReservation(
    restarted,
    persistedPolicy,
    successUser,
    operation,
    "cost-beta-pending",
  );
  const pendingContext = contextFor(pendingReservation);
  markGenerationBillingProviderStarted(pendingContext);
  assert.equal(
    await refundGenerationBilling(pendingContext, "provider timeout", {
      repository: restarted,
    }),
    "pending",
  );
  assert.equal(
    (await restarted.listLedger(successUser)).filter(
      (entry) =>
        entry.billingOperationId === pendingReservation.entry.billingOperationId
        && (entry.kind === "settle" || entry.kind === "refund"),
    ).length,
    0,
  );

  // Validated v2 service terminal intent: concurrent settle/refund leaves
  // exactly one durable winner and the loser fails closed instead of silently
  // adopting the opposite terminal.
  const serviceRaceReservation = await makeReservation(
    restarted,
    persistedPolicy,
    successUser,
    operation,
    "cost-beta-service-race",
  );
  const serviceRaceOutcomes = await Promise.allSettled([
    settlePlatformOperation(restarted, serviceRaceReservation),
    refundPlatformOperation(
      restarted,
      serviceRaceReservation,
      "explicit conflicting refund",
    ),
  ]);
  assert.equal(
    serviceRaceOutcomes.filter((outcome) => outcome.status === "fulfilled").length,
    1,
    "exactly one concurrent v2 service terminal may win",
  );
  assert.equal(
    serviceRaceOutcomes.filter((outcome) => outcome.status === "rejected").length,
    1,
    "the losing v2 service terminal must fail closed",
  );
  assert.equal(
    (await restarted.listLedger(successUser)).filter(
      (entry) =>
        entry.billingOperationId
          === serviceRaceReservation.entry.billingOperationId
        && (entry.kind === "settle" || entry.kind === "refund"),
    ).length,
    1,
    "concurrent v2 settle/refund must not write a second terminal",
  );

  // A byte-for-byte repeated v2 intent reuses the original terminal; changed
  // evidence (opposite kind or a different receipt) is rejected.
  const repeatReservation = await makeReservation(
    restarted,
    persistedPolicy,
    successUser,
    operation,
    "cost-beta-service-repeat",
  );
  const firstSettle = await settlePlatformOperation(restarted, repeatReservation);
  const repeatedSettle = await settlePlatformOperation(restarted, repeatReservation);
  assert.equal(repeatedSettle.id, firstSettle.id);
  await assert.rejects(
    refundPlatformOperation(restarted, repeatReservation, "conflicting refund"),
    PricingUnavailableError,
  );
  await assert.rejects(
    settlePlatformOperation(restarted, repeatReservation, {
      providerCostMinor: firstSettle.providerCostMinor! + 1,
      providerCurrency: persistedPolicy.providerCurrency,
      providerMinorUnitScale: persistedPolicy.providerMinorUnitScale,
    }),
    PricingUnavailableError,
  );
  assert.equal(
    (await restarted.listLedger(successUser)).filter(
      (entry) =>
        entry.billingOperationId === repeatReservation.entry.billingOperationId
        && (entry.kind === "settle" || entry.kind === "refund"),
    ).length,
    1,
  );

  // Legacy v1 failure markers are strict no-ops.
  const legacyPolicy: BillingPolicy = {
    version: "provider-cost-test-v1",
    markupBasisPoints: policy.markupBasisPoints,
    initialGrantCredits: policy.initialGrantCredits,
    providerCurrency: policy.providerCurrency,
    providerMinorUnitScale: policy.providerMinorUnitScale,
    creditUnitsPerProviderMinor: policy.creditUnitsPerProviderMinor,
    entries: [
      {
        operation,
        modality: "text",
        provider: "fixture-provider",
        model: "fixture-model",
        providerCostMinor: 10,
        enabled: true,
      },
    ],
    updatedAt: policy.updatedAt,
    updatedBy: policy.updatedBy,
  };
  const legacyCatalog = legacyPolicy.entries[0]!;
  const legacyReservation: CreditReservation = {
    entry: {
      ...failureReservation.entry,
      provider: legacyCatalog.provider,
      model: legacyCatalog.model,
    },
    quote: {
      ...failureReservation.quote,
      pricePolicyVersion: legacyPolicy.version,
    },
    policy: legacyPolicy,
    catalogEntry: legacyCatalog,
    replayed: false,
  };
  assert.doesNotThrow(() => {
    markGenerationBillingOperationFailed(
      contextFor(legacyReservation),
    );
  });
  const fixedLegacyPolicy: BillingPolicy = {
    ...legacyPolicy,
    version: `fixed-beta-v1.${"a".repeat(64)}`,
    entries: [{
      ...legacyCatalog,
      pricingMode: "fixed_beta_credit_v1",
      fixedCredits: 1,
    }],
  };
  assert.doesNotThrow(() => {
    markGenerationBillingOperationFailed(
      contextFor({
        ...legacyReservation,
        policy: fixedLegacyPolicy,
        catalogEntry: fixedLegacyPolicy.entries[0]!,
        quote: {
          ...legacyReservation.quote,
          pricePolicyVersion: fixedLegacyPolicy.version,
        },
      }),
    );
  });

  // Selector/activation dispatch uses the exact env keys from the actual
  // pricing source. The old fixed-beta selector never claims v2; the new helper
  // returns false for the old selector; a v2 selector with a legacy policy
  // fails closed.
  process.env[COST_BETA_PRICING_MODE_ENV] = COST_BETA_PRICING_MODE_CONFIG;
  assert.equal(isCostBetaPricingModeRequested(process.env), true);
  let legacyFixedRequested = false;
  try {
    legacyFixedRequested = isFixedBetaPricingModeRequested();
  } catch {
    legacyFixedRequested = false;
  }
  assert.equal(legacyFixedRequested, false);
  process.env[COST_BETA_PRICING_MODE_ENV] = FIXED_BETA_PRICING_MODE_CONFIG;
  assert.equal(isCostBetaPricingModeRequested(process.env), false);
  delete process.env[COST_BETA_PRICING_MODE_ENV];

  const dispatchRepository = new LocalAdminRepository(
    path.join(root, "dispatch.json"),
  );
  await saveBillingPolicy(
    dispatchRepository,
    actor,
    policy,
    "发布成本β调度定价",
    "cost-beta-dispatch-save",
  );
  delete process.env.AISTORY_PLATFORM_MANAGED_ENABLED;
  delete process.env.AISTORY_PLATFORM_BILLING_ENABLED;
  process.env.AISTORY_PLATFORM_BILLING_ENABLED = "true";
  process.env[COST_BETA_PRICING_MODE_ENV] = COST_BETA_PRICING_MODE_CONFIG;
  process.env[COST_BETA_PRICING_VERSION_ENV] = policy.version;
  const dispatchQuote = await quotePlatformOperation(
    dispatchRepository,
    operation,
    runtimeConfig,
  );
  assert.equal(
    dispatchQuote.publicQuote.estimatedCredits,
    catalogEntryFor(policy).fixedCredits,
  );
  await dispatchRepository.saveBillingPolicy({
    ...legacyPolicy,
    updatedAt: "2030-01-01T00:00:00.000Z",
    updatedBy: actor.userId,
  });
  await assert.rejects(
    quotePlatformOperation(dispatchRepository, operation, runtimeConfig),
    PricingUnavailableError,
  );
  delete process.env[COST_BETA_PRICING_MODE_ENV];
  delete process.env[COST_BETA_PRICING_VERSION_ENV];
  delete process.env.AISTORY_PLATFORM_BILLING_ENABLED;

  // Reconciliation: durable evidence-bound failure refund.
  const reconciliationUser = "cost-beta-reconcile-user";
  await createUserWithInitialGrant(restarted, {
    userId: reconciliationUser,
    tenantId: "platform",
    displayName: "Cost Beta Reconciliation User",
    status: "active",
    userType: "player",
  });
  const reconciliationBalance = await getServerCreditBalance(
    restarted,
    reconciliationUser,
  );
  const reconciliationReservation = await freezableReservation(
    restarted,
    persistedPolicy,
    reconciliationUser,
    operation,
    "cost-beta-reconcile-failure",
  );
  const failureEvidence = evidenceFor(
    reconciliationReservation,
    "failed_not_delivered",
    "trusted-evidence-failure-1",
  );
  const reconciledFailure = await reconcilePendingBillingOperation(restarted, {
    userId: reconciliationUser,
    billingOperationId: reconciliationReservation.billingOperationId,
    policy: persistedPolicy,
    lookup: async () => failureEvidence,
  });
  assert.equal(reconciledFailure.status, "refunded");
  if (reconciledFailure.status === "refunded") {
    assert.equal(
      reconciledFailure.entry.amount,
      reconciliationReservation.reservedCredits,
    );
    assert.equal(reconciledFailure.entry.settledCredits, 0);
    assert.equal(reconciledFailure.entry.costSource, "price_catalog");
    assert.match(
      reconciledFailure.entry.reason ?? "",
      new RegExp(`^${PROVIDER_COST_UNKNOWN_PLATFORM_ABSORBED_REASON}:`),
    );
  }
  assert.equal(
    await getServerCreditBalance(restarted, reconciliationUser),
    reconciliationBalance,
  );

  // Same proof replay returns the original single terminal.
  const replayedFailure = await reconcilePendingBillingOperation(restarted, {
    userId: reconciliationUser,
    billingOperationId: reconciliationReservation.billingOperationId,
    policy: persistedPolicy,
    lookup: async () => failureEvidence,
  });
  assert.equal(replayedFailure.status, "refunded");
  if (
    replayedFailure.status === "refunded"
    && reconciledFailure.status === "refunded"
  ) {
    assert.equal(replayedFailure.entry.id, reconciledFailure.entry.id);
    assert.equal(replayedFailure.replayed, true);
  }
  assert.equal(
    (await restarted.listLedger(reconciliationUser)).filter(
      (entry) =>
        entry.billingOperationId === reconciliationReservation.billingOperationId
        && (entry.kind === "settle" || entry.kind === "refund"),
    ).length,
    1,
  );

  // Conflicting proof/outcome for the same operation must reject, never
  // silently rewrite the durable terminal.
  await assert.rejects(
    reconcilePendingBillingOperation(restarted, {
      userId: reconciliationUser,
      billingOperationId: reconciliationReservation.billingOperationId,
      policy: persistedPolicy,
      lookup: async () =>
        evidenceFor(
          reconciliationReservation,
          "failed_not_delivered",
          "trusted-evidence-failure-2",
        ),
    }),
    BillingReconciliationError,
  );
  await assert.rejects(
    reconcilePendingBillingOperation(restarted, {
      userId: reconciliationUser,
      billingOperationId: reconciliationReservation.billingOperationId,
      policy: persistedPolicy,
      lookup: async () =>
        evidenceFor(
          reconciliationReservation,
          "succeeded",
          "trusted-evidence-success-1",
        ),
    }),
    BillingReconciliationError,
  );

  // A durable terminal is never reported as "pending" merely because fresh
  // evidence is unknown or the lookup is temporarily unavailable. The real,
  // structurally valid terminal is returned and never replaced.
  for (const lookup of [
    async () =>
      evidenceFor(
        reconciliationReservation,
        "unknown",
        "trusted-evidence-terminal-unknown",
      ),
    async (): Promise<never> => {
      throw new Error("SYNTHETIC_LOOKUP_UNAVAILABLE");
    },
  ]) {
    const adopted = await reconcilePendingBillingOperation(restarted, {
      userId: reconciliationUser,
      billingOperationId: reconciliationReservation.billingOperationId,
      policy: persistedPolicy,
      lookup,
    });
    assert.equal(adopted.status, "refunded");
    if (
      adopted.status === "refunded"
      && reconciledFailure.status === "refunded"
    ) {
      assert.equal(adopted.entry.id, reconciledFailure.entry.id);
      assert.equal(adopted.replayed, true);
    }
  }
  assert.equal(
    (await restarted.listLedger(reconciliationUser)).filter(
      (entry) =>
        entry.billingOperationId === reconciliationReservation.billingOperationId
        && (entry.kind === "settle" || entry.kind === "refund"),
    ).length,
    1,
  );

  // Changed current pricing must not reprice an existing captured reserve. Use
  // the formal phase (same canonical runtime binding, different derived credits
  // and version) instead of an invalid synthetic model.
  const changedCandidate = buildCostBetaPricingCandidate(runtimeConfig, "formal");
  await restarted.saveBillingPolicy({
    ...changedCandidate.policy,
    updatedAt: "9999-12-31T23:59:59.999Z",
    updatedBy: actor.userId,
  });
  const changedPriceReconciliation = await freezableReservation(
    new LocalAdminRepository(storePath),
    persistedPolicy,
    reconciliationUser,
    operation,
    "cost-beta-reconcile-changed-price",
  );
  const changedPriceResult = await reconcilePendingBillingOperation(
    new LocalAdminRepository(storePath),
    {
      userId: reconciliationUser,
      billingOperationId: changedPriceReconciliation.billingOperationId,
      policy: persistedPolicy,
      lookup: async () =>
        evidenceFor(
          changedPriceReconciliation,
          "failed_not_delivered",
          "trusted-evidence-changed-price",
        ),
    },
  );
  assert.equal(changedPriceResult.status, "refunded");
  if (changedPriceResult.status === "refunded") {
    assert.equal(
      changedPriceResult.entry.amount,
      changedPriceReconciliation.reservedCredits,
      "historical captured pricing must drive the refund amount",
    );
  }

  // Unknown/missing/throwing evidence leaves the operation pending.
  const fakeUser = "cost-beta-fake-user";
  const fakeReserve = fakeReserveEntry(
    persistedPolicy,
    operation,
    fakeUser,
    "cost-beta-fake-unknown",
  );
  const fakeUnknown = createFakeRepository([fakeReserve]);
  const fakeUnknownReservation = (
    await discoverPendingBillingReservations(fakeUnknown.repository, {
      userId: fakeUser,
      billingOperationId: fakeReserve.billingOperationId,
    })
  )[0]!.reservation;
  const unknownResult = await reconcilePendingBillingOperation(
    fakeUnknown.repository,
    {
      userId: fakeUser,
      billingOperationId: fakeReserve.billingOperationId!,
      policy: persistedPolicy,
      lookup: async () =>
        evidenceFor(
          fakeUnknownReservation,
          "unknown",
          "trusted-evidence-unknown",
        ),
    },
  );
  assert.equal(unknownResult.status, "pending");
  assert.equal(fakeUnknown.ledger.length, 1);

  const throwingResult = await reconcilePendingBillingOperation(
    fakeUnknown.repository,
    {
      userId: fakeUser,
      billingOperationId: fakeReserve.billingOperationId!,
      policy: persistedPolicy,
      lookup: async () => {
        throw new Error("SYNTHETIC_LOOKUP_UNAVAILABLE");
      },
    },
  );
  assert.equal(throwingResult.status, "pending");

  // Response-loss: the atomic append commits but the caller sees an error.
  const lossReserve = fakeReserveEntry(
    persistedPolicy,
    operation,
    fakeUser,
    "cost-beta-fake-loss",
  );
  const lossy = createFakeRepository([lossReserve], { loseResponse: true });
  const lossReservation = await discoverPendingBillingReservations(
    lossy.repository,
    { userId: fakeUser, billingOperationId: lossReserve.billingOperationId },
  );
  assert.equal(lossReservation.length, 1);
  const lossEvidence = evidenceFor(
    lossReservation[0]!.reservation,
    "failed_not_delivered",
    "trusted-evidence-loss",
  );
  const lossResult = await reconcilePendingBillingOperation(lossy.repository, {
    userId: fakeUser,
    billingOperationId: lossReserve.billingOperationId!,
    policy: persistedPolicy,
    lookup: async () => lossEvidence,
  });
  assert.equal(lossResult.status, "refunded");
  assert.equal(lossy.ledger.filter((entry) => entry.kind === "refund").length, 1);
  if (lossResult.status === "refunded") {
    assert.equal(lossResult.replayed, true);
  }

  // Service response-loss: an atomic terminal append that commits and then
  // loses its response is recovered only by an EXACT same-intent durable
  // terminal. A conflicting existing terminal must propagate the failure.
  const serviceLossReserve = fakeReserveEntry(
    persistedPolicy,
    operation,
    fakeUser,
    "cost-beta-service-loss",
  );
  const serviceLossCatalog = persistedPolicy.entries.find(
    (entry) => entry.operation === operation,
  );
  assert.ok(serviceLossCatalog);
  assert.ok(serviceLossReserve.reservedCredits);
  const serviceLossReservation: CreditReservation = {
    entry: serviceLossReserve,
    quote: {
      operation,
      modalities: [serviceLossCatalog.modality ?? "mixed"],
      estimatedCredits: serviceLossReserve.reservedCredits,
      pricePolicyVersion: persistedPolicy.version,
      costSource: "price_catalog",
      responsibility: "platform_credits",
    },
    policy: persistedPolicy,
    catalogEntry: serviceLossCatalog,
    replayed: false,
  };
  const serviceLoss = createFakeRepository(
    [serviceLossReserve],
    { loseResponse: true },
  );
  const recoveredServiceTerminal = await settlePlatformOperation(
    serviceLoss.repository,
    serviceLossReservation,
  );
  assert.equal(recoveredServiceTerminal.kind, "settle");
  assert.equal(
    serviceLoss.ledger.filter(
      (entry) => entry.kind === "settle" || entry.kind === "refund",
    ).length,
    1,
  );

  const conflictingLossReserve = fakeReserveEntry(
    persistedPolicy,
    operation,
    fakeUser,
    "cost-beta-service-loss-conflict",
  );
  assert.ok(conflictingLossReserve.reservedCredits);
  const conflictingLoss = createFakeRepository(
    [conflictingLossReserve],
    { loseResponseOnReturn: true },
  );
  conflictingLoss.ledger.push({
    ...conflictingLossReserve,
    id: randomUUID(),
    kind: "refund",
    amount: conflictingLossReserve.reservedCredits,
    reason: "existing conflicting refund",
    idempotencyKey: `${conflictingLossReserve.idempotencyKey}:refund`,
    settledCredits: 0,
    providerCostMinor: 0,
  });
  await assert.rejects(
    settlePlatformOperation(conflictingLoss.repository, {
      entry: conflictingLossReserve,
      quote: {
        operation,
        modalities: [serviceLossCatalog.modality ?? "mixed"],
        estimatedCredits: conflictingLossReserve.reservedCredits,
        pricePolicyVersion: persistedPolicy.version,
        costSource: "price_catalog",
        responsibility: "platform_credits",
      },
      policy: persistedPolicy,
      catalogEntry: serviceLossCatalog,
      replayed: false,
    }),
    /SYNTHETIC_RESPONSE_LOSS_ON_RETURN/,
  );

  // Wrong evidence binding fails closed.
  const bindingReserve = fakeReserveEntry(
    persistedPolicy,
    operation,
    fakeUser,
    "cost-beta-fake-binding",
  );
  const bindingLedger = createFakeRepository([bindingReserve]);
  const bindingReservation = (
    await discoverPendingBillingReservations(bindingLedger.repository, {
      userId: fakeUser,
      billingOperationId: bindingReserve.billingOperationId,
    })
  )[0]!.reservation;
  await assert.rejects(
    reconcilePendingBillingOperation(bindingLedger.repository, {
      userId: fakeUser,
      billingOperationId: bindingReserve.billingOperationId!,
      policy: persistedPolicy,
      lookup: async () => ({
        ...evidenceFor(bindingReservation, "succeeded", "trusted-binding"),
        provider: "forged-provider",
      }),
    }),
    BillingReconciliationError,
  );
  await assert.rejects(
    reconcilePendingBillingOperation(bindingLedger.repository, {
      userId: fakeUser,
      billingOperationId: bindingReserve.billingOperationId!,
      policy: persistedPolicy,
      lookup: async () => ({
        ...evidenceFor(bindingReservation, "succeeded", "trusted-binding"),
        unexpected: "extra",
      }),
    }),
    BillingReconciliationError,
  );

  // Accessors/proxies are rejected without executing any read.
  let accessorReads = 0;
  const accessorEvidence: Record<string, unknown> = {
    ...evidenceFor(bindingReservation, "succeeded", "trusted-accessor"),
  };
  delete accessorEvidence.outcome;
  Object.defineProperty(accessorEvidence, "outcome", {
    enumerable: true,
    configurable: true,
    get: () => {
      accessorReads += 1;
      return "succeeded";
    },
  });
  await assert.rejects(
    reconcilePendingBillingOperation(bindingLedger.repository, {
      userId: fakeUser,
      billingOperationId: bindingReserve.billingOperationId!,
      policy: persistedPolicy,
      lookup: async () => accessorEvidence,
    }),
    BillingReconciliationError,
  );
  assert.equal(accessorReads, 0, "evidence accessors must never execute");

  let proxyReads = 0;
  const proxyEvidence = new Proxy(
    evidenceFor(bindingReservation, "succeeded", "trusted-proxy"),
    {
      get(target, property, receiver) {
        if (property === "then") return undefined;
        proxyReads += 1;
        return Reflect.get(target, property, receiver);
      },
    },
  );
  await assert.rejects(
    reconcilePendingBillingOperation(bindingLedger.repository, {
      userId: fakeUser,
      billingOperationId: bindingReserve.billingOperationId!,
      policy: persistedPolicy,
      lookup: async () => proxyEvidence,
    }),
    BillingReconciliationError,
  );
  assert.equal(proxyReads, 0, "evidence proxies must never execute traps");

  // Concurrent opposite proofs: exactly one terminal; the loser rejects.
  const raceReserve = fakeReserveEntry(
    persistedPolicy,
    operation,
    fakeUser,
    "cost-beta-fake-race",
  );
  const race = createFakeRepository([raceReserve]);
  const raceReservation = (
    await discoverPendingBillingReservations(race.repository, {
      userId: fakeUser,
      billingOperationId: raceReserve.billingOperationId,
    })
  )[0]!.reservation;
  const [settleAttempt, refundAttempt] = await Promise.allSettled([
    reconcilePendingBillingOperation(race.repository, {
      userId: fakeUser,
      billingOperationId: raceReserve.billingOperationId!,
      policy: persistedPolicy,
      lookup: async () =>
        evidenceFor(raceReservation, "succeeded", "trusted-race-settle"),
    }),
    reconcilePendingBillingOperation(race.repository, {
      userId: fakeUser,
      billingOperationId: raceReserve.billingOperationId!,
      policy: persistedPolicy,
      lookup: async () =>
        evidenceFor(
          raceReservation,
          "failed_not_delivered",
          "trusted-race-refund",
        ),
    }),
  ]);
  const raceOutcomes = [settleAttempt, refundAttempt];
  assert.equal(
    raceOutcomes.filter((outcome) => outcome.status === "fulfilled").length,
    1,
    "exactly one opposite proof may win",
  );
  assert.equal(
    raceOutcomes.filter((outcome) => outcome.status === "rejected").length,
    1,
    "the losing opposite proof must reject instead of rewriting the terminal",
  );
  assert.equal(
    race.ledger.filter(
      (entry) => entry.kind === "settle" || entry.kind === "refund",
    ).length,
    1,
    "concurrent opposite proofs must leave exactly one terminal",
  );

  // Fresh repository restart still observes the durable terminals.
  const finalRepository = new LocalAdminRepository(storePath);
  const finalFailureTerminal = (await finalRepository.listLedger(failureUser))
    .find(
      (entry) =>
        entry.billingOperationId === failureReservation.entry.billingOperationId
        && entry.kind === "refund",
    );
  assert.ok(finalFailureTerminal, "durable refund must survive a restart");
  assert.equal(
    finalFailureTerminal.reason,
    PROVIDER_COST_UNKNOWN_PLATFORM_ABSORBED_REASON,
  );
  assert.equal(
    (await finalRepository.listLedger(reconciliationUser)).filter(
      (entry) =>
        entry.billingOperationId === reconciliationReservation.billingOperationId
        && (entry.kind === "settle" || entry.kind === "refund"),
    ).length,
    1,
  );

  // Essential core delivery follows the REAL domain shape: StartResponse /
  // SceneResponse carry `scene`, and the beat graph lives at scene.beats with
  // scene.entryBeatId. Placeholder images without a server image UUID fail and
  // can never be cached. Optional portraits/cards/TTS absence is legitimate.
  const makeChangeSceneChoice = (id = "exit-1") => ({
    id,
    label: "进入下一幕",
    effect: {
      kind: "change-scene",
      nextSceneSeed: "下一幕的种子：走廊尽头传来脚步声。",
    },
  });

  const realCore = {
    sessionId: "s_fixture",
    imageUrl: "https://cdn.fixture.invalid/scene.webp",
    scene: {
      id: "scene-1",
      scenePrompt: "可信的场景提示",
      imageUuid: "8f14e45f-ea4b-4c3f-9f0e-3f4c1c3b2a10",
      imageUrl: "https://cdn.fixture.invalid/scene.webp",
      entryBeatId: "b1",
      beats: [
        {
          id: "b1",
          narration: "仅旁白也可交付",
          next: { type: "continue", nextBeatId: "b2" },
        },
        {
          id: "b2",
          line: "仅台词也可交付",
          next: {
            type: "choice",
            choices: [makeChangeSceneChoice()],
          },
        },
      ],
    },
    characters: [],
  };
  assert.equal(isCostBetaGeneratedCore(realCore), true);
  assert.doesNotThrow(() => assertCostBetaGeneratedCore(realCore));

  const narrationOnlyCore = {
    scene: {
      imageUuid: "8f14e45f-ea4b-4c3f-9f0e-3f4c1c3b2a11",
      imageUrl: "https://cdn.fixture.invalid/narration.webp",
      entryBeatId: "only",
      beats: [{
        id: "only",
        narration: "只有旁白",
        next: {
          type: "choice",
          choices: [makeChangeSceneChoice("only-exit")],
        },
      }],
    },
  };
  assert.equal(isCostBetaGeneratedCore(narrationOnlyCore), true);

  // Multiline narration is legitimate prose. Newline, carriage return and tab
  // must not be mistaken for unsafe control characters.
  const multilineNarrationCore = {
    scene: {
      imageUuid: "8f14e45f-ea4b-4c3f-9f0e-3f4c1c3b2a13",
      imageUrl: "https://cdn.fixture.invalid/multiline.webp",
      entryBeatId: "multi",
      beats: [{
        id: "multi",
        narration: "第一行\n\t第二行\r\n第三行",
        next: {
          type: "choice",
          choices: [makeChangeSceneChoice("multi-exit")],
        },
      }],
    },
  };
  assert.equal(isCostBetaGeneratedCore(multilineNarrationCore), true);

  // Optional TTS audio, character cards and portraits are never required.
  const noOptionalMediaCore = {
    scene: {
      imageUuid: "8f14e45f-ea4b-4c3f-9f0e-3f4c1c3b2a14",
      imageUrl: "https://cdn.fixture.invalid/no-media.webp",
      entryBeatId: "plain",
      beats: [{
        id: "plain",
        narration: "没有语音、卡片或立绘也可以交付",
        next: {
          type: "choice",
          choices: [makeChangeSceneChoice("plain-exit")],
        },
      }],
    },
  };
  assert.equal(isCostBetaGeneratedCore(noOptionalMediaCore), true);

  const placeholderCore = {
    scene: {
      imageUrl: "data:image/webp;base64,PLACEHOLDER",
      entryBeatId: "b1",
      beats: [{
        id: "b1",
        line: "占位文本",
        next: {
          type: "choice",
          choices: [makeChangeSceneChoice()],
        },
      }],
    },
  };
  assert.equal(isCostBetaGeneratedCore(placeholderCore), false);
  assert.throws(
    () => assertCostBetaGeneratedCore(placeholderCore),
    /未通过可信交付校验/,
  );

  // `beats` at the response root (instead of scene.beats) is the wrong shape.
  const topLevelBeatsCore = {
    scene: {
      imageUuid: "8f14e45f-ea4b-4c3f-9f0e-3f4c1c3b2a12",
      imageUrl: "https://cdn.fixture.invalid/scene.webp",
      entryBeatId: "b1",
    },
    beats: [{
      id: "b1",
      line: "错误层级",
      next: {
        type: "choice",
        choices: [makeChangeSceneChoice()],
      },
    }],
  };
  assert.equal(isCostBetaGeneratedCore(topLevelBeatsCore), false);

  const emptyUuidCore = {
    ...realCore,
    scene: { ...realCore.scene, imageUuid: "   " },
  };
  assert.equal(isCostBetaGeneratedCore(emptyUuidCore), false);

  const missingSceneUrlCore = {
    ...realCore,
    scene: { ...realCore.scene, imageUrl: "" },
  };
  assert.equal(isCostBetaGeneratedCore(missingSceneUrlCore), false);

  const emptyBeatsCore = {
    ...realCore,
    scene: { ...realCore.scene, beats: [] },
  };
  assert.equal(isCostBetaGeneratedCore(emptyBeatsCore), false);

  const missingEntryCore = {
    ...realCore,
    scene: { ...realCore.scene, entryBeatId: "absent-beat" },
  };
  assert.equal(isCostBetaGeneratedCore(missingEntryCore), false);

  const duplicateBeatCore = {
    ...realCore,
    scene: {
      ...realCore.scene,
      beats: [
        {
          id: "dup",
          narration: "一",
          next: {
            type: "choice",
            choices: [makeChangeSceneChoice("dup-exit-1")],
          },
        },
        {
          id: "dup",
          line: "二",
          next: {
            type: "choice",
            choices: [makeChangeSceneChoice("dup-exit-2")],
          },
        },
      ],
      entryBeatId: "dup",
    },
  };
  assert.equal(isCostBetaGeneratedCore(duplicateBeatCore), false);

  const brokenGraphCore = {
    ...realCore,
    scene: {
      ...realCore.scene,
      beats: [{
        id: "b1",
        narration: "图断裂",
        next: { type: "continue", nextBeatId: "does-not-exist" },
      }],
      entryBeatId: "b1",
    },
  };
  assert.equal(isCostBetaGeneratedCore(brokenGraphCore), false);

  const danglingAdvanceTargetCore = {
    ...realCore,
    scene: {
      ...realCore.scene,
      beats: [{
        id: "b1",
        narration: "选项指向不存在的节拍",
        next: {
          type: "choice",
          choices: [{
            id: "dangling-advance",
            label: "去不存在的地方",
            effect: { kind: "advance-beat", targetBeatId: "ghost" },
          }],
        },
      }],
      entryBeatId: "b1",
    },
  };
  assert.equal(isCostBetaGeneratedCore(danglingAdvanceTargetCore), false);

  // A choice branch with no options is not a usable terminal state.
  const emptyChoicesCore = {
    ...realCore,
    scene: {
      ...realCore.scene,
      beats: [{
        id: "b1",
        narration: "没有可选项",
        next: { type: "choice", choices: [] },
      }],
      entryBeatId: "b1",
    },
  };
  assert.equal(isCostBetaGeneratedCore(emptyChoicesCore), false);

  const blankChoiceLabelCore = {
    ...realCore,
    scene: {
      ...realCore.scene,
      beats: [{
        id: "b1",
        narration: "选项标签为空",
        next: {
          type: "choice",
          choices: [{
            id: "blank-label",
            label: "   ",
            effect: {
              kind: "change-scene",
              nextSceneSeed: "有效种子",
            },
          }],
        },
      }],
      entryBeatId: "b1",
    },
  };
  assert.equal(isCostBetaGeneratedCore(blankChoiceLabelCore), false);

  const blankSceneSeedCore = {
    ...realCore,
    scene: {
      ...realCore.scene,
      beats: [{
        id: "b1",
        narration: "换幕种子为空",
        next: {
          type: "choice",
          choices: [{
            id: "blank-seed",
            label: "进入下一幕",
            effect: { kind: "change-scene", nextSceneSeed: "   " },
          }],
        },
      }],
      entryBeatId: "b1",
    },
  };
  assert.equal(isCostBetaGeneratedCore(blankSceneSeedCore), false);

  // The scene must expose a change-scene exit reachable from the entry beat.
  const noReachableExitCore = {
    ...realCore,
    scene: {
      ...realCore.scene,
      beats: [
        {
          id: "b1",
          narration: "只能跳到下一拍",
          next: {
            type: "choice",
            choices: [{
              id: "to-b2",
              label: "下一拍",
              effect: { kind: "advance-beat", targetBeatId: "b2" },
            }],
          },
        },
        {
          id: "b2",
          narration: "仍然没有出口",
          next: {
            type: "choice",
            choices: [{
              id: "back-to-b1",
              label: "回到上一拍",
              effect: { kind: "advance-beat", targetBeatId: "b1" },
            }],
          },
        },
      ],
      entryBeatId: "b1",
    },
  };
  assert.equal(isCostBetaGeneratedCore(noReachableExitCore), false);

  const unreachableExitCore = {
    ...realCore,
    scene: {
      ...realCore.scene,
      beats: [
        {
          id: "b1",
          narration: "入口只有回到自身的选择",
          next: {
            type: "choice",
            choices: [{
              id: "self-loop",
              label: "回到自身",
              effect: { kind: "advance-beat", targetBeatId: "b1" },
            }],
          },
        },
        {
          id: "island",
          narration: "这一拍有换幕出口，但入口到不了",
          next: {
            type: "choice",
            choices: [makeChangeSceneChoice("island-exit")],
          },
        },
      ],
      entryBeatId: "b1",
    },
  };
  assert.equal(isCostBetaGeneratedCore(unreachableExitCore), false);

  const unsafeIdentifierCore = {
    ...realCore,
    scene: {
      ...realCore.scene,
      beats: [{
        id: "bad\nid",
        narration: "标识符必须严格",
        next: {
          type: "choice",
          choices: [makeChangeSceneChoice("safe-exit")],
        },
      }],
      entryBeatId: "bad\nid",
    },
  };
  assert.equal(isCostBetaGeneratedCore(unsafeIdentifierCore), false);

  const blankTextCore = {
    ...realCore,
    scene: {
      ...realCore.scene,
      beats: [{
        id: "b1",
        narration: "   ",
        line: "",
        next: {
          type: "choice",
          choices: [makeChangeSceneChoice()],
        },
      }],
      entryBeatId: "b1",
    },
  };
  assert.equal(isCostBetaGeneratedCore(blankTextCore), false);
  assert.throws(
    () => assertCostBetaGeneratedCore(blankTextCore),
    /未通过可信交付校验/,
  );

  assert.equal(fetchCalls, 0, "no script path may reach the network");
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
  for (const [key, value] of [
    [COST_BETA_PRICING_MODE_ENV, previousCostBetaMode],
    [COST_BETA_PRICING_VERSION_ENV, previousCostBetaVersion],
    [FIXED_BETA_PRICING_MODE_ENV, previousFixedMode],
    [FIXED_BETA_PRICING_VERSION_ENV, previousFixedVersion],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.fetch = originalFetch;
  await rm(root, { recursive: true, force: true });
}

console.log("cost beta v2 reconciliation tests passed");
