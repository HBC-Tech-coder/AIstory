import { NextResponse } from "next/server";
import { getLocalMiniDramaStatus } from "@/lib/localminidrama/server";
import { isLoopbackReadRequest } from "@/lib/security/localMutation";

export const runtime = "nodejs";

export async function GET(request: Request) {
  if (!isLoopbackReadRequest(request)) {
    return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
  }
  const status = await getLocalMiniDramaStatus();
  return NextResponse.json(status, { status: status.ok ? 200 : 503 });
}
