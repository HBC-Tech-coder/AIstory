import { NextResponse } from "next/server";

import { getGenerationJobScheduler } from "@/lib/generation-jobs/server";
import { isLoopbackReadRequest } from "@/lib/security/localMutation";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
): Promise<Response> {
  if (!isLoopbackReadRequest(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { jobId } = await context.params;
  const job = await getGenerationJobScheduler().get(jobId);
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ job });
}
