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
  prepareGenerationBilling,
  refundGenerationBilling,
  settleGenerationBilling,
} from "@/lib/billing/generationGate";
import { requireUser } from "@/lib/supabase/guard";

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

export async function POST(req: Request) {
  let body: StartRequest;
  try {
    body = (await req.json()) as StartRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.worldSetting?.trim() || !body.styleGuide?.trim()) {
    return NextResponse.json(
      { error: "worldSetting and styleGuide are required" },
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
  const auth = await requireUser();
  if (auth instanceof NextResponse) return auth;
  const billing = await prepareGenerationBilling({
    request: req,
    auth,
    requestedMode: body.credentialMode,
    hasByok,
    operation: "story.start",
  });
  if (billing instanceof NextResponse) return billing;

  try {
    if (hasByok) assertCompleteByok(body.byo);
    const base = hasByok
      ? buildByoEngineConfig(body.byo!, loadEngineConfig())
      : loadEngineConfig();
    const config = body.clientTts === true ? { ...base, tts: undefined } : base;

    if (!acceptsSSE) {
      try {
        const result = await withSceneCache(
          cacheMeta,
          "api/start",
          async () => cacheApiResponseImage(await startSession(config, body)),
        );
        if (result.cache.status === "hit") {
          await refundGenerationBilling(billing, "Cache hit; reservation released.");
        } else {
          await settleGenerationBilling(billing);
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
            async () => cacheApiResponseImage(await startSession(config, body, emit)),
            emit,
          );
          if (result.cache.status === "hit") {
            await refundGenerationBilling(billing, "Cache hit; reservation released.");
          } else {
            await settleGenerationBilling(billing);
          }
          controller.enqueue(
            encoder.encode(
              formatSSE({ type: "done", response: freshenCachedStartSession(result) }),
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
