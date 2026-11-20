import { NextResponse } from "next/server";

import {
  CREDIT_CARD_PUBLIC_ERROR,
  parseCreditCardRedeemAction,
} from "@/lib/billing/creditCards";
import {
  createCreditCardProductionRuntime,
  CreditCardRequestError,
  isCreditCardSameOriginRequest,
  readCreditCardJsonBody,
  redeemCreditCard,
} from "@/lib/billing/creditCardsServer";
import { requireUser } from "@/lib/supabase/guard";

export const runtime = "nodejs";

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  Vary: "Cookie",
};

function json(body: Record<string, unknown>, status = 200): Response {
  return NextResponse.json(body, { status, headers: PRIVATE_HEADERS });
}

export async function POST(request: Request): Promise<Response> {
  const auth = await requireUser();
  if (auth instanceof NextResponse || auth.authType !== "phone") {
    return json({ error: CREDIT_CARD_PUBLIC_ERROR.sessionRequired }, 401);
  }
  try {
    const service = await createCreditCardProductionRuntime();
    if (!isCreditCardSameOriginRequest(request, service.publicOrigin)) {
      return json({ error: CREDIT_CARD_PUBLIC_ERROR.invalidRequest }, 403);
    }
    const action = parseCreditCardRedeemAction(
      await readCreditCardJsonBody(request, 4096),
    );
    if (!action) {
      return json({ error: CREDIT_CARD_PUBLIC_ERROR.invalidRequest }, 400);
    }
    return json(await redeemCreditCard({
      repository: service.repository,
      policy: service.policy,
      userId: auth.userId,
      cardNumber: action.cardNumber,
      pin: action.pin,
      idempotencyKey: action.idempotencyKey,
    }));
  } catch (error) {
    if (error instanceof CreditCardRequestError) {
      const response = json(
        { error: error.code },
        error.status,
      );
      if (error.retryAfterSeconds) {
        response.headers.set("Retry-After", String(error.retryAfterSeconds));
      }
      return response;
    }
    return json({ error: CREDIT_CARD_PUBLIC_ERROR.unavailable }, 503);
  }
}
