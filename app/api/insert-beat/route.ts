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
  prepareGenerationBilling,
  refundGenerationBilling,
  settleGenerationBilling,
  type GenerationBillingContext,
} from "@/lib/billing/generationGate";

export const runtime = "nodejs";

export async function POST(req: Request) {
  let body: InsertBeatRequest;
  try {
    body = (await req.json()) as InsertBeatRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.session || !body.freeformAction) {
    return NextResponse.json(
      { error: "session and freeformAction are required" },
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
    operation: "story.insert-beat",
  });
  if (preparedBilling instanceof NextResponse) return preparedBilling;
  const billing: GenerationBillingContext = preparedBilling;

  try {
    if (hasByok) assertCompleteByok(body.byo);
    const base = hasByok
      ? buildByoEngineConfig(body.byo!, loadEngineConfig())
      : loadEngineConfig();
    const config = body.clientTts === true ? { ...base, tts: undefined } : base;
    const result = await requestInsertBeat(config, body);
    await settleGenerationBilling(billing);
    return NextResponse.json({
      ...result,
      characters: result.characters.map((c) => ({ ...c, voice: undefined })),
    });
  } catch (err) {
    await refundGenerationBilling(
      billing,
      "Beat generation failed before settlement.",
    ).catch(() => undefined);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
