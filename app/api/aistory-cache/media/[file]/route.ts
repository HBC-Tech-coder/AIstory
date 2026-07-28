import { NextResponse } from "next/server";
import { readCachedMedia } from "@/lib/engine/mediaCache";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  context: { params: Promise<{ file: string }> },
) {
  const { file } = await context.params;
  const media = await readCachedMedia(file);
  if (!media) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return new Response(new Uint8Array(media.body), {
    headers: {
      "Content-Type": media.contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
