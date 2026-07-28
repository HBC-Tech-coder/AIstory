import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { AUTH_ENABLED } from "@/lib/supabase/config";
import { createClient } from "@/lib/supabase/server";
import { assertProductionDatabaseGateReady } from "@/lib/production/databaseGate";

export const runtime = "nodejs";

export async function POST(): Promise<Response> {
  // Local admin sessions never call production bootstrap. Production requires
  // an authenticated Supabase identity explicitly allowlisted in the env.
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
    bootstrap_request_id: randomUUID(),
  });
  if (result.error) {
    return NextResponse.json(
      { error: "Bootstrap unavailable or already completed" },
      { status: 409 },
    );
  }
  return NextResponse.json({ ok: true });
}
