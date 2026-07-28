import { NextResponse } from "next/server";

import { discoverComfyUIProviderStatus } from "@/lib/providers/comfyui/server";

export const runtime = "nodejs";

export async function GET() {
  const status = await discoverComfyUIProviderStatus();
  return NextResponse.json(status, {
    status: status.available || status.state === "disabled" ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
