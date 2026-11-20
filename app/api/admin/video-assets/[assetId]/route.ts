import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/admin/security";
import { assertTrustedAdminMutation } from "@/lib/security/localMutation";
import { isVideoAssetUnavailableError } from "@/lib/video-assets/errors";
import { getRuntimeVideoAssetServiceOptions } from "@/lib/video-assets/production/runtime";
import { mutateAdminVideoAsset } from "@/lib/video-assets/server";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ assetId: string }> },
): Promise<Response> {
  const actor = await requireAdmin(["super_admin", "ops", "moderator"]);
  if (actor instanceof NextResponse) return actor;
  try {
    assertTrustedAdminMutation(request, actor.mode);
    const options = getRuntimeVideoAssetServiceOptions();
    const { assetId } = await context.params;
    const body = (await request.json()) as Record<string, unknown>;
    const result = await mutateAdminVideoAsset(actor, assetId, {
      action: String(body.action || "") as
        | "submit_review"
        | "approve"
        | "offline"
        | "restore_draft"
        | "bind",
      reason: String(body.reason || ""),
      projectId: body.projectId ? Number(body.projectId) : undefined,
      storyId: typeof body.storyId === "string" ? body.storyId : undefined,
      nodeId: typeof body.nodeId === "string" ? body.nodeId : undefined,
      releasePolicy: body.releasePolicy as
        | "public"
        | "internal"
        | "enterprise"
        | undefined,
      title: typeof body.title === "string" ? body.title : undefined,
      idempotencyKey: request.headers.get("x-idempotency-key") || "",
      requestId: request.headers.get("x-request-id") || randomUUID(),
    }, options);
    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const unavailable = isVideoAssetUnavailableError(error);
    return NextResponse.json(
      {
        error: unavailable
          ? "视频资产服务暂不可用。"
          : "视频资产请求不合法或操作失败。",
      },
      { status: unavailable ? 503 : 400 },
    );
  }
}

