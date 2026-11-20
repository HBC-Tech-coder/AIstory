import { handleSteamVideoGenerationPreflightGet } from "@/lib/steam/videoGenerationPreflightHandler";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return handleSteamVideoGenerationPreflightGet(request);
}
