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
  markGenerationBillingOperationFailed,
  markGenerationBillingProviderStarted,
  markGenerationBillingProviderSucceeded,
  prepareGenerationBilling,
  refundGenerationBilling,
  settleGenerationBilling,
  type GenerationBillingContext,
} from "@/lib/billing/generationGate";
import { runInCostEnvelope } from "@/lib/billing/platformCostEnvelopeServer";
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

type NormalizedRewrite = {
  id: string;
  narration?: string;
  line?: string;
  lineDelivery?: string;
};

const REWRITE_FIELDS = ["narration", "line", "lineDelivery"] as const;

/**
 * Structural validation for v2 rewrite output. Throws when the payload is
 * malformed (non-array beats, non-object beats, duplicate beat ids, non-string
 * prose fields) so callers can treat it as unusable instead of trusting it.
 *
 * Duplicate ids are rejected because applyExpressionRewrite collapses entries
 * through a Map (last one wins). A changed duplicate followed by an unchanged
 * one would otherwise look useful here while the delivered rewrite silently
 * kept the original prose.
 */
function normalizeRewrite(parsed: RawRewrite): NormalizedRewrite[] {
  const beats = (parsed as { beats?: unknown }).beats;
  if (beats === undefined) return [];
  if (!Array.isArray(beats)) {
    throw new Error("malformed style rewrite");
  }
  const normalized: NormalizedRewrite[] = [];
  const seenIds = new Set<string>();
  for (const rawBeat of beats) {
    if (!rawBeat || typeof rawBeat !== "object") {
      throw new Error("malformed style rewrite");
    }
    const record = rawBeat as Record<string, unknown>;
    if (typeof record.id !== "string" || record.id.length === 0) continue;
    if (seenIds.has(record.id)) {
      throw new Error("duplicate style rewrite beat id");
    }
    seenIds.add(record.id);
    const entry: NormalizedRewrite = { id: record.id };
    for (const field of REWRITE_FIELDS) {
      const value = record[field];
      if (value !== undefined && typeof value !== "string") {
        throw new Error("malformed style rewrite");
      }
      entry[field] = value;
    }
    normalized.push(entry);
  }
  return normalized;
}

/**
 * A rewrite is only useful when it maps onto a canonical beat id and actually
 * changes at least one of narration/line/lineDelivery to a different,
 * non-whitespace value. Same-value and whitespace-only edits do not count.
 */
function hasUsefulRewrite(
  canonical: Beat[],
  rewritten: NormalizedRewrite[],
): boolean {
  const byId = new Map<string, Beat>();
  for (const beat of canonical) byId.set(beat.id, beat);
  for (const candidate of rewritten) {
    const original = byId.get(candidate.id);
    if (!original) continue;
    for (const field of REWRITE_FIELDS) {
      const next = candidate[field];
      if (typeof next !== "string") continue;
      const trimmed = next.trim();
      if (!trimmed) continue;
      const previous = original[field];
      if (trimmed !== (typeof previous === "string" ? previous.trim() : "")) {
        return true;
      }
    }
  }
  return false;
}

