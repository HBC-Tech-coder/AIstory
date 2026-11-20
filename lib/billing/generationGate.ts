import "server-only";

import { NextResponse } from "next/server";

import { getAdminRepository } from "@/lib/admin/service";
import type { AdminRepository } from "@/lib/admin/repositories";
import type {
  CreditReservation,
  ProviderSettlementReceipt,
} from "./service";
import {
  InsufficientCreditsError,
  isValidPlatformBillingIdempotencyKey,
  normalizeProviderSettlementReceipt,
  PricingUnavailableError,
  quotePlatformOperation,
  refundPlatformOperation,
  reservePlatformOperation,
  settlePlatformOperation,
} from "./service";
import {
  authorizeCredentialAccess,
  resolveCredentialMode,
  type CredentialAccessDecision,
} from "@/lib/credentials/serverPolicy";
import type { AiUserBusinessSession } from "@/lib/auth/aiUserProductSession";
import type { AiUserLinkedBillingPhoneUserId } from "@/lib/auth/aiUserLinkedBillingRepository";
import { resolveLinkedPhoneForBilling } from "./linkedBillingServer";
import {
  assertProductionDatabaseGateReady,
  ProductionDatabaseGateError,
} from "@/lib/production/databaseGate";
import type { FixedBetaRuntimeConfig } from "./fixedBetaPricing";
import {
  inspectCapturedCostBetaReservation,
  PROVIDER_COST_UNKNOWN_PLATFORM_ABSORBED_REASON,
} from "./reconciliation";

type AuthIdentity = {
  userId: string;
  authType: "anonymous" | "phone" | "supabase" | "aiuser" | "passport_v4";
  aiuser?: AiUserBusinessSession;
};

export type GenerationBillingContext = {
  mode: "user_byok" | "platform_managed";
  reservation?: CreditReservation;
  providerOutcome?: "not_started" | "outcome_unknown" | "succeeded";
};

const providerReceiptIntents = new WeakMap<
  GenerationBillingContext,
  Readonly<ProviderSettlementReceipt> | undefined
>();

function sameProviderReceipt(
  left: Readonly<ProviderSettlementReceipt> | undefined,
  right: Readonly<ProviderSettlementReceipt> | undefined,
): boolean {
  return left === undefined
    ? right === undefined
    : right !== undefined
      && left.providerCostMinor === right.providerCostMinor
      && left.providerCurrency === right.providerCurrency
      && left.providerMinorUnitScale === right.providerMinorUnitScale;
}

function pinProviderReceiptIntent(
  context: GenerationBillingContext,
  receipt: ProviderSettlementReceipt | undefined,
  pinAbsence: boolean,
): Readonly<ProviderSettlementReceipt> | undefined {
  const normalized = normalizeProviderSettlementReceipt(receipt);
  if (providerReceiptIntents.has(context)) {
    const pinned = providerReceiptIntents.get(context);
    if (receipt !== undefined && !sameProviderReceipt(pinned, normalized)) {
      throw new PricingUnavailableError("供应商结算回执与首次终态意图不一致。");
    }
    return pinned;
  }
  if (normalized !== undefined) {
    const pinned = Object.freeze({ ...normalized });
    providerReceiptIntents.set(context, pinned);
    return pinned;
  }
  if (pinAbsence) providerReceiptIntents.set(context, undefined);
  return undefined;
}

type GenerationCompletionIntent = "succeeded" | "failed_not_delivered";

const completionIntents = new WeakMap<
  GenerationBillingContext,
  GenerationCompletionIntent
>();

function pinCompletionIntent(
  context: GenerationBillingContext,
  intent: GenerationCompletionIntent,
): void {
  const existing = completionIntents.get(context);
  if (existing === intent) return;
  if (existing !== undefined) {
    throw new PricingUnavailableError("生成完成意图与已有终态冲突。");
  }
  completionIntents.set(context, intent);
}

/**
 * Validates the captured exact v2 policy content (never a raw client flag)
 * without requiring the live activation kill switch. Legacy/BYOK contexts are
 * untouched.
 */
export function isCostBetaGenerationBilling(
  context: GenerationBillingContext,
): boolean {
  if (!context.reservation) return false;
  const inspection = inspectCapturedCostBetaReservation(context.reservation);
  if (inspection.mode === "invalid") {
    throw new PricingUnavailableError(
      "成本 β 计费预留快照无效，未发起任何模型调用。",
    );
  }
  return inspection.mode === "cost_beta_credit_v2";
}

