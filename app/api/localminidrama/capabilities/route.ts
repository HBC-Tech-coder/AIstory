import { NextResponse } from "next/server";

import { discoverLocalMiniDramaCapabilities } from "@/lib/localminidrama/server";

export const runtime = "nodejs";

export async function GET() {
  const capabilities = await discoverLocalMiniDramaCapabilities();
  return NextResponse.json(capabilities, {
    status: capabilities.ok ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
