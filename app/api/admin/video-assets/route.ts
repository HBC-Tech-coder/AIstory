import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/admin/security";
import { assertTrustedAdminMutation } from "@/lib/security/localMutation";
import { isVideoAssetUnavailableError } from "@/lib/video-assets/errors";
import { getRuntimeVideoAssetServiceOptions } from "@/lib/video-assets/production/runtime";
import {
  listAdminVideoAssets,
  uploadAdminVideoAsset,
  videoAssetCapabilityStatus,
  videoAssetMaxUploadBytes,
} from "@/lib/video-assets/server";

export const runtime = "nodejs";

function errorResponse(error: unknown, unavailable = false): NextResponse {
  const serviceUnavailable = unavailable || isVideoAssetUnavailableError(error);
  return NextResponse.json(
    {
      error: serviceUnavailable
        ? "视频资产服务暂不可用。"
        : "视频资产请求不合法或操作失败。",
    },
    { status: serviceUnavailable ? 503 : 400 },
  );
}

export async function GET(): Promise<Response> {
  const actor = await requireAdmin();
  if (actor instanceof NextResponse) return actor;
  try {
    const options = getRuntimeVideoAssetServiceOptions();
    const capability = videoAssetCapabilityStatus(actor, options);
    if (!capability.available) {
      return NextResponse.json(
        { capability, assets: [] },
        {
          status: actor.mode === "production" ? 503 : 200,
          headers: { "Cache-Control": "no-store" },
        },
      );
    }
    return NextResponse.json(
      { capability, assets: await listAdminVideoAssets(actor, options) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error, true);
  }
}

export async function POST(request: Request): Promise<Response> {
  const actor = await requireAdmin(["super_admin", "ops", "moderator"]);
  if (actor instanceof NextResponse) return actor;
  try {
    assertTrustedAdminMutation(request, actor.mode);
    const options = getRuntimeVideoAssetServiceOptions();
    if (!videoAssetCapabilityStatus(actor, options).uploadAvailable) {
      return errorResponse(new Error("VIDEO_ASSET_UNAVAILABLE"), true);
    }
    const maxBytes = videoAssetMaxUploadBytes();
    const contentLength = Number(request.headers.get("content-length"));
    if (
      !Number.isFinite(contentLength) ||
      contentLength <= 0 ||
      contentLength > maxBytes + 1024 * 1024
    ) {
      return NextResponse.json(
        { error: "上传请求为空或超过大小限制。" },
        { status: 413 },
      );
    }
    const idempotencyKey = request.headers.get("x-idempotency-key") || "";
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "缺少视频文件。" }, { status: 400 });
    }
    if (file.size <= 0 || file.size > maxBytes) {
      return NextResponse.json(
        { error: "视频为空或超过上传大小限制。" },
        { status: 413 },
      );
    }
    const subtitle = form.get("subtitle");
    let webVtt: string | undefined;
    if (subtitle instanceof File && subtitle.size > 0) {
      if (
        subtitle.type !== "text/vtt" ||
        subtitle.size > 512 * 1024
      ) {
        return NextResponse.json(
          { error: "字幕只支持不超过 512KB 的 WebVTT。" },
          { status: 400 },
        );
      }
      webVtt = await subtitle.text();
    } else if (typeof subtitle === "string" && subtitle.trim()) {
      webVtt = subtitle;
    }
    const cuesRaw = form.get("cues");
    let cues: unknown;
    if (typeof cuesRaw === "string" && cuesRaw.trim()) {
      try {
        cues = JSON.parse(cuesRaw);
      } catch {
        return NextResponse.json(
          { error: "结构化字幕 JSON 不合法。" },
          { status: 400 },
        );
      }
    }
    const result = await uploadAdminVideoAsset(actor, {
      bytes: new Uint8Array(await file.arrayBuffer()),
      declaredType: file.type,
      title: String(form.get("title") || ""),
      projectId: form.get("projectId")
        ? Number(form.get("projectId"))
        : undefined,
      storyId: String(form.get("storyId") || "") || undefined,
      nodeId: String(form.get("nodeId") || "") || undefined,
      releasePolicy:
        (String(form.get("releasePolicy") || "public") as
          | "public"
          | "internal"
          | "enterprise"),
      cues,
      webVtt,
      idempotencyKey,
      requestId: request.headers.get("x-request-id") || randomUUID(),
    }, options);
    return NextResponse.json(result, {
      status: result.created ? 201 : 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

