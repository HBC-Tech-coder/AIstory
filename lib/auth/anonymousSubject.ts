import "server-only";

import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { NextResponse } from "next/server";

export const ANONYMOUS_SUBJECT_COOKIE = "aistory_anonymous_subject";
const ANONYMOUS_SUBJECT_VERSION = 1;
const ANONYMOUS_SUBJECT_TTL_SECONDS = 180 * 24 * 60 * 60;

type AnonymousSubjectEnvironment = Partial<Record<
  | "AISTORY_ANONYMOUS_SESSION_SECRET"
  | "AISTORY_ANONYMOUS_SUBJECT_PEPPER"
  | "NODE_ENV",
  string | undefined
>>;

export type AnonymousSubject = {
  subjectHash: string;
  expiresAt: number;
};

type AnonymousSubjectToken = AnonymousSubject & {
  token: string;
  created: boolean;
};

function secret(
  env: AnonymousSubjectEnvironment,
  name:
    | "AISTORY_ANONYMOUS_SESSION_SECRET"
    | "AISTORY_ANONYMOUS_SUBJECT_PEPPER",
): string | undefined {
  const value = env[name]?.trim();
  return value && value.length >= 32 ? value : undefined;
}

function sign(payload: string, value: string): string {
  return createHmac("sha256", value).update(payload).digest("base64url");
}

function subjectHash(rawId: string, pepper: string): string {
  return createHmac("sha256", pepper).update(rawId).digest("hex");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookieValue(request: Request): string | undefined {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === ANONYMOUS_SUBJECT_COOKIE) {
      try {
        return decodeURIComponent(rest.join("="));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export function inspectAnonymousSubjectToken(
  token: string | undefined,
  env: AnonymousSubjectEnvironment = process.env,
  now = Date.now(),
): AnonymousSubject | undefined {
  const signingSecret = secret(env, "AISTORY_ANONYMOUS_SESSION_SECRET");
  const pepper = secret(env, "AISTORY_ANONYMOUS_SUBJECT_PEPPER");
  if (!token || !signingSecret || !pepper) return undefined;
  const [version, rawId, issuedText, expiresText, suppliedSignature, extra] =
    token.split(".");
  const issuedAt = Number(issuedText);
  const expiresAt = Number(expiresText);
  if (
    extra !== undefined ||
    version !== String(ANONYMOUS_SUBJECT_VERSION) ||
    !/^[A-Za-z0-9_-]{43}$/.test(rawId || "") ||
    !Number.isSafeInteger(issuedAt) ||
    !Number.isSafeInteger(expiresAt) ||
    issuedAt > now + 60_000 ||
    expiresAt <= now ||
    expiresAt - issuedAt > ANONYMOUS_SUBJECT_TTL_SECONDS * 1000 ||
    !suppliedSignature
  ) {
    return undefined;
  }
  const payload = [version, rawId, issuedText, expiresText].join(".");
  if (!safeEqual(suppliedSignature, sign(payload, signingSecret))) {
    return undefined;
  }
  return {
    subjectHash: subjectHash(rawId!, pepper),
    expiresAt,
  };
}

export function readAnonymousSubject(
  request: Request,
  env: AnonymousSubjectEnvironment = process.env,
  now = Date.now(),
): AnonymousSubject | undefined {
  return inspectAnonymousSubjectToken(cookieValue(request), env, now);
}

export function getOrCreateAnonymousSubject(
  request: Request,
  env: AnonymousSubjectEnvironment = process.env,
  now = Date.now(),
): AnonymousSubjectToken | undefined {
  const existingToken = cookieValue(request);
  const existing = inspectAnonymousSubjectToken(existingToken, env, now);
  if (existing && existingToken) {
    return { ...existing, token: existingToken, created: false };
  }
  const signingSecret = secret(env, "AISTORY_ANONYMOUS_SESSION_SECRET");
  const pepper = secret(env, "AISTORY_ANONYMOUS_SUBJECT_PEPPER");
  if (!signingSecret || !pepper) return undefined;
  const rawId = randomBytes(32).toString("base64url");
  const expiresAt = now + ANONYMOUS_SUBJECT_TTL_SECONDS * 1000;
  const payload = [
    ANONYMOUS_SUBJECT_VERSION,
    rawId,
    now,
    expiresAt,
  ].join(".");
  return {
    token: `${payload}.${sign(payload, signingSecret)}`,
    subjectHash: subjectHash(rawId, pepper),
    expiresAt,
    created: true,
  };
}

export function attachAnonymousSubjectCookie(
  response: NextResponse,
  subject: AnonymousSubjectToken | undefined,
  env: AnonymousSubjectEnvironment = process.env,
): void {
  if (!subject?.created) return;
  response.cookies.set(ANONYMOUS_SUBJECT_COOKIE, subject.token, {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: ANONYMOUS_SUBJECT_TTL_SECONDS,
  });
}

export function clearAnonymousSubjectCookie(response: NextResponse): void {
  response.cookies.set(ANONYMOUS_SUBJECT_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

