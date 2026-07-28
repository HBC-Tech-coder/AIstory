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
  prepareGenerationBilling,
  refundGenerationBilling,
  settleGenerationBilling,
  type GenerationBillingContext,
} from "@/lib/billing/generationGate";

export const runtime = "nodejs";

export async function POST(req: Request) {
  let body: FreeformClassifyRequest;
  try {
    body = (await req.json()) as FreeformClassifyRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.session || !body.freeformText?.trim()) {
    return NextResponse.json(
      { error: "session and freeformText are required" },
      { status: 400 },
    );
  }

  const hasByok = hasByokPayload(body.byo);
  const auth = await requireUser();
  if (auth instanceof NextResponse) return auth;
  const preparedBilling = await prepareGenerationBilling({
    request: req,
    auth,
    requestedMode: body.credentialMode,
    hasByok,
    operation: "story.classify-freeform",
  });
  if (preparedBilling instanceof NextResponse) return preparedBilling;
  const billing: GenerationBillingContext = preparedBilling;

  try {
    if (hasByok) assertCompleteByok(body.byo);
    const official = loadEngineConfig();
    const config = body.byo ? buildByoEngineConfig(body.byo, official) : official;
    const result = await classifyFreeform(config, body);
    await settleGenerationBilling(billing);
    return NextResponse.json(result);
  } catch (err) {
    await refundGenerationBilling(
      billing,
      "Freeform classification failed before settlement.",
    ).catch(() => undefined);
    const message = err instanceof Error ? err.message : "Unknown error";
    const status = message.includes("Invalid BYO") || message.includes("Missing BYO") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
