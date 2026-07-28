import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies, headers } from "next/headers";

import { isLoopbackHost } from "@/lib/admin/security";
import { getProductionPhoneIdentityRepository } from "./phoneIdentityRepository";
import { inspectProductionDatabaseGate } from "@/lib/production/databaseGate";

export const USER_SESSION_COOKIE = "aistory_user_session";
const PRODUCTION_SESSION_VERSION = 2;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type UserSessionPayload = {
  version: 1 | 2;
  userId: string;
  issuedAt: number;
  expiresAt: number;
  authType: "phone";
};

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

export function createUserSessionToken(
  userId: string,
  now = Date.now(),
): string {
  const secret = sessionSecret();
  if (!secret) throw new Error("User session signing is not configured.");
  const version = isUuid(userId) && inspectProductionDatabaseGate().ready
    ? PRODUCTION_SESSION_VERSION
    : legacyLocalPhoneSessionsAllowed() && /^phone_[a-f0-9]{32}$/.test(userId)
      ? 1
      : undefined;
  if (!version) {
    throw new Error("A stable UUID user identity is required.");
  }
  const payload: UserSessionPayload = {
    version,
    userId,
    issuedAt: now,
    expiresAt: now + SESSION_TTL_MS,
    authType: "phone",
  };
  const encoded = encode(JSON.stringify(payload));
  return `${encoded}.${signature(encoded, secret)}`;
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
    ) return undefined;
    return payload as UserSessionPayload;
  } catch {
    return undefined;
  }
}

export async function readPhoneUserSession(): Promise<
  UserSessionPayload | undefined
> {
  if (
    process.env.AISTORY_SMS_PROVIDER === "local_mock"
    && !isLoopbackHost((await headers()).get("host"))
  ) return undefined;
  const cookieStore = await cookies();
  const session = verifyUserSessionToken(
    cookieStore.get(USER_SESSION_COOKIE)?.value,
  );
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

export function userSessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "strict" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  };
}
