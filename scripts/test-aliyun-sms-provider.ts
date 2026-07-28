import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { LocalAdminRepository } from "@/lib/admin/localRepository";
import {
  ALIYUN_SMS_API_VERSION,
  ALIYUN_SMS_DEFAULT_ENDPOINT,
  ALIYUN_SMS_DEFAULT_REGION,
  createAliyunSmsProvider,
  type AliyunSmsDiagnostic,
  type AliyunSmsTransport,
  type AliyunSmsTransportInput,
} from "@/lib/auth/aliyunSmsProvider";
import {
  PhoneAuthError,
  requestPhoneOtp,
  resolveSmsProvider,
  verifyPhoneOtp,
  type PhoneOtpChallengeStore,
} from "@/lib/auth/phoneAuthService";
import {
  createPhoneChallenge,
  invalidatePhoneChallenge,
  listRecentPhoneChallenges,
} from "@/lib/auth/phoneAuthStore";
import { POST as requestPhoneRoute } from "@/app/api/auth/phone/request/route";

const root = await mkdtemp(path.join(os.tmpdir(), "aistory-sms-provider-"));
const phoneStore = path.join(root, "phone-auth.json");
const accountStore = path.join(root, "admin.json");
const fixturePhone = "+8613900012345";
const fixturePhoneDigits = "13900012345";
const routeFixturePhone = "+8613500056789";
const fixtureCode = "582704";
const fixtureAccessKeyId = "fixture-access-key-id";
const fixtureAccessKeySecret = "fixture-access-key-secret";
const fixtureSignName = "测试签名";
const fixtureTemplateCode = "SMS_TestLogin01";

process.env.AISTORY_PHONE_AUTH_STORE_PATH = phoneStore;
process.env.AISTORY_PHONE_ID_PEPPER =
  "fixture-phone-pepper-12345678901234567890";
process.env.AISTORY_SMS_OTP_SECRET =
  "fixture-otp-secret-1234567890123456789012";
process.env.AISTORY_USER_SESSION_SECRET =
  "fixture-session-secret-123456789012345678";

const validEnv = {
  ALIBABA_CLOUD_ACCESS_KEY_ID: fixtureAccessKeyId,
  ALIBABA_CLOUD_ACCESS_KEY_SECRET: fixtureAccessKeySecret,
  ALIYUN_SMS_SIGN_NAME: fixtureSignName,
  ALIYUN_SMS_TEMPLATE_CODE_LOGIN: fixtureTemplateCode,
};

type StoredChallenge = {
  id: string;
  status?: "pending" | "sent" | "invalidated";
};

async function readChallenges(): Promise<StoredChallenge[]> {
  const parsed = JSON.parse(await readFile(phoneStore, "utf8")) as {
    challenges: StoredChallenge[];
  };
  return parsed.challenges;
}

function assertGenericProviderError(
  error: unknown,
  code: "SMS_PROVIDER_UNAVAILABLE" | "SMS_RATE_LIMITED",
): boolean {
  assert.ok(error instanceof PhoneAuthError);
  assert.equal(error.code, code);
  const serialized = JSON.stringify({
    code: error.code,
    status: error.status,
    message: error.message,
  });
  for (const sensitive of [
    fixturePhone,
    fixturePhoneDigits,
    fixtureCode,
    fixtureAccessKeyId,
    fixtureAccessKeySecret,
    fixtureSignName,
    fixtureTemplateCode,
  ]) {
    assert.equal(serialized.includes(sensitive), false);
  }
  return true;
}

