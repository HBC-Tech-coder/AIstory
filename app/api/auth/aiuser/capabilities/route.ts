import { aiUserUserCapabilities } from "@/lib/auth/aiUserOidcCallbackServer";
import { isAiUserAccountLinkAvailable } from "@/lib/auth/aiUserAccountLinkServer";
import { isAiUserAccountLinkReauthAvailable } from "@/lib/auth/aiUserAccountLinkReauthServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request): Promise<Response> {
  const [linkingEnabled, linkReauthAvailable] = await Promise.all([
    isAiUserAccountLinkAvailable(request),
    isAiUserAccountLinkReauthAvailable(request),
  ]);
  return aiUserUserCapabilities(linkingEnabled, linkReauthAvailable);
}
