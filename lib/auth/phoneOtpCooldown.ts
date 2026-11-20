import {
  PHONE_OTP_COOLDOWN_SECONDS,
  PHONE_OTP_MAX_RETRY_AFTER_SECONDS,
  normalizePhoneOtpRetryAfterSeconds,
} from "./phoneOtpPolicy";

export const PHONE_OTP_COOLDOWN_STORAGE_KEY =
  "aistory.phone-otp.cooldown-deadline.v1";
export const PHONE_OTP_COOLDOWN_EVENT = "aistory:phone-otp-cooldown";

export type PhoneOtpCooldownStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function phoneOtpCooldownSecondsRemaining(
  deadline: number,
  now = Date.now(),
): number {
  if (!Number.isFinite(deadline) || !Number.isFinite(now)) return 0;
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

export function resolvePhoneOtpRetryAfterSeconds(
  payload: unknown,
  retryAfterHeader: string | null,
  now = Date.now(),
): number {
  const data = record(payload);
  const structured = data?.retryAfterSeconds ?? data?.retryAfter;
  if (structured !== undefined) {
    return normalizePhoneOtpRetryAfterSeconds(structured);
  }
  if (retryAfterHeader?.trim()) {
    const numeric = Number(retryAfterHeader);
    if (Number.isFinite(numeric) && numeric > 0) {
      return normalizePhoneOtpRetryAfterSeconds(numeric);
    }
    const timestamp = Date.parse(retryAfterHeader);
    if (Number.isFinite(timestamp) && timestamp > now) {
      return normalizePhoneOtpRetryAfterSeconds((timestamp - now) / 1000);
    }
  }
  return PHONE_OTP_COOLDOWN_SECONDS;
}

export function readPhoneOtpCooldownDeadline(
  storage: PhoneOtpCooldownStorage,
  now = Date.now(),
): number {
  try {
    const deadline = Number(storage.getItem(PHONE_OTP_COOLDOWN_STORAGE_KEY));
    if (!Number.isSafeInteger(deadline) || deadline <= now) {
      storage.removeItem(PHONE_OTP_COOLDOWN_STORAGE_KEY);
      return 0;
    }
    const maximumDeadline = now + PHONE_OTP_MAX_RETRY_AFTER_SECONDS * 1000;
    if (deadline > maximumDeadline) {
      storage.removeItem(PHONE_OTP_COOLDOWN_STORAGE_KEY);
      return 0;
    }
    return deadline;
  } catch {
    return 0;
  }
}

export function storePhoneOtpCooldownDeadline(
  storage: PhoneOtpCooldownStorage,
  seconds: unknown,
  now = Date.now(),
): number {
  const candidate =
    now + normalizePhoneOtpRetryAfterSeconds(seconds) * 1000;
  const existing = readPhoneOtpCooldownDeadline(storage, now);
  const deadline = Math.max(existing, candidate);
  try {
    storage.setItem(PHONE_OTP_COOLDOWN_STORAGE_KEY, String(deadline));
  } catch {
    // Browser storage is an experience enhancement; the server gate is final.
  }
  return deadline;
}

export function clearExpiredPhoneOtpCooldown(
  storage: PhoneOtpCooldownStorage,
  deadline: number,
  now = Date.now(),
): void {
  if (phoneOtpCooldownSecondsRemaining(deadline, now) > 0) return;
  try {
    const stored = Number(storage.getItem(PHONE_OTP_COOLDOWN_STORAGE_KEY));
    if (!Number.isFinite(stored) || stored <= deadline) {
      storage.removeItem(PHONE_OTP_COOLDOWN_STORAGE_KEY);
    }
  } catch {
    // Ignore unavailable browser storage; the server gate remains authoritative.
  }
}
