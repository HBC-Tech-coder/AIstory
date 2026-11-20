import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { types as utilTypes } from "node:util";

import type { AdminRepository } from "@/lib/admin/repositories";
import type {
  BillingPolicy,
  PriceCatalogEntry,
  ServerCreditLedgerEntry,
} from "@/lib/admin/types";
import {
  assertCostBetaPricingPolicy,
  COST_BETA_PRICING_MODE,
  COST_BETA_PRICING_VERSION_PREFIX,
  isCostBetaPricingVersion,
} from "@/lib/billing/costBetaPricing";

/**
 * Server-only reconciliation for platform generation reservations.
 *
 * The durable credit ledger is the only source of the frozen reservation. A
 * caller may scope the query with `userId` + `billingOperationId`, but a
 * client-supplied reservation object is never trusted. Completion evidence
 * comes from an injected, trusted internal lookup and is bound byte-for-byte
 * to that frozen reservation before any terminal is written.
 *
 * Owner policy for exact bounded cost_beta_credit_v2 operations:
 * - a trusted `succeeded` completion settles the original reserved credits;
 * - a trusted `failed_not_delivered` completion refunds the user even when the
 *   provider MAY have charged; the platform absorbs the bounded test loss and
 *   the ledger keeps `costSource=price_catalog` with an explicit
 *   `provider_cost_unknown_platform_absorbed` label. No provider settlement
 *   receipt or "provider is free" claim is ever fabricated;
 * - `unknown`, missing or throwing evidence leaves the reservation pending.
 *   Age alone never authorizes a refund.
 */

export const PROVIDER_COST_UNKNOWN_PLATFORM_ABSORBED_REASON =
  "provider_cost_unknown_platform_absorbed";

const RESERVE_REASON_PREFIX = "Platform generation reserve: ";
const OPERATION_PATTERN = /^[A-Za-z0-9._-]{1,80}$/;
const MAX_PLAIN_DEPTH = 12;
const MAX_PLAIN_ARRAY_LENGTH = 4_096;
const MAX_ID_LENGTH = 200;
const MAX_EVIDENCE_ID_LENGTH = 160;

export class BillingReconciliationError extends Error {
  readonly code = "BILLING_RECONCILIATION_INVALID";

  constructor(message = "计费对账证据无效，已拒绝写入终态。") {
    super(message);
    this.name = "BillingReconciliationError";
  }
}

type PlainReadResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false };

function isPlainDataRecord(value: unknown): value is Record<string, unknown> {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && !utilTypes.isProxy(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.getOwnPropertySymbols(value).length === 0;
}

/**
 * Deep-copies plain JSON-like data using property descriptors, so accessors
 * are rejected instead of executed and proxies are rejected before any trap.
 * Anything that cannot be proven plain fails closed (`ok: false`).
 */
function readPlainData(value: unknown, depth: number): PlainReadResult {
  if (depth > MAX_PLAIN_DEPTH) return { ok: false };
  if (value === null) return { ok: true, value: null };
  if (
    typeof value === "string"
    || typeof value === "boolean"
    || typeof value === "undefined"
  ) {
    return { ok: true, value };
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? { ok: true, value } : { ok: false };
  }
  if (typeof value !== "object") return { ok: false };
  if (utilTypes.isProxy(value)) return { ok: false };
  if (Array.isArray(value)) {
    if (value.length > MAX_PLAIN_ARRAY_LENGTH) return { ok: false };
    if (Object.getOwnPropertySymbols(value).length !== 0) return { ok: false };
    const output: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        return { ok: false };
      }
      const child = readPlainData(descriptor.value, depth + 1);
      if (!child.ok) return child;
      output.push(child.value);
    }
    for (const key of Object.keys(value)) {
      if (!/^(?:0|[1-9][0-9]*)$/.test(key)) return { ok: false };
    }
    return { ok: true, value: output };
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) return { ok: false };
  if (Object.getOwnPropertySymbols(value).length !== 0) return { ok: false };
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(descriptors)) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      return { ok: false };
    }
    const child = readPlainData(descriptor.value, depth + 1);
    if (!child.ok) return child;
    output[key] = child.value;
  }
  return { ok: true, value: output };
}

