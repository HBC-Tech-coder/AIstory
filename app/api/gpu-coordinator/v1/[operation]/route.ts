import { NextResponse } from "next/server";

import {
  handleLanGpuCoordinatorOperation,
  inspectLanGpuCoordinatorEnvironment,
  isLanGpuCoordinatorHostAllowed,
} from "@/lib/gpu-coordinator/server";
import {
  isGpuCoordinatorOperation,
  GPU_COORDINATOR_ENDPOINTS,
} from "@/lib/gpu-coordinator/protocol";
import { GPU_COORDINATOR_MAX_BODY_BYTES } from "@/lib/gpu-coordinator/types";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ operation: string }> },
): Promise<Response> {
  const capability = inspectLanGpuCoordinatorEnvironment();
  if (!capability.ready || !isLanGpuCoordinatorHostAllowed(request.headers)) {
    return NextResponse.json(
      { error: { code: "coordinator_unavailable" } },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  const { operation } = await context.params;
  if (!isGpuCoordinatorOperation(operation)) {
    return NextResponse.json(
      { error: { code: "bad_request" } },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }
  const contentLength = Number(request.headers.get("content-length"));
  if (
    Number.isFinite(contentLength) &&
    contentLength > GPU_COORDINATOR_MAX_BODY_BYTES
  ) {
    return NextResponse.json(
      { error: { code: "bad_request" } },
      { status: 413, headers: { "Cache-Control": "no-store" } },
    );
  }
  try {
    const body = new Uint8Array(await request.arrayBuffer());
    if (body.byteLength > GPU_COORDINATOR_MAX_BODY_BYTES) {
      return NextResponse.json(
        { error: { code: "bad_request" } },
        { status: 413, headers: { "Cache-Control": "no-store" } },
      );
    }
    const expectedPath = GPU_COORDINATOR_ENDPOINTS[operation];
    if (new URL(request.url).pathname !== expectedPath) {
      return NextResponse.json(
        { error: { code: "bad_request" } },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    const result = await handleLanGpuCoordinatorOperation({
      operation,
      method: request.method,
      path: expectedPath,
      headers: request.headers,
      body,
    });
    return new Response(new Uint8Array(result.body).buffer, {
      status: result.status,
      headers: result.headers,
    });
  } catch {
    return NextResponse.json(
      { error: { code: "coordinator_unavailable" } },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
