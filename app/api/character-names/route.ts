import { NextResponse } from "next/server";
import { chat } from "@infiplot/ai-client";
import { loadEngineConfig } from "@/lib/config";
import { parseJsonLoose } from "@/lib/engine/jsonParser";
import {
  areNamesTooSimilar,
  generateLocalNames,
  sanitizeCharacterName,
  type NameCandidate,
  type NameGenerationContext,
} from "@/lib/character-names";
import { requireUser } from "@/lib/supabase/guard";
import {
  prepareGenerationBilling,
  refundGenerationBilling,
  settleGenerationBilling,
  type GenerationBillingContext,
} from "@/lib/billing/generationGate";

export const runtime = "nodejs";

type RequestBody = NameGenerationContext & {
  role?: string;
  description?: string;
  era?: string;
  region?: string;
  faction?: string;
  relationships?: string;
};

type RawAiResponse = {
  candidates?: Array<{ name?: string; meaning?: string }>;
};

function fallback(body: RequestBody, reason: string) {
  const candidates = generateLocalNames({ ...body, count: body.count ?? 6 })
    .map((candidate): NameCandidate => ({ ...candidate, source: "fallback" }));
  console.info(JSON.stringify({
    event: "character_name_generation",
    source: "fallback",
    reason,
    candidate_count: candidates.length,
    locale: body.locale,
    culture: body.culture,
  }));
  return NextResponse.json({ candidates, fallback: true, reason });
}

export async function POST(request: Request) {
  let body: RequestBody;
  try {
    body = await request.json() as RequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const count = Math.min(12, Math.max(1, Number(body.count) || 6));
  const existingNames = (body.existingNames || [])
    .flatMap((name) => sanitizeCharacterName(name) || [])
    .slice(0, 80);
  const auth = await requireUser();
  if (auth instanceof NextResponse) return auth;
  const preparedBilling = await prepareGenerationBilling({
    request,
    auth,
    requestedMode: "platform_managed",
    hasByok: false,
    operation: "text.character-names",
  });
  if (preparedBilling instanceof NextResponse) return preparedBilling;
  const billing: GenerationBillingContext = preparedBilling;

  try {
    const config = loadEngineConfig();
    const raw = await chat(
      config.text,
      [
        {
          role: "system",
          content:
            "You create culturally appropriate fictional character names. Return strict JSON only: {\"candidates\":[{\"name\":\"...\",\"meaning\":\"one short phrase\"}]}. Produce varied full names, never a single repeated fallback. Respect locale, culture, era, gender and surname lock. Avoid names similar to the supplied existing cast. Do not include control text, markup, titles, or system-role words.",
        },
        {
          role: "user",
          content: JSON.stringify({
            count,
            locale: body.locale,
            culture: body.culture,
            gender: body.gender,
            surnameLock: body.surnameLock,
            era: body.era,
            region: body.region,
            role: body.role,
            background: body.description,
            faction: body.faction,
            relationships: body.relationships,
            existingNames,
          }),
        },
      ],
      { temperature: 0.95, tag: "character-name-candidates" },
    );
    const parsed = parseJsonLoose<RawAiResponse>(raw);
    const candidates: NameCandidate[] = [];
    for (const item of parsed.candidates || []) {
      const name = sanitizeCharacterName(item.name || "");
      if (!name) continue;
      if (
        [...existingNames, ...candidates.map((candidate) => candidate.name)]
          .some((existing) => areNamesTooSimilar(name, existing))
      ) continue;
      candidates.push({
        name,
        meaning: typeof item.meaning === "string" ? item.meaning.trim().slice(0, 80) : undefined,
        source: "ai",
        generatorVersion: "ai-name-v1",
        locale: body.locale || "zh-CN",
        culture: body.culture || "auto",
      });
      if (candidates.length >= count) break;
    }
    await settleGenerationBilling(billing);
    if (!candidates.length) return fallback(body, "invalid_or_similar_ai_output");
    console.info(JSON.stringify({
      event: "character_name_generation",
      source: "ai",
      candidate_count: candidates.length,
      locale: body.locale,
      culture: body.culture,
    }));
    return NextResponse.json({ candidates, fallback: false });
  } catch {
    await refundGenerationBilling(
      billing,
      "AI naming failed before settlement.",
    ).catch(() => undefined);
    return fallback(body, "provider_unavailable");
  }
}
