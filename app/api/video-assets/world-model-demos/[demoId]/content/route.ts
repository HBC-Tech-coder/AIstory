import { NextResponse } from "next/server";

import { streamVideoFile } from "@/lib/video-assets/http";
import { resolvePublishedWorldModelVideo } from "@/lib/world-model-demos/server";

export const runtime = "nodejs";

const CACHE_CONTROL = "public, max-age=0, must-revalidate";

function notFound(request: Request): Response {
  const headers = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  if (request.method === "HEAD") {
    return new Response(null, { status: 404, headers });
  }
  return NextResponse.json({ error: "Not found" }, { status: 404, headers });
}

async function respond(
  request: Request,
  context: { params: Promise<{ demoId: string }> },
): Promise<Response> {
  const { demoId } = await context.params;
  try {
    const video = resolvePublishedWorldModelVideo(demoId);
    if (!video) return notFound(request);
    return await streamVideoFile(
      request,
      video.file,
      video.contentType,
      CACHE_CONTROL,
      video.contentHash,
      video.bytes,
    );
  } catch {
    return notFound(request);
  }
}

export const GET = respond;
export const HEAD = respond;
