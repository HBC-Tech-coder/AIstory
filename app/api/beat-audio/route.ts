import { requestBeatAudio } from "@infiplot/engine";
import type { BeatAudioRequest } from "@infiplot/types";
import { NextResponse } from "next/server";
import { loadEngineConfig } from "@/lib/config";
import {
  beatAudioCacheKey,
  peekTtsCache,
  withTtsCache,
} from "@/lib/engine/ttsCache";
import {
  prepareGenerationBilling,
  refundGenerationBilling,
  settleGenerationBilling,
} from "@/lib/billing/generationGate";
import { requireUser } from "@/lib/supabase/guard";

export const runtime = "nodejs";

export async function POST(req: Request) {
  let body: BeatAudioRequest;
  try {
    body = (await req.json()) as BeatAudioRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Voice is now optional — when the server runs StepFun, the client omits
  // the ~220KB Xiaomi reference audio and sends stepfunVoiceId /
  // voiceDescription instead (saves Fast Origin Transfer bandwidth). The
  // engine's resolveVoice re-provisions on a provider mismatch. We only
  // require the beat text + SOMETHING to synthesize from.
  const VALID_TTS_PROVIDERS = ["xiaomi", "stepfun", "bailian"];
  const hasInvalidVoiceProvider =
    !!body.voice?.provider && !VALID_TTS_PROVIDERS.includes(body.voice.provider);
  const hasVoice =
    !!body.voice?.provider && VALID_TTS_PROVIDERS.includes(body.voice.provider);
  const hasFallback =
    !!body.stepfunVoiceId || !!body.voiceDescription || !!body.voiceProfile;
  if (
    !body.beat?.id ||
    !body.beat?.line ||
    hasInvalidVoiceProvider ||
    (!hasVoice && !hasFallback)
  ) {
    return NextResponse.json(
      { error: "beat.id and beat.line are required, plus either voice.provider (xiaomi|stepfun|bailian) or stepfunVoiceId/voiceDescription/voiceProfile" },
      { status: 400 },
    );
  }

  try {
    const config = loadEngineConfig();
    const cacheMeta = beatAudioCacheKey(config.tts, body);
    const cached = await peekTtsCache(cacheMeta);
    if (cached?.audio) {
      const binary = Buffer.from(cached.audio.base64, "base64");
      return new Response(binary, {
        headers: {
          "Content-Type": cached.audio.mime,
          "X-AIstory-TTS-Cache": "hit",
          ...(cacheMeta.key
            ? { "X-AIstory-TTS-Cache-Key": cacheMeta.key.slice(0, 12) }
            : {}),
        },
      });
    }
    const auth = await requireUser();
    if (auth instanceof NextResponse) return auth;
    const billing = await prepareGenerationBilling({
      request: req,
      auth,
      requestedMode: "platform_managed",
      hasByok: false,
      operation: "tts.beat",
    });
    if (billing instanceof NextResponse) return billing;
    try {
    const result = await withTtsCache(
      cacheMeta,
      "api/beat-audio",
      () => requestBeatAudio(config, body),
    );
    if (result.cache.status === "hit" || !result.audio) {
      await refundGenerationBilling(
        billing,
        result.cache.status === "hit"
          ? "Cache hit; reservation released."
          : "No audio produced; reservation released.",
      );
    } else {
      await settleGenerationBilling(billing);
    }
    if (!result.audio) {
      return new Response(null, {
        status: 204,
        headers: {
          "X-AIstory-TTS-Cache": result.cache.status,
          ...(result.cache.reason ? { "X-AIstory-TTS-Cache-Reason": result.cache.reason } : {}),
        },
      });
    }
    const binary = Buffer.from(result.audio.base64, "base64");
    return new Response(binary, {
      headers: {
        "Content-Type": result.audio.mime,
        "X-AIstory-TTS-Cache": result.cache.status,
        ...(result.cache.key ? { "X-AIstory-TTS-Cache-Key": result.cache.key.slice(0, 12) } : {}),
      },
    });
    } catch (error) {
      await refundGenerationBilling(
        billing,
        "TTS generation failed before settlement.",
      ).catch(() => undefined);
      throw error;
    }
  } catch (err) {
    // Engine already swallows synth errors and returns audio:null. Anything
    // that reaches here is config-level — surface so the client can log it.
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

