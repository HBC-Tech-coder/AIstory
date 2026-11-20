import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { isLinghaoPassportV4StateEnvelope } from "./linghaoPassportV4StateSeal";

export const LINGHAO_PASSPORT_V4_AUTH_DATABASE_GATE_VERSION =
  "20261119120000" as const;
export const LINGHAO_PASSPORT_V4_AUTH_REPOSITORY_ENV =
  "AISTORY_LINGHAO_PASSPORT_V4_AUTH_REPOSITORY" as const;
export const LINGHAO_PASSPORT_V4_AUTH_GATE_ENV =
  "AISTORY_LINGHAO_PASSPORT_V4_AUTH_DATABASE_GATE_VERSION" as const;
export const LINGHAO_PASSPORT_V4_AUTH_REPOSITORY = "supabase" as const;

export type LinghaoPassportV4DurableHashPurpose =
  | "family_cookie"
  | "transaction_cookie"
  | "oidc_state"
  | "oidc_nonce"
  | "session_cookie"
  | "access_token"
  | "refresh_token"
  | "refresh_attempt"
  | "logout_receipt"
  | "logout_state"
  | "rate_bucket"
  | "completion";

export type LinghaoPassportV4ReserveStartInput = Readonly<{
  familyHash: string;
  transactionHash: string;
  stateHash: string;
  nonceHash: string;
  rateBucketHash: string;
  verifierEnvelope: string;
}>;

export type LinghaoPassportV4ReserveStartResult =
  | Readonly<{ status: "reserved"; expiresAtMs: number }>
  | Readonly<{ status: "rate_limited" }>;

export type LinghaoPassportV4ConsumeCallbackResult =
  | Readonly<{
      status: "accepted";
      familyHash: string;
      transactionHash: string;
      nonceHash: string;
      verifierEnvelope: string;
    }>
  | Readonly<{
      status: "completed";
      sessionResultEnvelope: string;
    }>
  | Readonly<{
      status: "rejected";
      reason: "missing" | "expired" | "state_mismatch" | "terminal";
    }>;

export type LinghaoPassportV4CommitCallbackInput = Readonly<{
  transactionHash: string;
  familyHash: string;
  principalKey: string;
  sessionHash: string;
  completionHash: string;
  sessionResultEnvelope: string;
  accessTokenFingerprint: string;
  accessTokenEnvelope: string;
  idTokenHintEnvelope: string | null;
  refreshFingerprint: string | null;
  refreshEnvelope: string | null;
  providerExpiresAtMs: number;
}>;

export type LinghaoPassportV4CommitCallbackResult =
  | Readonly<{
      status: "committed" | "replayed";
      sessionResultEnvelope: string;
      absoluteExpiresAtMs: number;
    }>
  | Readonly<{ status: "cleanup_required" | "rejected" }>;

export type LinghaoPassportV4SessionRead =
  | Readonly<{
      status: "authenticated";
      principalKey: string;
      familyHash: string;
      sessionHash: string;
      generation: number;
      authenticatedAtMs: number;
      expiresAtMs: number;
    }>
  | Readonly<{ status: "refresh_required"; familyHash: string }>
  | Readonly<{ status: "invalid" }>;

export type LinghaoPassportV4BeginRefreshResult =
  | Readonly<{
      status: "claimed";
      familyHash: string;
      sessionHash: string;
      generation: number;
      refreshContextHash: string;
      refreshEnvelope: string;
    }>
  | Readonly<{ status: "rejected" }>;

export type LinghaoPassportV4CommitRefreshInput = Readonly<{
  attemptHash: string;
  completionHash: string;
  replacementFingerprint: string;
  replacementEnvelope: string;
  accessTokenFingerprint: string;
  accessTokenEnvelope: string;
  idTokenHintEnvelope: string | null;
  providerExpiresAtMs: number;
}>;

export type LinghaoPassportV4CommitRefreshResult = Readonly<{
  status: "committed" | "replayed" | "cleanup_required" | "rejected";
}>;

export type LinghaoPassportV4BeginLogoutResult =
  | Readonly<{
      status: "revoked";
      localLoggedOut: true;
      revocationPending: boolean;
      resultExpiresAtMs: number;
      idTokenHintEnvelope: string | null;
    }>
  | Readonly<{ status: "missing"; localLoggedOut: true; revocationPending: false; idTokenHintEnvelope: null }>;

export type LinghaoPassportV4RevocationWork =
  | Readonly<{
      status: "claimed";
      outboxHash: string;
      tokenContextHash: string;
      tokenKind: "access_token" | "refresh_token";
      tokenEnvelope: string;
    }>
  | Readonly<{ status: "empty" }>;

