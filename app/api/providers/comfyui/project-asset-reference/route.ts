import { NextResponse } from "next/server";

import { prepareProjectAssetComfyReference } from "@/lib/project-assets/comfyReference";
import { assertTrustedLoopbackMutation } from "@/lib/security/localMutation";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  try {
    assertTrustedLoopbackMutation(request);
    const body = (await request.json()) as {
      projectId?: unknown;
      assetId?: unknown;
    };
    if (typeof body.assetId !== "string") throw new Error("Invalid asset id.");
    const reference = await prepareProjectAssetComfyReference(
      Number(body.projectId),
      body.assetId,
    );
    return NextResponse.json({ reference });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Reference preparation failed.";
    const forbidden = message.includes("loopback");
    const unavailable = message.includes("not ready");
    return NextResponse.json(
      { error: forbidden ? "Forbidden" : message },
      { status: forbidden ? 403 : unavailable ? 503 : 400 },
    );
  }
}
