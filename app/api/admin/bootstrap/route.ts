import { NextResponse } from "next/server";
import { AUTH_ENABLED } from "@/lib/supabase/config";
import { createClient } from "@/lib/supabase/server";
import { assertProductionDatabaseGateReady } from "@/lib/production/databaseGate";
import { hasIndependentAdminPrincipalModeValue } from "@/lib/admin/independentPrincipalServer";
import { hasLinghaoPassportV4ProductCookieHeader } from "@/lib/auth/linghaoPassportV4ProductionCookies";

export const runtime = "nodejs";

function isExactSameOrigin(request: Request): boolean {
  const originHeader = request.headers.get("origin");
  const hostHeader = request.headers.get("host")?.trim().toLowerCase();
  if (!originHeader || !hostHeader) return false;
  try {
    const requestUrl = new URL(request.url);
    const originUrl = new URL(originHeader);
    const loopback = requestUrl.hostname === "localhost"
      || requestUrl.hostname === "127.0.0.1"
      || requestUrl.hostname === "[::1]";
    if (requestUrl.protocol !== "https:" && !(loopback && requestUrl.protocol === "http:")) {
      return false;
    }
    return originHeader === originUrl.origin
      && originUrl.origin === requestUrl.origin
      && hostHeader === requestUrl.host.toLowerCase();
  } catch {
    return false;
  }
}

export async function POST(request: Request): Promise<Response> {
  if (hasIndependentAdminPrincipalModeValue()) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (hasLinghaoPassportV4ProductCookieHeader(request.headers.get("cookie"))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // This legacy Supabase Auth bootstrap remains isolated. It never consumes a
  // phone session or the independent administrator-principal candidate.
  if (!isExactSameOrigin(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!AUTH_ENABLED) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  try {
    await assertProductionDatabaseGateReady("identity");
  } catch {
    return NextResponse.json(
      { error: "Administrator repository is unavailable." },
      { status: 503 },
    );
  }
  const supabase = await createClient();
  const claims = await supabase.auth.getClaims();
  const claim = claims.data?.claims;
  const userId = typeof claim?.sub === "string" ? claim.sub : "";
  const email = typeof claim?.email === "string" ? claim.email.toLowerCase() : "";
  const allowedUserId =
    process.env.AISTORY_ADMIN_BOOTSTRAP_USER_ID?.trim() || undefined;
  const allowedEmail =
    process.env.AISTORY_ADMIN_BOOTSTRAP_EMAIL?.trim().toLowerCase()
    || undefined;
  if (
    claims.error
    || !userId
    || (!allowedUserId && !allowedEmail)
    || (allowedUserId !== undefined && allowedUserId !== userId)
    || (allowedEmail !== undefined && allowedEmail !== email)
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const result = await supabase.rpc("bootstrap_super_admin", {
    bootstrap_user_id: userId,
    bootstrap_request_id: `bootstrap:${userId}`,
  });
  if (result.error) {
    return NextResponse.json(
      { error: "Bootstrap unavailable or already completed" },
      { status: 409 },
    );
  }
  return NextResponse.json({ ok: true });
}