export type LinghaoPassportV4LogoutResult =
  | Readonly<{
      status: "consumed";
      localLoggedOut: true;
      revocationConfirmed: boolean;
      upstreamReturnConfirmed: boolean;
    }>
  | Readonly<{ status: "invalid" }>;

export type LinghaoPassportV4LogoutInspection =
  | Readonly<{ status: "ready"; revocationConfirmed: boolean }>
  | Readonly<{ status: "invalid" }>;

export interface LinghaoPassportV4DurableAuthority {
  assertReady(): Promise<void>;
  reserveStart(input: LinghaoPassportV4ReserveStartInput): Promise<LinghaoPassportV4ReserveStartResult>;
  cancelStart(transactionHash: string): Promise<void>;
  consumeCallback(transactionHash: string, stateHash: string): Promise<LinghaoPassportV4ConsumeCallbackResult>;
  commitCallback(input: LinghaoPassportV4CommitCallbackInput): Promise<LinghaoPassportV4CommitCallbackResult>;
  readSession(sessionHash: string): Promise<LinghaoPassportV4SessionRead>;
  beginRefresh(sessionHash: string, attemptHash: string): Promise<LinghaoPassportV4BeginRefreshResult>;
  commitRefresh(input: LinghaoPassportV4CommitRefreshInput): Promise<LinghaoPassportV4CommitRefreshResult>;
  failRefresh(attemptHash: string): Promise<void>;
  beginLogout(input: Readonly<{
    familyHash: string;
    sessionHash: string;
    receiptHash: string;
    stateHash: string;
    upstreamReturnExpected: boolean;
  }>): Promise<LinghaoPassportV4BeginLogoutResult>;
  claimRevocation(outboxClaimHash: string): Promise<LinghaoPassportV4RevocationWork>;
  completeRevocation(outboxHash: string, confirmed: boolean): Promise<void>;
  inspectLogoutResult(receiptHash: string): Promise<LinghaoPassportV4LogoutInspection>;
  consumeLogoutResult(receiptHash: string, stateHash: string, upstreamReturnConfirmed: boolean): Promise<LinghaoPassportV4LogoutResult>;
}

const HASH = /^[a-f0-9]{64}$/;

function reject(): never {
  throw new Error("linghao_passport_v4_durable_authority_rejected");
}

export function isLinghaoPassportV4DurableHash(value: unknown): value is string {
  return typeof value === "string" && HASH.test(value);
}

export function assertLinghaoPassportV4DurableHash(value: unknown): string {
  if (!isLinghaoPassportV4DurableHash(value)) reject();
  return value;
}

export function deriveLinghaoPassportV4DurableHash(
  purpose: LinghaoPassportV4DurableHashPurpose,
  value: string,
  stateSealKey: Uint8Array,
): string {
  if (
    !/^[a-z_]{3,32}$/.test(purpose) ||
    typeof value !== "string" ||
    value.length < 1 ||
    Buffer.byteLength(value, "utf8") > 16 * 1024 ||
    !(stateSealKey instanceof Uint8Array) ||
    stateSealKey.byteLength !== 32
  ) {
    reject();
  }
  const key = Buffer.from(stateSealKey);
  try {
    return createHmac("sha256", key)
      .update("aistory.linghao-passport-v4.durable-hash.v1\0", "utf8")
      .update(purpose, "utf8")
      .update("\0", "utf8")
      .update(value, "utf8")
      .digest("hex");
  } finally {
    key.fill(0);
  }
}

export function inspectLinghaoPassportV4DurableAuthorityGate(
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<{ ready: boolean; missing: readonly string[] }> {
  const missing: string[] = [];
  if (
    environment[LINGHAO_PASSPORT_V4_AUTH_REPOSITORY_ENV] !==
    LINGHAO_PASSPORT_V4_AUTH_REPOSITORY
  ) {
    missing.push("auth_repository");
  }
  if (
    environment[LINGHAO_PASSPORT_V4_AUTH_GATE_ENV] !==
    LINGHAO_PASSPORT_V4_AUTH_DATABASE_GATE_VERSION
  ) {
    missing.push("auth_database_gate");
  }
  return Object.freeze({ ready: missing.length === 0, missing: Object.freeze(missing) });
}

export function assertLinghaoPassportV4DurableAuthorityGate(
  environment: Readonly<Record<string, string | undefined>>,
): void {
  if (!inspectLinghaoPassportV4DurableAuthorityGate(environment).ready) reject();
}

export function assertLinghaoPassportV4StateEnvelope(value: unknown): string {
  if (!isLinghaoPassportV4StateEnvelope(value)) reject();
  return value;
}

export function safeLinghaoPassportV4HashEqual(left: string, right: string): boolean {
  if (!HASH.test(left) || !HASH.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}
