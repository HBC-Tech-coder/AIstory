export const PHONE_OTP_COOLDOWN_SECONDS = 60;
export const PHONE_OTP_MAX_RETRY_AFTER_SECONDS = 60 * 60;

export function normalizePhoneOtpRetryAfterSeconds(
  value: unknown,
  fallback = PHONE_OTP_COOLDOWN_SECONDS,
): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    const fallbackNumber = Number(fallback);
    return Number.isFinite(fallbackNumber) && fallbackNumber > 0
      ? Math.min(
          PHONE_OTP_MAX_RETRY_AFTER_SECONDS,
          Math.max(1, Math.ceil(fallbackNumber)),
        )
      : PHONE_OTP_COOLDOWN_SECONDS;
  }
  return Math.min(
    PHONE_OTP_MAX_RETRY_AFTER_SECONDS,
    Math.max(1, Math.ceil(parsed)),
  );
}
