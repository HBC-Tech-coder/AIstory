import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  parseCreditCardAdminAction,
  CREDIT_CARD_PUBLIC_ERROR,
  CREDIT_CARD_SCHEMA_VERSION,
} from "@/lib/billing/creditCards";
import {
  activateCreditCardBatch,
  createCreditCardProductionRuntime,
  CreditCardRequestError,
  disableCreditCard,
  disableCreditCardBatch,
  isCreditCardSameOriginRequest,
  issueCreditCardBatch,
  projectCreditCardAdminSnapshot,
  readCreditCardJsonBody,
} from "@/lib/billing/creditCardsServer";
import {
  INDEPENDENT_ADMIN_PRINCIPAL_PRODUCTION_COOKIE,
  resolveIndependentAdminPrincipalAuthorizedContext,
} from "@/lib/admin/independentPrincipalServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  Vary: "Cookie",
};

function json(body: Record<string, unknown>, status = 200): Response {
  return NextResponse.json(body, { status, headers: PRIVATE_HEADERS });
}

async function authorize() {
  const token = (await cookies()).get(
    INDEPENDENT_ADMIN_PRINCIPAL_PRODUCTION_COOKIE,
  )?.value;
  if (!token) return undefined;
  return resolveIndependentAdminPrincipalAuthorizedContext(token);
}

function failed(error: unknown): Response {
  if (error instanceof CreditCardRequestError) {
    return json({ error: error.code }, error.status);
  }
  return json({ error: CREDIT_CARD_PUBLIC_ERROR.unavailable }, 503);
}

export async function GET(): Promise<Response> {
  try {
    const context = await authorize();
    if (!context) {
      return json({ error: CREDIT_CARD_PUBLIC_ERROR.sessionRequired }, 401);
    }
    const service = await createCreditCardProductionRuntime({
      client: context.client,
    });
    const batches = await service.repository.listBatches(
      context.databaseContext,
      new Date().toISOString(),
    );
    return json(projectCreditCardAdminSnapshot(service.policy, batches));
  } catch (error) {
    return failed(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const context = await authorize();
    if (!context) {
      return json({ error: CREDIT_CARD_PUBLIC_ERROR.sessionRequired }, 401);
    }
    const service = await createCreditCardProductionRuntime({
      client: context.client,
    });
    if (!isCreditCardSameOriginRequest(request, service.publicOrigin)) {
      return json({ error: CREDIT_CARD_PUBLIC_ERROR.invalidRequest }, 403);
    }
    const action = parseCreditCardAdminAction(
      await readCreditCardJsonBody(request),
    );
    if (!action) {
      return json({ error: CREDIT_CARD_PUBLIC_ERROR.invalidRequest }, 400);
    }
    if (action.action === "issue") {
      const result = await issueCreditCardBatch({
        repository: service.repository,
        authorization: context.databaseContext,
        policy: service.policy,
        denominationCredits: action.denominationCredits,
        quantity: action.quantity,
        validityDays: action.validityDays,
        idempotencyKey: action.idempotencyKey,
      });
      return json({
        schemaVersion: CREDIT_CARD_SCHEMA_VERSION,
        status: "PENDING_ACTIVATION",
        batch: result.batch,
        deliveryAvailable: result.deliveryAvailable,
        ...(result.oneTimeDelivery
          ? { oneTimeDelivery: result.oneTimeDelivery }
          : {}),
      }, 201);
    }
    const batch = action.action === "activate"
      ? await activateCreditCardBatch({
        repository: service.repository,
        authorization: context.databaseContext,
        policy: service.policy,
        batchId: action.batchId,
        activationToken: action.activationToken,
      })
      : action.action === "disable_batch"
        ? await disableCreditCardBatch({
          repository: service.repository,
          authorization: context.databaseContext,
          batchId: action.batchId,
        })
        : await disableCreditCard({
          repository: service.repository,
          authorization: context.databaseContext,
          policy: service.policy,
          cardNumber: action.cardNumber,
        });
    return json({
      schemaVersion: CREDIT_CARD_SCHEMA_VERSION,
      ok: true,
      batch,
    });
  } catch (error) {
    return failed(error);
  }
}
