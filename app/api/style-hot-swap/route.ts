import { chat } from "@infiplot/ai-client";
import type {
  Beat,
  StyleHotSwapRequest,
  StyleHotSwapResponse,
} from "@infiplot/types";
import { coerceOrientation } from "@infiplot/types";
import { NextResponse } from "next/server";

import { loadEngineConfig } from "@/lib/config";
import { runPainter } from "@/lib/engine/agents/painter";
import { parseJsonLoose } from "@/lib/engine/jsonParser";
import { isMockImageDataUri } from "@/lib/engine/mockImage";
import {
  peekStyleHotSwapCache,
  withStyleHotSwapCache,
} from "@/lib/engine/styleHotSwapCache";
import {
  applyExpressionRewrite,
  canonicalBeats,
  currentStyleCacheKeys,
} from "@/lib/styleHotSwap";
import { requireUser } from "@/lib/supabase/guard";
import {
  prepareGenerationBilling,
  refundGenerationBilling,
  settleGenerationBilling,
  type GenerationBillingContext,
} from "@/lib/billing/generationGate";
import { isAuthoredAiContinuationAllowed } from "@/lib/case-studies/schema";

export const runtime = "nodejs";

type RawRewrite = {
  beats?: Array<{
    id?: string;
    narration?: string;
    line?: string;
    lineDelivery?: string;
  }>;
};

export async function POST(req: Request) {
  let body: StyleHotSwapRequest;
  let billing: GenerationBillingContext | undefined;
  try {
    body = (await req.json()) as StyleHotSwapRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const session = body.session;
  const entry = session?.history.find((item) => item.scene.id === body.sceneId);
  if (!session || !entry) {
    return NextResponse.json({ error: "session and sceneId are required" }, { status: 400 });
  }
  if (
    body.action === "rewrite-current"
    && session.authoredStory?.authorLocked
    && !isAuthoredAiContinuationAllowed(session.authoredStory)
  ) {
    return NextResponse.json(
      { error: "作者锁定章节不允许 AI 改写原稿。" },
      { status: 409 },
    );
  }

  try {
    const config = loadEngineConfig();
    const keys = currentStyleCacheKeys(session, body.sceneId, config);
    if (body.action === "redraw-current") {
      const cached = await peekStyleHotSwapCache<{
        imageUrl: string;
        imageUuid?: string;
      }>(keys.imageKey);
      if (cached) {
        return NextResponse.json({
          action: "redraw-current",
          status: "ready",
          imageUrl: cached.imageUrl,
          imageUuid: cached.imageUuid,
          cacheStatus: "hit",
        } satisfies StyleHotSwapResponse);
      }
    } else {
      const cached = await peekStyleHotSwapCache<Beat[]>(keys.textKey);
      if (cached) {
        return NextResponse.json({
          action: "rewrite-current",
          status: "ready",
          beats: cached,
          cacheStatus: "hit",
        } satisfies StyleHotSwapResponse);
      }
    }
    const auth = await requireUser();
    if (auth instanceof NextResponse) return auth;
    const preparedBilling = await prepareGenerationBilling({
      request: req,
      auth,
      requestedMode: "platform_managed",
      hasByok: false,
      operation: body.action === "redraw-current"
        ? "style.redraw"
        : "style.rewrite",
    });
    if (preparedBilling instanceof NextResponse) return preparedBilling;
    billing = preparedBilling;

    if (body.action === "redraw-current") {
      const sourceBeats = canonicalBeats(entry.scene);
      const entryBeat = sourceBeats.find((beat) => beat.id === entry.scene.entryBeatId);
      const visibleNames = new Set(
        (entryBeat?.activeCharacters ?? []).map((character) => character.name),
      );
      if (entryBeat?.speaker && entryBeat.speaker !== "你") {
        visibleNames.add(entryBeat.speaker);
      }
      const onStageCharacters = session.characters.filter((character) =>
        visibleNames.has(character.name),
      );
      const result = await withStyleHotSwapCache(keys.imageKey, async () =>
        runPainter(
          config,
          {
            integratedPrompt: entry.scene.scenePrompt,
            styleGuide: session.styleGuide,
            onStageCharacters,
            styleReferenceImage: session.styleReferenceImage,
            orientation: coerceOrientation(session.orientation),
          },
          entryBeat,
        ),
      );
      if (isMockImageDataUri(result.data.imageUrl)) {
        await refundGenerationBilling(
          billing,
          "No billable image was produced; reservation released.",
        );
        const response: StyleHotSwapResponse = {
          action: "redraw-current",
          status: "image_pending",
          retryAfterMs: 4_000,
          cacheStatus: "miss",
        };
        return NextResponse.json(response, { status: 202 });
      }
      const response: StyleHotSwapResponse = {
        action: "redraw-current",
        status: "ready",
        imageUrl: result.data.imageUrl,
        imageUuid:
          result.data.kind === "real" ? result.data.imageUuid : undefined,
        cacheStatus: result.cacheStatus,
      };
      if (result.cacheStatus === "hit") {
        await refundGenerationBilling(billing, "Cache hit; reservation released.");
      } else {
        await settleGenerationBilling(billing);
      }
      return NextResponse.json(response);
    }

    const sourceBeats = canonicalBeats(entry.scene);
    const result = await withStyleHotSwapCache(keys.textKey, async () => {
      const raw = await chat(
        config.text,
        [
          {
            role: "system",
            content:
              "你只负责改写互动小说的表达。严格保持每个 beat 的 id、speaker、事实、人物关系、事件结果、选项语义和状态不变；不得新增、删除或重排 beat。玩家名必须继续写成 {{PLAYER_NAME}}。只返回 JSON：{\"beats\":[{\"id\",\"narration\",\"line\",\"lineDelivery\"}]}。",
          },
          {
            role: "user",
            content: `目标叙事文风：${session.narrativeStyle || "自动"}\n原始 canonical beats：${JSON.stringify(
              sourceBeats.map((beat) => ({
                id: beat.id,
                narration: beat.narration,
                speaker: beat.speaker,
                line: beat.line,
                lineDelivery: beat.lineDelivery,
                next: beat.next,
              })),
            )}`,
          },
        ],
        { temperature: 0.55, tag: "style-hot-swap-rewrite" },
      );
      const parsed = parseJsonLoose<RawRewrite>(raw);
      const rewritten = (parsed.beats ?? [])
        .filter((beat) => typeof beat.id === "string" && beat.id.length > 0)
        .map((beat) => ({
          id: beat.id!,
          narration: beat.narration,
          line: beat.line,
          lineDelivery: beat.lineDelivery,
        }));
      return applyExpressionRewrite(sourceBeats, rewritten);
    });
    const response: StyleHotSwapResponse = {
      action: "rewrite-current",
      status: "ready",
      beats: result.data,
      cacheStatus: result.cacheStatus,
    };
    if (result.cacheStatus === "hit") {
      await refundGenerationBilling(billing, "Cache hit; reservation released.");
    } else {
      await settleGenerationBilling(billing);
    }
    return NextResponse.json(response);
  } catch (error) {
    if (billing) {
      await refundGenerationBilling(
        billing,
        "Style generation failed before settlement.",
      ).catch(() => undefined);
    }
    const message = error instanceof Error ? error.message : "Style generation failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
