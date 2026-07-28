import { NextResponse } from "next/server";

import { getAdminRepository } from "@/lib/admin/service";
import {
  USER_SESSION_COOKIE,
  userSessionCookieOptions,
} from "@/lib/auth/userSession";
import { requireUser } from "@/lib/supabase/guard";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const auth = await requireUser();
  if (auth instanceof NextResponse) return auth;
  if (auth.userId === "anonymous") {
    return NextResponse.json({
      authenticated: false,
      account: null,
    });
  }
  const repository = getAdminRepository();
  const user = await repository.getUser(auth.userId);
  const ledger = await repository.listLedger(auth.userId);
  return NextResponse.json({
    authenticated: true,
    account: {
      userId: auth.userId,
      authType: auth.authType,
      displayName: user?.displayName || "AIstory 用户",
      maskedContact: user?.maskedContact,
      status: user?.status || "active",
      balance: ledger.reduce((sum, entry) => sum + entry.amount, 0),
      ledger: ledger.slice(-20).reverse().map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        amount: entry.amount,
        reason: entry.reason,
        createdAt: entry.createdAt,
      })),
    },
  });
}

export async function DELETE(): Promise<Response> {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(USER_SESSION_COOKIE, "", {
    ...userSessionCookieOptions(),
    maxAge: 0,
  });
  return response;
}
