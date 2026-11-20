import { NextResponse } from "next/server";

import { isLoopbackReadRequest } from "@/lib/security/localMutation";
import { readSteamVideoProductionPlan } from "@/lib/steam/productionPlanServer";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  if (!isLoopbackReadRequest(request)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  try {
    return NextResponse.json(await readSteamVideoProductionPlan(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json(
      { error: "production_plan_unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}

