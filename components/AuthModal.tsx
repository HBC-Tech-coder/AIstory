"use client";
import { AiUserLoginButton } from "@/components/AiUserLoginButton";
import { LinghaoPassportV4LoginBoundary } from "@/components/LinghaoPassportV4LoginButton";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { track } from "@/lib/analytics";
import { useI18n } from "@/lib/i18n/client";
import {
  applyAnonymousClaimResult,
  prepareAnonymousClaimManifest,
  type LocalClaimCommitResult,
} from "@/lib/auth/anonymousClaimClient";
import {
  PHONE_OTP_CLAIM_CLICK_WAIT_MS,
  verifyPhoneOtpForModal,
  type PhoneOtpVerifyDiagnostic,
} from "../lib/auth/phoneOtpModalVerification";
import type {
  AnonymousClaimResult,
  AnonymousClaimSkipReason,
} from "@/lib/auth/anonymousClaim";
import {
  SAFE_AUTH_PROMPTS,
  mapPhoneVerifyFailure,
  resolveAuthRequirementMessage,
} from "@/lib/auth/authModalPresentation";
import {
  PHONE_OTP_COOLDOWN_EVENT,
  PHONE_OTP_COOLDOWN_STORAGE_KEY,
  clearExpiredPhoneOtpCooldown,
  phoneOtpCooldownSecondsRemaining,
  readPhoneOtpCooldownDeadline,
  resolvePhoneOtpRetryAfterSeconds,
  storePhoneOtpCooldownDeadline,
} from "@/lib/auth/phoneOtpCooldown";

type AuthStep = "phone-input" | "phone-verify" | "claim-result";

const CLAIM_SKIP_REASON_KEYS: Record<AnonymousClaimSkipReason, string> = {
  not_published: "auth.claimSkipNotPublished",
  version_mismatch: "auth.claimSkipVersionMismatch",
  node_unavailable: "auth.claimSkipNodeUnavailable",
  resource_unavailable: "auth.claimSkipResourceUnavailable",
  assignment_unavailable: "auth.claimSkipAssignmentUnavailable",
  manifest_invalid: "auth.claimSkipManifestInvalid",
};

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function getFocusableElements(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter((element) => {
    if (element.hasAttribute("disabled")) return false;
    if (element.getAttribute("aria-hidden") === "true") return false;
    if (element.hidden) return false;
    if (element.tabIndex < 0) return false;
    return element.getClientRects().length > 0;
  });
}

/**
 * Records a non-secret phone-verification phase for debugging. Only the
 * enumerated stage/reason labels are emitted: never the phone number, OTP,
 * challenge id, cookies, tokens, response bodies or server text.
 */
function reportPhoneVerifyDiagnostic(diagnostic: PhoneOtpVerifyDiagnostic): void {
  try {
    console.warn(
      `[auth] phone-verify stage=${diagnostic.stage}${diagnostic.reason ? ` reason=${diagnostic.reason}` : ""}`,
    );
  } catch {
    // Diagnostics must never affect the login flow.
  }
}

export type AuthRequirement = {
  message: string;
  quote?: {
    estimatedCredits: number;
    pricePolicyVersion: string;
    modalities: string[];
  };
};

