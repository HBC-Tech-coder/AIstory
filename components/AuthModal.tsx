"use client";

import { useCallback, useEffect, useState } from "react";
import { track } from "@/lib/analytics";
import { useI18n } from "@/lib/i18n/client";

type AuthStep = "phone-input" | "phone-verify";

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
}: {
  onClose: () => void;
  onSuccess: () => void;
  requirement?: AuthRequirement;
}) {
  const [step, setStep] = useState<AuthStep>("phone-input");
  const [otp, setOtp] = useState("");
  const [phone, setPhone] = useState("");
  const [phoneChallengeId, setPhoneChallengeId] = useState("");
  const [maskedPhone, setMaskedPhone] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const { t } = useI18n();

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const handleSendPhoneOtp = useCallback(async () => {
    const trimmed = phone.trim();
    if (!trimmed) return;
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/auth/phone/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: trimmed }),
      });
      const result = await response.json() as {
        error?: string;
        code?: string;
        challengeId?: string;
        maskedPhone?: string;
      };
      if (!response.ok || !result.challengeId) {
        if (result.code === "PHONE_INVALID") {
          setError(t("auth.phoneInvalid"));
        } else if (result.code === "SMS_RATE_LIMITED") {
          setError(t("auth.smsRateLimited"));
        } else {
          setError(t("auth.smsUnavailable"));
        }
        return;
      }
      setPhoneChallengeId(result.challengeId);
      setMaskedPhone(result.maskedPhone || trimmed);
      setStep("phone-verify");
    } catch {
      setError(t("auth.smsUnavailable"));
    } finally {
      setLoading(false);
    }
  }, [phone, t]);

  const handleVerifyPhoneOtp = useCallback(async () => {
    if (!phoneChallengeId || otp.length !== 6) return;
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/auth/phone/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone: phone.trim(),
          challengeId: phoneChallengeId,
          code: otp,
        }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) {
        setError(result.error || "验证码无效或已过期。");
        return;
      }
      track("login_success", { provider: "phone" });
      window.dispatchEvent(new Event("aistory:account-changed"));
      onSuccess();
    } catch {
      setError("手机号登录暂时不可用。");
    } finally {
      setLoading(false);
    }
  }, [onSuccess, otp, phone, phoneChallengeId]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      style={{ background: "rgba(0,0,0,0.55)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "rgba(14, 10, 6, 0.92)",
          border: "1.5px solid rgba(175, 138, 72, 0.72)",
          borderRadius: "8px",
          backdropFilter: "blur(14px)",
          WebkitBackdropFilter: "blur(14px)",
          boxShadow:
            "0 10px 42px rgba(0,0,0,0.62), inset 0 1px 0 rgba(200,165,90,0.12)",
        }}
        role="dialog"
        aria-modal="true"
        aria-label={t("auth.ariaLabel")}
      >
        {/* header */}
        <div className="flex items-center justify-between border-b border-cream-50/10 px-5 py-3.5">
          <div className="flex items-center gap-2 text-[11px] smallcaps text-cream-50/70">
            <i className="fa-solid fa-right-to-bracket text-[11px]" />
            {t("auth.steps.phone")}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center text-cream-50/60 transition-colors hover:text-cream-50"
            aria-label={t("auth.close")}
          >
            <i className="fa-solid fa-xmark text-[12px]" />
          </button>
        </div>

        <div className="px-5 py-5 space-y-3">
          {requirement && (
            <div className="rounded-md border border-amber-300/35 bg-amber-200/[0.08] px-3 py-2.5">
              <p className="text-[12px] font-medium text-amber-200">
                {t("auth.platformCostTitle")}
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-cream-50/65">
                {requirement.quote
                  ? t("auth.platformCostDetail", {
                      credits: requirement.quote.estimatedCredits.toLocaleString(),
                      version: requirement.quote.pricePolicyVersion,
                    })
                  : requirement.message}
              </p>
            </div>
          )}
          {error && (
            <p className="text-[12px] text-red-400/90 leading-snug">{error}</p>
          )}

          {step === "phone-input" && (
            <>
              <div className="space-y-1.5 pr-2">
                <h2 className="text-[16px] font-medium text-cream-50">
                  {t("auth.phoneLogin")}
                </h2>
                <p className="text-[12px] leading-relaxed text-cream-50/60">
                  {t("auth.registrationHint")}
                </p>
              </div>
              <input
                type="tel"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                onKeyDown={(event) =>
                  event.key === "Enter" && handleSendPhoneOtp()
                }
                placeholder={t("auth.phonePlaceholder")}
                autoComplete="tel"
                autoFocus
                className="w-full rounded-md border border-cream-50/15 bg-cream-50/[0.06] px-3.5 py-2.5 text-[13px] text-cream-50/90 placeholder:text-cream-50/30 outline-none focus:border-[rgba(175,138,72,0.6)]"
              />
              <button
                type="button"
                disabled={loading || !phone.trim()}
                onClick={handleSendPhoneOtp}
                className="w-full rounded-md bg-[rgba(175,138,72,0.85)] px-4 py-2.5 text-[13px] font-medium text-cream-50 transition-colors hover:bg-[rgba(175,138,72,1)] disabled:opacity-50"
              >
                {loading ? t("auth.sending") : t("auth.sendCode")}
              </button>
              {process.env.NODE_ENV !== "production" && (
                <p className="text-[11px] leading-relaxed text-cream-50/45">
                  {t("auth.localSmsHint")}
                </p>
              )}
            </>
          )}

          {step === "phone-verify" && (
            <>
              <p className="text-[12px] leading-snug text-cream-50/60">
                {t("auth.phoneCodeSent", { phone: maskedPhone })}
              </p>
              <input
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
                autoFocus
                className="w-full rounded-md border border-cream-50/15 bg-cream-50/[0.06] px-3.5 py-2.5 text-center text-[16px] tracking-[0.35em] text-cream-50/90 placeholder:text-cream-50/30 placeholder:tracking-normal outline-none focus:border-[rgba(175,138,72,0.6)]"
              />
              <button
                type="button"
                disabled={loading || otp.length < 6}
                onClick={handleVerifyPhoneOtp}
                className="w-full rounded-md bg-[rgba(175,138,72,0.85)] px-4 py-2.5 text-[13px] font-medium text-cream-50 transition-colors hover:bg-[rgba(175,138,72,1)] disabled:opacity-50"
              >
                {loading ? t("auth.verifying") : t("auth.verify")}
              </button>
              <button
                type="button"
                onClick={() => {
                  setStep("phone-input");
                  setOtp("");
                  setError("");
                }}
                className="w-full text-center text-[12px] text-cream-50/50 transition-colors hover:text-cream-50/80"
              >
                {t("auth.resend")}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
