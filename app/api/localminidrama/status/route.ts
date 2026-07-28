import { NextResponse } from "next/server";
import { getLocalMiniDramaStatus } from "@/lib/localminidrama/server";

export const runtime = "nodejs";

export async function GET() {
  const status = await getLocalMiniDramaStatus();
  return NextResponse.json(status, { status: status.ok ? 200 : 503 });
}
