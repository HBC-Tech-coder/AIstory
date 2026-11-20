import { visionDecide } from "@infiplot/engine";
import type { VisionRequest } from "@infiplot/types";
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

// Browser annotator resizes to 768 wide → typically 200-800 KB base64.
// 3 MB caps abusive direct-API payloads (which would inflate upstream
// vision LLM costs) while leaving ~4x headroom for legitimate inputs.
const MAX_ANNOTATED_BYTES = 3 * 1024 * 1024;

export async function POST(req: Request) {
  let body: VisionRequest;
  try {
    body = (await req.json()) as VisionRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (
    !body.session
    || !Array.isArray(body.session.history)
    || !Array.isArray(body.session.characters)
  ) {
    return NextResponse.json(
      { error: "session is required" },
      { status: 400 },
    );
  }
  if (
    body.session.authoredStory?.authorLocked
    && !isAuthoredAiContinuationAllowed(body.session.authoredStory)
  ) {
    return NextResponse.json(
      { error: "作者锁定章节不允许请求 AI 视觉分支。" },
      { status: 409 },
    );
  }
  if (
    typeof body.annotatedImageBase64 !== "string" ||
    body.annotatedImageBase64.length === 0
  ) {
    return NextResponse.json(
      { error: "annotatedImageBase64 must be a non-empty string" },
      { status: 400 },
    );
  }
  if (body.annotatedImageBase64.length > MAX_ANNOTATED_BYTES) {
    return NextResponse.json(
      { error: `annotatedImageBase64 exceeds ${MAX_ANNOTATED_BYTES} bytes` },
      { status: 413 },
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
          : "Vision provider unavailable.",
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
    operation: "vision.decide",
  });
  if (preparedBilling instanceof NextResponse) return preparedBilling;
  const billing: GenerationBillingContext = preparedBilling;

  try {
    const generate = async () => {
      const result = await visionDecide(config, body, {
        onProviderStarted: () => {
          markGenerationBillingProviderStarted(billing);
        },
      });
      return result;
    };
    let result: Awaited<ReturnType<typeof visionDecide>>;
    try {
      if (billing.reservation?.catalogEntry.pricingMode === "cost_beta_credit_v2") {
        result = await runInCostEnvelope(config, "vision.decide", generate);
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
      "Vision generation failed before settlement.",
    ).catch(() => undefined);
    return NextResponse.json({ error: "Vision generation failed." }, { status: 500 });
  }
}
