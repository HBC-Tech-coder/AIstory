import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { POST as requestPhoneOtpRoute } from
  "@/app/api/auth/phone/request/route";
import { POST as verifyPhoneOtpRoute } from
  "@/app/api/auth/phone/verify/route";
import {
  authorizePhoneForInviteBeta,
  authorizePhoneOtpAdmission,
  inviteBetaSessionBindingIsCurrent,
  parsePhoneInviteBetaAllowlist,
  parsePhoneRegistrationPolicy,
  PHONE_BETA_CREDIT_MEMBERSHIP_CAPABILITY_ID,
  PHONE_INVITE_BETA_ALLOWLIST_FILE_ENV,
  PHONE_INVITE_BETA_ENABLED_ENV,
  PHONE_INVITE_BETA_PHONE_HASH_DOMAIN,
  PHONE_INVITE_BETA_POLICY_ID,
  PHONE_REGISTRATION_POLICY_ENV,
  PHONE_REGISTRATION_POLICY_ID,
  PHONE_REGISTRATION_POLICY_VALUES,
  phoneOtpAdmissionIsCurrent,
  phoneRegistrationSessionBindingIsCurrent,
  resolvePhoneBetaCreditMembership,
} from "@/lib/auth/phoneInviteBetaGate";
import {
  normalizePhone,
  verifyPhoneOtp,
} from "@/lib/auth/phoneAuthService";
import { getAdminRepository } from "@/lib/admin/service";
import {
  createUserSessionToken,
  verifyUserSessionToken,
} from "@/lib/auth/userSession";

const root = await mkdtemp(path.join(os.tmpdir(), "aistory-phone-policy-"));
const protectedRoot = path.join(root, "protected");
const runtimeRoot = path.join(root, "runtime");
const allowlistFile = path.join(protectedRoot, "beta-credit-members-v1.json");
const phoneStore = path.join(runtimeRoot, "phone-auth.json");
const adminStore = path.join(runtimeRoot, ".aistory-admin", "store.json");
const originalCwd = process.cwd();
const originalFetch = globalThis.fetch;
const environmentNames = [
  PHONE_REGISTRATION_POLICY_ENV,
  PHONE_INVITE_BETA_ENABLED_ENV,
  PHONE_INVITE_BETA_ALLOWLIST_FILE_ENV,
  "AISTORY_PHONE_ID_PEPPER",
  "AISTORY_SMS_OTP_SECRET",
  "AISTORY_USER_SESSION_SECRET",
  "AISTORY_SMS_PROVIDER",
  "AISTORY_LOCAL_SMS_ENABLED",
  "AISTORY_LOCAL_SMS_TEST_CODE",
  "AISTORY_PHONE_AUTH_STORE_PATH",
  "AISTORY_IDENTITY_REPOSITORY",
  "AISTORY_ADMIN_REPOSITORY",
  "AISTORY_ANONYMOUS_SESSION_SECRET",
  "AISTORY_ANONYMOUS_SUBJECT_PEPPER",
] as const;
const originalEnvironment = Object.fromEntries(
  environmentNames.map((name) => [name, process.env[name]]),
);

const phonePepper = `fixture-${"phone-pepper-".repeat(3)}`;
const localOtp = "7".repeat(6);

function syntheticNationalPhone(
  secondDigit: 3 | 4 | 5 | 6 | 7 | 8 | 9,
  finalDigit: number,
): string {
  return `1${secondDigit}${"0".repeat(8)}${finalDigit}`;
}

const memberNationalPhone = syntheticNationalPhone(3, 1);
const publicNationalPhone = syntheticNationalPhone(4, 2);
const deniedNationalPhone = syntheticNationalPhone(5, 3);
const capabilityNationalPhone = syntheticNationalPhone(6, 4);
const memberPhone = normalizePhone(memberNationalPhone);
const publicPhone = normalizePhone(publicNationalPhone);
const deniedPhone = normalizePhone(deniedNationalPhone);
const capabilityPhone = normalizePhone(capabilityNationalPhone);
const formattedPublicPhone = [
  publicNationalPhone.slice(0, 3),
  publicNationalPhone.slice(3, 7),
  publicNationalPhone.slice(7),
].join(" ");

function phoneHash(phone: string): string {
  return createHmac("sha256", phonePepper)
    .update(PHONE_INVITE_BETA_PHONE_HASH_DOMAIN)
    .update("\n")
    .update(phone)
    .digest("hex");
}

const memberPhoneHash = phoneHash(memberPhone);
const deniedPhoneHash = phoneHash(deniedPhone);
const capabilityPhoneHash = phoneHash(capabilityPhone);

async function writeAllowlist(phoneHashes: string[]): Promise<void> {
  await mkdir(protectedRoot, { recursive: true });
  await writeFile(
    allowlistFile,
    JSON.stringify({
      schemaVersion: 1,
      policyId: PHONE_INVITE_BETA_POLICY_ID,
      phoneHashDomain: PHONE_INVITE_BETA_PHONE_HASH_DOMAIN,
      phoneHashes: [...phoneHashes].sort(),
    }),
    { encoding: "utf8", mode: 0o600 },
  );
  if (process.platform !== "win32") await chmod(allowlistFile, 0o600);
}

