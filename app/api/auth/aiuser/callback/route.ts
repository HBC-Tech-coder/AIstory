import { handleAiUserUserCallback } from "@/lib/auth/aiUserOidcCallbackServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleAiUserUserCallback(request);
}
