import {
  handleGetSharedStory,
  handlePatchSharedStory,
  type SharedOwner,
} from "@/lib/shared-stories";
import { requireUser } from "@/lib/supabase/guard";

type IdContext = { params: Promise<{ id: string }> };

function withNoStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function ownerFromAuth(auth: { userId: string; authType: string }): SharedOwner {
  // Explicit copy: never spread a framework session into the domain layer.
  return { userId: auth.userId, authType: auth.authType };
}

export async function GET(request: Request, context: IdContext): Promise<Response> {
  const { id } = await context.params;
  return handleGetSharedStory(request, id);
}

export async function PATCH(request: Request, context: IdContext): Promise<Response> {
  const auth = await requireUser();
  if (auth instanceof Response) return withNoStore(auth);
  const { id } = await context.params;
  return handlePatchSharedStory(request, id, ownerFromAuth(auth));
}
