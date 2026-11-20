import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/admin/security";
import { isVideoAssetUnavailableError } from "@/lib/video-assets/errors";
import { streamVideoAssetContent } from "@/lib/video-assets/http";
import { getRuntimeVideoAssetServiceOptions } from "@/lib/video-assets/production/runtime";
import { getAdminVideoAssetContent } from "@/lib/video-assets/server";

export const runtime = "nodejs";

async function respond(
  request: Request,
  context: { params: Promise<{ assetId: string }> },
): Promise<Response> {
  const actor = await requireAdmin();
  if (actor instanceof NextResponse) return actor;
  try {
    const { assetId } = await context.params;
    const record = await getAdminVideoAssetContent(
      actor,
      assetId,
      getRuntimeVideoAssetServiceOptions(),
    );
    return streamVideoAssetContent(
      request,
      record,
      "private, no-store",
    );
  } catch (error) {
    if (isVideoAssetUnavailableError(error)) {
      return NextResponse.json(
        { error: "Video asset service unavailable" },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}

export const GET = respond;
export const HEAD = respond;
