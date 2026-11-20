import {
  handleCreateSharedStory,
  handleListSharedStories,
  isMineListRequest,
  type SharedOwner,
} from "@/lib/shared-stories";
import { requireUser } from "@/lib/supabase/guard";

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

export async function GET(request: Request): Promise<Response> {
  if (isMineListRequest(request)) {
    const auth = await requireUser();
    if (auth instanceof Response) return withNoStore(auth);
    return handleListSharedStories(request, ownerFromAuth(auth));
  }
  return handleListSharedStories(request, null);
}

export async function POST(request: Request): Promise<Response> {
  const auth = await requireUser();
  if (auth instanceof Response) return withNoStore(auth);
  return handleCreateSharedStory(request, ownerFromAuth(auth));
}
