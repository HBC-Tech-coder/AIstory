import { handleAiUserOidcRequest } from "@/lib/auth/aiUserOidcCallbackServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handleAiUserOidcRequest("start", request);
}
