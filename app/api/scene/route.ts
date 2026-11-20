import { requestScene } from "@infiplot/engine";
import type {
  Character,
  SceneRequest,
  SceneResponse,
  SceneStreamEvent,
} from "@infiplot/types";
import { NextResponse } from "next/server";
import { buildByoEngineConfig, loadEngineConfig } from "@/lib/config";
import {
  assertCompleteByok,
  hasByokPayload,
} from "@/lib/credentials/serverPolicy";
import { cacheApiResponseImage } from "@/lib/engine/mediaCache";
import {
  nextSceneCacheKey,
  peekSceneCache,
  withSceneCache,
} from "@/lib/engine/sceneCache";
import {
  getSpeculativeBranchContext,
  rejectSpeculativeRequest,
  withSpeculativeBranchCache,
} from "@/lib/engine/speculativeBranchCache";
import { requireUser } from "@/lib/supabase/guard";
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
import { isAuthoredAiContinuationAllowed } from "@/lib/case-studies/schema";
import {
  logSceneGenerationFailure,
  type SceneFailureStage,
} from "@/lib/engine/sceneFailureDiagnostic";

/**
 * Server-owned failure stages for the platform generation boundary below.
 * These constants (never the thrown value) decide what the diagnostic records.
 */
const SCENE_FAILURE_STAGE = {
  engine: "engine_generation",
  assertCore: "core_validation",
  envelope: "cost_envelope",
} as const satisfies Record<string, SceneFailureStage>;

function stripKnownVoices(
  characters: Character[],
  knownNames: Set<string>,
): Character[] {
  return characters.map((c) =>
    knownNames.has(c.name) ? { ...c, voice: undefined } : c,
  );
}

function formatSSE(event: SceneStreamEvent | { type: string; [k: string]: unknown }): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * Runs the actual scene engine callback for platform-managed generation.
 *
 * Only validated cost_beta_credit_v2 billing is wrapped in the cost envelope;
 * legacy/BYOK paths keep the original direct generate → mark → cache flow.
 * `config` must be the FULL trusted server runtime config (including TTS even
 * when the browser manages speech) so the envelope identity matches the
 * pricing runtime-binding hash; the engine callback receives its own
 * TTS-suppressed config.
 * The essential core is validated inside the envelope BEFORE any generated
 * result may be cached, and success is marked once after the envelope returns
 * and image cache preparation succeeds. A sticky post-callback cap violation
 * therefore cannot be reported as a successful delivery.
 */
async function runSceneGeneration(
  billing: GenerationBillingContext,
  config: ReturnType<typeof loadEngineConfig>,
  operation: PlatformOperation,
  generate: () => Promise<SceneResponse>,
  costBetaBilling: boolean,
): Promise<SceneResponse> {
  markGenerationBillingProviderStarted(billing);
  if (!costBetaBilling) {
    const generated = await generate();
    markGenerationBillingProviderSucceeded(billing);
    return cacheApiResponseImage(generated);
  }
  let generated: SceneResponse;
  // Updated at the exact failure point, reset after the essential-core check
  // so a sticky post-callback envelope violation is attributed to the
  // envelope rather than to a successfully returned callback.
  let failureStage: SceneFailureStage = SCENE_FAILURE_STAGE.envelope;
  try {
    generated = await runInCostEnvelope(
      config,
      operation,
      async () => {
        failureStage = SCENE_FAILURE_STAGE.engine;
        const result = await generate();
        failureStage = SCENE_FAILURE_STAGE.assertCore;
        assertCostBetaGeneratedCore(result);
        failureStage = SCENE_FAILURE_STAGE.envelope;
        return result;
      },
    );
  } catch (error) {
    // Trusted internal engine/essential-output failure only. Settlement,
    // network and DB catches below never call this marker.
    logSceneGenerationFailure(failureStage, error);
    markGenerationBillingOperationFailed(billing);
    throw error;
  }
  const cached = await cacheApiResponseImage(generated);
  markGenerationBillingProviderSucceeded(billing);
  return cached;
}

export const runtime = "nodejs";