/**
 * Records trusted internal `failed_not_delivered` completion intent for an
 * exact bounded v2 operation. Callers must only use this for their own trusted
 * engine/essential-output pipeline failures; browser body fields and client
 * acknowledgments are never evidence. The vendor cost intentionally stays
 * unknown (`providerOutcome` may remain `outcome_unknown`).
 *
 * No-op for BYOK, missing reservations and legacy v1 semantics. A pinned
 * successful terminal is a conflicting intent and is rejected; repeated
 * identical failures are idempotent.
 */
export function markGenerationBillingOperationFailed(
  context: GenerationBillingContext,
): void {
  if (!context.reservation) return;
  if (!isCostBetaGenerationBilling(context)) return;
  if (context.providerOutcome === "succeeded") {
    throw new PricingUnavailableError("生成已成功，不能记录失败终态。");
  }
  pinCompletionIntent(context, "failed_not_delivered");
}

function safeIdempotencyKey(request: Request): string | undefined {
  const supplied = request.headers.get("x-idempotency-key")?.trim();
  return isValidPlatformBillingIdempotencyKey(supplied) ? supplied : undefined;
}

function billingFailureResponse(
  error:
    | PricingUnavailableError
    | InsufficientCreditsError
    | ProductionDatabaseGateError,
): NextResponse {
  const safeMessage = error instanceof InsufficientCreditsError
    ? "平台积分不足，未发起任何模型调用。"
    : error instanceof PricingUnavailableError
      ? "平台定价暂不可用，未发起任何模型调用。"
      : "生产计费门禁暂不可用，未发起任何模型调用。";
  return NextResponse.json(
    {
      error: safeMessage,
      code: error.code,
      ...("quote" in error ? { quote: error.quote } : {}),
    },
    { status: error.status },
  );
}

function accessResponse(
  decision: Exclude<CredentialAccessDecision, { allowed: true }>,
  quote?: Awaited<ReturnType<typeof quotePlatformOperation>>["publicQuote"],
): NextResponse {
  return NextResponse.json(
    {
      error: decision.message,
      code: decision.code,
      ...(quote ? { quote } : {}),
    },
    { status: decision.status },
  );
}