function safeIsCostBetaPricingVersion(value: string): boolean {
  try {
    return isCostBetaPricingVersion(value);
  } catch {
    return false;
  }
}

export type CostBetaPolicyInspection =
  | { readonly mode: "legacy" }
  | { readonly mode: "cost_beta_credit_v2"; readonly policy: BillingPolicy }
  | { readonly mode: "invalid"; readonly message: string }
  | { readonly mode: "unreadable" };

/**
 * Classifies a policy candidate without executing accessors/proxies.
 *
 * "legacy" means neither the version nor any catalog entry claims the v2
 * contract, so the unchanged provider_cost_v1 / fixed_beta_credit_v1 path
 * applies. A v2 version prefix alone is never approval: the whole policy is
 * asserted against the v2 contract. Any partial/malformed v2 claim fails
 * closed instead of silently degrading to provider-cost pricing.
 */
export function inspectCostBetaPolicyCandidate(
  value: unknown,
): CostBetaPolicyInspection {
  const plain = readPlainData(value, 0);
  if (!plain.ok) return { mode: "unreadable" };
  const plainValue = plain.value;
  if (!isPlainDataRecord(plainValue)) return { mode: "unreadable" };
  const record = plainValue;
  const version = record.version;
  const entries = record.entries;
  if (typeof version !== "string" || !Array.isArray(entries)) {
    return { mode: "unreadable" };
  }
  const versionIntent = version.startsWith(COST_BETA_PRICING_VERSION_PREFIX);
  const versionIsBeta = versionIntent && safeIsCostBetaPricingVersion(version);
  let hasBetaEntry = false;
  for (const entry of entries) {
    if (isPlainDataRecord(entry) && entry.pricingMode === COST_BETA_PRICING_MODE) {
      hasBetaEntry = true;
      break;
    }
  }
  if (!versionIntent && !hasBetaEntry) return { mode: "legacy" };
  if (!versionIsBeta || !hasBetaEntry) {
    return {
      mode: "invalid",
      message: "成本 β 定价版本与价目模式不一致，未发起任何模型调用。",
    };
  }
  try {
    assertCostBetaPricingPolicy(plainValue as BillingPolicy);
  } catch {
    return {
      mode: "invalid",
      message: "成本 β 定价合同校验失败，未发起任何模型调用。",
    };
  }
  return {
    mode: "cost_beta_credit_v2",
    policy: plainValue as BillingPolicy,
  };
}

export type CapturedBillingReservation = {
  entry: ServerCreditLedgerEntry;
  quote: {
    operation: string;
    estimatedCredits: number;
    pricePolicyVersion: string;
  };
  policy: BillingPolicy;
  catalogEntry: PriceCatalogEntry;
};

export type CostBetaReservationInspection =
  | { readonly mode: "legacy" }
  | {
    readonly mode: "cost_beta_credit_v2";
    readonly policy: BillingPolicy;
    readonly catalogEntry: PriceCatalogEntry;
    readonly reservedCredits: number;
  }
  | { readonly mode: "invalid"; readonly message: string };

/**
 * Validates a captured v2 reservation snapshot without requiring the live
 * activation kill switch. Terminals and trusted failure markers must keep
 * working after activation is turned off, but only for the exact captured
 * policy content that was reserved.
 */
