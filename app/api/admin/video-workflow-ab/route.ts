import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/admin/security";
import { assertTrustedLoopbackMutation } from "@/lib/security/localMutation";
import {
  importVideoWorkflowABExperiment,
  listVideoWorkflowABExperiments,
  videoWorkflowABCapabilityStatus,
} from "@/lib/video-workflow-ab/server";

export const runtime = "nodejs";

function safeError(error: unknown): NextResponse {
  const message = error instanceof Error ? error.message : "";
  const unavailable = /not configured|not enabled/.test(message);
  const conflict = /Idempotency key conflicts|already exists/.test(message);
  return NextResponse.json(
    {
      error: unavailable
        ? "A/B 实验仓储或视频探测器尚未配置。"
        : conflict
          ? "幂等键已用于不同的 A/B 操作。"
          : "A/B 回传包校验或导入失败。",
    },
    { status: unavailable ? 503 : conflict ? 409 : 400 },
  );
}

export async function GET(): Promise<Response> {
  const actor = await requireAdmin();
  if (actor instanceof NextResponse) return actor;
  const capability = videoWorkflowABCapabilityStatus(actor);
  if (!capability.available) {
    return NextResponse.json(
      { capability, experiments: [] },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  try {
    return NextResponse.json(
      {
        capability,
        experiments: await listVideoWorkflowABExperiments(actor),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return safeError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  const actor = await requireAdmin(["super_admin", "ops", "moderator"]);
  if (actor instanceof NextResponse) return actor;
  try {
    if (actor.mode !== "local") {
      throw new Error("Production A/B experiment repository is not configured.");
    }
    assertTrustedLoopbackMutation(request);
    const capability = videoWorkflowABCapabilityStatus(actor);
    if (!capability.available) {
      throw new Error("Local A/B experiment repository is not enabled.");
    }
    const contentLength = Number(request.headers.get("content-length"));
    if (
      !Number.isFinite(contentLength) ||
      contentLength <= 0 ||
      contentLength > capability.maxPackageBytes + 1024 * 1024
    ) {
      return NextResponse.json(
        { error: "A/B 回传包为空或超过大小限制。" },
        { status: 413 },
      );
    }
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "缺少 A/B ZIP 回传包。" }, { status: 400 });
    }
    if (file.size <= 0 || file.size > capability.maxPackageBytes) {
      return NextResponse.json(
        { error: "A/B 回传包为空或超过大小限制。" },
        { status: 413 },
      );
    }
    const result = await importVideoWorkflowABExperiment(
      actor,
      {
        packageBytes: new Uint8Array(await file.arrayBuffer()),
        reason: String(form.get("reason") || ""),
        idempotencyKey: request.headers.get("x-idempotency-key") || "",
        requestId: request.headers.get("x-request-id") || randomUUID(),
      },
    );
    return NextResponse.json(result, {
      status: result.created ? 201 : 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return safeError(error);
  }
}
