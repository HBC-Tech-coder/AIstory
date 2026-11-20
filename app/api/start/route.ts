import { startSession } from "@infiplot/engine";
import type { SceneStreamEvent, StartRequest, StartResponse } from "@infiplot/types";
import { NextResponse } from "next/server";
import { buildByoEngineConfig, loadEngineConfig } from "@/lib/config";
import {
  assertCompleteByok,
  hasByokPayload,
} from "@/lib/credentials/serverPolicy";
import { cacheApiResponseImage } from "@/lib/engine/mediaCache";
import {
  peekSceneCache,
  startSceneCacheKey,
  withSceneCache,
} from "@/lib/engine/sceneCache";
import {
  isCostBetaGenerationBilling,
  markGenerationBillingOperationFailed,
  markGenerationBillingProviderStarted,
  markGenerationBillingProviderSucceeded,
  prepareGenerationBilling,
  refundGenerationBilling,
  settleGenerationBilling,
  type GenerationBillingContext,
} from "@/lib/billing/generationGate";
import { assertCostBetaGeneratedCore } from "@/lib/billing/generationDelivery";
import type { PlatformOperation } from "@/lib/billing/platformCostEnvelope";
import { runInCostEnvelope } from "@/lib/billing/platformCostEnvelopeServer";
import { PricingUnavailableError } from "@/lib/billing/service";
import { requireUser } from "@/lib/supabase/guard";

const GENERATION_OPERATION: PlatformOperation = "story.start";

function formatSSE(event: SceneStreamEvent | { type: string; [k: string]: unknown }): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export const runtime = "nodejs";

// Matches /api/vision and /api/parse-style-image — the user's resized 512px
// webp is ~30-80 KB; this caps pathological direct-API payloads (which would
// then ride along in every subsequent /api/scene request body via session).
const MAX_STYLE_REF_BYTES = 3 * 1024 * 1024;