export function inspectCapturedCostBetaReservation(
  reservation: CapturedBillingReservation,
): CostBetaReservationInspection {
  const policyInspection = inspectCostBetaPolicyCandidate(reservation.policy);
  if (policyInspection.mode === "legacy") return { mode: "legacy" };
  if (policyInspection.mode !== "cost_beta_credit_v2") {
    return {
      mode: "invalid",
      message: "成本 β 计费预留快照无效，未发起任何模型调用。",
    };
  }
  try {
    const policy = policyInspection.policy;
    const catalogEntry = reservation.catalogEntry;
    const quote = reservation.quote;
    const ledgerEntry = reservation.entry;
    if (
      !catalogEntry
      || !quote
      || !ledgerEntry
      || quote.pricePolicyVersion !== policy.version
      || ledgerEntry.pricePolicyVersion !== policy.version
      || ledgerEntry.costSource !== "price_catalog"
      || ledgerEntry.kind !== "reserve"
      || catalogEntry.operation !== quote.operation
      || catalogEntry.pricingMode !== COST_BETA_PRICING_MODE
      || catalogEntry.enabled !== true
      || !Number.isSafeInteger(catalogEntry.fixedCredits)
      || (catalogEntry.fixedCredits ?? 0) <= 0
      || !Number.isSafeInteger(quote.estimatedCredits)
      || quote.estimatedCredits <= 0
      || catalogEntry.fixedCredits !== quote.estimatedCredits
      || ledgerEntry.reservedCredits !== quote.estimatedCredits
      || ledgerEntry.amount !== -quote.estimatedCredits
      || ledgerEntry.provider !== catalogEntry.provider
      || ledgerEntry.model !== catalogEntry.model
      || ledgerEntry.providerCostMinor !== catalogEntry.providerCostMinor
      || ledgerEntry.providerCurrency !== policy.providerCurrency
      || ledgerEntry.providerMinorUnitScale !== policy.providerMinorUnitScale
    ) {
      return {
        mode: "invalid",
        message: "成本 β 计费预留快照不一致，未发起任何模型调用。",
      };
    }
    const policyEntry = policy.entries.find(
      (entry) => entry.operation === catalogEntry.operation,
    );
    if (
      !policyEntry
      || policyEntry.enabled !== true
      || policyEntry.pricingMode !== COST_BETA_PRICING_MODE
      || policyEntry.provider !== catalogEntry.provider
      || policyEntry.model !== catalogEntry.model
      || policyEntry.fixedCredits !== catalogEntry.fixedCredits
      || policyEntry.providerCostMinor !== catalogEntry.providerCostMinor
      || !Number.isSafeInteger(policyEntry.fixedCredits)
      || (policyEntry.fixedCredits ?? 0) <= 0
    ) {
      return {
        mode: "invalid",
        message: "成本 β 计费预留与定价快照不一致，未发起任何模型调用。",
      };
    }
    return {
      mode: "cost_beta_credit_v2",
      policy,
      catalogEntry,
      reservedCredits: quote.estimatedCredits,
    };
  } catch {
    return {
      mode: "invalid",
      message: "成本 β 计费预留快照无效，未发起任何模型调用。",
    };
  }
}

const TERMINAL_INTENT_FIELDS = [
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
  "settledCredits",
] as const satisfies ReadonlyArray<keyof ServerCreditLedgerEntry>;

/**
 * Structural terminal-intent equality. `id`/`createdAt` are persistence
 * details; every billing-relevant field must match before a response-loss
 * recovery may reuse an existing terminal.
 */
export function isSameBillingTerminalIntent(
  actual: ServerCreditLedgerEntry | undefined,
  expected: ServerCreditLedgerEntry,
): boolean {
  if (!actual) return false;
  return TERMINAL_INTENT_FIELDS.every(
    (field) => actual[field] === expected[field],
  );
}

export type FrozenBillingReservation = Readonly<{
  reservationId: string;
  billingOperationId: string;
  accountId: string;
  userId: string;
  tenantId: string;
  provider: string;
  model: string;
  pricePolicyVersion: string;
  modality: ServerCreditLedgerEntry["modality"];
  reservedCredits: number;
  providerCostMinor: number;
  providerCurrency: string;
  providerMinorUnitScale: number;
  costSource: "price_catalog";
  idempotencyKey: string;
}>;

export type BillingCompletionOutcome =
  | "succeeded"
  | "failed_not_delivered"
  | "unknown";

export type BillingCompletionEvidence = Readonly<{
  reservationId: string;
  billingOperationId: string;
  accountId: string;
  userId: string;
  tenantId: string;
  provider: string;
  model: string;
  pricePolicyVersion: string;
  outcome: BillingCompletionOutcome;
  scope: "whole_operation";
  evidenceId: string;
}>;

