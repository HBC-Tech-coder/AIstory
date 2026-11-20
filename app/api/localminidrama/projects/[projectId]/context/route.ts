import { NextResponse } from "next/server";

import { getLocalMiniDramaProjectContext } from "@/lib/localminidrama/server";
import { isLoopbackReadRequest } from "@/lib/security/localMutation";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  if (!isLoopbackReadRequest(request)) {
    return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
  }
  const { projectId } = await context.params;
  const id = Number(projectId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return NextResponse.json(
      { ok: false, code: "invalid_project_id", error: "项目 ID 无效。" },
      { status: 400 },
    );
  }
  try {
    const data = await getLocalMiniDramaProjectContext(id);
    return NextResponse.json(
      { ok: true, data },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      {
        ok: false,
        code: "localminidrama_unavailable",
        error: "本地项目上下文暂不可用。",
      },
      { status: 502 },
    );
  }
}
