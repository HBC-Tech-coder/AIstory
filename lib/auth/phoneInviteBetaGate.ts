import "server-only";

import {
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

export const PHONE_INVITE_BETA_POLICY_ID = "aistory-phone-invite-beta-v1";
export const PHONE_INVITE_BETA_PHONE_HASH_DOMAIN =
  "aistory:phone-invite-beta:member:v1";
export const PHONE_INVITE_BETA_ENABLED_ENV =
  "AISTORY_INVITE_BETA_ENABLED";
export const PHONE_INVITE_BETA_ALLOWLIST_FILE_ENV =
  "AISTORY_INVITE_BETA_ALLOWLIST_FILE";
export const PHONE_REGISTRATION_POLICY_ENV =
  "AISTORY_PHONE_REGISTRATION_POLICY";
export const PHONE_REGISTRATION_POLICY_ID =
  "aistory-phone-registration-v1";
export const PHONE_REGISTRATION_POLICY_VALUES = Object.freeze({
  publicBeta: `${PHONE_REGISTRATION_POLICY_ID}:public_beta`,
  inviteOnly: `${PHONE_REGISTRATION_POLICY_ID}:invite_only`,
  disabled: `${PHONE_REGISTRATION_POLICY_ID}:disabled`,
} as const);
export const PHONE_BETA_CREDIT_MEMBERSHIP_CAPABILITY_ID =
  "aistory-beta-credit-membership-v1";

const PHONE_ID_PEPPER_ENV = "AISTORY_PHONE_ID_PEPPER";
const MAX_ALLOWLIST_FILE_BYTES = 32 * 1024;
const MAX_ALLOWLIST_ENTRIES = 128;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const MAINLAND_PHONE_PATTERN = /^\+861[3-9]\d{9}$/;
const POLICY_FINGERPRINT_DOMAIN = "aistory:phone-invite-beta:policy:v1";

type InviteBetaEnvironment = Record<string, string | undefined>;

export type PhoneInviteBetaAllowlist = {
  schemaVersion: 1;
  policyId: typeof PHONE_INVITE_BETA_POLICY_ID;
  phoneHashDomain: typeof PHONE_INVITE_BETA_PHONE_HASH_DOMAIN;
  phoneHashes: readonly string[];
};

export type PhoneInviteBetaAuthorization =
  | {
      allowed: true;
      policyFingerprint: string;
    }
  | {
      allowed: false;
    };

export type PhoneRegistrationMode =
  | "public_beta"
  | "invite_only"
  | "disabled";

export type PhoneOtpAdmissionAuthorization =
  | {
      allowed: true;
      policyId: typeof PHONE_REGISTRATION_POLICY_ID;
      mode: "public_beta";
    }
  | {
      allowed: true;
      policyId: typeof PHONE_REGISTRATION_POLICY_ID;
      mode: "invite_only";
      membershipPolicyFingerprint: string;
    }
  | {
      allowed: false;
    };

export type PhoneBetaCreditMembershipCapability = Readonly<{
  schemaVersion: 1;
  capabilityId: typeof PHONE_BETA_CREDIT_MEMBERSHIP_CAPABILITY_ID;
  eligible: boolean;
}>;

type PhoneInviteBetaRuntime = {
  env?: InviteBetaEnvironment;
  workspaceRoot?: string;
};

function failConfiguration(): never {
  throw new Error("Invite beta configuration is unavailable.");
}

export function parsePhoneRegistrationPolicy(
  value: unknown,
): PhoneRegistrationMode {
  if (value === PHONE_REGISTRATION_POLICY_VALUES.publicBeta) {
    return "public_beta";
  }
  if (value === PHONE_REGISTRATION_POLICY_VALUES.inviteOnly) {
    return "invite_only";
  }
  if (value === PHONE_REGISTRATION_POLICY_VALUES.disabled) {
    return "disabled";
  }
  failConfiguration();
}

function ownDataValue(
  value: object,
  key: PropertyKey,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) failConfiguration();
  return descriptor.value;
}

function isExactPlainRecord(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === expectedKeys.length
    && keys.every(
      (key) =>
        typeof key === "string"
        && expectedKeys.includes(key)
        && Object.getOwnPropertyDescriptor(value, key)?.get === undefined
        && Object.getOwnPropertyDescriptor(value, key)?.set === undefined,
    );
}

function parsePhoneHashArray(value: unknown): readonly string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    failConfiguration();
  }
  if (
    value.length < 1
    || value.length > MAX_ALLOWLIST_ENTRIES
    || Reflect.ownKeys(value).length !== value.length + 1
  ) failConfiguration();
  const phoneHashes = Array.from({ length: value.length }, (_, index) => {
    const item = ownDataValue(value, String(index));
    if (typeof item !== "string" || !HASH_PATTERN.test(item)) {
      failConfiguration();
    }
    return item;
  });
  if (
    new Set(phoneHashes).size !== phoneHashes.length
    || phoneHashes.some(
      (item, index) => index > 0 && phoneHashes[index - 1]! >= item,
    )
  ) failConfiguration();
  return Object.freeze(phoneHashes);
}

