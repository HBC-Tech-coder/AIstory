import { NextResponse } from "next/server";

import { listProjectAssets } from "@/lib/project-assets/repository";
import { adoptGenerationJobArtifact } from "@/lib/project-assets/server";
import {
  assertTrustedLoopbackMutation,
  isLoopbackReadRequest,
} from "@/lib/security/localMutation";

export const runtime = "nodejs";

function projectIdFrom(value: unknown): number {
  const projectId = Number(value);
  if (!Number.isSafeInteger(projectId) || projectId <= 0) {
    throw new Error("Invalid project id.");
  }
  return projectId;
}

export async function GET(request: Request): Promise<Response> {
  if (!isLoopbackReadRequest(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  try {
    const projectId = projectIdFrom(
      new URL(request.url).searchParams.get("projectId"),
    );
    return NextResponse.json(await listProjectAssets(projectId));
  } catch {
    return NextResponse.json({ error: "Invalid project id." }, { status: 400 });
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertTrustedLoopbackMutation(request);
    const body = (await request.json()) as {
      projectId?: unknown;
      jobId?: unknown;
    };
    const projectId = projectIdFrom(body.projectId);
    if (typeof body.jobId !== "string") throw new Error("Invalid job id.");
    const result = await adoptGenerationJobArtifact(projectId, body.jobId);
    return NextResponse.json(result, { status: result.created ? 201 : 200 });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Asset adoption failed.";
    const forbidden = message.includes("loopback");
    return NextResponse.json(
      { error: forbidden ? "Forbidden" : message },
      { status: forbidden ? 403 : 400 },
    );
  }
}
