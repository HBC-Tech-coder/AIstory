import { NextResponse } from "next/server";

import { discoverVolcengineAgentPlanStatus } from "@/lib/providers/volcengine-agent-plan/server";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  return NextResponse.json(discoverVolcengineAgentPlanStatus(), {
    headers: { "Cache-Control": "no-store" },
  });
}
