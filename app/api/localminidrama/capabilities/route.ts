import { NextResponse } from "next/server";

import { discoverLocalMiniDramaCapabilities } from "@/lib/localminidrama/server";
import { isLoopbackReadRequest } from "@/lib/security/localMutation";

export const runtime = "nodejs";

export async function GET(request: Request) {
  if (!isLoopbackReadRequest(request)) {
    return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
  }
  const capabilities = await discoverLocalMiniDramaCapabilities();
  return NextResponse.json(capabilities, {
    status: capabilities.ok ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
