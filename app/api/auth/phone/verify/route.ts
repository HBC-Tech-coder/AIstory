import { NextResponse } from "next/server";

import {
  PhoneAuthError,
  resolveSmsProvider,
  verifyPhoneOtp,
} from "@/lib/auth/phoneAuthService";
import {
  createUserSessionToken,
  USER_SESSION_COOKIE,
  userSessionCookieOptions,
} from "@/lib/auth/userSession";
import { getAdminRepository } from "@/lib/admin/service";
import { isTrustedLoopbackMutationRequest } from "@/lib/security/localMutation";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const provider = resolveSmsProvider();
  if (
    provider.id === "local_mock"
    && !isTrustedLoopbackMutationRequest(request)
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  let body: {
    phone?: unknown;
    challengeId?: unknown;
    code?: unknown;
  };
  try {
    body = await request.json() as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (
    typeof body.phone !== "string"
    || typeof body.challengeId !== "string"
    || typeof body.code !== "string"
  ) {
    return NextResponse.json(
      { error: "验证码无效或已过期。" },
      { status: 400 },
    );
  }
  try {
    const account = await verifyPhoneOtp(getAdminRepository(), {
      phone: body.phone,
      challengeId: body.challengeId,
      code: body.code,
    });
    const response = NextResponse.json({
      ok: true,
      account: {
        userId: account.userId,
        maskedPhone: account.maskedPhone,
        balance: account.balance,
        initialGrantApplied: account.created,
      },
    });
    response.cookies.set(
      USER_SESSION_COOKIE,
      createUserSessionToken(account.userId),
      userSessionCookieOptions(),
    );
    return response;
  } catch (error) {
    if (error instanceof PhoneAuthError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { error: "手机号登录暂时不可用。" },
      { status: 503 },
    );
  }
}
