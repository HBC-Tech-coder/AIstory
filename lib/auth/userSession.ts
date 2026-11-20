import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies, headers } from "next/headers";

import { isLoopbackHost } from "@/lib/security/host";
import { getProductionPhoneIdentityRepository } from "./phoneIdentityRepository";
import { inspectProductionDatabaseGate } from "@/lib/production/databaseGate";
import {
  inviteBetaSessionBindingIsCurrent,
  PHONE_REGISTRATION_POLICY_VALUES,
  phoneRegistrationSessionBindingIsCurrent,
} from "./phoneInviteBetaGate";

export const USER_SESSION_COOKIE = "aistory_user_session";
const PRODUCTION_SESSION_VERSION = 2;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type UserSessionPayload = {
  version: 1 | 2;
  userId: string;
  issuedAt: number;
  expiresAt: number;
  authType: "phone";
  inviteBetaPolicyFingerprint?: string;
  phoneRegistrationPolicy?:
    typeof PHONE_REGISTRATION_POLICY_VALUES.publicBeta;
};

export type UserSessionTokenOptions = {
  inviteBetaPolicyFingerprint?: string;
  phoneRegistrationPolicy?:
    typeof PHONE_REGISTRATION_POLICY_VALUES.publicBeta;
};

export type UserSessionTokenIssuer = (
  userId: string,
  options?: UserSessionTokenOptions,
) => string;

function sessionSecret(): string | undefined {
  const value = process.env.AISTORY_USER_SESSION_SECRET?.trim();
  return value && value.length >= 32 ? value : undefined;
}

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value);
}

function legacyLocalPhoneSessionsAllowed(): boolean {
  return process.env.AISTORY_IDENTITY_REPOSITORY !== "supabase"
    && process.env.AISTORY_SMS_PROVIDER === "local_mock";
}

export function prepareUserSessionTokenIssuer(
  now = Date.now(),
): UserSessionTokenIssuer {
  const secret = sessionSecret();
  if (!secret) throw new Error("User session signing is not configured.");
  const productionReady = inspectProductionDatabaseGate().ready;
  const legacyLocalReady = legacyLocalPhoneSessionsAllowed();
  if (!productionReady && !legacyLocalReady) {
    throw new Error("A stable UUID user identity is required.");
  }
  return (userId, options = {}) => {
    const version = isUuid(userId) && productionReady
      ? PRODUCTION_SESSION_VERSION
      : legacyLocalReady && /^phone_[a-f0-9]{32}$/.test(userId)
        ? 1
        : undefined;
    if (!version) {
      throw new Error("A stable UUID user identity is required.");
    }
    if (
      options.inviteBetaPolicyFingerprint !== undefined
      && !/^[a-f0-9]{64}$/.test(options.inviteBetaPolicyFingerprint)
    ) {
      throw new Error("Invite beta session binding is invalid.");
    }
    if (
      options.phoneRegistrationPolicy !== undefined
      && options.phoneRegistrationPolicy
        !== PHONE_REGISTRATION_POLICY_VALUES.publicBeta
    ) {
      throw new Error("Phone registration session binding is invalid.");
    }
    const payload: UserSessionPayload = {
      version,
      userId,
      issuedAt: now,
      expiresAt: now + SESSION_TTL_MS,
      authType: "phone",
      ...(options.inviteBetaPolicyFingerprint
        ? {
            inviteBetaPolicyFingerprint:
              options.inviteBetaPolicyFingerprint,
          }
        : {}),
      ...(options.phoneRegistrationPolicy
        ? { phoneRegistrationPolicy: options.phoneRegistrationPolicy }
        : {}),
    };
    const encoded = encode(JSON.stringify(payload));
    return `${encoded}.${signature(encoded, secret)}`;
  };
}

export function createUserSessionToken(
  userId: string,
  now = Date.now(),
  options: UserSessionTokenOptions = {},
): string {
  return prepareUserSessionTokenIssuer(now)(userId, options);
}

export function verifyUserSessionToken(
  token: string | undefined,
  now = Date.now(),
): UserSessionPayload | undefined {
  const secret = sessionSecret();
  if (!secret || !token) return undefined;
  const [encoded, provided, extra] = token.split(".");
  if (!encoded || !provided || extra) return undefined;
  const expected = signature(encoded, secret);
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    return undefined;
  }
  try {
    const payload = JSON.parse(decode(encoded)) as Partial<UserSessionPayload>;
    const validIdentity =
      payload.version === PRODUCTION_SESSION_VERSION
        ? inspectProductionDatabaseGate().ready
          && typeof payload.userId === "string"
          && isUuid(payload.userId)
        : payload.version === 1
          && legacyLocalPhoneSessionsAllowed()
          && typeof payload.userId === "string"
          && /^phone_[a-f0-9]{32}$/.test(payload.userId);
    if (
      !validIdentity
      || payload.authType !== "phone"
      || typeof payload.expiresAt !== "number"
      || payload.expiresAt <= now
      || (
        payload.inviteBetaPolicyFingerprint !== undefined
        && (
          typeof payload.inviteBetaPolicyFingerprint !== "string"
          || !/^[a-f0-9]{64}$/.test(payload.inviteBetaPolicyFingerprint)
        )
      )
      || (
        payload.phoneRegistrationPolicy !== undefined
        && payload.phoneRegistrationPolicy
          !== PHONE_REGISTRATION_POLICY_VALUES.publicBeta
      )
    ) return undefined;
    return payload as UserSessionPayload;
  } catch {
    return undefined;
  }
}

async function readSignedPhoneUserSession(): Promise<
  UserSessionPayload | undefined
> {
  if (
    process.env.AISTORY_SMS_PROVIDER === "local_mock"
    && !isLoopbackHost((await headers()).get("host"))
  ) return undefined;
  const cookieStore = await cookies();
  return verifyUserSessionToken(
    cookieStore.get(USER_SESSION_COOKIE)?.value,
  );
}

async function validatePhoneSessionIdentity(
  session: UserSessionPayload | undefined,
): Promise<UserSessionPayload | undefined> {
  if (!session || session.version === 1) return session;
  try {
    return await getProductionPhoneIdentityRepository()
      .validateActiveUser(session.userId)
      ? session
      : undefined;
  } catch {
    return undefined;
  }
}

export async function readPhoneUserSession(): Promise<
  UserSessionPayload | undefined
> {
  return validatePhoneSessionIdentity(await readSignedPhoneUserSession());
}

export async function readInviteBetaPhoneUserSession(): Promise<
  UserSessionPayload | undefined
> {
  const session = await readSignedPhoneUserSession();
  if (
    !session
    || !await inviteBetaSessionBindingIsCurrent(
      session.inviteBetaPolicyFingerprint,
    )
  ) return undefined;
  return validatePhoneSessionIdentity(session);
}

export async function readPhoneRegistrationSession(): Promise<
  UserSessionPayload | undefined
> {
  const session = await readSignedPhoneUserSession();
  if (
    !session
    || !await phoneRegistrationSessionBindingIsCurrent(
      session.inviteBetaPolicyFingerprint,
      session.phoneRegistrationPolicy,
    )
  ) return undefined;
  return validatePhoneSessionIdentity(session);
}

export function userSessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "strict" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  };
}
