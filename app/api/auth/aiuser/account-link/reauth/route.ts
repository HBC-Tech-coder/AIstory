import { handleAiUserAccountLinkReauthStart } from "@/lib/auth/aiUserAccountLinkReauthServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = handleAiUserAccountLinkReauthStart;
