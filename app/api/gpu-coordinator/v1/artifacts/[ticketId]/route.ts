import { NextResponse } from "next/server";

import {
  handleLanGpuArtifactDownload,
  handleLanGpuArtifactUpload,
  inspectLanGpuCoordinatorEnvironment,
  isLanGpuCoordinatorHostAllowed,
} from "@/lib/gpu-coordinator/server";
import { GPU_COORDINATOR_STREAM_CHUNK_BYTES } from "@/lib/gpu-coordinator/types";

export const runtime = "nodejs";

const SAFE_TICKET_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/;

function exactArtifactPath(ticketId: string): string {
  return `/api/gpu-coordinator/v1/artifacts/${encodeURIComponent(ticketId)}`;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ ticketId: string }> },
): Promise<Response> {
  const capability = inspectLanGpuCoordinatorEnvironment();
  if (!capability.ready || !isLanGpuCoordinatorHostAllowed(request.headers)) {
    return NextResponse.json(
      { error: { code: "coordinator_unavailable" } },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  const { ticketId } = await context.params;
  const path = exactArtifactPath(ticketId);
  if (
    !SAFE_TICKET_ID.test(ticketId) ||
    new URL(request.url).pathname !== path
  ) {
    return NextResponse.json(
      { error: { code: "ticket_invalid" } },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  try {
    const result = await handleLanGpuArtifactDownload({ ticketId });
    return new Response(result.body.buffer.slice(
      result.body.byteOffset,
      result.body.byteOffset + result.body.byteLength,
    ) as ArrayBuffer, {
      status: 200,
      headers: {
        "Cache-Control": "no-store, private",
        "Content-Length": String(result.body.byteLength),
        "Content-Type": result.contentType,
        "x-aistory-content-sha256": result.sha256,
      },
    });
  } catch {
    return NextResponse.json(
      { error: { code: "ticket_invalid" } },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
}

async function readBoundedVideoBody(
  request: Request,
  expectedBytes: number,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!request.body) throw new Error("artifact_invalid");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (
      let offset = 0;
      offset < value.byteLength;
      offset += GPU_COORDINATOR_STREAM_CHUNK_BYTES
    ) {
      const chunk = value.subarray(
        offset,
        Math.min(value.byteLength, offset + GPU_COORDINATOR_STREAM_CHUNK_BYTES),
      );
      total += chunk.byteLength;
      if (total > maxBytes || total > expectedBytes) {
        await reader.cancel("artifact_too_large").catch(() => undefined);
        throw new Error("artifact_invalid");
      }
      chunks.push(chunk);
    }
  }
  if (total !== expectedBytes) throw new Error("artifact_invalid");
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ ticketId: string }> },
): Promise<Response> {
  const capability = inspectLanGpuCoordinatorEnvironment();
  if (!capability.ready || !isLanGpuCoordinatorHostAllowed(request.headers)) {
    return NextResponse.json(
      { error: { code: "coordinator_unavailable" } },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  const maxBytes = Math.min(
    2 * 1024 * 1024 * 1024,
    Math.max(
      1024 * 1024,
      Number(process.env.AISTORY_GPU_LAN_LAB_MAX_VIDEO_BYTES) ||
        512 * 1024 * 1024,
    ),
  );
  const contentLength = Number(request.headers.get("content-length"));
  if (
    !Number.isFinite(contentLength) ||
    contentLength <= 0 ||
    contentLength > maxBytes
  ) {
    return NextResponse.json(
      { error: { code: "artifact_invalid" } },
      { status: 413, headers: { "Cache-Control": "no-store" } },
    );
  }
  const { ticketId } = await context.params;
  if (!SAFE_TICKET_ID.test(ticketId)) {
    return NextResponse.json(
      { error: { code: "ticket_invalid" } },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  try {
    const body = await readBoundedVideoBody(request, contentLength, maxBytes);
    const path = exactArtifactPath(ticketId);
    if (new URL(request.url).pathname !== path) {
      return NextResponse.json(
        { error: { code: "ticket_invalid" } },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    const result = await handleLanGpuArtifactUpload({
      ticketId,
      method: request.method,
      path,
      headers: request.headers,
      body,
    });
    return new Response(new Uint8Array(result.body).buffer, {
      status: result.status,
      headers: result.headers,
    });
  } catch {
    return NextResponse.json(
      { error: { code: "ticket_invalid" } },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
}
