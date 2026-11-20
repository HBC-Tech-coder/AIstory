import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import {
  maskPhone,
  normalizePhone,
  PhoneAuthError,
  requestPhoneOtp,
  resolveSmsProvider,
} from "@/lib/auth/phoneAuthService";
import {
  authorizePhoneOtpAdmission,
  phoneOtpAdmissionIsCurrent,
} from "@/lib/auth/phoneInviteBetaGate";
import { prepareUserSessionTokenIssuer } from "@/lib/auth/userSession";
import { PHONE_OTP_COOLDOWN_SECONDS } from "@/lib/auth/phoneOtpPolicy";
import { isTrustedLoopbackMutationRequest } from "@/lib/security/localMutation";
import {
  attachAnonymousSubjectCookie,
  getOrCreateAnonymousSubject,
} from "@/lib/auth/anonymousSubject";
import { resolveSmsRequestIp } from "@/lib/auth/trustedClientIp";

export const runtime = "nodejs";
const OTP_EXPIRES_IN_SECONDS = 5 * 60;

function localMockSmsEnabled(): boolean {
  return process.env.AISTORY_SMS_PROVIDER === "local_mock"
    && process.env.AISTORY_LOCAL_SMS_ENABLED === "true";
}

function acceptedRequestResponse(
  request: Request,
  input: {
    challengeId: string;
    maskedPhone: string;
    expiresInSeconds: number;
    retryAfterSeconds: number;
  },
): Response {
  const response = NextResponse.json(
    {
      ok: true,
      challengeId: input.challengeId,
      maskedPhone: input.maskedPhone,
      expiresInSeconds: input.expiresInSeconds,
      retryAfterSeconds: input.retryAfterSeconds,
      message: "如果号码可用，验证码将很快送达。",
    },
    { status: 202 },
  );
  attachAnonymousSubjectCookie(
    response,
    getOrCreateAnonymousSubject(request),
  );
  return response;
}

function decoyRequestResponse(
  request: Request,
  maskedPhone: string,
): Response {
  return acceptedRequestResponse(request, {
    challengeId: randomUUID(),
    maskedPhone,
    expiresInSeconds: OTP_EXPIRES_IN_SECONDS,
    retryAfterSeconds: PHONE_OTP_COOLDOWN_SECONDS,
  });
}

export async function POST(request: Request): Promise<Response> {
  if (localMockSmsEnabled() && !isTrustedLoopbackMutationRequest(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  let body: { phone?: unknown };
  try {
    body = await request.json() as { phone?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.phone !== "string") {
    return NextResponse.json({ error: "请输入有效手机号。" }, { status: 400 });
  }
  let normalizedPhone: string;
  let maskedPhone: string;
  try {
    normalizedPhone = normalizePhone(body.phone);
    maskedPhone = maskPhone(normalizedPhone);
  } catch (error) {
    if (error instanceof PhoneAuthError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }
    return NextResponse.json({ error: "请输入有效手机号。" }, { status: 400 });
  }
  const admission = await authorizePhoneOtpAdmission(normalizedPhone);
  if (!admission.allowed) {
    return decoyRequestResponse(request, maskedPhone);
  }
  try {
    prepareUserSessionTokenIssuer();
  } catch {
    return decoyRequestResponse(request, maskedPhone);
  }
  if (!await phoneOtpAdmissionIsCurrent(
    normalizedPhone,
    admission,
  )) return decoyRequestResponse(request, maskedPhone);
  try {
    const provider = resolveSmsProvider();
    const result = await requestPhoneOtp({
      phone: normalizedPhone,
      ip: resolveSmsRequestIp(request.headers),
      provider,
    });
    return acceptedRequestResponse(request, result);
  } catch {
    return decoyRequestResponse(request, maskedPhone);
  }
}
