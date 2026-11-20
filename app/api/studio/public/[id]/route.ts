import { handleStudioGetPublicProject } from "@/lib/creator-studio/online/service";

export const runtime = "nodejs";

/**
 * Anonymous read of an explicitly published Studio work.
 *
 * Only the published safe snapshot is returned. A hidden or unknown id yields
 * the identical 404 body, and an unavailable gate yields an honest 503 instead
 * of a misleading 404.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return handleStudioGetPublicProject(request, id);
}
