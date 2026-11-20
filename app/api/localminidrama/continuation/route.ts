import { NextRequest, NextResponse } from "next/server";
import { requestLocalMiniDramaStoryGeneration } from "@/lib/localminidrama/server";
import { assertTrustedLoopbackMutation } from "@/lib/security/localMutation";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    assertTrustedLoopbackMutation(request);
    const body = (await request.json()) as {
      premise?: string;
      style?: string;
      type?: string;
      episode_count?: number;
      model?: string;
    };
    const premise = body.premise?.trim();
    if (!premise) {
      return NextResponse.json({ ok: false, error: "请提供故事梗概" }, { status: 400 });
    }
    const data = await requestLocalMiniDramaStoryGeneration({ ...body, premise });
    return NextResponse.json({ ok: true, data });
  } catch (error) {
    const forbidden = error instanceof Error && error.message.includes("loopback");
    return NextResponse.json(
      {
        ok: false,
        error: forbidden
          ? "Forbidden"
          : error instanceof Error ? error.message : "续写请求失败",
      },
      { status: forbidden ? 403 : 502 },
    );
  }
}