export async function POST(req: Request) {
  let body: SceneRequest;
  try {
    body = (await req.json()) as SceneRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.session) {
    return NextResponse.json({ error: "session is required" }, { status: 400 });
  }
  if (
    body.session.authoredStory?.authorLocked
    && !isAuthoredAiContinuationAllowed(body.session.authoredStory)
  ) {
    return NextResponse.json(
      { error: "作者锁定章节不允许请求 AI 场景生成。" },
      { status: 409 },
    );
  }

  const hasByo = hasByokPayload(body.byo);
  const speculativeRejection = rejectSpeculativeRequest(body.speculation);
  if (speculativeRejection) {
    return NextResponse.json(
      { error: `Speculative prefetch rejected: ${speculativeRejection}` },
      { status: 429, headers: { "Retry-After": "1" } },
    );
  }
  const acceptsSSE = req.headers.get("accept")?.includes("text/event-stream");
  const cacheMeta = nextSceneCacheKey(body.session, hasByo);
  const cached = await peekSceneCache<SceneResponse>(cacheMeta);
  if (cached) {
    const knownNames = new Set(
      (body.session.characters ?? []).map((character) => character.name),
    );
    const response = {
      ...cached,
      characters: stripKnownVoices(cached.characters, knownNames),
    };
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
    if (hasByo) assertCompleteByok(body.byo);
    config = hasByo
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
        error: hasByo
          ? "Invalid BYO configuration."
          : "Generation provider unavailable.",
      },
      { status: hasByo ? 400 : 503 },
    );
  }
  const auth = await requireUser();
  if (auth instanceof NextResponse) return auth;
  const sceneOperation = body.speculation?.mode === "prefetch"
    ? "story.scene.prefetch"
    : "story.scene";
  const billing = await prepareGenerationBilling({
    request: req,
    auth,
    requestedMode: body.credentialMode,
    hasByok: hasByo,
    runtimeConfig: config,
    operation: sceneOperation,
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
    const speculativeContext = getSpeculativeBranchContext(
      body.session,
      config,
      body.speculation,
    );

    if (!acceptsSSE) {
      try {
        const result = await withSpeculativeBranchCache(
          speculativeContext,
          async (observe) =>
            withSceneCache(
              cacheMeta,
              "api/scene",
              async () =>
                runSceneGeneration(
                  billing,
                  config,
                  sceneOperation,
                  () => requestScene(engineConfig, body, observe),
                  costBetaBilling,
                ),
            ),
        );
        if (billing.providerOutcome === "not_started") {
          await refundGenerationBilling(
            billing,
            "Cache hit; reservation released.",
            { providerNotStarted: true },
          );
        } else {
          await settleGenerationBilling(billing, { requestSignal: req.signal });
        }
        const knownNames = new Set(
          (body.session.characters ?? []).map((c) => c.name),
        );
        return NextResponse.json({
          ...result,
          characters: stripKnownVoices(result.characters, knownNames),
        });
      } catch (error) {
        await refundGenerationBilling(
          billing,
          "Generation failed before settlement.",
        );
        throw error;
      }
    }

    const encoder = new TextEncoder();
    const knownNames = new Set(
      (body.session.characters ?? []).map((c) => c.name),
    );

    const stream = new ReadableStream({
      async start(controller) {
        try {
          const emit = (event: SceneStreamEvent) => {
            controller.enqueue(encoder.encode(formatSSE(event)));
          };
          const result = await withSpeculativeBranchCache(
            speculativeContext,
            async (observe) =>
              withSceneCache(
                cacheMeta,
                "api/scene",
                async () =>
                  runSceneGeneration(
                    billing,
                    config,
                    sceneOperation,
                    () =>
                      requestScene(
                        engineConfig,
                        body,
                        (event) => {
                          observe(event);
                          emit(event);
                        },
                      ),
                    costBetaBilling,
                  ),
                emit,
              ),
          );
          if (billing.providerOutcome === "not_started") {
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
              formatSSE({
                type: "done",
                response: {
                  ...result,
                  characters: stripKnownVoices(result.characters, knownNames),
                },
              }),
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
