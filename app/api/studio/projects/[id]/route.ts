import {
  handleStudioGetOwnProject,
  handleStudioPublishProject,
  handleStudioReviseProject,
  handleStudioSetVisibility,
} from "@/lib/creator-studio/online/service";
import { requireUser } from "@/lib/supabase/guard";

export const runtime = "nodejs";

function withNoStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function ownerFromAuth(auth: { userId: string; authType: string }) {
  // Explicit copy: never spread a framework session into the domain layer.
  return { userId: auth.userId, authType: auth.authType };
}

/**
 * Owner read. Authentication happens before the id is used, so an anonymous
 * caller never learns whether an id exists.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await requireUser();
  if (auth instanceof Response) return withNoStore(auth);
  const { id } = await context.params;
  return handleStudioGetOwnProject(request, id, ownerFromAuth(auth));
}

/** Revise the private draft. Requires an optimistic `expectedRevision`. */
export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await requireUser();
  if (auth instanceof Response) return withNoStore(auth);
  const { id } = await context.params;
  return handleStudioReviseProject(request, id, ownerFromAuth(auth));
}

/** Explicit publish: stores the supplied safe snapshot (owner-only mutation). */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await requireUser();
  if (auth instanceof Response) return withNoStore(auth);
  const { id } = await context.params;
  return handleStudioPublishProject(request, id, ownerFromAuth(auth));
}

/** Owner visibility toggle for an already published project. */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await requireUser();
  if (auth instanceof Response) return withNoStore(auth);
  const { id } = await context.params;
  return handleStudioSetVisibility(request, id, ownerFromAuth(auth));
}
