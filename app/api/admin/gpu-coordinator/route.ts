import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/admin/security";
import {
  cancelConfiguredLanGpuJob,
  configuredLanGpuAdminStatus,
  configuredLanGpuWorkflows,
  inspectLanGpuCoordinatorEnvironment,
  submitConfiguredLanGpuVideoJob,
} from "@/lib/gpu-coordinator/server";
import { assertTrustedLoopbackMutation } from "@/lib/security/localMutation";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const actor = await requireAdmin(["super_admin", "ops"]);
  if (actor instanceof NextResponse) return actor;
  const capability = inspectLanGpuCoordinatorEnvironment();
  try {
    return NextResponse.json(
      {
        capability,
        status: await configuredLanGpuAdminStatus(),
        workflows: configuredLanGpuWorkflows(),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      {
        capability,
        status: {
          mode: capability.enabled ? "lan_lab" : "disabled",
          state: "offline",
          recentJobs: [],
          workflowCount: capability.workflowCount,
          concurrency: 1,
          speculativePrefetch: false,
        },
        workflows: [],
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}

export async function POST(request: Request): Promise<Response> {
  const actor = await requireAdmin(["super_admin", "ops"]);
  if (actor instanceof NextResponse) return actor;
  try {
    if (actor.mode !== "local") {
      return NextResponse.json(
        { error: "LAN LAB 仅限受控本地管理员。" },
        { status: 403 },
      );
    }
    assertTrustedLoopbackMutation(request);
    const body = (await request.json()) as {
      action?: unknown;
      jobId?: unknown;
      input?: Record<string, unknown>;
    };
    if (body.action === "cancel") {
      if (
        typeof body.jobId !== "string" ||
        !/^[0-9a-f-]{20,80}$/i.test(body.jobId)
      ) {
        return NextResponse.json({ error: "任务 ID 不合法。" }, { status: 400 });
      }
      return NextResponse.json({
        job: await cancelConfiguredLanGpuJob(body.jobId),
      });
    }
    if (body.action === "submit-generate" && body.input) {
      const input = body.input;
      return NextResponse.json(
        {
          job: await submitConfiguredLanGpuVideoJob({
            taskType: "generate",
            workflowId: String(input.workflowId || ""),
            workflowSha256: String(input.workflowSha256 || ""),
            prompt: String(input.prompt || ""),
            negativePrompt:
              typeof input.negativePrompt === "string"
                ? input.negativePrompt
                : undefined,
            seed: Number(input.seed),
            width: Number(input.width),
            height: Number(input.height),
            frames: Number(input.frames),
            fps: Number(input.fps),
            projectId:
              input.projectId === undefined
                ? undefined
                : Number(input.projectId),
            idempotencyKey: String(input.idempotencyKey || ""),
          }),
        },
        { status: 202 },
      );
    }
    if (body.action === "submit-upscale" && body.input) {
      const input = body.input;
      return NextResponse.json(
        {
          job: await submitConfiguredLanGpuVideoJob({
            taskType: "upscale",
            workflowId: String(input.workflowId || ""),
            workflowSha256: String(input.workflowSha256 || ""),
            sourceJobId: String(input.sourceJobId || ""),
            width: Number(input.width),
            height: Number(input.height),
            frames: Number(input.frames),
            fps: Number(input.fps),
            preserveAudio: true,
            projectId:
              input.projectId === undefined
                ? undefined
                : Number(input.projectId),
            idempotencyKey: String(input.idempotencyKey || ""),
          }),
        },
        { status: 202 },
      );
    }
    return NextResponse.json({ error: "不支持的操作。" }, { status: 400 });
  } catch {
    return NextResponse.json(
      { error: "LAN LAB 操作失败。" },
      { status: 400 },
    );
  }
}
