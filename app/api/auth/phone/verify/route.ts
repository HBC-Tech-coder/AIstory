import { NextResponse } from "next/server";

import {
  normalizePhone,
  verifyPhoneOtp,
} from "@/lib/auth/phoneAuthService";
import {
  authorizePhoneOtpAdmission,
  PHONE_REGISTRATION_POLICY_VALUES,
  phoneOtpAdmissionIsCurrent,
} from "@/lib/auth/phoneInviteBetaGate";
import {
  prepareUserSessionTokenIssuer,
  USER_SESSION_COOKIE,
  userSessionCookieOptions,
} from "@/lib/auth/userSession";
import { getAdminRepository } from "@/lib/admin/service";
import { isTrustedLoopbackMutationRequest } from "@/lib/security/localMutation";
import {
  emptyAnonymousClaimResult,
  type AnonymousClaimResult,
} from "@/lib/auth/anonymousClaim";
import { prepareServerAnonymousClaim } from "@/lib/auth/anonymousClaimServer";

export const runtime = "nodejs";
const MAX_VERIFY_BODY_BYTES = 160 * 1024;

function localMockSmsEnabled(): boolean {
  return process.env.AISTORY_SMS_PROVIDER === "local_mock"
    && process.env.AISTORY_LOCAL_SMS_ENABLED === "true";
}

function rejectedOtpResponse(): Response {
  return NextResponse.json(
    {
      error: "验证码无效或已过期。",
      code: "OTP_INVALID_OR_EXPIRED",
    },
    { status: 400 },
  );
}

export async function POST(request: Request): Promise<Response> {
  if (localMockSmsEnabled() && !isTrustedLoopbackMutationRequest(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  let body: {
    phone?: unknown;
    challengeId?: unknown;
    code?: unknown;
    anonymousClaim?: unknown;
  };
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_VERIFY_BODY_BYTES) {
      return NextResponse.json(
        { error: "本机进度清单过大，未执行登录。" },
        { status: 413 },
      );
    }
    body = JSON.parse(raw) as typeof body;
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
  let normalizedPhone: string;
  try {
    normalizedPhone = normalizePhone(body.phone);
  } catch {
    return rejectedOtpResponse();
  }
  const admission = await authorizePhoneOtpAdmission(normalizedPhone);
  if (!admission.allowed) return rejectedOtpResponse();
  let issueUserSessionToken: ReturnType<
    typeof prepareUserSessionTokenIssuer
  >;
  try {
    issueUserSessionToken = prepareUserSessionTokenIssuer();
  } catch {
    return rejectedOtpResponse();
  }
  let anonymousClaim;
  try {
    anonymousClaim = await prepareServerAnonymousClaim(
      request,
      body.anonymousClaim,
    );
  } catch {
    return rejectedOtpResponse();
  }
  if (!await phoneOtpAdmissionIsCurrent(
    normalizedPhone,
    admission,
  )) return rejectedOtpResponse();
  try {
    const account = await verifyPhoneOtp(getAdminRepository(), {
      phone: normalizedPhone,
      challengeId: body.challengeId,
      code: body.code,
      ...(anonymousClaim ? { anonymousClaim } : {}),
    });
    const claim: AnonymousClaimResult | undefined = account.claim ??
      (body.anonymousClaim
        ? emptyAnonymousClaimResult("not_found")
        : undefined);
    const response = NextResponse.json({
      ok: true,
      account: {
        userId: account.userId,
        maskedPhone: account.maskedPhone,
        balance: account.balance,
        initialGrantApplied: account.initialGrantApplied,
      },
      ...(claim ? { claim } : {}),
    });
    response.cookies.set(
      USER_SESSION_COOKIE,
      issueUserSessionToken(
        account.userId,
        admission.mode === "invite_only"
          ? {
              inviteBetaPolicyFingerprint:
                admission.membershipPolicyFingerprint,
            }
          : {
              phoneRegistrationPolicy:
                PHONE_REGISTRATION_POLICY_VALUES.publicBeta,
            },
      ),
      userSessionCookieOptions(),
    );
    return response;
  } catch {
    return rejectedOtpResponse();
  }
}
