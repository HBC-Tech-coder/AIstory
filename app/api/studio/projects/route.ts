import {
  handleStudioCreateProject,
  handleStudioListProjects,
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

/** Owner listing. Anonymous callers are rejected by the guard and the service. */
export async function GET(request: Request): Promise<Response> {
  const auth = await requireUser();
  if (auth instanceof Response) return withNoStore(auth);
  return handleStudioListProjects(request, ownerFromAuth(auth));
}

/** Create a Studio work. Ownership comes only from the verified caller. */
export async function POST(request: Request): Promise<Response> {
  const auth = await requireUser();
  if (auth instanceof Response) return withNoStore(auth);
  return handleStudioCreateProject(request, ownerFromAuth(auth));
}
