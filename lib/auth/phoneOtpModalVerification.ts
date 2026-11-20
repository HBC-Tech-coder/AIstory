import type { AnonymousClaimResult } from "@/lib/auth/anonymousClaim";
import type { LocalClaimCommitResult } from "@/lib/auth/anonymousClaimClient";

/**
 * Non-secret phases of the modal phone-verification request. These labels are
 * the only diagnostic detail that may reach the UI or logs: they carry no
 * phone number, OTP, challenge id, cookie, token, response body or server
 * text.
 */
export type PhoneOtpVerifyDiagnosticStage =
  | "pre-request"
  | "fetch"
  | "response"
  | "response-parse"
  | "local-claim-apply"
  | "unexpected";

export type PhoneOtpVerifyFailureReason =
  | "invalid-input"
  | "fetcher-unavailable"
  | "claim-preparation-timeout"
  | "invalid-payload"
  | "dispatch-threw"
  | "fetch-rejected"
  | "response-unavailable"
  | "invalid-json"
  | "claim-apply-timeout";

export type PhoneOtpVerifyDiagnostic = {
  stage: PhoneOtpVerifyDiagnosticStage;
  reason?: PhoneOtpVerifyFailureReason | "uncaught";
};

type VerificationResult =
  | { kind: "inactive" }
  | { kind: "rejected"; status: number; code?: string }
  | { kind: "invalid-account" }
  | { kind: "phone-proof" }
  | { kind: "normal"; claim?: AnonymousClaimResult; localClaim?: LocalClaimCommitResult; claimApplyFailed: boolean }
  | {
      kind: "failed";
      stage: Extract<PhoneOtpVerifyDiagnosticStage, "pre-request" | "fetch" | "response-parse">;
      reason: PhoneOtpVerifyFailureReason;
    };

/**
 * Local progress inheritance is useful, but it is not allowed to hold the OTP
 * request hostage. AuthModal starts this work while the player is reading the
 * SMS; this is only the small amount of time a click may still wait for it.
 */
export const PHONE_OTP_CLAIM_CLICK_WAIT_MS = 350;
export const PHONE_OTP_CLAIM_APPLY_WAIT_MS = 350;