try {
  assert.equal(ALIYUN_SMS_API_VERSION, "2017-05-25");
  assert.equal(ALIYUN_SMS_DEFAULT_ENDPOINT, "dysmsapi.aliyuncs.com");
  assert.equal(ALIYUN_SMS_DEFAULT_REGION, "cn-hangzhou");

  assert.equal(createAliyunSmsProvider({ env: {} }).available, false);
  assert.equal(
    createAliyunSmsProvider({
      env: {
        ...validEnv,
        ALIBABA_CLOUD_ACCESS_KEY_SECRET: undefined,
      },
    }).available,
    false,
  );
  assert.equal(
    createAliyunSmsProvider({
      env: {
        ...validEnv,
        ALIYUN_SMS_ENDPOINT: "example.invalid",
      },
    }).available,
    false,
  );

  const delivered: AliyunSmsTransportInput[] = [];
  const successProvider = createAliyunSmsProvider({
    env: validEnv,
    transport: {
      async sendSms(input) {
        delivered.push(input);
        return { code: "OK", requestId: "fixture-request-0001" };
      },
    },
  });
  assert.equal(successProvider.available, true);
  await successProvider.sendVerificationCode({
    phone: fixturePhone,
    code: fixtureCode,
    expiresInSeconds: 300,
  });
  assert.deepEqual(delivered[0], {
    phoneNumbers: fixturePhoneDigits,
    signName: fixtureSignName,
    templateCode: fixtureTemplateCode,
    templateParam: JSON.stringify({ code: fixtureCode }),
  });
  assert.deepEqual(Object.keys(JSON.parse(delivered[0]!.templateParam)), [
    "code",
  ]);

  const customParam: AliyunSmsTransportInput[] = [];
  await createAliyunSmsProvider({
    env: {
      ...validEnv,
      ALIYUN_SMS_TEMPLATE_PARAM_CODE_KEY: "verification_code",
    },
    transport: {
      async sendSms(input) {
        customParam.push(input);
        return { code: "OK" };
      },
    },
  }).sendVerificationCode({
    phone: fixturePhone,
    code: fixtureCode,
    expiresInSeconds: 300,
  });
  assert.deepEqual(
    JSON.parse(customParam[0]!.templateParam),
    { verification_code: fixtureCode },
  );

  let nonChinaTransportCalls = 0;
  const domesticOnly = createAliyunSmsProvider({
    env: validEnv,
    transport: {
      async sendSms() {
        nonChinaTransportCalls += 1;
        return { code: "OK" };
      },
    },
  });
  await assert.rejects(
    domesticOnly.sendVerificationCode({
      phone: "+14155550100",
      code: fixtureCode,
      expiresInSeconds: 300,
    }),
    (error: unknown) =>
      error instanceof PhoneAuthError && error.code === "PHONE_INVALID",
  );
  assert.equal(nonChinaTransportCalls, 0);

  for (const providerResult of [
    { code: "ok", expected: "SMS_PROVIDER_UNAVAILABLE" as const },
    { code: "isv.BUSINESS_LIMIT_CONTROL", expected: "SMS_RATE_LIMITED" as const },
  ]) {
    const provider = createAliyunSmsProvider({
      env: validEnv,
      transport: {
        async sendSms() {
          return {
            code: providerResult.code,
            requestId: "fixture-request-0002",
          };
        },
      },
    });
    await assert.rejects(
      provider.sendVerificationCode({
        phone: fixturePhone,
        code: fixtureCode,
        expiresInSeconds: 300,
      }),
      (error: unknown) =>
        assertGenericProviderError(error, providerResult.expected),
    );
  }

  const diagnostics: AliyunSmsDiagnostic[] = [];
  const timeoutProvider = createAliyunSmsProvider({
    env: validEnv,
    onDiagnostic(event) {
      diagnostics.push(event);
    },
    transport: {
      async sendSms() {
        const error = new Error(
          `timeout ${fixturePhone} ${fixtureCode} ${fixtureAccessKeySecret}`,
        ) as Error & {
          code: string;
          requestId: string;
        };
        error.code = `Timeout:${fixtureCode}`;
        error.requestId = `request-${fixturePhoneDigits}`;
        throw error;
      },
    },
  });
  await assert.rejects(
    timeoutProvider.sendVerificationCode({
      phone: fixturePhone,
      code: fixtureCode,
      expiresInSeconds: 300,
    }),
    (error: unknown) =>
      assertGenericProviderError(error, "SMS_PROVIDER_UNAVAILABLE"),
  );
  assert.deepEqual(diagnostics, [{
    outcome: "unavailable",
    providerCode: undefined,
    requestId: undefined,
    durationMs: diagnostics[0]!.durationMs,
  }]);
  assert.equal(JSON.stringify(diagnostics).includes(fixtureCode), false);
  assert.equal(JSON.stringify(diagnostics).includes(fixturePhoneDigits), false);

  let releaseSend: ((result: { code: string; requestId: string }) => void)
    | undefined;
  let notifyStarted: (() => void) | undefined;
  const sendStarted = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  const sendGate = new Promise<{ code: string; requestId: string }>((resolve) => {
    releaseSend = resolve;
  });
  let challengeCode = "";
  const pendingTransport: AliyunSmsTransport = {
    async sendSms(input) {
      challengeCode = JSON.parse(input.templateParam).code as string;
      notifyStarted?.();
      return sendGate;
    },
  };
  const pendingRequest = requestPhoneOtp({
    phone: fixturePhone,
    ip: "127.0.0.10",
    now: Date.now(),
    provider: createAliyunSmsProvider({
      env: validEnv,
      transport: pendingTransport,
    }),
  });
  await sendStarted;
  const pendingState = await readChallenges();
  assert.equal(pendingState.at(-1)?.status, "pending");
  releaseSend?.({ code: "OK", requestId: "fixture-request-0003" });
  const sentChallenge = await pendingRequest;
  const sentState = await readChallenges();
  assert.equal(
    sentState.find((item) => item.id === sentChallenge.challengeId)?.status,
    "sent",
  );
  const repository = new LocalAdminRepository(accountStore);
  const account = await verifyPhoneOtp(repository, {
    phone: fixturePhone,
    challengeId: sentChallenge.challengeId,
    code: challengeCode,
    now: Date.now() + 1,
  });
  assert.equal(account.balance, 1000);
  assert.equal(
    (await repository.listLedger(account.userId)).filter(
      (entry) => entry.kind === "initial_grant",
    ).length,
    1,
  );

  let failedCode = "";
  await assert.rejects(
    requestPhoneOtp({
      phone: "+8613800023456",
      ip: "127.0.0.11",
      now: Date.now() + 61_000,
      provider: createAliyunSmsProvider({
        env: validEnv,
        transport: {
          async sendSms(input) {
            failedCode = JSON.parse(input.templateParam).code as string;
            throw new Error("fixture transport failed");
          },
        },
      }),
    }),
    (error: unknown) =>
      assertGenericProviderError(error, "SMS_PROVIDER_UNAVAILABLE"),
  );
  const failedChallenge = (await readChallenges()).at(-1)!;
  assert.equal(failedChallenge.status, "invalidated");
  await assert.rejects(
    verifyPhoneOtp(repository, {
      phone: "+8613800023456",
      challengeId: failedChallenge.id,
      code: failedCode,
      now: Date.now() + 61_001,
    }),
    (error: unknown) =>
      error instanceof PhoneAuthError
      && error.code === "OTP_INVALID_OR_EXPIRED",
  );

  let markFailureCode = "";
  const markFailureStore: PhoneOtpChallengeStore = {
    listRecent: listRecentPhoneChallenges,
    create: createPhoneChallenge,
    async markSent() {
      return false;
    },
    invalidate: invalidatePhoneChallenge,
  };
  await assert.rejects(
    requestPhoneOtp({
      phone: "+8613700034567",
      ip: "127.0.0.12",
      now: Date.now() + 122_000,
      provider: createAliyunSmsProvider({
        env: validEnv,
        transport: {
          async sendSms(input) {
            markFailureCode = JSON.parse(input.templateParam).code as string;
            return { code: "OK", requestId: "fixture-request-0004" };
          },
        },
      }),
      challengeStore: markFailureStore,
    }),
    (error: unknown) =>
      assertGenericProviderError(error, "SMS_PROVIDER_UNAVAILABLE"),
  );
  const markFailureChallenge = (await readChallenges()).at(-1)!;
  assert.equal(markFailureChallenge.status, "invalidated");
  await assert.rejects(
    verifyPhoneOtp(repository, {
      phone: "+8613700034567",
      challengeId: markFailureChallenge.id,
      code: markFailureCode,
      now: Date.now() + 122_001,
    }),
    (error: unknown) =>
      error instanceof PhoneAuthError
      && error.code === "OTP_INVALID_OR_EXPIRED",
  );

  process.env.AISTORY_SMS_PROVIDER = "aliyun_dysms";
  delete process.env.ALIBABA_CLOUD_ACCESS_KEY_ID;
  delete process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET;
  delete process.env.ALIYUN_SMS_SIGN_NAME;
  delete process.env.ALIYUN_SMS_TEMPLATE_CODE_LOGIN;
  const unavailableResponse = await requestPhoneRoute(new Request(
    "http://127.0.0.1:4200/api/auth/phone/request",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "127.0.0.1:4200",
        origin: "http://127.0.0.1:4200",
      },
      body: JSON.stringify({ phone: routeFixturePhone }),
    },
  ));
  assert.equal(unavailableResponse.status, 503);
  const unavailableBody = await unavailableResponse.text();
  for (const sensitive of [
    fixturePhone,
    fixturePhoneDigits,
    routeFixturePhone,
    fixtureAccessKeyId,
    fixtureAccessKeySecret,
    fixtureCode,
  ]) {
    assert.equal(unavailableBody.includes(sensitive), false);
  }

  process.env.AISTORY_SMS_PROVIDER = "local_mock";
  process.env.AISTORY_LOCAL_SMS_ENABLED = "true";
  process.env.AISTORY_LOCAL_SMS_TEST_CODE = "731946";
  assert.equal(resolveSmsProvider().available, true);
  const lanResponse = await requestPhoneRoute(new Request(
    "http://192.168.1.20:4200/api/auth/phone/request",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "192.168.1.20:4200",
        origin: "http://192.168.1.20:4200",
      },
      body: JSON.stringify({ phone: "+8613600045678" }),
    },
  ));
  assert.equal(lanResponse.status, 403);
  const loopbackResponse = await requestPhoneRoute(new Request(
    "http://127.0.0.1:4200/api/auth/phone/request",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "127.0.0.1:4200",
        origin: "http://127.0.0.1:4200",
      },
      body: JSON.stringify({ phone: "+8613600045678" }),
    },
  ));
  assert.equal(loopbackResponse.status, 202);
  const loopbackBody = await loopbackResponse.text();
  assert.equal(loopbackBody.includes("731946"), false);
  assert.equal(loopbackBody.includes("13600045678"), false);

  const persisted = `${await readFile(phoneStore, "utf8")}\n${
    await readFile(accountStore, "utf8")
  }`;
  assert.equal(persisted.includes(fixturePhone), false);
  assert.equal(persisted.includes(fixturePhoneDigits), false);
  assert.equal(persisted.includes(fixtureCode), false);
  assert.equal(persisted.includes(fixtureAccessKeySecret), false);

  console.log("Aliyun SMS provider contract tests passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
