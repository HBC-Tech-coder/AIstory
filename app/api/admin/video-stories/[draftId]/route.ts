import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/admin/security";
import { assertTrustedLoopbackMutation } from "@/lib/security/localMutation";
import {
  listVideoStoryDrafts,
  saveVideoStoryDraft,
  transitionVideoStoryDraft,
  validateStoredVideoStoryDraft,
} from "@/lib/video-stories/server";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ draftId: string }>;
};

function errorResponse(error: unknown): NextResponse {
  const message =
    error instanceof Error ? error.message : "视频剧情操作失败。";
  const unavailable = /未配置|未启用/.test(message);
  const safe =
    unavailable ||
    /不存在|不合法|不能为空|至少|草稿|审核|发布|下线|节点|选项|字幕|视频资产|死路|起点|终局|不可达/.test(
      message,
    )
      ? message
      : "视频剧情操作失败。";
  return NextResponse.json(
    { error: safe },
    { status: unavailable ? 503 : 400 },
  );
}

export async function GET(
  _request: Request,
  context: RouteContext,
): Promise<Response> {
  const actor = await requireAdmin();
  if (actor instanceof NextResponse) return actor;
  try {
    const { draftId } = await context.params;
    const result = await listVideoStoryDrafts(actor);
    const draft = result.drafts.find((item) => item.id === draftId);
    if (!draft) {
      return NextResponse.json(
        { error: "视频剧情不存在。" },
        { status: 404 },
      );
    }
    return NextResponse.json(
      { capability: result.capability, draft, assets: result.assets },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const actor = await requireAdmin(["super_admin", "ops", "moderator"]);
  if (actor instanceof NextResponse) return actor;
  try {
    if (actor.mode !== "local") {
      throw new Error("生产视频剧情仓储尚未配置。");
    }
    assertTrustedLoopbackMutation(request);
    const { draftId } = await context.params;
    const body = (await request.json()) as Record<string, unknown>;
    const idempotencyKey =
      request.headers.get("x-idempotency-key") || "";
    const requestId = request.headers.get("x-request-id") || randomUUID();
    if (body.action === "validate") {
      return NextResponse.json(
        { validation: await validateStoredVideoStoryDraft(actor, draftId) },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    if (body.action === "save") {
      const result = await saveVideoStoryDraft(actor, draftId, {
        title: body.title,
        summary: body.summary,
        version: body.version,
        orientation: body.orientation,
        startNodeId: body.startNodeId,
        variables: body.variables,
        nodes: body.nodes,
        reason: body.reason,
        idempotencyKey,
        requestId,
      });
      return NextResponse.json(result, {
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (
      body.action !== "submit_review" &&
      body.action !== "publish" &&
      body.action !== "offline"
    ) {
      return NextResponse.json(
        { error: "视频剧情操作不受支持。" },
        { status: 400 },
      );
    }
    const result = await transitionVideoStoryDraft(actor, draftId, {
      action: body.action,
      reason: body.reason,
      idempotencyKey,
      requestId,
    });
    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

