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
  prepareGenerationBilling,
  refundGenerationBilling,
  settleGenerationBilling,
} from "@/lib/billing/generationGate";

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
  const auth = await requireUser();
  if (auth instanceof NextResponse) return auth;
  const billing = await prepareGenerationBilling({
    request: req,
    auth,
    requestedMode: body.credentialMode,
    hasByok: hasByo,
    operation: body.speculation?.mode === "prefetch"
      ? "story.scene.prefetch"
      : "story.scene",
  });
  if (billing instanceof NextResponse) return billing;

  try {
    if (hasByo) assertCompleteByok(body.byo);
    const base = hasByo
      ? buildByoEngineConfig(body.byo!, loadEngineConfig())
      : loadEngineConfig();
    const config = body.clientTts === true ? { ...base, tts: undefined } : base;
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
                cacheApiResponseImage(
                  await requestScene(config, body, observe),
                ),
            ),
        );
        if (result.cache?.status === "hit") {
          await refundGenerationBilling(billing, "Cache hit; reservation released.");
        } else {
          await settleGenerationBilling(billing);
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
                  cacheApiResponseImage(
                    await requestScene(config, body, (event) => {
                      observe(event);
                      emit(event);
                    }),
                  ),
                emit,
              ),
          );
          if (result.cache?.status === "hit") {
            await refundGenerationBilling(billing, "Cache hit; reservation released.");
          } else {
            await settleGenerationBilling(billing);
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
        } catch (err) {
          await refundGenerationBilling(
            billing,
            "Generation failed before settlement.",
          ).catch(() => undefined);
          const message = err instanceof Error ? err.message : "Unknown error";
          controller.enqueue(
            encoder.encode(formatSSE({ type: "error", message })),
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
  } catch (err) {
    await refundGenerationBilling(
      billing,
      "Generation failed before settlement.",
    ).catch(() => undefined);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
