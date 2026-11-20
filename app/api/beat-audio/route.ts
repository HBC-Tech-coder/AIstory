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
  markGenerationBillingOperationFailed,
  markGenerationBillingProviderStarted,
  markGenerationBillingProviderSucceeded,
  prepareGenerationBilling,
  refundGenerationBilling,
  settleGenerationBilling,
} from "@/lib/billing/generationGate";
import { runInCostEnvelope } from "@/lib/billing/platformCostEnvelopeServer";
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
    typeof body.beat?.id !== "string" ||
    !body.beat.id.trim() ||
    typeof body.beat.line !== "string" ||
    !body.beat.line.trim() ||
    (body.beat.lineDelivery != null && typeof body.beat.lineDelivery !== "string") ||
    (body.voiceDescription != null && typeof body.voiceDescription !== "string") ||
    (body.characterName != null && typeof body.characterName !== "string") ||
    (body.stepfunVoiceId != null && typeof body.stepfunVoiceId !== "string") ||
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
    const billingBody: BeatAudioRequest = config.tts
      && (body.voice?.provider === "stepfun" || body.voice?.provider === "bailian")
      ? {
          ...body,
          voice: {
            ...body.voice,
            model: config.tts.speechModel,
          },
        }
      : body;
    const cacheMeta = beatAudioCacheKey(config.tts, billingBody);
    const cached = await peekTtsCache(cacheMeta);
    if (cached?.audio) {
      const binary = Buffer.from(cached.audio.base64, "base64");
      const audio = new Uint8Array(binary.byteLength);
      audio.set(binary);
      return new Response(audio, {
        headers: {
          "Content-Type": cached.audio.mime,
          "X-AIstory-TTS-Cache": "hit",
          ...(cacheMeta.key
            ? { "X-AIstory-TTS-Cache-Key": cacheMeta.key.slice(0, 12) }
            : {}),
        },
      });
    }
    if (!config.tts) {
      return new Response(null, {
        status: 204,
        headers: {
          "X-AIstory-TTS-Cache": "skip",
          "X-AIstory-TTS-Cache-Reason": "tts-disabled",
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
      runtimeConfig: config,
      operation: "tts.beat",
    });
    if (billing instanceof NextResponse) return billing;
    try {
      const result = await withTtsCache(
        cacheMeta,
        "api/beat-audio",
        async () => {
          const generate = async () => {
            return await requestBeatAudio(config, billingBody, {
              onProviderStarted: () => {
                markGenerationBillingProviderStarted(billing);
              },
            });
          };
          let generated: Awaited<ReturnType<typeof requestBeatAudio>>;
          try {
            if (billing.reservation?.catalogEntry.pricingMode === "cost_beta_credit_v2") {
              generated = await runInCostEnvelope(config, "tts.beat", generate);
            } else {
              generated = await generate();
            }
          } catch (error) {
            markGenerationBillingOperationFailed(billing);
            throw error;
          }
          if (generated.audio) {
            markGenerationBillingProviderSucceeded(billing);
          } else {
            markGenerationBillingOperationFailed(billing);
          }
          return generated;
        },
      );
      if (result.cache.status === "hit" || !result.audio) {
        await refundGenerationBilling(
          billing,
          result.cache.status === "hit"
            ? "Cache hit; reservation released."
            : "No audio produced; reservation released.",
          result.cache.status === "hit"
            ? { providerNotStarted: true }
            : undefined,
        );
      } else {
        await settleGenerationBilling(billing, { requestSignal: req.signal });
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
      const audio = new Uint8Array(binary.byteLength);
      audio.set(binary);
      return new Response(audio, {
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
  } catch {
    // Engine already swallows synth errors and returns audio:null. Anything
    // that reaches here is returned as a fixed, non-sensitive route error.
    return NextResponse.json({ error: "TTS unavailable." }, { status: 503 });
  }
}