export async function prepareGenerationBilling(input: {
  request: Request;
  auth: AuthIdentity;
  requestedMode: unknown;
  hasByok: boolean;
  operation: string;
  runtimeConfig?: FixedBetaRuntimeConfig;
}): Promise<GenerationBillingContext | NextResponse> {
  if (input.hasByok && input.requestedMode === "platform_managed") {
    return NextResponse.json(
      {
        error: "凭据模式与请求载荷冲突，未发起模型调用。",
        code: "CREDENTIAL_MODE_CONFLICT",
      },
      { status: 400 },
    );
  }
  let verifiedLinkedPhoneUserId: AiUserLinkedBillingPhoneUserId | undefined;
  if (input.auth.authType === "aiuser"
    && resolveCredentialMode(input.requestedMode, input.hasByok) === "platform_managed") {
    try {
      const linked = await resolveLinkedPhoneForBilling(input.auth.aiuser);
      if (linked.state === "linked") verifiedLinkedPhoneUserId = linked.phoneUserId;
    } catch {
      return NextResponse.json(
        { error: "关联账户计费暂不可用，未发起任何模型调用。", code: "LINKED_BILLING_UNAVAILABLE" },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
  }
  const decision = authorizeCredentialAccess({
    requestedMode: input.requestedMode,
    hasByok: input.hasByok,
    userId: input.auth.userId,
    authType: input.auth.authType,
    verifiedLinkedPhoneUserId,
  });
  if (!decision.allowed) {
    if (decision.code === "PHONE_VERIFICATION_REQUIRED") {
      try {
        await assertProductionDatabaseGateReady("billing");
        const quote = await quotePlatformOperation(
          getAdminRepository(),
          input.operation,
          input.runtimeConfig,
        );
        return accessResponse(decision, quote.publicQuote);
      } catch (error) {
        if (
          error instanceof PricingUnavailableError
          || error instanceof ProductionDatabaseGateError
        ) {
          return billingFailureResponse(error);
        }
        throw error;
      }
    }
    return accessResponse(decision);
  }
  if (decision.mode === "user_byok") return { mode: "user_byok" };
  const idempotencyKey = safeIdempotencyKey(input.request);
  if (!idempotencyKey) {
    return NextResponse.json(
      {
        error: "平台积分请求必须携带有效的幂等键，未发起任何模型调用。",
        code: "IDEMPOTENCY_KEY_REQUIRED",
      },
      { status: 400 },
    );
  }
  try {
    await assertProductionDatabaseGateReady("billing");
    const reservation = await reservePlatformOperation(
      getAdminRepository(),
      {
        userId: decision.billingUserId,
        operation: input.operation,
        idempotencyKey,
        runtimeConfig: input.runtimeConfig,
      },
    );
    if (reservation.replayed) {
      return NextResponse.json(
        {
          error: "该计费幂等请求已存在，未重复发起模型调用。",
          code: "BILLING_OPERATION_REPLAYED",
        },
        { status: 409 },
      );
    }
    return {
      mode: "platform_managed",
      reservation,
      providerOutcome: "not_started",
    };
  } catch (error) {
    if (
      error instanceof PricingUnavailableError
      || error instanceof InsufficientCreditsError
      || error instanceof ProductionDatabaseGateError
    ) {
      return billingFailureResponse(error);
    }
    if (error instanceof Error && error.message === "ACCOUNT_UNAVAILABLE") {
      return NextResponse.json(
        {
          error: "账户不可用，未发起任何模型调用。",
          code: "ACCOUNT_UNAVAILABLE",
        },
        { status: 403 },
      );
    }
    throw error;
  }
}

export function markGenerationBillingProviderStarted(
  context: GenerationBillingContext,
): void {
  if (
    context.reservation
    && context.providerOutcome === "not_started"
  ) {
    context.providerOutcome = "outcome_unknown";
  }
}

export function markGenerationBillingProviderSucceeded(
  context: GenerationBillingContext,
  providerReceipt?: ProviderSettlementReceipt,
): void {
  if (
    context.reservation
    && context.providerOutcome === "outcome_unknown"
  ) {
    // Reject an incompatible completion before changing the provider state.
    // Otherwise a failed intent could throw after becoming billable success.
    pinCompletionIntent(context, "succeeded");
    if (providerReceipt !== undefined) {
      pinProviderReceiptIntent(context, providerReceipt, false);
    }
    context.providerOutcome = "succeeded";
  }
  if (context.reservation && context.providerOutcome === "succeeded") {
    // A completed generation is the conceptual `successful_generation`
    // terminal intent. A later failure/refund intent is a conflict.
    pinCompletionIntent(context, "succeeded");
  }
}

export async function settleGenerationBilling(
  context: GenerationBillingContext,
  options: {
    requestSignal?: AbortSignal;
    providerReceipt?: ProviderSettlementReceipt;
    repository?: AdminRepository;
  } = {},
): Promise<"none" | "refund" | "settle" | "pending"> {
  if (!context.reservation) return "none";
  if (context.providerOutcome !== "succeeded") return "pending";
  // A late client abort does not prove that a completed provider call never
  // started, so it cannot turn a successful result into a refund.
  void options.requestSignal;
  const providerReceipt = pinProviderReceiptIntent(
    context,
    options.providerReceipt,
    true,
  );
  const terminal = await settlePlatformOperation(
    options.repository ?? getAdminRepository(),
    context.reservation,
    providerReceipt,
  );
  return terminal.kind === "refund" ? "refund" : "settle";
}

export async function refundGenerationBilling(
  context: GenerationBillingContext,
  reason: string,
  options: {
    providerNotStarted?: boolean;
    repository?: AdminRepository;
  } = {},
): Promise<"none" | "refund" | "settle" | "pending"> {
  if (!context.reservation) return "none";
  // This assertion can document a mechanically proven cache/config path, but
  // it must never overwrite a provider-started or succeeded state.
  void options.providerNotStarted;
  const costBeta = isCostBetaGenerationBilling(context);
  if (context.providerOutcome === "succeeded") {
    const terminal = await settlePlatformOperation(
      options.repository ?? getAdminRepository(),
      context.reservation,
      providerReceiptIntents.get(context),
    );
    return terminal.kind === "refund" ? "refund" : "settle";
  }
  if (
    costBeta
    && completionIntents.get(context) === "failed_not_delivered"
  ) {
    // Trusted internal pipeline failure for an exact bounded v2 operation:
    // refund the user once even if the vendor MAY have charged. The constant
    // reason labels the unknown vendor cost; no provider receipt is invented.
    const terminal = await refundPlatformOperation(
      options.repository ?? getAdminRepository(),
      context.reservation,
      PROVIDER_COST_UNKNOWN_PLATFORM_ABSORBED_REASON,
    );
    return terminal.kind === "settle" ? "settle" : "refund";
  }
  if (context.providerOutcome !== "not_started") return "pending";
  const terminal = await refundPlatformOperation(
    options.repository ?? getAdminRepository(),
    context.reservation,
    reason,
  );
  return terminal.kind === "settle" ? "settle" : "refund";
}
