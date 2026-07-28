import {
  readCaseReviewAsset,
} from "@/lib/case-studies/reviewAssets";
import { isLoopbackReadRequest } from "@/lib/security/localMutation";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ itemId: string }> },
) {
  if (!isLoopbackReadRequest(request)) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  try {
    const { itemId } = await context.params;
    const asset = await readCaseReviewAsset(itemId);
    return new Response(new Uint8Array(asset.bytes), {
      headers: {
        "content-type": asset.contentType,
        "content-length": String(asset.bytes.byteLength),
        "cache-control": "private, no-store",
        etag: `"${asset.sha256}"`,
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return Response.json({ error: "审核素材不可用" }, { status: 404 });
  }
}
