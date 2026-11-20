/**
 * Presentation-safe helpers for the auth modal.
 *
 * These helpers deliberately never return raw server text, status text
 * (for example "Unauthorized"), or internal error codes. Callers can render
 * the returned strings directly to players.
 */

export type AuthRequirementPresentationInput = {
  message?: unknown;
  quote?: {
    estimatedCredits?: unknown;
    pricePolicyVersion?: unknown;
    modalities?: unknown;
  } | null;
};

export const SAFE_AUTH_PROMPTS = {
  loginRequired: "请先登录后继续。",
  invalidCode: "验证码无效或已过期，请重新获取。",
  rateLimited: "操作过于频繁，请稍后再试。",
  serviceUnavailable: "登录服务暂时不可用，请稍后再试。",
  phoneInvalid: "请输入有效的手机号。",
} as const;

export type SafeAuthPrompt =
  (typeof SAFE_AUTH_PROMPTS)[keyof typeof SAFE_AUTH_PROMPTS];

const INVALID_CODE_CODES = new Set([
  "INVALID_CODE",
  "INVALID_OTP",
  "OTP_INVALID",
  "PHONE_CODE_INVALID",
  "PHONE_OTP_INVALID",
  "VERIFICATION_CODE_INVALID",
  "CODE_INVALID",
  "CODE_MISMATCH",
  "WRONG_CODE",
  "OTP_MISMATCH",
  "PHONE_VERIFY_CODE_INVALID",
  "PHONE_OTP_CODE_INVALID",
  "OTP_INVALID_OR_EXPIRED",
]);

const INVALID_PHONE_CODES = new Set([
  "PHONE_INVALID",
  "INVALID_PHONE",
  "PHONE_NUMBER_INVALID",
]);

const RATE_LIMIT_CODES = new Set([
  "SMS_RATE_LIMITED",
  "RATE_LIMITED",
  "TOO_MANY_REQUESTS",
  "PHONE_OTP_RATE_LIMITED",
  "OTP_RATE_LIMITED",
  "PHONE_RATE_LIMITED",
]);

const SERVICE_UNAVAILABLE_STATUSES = new Set([403, 404, 408, 413, 425]);

const INVALID_CODE_STATUSES = new Set([400, 401, 409, 422]);

/**
 * Normalizes server-provided error code strings for safe lookup only. The
 * normalized value is never rendered.
 */
export function normalizeAuthErrorCode(code: unknown): string {
  if (typeof code !== "string") return "";
  return code.trim().toUpperCase().replace(/[\s-]+/g, "_");
}

export function hasRequirementQuote(
  requirement: AuthRequirementPresentationInput | null | undefined,
): boolean {
  return Boolean(
    requirement
      && requirement.quote
      && typeof requirement.quote === "object",
  );
}

/**
 * Returns the safe copy for a requirement that has no price quote. A quote
 * requirement returns null because its text is composed from trusted i18n
 * keys by the caller. requirement.message is intentionally ignored because
 * it can contain arbitrary server text or internal codes.
 */
export function resolveAuthRequirementMessage(
  requirement: AuthRequirementPresentationInput | null | undefined,
): string | null {
  if (!requirement) return null;
  if (hasRequirementQuote(requirement)) return null;
  return SAFE_AUTH_PROMPTS.loginRequired;
}

/**
 * Maps a failed phone verification response to safe player-facing copy.
 * Rate limiting and service failures are reported separately, and unknown
 * payload text (including "Unauthorized") is never echoed.
 */
export function mapPhoneVerifyFailure(
  input: { status?: unknown; code?: unknown } = {},
): SafeAuthPrompt {
  const status =
    typeof input.status === "number" && Number.isFinite(input.status)
      ? input.status
      : 0;
  const code = normalizeAuthErrorCode(input.code);

  if (status === 429 || RATE_LIMIT_CODES.has(code)) {
    return SAFE_AUTH_PROMPTS.rateLimited;
  }
  if (INVALID_CODE_CODES.has(code)) {
    return SAFE_AUTH_PROMPTS.invalidCode;
  }
  if (INVALID_PHONE_CODES.has(code)) {
    return SAFE_AUTH_PROMPTS.phoneInvalid;
  }
  if (status >= 500 || SERVICE_UNAVAILABLE_STATUSES.has(status)) {
    return SAFE_AUTH_PROMPTS.serviceUnavailable;
  }
  if (INVALID_CODE_STATUSES.has(status) || (status >= 400 && status < 500)) {
    return SAFE_AUTH_PROMPTS.invalidCode;
  }
  return SAFE_AUTH_PROMPTS.serviceUnavailable;
}
