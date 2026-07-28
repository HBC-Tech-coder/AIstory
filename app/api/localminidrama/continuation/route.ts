import { NextRequest, NextResponse } from "next/server";
import { requestLocalMiniDramaStoryGeneration } from "@/lib/localminidrama/server";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
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
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "续写请求失败",
      },
      { status: 502 },
    );
  }
}
