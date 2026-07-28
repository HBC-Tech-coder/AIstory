import "server-only";

import { createHmac, randomInt, randomUUID } from "node:crypto";

import type { AdminRepository } from "@/lib/admin/repositories";
import {
  createUserWithInitialGrant,
  ingestGameplayEvent,
} from "@/lib/admin/service";
import {
  createPhoneChallenge,
  listRecentPhoneChallenges,
  verifyAndConsumePhoneChallenge,
} from "./phoneAuthStore";

const OTP_TTL_MS = 5 * 60 * 1000;
const REQUEST_WINDOW_MS = 60 * 60 * 1000;
const PHONE_REQUEST_LIMIT = 5;
const IP_REQUEST_LIMIT = 10;
const OTP_MAX_ATTEMPTS = 5;

export interface SmsVerificationProvider {
  readonly id: "local_mock" | "aliyun_dysms";
  readonly available: boolean;
  sendVerificationCode(input: {
    phone: string;
    code: string;
    expiresInSeconds: number;
  }): Promise<void>;
}

export class PhoneAuthError extends Error {
  constructor(
    readonly code:
      | "PHONE_INVALID"
      | "SMS_PROVIDER_UNAVAILABLE"
      | "SMS_RATE_LIMITED"
      | "OTP_INVALID_OR_EXPIRED"
      | "PHONE_AUTH_NOT_CONFIGURED",
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "PhoneAuthError";
  }
}

function requiredSecret(name: string): string {
  const value = process.env[name]?.trim();
  if (!value || value.length < 32) {
    throw new PhoneAuthError(
      "PHONE_AUTH_NOT_CONFIGURED",
      503,
      "手机号登录尚未完成服务端安全配置。",
    );
  }
  return value;
}

function hmac(value: string, secretName: string): string {
  return createHmac("sha256", requiredSecret(secretName))
    .update(value)
    .digest("hex");
}

export function normalizePhone(value: string): string {
  const compact = value.replace(/[\s()-]/g, "");
  if (/^1\d{10}$/.test(compact)) return `+86${compact}`;
  if (/^\+[1-9]\d{7,14}$/.test(compact)) return compact;
  throw new PhoneAuthError("PHONE_INVALID", 400, "请输入有效手机号。");
}

export function maskPhone(phone: string): string {
  const tail = phone.slice(-2);
  const head = phone.startsWith("+86") ? phone.slice(0, 5) : phone.slice(0, 4);
  return `${head}******${tail}`;
}

export function phoneIdentity(phone: string): {
  phoneHash: string;
  userId: string;
  maskedPhone: string;
} {
  const normalized = normalizePhone(phone);
  const phoneHash = hmac(normalized, "AISTORY_PHONE_ID_PEPPER");
  return {
    phoneHash,
    userId: `phone_${phoneHash.slice(0, 32)}`,
    maskedPhone: maskPhone(normalized),
  };
}

function requestIpHash(value: string): string {
  return hmac(value || "unknown", "AISTORY_SMS_OTP_SECRET");
}

function otpHash(challengeId: string, phoneHash: string, code: string): string {
  return hmac(
    `${challengeId}:${phoneHash}:${code}`,
    "AISTORY_SMS_OTP_SECRET",
  );
}

export function resolveSmsProvider(): SmsVerificationProvider {
  if (
    process.env.AISTORY_SMS_PROVIDER === "local_mock"
    && process.env.AISTORY_LOCAL_SMS_ENABLED === "true"
  ) {
    const fixed = process.env.AISTORY_LOCAL_SMS_TEST_CODE?.trim();
    return {
      id: "local_mock",
      available: /^\d{6}$/.test(fixed || ""),
      async sendVerificationCode(): Promise<void> {
        // The local adapter deliberately performs no network I/O and never
        // returns or logs the code. A fixed code must be supplied via env.
      },
    };
  }
  return {
    id: "aliyun_dysms",
    available: false,
    async sendVerificationCode(): Promise<void> {
      throw new PhoneAuthError(
        "SMS_PROVIDER_UNAVAILABLE",
        503,
        "短信服务尚未配置，未发送验证码。",
      );
    },
  };
}