function loopbackRequest(pathname: string, body: unknown): Request {
  const origin = "http://127.0.0.1:42991";
  return new Request(`${origin}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: "127.0.0.1:42991",
      origin,
    },
    body: JSON.stringify(body),
  });
}

type RequestReceipt = {
  ok?: boolean;
  challengeId?: string;
  maskedPhone?: string;
  expiresInSeconds?: number;
  retryAfterSeconds?: number;
  message?: string;
};

type ChallengeStoreProjection = {
  challenges?: Array<{
    id?: string;
    status?: string;
    attempts?: number;
    consumedAt?: number;
  }>;
};

async function readChallenges(): Promise<ChallengeStoreProjection> {
  try {
    return JSON.parse(await readFile(phoneStore, "utf8")) as
      ChallengeStoreProjection;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

function redactChallenge(receipt: RequestReceipt): RequestReceipt {
  return {
    ...receipt,
    challengeId: receipt.challengeId ? "<opaque-challenge>" : undefined,
  };
}

function assertNoSensitiveBetaData(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const forbidden of [
    memberPhone,
    memberNationalPhone,
    publicPhone,
    publicNationalPhone,
    capabilityPhone,
    capabilityNationalPhone,
    memberPhoneHash,
    deniedPhoneHash,
    capabilityPhoneHash,
    phonePepper,
    allowlistFile,
  ]) {
    assert.equal(serialized.includes(forbidden), false, "sensitive beta data");
  }
}

function sessionTokenFrom(response: Response): string {
  const setCookie = response.headers.get("set-cookie") || "";
  const match = setCookie.match(/aistory_user_session=([^;]+)/);
  assert.ok(match?.[1]);
  return decodeURIComponent(match![1]!);
}

let fetchCalls = 0;
Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  value: async () => {
    fetchCalls += 1;
    throw new Error("network access is forbidden in this test");
  },
});

try {
  await mkdir(runtimeRoot, { recursive: true });
  process.chdir(runtimeRoot);
  Object.assign(process.env, {
    [PHONE_REGISTRATION_POLICY_ENV]:
      PHONE_REGISTRATION_POLICY_VALUES.publicBeta,
    [PHONE_INVITE_BETA_ENABLED_ENV]: "true",
    [PHONE_INVITE_BETA_ALLOWLIST_FILE_ENV]: allowlistFile,
    AISTORY_PHONE_ID_PEPPER: phonePepper,
    AISTORY_SMS_OTP_SECRET: `fixture-${"otp-secret-".repeat(3)}`,
    AISTORY_USER_SESSION_SECRET: `fixture-${"session-secret-".repeat(3)}`,
    AISTORY_SMS_PROVIDER: "local_mock",
    AISTORY_LOCAL_SMS_ENABLED: "true",
    AISTORY_LOCAL_SMS_TEST_CODE: localOtp,
    AISTORY_PHONE_AUTH_STORE_PATH: phoneStore,
    AISTORY_IDENTITY_REPOSITORY: "local",
    AISTORY_ADMIN_REPOSITORY: "local",
    AISTORY_ANONYMOUS_SESSION_SECRET:
      `fixture-${"anonymous-session-".repeat(2)}`,
    AISTORY_ANONYMOUS_SUBJECT_PEPPER:
      `fixture-${"anonymous-pepper-".repeat(2)}`,
  });

  assert.equal(PHONE_REGISTRATION_POLICY_ID, "aistory-phone-registration-v1");
  assert.equal(
    parsePhoneRegistrationPolicy(
      PHONE_REGISTRATION_POLICY_VALUES.publicBeta,
    ),
    "public_beta",
  );
  assert.equal(
    parsePhoneRegistrationPolicy(
      PHONE_REGISTRATION_POLICY_VALUES.inviteOnly,
    ),
    "invite_only",
  );
  assert.equal(
    parsePhoneRegistrationPolicy(
      PHONE_REGISTRATION_POLICY_VALUES.disabled,
    ),
    "disabled",
  );
  for (const hostile of [
    undefined,
    "",
    "true",
    "public_beta",
    "aistory-phone-registration-v1:PUBLIC_BETA",
    "aistory-phone-registration-v1:public-beta",
    "aistory-phone-registration-v2:public_beta",
    ` ${PHONE_REGISTRATION_POLICY_VALUES.publicBeta}`,
  ]) {
    assert.throws(() => parsePhoneRegistrationPolicy(hostile));
  }

  const exactConfig = {
    schemaVersion: 1,
    policyId: PHONE_INVITE_BETA_POLICY_ID,
    phoneHashDomain: PHONE_INVITE_BETA_PHONE_HASH_DOMAIN,
    phoneHashes: [memberPhoneHash],
  };
  assert.deepEqual(parsePhoneInviteBetaAllowlist(exactConfig), exactConfig);
  for (const hostile of [
    { ...exactConfig, unknown: true },
    { ...exactConfig, schemaVersion: 2 },
    { ...exactConfig, policyId: "wrong-policy" },
    { ...exactConfig, phoneHashDomain: "wrong-domain" },
    { ...exactConfig, phoneHashes: [] },
    { ...exactConfig, phoneHashes: [memberPhoneHash.toUpperCase()] },
    { ...exactConfig, phoneHashes: [memberPhoneHash, memberPhoneHash] },
    {
      ...exactConfig,
      phoneHashes: [memberPhoneHash, deniedPhoneHash].sort().reverse(),
    },
    Object.assign(Object.create({ inherited: true }), exactConfig),
    Object.assign({ ...exactConfig }, { [Symbol("hidden")]: true }),
  ]) {
    assert.throws(() => parsePhoneInviteBetaAllowlist(hostile));
  }
  const accessor = Object.defineProperties({}, {
    schemaVersion: { enumerable: true, value: 1 },
    policyId: { enumerable: true, value: PHONE_INVITE_BETA_POLICY_ID },
    phoneHashDomain: {
      enumerable: true,
      value: PHONE_INVITE_BETA_PHONE_HASH_DOMAIN,
    },
    phoneHashes: {
      enumerable: true,
      get() {
        throw new Error("must not execute accessor");
      },
    },
  });
  assert.throws(() => parsePhoneInviteBetaAllowlist(accessor));

  for (const secondDigit of [3, 4, 5, 6, 7, 8, 9] as const) {
    const normalized = normalizePhone(syntheticNationalPhone(secondDigit, 8));
    assert.deepEqual(
      await authorizePhoneOtpAdmission(normalized, {
        env: {
          [PHONE_REGISTRATION_POLICY_ENV]:
            PHONE_REGISTRATION_POLICY_VALUES.publicBeta,
        },
        workspaceRoot: runtimeRoot,
      }),
      {
        allowed: true,
        policyId: PHONE_REGISTRATION_POLICY_ID,
        mode: "public_beta",
      },
    );
  }
  for (const invalidPublicPhone of [
    normalizePhone(`+1${"5".repeat(10)}`),
    normalizePhone(`+8612${"0".repeat(9)}`),
  ]) {
    assert.deepEqual(
      await authorizePhoneOtpAdmission(invalidPublicPhone, {
        env: {
          [PHONE_REGISTRATION_POLICY_ENV]:
            PHONE_REGISTRATION_POLICY_VALUES.publicBeta,
        },
      }),
      { allowed: false },
    );
  }
  assert.deepEqual(
    await authorizePhoneOtpAdmission(publicPhone, {
      env: {
        [PHONE_INVITE_BETA_ENABLED_ENV]: "true",
      },
    }),
    { allowed: false },
    "the legacy boolean must not become an admission fallback",
  );

  await writeAllowlist([memberPhoneHash]);
  const memberAuthorization = await authorizePhoneForInviteBeta(memberPhone);
  assert.equal(memberAuthorization.allowed, true);
  assert.deepEqual(
    await authorizePhoneForInviteBeta(memberPhone, {
      env: {
        [PHONE_INVITE_BETA_ENABLED_ENV]: "true",
        AISTORY_PHONE_ID_PEPPER: phonePepper,
      },
      workspaceRoot: runtimeRoot,
    }),
    { allowed: false },
  );
  assert.deepEqual(
    await authorizePhoneForInviteBeta(memberPhone, {
      env: {
        [PHONE_INVITE_BETA_ENABLED_ENV]: "true",
        [PHONE_INVITE_BETA_ALLOWLIST_FILE_ENV]: "relative.json",
        AISTORY_PHONE_ID_PEPPER: phonePepper,
      },
      workspaceRoot: runtimeRoot,
    }),
    { allowed: false },
  );
  const networkReference = process.platform === "win32"
    ? "\\\\server.invalid\\share\\beta-credit-members-v1.json"
    : "//server.invalid/share/beta-credit-members-v1.json";
  assert.deepEqual(
    await authorizePhoneForInviteBeta(memberPhone, {
      env: {
        [PHONE_INVITE_BETA_ENABLED_ENV]: "true",
        [PHONE_INVITE_BETA_ALLOWLIST_FILE_ENV]: networkReference,
        AISTORY_PHONE_ID_PEPPER: phonePepper,
      },
      workspaceRoot: runtimeRoot,
    }),
    { allowed: false },
  );
  assert.deepEqual(
    await authorizePhoneForInviteBeta(memberPhone, {
      env: {
        [PHONE_INVITE_BETA_ENABLED_ENV]: "true",
        [PHONE_INVITE_BETA_ALLOWLIST_FILE_ENV]: allowlistFile,
        AISTORY_PHONE_ID_PEPPER: phonePepper,
      },
      workspaceRoot: root,
    }),
    { allowed: false },
  );
  const exactMembershipCapability =
    await resolvePhoneBetaCreditMembership(memberPhone);
  assert.deepEqual(
    exactMembershipCapability,
    {
      schemaVersion: 1,
      capabilityId: PHONE_BETA_CREDIT_MEMBERSHIP_CAPABILITY_ID,
      eligible: true,
    },
  );
  assert.deepEqual(
    Reflect.ownKeys(exactMembershipCapability),
    ["schemaVersion", "capabilityId", "eligible"],
  );
  assert.equal(Object.isFrozen(exactMembershipCapability), true);
  assert.deepEqual(
    await resolvePhoneBetaCreditMembership(deniedPhone),
    {
      schemaVersion: 1,
      capabilityId: PHONE_BETA_CREDIT_MEMBERSHIP_CAPABILITY_ID,
      eligible: false,
    },
  );
  await writeFile(allowlistFile, "{malformed", {
    encoding: "utf8",
    mode: 0o600,
  });
  assert.deepEqual(
    await resolvePhoneBetaCreditMembership(memberPhone),
    {
      schemaVersion: 1,
      capabilityId: PHONE_BETA_CREDIT_MEMBERSHIP_CAPABILITY_ID,
      eligible: false,
    },
    "membership configuration failure must not fail public admission",
  );
  assert.equal((await authorizePhoneOtpAdmission(publicPhone)).allowed, true);

  await writeAllowlist([memberPhoneHash]);
  assert.ok(memberAuthorization.allowed);
  const legacyInviteToken = createUserSessionToken(
    `phone_${"a".repeat(32)}`,
    Date.now(),
    {
      inviteBetaPolicyFingerprint:
        memberAuthorization.policyFingerprint,
    },
  );
  process.env[PHONE_REGISTRATION_POLICY_ENV] =
    PHONE_REGISTRATION_POLICY_VALUES.publicBeta;
  process.env[PHONE_INVITE_BETA_ENABLED_ENV] = "false";
  delete process.env[PHONE_INVITE_BETA_ALLOWLIST_FILE_ENV];
  const legacyInviteSession = verifyUserSessionToken(legacyInviteToken);
  assert.equal(
    await phoneRegistrationSessionBindingIsCurrent(
      legacyInviteSession?.inviteBetaPolicyFingerprint,
      legacyInviteSession?.phoneRegistrationPolicy,
    ),
    true,
    "a valid old invite session must remain accepted in public beta",
  );
  assert.ok(legacyInviteSession);
  const unboundLegacyToken = createUserSessionToken(
    `phone_${"b".repeat(32)}`,
  );
  assert.equal(
    await phoneRegistrationSessionBindingIsCurrent(undefined, undefined),
    false,
    "pre-invite unbound sessions must not be grandfathered",
  );
  assert.ok(verifyUserSessionToken(unboundLegacyToken));
  const publicToken = createUserSessionToken(
    `phone_${"c".repeat(32)}`,
    Date.now(),
    {
      phoneRegistrationPolicy:
        PHONE_REGISTRATION_POLICY_VALUES.publicBeta,
    },
  );
  const markedPublicSession = verifyUserSessionToken(publicToken);
  assert.equal(markedPublicSession?.inviteBetaPolicyFingerprint, undefined);
  assert.equal(
    await phoneRegistrationSessionBindingIsCurrent(
      undefined,
      markedPublicSession?.phoneRegistrationPolicy,
    ),
    true,
  );
  process.env[PHONE_REGISTRATION_POLICY_ENV] =
    PHONE_REGISTRATION_POLICY_VALUES.inviteOnly;
  process.env[PHONE_INVITE_BETA_ENABLED_ENV] = "true";
  process.env[PHONE_INVITE_BETA_ALLOWLIST_FILE_ENV] = allowlistFile;
  assert.equal(
    await phoneRegistrationSessionBindingIsCurrent(
      undefined,
      markedPublicSession?.phoneRegistrationPolicy,
    ),
    false,
  );
  assert.equal(
    await phoneRegistrationSessionBindingIsCurrent(
      legacyInviteSession?.inviteBetaPolicyFingerprint,
      legacyInviteSession?.phoneRegistrationPolicy,
    ),
    true,
  );
  for (const closedPolicy of [
    PHONE_REGISTRATION_POLICY_VALUES.disabled,
    "aistory-phone-registration-v2:public_beta",
  ]) {
    process.env[PHONE_REGISTRATION_POLICY_ENV] = closedPolicy;
    assert.equal(
      await phoneRegistrationSessionBindingIsCurrent(
        legacyInviteSession?.inviteBetaPolicyFingerprint,
        legacyInviteSession?.phoneRegistrationPolicy,
      ),
      false,
    );
  }
  assert.equal(verifyUserSessionToken(`${legacyInviteToken}tampered`), undefined);

  process.env[PHONE_REGISTRATION_POLICY_ENV] =
    PHONE_REGISTRATION_POLICY_VALUES.disabled;
  const disabledRequest = await requestPhoneOtpRoute(loopbackRequest(
    "/api/auth/phone/request",
    { phone: formattedPublicPhone },
  ));
  assert.equal(disabledRequest.status, 202);
  const disabledReceipt = await disabledRequest.json() as RequestReceipt;
  assert.equal((await readChallenges()).challenges?.length ?? 0, 0);
  await assert.rejects(stat(adminStore), { code: "ENOENT" });

  process.env[PHONE_REGISTRATION_POLICY_ENV] = "unknown-policy";
  const unknownRequest = await requestPhoneOtpRoute(loopbackRequest(
    "/api/auth/phone/request",
    { phone: formattedPublicPhone },
  ));
  assert.equal(unknownRequest.status, 202);
  assert.deepEqual(
    redactChallenge(await unknownRequest.json() as RequestReceipt),
    redactChallenge(disabledReceipt),
  );
  assert.equal((await readChallenges()).challenges?.length ?? 0, 0);

  process.env[PHONE_REGISTRATION_POLICY_ENV] =
    PHONE_REGISTRATION_POLICY_VALUES.inviteOnly;
  process.env[PHONE_INVITE_BETA_ENABLED_ENV] = "true";
  process.env[PHONE_INVITE_BETA_ALLOWLIST_FILE_ENV] = allowlistFile;
  await writeFile(allowlistFile, "{malformed", {
    encoding: "utf8",
    mode: 0o600,
  });
  const malformedInviteRequest = await requestPhoneOtpRoute(loopbackRequest(
    "/api/auth/phone/request",
    { phone: formattedPublicPhone },
  ));
  assert.deepEqual(
    redactChallenge(
      await malformedInviteRequest.json() as RequestReceipt,
    ),
    redactChallenge(disabledReceipt),
  );
  assert.equal((await readChallenges()).challenges?.length ?? 0, 0);

  await writeAllowlist([memberPhoneHash]);
  const nonmemberRequest = await requestPhoneOtpRoute(loopbackRequest(
    "/api/auth/phone/request",
    { phone: formattedPublicPhone },
  ));
  assert.equal(nonmemberRequest.status, 202);
  assert.deepEqual(
    redactChallenge(await nonmemberRequest.json() as RequestReceipt),
    redactChallenge(disabledReceipt),
  );
  assert.equal((await readChallenges()).challenges?.length ?? 0, 0);

  process.env[PHONE_REGISTRATION_POLICY_ENV] =
    PHONE_REGISTRATION_POLICY_VALUES.publicBeta;
  process.env[PHONE_INVITE_BETA_ENABLED_ENV] = "true";
  process.env[PHONE_INVITE_BETA_ALLOWLIST_FILE_ENV] = allowlistFile;
  await writeFile(allowlistFile, "{malformed", {
    encoding: "utf8",
    mode: 0o600,
  });
  const configuredSessionSecret = process.env.AISTORY_USER_SESSION_SECRET;
  delete process.env.AISTORY_USER_SESSION_SECRET;
  const missingSignerRequest = await requestPhoneOtpRoute(loopbackRequest(
    "/api/auth/phone/request",
    { phone: formattedPublicPhone },
  ));
  assert.deepEqual(
    redactChallenge(await missingSignerRequest.json() as RequestReceipt),
    redactChallenge(disabledReceipt),
  );
  assert.equal((await readChallenges()).challenges?.length ?? 0, 0);
  process.env.AISTORY_USER_SESSION_SECRET = configuredSessionSecret;
  process.env.AISTORY_SMS_PROVIDER = "disabled";
  const providerUnavailableRequest = await requestPhoneOtpRoute(
    loopbackRequest("/api/auth/phone/request", {
      phone: formattedPublicPhone,
    }),
  );
  assert.deepEqual(
    redactChallenge(
      await providerUnavailableRequest.json() as RequestReceipt,
    ),
    redactChallenge(disabledReceipt),
  );
  assert.equal((await readChallenges()).challenges?.length ?? 0, 0);

  process.env.AISTORY_SMS_PROVIDER = "local_mock";
  const publicRequest = await requestPhoneOtpRoute(loopbackRequest(
    "/api/auth/phone/request",
    { phone: formattedPublicPhone },
  ));
  assert.equal(publicRequest.status, 202);
  const publicReceipt = await publicRequest.json() as RequestReceipt;
  assert.match(publicReceipt.challengeId || "", /^[0-9a-f-]{36}$/);
  assert.deepEqual(
    redactChallenge(publicReceipt),
    redactChallenge(disabledReceipt),
  );
  assert.equal((await readChallenges()).challenges?.length, 1);
  await assert.rejects(stat(adminStore), { code: "ENOENT" });

  const challengeBeforePolicyDrift = JSON.stringify(await readChallenges());
  process.env[PHONE_REGISTRATION_POLICY_ENV] =
    PHONE_REGISTRATION_POLICY_VALUES.disabled;
  const disabledVerify = await verifyPhoneOtpRoute(loopbackRequest(
    "/api/auth/phone/verify",
    {
      phone: formattedPublicPhone,
      challengeId: publicReceipt.challengeId,
      code: localOtp,
    },
  ));
  assert.equal(disabledVerify.status, 400);
  assert.equal(disabledVerify.headers.get("set-cookie"), null);
  assert.deepEqual(await disabledVerify.json(), {
    error: "验证码无效或已过期。",
    code: "OTP_INVALID_OR_EXPIRED",
  });
  assert.equal(
    JSON.stringify(await readChallenges()),
    challengeBeforePolicyDrift,
  );
  await assert.rejects(stat(adminStore), { code: "ENOENT" });

  process.env[PHONE_REGISTRATION_POLICY_ENV] = "unknown-policy";
  const driftedVerify = await verifyPhoneOtpRoute(loopbackRequest(
    "/api/auth/phone/verify",
    {
      phone: formattedPublicPhone,
      challengeId: publicReceipt.challengeId,
      code: localOtp,
    },
  ));
  assert.equal(driftedVerify.status, 400);
  assert.deepEqual(await driftedVerify.json(), {
    error: "验证码无效或已过期。",
    code: "OTP_INVALID_OR_EXPIRED",
  });
  assert.equal(
    JSON.stringify(await readChallenges()),
    challengeBeforePolicyDrift,
  );
  await assert.rejects(stat(adminStore), { code: "ENOENT" });

  process.env[PHONE_REGISTRATION_POLICY_ENV] =
    PHONE_REGISTRATION_POLICY_VALUES.publicBeta;
  const publicVerify = await verifyPhoneOtpRoute(loopbackRequest(
    "/api/auth/phone/verify",
    {
      phone: publicNationalPhone,
      challengeId: publicReceipt.challengeId,
      code: localOtp,
    },
  ));
  assert.equal(publicVerify.status, 200);
  const publicAccount = await publicVerify.json() as {
    ok?: boolean;
    account?: Record<string, unknown>;
  };
  assert.equal(publicAccount.ok, true);
  assert.equal("betaCreditMembership" in (publicAccount.account ?? {}), false);
  assert.equal("eligible" in (publicAccount.account ?? {}), false);
  assertNoSensitiveBetaData(publicAccount);
  const publicSessionToken = sessionTokenFrom(publicVerify);
  const publicSession = verifyUserSessionToken(publicSessionToken);
  assert.ok(publicSession);
  assert.equal(publicSession?.inviteBetaPolicyFingerprint, undefined);
  assert.equal(
    publicSession?.phoneRegistrationPolicy,
    PHONE_REGISTRATION_POLICY_VALUES.publicBeta,
  );
  const decodedPublicSession = Buffer.from(
    publicSessionToken.split(".")[0]!,
    "base64url",
  ).toString("utf8");
  assertNoSensitiveBetaData(decodedPublicSession);
  for (const publicProjection of [
    JSON.stringify(publicAccount),
    decodedPublicSession,
  ]) {
    assert.equal(publicProjection.includes("betaCreditMembership"), false);
    assert.equal(publicProjection.includes("\"eligible\""), false);
    assert.equal(
      publicProjection.includes(PHONE_BETA_CREDIT_MEMBERSHIP_CAPABILITY_ID),
      false,
    );
  }

  const localAccountStore = JSON.parse(
    await readFile(adminStore, "utf8"),
  ) as {
    creditLedger?: Array<{
      kind?: string;
      amount?: number;
      idempotencyKey?: string;
    }>;
  };
  assert.equal(localAccountStore.creditLedger?.length, 1);
  assert.equal(localAccountStore.creditLedger?.[0]?.kind, "initial_grant");
  assert.equal(localAccountStore.creditLedger?.[0]?.amount, 1000);
  assert.equal(
    JSON.stringify(localAccountStore.creditLedger).includes("beta"),
    false,
  );

  await writeAllowlist([memberPhoneHash]);
  process.env[PHONE_REGISTRATION_POLICY_ENV] =
    PHONE_REGISTRATION_POLICY_VALUES.inviteOnly;
  process.env[PHONE_INVITE_BETA_ENABLED_ENV] = "true";
  process.env[PHONE_INVITE_BETA_ALLOWLIST_FILE_ENV] = allowlistFile;
  const inviteRequest = await requestPhoneOtpRoute(loopbackRequest(
    "/api/auth/phone/request",
    { phone: memberNationalPhone },
  ));
  const inviteReceipt = await inviteRequest.json() as RequestReceipt;
  assert.match(inviteReceipt.challengeId || "", /^[0-9a-f-]{36}$/);
  assert.equal((await readChallenges()).challenges?.length, 2);
  await writeAllowlist([deniedPhoneHash]);
  const inviteChallengeBeforeRemoval = JSON.stringify(await readChallenges());
  const removedMemberVerify = await verifyPhoneOtpRoute(loopbackRequest(
    "/api/auth/phone/verify",
    {
      phone: memberNationalPhone,
      challengeId: inviteReceipt.challengeId,
      code: localOtp,
    },
  ));
  assert.equal(removedMemberVerify.status, 400);
  assert.equal(
    JSON.stringify(await readChallenges()),
    inviteChallengeBeforeRemoval,
  );
  await writeAllowlist([memberPhoneHash]);
  const inviteVerify = await verifyPhoneOtpRoute(loopbackRequest(
    "/api/auth/phone/verify",
    {
      phone: memberNationalPhone,
      challengeId: inviteReceipt.challengeId,
      code: localOtp,
    },
  ));
  assert.equal(inviteVerify.status, 200);
  const inviteSessionToken = sessionTokenFrom(inviteVerify);
  const inviteSession = verifyUserSessionToken(inviteSessionToken);
  assert.ok(inviteSession?.inviteBetaPolicyFingerprint);
  assert.equal(
    await inviteBetaSessionBindingIsCurrent(
      inviteSession?.inviteBetaPolicyFingerprint,
    ),
    true,
  );
  assert.equal(
    await phoneRegistrationSessionBindingIsCurrent(
      inviteSession?.inviteBetaPolicyFingerprint,
      inviteSession?.phoneRegistrationPolicy,
    ),
    true,
  );
  await writeAllowlist([deniedPhoneHash]);
  assert.equal(
    await phoneRegistrationSessionBindingIsCurrent(
      inviteSession?.inviteBetaPolicyFingerprint,
      inviteSession?.phoneRegistrationPolicy,
    ),
    false,
  );
  await writeAllowlist([memberPhoneHash]);
  delete process.env.AISTORY_PHONE_ID_PEPPER;
  assert.equal(
    await phoneRegistrationSessionBindingIsCurrent(
      inviteSession?.inviteBetaPolicyFingerprint,
      inviteSession?.phoneRegistrationPolicy,
    ),
    false,
  );
  process.env.AISTORY_PHONE_ID_PEPPER = "short";
  assert.equal(
    await phoneRegistrationSessionBindingIsCurrent(
      inviteSession?.inviteBetaPolicyFingerprint,
      inviteSession?.phoneRegistrationPolicy,
    ),
    false,
  );
  process.env.AISTORY_PHONE_ID_PEPPER =
    `fixture-${"rotated-phone-pepper-".repeat(2)}`;
  assert.equal(
    await phoneRegistrationSessionBindingIsCurrent(
      inviteSession?.inviteBetaPolicyFingerprint,
      inviteSession?.phoneRegistrationPolicy,
    ),
    false,
  );
  process.env[PHONE_REGISTRATION_POLICY_ENV] =
    PHONE_REGISTRATION_POLICY_VALUES.publicBeta;
  delete process.env[PHONE_INVITE_BETA_ALLOWLIST_FILE_ENV];
  assert.equal(
    await phoneRegistrationSessionBindingIsCurrent(
      inviteSession?.inviteBetaPolicyFingerprint,
      inviteSession?.phoneRegistrationPolicy,
    ),
    true,
    "public beta must preserve a signed old invite session after drift",
  );
  process.env.AISTORY_PHONE_ID_PEPPER = phonePepper;
  process.env[PHONE_REGISTRATION_POLICY_ENV] =
    PHONE_REGISTRATION_POLICY_VALUES.inviteOnly;
  process.env[PHONE_INVITE_BETA_ALLOWLIST_FILE_ENV] = allowlistFile;
  assert.equal(
    await phoneRegistrationSessionBindingIsCurrent(
      inviteSession?.inviteBetaPolicyFingerprint,
      inviteSession?.phoneRegistrationPolicy,
    ),
    true,
  );
  const afterInviteStore = JSON.parse(
    await readFile(adminStore, "utf8"),
  ) as { creditLedger?: Array<{ kind?: string; amount?: number }> };
  assert.equal(afterInviteStore.creditLedger?.length, 2);
  assert.equal(
    afterInviteStore.creditLedger?.every(
      (entry) => entry.kind === "initial_grant" && entry.amount === 1000,
    ),
    true,
  );

  await writeAllowlist([memberPhoneHash, capabilityPhoneHash]);
  const capabilityRequest = await requestPhoneOtpRoute(loopbackRequest(
    "/api/auth/phone/request",
    { phone: capabilityNationalPhone },
  ));
  const capabilityReceipt = await capabilityRequest.json() as RequestReceipt;
  assert.match(capabilityReceipt.challengeId || "", /^[0-9a-f-]{36}$/);
  assert.equal((await readChallenges()).challenges?.length, 3);
  const verifiedCapability = await verifyPhoneOtp(getAdminRepository(), {
    phone: capabilityNationalPhone,
    challengeId: capabilityReceipt.challengeId!,
    code: localOtp,
  });
  assert.deepEqual(verifiedCapability.betaCreditMembership, {
    schemaVersion: 1,
    capabilityId: PHONE_BETA_CREDIT_MEMBERSHIP_CAPABILITY_ID,
    eligible: true,
  });
  const afterCapabilityStore = JSON.parse(
    await readFile(adminStore, "utf8"),
  ) as { creditLedger?: Array<{ kind?: string; amount?: number }> };
  assert.equal(afterCapabilityStore.creditLedger?.length, 3);
  assert.equal(
    afterCapabilityStore.creditLedger?.every(
      (entry) => entry.kind === "initial_grant" && entry.amount === 1000,
    ),
    true,
  );

  const requestSource = await readFile(
    path.join(originalCwd, "app/api/auth/phone/request/route.ts"),
    "utf8",
  );
  const verifySource = await readFile(
    path.join(originalCwd, "app/api/auth/phone/verify/route.ts"),
    "utf8",
  );
  const serviceSource = await readFile(
    path.join(originalCwd, "lib/auth/phoneAuthService.ts"),
    "utf8",
  );
  const gateSource = await readFile(
    path.join(originalCwd, "lib/auth/phoneInviteBetaGate.ts"),
    "utf8",
  );
  const userSessionSource = await readFile(
    path.join(originalCwd, "lib/auth/userSession.ts"),
    "utf8",
  );
  const guardSource = await readFile(
    path.join(originalCwd, "lib/supabase/guard.ts"),
    "utf8",
  );
  const cloudProgressSources = await Promise.all(
    ["manifest", "push", "pull", "delete"].map((route) =>
      readFile(
        path.join(
          originalCwd,
          `app/api/stories/${route}/route.ts`,
        ),
        "utf8",
      )),
  );
  const requestAdmission = requestSource.indexOf(
    "const admission = await authorizePhoneOtpAdmission",
  );
  const requestRecheck = requestSource.indexOf(
    "if (!await phoneOtpAdmissionIsCurrent",
  );
  assert.ok(requestAdmission > 0);
  assert.ok(requestRecheck > requestAdmission);
  assert.ok(requestRecheck < requestSource.indexOf("requestPhoneOtp({"));
  const verifyAdmission = verifySource.indexOf(
    "const admission = await authorizePhoneOtpAdmission",
  );
  const verifyRecheck = verifySource.indexOf(
    "if (!await phoneOtpAdmissionIsCurrent",
  );
  assert.ok(verifyAdmission > 0);
  assert.ok(
    verifyRecheck > verifySource.indexOf("prepareServerAnonymousClaim"),
  );
  assert.ok(
    verifyRecheck < verifySource.indexOf("verifyPhoneOtp(getAdminRepository"),
  );
  assert.equal(verifySource.includes("betaCreditMembership"), false);
  const productionVerify = serviceSource.indexOf(
    "const verified = await identityRepository.verifyAndRegister",
  );
  const productionMembership = serviceSource.indexOf(
    "betaCreditMembership: await resolvePhoneBetaCreditMembership",
    productionVerify,
  );
  assert.ok(productionVerify > 0);
  assert.ok(productionMembership > productionVerify);
  const localConsumption = serviceSource.indexOf(
    "const status = await verifyAndConsumePhoneChallenge",
  );
  const localMembership = serviceSource.lastIndexOf(
    "betaCreditMembership: await resolvePhoneBetaCreditMembership",
  );
  assert.ok(localMembership > localConsumption);
  assert.match(userSessionSource, /readPhoneRegistrationSession/);
  assert.match(
    userSessionSource,
    /phoneRegistrationSessionBindingIsCurrent/,
  );
  assert.match(guardSource, /readPhoneRegistrationSession/);
  assert.doesNotMatch(guardSource, /readInviteBetaPhoneUserSession/);
  assert.match(guardSource, /auth\.authType !== "phone"/);
  assert.match(guardSource, /CLOUD_PROGRESS_PRINCIPAL_UNAVAILABLE/);
  assert.match(guardSource, /status: 503/);
  for (const cloudProgressSource of cloudProgressSources) {
    const principalGate = cloudProgressSource.indexOf(
      "rejectUnboundCloudProgressPrincipal(auth)",
    );
    assert.ok(principalGate > cloudProgressSource.indexOf("requireUser("));
    assert.ok(cloudProgressSource.search(/await cloud[A-Z]/) > principalGate);
  }
  assert.ok(
    cloudProgressSources[1]!.indexOf("await req.text()")
      > cloudProgressSources[1]!.indexOf(
        "rejectUnboundCloudProgressPrincipal(auth)",
      ),
  );
  for (const bodyReadingSource of cloudProgressSources.slice(2)) {
    assert.ok(
      bodyReadingSource.indexOf("await req.json()")
        > bodyReadingSource.indexOf(
          "rejectUnboundCloudProgressPrincipal(auth)",
        ),
    );
  }
  assert.doesNotMatch(
    gateSource,
    /node:(?:http|https|net|tls)|undici|fetch\(|@\/lib\/(?:admin|billing)|supabase/,
  );
  for (const source of [requestSource, verifySource, serviceSource]) {
    assert.equal(source.includes("NEXT_PUBLIC_"), false);
    assert.equal(source.includes("console.log"), false);
    assert.equal(source.includes("adjustCredits"), false);
    assert.equal(source.includes("100000"), false);
    assert.equal(source.includes("100_000"), false);
  }
  assert.equal(
    await phoneOtpAdmissionIsCurrent(publicPhone, { allowed: false }),
    false,
  );
  assertNoSensitiveBetaData(disabledReceipt);
  assertNoSensitiveBetaData(publicReceipt);
  assertNoSensitiveBetaData(await inviteVerify.clone().json());
  assert.equal(fetchCalls, 0);
  console.log("phone registration policy and beta membership tests passed");
} finally {
  process.chdir(originalCwd);
  for (const name of environmentNames) {
    const value = originalEnvironment[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: originalFetch,
  });
  await rm(root, { recursive: true, force: true });
}