/**
 * Trusted internal completion lookup seam. It receives the exact, frozen
 * durable reservation descriptor and must return evidence bound to it. The
 * lookup is injected by internal callers only; there is no public route, and
 * no provider lookup is performed by this module.
 */
export type BillingCompletionLookup = (
  reservation: FrozenBillingReservation,
) => Promise<unknown>;

export type DiscoveredPendingBillingReservation = Readonly<{
  reservation: FrozenBillingReservation;
  costBeta: boolean;
}>;

export type BillingReconciliationPendingReason =
  | "legacy_policy"
  | "completion_unknown"
  | "completion_evidence_missing"
  | "completion_lookup_unavailable";

export type BillingReconciliationResult =
  | {
    readonly status: "pending";
    readonly reason: BillingReconciliationPendingReason;
    readonly reservation: FrozenBillingReservation;
  }
  | {
    readonly status: "settled";
    readonly reservation: FrozenBillingReservation;
    readonly entry: ServerCreditLedgerEntry;
    readonly replayed: boolean;
  }
  | {
    readonly status: "refunded";
    readonly reservation: FrozenBillingReservation;
    readonly entry: ServerCreditLedgerEntry;
    readonly replayed: boolean;
  };

function isSafeBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function operationFromReserveReason(reason: string | undefined): string | undefined {
  if (typeof reason !== "string" || !reason.startsWith(RESERVE_REASON_PREFIX)) {
    return undefined;
  }
  const operation = reason.slice(RESERVE_REASON_PREFIX.length);
  return OPERATION_PATTERN.test(operation) ? operation : undefined;
}

function buildFrozenReservation(
  entry: ServerCreditLedgerEntry,
): FrozenBillingReservation | undefined {
  const reservationId = entry.id;
  const billingOperationId = entry.billingOperationId;
  const accountId = entry.accountId;
  const userId = entry.userId;
  const tenantId = entry.tenantId;
  const provider = entry.provider;
  const model = entry.model;
  const pricePolicyVersion = entry.pricePolicyVersion;
  const idempotencyKey = entry.idempotencyKey;
  const providerCurrency = entry.providerCurrency;
  const reservedCredits = entry.reservedCredits;
  const providerCostMinor = entry.providerCostMinor;
  const providerMinorUnitScale = entry.providerMinorUnitScale;
  if (
    entry.kind !== "reserve"
    || !isSafeBoundedString(reservationId, MAX_ID_LENGTH)
    || !isSafeBoundedString(billingOperationId, MAX_ID_LENGTH)
    || !isSafeBoundedString(accountId, MAX_ID_LENGTH)
    || !isSafeBoundedString(userId, MAX_ID_LENGTH)
    || !isSafeBoundedString(tenantId, MAX_ID_LENGTH)
    || !isSafeBoundedString(provider, MAX_ID_LENGTH)
    || !isSafeBoundedString(model, MAX_ID_LENGTH)
    || !isSafeBoundedString(pricePolicyVersion, MAX_ID_LENGTH)
    || !isSafeBoundedString(idempotencyKey, MAX_ID_LENGTH)
    || !isSafeBoundedString(providerCurrency, 32)
    || typeof reservedCredits !== "number"
    || !Number.isSafeInteger(reservedCredits)
    || reservedCredits <= 0
    || entry.amount !== -reservedCredits
    || typeof providerCostMinor !== "number"
    || !Number.isSafeInteger(providerCostMinor)
    || providerCostMinor < 0
    || typeof providerMinorUnitScale !== "number"
    || !Number.isSafeInteger(providerMinorUnitScale)
    || providerMinorUnitScale < 0
    || entry.costSource !== "price_catalog"
  ) {
    return undefined;
  }
  return Object.freeze({
    reservationId,
    billingOperationId,
    accountId,
    userId,
    tenantId,
    provider,
    model,
    pricePolicyVersion,
    modality: entry.modality,
    reservedCredits,
    providerCostMinor,
    providerCurrency,
    providerMinorUnitScale,
    costSource: "price_catalog",
    idempotencyKey,
  });
}

function isTerminalEntry(entry: ServerCreditLedgerEntry): boolean {
  return entry.kind === "settle" || entry.kind === "refund";
}

