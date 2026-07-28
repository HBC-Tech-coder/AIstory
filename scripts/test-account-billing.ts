import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { LocalAdminRepository } from "@/lib/admin/localRepository";
import {
  adjustCredits,
  createUserWithInitialGrant,
  saveBillingPolicy,
} from "@/lib/admin/service";
import type { AdminActor } from "@/lib/admin/types";
import {
  PhoneAuthError,
  maskPhone,
  normalizePhone,
  requestPhoneOtp,
  verifyPhoneOtp,
  type SmsVerificationProvider,
} from "@/lib/auth/phoneAuthService";
import {
  creditsForProviderCost,
  refundPlatformOperation,
  reservePlatformOperation,
  settlePlatformOperation,
} from "@/lib/billing/service";
import { authorizeCredentialAccess } from "@/lib/credentials/serverPolicy";
import {
  createUserSessionToken,
  verifyUserSessionToken,
} from "@/lib/auth/userSession";

const root = await mkdtemp(path.join(os.tmpdir(), "aistory-account-billing-"));
const accountStore = path.join(root, "admin.json");
const phoneStore = path.join(root, "phone-auth.json");
process.env.AISTORY_PHONE_AUTH_STORE_PATH = phoneStore;
process.env.AISTORY_PHONE_ID_PEPPER = "test-phone-pepper-12345678901234567890";
process.env.AISTORY_SMS_OTP_SECRET = "test-otp-secret-1234567890123456789012";
process.env.AISTORY_USER_SESSION_SECRET =
  "test-session-secret-123456789012345678";
process.env.AISTORY_SMS_PROVIDER = "local_mock";
process.env.AISTORY_LOCAL_SMS_ENABLED = "true";
process.env.AISTORY_LOCAL_SMS_TEST_CODE = "731946";

const repository = new LocalAdminRepository(accountStore);
const actor: AdminActor = {
  userId: "local-admin",
  roles: ["super_admin"],
  mode: "local",
};
const delivered: Array<{ phone: string; code: string }> = [];
const provider: SmsVerificationProvider = {
  id: "local_mock",
  available: true,
  async sendVerificationCode(input) {
    delivered.push({ phone: input.phone, code: input.code });
  },
};

