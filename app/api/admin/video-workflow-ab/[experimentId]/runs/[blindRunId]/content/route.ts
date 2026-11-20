import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/admin/security";
import { streamVideoFile } from "@/lib/video-assets/http";
import { getVideoWorkflowABBlindRunFile } from "@/lib/video-workflow-ab/server";

export const runtime = "nodejs";

async function serve(
  request: Request,
  context: {
    params: Promise<{ experimentId: string; blindRunId: string }>;
  },
): Promise<Response> {
  const actor = await requireAdmin();
  if (actor instanceof NextResponse) return actor;
  try {
    const { experimentId, blindRunId } = await context.params;
    const result = await getVideoWorkflowABBlindRunFile(
      actor,
      experimentId,
      blindRunId,
    );
    if (!result) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return streamVideoFile(request, result.file, result.contentType, "no-store");
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}

export async function GET(
  request: Request,
  context: {
    params: Promise<{ experimentId: string; blindRunId: string }>;
  },
): Promise<Response> {
  return serve(request, context);
}

export async function HEAD(
  request: Request,
  context: {
    params: Promise<{ experimentId: string; blindRunId: string }>;
  },
): Promise<Response> {
  return serve(request, context);
}