function newSessionId(): string {
  return `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function freshenCachedStartSession(result: StartResponse): StartResponse {
  if (result.cache?.status !== "hit") return result;
  return { ...result, sessionId: newSessionId() };
}

/**
 * Runs the actual engine callback for platform-managed generation.
 *
 * Only validated cost_beta_credit_v2 billing is wrapped in the cost envelope;
 * legacy/BYOK paths keep the original direct generate → mark → cache flow.
 * `config` must be the FULL trusted server runtime config (including TTS even
 * when the browser manages speech) so the envelope identity matches the
 * pricing runtime-binding hash; the engine callback receives its own
 * TTS-suppressed config.
 * Inside the envelope we generate and validate the essential core BEFORE any
 * generated result can be cached. Success is marked once, after the envelope
 * returns AND the image cache preparation succeeded, so a sticky post-callback
 * cap violation can never be reported as a successful delivery.
 */
async function runStartGeneration(
  billing: GenerationBillingContext,
  config: ReturnType<typeof loadEngineConfig>,
  generate: () => Promise<StartResponse>,
  costBetaBilling: boolean,
): Promise<StartResponse> {
  markGenerationBillingProviderStarted(billing);
  if (!costBetaBilling) {
    const generated = await generate();
    markGenerationBillingProviderSucceeded(billing);
    return cacheApiResponseImage(generated);
  }
  let generated: StartResponse;
  try {
    generated = await runInCostEnvelope(
      config,
      GENERATION_OPERATION,
      async () => {
        const result = await generate();
        assertCostBetaGeneratedCore(result);
        return result;
      },
    );
  } catch (error) {
    // Trusted internal engine/essential-output failure only. Settlement,
    // network and DB catches below never call this marker.
    markGenerationBillingOperationFailed(billing);
    throw error;
  }
  const cached = await cacheApiResponseImage(generated);
  markGenerationBillingProviderSucceeded(billing);
  return cached;
}

export async function POST(req: Request) {
  let body: StartRequest;
  try {
    body = (await req.json()) as StartRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (
    typeof body.worldSetting !== "string"
    || typeof body.styleGuide !== "string"
    || !body.worldSetting.trim()
    || !body.styleGuide.trim()
  ) {
    return NextResponse.json(
      { error: "worldSetting and styleGuide are required" },
      { status: 400 },
    );
  }
  if (
    (body.styleReferenceImage != null && typeof body.styleReferenceImage !== "string")
    || (body.playerName != null && typeof body.playerName !== "string")
    || (body.language != null && typeof body.language !== "string")
  ) {
    return NextResponse.json(
      { error: "Optional start fields have invalid types." },
      { status: 400 },
    );
  }
  if (typeof body.styleReferenceImage === "string") {
    if (!body.styleReferenceImage.startsWith("data:image/")) {
      return NextResponse.json(
        { error: "styleReferenceImage must be a data:image/... base64 URL" },
        { status: 400 },
      );
    }
    if (body.styleReferenceImage.length > MAX_STYLE_REF_BYTES) {
      return NextResponse.json(
        { error: `styleReferenceImage exceeds ${MAX_STYLE_REF_BYTES} bytes` },
        { status: 413 },
      );
    }
  }

  const hasByok = hasByokPayload(body.byo);
  const acceptsSSE = req.headers.get("accept")?.includes("text/event-stream");
  const cacheMeta = startSceneCacheKey(body);
  const cached = await peekSceneCache<StartResponse>(cacheMeta);
  if (cached) {
    const response = freshenCachedStartSession(cached);
    if (!acceptsSSE) return NextResponse.json(response);
    return new Response(
      formatSSE({ type: "done", response }),
      {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
        },
      },
    );
  }
  let config: ReturnType<typeof loadEngineConfig>;
  let engineConfig: ReturnType<typeof loadEngineConfig>;
  try {
    if (hasByok) assertCompleteByok(body.byo);
    config = hasByok
      ? buildByoEngineConfig(body.byo!, loadEngineConfig())
      : loadEngineConfig();
    // The full server-selected runtime config is the trusted identity for
    // platform pricing and the cost envelope: the operation runtime-binding
    // hash covers the whole configured role set (including the optional TTS
    // role). Client-managed speech only suppresses TTS for the actual engine,
    // so the engine config may drop `tts` while pricing/envelope keep it.
    engineConfig = body.clientTts === true
      ? { ...config, tts: undefined }
      : config;
  } catch {
    return NextResponse.json(
      {
        error: hasByok
          ? "Invalid BYO configuration."
          : "Generation provider unavailable.",
      },
      { status: hasByok ? 400 : 503 },
    );
  }
  const auth = await requireUser();
  if (auth instanceof NextResponse) return auth;
  const billing = await prepareGenerationBilling({
    request: req,
    auth,
    requestedMode: body.credentialMode,
    hasByok,
    runtimeConfig: config,
    operation: GENERATION_OPERATION,
  });
  if (billing instanceof NextResponse) return billing;
  let costBetaBilling = false;
  try {
    costBetaBilling = isCostBetaGenerationBilling(billing);
  } catch (error) {
    if (error instanceof PricingUnavailableError) {
      return NextResponse.json(
        { error: "Platform pricing unavailable.", code: error.code },
        { status: error.status },
      );
    }
    throw error;
  }

  try {
    if (!acceptsSSE) {
      try {
        const result = await withSceneCache(
          cacheMeta,
          "api/start",
          async () =>
            runStartGeneration(
              billing,
              config,
              () => startSession(engineConfig, body),
              costBetaBilling,
            ),
        );
        if (result.cache.status === "hit") {
          await refundGenerationBilling(
            billing,
            "Cache hit; reservation released.",
            { providerNotStarted: true },
          );
        } else {
          await settleGenerationBilling(billing, { requestSignal: req.signal });
        }
        return NextResponse.json(freshenCachedStartSession(result));
      } catch (error) {
        await refundGenerationBilling(billing, "Generation failed before settlement.");
        throw error;
      }
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          const emit = (event: SceneStreamEvent) => {
            controller.enqueue(encoder.encode(formatSSE(event)));
          };
          const result = await withSceneCache(
            cacheMeta,
            "api/start",
            async () =>
              runStartGeneration(
                billing,
                config,
                () => startSession(engineConfig, body, emit),
                costBetaBilling,
              ),
            emit,
          );
          if (result.cache.status === "hit") {
            await refundGenerationBilling(
              billing,
              "Cache hit; reservation released.",
              { providerNotStarted: true },
            );
          } else {
            await settleGenerationBilling(billing, { requestSignal: req.signal });
          }
          controller.enqueue(
            encoder.encode(
              formatSSE({ type: "done", response: freshenCachedStartSession(result) }),
            ),
          );
          controller.close();
        } catch {
          await refundGenerationBilling(
            billing,
            "Generation failed before settlement.",
          ).catch(() => undefined);
          controller.enqueue(
            encoder.encode(formatSSE({ type: "error", message: "Generation failed." })),
          );
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  } catch {
    await refundGenerationBilling(
      billing,
      "Generation failed before settlement.",
    ).catch(() => undefined);
    return NextResponse.json({ error: "Generation failed." }, { status: 500 });
  }
}