function scopedLedgerEntries(
  entries: ServerCreditLedgerEntry[],
  userId: string,
  billingOperationId?: string,
): ServerCreditLedgerEntry[] {
  return entries.filter(
    (entry) => entry.userId === userId
      && (billingOperationId === undefined
        || entry.billingOperationId === billingOperationId),
  );
}

/**
 * Lists pending (reserve-only) operations for one durable user scope.
 * Duplicate reserves/terminals and malformed binding snapshots fail closed.
 */
export async function discoverPendingBillingReservations(
  repository: AdminRepository,
  input: { userId: string; billingOperationId?: string },
): Promise<DiscoveredPendingBillingReservation[]> {
  if (!isSafeBoundedString(input.userId, MAX_ID_LENGTH)) {
    throw new BillingReconciliationError("用户范围无效，未读取任何账本。");
  }
  if (
    input.billingOperationId !== undefined
    && !isSafeBoundedString(input.billingOperationId, MAX_ID_LENGTH)
  ) {
    throw new BillingReconciliationError("计费操作范围无效，未读取任何账本。");
  }
  const ledger = await repository.listLedger(input.userId);
  const scoped = scopedLedgerEntries(ledger, input.userId, input.billingOperationId);
  const groups = new Map<string, ServerCreditLedgerEntry[]>();
  for (const entry of scoped) {
    const operationId = entry.billingOperationId;
    if (!operationId) continue;
    const group = groups.get(operationId);
    if (group) group.push(entry);
    else groups.set(operationId, [entry]);
  }
  const discovered: DiscoveredPendingBillingReservation[] = [];
  for (const group of groups.values()) {
    const reserves = group.filter((entry) => entry.kind === "reserve");
    const terminals = group.filter(isTerminalEntry);
    if (reserves.length > 1 || terminals.length > 1) {
      throw new BillingReconciliationError("账本存在重复计费条目，已拒绝推断终态。");
    }
    if (reserves.length !== 1 || terminals.length !== 0) continue;
    const reservation = buildFrozenReservation(reserves[0]!);
    if (!reservation) {
      throw new BillingReconciliationError("计费预留快照无效，已拒绝推断终态。");
    }
    discovered.push({
      reservation,
      costBeta: safeIsCostBetaPricingVersion(reservation.pricePolicyVersion),
    });
  }
  return discovered;
}

const EVIDENCE_BINDING_FIELDS = [
  "reservationId",
  "billingOperationId",
  "accountId",
  "userId",
  "tenantId",
  "provider",
  "model",
  "pricePolicyVersion",
] as const;

const EVIDENCE_KEYS: readonly string[] = [
  ...EVIDENCE_BINDING_FIELDS,
  "outcome",
  "scope",
  "evidenceId",
].sort();

function readCompletionEvidence(
  raw: unknown,
  reservation: FrozenBillingReservation,
): BillingCompletionEvidence {
  const plain = readPlainData(raw, 0);
  if (!plain.ok) {
    throw new BillingReconciliationError("对账证据格式无效，已拒绝写入终态。");
  }
  const plainValue = plain.value;
  if (!isPlainDataRecord(plainValue)) {
    throw new BillingReconciliationError("对账证据格式无效，已拒绝写入终态。");
  }
  const record = plainValue;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== EVIDENCE_KEYS.length
    || keys.some((key, index) => key !== EVIDENCE_KEYS[index])
  ) {
    throw new BillingReconciliationError("对账证据字段集无效，已拒绝写入终态。");
  }
  for (const field of EVIDENCE_BINDING_FIELDS) {
    if (!isSafeBoundedString(record[field], MAX_ID_LENGTH)) {
      throw new BillingReconciliationError("对账证据绑定字段无效，已拒绝写入终态。");
    }
    if (record[field] !== reservation[field]) {
      throw new BillingReconciliationError("对账证据与预留绑定不一致，已拒绝写入终态。");
    }
  }
  if (record.scope !== "whole_operation") {
    throw new BillingReconciliationError("对账证据范围无效，已拒绝写入终态。");
  }
  const outcome = record.outcome;
  if (
    outcome !== "succeeded"
    && outcome !== "failed_not_delivered"
    && outcome !== "unknown"
  ) {
    throw new BillingReconciliationError("对账结论无效，已拒绝写入终态。");
  }
  const evidenceId = record.evidenceId;
  if (!isSafeBoundedString(evidenceId, MAX_EVIDENCE_ID_LENGTH)) {
    throw new BillingReconciliationError("对账证据标识无效，已拒绝写入终态。");
  }
  return Object.freeze({
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
  });
}