export async function POST(req: Request) {
  let body: StyleHotSwapRequest;
  let billingContext: GenerationBillingContext | undefined;
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
    session.authoredStory?.authorLocked
    && !isAuthoredAiContinuationAllowed(session.authoredStory)
  ) {
    return NextResponse.json(
      { error: "作者锁定章节不允许 AI 重绘或改写原稿。" },
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
    if (body.action === "redraw-current" && config.mockImage) {
      return NextResponse.json(
        {
          action: "redraw-current",
          status: "image_pending",
          retryAfterMs: 4_000,
          cacheStatus: "miss",
        } satisfies StyleHotSwapResponse,
        { status: 202 },
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
      operation: body.action === "redraw-current"
        ? "style.redraw"
        : "style.rewrite",
    });
    if (preparedBilling instanceof NextResponse) return preparedBilling;
    billingContext = preparedBilling;
    const billing: GenerationBillingContext = preparedBilling;

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
      const result = await withStyleHotSwapCache(keys.imageKey, async () => {
        const generate = async () => {
          return await runPainter(
            config,
            {
              integratedPrompt: entry.scene.scenePrompt,
              styleGuide: session.styleGuide,
              onStageCharacters,
              styleReferenceImage: session.styleReferenceImage,
              orientation: coerceOrientation(session.orientation),
            },
            entryBeat,
            {
              onProviderStarted: () => {
                markGenerationBillingProviderStarted(billing!);
              },
            },
          );
        };
        let generated: Awaited<ReturnType<typeof runPainter>>;
        try {
          if (billing.reservation?.catalogEntry.pricingMode === "cost_beta_credit_v2") {
            generated = await runInCostEnvelope(config, "style.redraw", generate);
          } else {
            generated = await generate();
          }
        } catch (error) {
          markGenerationBillingOperationFailed(billing!);
          throw error;
        }
        if (!isMockImageDataUri(generated.imageUrl)) {
          markGenerationBillingProviderSucceeded(billing!);
        } else {
          markGenerationBillingOperationFailed(billing!);
        }
        return generated;
      });
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
        await refundGenerationBilling(
          billing,
          "Cache hit; reservation released.",
          { providerNotStarted: true },
        );
      } else {
        await settleGenerationBilling(billing, { requestSignal: req.signal });
      }
      return NextResponse.json(response);
    }

    const sourceBeats = canonicalBeats(entry.scene);
    const result = await withStyleHotSwapCache(keys.textKey, async () => {
      const generate = async () => {
        markGenerationBillingProviderStarted(billing!);
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
        return raw;
      };
      const isV2 = billing.reservation?.catalogEntry.pricingMode === "cost_beta_credit_v2";
      let raw: string;
      try {
        if (isV2) {
          raw = await runInCostEnvelope(config, "style.rewrite", generate);
        } else {
          raw = await generate();
        }
      } catch (error) {
        markGenerationBillingOperationFailed(billing!);
        throw error;
      }

      // v2 only settles a rewrite that maps to canonical beats and actually
      // changes usable prose. Throwing here prevents the unusable raw model
      // response from being written into the style cache.
      let normalized: NormalizedRewrite[] = [];
      let v2Unusable = false;
      if (isV2) {
        try {
          const parsed = parseJsonLoose<RawRewrite>(raw);
          normalized = normalizeRewrite(parsed);
          v2Unusable = !hasUsefulRewrite(sourceBeats, normalized);
        } catch {
          v2Unusable = true;
        }
      }
      if (!isV2 || !v2Unusable) {
        markGenerationBillingProviderSucceeded(billing!);
      }
      if (isV2) {
        if (v2Unusable) {
          // Trusted failed-not-delivered intent; the broad route catch refunds.
          markGenerationBillingOperationFailed(billing!);
          throw new Error("Unusable style rewrite output");
        }
        return applyExpressionRewrite(sourceBeats, normalized);
      }
      // Legacy/v1 keeps the historical success-before-parse ordering and still
      // caches an unusable rewrite.
      const legacyParsed = parseJsonLoose<RawRewrite>(raw);
      const legacyRewritten = (legacyParsed.beats ?? [])
        .filter((beat) => typeof beat.id === "string" && beat.id.length > 0)
        .map((beat) => ({
          id: beat.id!,
          narration: beat.narration,
          line: beat.line,
          lineDelivery: beat.lineDelivery,
        }));
      return applyExpressionRewrite(sourceBeats, legacyRewritten);
    });
    const response: StyleHotSwapResponse = {
      action: "rewrite-current",
      status: "ready",
      beats: result.data,
      cacheStatus: result.cacheStatus,
    };
    if (result.cacheStatus === "hit") {
      await refundGenerationBilling(
        billing,
        "Cache hit; reservation released.",
        { providerNotStarted: true },
      );
    } else {
      await settleGenerationBilling(billing, { requestSignal: req.signal });
    }
    return NextResponse.json(response);
  } catch {
    if (billingContext) {
      await refundGenerationBilling(
        billingContext,
        "Style generation failed before settlement.",
      ).catch(() => undefined);
    }
    return NextResponse.json({ error: "Style generation failed." }, { status: 500 });
  }
}
