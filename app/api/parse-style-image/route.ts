import { analyzeImageDataUrl } from "@infiplot/ai-client";
import type {
  ParseStyleImageRequest,
  ParseStyleImageResponse,
} from "@infiplot/types";
import { NextResponse } from "next/server";
import { loadEngineConfig } from "@/lib/config";
import { STYLE_EXTRACTION_PROMPT } from "@/lib/styleExtraction";
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

export const runtime = "nodejs";

// The client resizes uploads before posting. 3 MB leaves generous headroom
// against malformed direct-API payloads.
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

function parseVisionJson(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]!);
        return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
      } catch {
        // Fall through to raw-text compatibility.
      }
    }
    return { stylePrompt: raw };
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return out.length ? out : undefined;
}

function optionalCharacters(value: unknown): ParseStyleImageResponse["characters"] {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => ({
      label: optionalString(item.label),
      face: optionalString(item.face),
      clothing: optionalString(item.clothing),
      expression: optionalString(item.expression),
      pose: optionalString(item.pose),
      relationship: optionalString(item.relationship),
    }))
    .filter((item) => Object.values(item).some(Boolean));
  return out.length ? out : undefined;
}

function buildPayload(
  parsed: Record<string, unknown>,
  stylePrompt: string,
): ParseStyleImageResponse {
  return {
    stylePrompt,
    storySeed: optionalString(parsed.storySeed),
    subjectPrompt: optionalString(parsed.subjectPrompt),
    characterPrompt: optionalString(parsed.characterPrompt),
    scenePrompt: optionalString(parsed.scenePrompt),
    setting: optionalString(parsed.setting),
    mood: optionalString(parsed.mood),
    props: optionalStringArray(parsed.props),
    characters: optionalCharacters(parsed.characters),
  };
}

export async function POST(req: Request) {
  let body: ParseStyleImageRequest;
  try {
    body = (await req.json()) as ParseStyleImageRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (
    typeof body.imageDataUrl !== "string" ||
    !body.imageDataUrl.startsWith("data:image/")
  ) {
    return NextResponse.json(
      { error: "imageDataUrl must be a data:image/... base64 URL" },
      { status: 400 },
    );
  }
  if (body.imageDataUrl.length > MAX_IMAGE_BYTES) {
    return NextResponse.json(
      { error: `imageDataUrl exceeds ${MAX_IMAGE_BYTES} bytes` },
      { status: 413 },
    );
  }

  let config: ReturnType<typeof loadEngineConfig>;
  try {
    config = loadEngineConfig();
  } catch {
    return NextResponse.json(
      { error: "Vision provider unavailable." },
      { status: 503 },
    );
  }

  const auth = await requireUser();
  if (auth instanceof NextResponse) return auth;
  const preparedBilling = await prepareGenerationBilling({
    request: req,
    auth,
    requestedMode: "platform_managed",
    hasByok: false,
    runtimeConfig: config,
    operation: "vision.style-parse",
  });
  if (preparedBilling instanceof NextResponse) return preparedBilling;
  const billing: GenerationBillingContext = preparedBilling;

  try {
    const isV2 = billing.reservation?.catalogEntry.pricingMode === "cost_beta_credit_v2";
    const generate = async () => {
      markGenerationBillingProviderStarted(billing);
      return await analyzeImageDataUrl(
        config.vision,
        body.imageDataUrl,
        STYLE_EXTRACTION_PROMPT,
      );
    };
    let raw: string;
    try {
      if (isV2) {
        raw = await runInCostEnvelope(config, "vision.style-parse", generate);
      } else {
        raw = await generate();
      }
    } catch (error) {
      markGenerationBillingOperationFailed(billing);
      throw error;
    }

    // v2 credits only settle when the raw vision output yields a usable style
    // prompt. The parse/validation boundary is intentionally narrow so a
    // settle or response failure below cannot be misread as unusable output.
    let parsed: Record<string, unknown> | undefined;
    let stylePrompt: string | undefined;
    let v2ParseFailed = false;
    if (isV2) {
      try {
        parsed = parseVisionJson(raw);
        stylePrompt = optionalString(parsed.stylePrompt);
      } catch {
        v2ParseFailed = true;
      }
    }
    const v2Usable = !v2ParseFailed && Boolean(stylePrompt);
    if (!isV2 || v2Usable) {
      markGenerationBillingProviderSucceeded(billing);
    }
    if (!isV2) {
      // Legacy/v1 keeps the historical success-before-parse ordering and
      // still settles an unusable parsed result before the application 502.
      const legacyParsed = parseVisionJson(raw);
      const legacyStylePrompt = optionalString(legacyParsed.stylePrompt);
      if (!legacyStylePrompt) {
        await settleGenerationBilling(billing, { requestSignal: req.signal });
        return NextResponse.json(
          { error: "Vision model returned an empty stylePrompt" },
          { status: 502 },
        );
      }
      const legacyPayload = buildPayload(legacyParsed, legacyStylePrompt);
      await settleGenerationBilling(billing, { requestSignal: req.signal });
      return NextResponse.json(legacyPayload);
    }
    if (v2ParseFailed) {
      markGenerationBillingOperationFailed(billing);
      await refundGenerationBilling(
        billing,
        "Style analysis failed before settlement.",
      ).catch(() => undefined);
      return NextResponse.json({ error: "Style analysis failed." }, { status: 500 });
    }
    if (!stylePrompt) {
      markGenerationBillingOperationFailed(billing);
      await refundGenerationBilling(
        billing,
        "Style analysis failed before settlement.",
      ).catch(() => undefined);
      return NextResponse.json(
        { error: "Vision model returned an empty stylePrompt" },
        { status: 502 },
      );
    }
    const payload = buildPayload(parsed!, stylePrompt);
    await settleGenerationBilling(billing, { requestSignal: req.signal });
    return NextResponse.json(payload);
  } catch {
    await refundGenerationBilling(
      billing,
      "Style analysis failed before settlement.",
    ).catch(() => undefined);
    return NextResponse.json({ error: "Style analysis failed." }, { status: 500 });
  }
}
