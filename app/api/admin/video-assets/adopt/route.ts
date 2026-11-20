import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/admin/security";
import { assertTrustedAdminMutation } from "@/lib/security/localMutation";
import { isVideoAssetUnavailableError } from "@/lib/video-assets/errors";
import { adoptGenerationVideoAsset } from "@/lib/video-assets/server";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const actor = await requireAdmin(["super_admin", "ops", "moderator"]);
  if (actor instanceof NextResponse) return actor;
  try {
    assertTrustedAdminMutation(request, actor.mode);
    const body = (await request.json()) as Record<string, unknown>;
    const result = await adoptGenerationVideoAsset(actor, {
      jobId: String(body.jobId || ""),
      title: String(body.title || ""),
      projectId: body.projectId ? Number(body.projectId) : undefined,
      storyId: typeof body.storyId === "string" ? body.storyId : undefined,
      nodeId: typeof body.nodeId === "string" ? body.nodeId : undefined,
      releasePolicy:
        (body.releasePolicy as "public" | "internal" | "enterprise") ||
        "public",
      cues: body.cues,
      webVtt: typeof body.webVtt === "string" ? body.webVtt : undefined,
      idempotencyKey: request.headers.get("x-idempotency-key") || "",
      requestId: request.headers.get("x-request-id") || randomUUID(),
    });
    return NextResponse.json(result, {
      status: result.created ? 201 : 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const unavailable = isVideoAssetUnavailableError(error);
    return NextResponse.json(
      {
        error: unavailable
          ? "视频资产服务暂不可用。"
          : "视频任务纳管请求不合法或操作失败。",
      },
      { status: unavailable ? 503 : 400 },
    );
  }
}

