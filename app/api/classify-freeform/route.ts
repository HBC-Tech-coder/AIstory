import { classifyFreeform } from "@infiplot/engine";
import type { FreeformClassifyRequest } from "@infiplot/types";
import { NextResponse } from "next/server";
import { loadEngineConfig, buildByoEngineConfig } from "@/lib/config";
import {
  assertCompleteByok,
  hasByokPayload,
} from "@/lib/credentials/serverPolicy";
import { requireUser } from "@/lib/supabase/guard";
import {
  markGenerationBillingOperationFailed,
  markGenerationBillingProviderStarted,
  markGenerationBillingProviderSucceeded,
  prepareGenerationBilling,
  refundGenerationBilling,
  settleGenerationBilling,
  type GenerationBillingContext,
} from "@/lib/billing/generationGate";
import { runInCostEnvelope } from "@/lib/billing/platformCostEnvelopeServer";
import { isAuthoredAiContinuationAllowed } from "@/lib/case-studies/schema";

export const runtime = "nodejs";

export async function POST(req: Request) {
  let body: FreeformClassifyRequest;
  try {
    body = (await req.json()) as FreeformClassifyRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (
    !body.session
    || !Array.isArray(body.session.history)
    || !Array.isArray(body.session.characters)
    || typeof body.freeformText !== "string"
    || !body.freeformText.trim()
  ) {
    return NextResponse.json(
      { error: "session and freeformText are required" },
      { status: 400 },
    );
  }
  if (
    body.session.authoredStory?.authorLocked
    && !isAuthoredAiContinuationAllowed(body.session.authoredStory)
  ) {
    return NextResponse.json(
      { error: "作者锁定章节不允许请求 AI 自由输入分类。" },
      { status: 409 },
    );
  }

  const hasByok = hasByokPayload(body.byo);
  let config: ReturnType<typeof loadEngineConfig>;
  try {
    if (hasByok) assertCompleteByok(body.byo);
    const official = loadEngineConfig();
    config = body.byo ? buildByoEngineConfig(body.byo, official) : official;
  } catch {
    return NextResponse.json(
      {
        error: hasByok
          ? "Invalid BYO configuration."
          : "Text provider unavailable.",
      },
      { status: hasByok ? 400 : 503 },
    );
  }
  const auth = await requireUser();
  if (auth instanceof NextResponse) return auth;
  const preparedBilling = await prepareGenerationBilling({
    request: req,
    auth,
    requestedMode: body.credentialMode,
    hasByok,
    runtimeConfig: config,
    operation: "story.classify-freeform",
  });
  if (preparedBilling instanceof NextResponse) return preparedBilling;
  const billing: GenerationBillingContext = preparedBilling;

  try {
    const generate = async () => {
      const result = await classifyFreeform(config, body, {
        onProviderStarted: () => {
          markGenerationBillingProviderStarted(billing);
        },
      });
      return result;
    };
    let result: Awaited<ReturnType<typeof classifyFreeform>>;
    try {
      if (billing.reservation?.catalogEntry.pricingMode === "cost_beta_credit_v2") {
        result = await runInCostEnvelope(config, "story.classify-freeform", generate);
      } else {
        result = await generate();
      }
    } catch (error) {
      markGenerationBillingOperationFailed(billing);
      throw error;
    }
    markGenerationBillingProviderSucceeded(billing);
    await settleGenerationBilling(billing, { requestSignal: req.signal });
    return NextResponse.json(result);
  } catch {
    await refundGenerationBilling(
      billing,
      "Freeform classification failed before settlement.",
    ).catch(() => undefined);
    return NextResponse.json({ error: "Classification failed." }, { status: 500 });
  }
}