function completionEvidenceDigest(evidence: BillingCompletionEvidence): string {
  return createHash("sha256")
    .update("aistory.billing-reconciliation.v1\0", "utf8")
    .update([
      evidence.reservationId,
      evidence.billingOperationId,
      evidence.accountId,
      evidence.userId,
      evidence.tenantId,
      evidence.provider,
      evidence.model,
      evidence.pricePolicyVersion,
      evidence.outcome,
      evidence.scope,
      evidence.evidenceId,
    ].join("\0"), "utf8")
    .digest("hex");
}

function buildReconciliationTerminal(
  reservation: FrozenBillingReservation,
  operation: string,
  evidence: BillingCompletionEvidence,
): ServerCreditLedgerEntry {
  const settled = evidence.outcome === "succeeded";
  const digest = completionEvidenceDigest(evidence);
  const reason = settled
    ? `Platform generation settled: ${operation} evidence=${digest}`
    : `${PROVIDER_COST_UNKNOWN_PLATFORM_ABSORBED_REASON}:${digest}`;
  const terminalKind = settled ? "settle" : "refund";
  return {
    id: randomUUID(),
    accountId: reservation.accountId,
    tenantId: reservation.tenantId,
    userId: reservation.userId,
    kind: terminalKind,
    amount: settled ? 0 : reservation.reservedCredits,
    reason: reason.slice(0, 300),
    idempotencyKey: `${reservation.idempotencyKey}:${terminalKind}`,
    billingOperationId: reservation.billingOperationId,
    modality: reservation.modality,
    provider: reservation.provider,
    model: reservation.model,
    pricePolicyVersion: reservation.pricePolicyVersion,
    costSource: "price_catalog",
    providerCurrency: reservation.providerCurrency,
    // The catalog metadata is retained as-is. This is explicitly *not* a
    // provider settlement receipt: 0 would fabricate proof that the vendor
    // was free, which the platform cannot know on a failed delivery.
    providerCostMinor: reservation.providerCostMinor,
    providerMinorUnitScale: reservation.providerMinorUnitScale,
    reservedCredits: reservation.reservedCredits,
    settledCredits: settled ? reservation.reservedCredits : 0,
    createdAt: new Date().toISOString(),
  };
}

function terminalResult(
  reservation: FrozenBillingReservation,
  persisted: ServerCreditLedgerEntry,
  intended: ServerCreditLedgerEntry,
): Exclude<BillingReconciliationResult, { status: "pending" }> {
  return persisted.kind === "settle"
    ? {
      status: "settled",
      reservation,
      entry: persisted,
      replayed: persisted.id !== intended.id,
    }
    : {
      status: "refunded",
      reservation,
      entry: persisted,
      replayed: persisted.id !== intended.id,
    };
}

function assertTerminalMatchesIntent(
  persisted: ServerCreditLedgerEntry,
  intended: ServerCreditLedgerEntry,
): void {
  if (
    persisted.kind !== intended.kind
    || !isSameBillingTerminalIntent(persisted, intended)
  ) {
    throw new BillingReconciliationError(
      "计费终态与对账证据冲突，已拒绝覆盖既有终态。",
    );
  }
}

/**
 * Proves that a durable terminal is structurally consistent with its frozen
 * reservation. Used when completion evidence is unknown/unavailable but a
 * terminal already exists: report that real terminal (never a misleading
 * "pending") while refusing to accept a malformed/foreign entry.
 */
