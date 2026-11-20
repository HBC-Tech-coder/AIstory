import { handleAiUserAccountLink } from "@/lib/auth/aiUserAccountLinkServer";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = handleAiUserAccountLink;
export const POST = handleAiUserAccountLink;
