import { NextResponse } from "next/server";

import { getAdminRepository } from "@/lib/admin/service";
import { requireUser } from "@/lib/supabase/guard";
import {
  assertProductionDatabaseGate,
  ProductionDatabaseGateError,
} from "@/lib/production/databaseGate";
import {
  attachAnonymousSubjectCookie,
  getOrCreateAnonymousSubject,
  readAnonymousSubject,
} from "@/lib/auth/anonymousSubject";
import { getProductionPhoneIdentityRepository } from "@/lib/auth/phoneIdentityRepository";
import { aiUserPublicAccount } from "@/lib/auth/aiUserAccountPublic";
import { resolveLinkedPhoneForBilling } from "@/lib/billing/linkedBillingServer";
import { handleAccountLogout } from "@/lib/auth/accountLogoutRoute";
import { linghaoPassportV4PublicAccount } from "@/lib/auth/linghaoPassportV4ProductionSession";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const auth = await requireUser({ allowAnonymousWhenAuthDisabled: true });
  if (auth instanceof NextResponse) return auth;
  if (auth.authType === "passport_v4") {
    if (!auth.passport) {
      return NextResponse.json(
        { authenticated: false, account: null },
        { status: 401, headers: { "Cache-Control": "private, no-store" } },
      );
    }
    return NextResponse.json(
      { authenticated: true, account: linghaoPassportV4PublicAccount(auth.passport) },
      { headers: { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" } },
    );
  }
  if (auth.authType === "aiuser") {
    if (!auth.aiuser) return NextResponse.json({ authenticated: false, account: null }, { status: 401 });
    let account = aiUserPublicAccount(auth.aiuser.expiresAt);
    try {
      const linked = await resolveLinkedPhoneForBilling(auth.aiuser);
      if (linked.state === "unlinked") {
        account = aiUserPublicAccount(auth.aiuser.expiresAt,
          { accountLinked: false, balance: null, platformBilling: false });
      } else if (linked.state === "linked") {
        const repository = getAdminRepository();
        const user = await repository.getUser(linked.phoneUserId);
        if (user?.status === "active") {
          const ledger = await repository.listLedger(linked.phoneUserId);
          const balance = ledger.reduce((sum, entry) => sum + entry.amount, 0);
          if (Number.isSafeInteger(balance) && balance >= 0) {
            account = aiUserPublicAccount(auth.aiuser.expiresAt, {
              accountLinked: true,
              balance,
              platformBilling: process.env.AISTORY_PLATFORM_BILLING_ENABLED === "true",
            });
          }
        }
      }
    } catch {
      // Preserve ordinary AIUser login while the independent billing gate is unavailable.
    }
    return NextResponse.json({ authenticated: true, account },
      { headers: { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" } });
  }
  if (auth.userId === "anonymous") {
    const response = NextResponse.json({
      authenticated: false,
      account: null,
    });
    attachAnonymousSubjectCookie(
      response,
      getOrCreateAnonymousSubject(request),
    );
    return response;
  }
  try {
    if (
      auth.authType === "phone"
      && process.env.AISTORY_IDENTITY_REPOSITORY === "supabase"
    ) {
      assertProductionDatabaseGate("identity");
    }
    const repository = getAdminRepository();
    const user = await repository.getUser(auth.userId);
    const ledger = await repository.listLedger(auth.userId);
    const subject =
      auth.authType === "phone" &&
      process.env.AISTORY_IDENTITY_REPOSITORY === "supabase"
      ? readAnonymousSubject(request)
      : undefined;
    const claim = subject && auth.authType === "phone"
      ? await getProductionPhoneIdentityRepository().getClaimReceipt(
          subject.subjectHash,
          auth.userId,
        )
      : undefined;
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
      ...(claim ? { claim } : {}),
    });
  } catch (error) {
    const status = error instanceof ProductionDatabaseGateError
      ? error.status
      : 503;
    return NextResponse.json(
      {
        error: "账户数据暂时不可用。",
        code: "ACCOUNT_REPOSITORY_UNAVAILABLE",
      },
      { status },
    );
  }
}

export async function DELETE(request: Request): Promise<Response> {
  return handleAccountLogout(request);
}
