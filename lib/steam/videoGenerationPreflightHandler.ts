import { NextResponse } from "next/server";

import { isLoopbackReadRequest } from "@/lib/security/localMutation";
import { readSteamVideoGenerationPreflight } from "@/lib/steam/productionSpecServer";

export type RouteDeps = {
  read: typeof readSteamVideoGenerationPreflight;
};

const defaultDeps: RouteDeps = { read: readSteamVideoGenerationPreflight };

/**
 * Read-only preflight handler. The loopback-only gate runs before any read so
 * a remote request can never trigger the injectable dependency; tests inject a
 * fake `read` while the GET route always uses the real default.
 */
export async function handleSteamVideoGenerationPreflightGet(
  request: Request,
  deps: RouteDeps = defaultDeps,
): Promise<Response> {
  if (!isLoopbackReadRequest(request)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  try {
    return NextResponse.json(await deps.read(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json(
      { error: "generation_preflight_unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
