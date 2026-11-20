import { NextResponse } from "next/server";

import { isLoopbackReadRequest } from "@/lib/security/localMutation";
import { readPublishedVideoStory } from "@/lib/video-stories/server";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ storyId: string }>;
};

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    if (!isLoopbackReadRequest(request)) {
      return NextResponse.json(
        { error: "互动视频剧情不存在或已下线。" },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      );
    }
    const { storyId } = await context.params;
    const release = await readPublishedVideoStory(storyId);
    if (!release) {
      return NextResponse.json(
        { error: "互动视频剧情不存在或已下线。" },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json(release.bundle, {
      headers: {
        "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
        ETag: `"${release.contentHash}"`,
        "X-AIstory-Release": release.version,
      },
    });
  } catch {
    return NextResponse.json(
      { error: "互动视频剧情发布物不可用。" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
