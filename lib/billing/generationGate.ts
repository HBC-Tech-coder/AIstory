import "server-only";

import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { getAdminRepository } from "@/lib/admin/service";
import type { CreditReservation } from "./service";
import {
  InsufficientCreditsError,
  PricingUnavailableError,
  quotePlatformOperation,
  refundPlatformOperation,
  reservePlatformOperation,
  settlePlatformOperation,
} from "./service";
import {
  authorizeCredentialAccess,
  type CredentialAccessDecision,
} from "@/lib/credentials/serverPolicy";

type AuthIdentity = {
  userId: string;
  authType: "anonymous" | "phone" | "supabase";
};

export type GenerationBillingContext = {
  mode: "user_byok" | "platform_managed";
  reservation?: CreditReservation;
};

function safeIdempotencyKey(request: Request): string {
  const supplied = request.headers.get("x-idempotency-key")?.trim();
  if (supplied && /^[A-Za-z0-9:_-]{8,160}$/.test(supplied)) {
    return supplied;
  }
  return `generation:${randomUUID()}`;
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
}): Promise<GenerationBillingContext | NextResponse> {
  const decision = authorizeCredentialAccess({
    requestedMode: input.requestedMode,
    hasByok: input.hasByok,
    userId: input.auth.userId,
  });
  if (!decision.allowed) {
    if (decision.code === "PHONE_VERIFICATION_REQUIRED") {
      try {
        const quote = await quotePlatformOperation(
          getAdminRepository(),
          input.operation,
        );
        return accessResponse(decision, quote.publicQuote);
      } catch (error) {
        if (error instanceof PricingUnavailableError) {
          return NextResponse.json(
            { error: error.message, code: error.code },
            { status: error.status },
          );
        }
        throw error;
      }
    }
    return accessResponse(decision);
  }
  if (decision.mode === "user_byok") return { mode: "user_byok" };
  try {
    const reservation = await reservePlatformOperation(
      getAdminRepository(),
      {
        userId: input.auth.userId,
        operation: input.operation,
        idempotencyKey: safeIdempotencyKey(input.request),
      },
    );
    return { mode: "platform_managed", reservation };
  } catch (error) {
    if (
      error instanceof PricingUnavailableError
      || error instanceof InsufficientCreditsError
    ) {
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
          ...("quote" in error ? { quote: error.quote } : {}),
        },
        { status: error.status },
      );
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

export async function settleGenerationBilling(
  context: GenerationBillingContext,
): Promise<void> {
  if (!context.reservation) return;
  await settlePlatformOperation(getAdminRepository(), context.reservation);
}

export async function refundGenerationBilling(
  context: GenerationBillingContext,
  reason: string,
): Promise<void> {
  if (!context.reservation) return;
  await refundPlatformOperation(
    getAdminRepository(),
    context.reservation,
    reason,
  );
}