function assertPersistedTerminalStructurallyValid(
  persisted: ServerCreditLedgerEntry,
  reservation: FrozenBillingReservation,
): void {
  const settled = persisted.kind === "settle";
  if (
    (!settled && persisted.kind !== "refund")
    || persisted.accountId !== reservation.accountId
    || persisted.tenantId !== reservation.tenantId
    || persisted.userId !== reservation.userId
    || persisted.billingOperationId !== reservation.billingOperationId
    || persisted.idempotencyKey
      !== `${reservation.idempotencyKey}:${persisted.kind}`
    || persisted.modality !== reservation.modality
    || persisted.provider !== reservation.provider
    || persisted.model !== reservation.model
    || persisted.pricePolicyVersion !== reservation.pricePolicyVersion
    || (
      persisted.costSource !== "price_catalog"
      && persisted.costSource !== "provider_settlement"
    )
    || persisted.providerCurrency !== reservation.providerCurrency
    || typeof persisted.providerCostMinor !== "number"
    || !Number.isSafeInteger(persisted.providerCostMinor)
    || persisted.providerCostMinor < 0
    || (
      persisted.costSource === "price_catalog"
      && persisted.providerCostMinor !== reservation.providerCostMinor
    )
    || persisted.providerMinorUnitScale !== reservation.providerMinorUnitScale
    || persisted.reservedCredits !== reservation.reservedCredits
    || persisted.amount !== (settled ? 0 : reservation.reservedCredits)
    || persisted.settledCredits
      !== (settled ? reservation.reservedCredits : 0)
  ) {
    throw new BillingReconciliationError(
      "既有计费终态与预留结构不一致，已拒绝推断终态。",
    );
  }
}

function adoptPersistedTerminal(
  reservation: FrozenBillingReservation,
  persisted: ServerCreditLedgerEntry,
): BillingReconciliationResult {
  assertPersistedTerminalStructurallyValid(persisted, reservation);
  return persisted.kind === "settle"
    ? {
      status: "settled",
      reservation,
      entry: persisted,
      replayed: true,
    }
    : {
      status: "refunded",
      reservation,
      entry: persisted,
      replayed: true,
    };
}

async function appendReconciliationTerminal(
  repository: AdminRepository,
  userId: string,
  intended: ServerCreditLedgerEntry,
  reservation: FrozenBillingReservation,
): Promise<BillingReconciliationResult> {
  let persisted: ServerCreditLedgerEntry;
  try {
    persisted = await repository.appendBillingTerminal(intended);
  } catch (error) {
    // Read-after-uncertain-write: the atomic RPC may have committed before the
    // response was lost. Only an exact same-intent durable terminal may be
    // adopted; an opposite/conflicting terminal must never be manufactured.
    let reread: ServerCreditLedgerEntry[];
    try {
      reread = await repository.listLedger(userId);
    } catch {
      throw error;
    }
    const terminals = scopedLedgerEntries(
      reread,
      userId,
      intended.billingOperationId,
    ).filter(isTerminalEntry);
    if (terminals.length !== 1) throw error;
    const recovered = terminals[0]!;
    assertTerminalMatchesIntent(recovered, intended);
    return { ...terminalResult(reservation, recovered, intended), replayed: true };
  }
  assertTerminalMatchesIntent(persisted, intended);
  return terminalResult(reservation, persisted, intended);
}

/**
 * Reconciles one durable pending operation against trusted internal completion
 * evidence. `policy` is the captured historical v2 policy (full content), never
 * the current price list; it is validated and must match the persisted version
 * and binding. Legacy pending reservations are returned unchanged.
 */