export function parsePhoneInviteBetaAllowlist(
  value: unknown,
): PhoneInviteBetaAllowlist {
  const keys = [
    "schemaVersion",
    "policyId",
    "phoneHashDomain",
    "phoneHashes",
  ] as const;
  if (!isExactPlainRecord(value, keys)) failConfiguration();
  const schemaVersion = ownDataValue(value, "schemaVersion");
  const policyId = ownDataValue(value, "policyId");
  const phoneHashDomain = ownDataValue(value, "phoneHashDomain");
  const phoneHashes = parsePhoneHashArray(
    ownDataValue(value, "phoneHashes"),
  );
  if (
    schemaVersion !== 1
    || policyId !== PHONE_INVITE_BETA_POLICY_ID
    || phoneHashDomain !== PHONE_INVITE_BETA_PHONE_HASH_DOMAIN
  ) {
    failConfiguration();
  }
  return Object.freeze({
    schemaVersion: 1,
    policyId: PHONE_INVITE_BETA_POLICY_ID,
    phoneHashDomain: PHONE_INVITE_BETA_PHONE_HASH_DOMAIN,
    phoneHashes,
  });
}

function normalizePathForComparison(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isInsideDirectory(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === ""
    || (
      !path.isAbsolute(relative)
      && !relative.startsWith(`..${path.sep}`)
      && relative !== ".."
    );
}

async function readProtectedAllowlistFile(
  fileReference: string,
  workspaceRoot: string,
): Promise<string> {
  if (process.platform === "win32") {
    const windowsPath = fileReference.replaceAll("/", "\\");
    if (
      !/^[A-Za-z]:\\/.test(windowsPath)
      || windowsPath.slice(2).includes(":")
    ) failConfiguration();
  } else if (fileReference.startsWith("//")) {
    failConfiguration();
  }
  if (!path.isAbsolute(fileReference)) failConfiguration();
  const resolved = path.resolve(fileReference);
  if (isInsideDirectory(path.resolve(workspaceRoot), resolved)) {
    failConfiguration();
  }
  const linkMetadata = await lstat(resolved);
  if (!linkMetadata.isFile() || linkMetadata.isSymbolicLink()) {
    failConfiguration();
  }
  if (process.platform !== "win32" && (linkMetadata.mode & 0o077) !== 0) {
    failConfiguration();
  }
  const canonical = await realpath(resolved);
  if (
    normalizePathForComparison(canonical)
    !== normalizePathForComparison(resolved)
  ) failConfiguration();
  const noFollow = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
  const handle = await open(resolved, fsConstants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat();
    if (
      !before.isFile()
      || before.dev !== linkMetadata.dev
      || before.ino !== linkMetadata.ino
      || before.size !== linkMetadata.size
      || before.mtimeMs !== linkMetadata.mtimeMs
      || before.size < 2
      || before.size > MAX_ALLOWLIST_FILE_BYTES
      || (
        process.platform !== "win32"
        && (before.mode & 0o077) !== 0
      )
    ) failConfiguration();
    const raw = await handle.readFile({ encoding: "utf8" });
    const after = await handle.stat();
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || Buffer.byteLength(raw, "utf8") !== after.size
      || raw.charCodeAt(0) === 0xfeff
    ) failConfiguration();
    return raw;
  } finally {
    await handle.close();
  }
}

function requiredPepper(env: InviteBetaEnvironment): string {
  const value = env[PHONE_ID_PEPPER_ENV]?.trim();
  if (!value || value.length < 32) failConfiguration();
  return value;
}

function policyFingerprint(
  config: PhoneInviteBetaAllowlist,
  pepper: string,
): string {
  return createHmac("sha256", pepper)
    .update(POLICY_FINGERPRINT_DOMAIN)
    .update("\n")
    .update(config.policyId)
    .update("\n")
    .update(config.phoneHashDomain)
    .update("\n")
    .update(config.phoneHashes.join("\n"))
    .digest("hex");
}

function safeHashMatch(candidate: string, phoneHashes: readonly string[]): boolean {
  const candidateBytes = Buffer.from(candidate, "hex");
  let matched = false;
  for (const allowed of phoneHashes) {
    const allowedBytes = Buffer.from(allowed, "hex");
    matched = timingSafeEqual(candidateBytes, allowedBytes) || matched;
  }
  return matched;
}

async function loadPhoneInviteBetaAllowlist(
  runtime: PhoneInviteBetaRuntime = {},
): Promise<PhoneInviteBetaAllowlist> {
  const env = runtime.env ?? process.env;
  if (env[PHONE_INVITE_BETA_ENABLED_ENV] !== "true") failConfiguration();
  const fileReference = env[PHONE_INVITE_BETA_ALLOWLIST_FILE_ENV]?.trim();
  if (!fileReference) failConfiguration();
  const raw = await readProtectedAllowlistFile(
    fileReference,
    runtime.workspaceRoot ?? process.cwd(),
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    failConfiguration();
  }
  return parsePhoneInviteBetaAllowlist(parsed);
}

