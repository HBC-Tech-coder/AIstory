import { NextResponse } from "next/server";

import {
  PhoneAuthError,
  requestPhoneOtp,
  resolveSmsProvider,
} from "@/lib/auth/phoneAuthService";
import { isTrustedLoopbackMutationRequest } from "@/lib/security/localMutation";

export const runtime = "nodejs";

function clientIp(request: Request): string {
  if (process.env.AISTORY_TRUST_PROXY_HEADERS !== "true") {
    return "direct-client";
  }
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("x-real-ip")?.trim()
    || "loopback"
  );
}

export async function POST(request: Request): Promise<Response> {
  const provider = resolveSmsProvider();
  if (
    provider.id === "local_mock"
    && !isTrustedLoopbackMutationRequest(request)
  ) {
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
  try {
    const result = await requestPhoneOtp({
      phone: body.phone,
      ip: clientIp(request),
      provider,
    });
    return NextResponse.json(
      {
        ok: true,
        challengeId: result.challengeId,
        maskedPhone: result.maskedPhone,
        expiresInSeconds: result.expiresInSeconds,
        message: "如果号码可用，验证码将很快送达。",
      },
      { status: 202 },
    );
  } catch (error) {
    if (error instanceof PhoneAuthError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        {
          status: error.status,
          headers: error.status === 429 ? { "Retry-After": "60" } : undefined,
        },
      );
    }
    return NextResponse.json(
      { error: "验证码暂时无法发送。" },
      { status: 503 },
    );
  }
}
