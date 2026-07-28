import { NextRequest, NextResponse } from "next/server";
import {
  createLocalMiniDramaDraft,
  listLocalMiniDramaDramas,
} from "@/lib/localminidrama/server";
import type { DreamFrameMiniDramaDraft } from "@/lib/localminidrama/types";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const page = Number(request.nextUrl.searchParams.get("page") || "1");
    const pageSize = Number(request.nextUrl.searchParams.get("page_size") || "8");
    const keyword = request.nextUrl.searchParams.get("keyword") || undefined;
    const data = await listLocalMiniDramaDramas({ page, pageSize, keyword });
    return NextResponse.json({ ok: true, data });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "读取 LocalMiniDrama 项目失败",
      },
      { status: 502 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const draft = (await request.json()) as DreamFrameMiniDramaDraft;
    if (!draft.title?.trim() && !draft.summary?.trim() && !draft.sourceText?.trim()) {
      return NextResponse.json(
        { ok: false, error: "请先导入或填写剧本内容" },
        { status: 400 },
      );
    }
    const data = await createLocalMiniDramaDraft(draft);
    return NextResponse.json({ ok: true, data });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "创建 LocalMiniDrama 草稿失败",
      },
      { status: 502 },
    );
  }
}
