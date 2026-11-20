import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/admin/security";
import { assertTrustedLoopbackMutation } from "@/lib/security/localMutation";
import {
  adoptApprovedVideoWorkflowABRun,
  mutateVideoWorkflowABExperiment,
  type VideoWorkflowABMutationInput,
} from "@/lib/video-workflow-ab/server";
import type { VideoWorkflowABReviewScores } from "@/lib/video-workflow-ab/types";

export const runtime = "nodejs";

function safeError(error: unknown): NextResponse {
  const message = error instanceof Error ? error.message : "";
  const unavailable = /not configured|not enabled/.test(message);
  const conflict = /Idempotency key conflicts/.test(message);
  const state = /Only |must be|requires|cannot|changed before/.test(message);
  return NextResponse.json(
    {
      error: unavailable
        ? "A/B 实验仓储尚未配置。"
        : conflict
          ? "幂等键已用于不同的 A/B 操作。"
          : state
            ? "当前 A/B 实验状态不允许此操作。"
            : "A/B 实验操作失败。",
    },
    { status: unavailable ? 503 : conflict ? 409 : 400 },
  );
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ experimentId: string }> },
): Promise<Response> {
  const actor = await requireAdmin(["super_admin", "ops", "moderator"]);
  if (actor instanceof NextResponse) return actor;
  try {
    if (actor.mode !== "local") {
      throw new Error("Production A/B experiment repository is not configured.");
    }
    assertTrustedLoopbackMutation(request);
    const { experimentId } = await context.params;
    const body = (await request.json()) as Record<string, unknown>;
    const common = {
      reason: String(body.reason || ""),
      idempotencyKey: request.headers.get("x-idempotency-key") || "",
      requestId: request.headers.get("x-request-id") || randomUUID(),
    };
    if (body.action === "adopt") {
      return NextResponse.json(
        await adoptApprovedVideoWorkflowABRun(actor, experimentId, common),
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    const action = String(body.action || "");
    let mutation: VideoWorkflowABMutationInput;
    if (action === "review_run") {
      mutation = {
        action,
        blindRunId: String(body.blindRunId || ""),
        scores: body.scores as VideoWorkflowABReviewScores,
        note: typeof body.note === "string" ? body.note : "",
      };
    } else if (action === "approve") {
      mutation = {
        action,
        blindRunId: String(body.blindRunId || ""),
      };
    } else if (
      action === "finalize_review" ||
      action === "reveal" ||
      action === "reject" ||
      action === "offline"
    ) {
      mutation = { action };
    } else {
      return NextResponse.json(
        { error: "A/B 实验操作不受支持。" },
        { status: 400 },
      );
    }
    return NextResponse.json(
      await mutateVideoWorkflowABExperiment(actor, experimentId, {
        ...mutation,
        ...common,
      }),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return safeError(error);
  }
}