function createOtpCode(provider: SmsVerificationProvider): string {
  if (provider.id === "local_mock") {
    return process.env.AISTORY_LOCAL_SMS_TEST_CODE!.trim();
  }
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export async function requestPhoneOtp(input: {
  phone: string;
  ip: string;
  now?: number;
  provider?: SmsVerificationProvider;
}): Promise<{ challengeId: string; maskedPhone: string; expiresInSeconds: number }> {
  const now = input.now ?? Date.now();
  const normalized = normalizePhone(input.phone);
  const identity = phoneIdentity(normalized);
  const ipHash = requestIpHash(input.ip);
  const recent = await listRecentPhoneChallenges(
    identity.phoneHash,
    ipHash,
    now - REQUEST_WINDOW_MS,
  );
  const phoneRequests = recent.filter(
    (item) => item.phoneHash === identity.phoneHash,
  );
  const ipRequests = recent.filter((item) => item.requestIpHash === ipHash);
  const last = phoneRequests.sort((a, b) => b.createdAt - a.createdAt)[0];
  if (
    (last && now - last.createdAt < 60_000)
    || phoneRequests.length >= PHONE_REQUEST_LIMIT
    || ipRequests.length >= IP_REQUEST_LIMIT
  ) {
    throw new PhoneAuthError(
      "SMS_RATE_LIMITED",
      429,
      "验证码请求过于频繁，请稍后再试。",
    );
  }
  const provider = input.provider ?? resolveSmsProvider();
  if (!provider.available) {
    throw new PhoneAuthError(
      "SMS_PROVIDER_UNAVAILABLE",
      503,
      "短信服务尚未配置，未发送验证码。",
    );
  }
  const challengeId = randomUUID();
  const code = createOtpCode(provider);
  await createPhoneChallenge({
    id: challengeId,
    phoneHash: identity.phoneHash,
    maskedPhone: identity.maskedPhone,
    otpHash: otpHash(challengeId, identity.phoneHash, code),
    requestIpHash: ipHash,
    createdAt: now,
    expiresAt: now + OTP_TTL_MS,
    attempts: 0,
  });
  await provider.sendVerificationCode({
    phone: normalized,
    code,
    expiresInSeconds: OTP_TTL_MS / 1000,
  });
  return {
    challengeId,
    maskedPhone: identity.maskedPhone,
    expiresInSeconds: OTP_TTL_MS / 1000,
  };
}

export async function verifyPhoneOtp(
  repository: AdminRepository,
  input: {
    phone: string;
    challengeId: string;
    code: string;
    now?: number;
  },
): Promise<{
  userId: string;
  maskedPhone: string;
  created: boolean;
  balance: number;
}> {
  const now = input.now ?? Date.now();
  const identity = phoneIdentity(input.phone);
  if (!/^[0-9]{6}$/.test(input.code)) {
    throw new PhoneAuthError(
      "OTP_INVALID_OR_EXPIRED",
      400,
      "验证码无效或已过期。",
    );
  }
  const status = await verifyAndConsumePhoneChallenge({
    challengeId: input.challengeId,
    phoneHash: identity.phoneHash,
    otpHash: otpHash(input.challengeId, identity.phoneHash, input.code),
    now,
    maxAttempts: OTP_MAX_ATTEMPTS,
  });
  if (status !== "verified") {
    throw new PhoneAuthError(
      "OTP_INVALID_OR_EXPIRED",
      400,
      "验证码无效或已过期。",
    );
  }
  const existing = await repository.getUser(identity.userId);
  await createUserWithInitialGrant(repository, {
    userId: identity.userId,
    tenantId: "platform",
    displayName: `用户${identity.maskedPhone.slice(-2)}`,
    maskedContact: identity.maskedPhone,
    status: "active",
    userType: "player",
    locale: "zh-CN",
  });
  if (!existing) {
    await ingestGameplayEvent(repository, {
      id: randomUUID(),
      tenantId: "platform",
      userId: identity.userId,
      sessionId: `registration:${identity.userId}`,
      event: "account_registered",
      createdAt: new Date(now).toISOString(),
    });
  }
  const ledger = await repository.listLedger(identity.userId);
  return {
    userId: identity.userId,
    maskedPhone: identity.maskedPhone,
    created: !existing,
    balance: ledger.reduce((sum, entry) => sum + entry.amount, 0),
  };
}
