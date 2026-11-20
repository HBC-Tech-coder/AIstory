import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import { LINGHAO_PASSPORT_V4_PRODUCTION_REGISTRATION } from "./linghaoPassportV4ProductionContract";
import type { LinghaoPassportV4PublicAccount } from "./linghaoPassportV4ProductionPublic";
import { LINGHAO_PASSPORT_V4_PRODUCT_SESSION_COOKIE } from "./linghaoPassportV4ProductionCookies";

export { LINGHAO_PASSPORT_V4_PRODUCT_SESSION_COOKIE };
export const LINGHAO_PASSPORT_V4_ACCOUNT_NAMESPACE =
  "passport_v4_new_v1" as const;

const HEX = /^[a-f0-9]{64}$/;
const MAX_SUBJECT_BYTES = 512;
const MAX_SESSION_LIFETIME_MS = 60 * 60 * 1000;
const MAX_AUTHENTICATION_AGE_MS = 10 * 60 * 1000;
const PRINCIPAL_DOMAIN = "aistory.passport-v4.principal.v1\0";

export type LinghaoPassportV4ProductSession = Readonly<{
  authType: "passport_v4";
  userId: string;
  principalKey: string;
  sessionBinding: string;
  accountNamespace: typeof LINGHAO_PASSPORT_V4_ACCOUNT_NAMESPACE;
  authenticatedAtMs: number;
  expiresAtMs: number;
}>;

export type LinghaoPassportV4ProductSessionRead =
  | Readonly<{ state: "absent" }>
  | Readonly<{ state: "invalid" }>
  | Readonly<{
      state: "authenticated";
      session: LinghaoPassportV4ProductSession;
    }>;

function reject(): never {
  throw new Error("linghao_passport_v4_session_rejected");
}

function lengthPrefix(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const prefix = Buffer.allocUnsafe(4);
  prefix.writeUInt32BE(bytes.byteLength, 0);
  return Buffer.concat([prefix, bytes]);
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  if (leftBytes.length !== rightBytes.length) {
    timingSafeEqual(leftBytes, leftBytes);
    return false;
  }
  return timingSafeEqual(leftBytes, rightBytes);
}

function validSubject(subject: unknown): subject is string {
  if (typeof subject !== "string" || subject.length === 0) return false;
  const bytes = Buffer.from(subject, "utf8");
  return (
    bytes.byteLength <= MAX_SUBJECT_BYTES &&
    !/[\u0000-\u001f\u007f]/.test(subject)
  );
}

export function deriveLinghaoPassportV4PrincipalKey(
  issuer: string,
  clientId: string,
  subject: string,
): string {
  const registration = LINGHAO_PASSPORT_V4_PRODUCTION_REGISTRATION;
  if (
    !safeEqual(issuer, registration.issuer) ||
    !safeEqual(clientId, registration.clientId) ||
    !validSubject(subject)
  ) {
    reject();
  }
  return createHash("sha256")
    .update(PRINCIPAL_DOMAIN, "utf8")
    .update(lengthPrefix(issuer))
    .update(lengthPrefix(clientId))
    .update(lengthPrefix(subject))
    .digest("hex");
}

export function createLinghaoPassportV4ProductSessionCandidate(input: {
  readonly issuer: string;
  readonly clientId: string;
  readonly subject: string;
  readonly sessionBinding: string;
  readonly authenticatedAtMs: number;
  readonly expiresAtMs: number;
  readonly nowMs?: number;
}): LinghaoPassportV4ProductSession {
  const nowMs = input.nowMs ?? Date.now();
  if (
    !HEX.test(input.sessionBinding) ||
    !Number.isSafeInteger(nowMs) ||
    !Number.isSafeInteger(input.authenticatedAtMs) ||
    !Number.isSafeInteger(input.expiresAtMs) ||
    input.authenticatedAtMs > nowMs ||
    nowMs - input.authenticatedAtMs > MAX_AUTHENTICATION_AGE_MS ||
    input.expiresAtMs <= nowMs ||
    input.expiresAtMs - nowMs > MAX_SESSION_LIFETIME_MS
  ) {
    reject();
  }
  const principalKey = deriveLinghaoPassportV4PrincipalKey(
    input.issuer,
    input.clientId,
    input.subject,
  );
  return Object.freeze({
    authType: "passport_v4",
    userId: `passport_v4:${principalKey}`,
    principalKey,
    sessionBinding: input.sessionBinding,
    accountNamespace: LINGHAO_PASSPORT_V4_ACCOUNT_NAMESPACE,
    authenticatedAtMs: input.authenticatedAtMs,
    expiresAtMs: input.expiresAtMs,
  });
}

export function linghaoPassportV4PublicAccount(
  session: LinghaoPassportV4ProductSession,
): LinghaoPassportV4PublicAccount {
  if (
    session.authType !== "passport_v4" ||
    session.userId !== `passport_v4:${session.principalKey}` ||
    !HEX.test(session.principalKey) ||
    !HEX.test(session.sessionBinding) ||
    session.accountNamespace !== LINGHAO_PASSPORT_V4_ACCOUNT_NAMESPACE ||
    !Number.isSafeInteger(session.expiresAtMs)
  ) {
    reject();
  }
  return Object.freeze({
    authType: "passport_v4" as const,
    displayName: "灵号通行证用户" as const,
    status: "active" as const,
    expiresAt: session.expiresAtMs,
    balance: null,
    ledger: Object.freeze([] as const),
    capabilities: Object.freeze({
      ordinaryProductAccess: true,
      newContentNamespace: true,
      legacyAccountRead: false,
      legacyAccountLink: false,
      administrator: false,
      phoneAccount: false,
      formalWallet: false,
      platformPaidGeneration: false,
      cloudProgress: false,
      hostedByok: false,
    }),
  });
}

export function decideLinghaoPassportV4SessionPrecedence(
  passport: LinghaoPassportV4ProductSessionRead,
):
  | Readonly<{ state: "passport"; session: LinghaoPassportV4ProductSession }>
  | Readonly<{ state: "reject_invalid_passport" }>
  | Readonly<{ state: "legacy_fallback_allowed" }> {
  if (passport.state === "authenticated") {
    return Object.freeze({ state: "passport", session: passport.session });
  }
  if (passport.state === "invalid") {
    return Object.freeze({ state: "reject_invalid_passport" });
  }
  return Object.freeze({ state: "legacy_fallback_allowed" });
}

export function decideLinghaoPassportV4EntryCutover(input: {
  readonly passportPublicEnabled: boolean;
  readonly legacyEntryAvailable: boolean;
}) {
  if (input.passportPublicEnabled) {
    return Object.freeze({
      primaryEntry: "passport_v4" as const,
      legacyRollbackEntry: input.legacyEntryAvailable,
      finalDeliveryAccepted: true,
    });
  }
  return Object.freeze({
    primaryEntry: input.legacyEntryAvailable ? ("legacy" as const) : null,
    legacyRollbackEntry: input.legacyEntryAvailable,
    finalDeliveryAccepted: false,
  });
}

