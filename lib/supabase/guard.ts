import { NextResponse } from "next/server";
import { readPhoneUserSession } from "@/lib/auth/userSession";
import { AUTH_ENABLED } from "./config";
import { createClient } from "./server";

export async function requireUser(): Promise<
  { userId: string; authType: "anonymous" | "phone" | "supabase" } | NextResponse
> {
  const phoneSession = await readPhoneUserSession();
  if (phoneSession) {
    return { userId: phoneSession.userId, authType: "phone" };
  }
  if (!AUTH_ENABLED) {
    return { userId: "anonymous", authType: "anonymous" };
  }
  const supabase = await createClient();
  const claims = await supabase.auth.getClaims();
  if (claims.error || !claims.data?.claims?.sub) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return { userId: claims.data.claims.sub, authType: "supabase" };
}