try {
  assert.equal(normalizePhone("138 0013 8000"), "+8613800138000");
  assert.equal(maskPhone("+8613800138000"), "+8613******00");
  assert.throws(() => normalizePhone("not-a-phone"), PhoneAuthError);

  const startedAt = 1_000_000;
  const blocked = await requestPhoneOtp({
    phone: "13800138000",
    ip: "127.0.0.1",
    now: startedAt,
    provider,
  });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(
      verifyPhoneOtp(repository, {
        phone: "13800138000",
        challengeId: blocked.challengeId,
        code: "000000",
        now: startedAt + attempt + 1,
      }),
      (error: unknown) =>
        error instanceof PhoneAuthError
        && error.code === "OTP_INVALID_OR_EXPIRED",
    );
  }
  await assert.rejects(
    verifyPhoneOtp(repository, {
      phone: "13800138000",
      challengeId: blocked.challengeId,
      code: "731946",
      now: startedAt + 10,
    }),
    PhoneAuthError,
  );

  await assert.rejects(
    requestPhoneOtp({
      phone: "13800138000",
      ip: "127.0.0.1",
      now: startedAt + 30_000,
      provider,
    }),
    (error: unknown) =>
      error instanceof PhoneAuthError && error.code === "SMS_RATE_LIMITED",
  );

  const challenge = await requestPhoneOtp({
    phone: "13800138000",
    ip: "127.0.0.1",
    now: startedAt + 61_000,
    provider,
  });
  const first = await verifyPhoneOtp(repository, {
    phone: "13800138000",
    challengeId: challenge.challengeId,
    code: "731946",
    now: startedAt + 62_000,
  });
  assert.equal(first.created, true);
  assert.equal(first.balance, 1000);
  assert.match(first.userId, /^phone_[a-f0-9]{32}$/);
  assert.equal(first.maskedPhone, "+8613******00");

  const againChallenge = await requestPhoneOtp({
    phone: "13800138000",
    ip: "127.0.0.1",
    now: startedAt + 122_000,
    provider,
  });
  const second = await verifyPhoneOtp(repository, {
    phone: "13800138000",
    challengeId: againChallenge.challengeId,
    code: "731946",
    now: startedAt + 123_000,
  });
  assert.equal(second.created, false);
  assert.equal(second.balance, 1000);
  assert.equal(
    (await repository.listLedger(first.userId)).filter(
      (entry) => entry.kind === "initial_grant",
    ).length,
    1,
  );

  const expired = await requestPhoneOtp({
    phone: "+14155550100",
    ip: "127.0.0.2",
    now: startedAt + 200_000,
    provider,
  });
  await assert.rejects(
    verifyPhoneOtp(repository, {
      phone: "+14155550100",
      challengeId: expired.challengeId,
      code: "731946",
      now: startedAt + 200_000 + 5 * 60_000 + 1,
    }),
    PhoneAuthError,
  );

  const session = createUserSessionToken(first.userId, startedAt);
  assert.equal(
    verifyUserSessionToken(session, startedAt + 1)?.userId,
    first.userId,
  );
  assert.equal(
    verifyUserSessionToken(`${session}tampered`, startedAt + 1),
    undefined,
  );

  await saveBillingPolicy(
    repository,
    actor,
    {
      version: "test-price-v1",
      markupBasisPoints: 20_000,
      initialGrantCredits: 1000,
      providerCurrency: "CNY",
      providerMinorUnitScale: 2,
      creditUnitsPerProviderMinor: 1,
      entries: [
        {
          operation: "story.start",
          modality: "mixed",
          provider: "fixture",
          model: "fixture-model",
          providerCostMinor: 123,
          enabled: true,
        },
      ],
    },
    "测试版本化价格与两倍计费",
    "request-price-policy-1",
  );
  await createUserWithInitialGrant(repository, {
    userId: first.userId,
    tenantId: "platform",
    displayName: first.maskedPhone,
    maskedContact: first.maskedPhone,
    status: "active",
    userType: "player",
  });
  assert.equal(
    (await repository.listLedger(first.userId)).filter(
      (entry) => entry.kind === "initial_grant",
    ).length,
    1,
    "a price-policy version change must not mint another registration grant",
  );
  assert.equal(
    creditsForProviderCost(123, {
      markupBasisPoints: 20_000,
      creditUnitsPerProviderMinor: 1,
    }),
    246,
  );

  const reservation = await reservePlatformOperation(repository, {
    userId: first.userId,
    operation: "story.start",
    idempotencyKey: "generation:test:start:1",
  });
  const reservationReplay = await reservePlatformOperation(repository, {
    userId: first.userId,
    operation: "story.start",
    idempotencyKey: "generation:test:start:1",
  });
  assert.equal(reservationReplay.entry.id, reservation.entry.id);
  assert.equal(reservation.quote.estimatedCredits, 246);
  await settlePlatformOperation(repository, reservation);
  const settledThenRefunded = await refundPlatformOperation(
    repository,
    reservation,
    "late stream error after provider settlement",
  );
  assert.equal(
    settledThenRefunded.kind,
    "settle",
    "a settled operation cannot be refunded by a late error callback",
  );
  assert.equal(
    (await repository.listLedger(first.userId))
      .reduce((sum, entry) => sum + entry.amount, 0),
    754,
  );

  const failedReservation = await reservePlatformOperation(repository, {
    userId: first.userId,
    operation: "story.start",
    idempotencyKey: "generation:test:start:2",
  });
  await refundPlatformOperation(
    repository,
    failedReservation,
    "fixture provider failed",
  );
  const refundedThenSettled = await settlePlatformOperation(
    repository,
    failedReservation,
  );
  assert.equal(
    refundedThenSettled.kind,
    "refund",
    "a refunded operation cannot be settled by a late success callback",
  );
  assert.equal(
    (await repository.listLedger(first.userId))
      .reduce((sum, entry) => sum + entry.amount, 0),
    754,
  );

  const racedReservation = await reservePlatformOperation(repository, {
    userId: first.userId,
    operation: "story.start",
    idempotencyKey: "generation:test:start:terminal-race",
  });
  const [raceSettle, raceRefund] = await Promise.all([
    settlePlatformOperation(repository, racedReservation),
    refundPlatformOperation(
      repository,
      racedReservation,
      "concurrent terminal fixture",
    ),
  ]);
  assert.equal(raceSettle.id, raceRefund.id);
  assert.equal(
    (await repository.listLedger(first.userId)).filter(
      (entry) =>
        entry.billingOperationId === racedReservation.entry.billingOperationId
        && (entry.kind === "settle" || entry.kind === "refund"),
    ).length,
    1,
    "settle/refund races must produce exactly one terminal ledger entry",
  );

  const adjustment = {
    userId: first.userId,
    amount: 100,
    reason: "内测用户一次性赠送",
    idempotencyKey: "admin_grant:test:001",
    requestId: "request-admin-grant-1",
  };
  await Promise.all([
    adjustCredits(repository, actor, adjustment),
    adjustCredits(repository, actor, {
      ...adjustment,
      requestId: "request-admin-grant-replay",
    }),
  ]);
  assert.equal(
    (await repository.listLedger(first.userId)).filter(
      (entry) => entry.idempotencyKey === adjustment.idempotencyKey,
    ).length,
    1,
  );
  assert.equal(
    (await repository.listAudit()).filter(
      (entry) => entry.action === "credit.manual_adjustment",
    ).length,
    1,
  );

  assert.equal(authorizeCredentialAccess({
    requestedMode: "user_byok",
    hasByok: true,
    userId: "anonymous",
    env: { AISTORY_PLATFORM_BILLING_ENABLED: "true" },
  }).allowed, true);
  const anonymousPlatform = authorizeCredentialAccess({
    requestedMode: "platform_managed",
    hasByok: false,
    userId: "anonymous",
    env: { AISTORY_PLATFORM_BILLING_ENABLED: "true" },
  });
  assert.equal(anonymousPlatform.allowed, false);
  assert.equal(
    anonymousPlatform.allowed ? "" : anonymousPlatform.code,
    "PHONE_VERIFICATION_REQUIRED",
  );

  await saveBillingPolicy(
    repository,
    actor,
    {
      version: "test-price-v2",
      markupBasisPoints: 20_000,
      initialGrantCredits: 1200,
      providerCurrency: "CNY",
      providerMinorUnitScale: 2,
      creditUnitsPerProviderMinor: 1,
      entries: [
        {
          operation: "story.start",
          modality: "mixed",
          provider: "fixture",
          model: "fixture-model-v2",
          providerCostMinor: 125,
          enabled: true,
        },
      ],
    },
    "测试保留旧版价目并发布新版",
    "request-price-policy-2",
  );
  await createUserWithInitialGrant(repository, {
    userId: first.userId,
    tenantId: "platform",
    displayName: first.maskedPhone,
    maskedContact: first.maskedPhone,
    status: "active",
    userType: "player",
  });
  assert.equal(
    (await repository.listLedger(first.userId)).filter(
      (entry) => entry.kind === "initial_grant",
    ).length,
    1,
  );

  const persisted = `${await readFile(accountStore, "utf8")}\n${
    await readFile(phoneStore, "utf8")
  }`;
  assert.equal(persisted.includes("test-price-v1"), true);
  assert.equal(persisted.includes("test-price-v2"), true);
  assert.equal(persisted.includes("13800138000"), false);
  assert.equal(persisted.includes("+8613800138000"), false);
  assert.equal(persisted.includes("731946"), false);
  assert.equal(delivered.length >= 4, true);

  process.env.AISTORY_CACHE_DIR = path.join(root, "scene-cache");
  const sceneCache = await import("@/lib/engine/sceneCache");
  const cacheMeta = {
    status: "miss" as const,
    key: "anonymous-free-cache-fixture",
    sceneNumber: 1,
  };
  let modelCalls = 0;
  await sceneCache.withSceneCache(cacheMeta, "anonymous-fixture", async () => {
    modelCalls += 1;
    return { sceneImageUrl: "https://example.test/already-published.webp" };
  });
  const anonymousHit = await sceneCache.peekSceneCache(cacheMeta);
  assert.equal(anonymousHit?.cache.status, "hit");
  assert.equal(modelCalls, 1, "anonymous cache read must not invoke a model");

  const speculative = await import("@/lib/engine/speculativeBranchCache");
  assert.equal(
    speculative.rejectSpeculativeRequest({
      mode: "prefetch",
      requestedDepth: 0,
      branchOrdinal: 0,
      includeAudio: false,
    }),
    "prefetch-disabled",
    "depth 0 must fail before any text, image, TTS or GPU scheduling",
  );

  console.log("account, SMS mock and platform billing tests passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
