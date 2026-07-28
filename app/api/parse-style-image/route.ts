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
  prepareGenerationBilling,
  refundGenerationBilling,
  settleGenerationBilling,
  type GenerationBillingContext,
} from "@/lib/billing/generationGate";

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

  const auth = await requireUser();
  if (auth instanceof NextResponse) return auth;
  const preparedBilling = await prepareGenerationBilling({
    request: req,
    auth,
    requestedMode: "platform_managed",
    hasByok: false,
    operation: "vision.style-parse",
  });
  if (preparedBilling instanceof NextResponse) return preparedBilling;
  const billing: GenerationBillingContext = preparedBilling;

  try {
    const config = loadEngineConfig();
    const raw = await analyzeImageDataUrl(
      config.vision,
      body.imageDataUrl,
      STYLE_EXTRACTION_PROMPT,
    );

    const parsed = parseVisionJson(raw);
    const stylePrompt = optionalString(parsed.stylePrompt);
    if (!stylePrompt) {
      return NextResponse.json(
        { error: "Vision model returned an empty stylePrompt" },
        { status: 502 },
      );
    }

    const payload: ParseStyleImageResponse = {
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
    await settleGenerationBilling(billing);
    return NextResponse.json(payload);
  } catch (err) {
    await refundGenerationBilling(
      billing,
      "Style analysis failed before settlement.",
    ).catch(() => undefined);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