async function prepareClaimWithinDeadline(input: {
  prepareClaim: () => Promise<unknown>;
  timeoutMs: number;
}): Promise<{ value: unknown; timedOut: boolean }> {
  const prepared = Promise.resolve()
    .then(input.prepareClaim)
    .then(
      (value) => ({ value, timedOut: false as const }),
      () => ({ value: undefined, timedOut: false as const }),
    );
  const timeoutMs = Math.max(0, Math.trunc(input.timeoutMs));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ value: undefined; timedOut: true }>((resolve) => {
    timer = setTimeout(
      () => resolve({ value: undefined, timedOut: true }),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([prepared, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type ClaimApplyDeadlineResult =
  | { kind: "applied"; value: LocalClaimCommitResult }
  | { kind: "failed" }
  | { kind: "timed-out" };

async function applyClaimWithinDeadline(input: {
  applyClaim: () => Promise<LocalClaimCommitResult>;
  timeoutMs: number;
}): Promise<ClaimApplyDeadlineResult> {
  const applied: Promise<ClaimApplyDeadlineResult> = Promise.resolve()
    .then(input.applyClaim)
    .then(
      (value) => ({ kind: "applied" as const, value }),
      () => ({ kind: "failed" as const }),
    );
  const timeoutMs = Math.max(0, Math.trunc(input.timeoutMs));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ClaimApplyDeadlineResult>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timed-out" }), timeoutMs);
  });
  try {
    return await Promise.race([applied, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function readJsonRecord(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The linking path verifies the phone cookie without reading or applying
 * anonymous assets.
 *
 * Every failure before a usable response is reported with a non-secret stage,
 * so a client-side failure that never reaches the network ("pre-request"), a
 * rejected fetch ("fetch") and an unreadable/non-JSON response
 * ("response-parse") are distinguishable instead of collapsing into one
 * generic "service unavailable" state.
 */
export async function verifyPhoneOtpForModal(input: {
  phone: string;
  challengeId: string;
  code: string;
  phoneProofOnly: boolean;
  prepareClaim: () => Promise<unknown>;
  applyClaim: (userId: string, claim?: AnonymousClaimResult) => Promise<LocalClaimCommitResult>;
  fetcher: typeof fetch;
  isActive: () => boolean;
  onAuthenticated?: () => void;
  onPhoneProofSuccess: () => void;
  claimPreparationTimeoutMs?: number;
  claimApplyTimeoutMs?: number;
  onDiagnostic?: (diagnostic: PhoneOtpVerifyDiagnostic) => void;
}): Promise<VerificationResult> {
  const phone = typeof input.phone === "string" ? input.phone.trim() : "";
  const challengeId = typeof input.challengeId === "string" ? input.challengeId : "";
  const code = typeof input.code === "string" ? input.code : "";
  if (!phone || !challengeId || code.length !== 6) {
    return { kind: "failed", stage: "pre-request", reason: "invalid-input" };
  }

  const fetcher = input.fetcher;
  if (typeof fetcher !== "function") {
    return { kind: "failed", stage: "pre-request", reason: "fetcher-unavailable" };
  }

  let anonymousClaim: unknown;
  if (!input.phoneProofOnly) {
    const prepared = await prepareClaimWithinDeadline({
      prepareClaim: input.prepareClaim,
      timeoutMs:
        input.claimPreparationTimeoutMs ?? PHONE_OTP_CLAIM_CLICK_WAIT_MS,
    });
    anonymousClaim = prepared.value;
    if (prepared.timedOut) {
      input.onDiagnostic?.({
        stage: "pre-request",
        reason: "claim-preparation-timeout",
      });
    }
  }

  let body: string;
  try {
    body = JSON.stringify({
      phone,
      challengeId,
      code,
      ...(anonymousClaim === undefined ? {} : { anonymousClaim }),
    });
  } catch {
    return { kind: "failed", stage: "pre-request", reason: "invalid-payload" };
  }

  let dispatched: Promise<Response>;
  try {
    dispatched = Reflect.apply(fetcher, globalThis, [
      "/api/auth/phone/verify",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      },
    ]) as Promise<Response>;
  } catch {
    return { kind: "failed", stage: "fetch", reason: "dispatch-threw" };
  }
  let response: Response;
  try {
    response = await dispatched;
  } catch {
    return { kind: "failed", stage: "fetch", reason: "fetch-rejected" };
  }

  let raw: string;
  try {
    raw = await response.text();
  } catch {
    return { kind: "failed", stage: "response-parse", reason: "response-unavailable" };
  }
  const result = readJsonRecord(raw);
  if (!result) {
    return { kind: "failed", stage: "response-parse", reason: "invalid-json" };
  }

  const responseCode = typeof result.code === "string" ? result.code : undefined;
  if (!response.ok) {
    return input.isActive()
      ? { kind: "rejected", status: response.status, code: responseCode }
      : { kind: "inactive" };
  }

  const account = result.account;
  const userId = account !== null && typeof account === "object" && !Array.isArray(account)
    ? (account as { userId?: unknown }).userId
    : undefined;
  if (typeof userId !== "string" || !userId) {
    return input.isActive() ? { kind: "invalid-account" } : { kind: "inactive" };
  }
  const claim = result.claim as AnonymousClaimResult | undefined;

  if (input.phoneProofOnly) {
    if (!input.isActive()) return { kind: "inactive" };
    input.onPhoneProofSuccess();
    return { kind: "phone-proof" };
  }
  try {
    // A successful response may have already installed the HttpOnly session
    // cookie. Reconcile account state even if the modal was closed while the
    // request was in flight; only modal-local rendering remains flow-scoped.
    input.onAuthenticated?.();
  } catch {
    // Account reconciliation callbacks must never invalidate a valid login.
  }
  if (!input.isActive()) return { kind: "inactive" };
  const applied = await applyClaimWithinDeadline({
    applyClaim: () => input.applyClaim(userId, claim),
    timeoutMs: input.claimApplyTimeoutMs ?? PHONE_OTP_CLAIM_APPLY_WAIT_MS,
  });
  if (!input.isActive()) return { kind: "inactive" };
  if (applied.kind === "applied") {
    return {
      kind: "normal",
      claim,
      localClaim: applied.value,
      claimApplyFailed: false,
    };
  }
  if (applied.kind === "timed-out") {
    input.onDiagnostic?.({
      stage: "local-claim-apply",
      reason: "claim-apply-timeout",
    });
    // The guarded Promise keeps running and may still commit locally, but the
    // authenticated session must become visible without waiting for it.
    return { kind: "normal", claim, claimApplyFailed: true };
  }
  return { kind: "normal", claim, claimApplyFailed: true };
}
