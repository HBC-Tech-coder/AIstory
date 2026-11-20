import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/admin/security";
import { assertTrustedLoopbackMutation } from "@/lib/security/localMutation";
import {
  copyVideoStoryDraft,
  createVideoStoryDraft,
  listVideoStoryDrafts,
  videoStoryCapabilityStatus,
} from "@/lib/video-stories/server";

export const runtime = "nodejs";

function errorResponse(error: unknown): NextResponse {
  const message =
    error instanceof Error ? error.message : "视频剧情操作失败。";
  const unavailable = /未配置|未启用/.test(message);
  const safe =
    unavailable ||
    /项目 ID|作品 ID|标题|版本|幂等键|操作原因|源视频剧情/.test(message)
      ? message
      : "视频剧情操作失败。";
  return NextResponse.json(
    { error: safe },
    { status: unavailable ? 503 : 400 },
  );
}

export async function GET(): Promise<Response> {
  const actor = await requireAdmin();
  if (actor instanceof NextResponse) return actor;
  const capability = videoStoryCapabilityStatus(actor);
  if (!capability.available) {
    return NextResponse.json(
      { capability, drafts: [], assets: [] },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  try {
    return NextResponse.json(await listVideoStoryDrafts(actor), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  const actor = await requireAdmin(["super_admin", "ops", "moderator"]);
  if (actor instanceof NextResponse) return actor;
  try {
    if (actor.mode !== "local") {
      throw new Error("生产视频剧情仓储尚未配置。");
    }
    assertTrustedLoopbackMutation(request);
    const body = (await request.json()) as Record<string, unknown>;
    const baseInput = {
      id: typeof body.id === "string" ? body.id : undefined,
      projectId: body.projectId,
      storyId: body.storyId,
      title: body.title,
      summary: body.summary,
      version: body.version,
      orientation: body.orientation,
      reason: body.reason,
      idempotencyKey: request.headers.get("x-idempotency-key") || "",
      requestId: request.headers.get("x-request-id") || randomUUID(),
    };
    const result =
      body.action === "copy"
        ? await copyVideoStoryDraft(
            actor,
            String(body.sourceId || ""),
            baseInput,
          )
        : await createVideoStoryDraft(actor, baseInput);
    return NextResponse.json(result, {
      status: result.created ? 201 : 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

