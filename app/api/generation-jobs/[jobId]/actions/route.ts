import { NextResponse } from "next/server";

import { getGenerationJobScheduler } from "@/lib/generation-jobs/server";
import { assertTrustedLoopbackMutation } from "@/lib/security/localMutation";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
): Promise<Response> {
  try {
    assertTrustedLoopbackMutation(request);
    const { jobId } = await context.params;
    const body = (await request.json()) as { action?: unknown };
    const scheduler = getGenerationJobScheduler();
    const job = body.action === "cancel"
      ? await scheduler.cancel(jobId)
      : body.action === "retry"
        ? await scheduler.retry(jobId)
        : undefined;
    if (!job) {
      return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
    }
    return NextResponse.json({ job });
  } catch (error) {
    const forbidden = error instanceof Error && error.message.includes("loopback");
    return NextResponse.json(
      { error: forbidden ? "Forbidden" : "Generation action rejected." },
      { status: forbidden ? 403 : 400 },
    );
  }
}