export function AuthModal({
  onClose,
  onSuccess,
  requirement,
  phoneProofOnly = false,
}: {
  onClose: () => void;
  onSuccess: () => void;
  requirement?: AuthRequirement;
  /** Obtain a fresh phone proof for explicit AIUser linking without claiming local assets. */
  phoneProofOnly?: boolean;
}) {
  const [step, setStep] = useState<AuthStep>("phone-input");
  const [otp, setOtp] = useState("");
  const [phone, setPhone] = useState("");
  const [phoneChallengeId, setPhoneChallengeId] = useState("");
  const [phoneChallengeExpiresAt, setPhoneChallengeExpiresAt] = useState(0);
  const [maskedPhone, setMaskedPhone] = useState("");
  const [sendingOtp, setSendingOtp] = useState(false);
  const [verifyingOtp, setVerifyingOtp] = useState(false);
  const [error, setError] = useState("");
  const [cooldownDeadline, setCooldownDeadline] = useState(0);
  const [cooldownRemaining, setCooldownRemaining] = useState(0);
  const [hasRequestedCode, setHasRequestedCode] = useState(false);
  const [claimResult, setClaimResult] = useState<AnonymousClaimResult>();
  const [localClaim, setLocalClaim] = useState<LocalClaimCommitResult>();
  const [claimApplyFailed, setClaimApplyFailed] = useState(false);
  const [verifyDiagnostic, setVerifyDiagnostic] =
    useState<PhoneOtpVerifyDiagnostic | null>(null);
  const [hasMounted, setHasMounted] = useState(false);
  const mountedRef = useRef(false);
  const flowEpochRef = useRef(0);
  const sendInFlightRef = useRef(false);
  const verifyInFlightRef = useRef(false);
  const claimPreparationRef = useRef<{
    challengeId: string;
    promise: Promise<unknown>;
  } | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const phoneInputRef = useRef<HTMLInputElement | null>(null);
  const otpInputRef = useRef<HTMLInputElement | null>(null);
  const continueButtonRef = useRef<HTMLButtonElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const { t } = useI18n();
  const requirementPrompt = resolveAuthRequirementMessage(requirement);
  const claimSkipReasonText = claimResult
    ? Object.entries(claimResult.skippedByReason)
        .flatMap(([reason, count]) => {
          if (
            !count
            || !(reason in CLAIM_SKIP_REASON_KEYS)
          ) {
            return [];
          }
          return [
            `${t(
              CLAIM_SKIP_REASON_KEYS[reason as AnonymousClaimSkipReason],
            )} ${count}`,
          ];
        })
        .join(" · ")
    : "";

  const resetPhoneFlow = useCallback((preservePhone = false) => {
    flowEpochRef.current += 1;
    sendInFlightRef.current = false;
    verifyInFlightRef.current = false;
    claimPreparationRef.current = null;
    setStep("phone-input");
    setOtp("");
    if (!preservePhone) setPhone("");
    setPhoneChallengeId("");
    setPhoneChallengeExpiresAt(0);
    setMaskedPhone("");
    setSendingOtp(false);
    setVerifyingOtp(false);
    setError("");
    setHasRequestedCode(false);
    setClaimResult(undefined);
    setLocalClaim(undefined);
    setClaimApplyFailed(false);
    setVerifyDiagnostic(null);
  }, []);

  const handleClose = useCallback(() => {
    resetPhoneFlow();
    onCloseRef.current();
  }, [resetPhoneFlow]);

  const getClaimPreparation = useCallback((challengeId: string) => {
    if (phoneProofOnly) return Promise.resolve(undefined);
    const current = claimPreparationRef.current;
    if (current?.challengeId === challengeId) return current.promise;
    const promise = prepareAnonymousClaimManifest().catch(() => undefined);
    claimPreparationRef.current = { challengeId, promise };
    return promise;
  }, [phoneProofOnly]);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    mountedRef.current = true;
    setHasMounted(true);
    const syncCooldown = () => {
      const deadline = readPhoneOtpCooldownDeadline(window.localStorage);
      const remaining = phoneOtpCooldownSecondsRemaining(deadline);
      setCooldownDeadline(deadline);
      setCooldownRemaining(remaining);
    };
    const onStorage = (event: StorageEvent) => {
      if (
        event.key === null ||
        event.key === PHONE_OTP_COOLDOWN_STORAGE_KEY
      ) {
        syncCooldown();
      }
    };
    syncCooldown();
    window.addEventListener("storage", onStorage);
    window.addEventListener(PHONE_OTP_COOLDOWN_EVENT, syncCooldown);
    return () => {
      mountedRef.current = false;
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(PHONE_OTP_COOLDOWN_EVENT, syncCooldown);
    };
  }, []);

  useEffect(() => {
    if (!cooldownDeadline) {
      setCooldownRemaining(0);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      if (cancelled) return;
      const now = Date.now();
      const remaining = phoneOtpCooldownSecondsRemaining(
        cooldownDeadline,
        now,
      );
      setCooldownRemaining(remaining);
      if (remaining <= 0) {
        clearExpiredPhoneOtpCooldown(
          window.localStorage,
          cooldownDeadline,
          now,
        );
        setCooldownDeadline(0);
        return;
      }
      const remainingMs = Math.max(0, cooldownDeadline - now);
      const nextBoundaryMs =
        remainingMs - (remaining - 1) * 1000 + 10;
      timer = setTimeout(tick, Math.min(1000, Math.max(50, nextBoundaryMs)));
    };
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [cooldownDeadline]);

  // Escape-to-close, Tab focus trapping, body scroll lock and trigger focus
  // restoration. This effect is intentionally not re-run on every render so
  // typing or async state changes never steal focus.
  useEffect(() => {
    if (!hasMounted || typeof document === "undefined") return;

    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    previouslyFocusedRef.current = previousFocus;

    const body = document.body;
    const previousOverflow = body.style.overflow;
    const previousOverscrollBehavior = body.style.overscrollBehavior;
    body.style.overflow = "hidden";
    body.style.overscrollBehavior = "contain";

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        handleClose();
        return;
      }
      if (event.key !== "Tab") return;

      const dialog = dialogRef.current;
      const focusables = getFocusableElements(dialog);
      if (focusables.length === 0) {
        event.preventDefault();
        dialog?.focus({ preventScroll: true });
        return;
      }

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (first === undefined || last === undefined) return;
      const active = document.activeElement;
      const activeInsideDialog =
        active instanceof Node && dialog?.contains(active) === true;

      if (active === dialog) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }

      if (event.shiftKey) {
        if (!activeInsideDialog || active === first) {
          event.preventDefault();
          last.focus();
        }
        return;
      }
      if (!activeInsideDialog || active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      body.style.overflow = previousOverflow;
      body.style.overscrollBehavior = previousOverscrollBehavior;

      const previous = previouslyFocusedRef.current;
      previouslyFocusedRef.current = null;
      if (
        previous
        && previous !== document.body
        && previous !== document.documentElement
        && previous.isConnected
      ) {
        try {
          previous.focus({ preventScroll: true });
        } catch {
          previous.focus();
        }
      }
    };
  }, [handleClose, hasMounted]);

  // Move focus with the auth step only when the step changes. This avoids
  // stealing focus on unrelated rerenders (typing, cooldown ticks, errors).
  useEffect(() => {
    if (!hasMounted || typeof document === "undefined") return;
    const target =
      step === "phone-input"
        ? phoneInputRef.current
        : step === "phone-verify"
          ? otpInputRef.current
          : continueButtonRef.current;
    if (!target || document.activeElement === target) return;
    target.focus();
  }, [hasMounted, step]);

  const startPhoneOtpCooldown = useCallback((seconds: unknown) => {
    const deadline = storePhoneOtpCooldownDeadline(
      window.localStorage,
      seconds,
    );
    if (mountedRef.current) {
      setCooldownDeadline(deadline);
      setCooldownRemaining(phoneOtpCooldownSecondsRemaining(deadline));
    }
    window.dispatchEvent(new Event(PHONE_OTP_COOLDOWN_EVENT));
  }, []);

  const handleSendPhoneOtp = useCallback(async () => {
    const trimmed = phone.trim();
    if (!trimmed || sendInFlightRef.current) return;
    const flowEpoch = flowEpochRef.current;
    const persistedDeadline = readPhoneOtpCooldownDeadline(
      window.localStorage,
    );
    const persistedRemaining = phoneOtpCooldownSecondsRemaining(
      persistedDeadline,
    );
    if (persistedRemaining > 0) {
      setCooldownDeadline(persistedDeadline);
      setCooldownRemaining(persistedRemaining);
      return;
    }
    sendInFlightRef.current = true;
    setSendingOtp(true);
    setError("");
    setVerifyDiagnostic(null);
    try {
      const response = await window.fetch("/api/auth/phone/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: trimmed }),
      });
      const result = await response.json() as {
        error?: string;
        code?: string;
        challengeId?: string;
        maskedPhone?: string;
        expiresInSeconds?: number;
        retryAfter?: number;
        retryAfterSeconds?: number;
      };
      if (response.status === 202 || response.status === 429) {
        startPhoneOtpCooldown(
          resolvePhoneOtpRetryAfterSeconds(
            result,
            response.headers.get("retry-after"),
          ),
        );
      }
      const accepted =
        response.status === 202
        && typeof result.challengeId === "string"
        && result.challengeId.trim().length > 0;
      if (!accepted) {
        if (!mountedRef.current || flowEpoch !== flowEpochRef.current) return;
        if (result.code === "PHONE_INVALID") {
          setError(t("auth.phoneInvalid"));
        } else if (
          response.status === 429 ||
          result.code === "SMS_RATE_LIMITED"
        ) {
          if (response.status !== 429) {
            startPhoneOtpCooldown(
              resolvePhoneOtpRetryAfterSeconds(
                result,
                response.headers.get("retry-after"),
              ),
            );
          }
          setError(t("auth.smsRateLimited"));
        } else {
          setError(t("auth.smsUnavailable"));
        }
        return;
      }
      if (!mountedRef.current || flowEpoch !== flowEpochRef.current) return;
      const challengeId = result.challengeId!.trim();
      const expiresInSeconds =
        Number.isFinite(result.expiresInSeconds)
        && Number(result.expiresInSeconds) > 0
          ? Math.min(3_600, Math.trunc(Number(result.expiresInSeconds)))
          : 5 * 60;
      setPhone(trimmed);
      setPhoneChallengeId(challengeId);
      setPhoneChallengeExpiresAt(Date.now() + expiresInSeconds * 1000);
      setMaskedPhone(result.maskedPhone || "••••");
      setOtp("");
      setHasRequestedCode(true);
      void getClaimPreparation(challengeId);
      setStep("phone-verify");
    } catch {
      if (mountedRef.current && flowEpoch === flowEpochRef.current) {
        setError(t("auth.smsUnavailable"));
      }
    } finally {
      if (flowEpoch === flowEpochRef.current) {
        sendInFlightRef.current = false;
        if (mountedRef.current) setSendingOtp(false);
      }
    }
  }, [getClaimPreparation, phone, startPhoneOtpCooldown, t]);

  const handleVerifyPhoneOtp = useCallback(async () => {
    if (
      !phoneChallengeId
      || (phoneChallengeExpiresAt > 0 && phoneChallengeExpiresAt <= Date.now())
    ) {
      resetPhoneFlow(true);
      setError(SAFE_AUTH_PROMPTS.invalidCode);
      return;
    }
    if (otp.length !== 6) return;
    if (verifyInFlightRef.current) return;
    const flowEpoch = flowEpochRef.current;
    verifyInFlightRef.current = true;
    setVerifyingOtp(true);
    setError("");
    setClaimApplyFailed(false);
    setVerifyDiagnostic(null);
    try {
      const result = await verifyPhoneOtpForModal({
        phone, challengeId: phoneChallengeId, code: otp, phoneProofOnly,
        prepareClaim: () => getClaimPreparation(phoneChallengeId),
        applyClaim: applyAnonymousClaimResult,
        fetcher: (request, init) => window.fetch(request, init),
        claimPreparationTimeoutMs: PHONE_OTP_CLAIM_CLICK_WAIT_MS,
        onDiagnostic: reportPhoneVerifyDiagnostic,
        isActive: () =>
          mountedRef.current && flowEpoch === flowEpochRef.current,
        onAuthenticated: () => {
          track("login_success", { provider: "phone" });
          window.dispatchEvent(new Event("aistory:account-changed"));
        },
        onPhoneProofSuccess: () => {
          track("login_success", { provider: "phone" });
          window.dispatchEvent(new Event("aistory:account-changed"));
          onSuccess();
        },
      });
      if (!mountedRef.current || flowEpoch !== flowEpochRef.current) return;
      if (result.kind === "inactive" || result.kind === "phone-proof") return;
      if (result.kind === "failed") {
        if (!mountedRef.current) return;
        const diagnostic: PhoneOtpVerifyDiagnostic = {
          stage: result.stage,
          reason: result.reason,
        };
        reportPhoneVerifyDiagnostic(diagnostic);
        setVerifyDiagnostic(diagnostic);
        setError(SAFE_AUTH_PROMPTS.serviceUnavailable);
        return;
      }
      if (result.kind === "rejected") {
        setVerifyDiagnostic({ stage: "response" });
        const message = mapPhoneVerifyFailure({
          status: result.status,
          code: result.code,
        });
        if (result.code === "OTP_INVALID_OR_EXPIRED") {
          resetPhoneFlow(true);
          setVerifyDiagnostic({ stage: "response" });
        }
        setError(message);
        return;
      }
      if (result.kind === "invalid-account") {
        setVerifyDiagnostic({ stage: "response" });
        setError(SAFE_AUTH_PROMPTS.serviceUnavailable);
        return;
      }
      setClaimResult(result.claim);
      if (result.localClaim) setLocalClaim(result.localClaim);
      if (result.claimApplyFailed) setClaimApplyFailed(true);
      setStep("claim-result");
    } catch {
      if (mountedRef.current && flowEpoch === flowEpochRef.current) {
        const diagnostic: PhoneOtpVerifyDiagnostic = {
          stage: "unexpected",
          reason: "uncaught",
        };
        reportPhoneVerifyDiagnostic(diagnostic);
        setVerifyDiagnostic(diagnostic);
        setError(SAFE_AUTH_PROMPTS.serviceUnavailable);
      }
    } finally {
      if (flowEpoch === flowEpochRef.current) {
        verifyInFlightRef.current = false;
        if (mountedRef.current) setVerifyingOtp(false);
      }
    }
  }, [
    getClaimPreparation,
    onSuccess,
    otp,
    phone,
    phoneChallengeExpiresAt,
    phoneChallengeId,
    phoneProofOnly,
    resetPhoneFlow,
  ]);

  const sendCodeLabel = sendingOtp
    ? t("auth.sending")
    : cooldownRemaining > 0
      ? t("auth.resendCountdown", { seconds: cooldownRemaining })
      : hasRequestedCode
        ? t("auth.resendCode")
        : t("auth.sendCode");

  // Render nothing during SSR/first client paint; the portal is only created
  // after the mount effect has run and document.body is available.
  if (!hasMounted || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        boxSizing: "border-box",
        overflowX: "hidden",
        overflowY: "auto",
        WebkitOverflowScrolling: "touch",
        padding:
          "calc(env(safe-area-inset-top, 0px) + 16px) calc(env(safe-area-inset-right, 0px) + 16px) calc(env(safe-area-inset-bottom, 0px) + 16px) calc(env(safe-area-inset-left, 0px) + 16px)",
        background: "rgba(0,0,0,0.55)",
      }}
      onClick={(event) => {
        event.stopPropagation();
        handleClose();
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div
        ref={dialogRef}
        className="ui-surface flex w-full max-w-sm flex-col overflow-hidden rounded-lg shadow-[0_20px_70px_rgba(1,5,17,0.24)]"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        style={{
          backdropFilter: "blur(14px)",
          WebkitBackdropFilter: "blur(14px)",
          maxHeight:
            "calc(100dvh - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px) - 32px)",
          minHeight: 0,
          margin: "auto",
          outline: "none",
        }}
        role="dialog"
        aria-modal="true"
        aria-label={t("auth.ariaLabel")}
        tabIndex={-1}
      >
        {/* header */}
        <div className="flex shrink-0 items-center justify-between border-b border-clay-900/10 px-5 py-3.5">
          <div className="flex items-center gap-2 text-[11px] smallcaps text-clay-600">
            <i className="fa-solid fa-right-to-bracket text-[11px]" />
            {t("auth.steps.phone")}
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="flex h-11 w-11 items-center justify-center rounded-md text-clay-500 transition-colors hover:text-ember-500"
            style={{ minHeight: 44, minWidth: 44 }}
            aria-label={t("auth.close")}
          >
            <i className="fa-solid fa-xmark text-[12px]" />
          </button>
        </div>

        <div
          className="px-5 py-5 space-y-3"
          style={{
            flex: "1 1 auto",
            minHeight: 0,
            overflowY: "auto",
            overflowX: "hidden",
            overscrollBehavior: "contain",
            WebkitOverflowScrolling: "touch",
          }}
        >
          {!requirement && !phoneProofOnly && step === "phone-input" && (
            <LinghaoPassportV4LoginBoundary>
              <AiUserLoginButton />
            </LinghaoPassportV4LoginBoundary>
          )}
          {requirement && step !== "claim-result" && (
            <div className="rounded-md border border-ember-500/25 bg-ember-500/[0.07] px-3 py-2.5">
              <p className="text-[12px] font-medium text-ember-500">
                {t("auth.platformCostTitle")}
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-clay-600">
                {requirement.quote
                  ? t("auth.platformCostDetail", {
                      credits: requirement.quote.estimatedCredits.toLocaleString(),
                      version: requirement.quote.pricePolicyVersion,
                    })
                  : requirementPrompt ?? SAFE_AUTH_PROMPTS.loginRequired}
              </p>
            </div>
          )}
          {error && step !== "claim-result" && (
            <p
              className="text-[12px] text-red-400/90 leading-snug"
              data-auth-verify-stage={verifyDiagnostic?.stage}
              data-auth-verify-reason={verifyDiagnostic?.reason}
            >
              {error}
            </p>
          )}

          {step === "phone-input" && (
            <>
              <div className="space-y-1.5 pr-2">
                <h2 className="text-[16px] font-medium text-clay-900">
                  {t("auth.phoneLogin")}
                </h2>
                <p className="text-[12px] leading-relaxed text-clay-600">
                  {t("auth.registrationHint")}
                </p>
                <p className="text-[11px] leading-relaxed text-clay-500">
                  {t("auth.localProgressHint")}
                </p>
              </div>
              <input
                ref={phoneInputRef}
                type="tel"
                disabled={sendingOtp}
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                onKeyDown={(event) =>
                  event.key === "Enter" && handleSendPhoneOtp()
                }
                placeholder={t("auth.phonePlaceholder")}
                autoComplete="tel"
                className="ui-input w-full rounded-md px-3.5 py-2.5 text-[13px]"
              />
              <button
                type="button"
                disabled={
                  sendingOtp || cooldownRemaining > 0 || !phone.trim()
                }
                onClick={handleSendPhoneOtp}
                className="ui-button-primary w-full rounded-md px-4 py-2.5 text-[13px] font-medium disabled:opacity-50"
              >
                {sendCodeLabel}
              </button>
              {process.env.NODE_ENV !== "production" && (
                <p className="text-[11px] leading-relaxed text-clay-500">
                  {t("auth.localSmsHint")}
                </p>
              )}
            </>
          )}

          {step === "phone-verify" && (
            <>
              <p className="text-[12px] leading-snug text-clay-600">
                {t("auth.phoneCodeSent", { phone: maskedPhone })}
              </p>
              <input
                ref={otpInputRef}
                type="text"
                inputMode="numeric"
                maxLength={6}
                value={otp}
                onChange={(event) =>
                  setOtp(event.target.value.replace(/\D/g, ""))
                }
                onKeyDown={(event) =>
                  event.key === "Enter" && handleVerifyPhoneOtp()
                }
                placeholder={t("auth.codePlaceholder")}
                autoComplete="one-time-code"
                className="ui-input w-full rounded-md px-3.5 py-2.5 text-center text-[16px] tracking-[0.35em] placeholder:tracking-normal"
              />
              <button
                type="button"
                disabled={verifyingOtp || otp.length < 6}
                onClick={handleVerifyPhoneOtp}
                className="ui-button-primary w-full rounded-md px-4 py-2.5 text-[13px] font-medium disabled:opacity-50"
              >
                {verifyingOtp ? t("auth.verifying") : t("auth.verify")}
              </button>
              <button
                type="button"
                disabled={sendingOtp || verifyingOtp || cooldownRemaining > 0}
                onClick={handleSendPhoneOtp}
                className="w-full rounded-md border border-clay-900/10 px-4 py-2 text-center text-[12px] text-clay-600 transition-colors hover:border-ember-500/30 hover:text-ember-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {sendCodeLabel}
              </button>
              <button
                type="button"
                disabled={sendingOtp || verifyingOtp}
                onClick={() => {
                  resetPhoneFlow(true);
                }}
                className="w-full text-center text-[12px] text-clay-500 transition-colors hover:text-ember-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t("auth.changePhone")}
              </button>
            </>
          )}

          {step === "claim-result" && (
            <>
              <div className="space-y-1.5">
                <h2 className="text-[16px] font-medium text-clay-900">
                  {t("auth.claimCompleteTitle")}
                </h2>
                <p className="text-[12px] leading-relaxed text-clay-600">
                  {!claimResult || claimResult.status === "not_found"
                    ? t("auth.claimNotFound")
                    : t("auth.claimSummary", {
                        stories:
                          localClaim?.migratedStories ??
                          claimResult.counts.inheritedStories,
                        checkpoints:
                          claimResult.counts.inheritedCheckpoints,
                        skipped: claimResult.counts.skipped,
                      })}
                </p>
                {claimSkipReasonText && (
                  <p className="text-[11px] leading-relaxed text-clay-500">
                    {t("auth.claimSkipReasonSummary", {
                      reasons: claimSkipReasonText,
                    })}
                  </p>
                )}
                {claimApplyFailed && (
                  <p className="text-[11px] leading-relaxed text-ember-500">
                    {t("auth.claimRetryHint")}
                  </p>
                )}
                <p className="text-[11px] leading-relaxed text-clay-500">
                  {t("auth.sameBrowserOnly")}
                </p>
              </div>
              <button
                ref={continueButtonRef}
                type="button"
                onClick={onSuccess}
                className="ui-button-primary w-full rounded-md px-4 py-2.5 text-[13px] font-medium"
              >
                {t("auth.continue")}
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
