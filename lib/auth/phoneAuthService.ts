import "server-only";

import { createHmac, randomInt, randomUUID } from "node:crypto";

import type { AdminRepository } from "@/lib/admin/repositories";
import {
  createUserWithInitialGrant,
  ingestGameplayEvent,
} from "@/lib/admin/service";
import {
  createPhoneChallenge,
  invalidatePhoneChallenge,
  listRecentPhoneChallenges,
  markPhoneChallengeSent,
  verifyAndConsumePhoneChallenge,
} from "./phoneAuthStore";
import {
  getProductionPhoneIdentityRepository,
  type ProductionPhoneIdentityRepository,
} from "./phoneIdentityRepository";
import { createAliyunSmsProvider } from "./aliyunSmsProvider";
import {
  PhoneAuthError,
  type SmsVerificationProvider,
} from "./smsProvider";
import {
  assertProductionDatabaseGate,
  ProductionDatabaseGateError,
} from "@/lib/production/databaseGate";

export { PhoneAuthError };
export type { SmsVerificationProvider };

const OTP_TTL_MS = 5 * 60 * 1000;
const REQUEST_WINDOW_MS = 60 * 60 * 1000;
const PHONE_REQUEST_LIMIT = 5;
const IP_REQUEST_LIMIT = 10;
const OTP_MAX_ATTEMPTS = 5;

export type PhoneOtpChallengeStore = {
  listRecent: typeof listRecentPhoneChallenges;
  create: typeof createPhoneChallenge;
  markSent: typeof markPhoneChallengeSent;
  invalidate: typeof invalidatePhoneChallenge;
};

const DEFAULT_CHALLENGE_STORE: PhoneOtpChallengeStore = {
  listRecent: listRecentPhoneChallenges,
  create: createPhoneChallenge,
  markSent: markPhoneChallengeSent,
  invalidate: invalidatePhoneChallenge,
};

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
  if (process.env.AISTORY_SMS_PROVIDER === "aliyun_dysms") {
    return createAliyunSmsProvider();
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
  challengeStore?: PhoneOtpChallengeStore;
  identityRepository?: ProductionPhoneIdentityRepository;
}): Promise<{ challengeId: string; maskedPhone: string; expiresInSeconds: number }> {
  const now = input.now ?? Date.now();
  const challengeStore = input.challengeStore ?? DEFAULT_CHALLENGE_STORE;
  const normalized = normalizePhone(input.phone);
  const identity = phoneIdentity(normalized);
  const ipHash = requestIpHash(input.ip);
  const provider = input.provider ?? resolveSmsProvider();
  const productionIdentity =
    process.env.AISTORY_IDENTITY_REPOSITORY === "supabase"
    || (
      process.env.AISTORY_SMS_PROVIDER === "aliyun_dysms"
      && provider.id === "aliyun_dysms"
    );
  let identityRepository: ProductionPhoneIdentityRepository | undefined;
  if (productionIdentity) {
    assertProductionDatabaseGate("sms");
    identityRepository =
      input.identityRepository ?? getProductionPhoneIdentityRepository();
    await identityRepository.assertReady();
  } else {
    const recent = await challengeStore.listRecent(
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
  }
  if (!provider.available) {
    throw new PhoneAuthError(
      "SMS_PROVIDER_UNAVAILABLE",
      503,
      "短信服务尚未配置，未发送验证码。",
    );
  }
  const challengeId = randomUUID();
  const code = createOtpCode(provider);
  const challengeOtpHash = otpHash(challengeId, identity.phoneHash, code);
  if (identityRepository) {
    await identityRepository.createPendingChallenge({
      id: challengeId,
      phoneHash: identity.phoneHash,
      otpHash: challengeOtpHash,
      requestIpHash: ipHash,
    });
  } else {
    await challengeStore.create({
      id: challengeId,
      phoneHash: identity.phoneHash,
      maskedPhone: identity.maskedPhone,
      otpHash: challengeOtpHash,
      requestIpHash: ipHash,
      createdAt: now,
      expiresAt: now + OTP_TTL_MS,
      attempts: 0,
      status: "pending",
    });
  }
  try {
    await provider.sendVerificationCode({
      phone: normalized,
      code,
      expiresInSeconds: OTP_TTL_MS / 1000,
    });
    const markedSent = identityRepository
      ? await identityRepository.markChallengeSent(challengeId)
      : await challengeStore.markSent(challengeId);
    if (!markedSent) {
      throw new PhoneAuthError(
        "SMS_PROVIDER_UNAVAILABLE",
        503,
        "短信服务暂时不可用，请稍后再试。",
      );
    }
  } catch (error) {
    await (
      identityRepository
        ? identityRepository.invalidateChallenge(challengeId)
        : challengeStore.invalidate(challengeId)
    ).catch(() => undefined);
    if (error instanceof PhoneAuthError) throw error;
    if (error instanceof ProductionDatabaseGateError) throw error;
    throw new PhoneAuthError(
      "SMS_PROVIDER_UNAVAILABLE",
      503,
      "短信服务暂时不可用，请稍后再试。",
    );
  }
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
    locale?: string;
    identityRepository?: ProductionPhoneIdentityRepository;
  },
): Promise<{
  userId: string;
  maskedPhone: string;
  created: boolean;
  initialGrantApplied: boolean;
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
  if (process.env.AISTORY_IDENTITY_REPOSITORY === "supabase") {
    assertProductionDatabaseGate("identity");
    const identityRepository =
      input.identityRepository ?? getProductionPhoneIdentityRepository();
    const verified = await identityRepository.verifyAndRegister({
      challengeId: input.challengeId,
      phoneHash: identity.phoneHash,
      otpHash: otpHash(input.challengeId, identity.phoneHash, input.code),
      maskedPhone: identity.maskedPhone,
      locale: input.locale || "zh-CN",
    });
    if (!verified) {
      throw new PhoneAuthError(
        "OTP_INVALID_OR_EXPIRED",
        400,
        "验证码无效或已过期。",
      );
    }
    return verified;
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
    initialGrantApplied: !existing,
    balance: ledger.reduce((sum, entry) => sum + entry.amount, 0),
  };
}