export async function reconcilePendingBillingOperation(
  repository: AdminRepository,
  input: {
    userId: string;
    billingOperationId: string;
    policy: BillingPolicy;
    lookup: BillingCompletionLookup;
  },
): Promise<BillingReconciliationResult> {
  if (!isSafeBoundedString(input.userId, MAX_ID_LENGTH)) {
    throw new BillingReconciliationError("用户范围无效，未读取任何账本。");
  }
  if (!isSafeBoundedString(input.billingOperationId, MAX_ID_LENGTH)) {
    throw new BillingReconciliationError("计费操作范围无效，未读取任何账本。");
  }
  if (typeof input.lookup !== "function") {
    throw new BillingReconciliationError("对账查询能力缺失，已拒绝推断终态。");
  }
  const ledger = await repository.listLedger(input.userId);
  const group = scopedLedgerEntries(
    ledger,
    input.userId,
    input.billingOperationId,
  );
  const reserves = group.filter((entry) => entry.kind === "reserve");
  const terminals = group.filter(isTerminalEntry);
  if (reserves.length !== 1 || terminals.length > 1) {
    throw new BillingReconciliationError("账本计费条目缺失或重复，已拒绝推断终态。");
  }
  const reservation = buildFrozenReservation(reserves[0]!);
  if (!reservation) {
    throw new BillingReconciliationError("计费预留快照无效，已拒绝推断终态。");
  }
  if (!safeIsCostBetaPricingVersion(reservation.pricePolicyVersion)) {
    // Legacy provider-cost / fixed-beta v1 semantics are unchanged.
    return { status: "pending", reason: "legacy_policy", reservation };
  }
  const policyInspection = inspectCostBetaPolicyCandidate(input.policy);
  if (policyInspection.mode !== "cost_beta_credit_v2") {
    throw new BillingReconciliationError("历史成本 β 定价策略无效，已拒绝推断终态。");
  }
  const policy = policyInspection.policy;
  if (policy.version !== reservation.pricePolicyVersion) {
    throw new BillingReconciliationError("历史定价版本与预留不一致，已拒绝推断终态。");
  }
  if (
    policy.providerCurrency !== reservation.providerCurrency
    || policy.providerMinorUnitScale !== reservation.providerMinorUnitScale
  ) {
    throw new BillingReconciliationError("历史定价币种与预留不一致，已拒绝推断终态。");
  }
  const operation = operationFromReserveReason(reserves[0]!.reason);
  if (!operation) {
    throw new BillingReconciliationError("预留操作标识无效，已拒绝推断终态。");
  }
  const policyEntry = policy.entries.find(
    (entry) => entry.operation === operation,
  );
  if (
    !policyEntry
    || policyEntry.enabled !== true
    || policyEntry.pricingMode !== COST_BETA_PRICING_MODE
    || policyEntry.provider !== reservation.provider
    || policyEntry.model !== reservation.model
    || policyEntry.fixedCredits !== reservation.reservedCredits
    || policyEntry.providerCostMinor !== reservation.providerCostMinor
  ) {
    throw new BillingReconciliationError("历史定价绑定与预留不一致，已拒绝推断终态。");
  }
  const existingTerminal = terminals.length === 1 ? terminals[0] : undefined;
  let rawEvidence: unknown;
  try {
    rawEvidence = await input.lookup(reservation);
  } catch {
    // A durable terminal is already the mutation authority. Do not misreport
    // its existence as "pending" merely because the lookup is unavailable.
    if (existingTerminal) {
      return adoptPersistedTerminal(reservation, existingTerminal);
    }
    return {
      status: "pending",
      reason: "completion_lookup_unavailable",
      reservation,
    };
  }
  if (rawEvidence === undefined || rawEvidence === null) {
    if (existingTerminal) {
      return adoptPersistedTerminal(reservation, existingTerminal);
    }
    return { status: "pending", reason: "completion_evidence_missing", reservation };
  }
  const evidence = readCompletionEvidence(rawEvidence, reservation);
  if (evidence.outcome === "unknown") {
    // Unknown evidence never replaces or hides an already-durable terminal.
    if (existingTerminal) {
      return adoptPersistedTerminal(reservation, existingTerminal);
    }
    return { status: "pending", reason: "completion_unknown", reservation };
  }
  const intended = buildReconciliationTerminal(reservation, operation, evidence);
  if (existingTerminal) {
    // Definitive (possibly conflicting) proof is still checked against the
    // durable terminal; conflict rejects and the terminal is never replaced.
    assertTerminalMatchesIntent(existingTerminal, intended);
    return terminalResult(reservation, existingTerminal, intended);
  }
  return appendReconciliationTerminal(repository, input.userId, intended, reservation);
}