export async function authorizePhoneForInviteBeta(
  normalizedPhone: string,
  runtime: PhoneInviteBetaRuntime = {},
): Promise<PhoneInviteBetaAuthorization> {
  try {
    if (!/^\+[1-9]\d{7,14}$/.test(normalizedPhone)) {
      return { allowed: false };
    }
    const env = runtime.env ?? process.env;
    const config = await loadPhoneInviteBetaAllowlist(runtime);
    const pepper = requiredPepper(env);
    const phoneHash = createHmac("sha256", pepper)
      .update(PHONE_INVITE_BETA_PHONE_HASH_DOMAIN)
      .update("\n")
      .update(normalizedPhone)
      .digest("hex");
    if (!safeHashMatch(phoneHash, config.phoneHashes)) {
      return { allowed: false };
    }
    return {
      allowed: true,
      policyFingerprint: policyFingerprint(config, pepper),
    };
  } catch {
    return { allowed: false };
  }
}

export async function resolvePhoneBetaCreditMembership(
  normalizedPhone: string,
  runtime: PhoneInviteBetaRuntime = {},
): Promise<PhoneBetaCreditMembershipCapability> {
  const membership = MAINLAND_PHONE_PATTERN.test(normalizedPhone)
    ? await authorizePhoneForInviteBeta(normalizedPhone, runtime)
    : { allowed: false as const };
  return Object.freeze({
    schemaVersion: 1,
    capabilityId: PHONE_BETA_CREDIT_MEMBERSHIP_CAPABILITY_ID,
    eligible: membership.allowed,
  });
}

export async function authorizePhoneOtpAdmission(
  normalizedPhone: string,
  runtime: PhoneInviteBetaRuntime = {},
): Promise<PhoneOtpAdmissionAuthorization> {
  if (!MAINLAND_PHONE_PATTERN.test(normalizedPhone)) {
    return { allowed: false };
  }
  try {
    const env = runtime.env ?? process.env;
    const mode = parsePhoneRegistrationPolicy(
      env[PHONE_REGISTRATION_POLICY_ENV],
    );
    if (mode === "disabled") return { allowed: false };
    if (mode === "public_beta") {
      return {
        allowed: true,
        policyId: PHONE_REGISTRATION_POLICY_ID,
        mode,
      };
    }
    const membership = await authorizePhoneForInviteBeta(
      normalizedPhone,
      runtime,
    );
    if (!membership.allowed) return { allowed: false };
    return {
      allowed: true,
      policyId: PHONE_REGISTRATION_POLICY_ID,
      mode,
      membershipPolicyFingerprint: membership.policyFingerprint,
    };
  } catch {
    return { allowed: false };
  }
}

export async function phoneOtpAdmissionIsCurrent(
  normalizedPhone: string,
  authorization: PhoneOtpAdmissionAuthorization,
  runtime: PhoneInviteBetaRuntime = {},
): Promise<boolean> {
  if (!authorization.allowed) return false;
  const current = await authorizePhoneOtpAdmission(normalizedPhone, runtime);
  if (
    !current.allowed
    || current.policyId !== authorization.policyId
    || current.mode !== authorization.mode
  ) return false;
  if (current.mode === "public_beta") return true;
  if (authorization.mode !== "invite_only") return false;
  const expected = Buffer.from(
    current.membershipPolicyFingerprint,
    "hex",
  );
  const supplied = Buffer.from(
    authorization.membershipPolicyFingerprint,
    "hex",
  );
  return expected.length === supplied.length
    && timingSafeEqual(expected, supplied);
}

export async function inviteBetaSessionBindingIsCurrent(
  policyBinding: string | undefined,
  runtime: PhoneInviteBetaRuntime = {},
): Promise<boolean> {
  if (!policyBinding || !HASH_PATTERN.test(policyBinding)) return false;
  try {
    const env = runtime.env ?? process.env;
    const config = await loadPhoneInviteBetaAllowlist(runtime);
    const expected = Buffer.from(
      policyFingerprint(config, requiredPepper(env)),
      "hex",
    );
    const supplied = Buffer.from(policyBinding, "hex");
    return expected.length === supplied.length
      && timingSafeEqual(expected, supplied);
  } catch {
    return false;
  }
}

export async function phoneRegistrationSessionBindingIsCurrent(
  policyBinding: string | undefined,
  sessionRegistrationPolicy: string | undefined,
  runtime: PhoneInviteBetaRuntime = {},
): Promise<boolean> {
  try {
    const env = runtime.env ?? process.env;
    const mode = parsePhoneRegistrationPolicy(
      env[PHONE_REGISTRATION_POLICY_ENV],
    );
    if (mode === "public_beta") {
      return sessionRegistrationPolicy
        === PHONE_REGISTRATION_POLICY_VALUES.publicBeta
        || (
          typeof policyBinding === "string"
          && HASH_PATTERN.test(policyBinding)
        );
    }
    if (mode === "disabled") return false;
    return inviteBetaSessionBindingIsCurrent(policyBinding, runtime);
  } catch {
    return false;
  }
}
