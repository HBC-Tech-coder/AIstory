import { requestInsertBeat } from "@infiplot/engine";
import type { InsertBeatRequest } from "@infiplot/types";
import { NextResponse } from "next/server";
import { buildByoEngineConfig, loadEngineConfig } from "@/lib/config";
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
  let body: InsertBeatRequest;
  try {
    body = (await req.json()) as InsertBeatRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (
    !body.session
    || !Array.isArray(body.session.history)
    || !Array.isArray(body.session.characters)
    || typeof body.session.worldSetting !== "string"
    || typeof body.freeformAction !== "string"
    || !body.freeformAction.trim()
  ) {
    return NextResponse.json(
      { error: "session and freeformAction are required" },
      { status: 400 },
    );
  }
  if (
    body.session.authoredStory?.authorLocked
    && !isAuthoredAiContinuationAllowed(body.session.authoredStory)
  ) {
    return NextResponse.json(
      { error: "作者锁定章节不允许请求 AI 插入剧情。" },
      { status: 409 },
    );
  }

  const hasByok = hasByokPayload(body.byo);
  let config: ReturnType<typeof loadEngineConfig>;
  try {
    if (hasByok) assertCompleteByok(body.byo);
    const base = hasByok
      ? buildByoEngineConfig(body.byo!, loadEngineConfig())
      : loadEngineConfig();
    config = body.clientTts === true ? { ...base, tts: undefined } : base;
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
    operation: "story.insert-beat",
  });
  if (preparedBilling instanceof NextResponse) return preparedBilling;
  const billing: GenerationBillingContext = preparedBilling;

  try {
    const generate = async () => {
      const result = await requestInsertBeat(config, body, {
        onProviderStarted: () => {
          markGenerationBillingProviderStarted(billing);
        },
      });
      return result;
    };
    let result: Awaited<ReturnType<typeof requestInsertBeat>>;
    try {
      if (billing.reservation?.catalogEntry.pricingMode === "cost_beta_credit_v2") {
        result = await runInCostEnvelope(config, "story.insert-beat", generate);
      } else {
        result = await generate();
      }
    } catch (error) {
      markGenerationBillingOperationFailed(billing);
      throw error;
    }
    markGenerationBillingProviderSucceeded(billing);
    await settleGenerationBilling(billing, { requestSignal: req.signal });
    return NextResponse.json({
      ...result,
      characters: result.characters.map((c) => ({ ...c, voice: undefined })),
    });
  } catch {
    await refundGenerationBilling(
      billing,
      "Beat generation failed before settlement.",
    ).catch(() => undefined);
    return NextResponse.json({ error: "Beat generation failed." }, { status: 500 });
  }
}
