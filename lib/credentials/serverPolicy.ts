import "server-only";

import type { CredentialMode } from "./types";
import type { AiUserLinkedBillingPhoneUserId } from "@/lib/auth/aiUserLinkedBillingRepository";

export type CredentialAccessDecision =
  | { allowed: true; mode: "user_byok" }
  | { allowed: true; mode: "platform_managed"; billingUserId: string }
  | {
      allowed: false;
      mode: CredentialMode;
      status: 401 | 403;
      code:
        | "BYOK_REQUIRED"
        | "PLATFORM_MANAGED_DISABLED"
        | "PLATFORM_MANAGED_FORBIDDEN"
        | "PHONE_VERIFICATION_REQUIRED";
      message: string;
    };

type CredentialPolicyEnvironment = {
  AISTORY_PLATFORM_MANAGED_ENABLED?: string;
  AISTORY_PLATFORM_MANAGED_ALLOWLIST?: string;
  AISTORY_PLATFORM_BILLING_ENABLED?: string;
};

function readAllowlist(value: string | undefined): Set<string> {
  return new Set(
    (value || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

export function resolveCredentialMode(
  requestedMode: unknown,
  hasByok: boolean,
): CredentialMode {
  if (requestedMode === "user_byok" || requestedMode === "platform_managed") {
    return requestedMode;
  }
  return hasByok ? "user_byok" : "platform_managed";
}

export function authorizeCredentialAccess(input: {
  requestedMode?: unknown;
  hasByok: boolean;
  userId: string;
  authType: "anonymous" | "phone" | "supabase" | "aiuser" | "passport_v4";
  /** Server-resolved existing phone UUID for an explicitly linked AIUser. Never read from a request body. */
  verifiedLinkedPhoneUserId?: AiUserLinkedBillingPhoneUserId;
  env?: CredentialPolicyEnvironment;
}): CredentialAccessDecision {
  const mode = resolveCredentialMode(input.requestedMode, input.hasByok);
  if (mode === "user_byok") {
    return input.hasByok
      ? { allowed: true, mode }
      : {
          allowed: false,
          mode,
          status: 403,
          code: "BYOK_REQUIRED",
          message: "请先在“我的 API（BYOK）”中配置所需能力。",
        };
  }

  const env = input.env ?? process.env;
  if (input.authType === "passport_v4") {
    return {
      allowed: false,
      mode,
      status: 403,
      code: "PLATFORM_MANAGED_FORBIDDEN",
      message: "灵号通行证会话不读取或关联旧积分账户，请使用我的 API（BYOK）。",
    };
  }
  const linkedPhoneUserId = input.authType === "aiuser"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.verifiedLinkedPhoneUserId ?? "")
    ? input.verifiedLinkedPhoneUserId
    : undefined;
  const billingUserId = input.authType === "phone" && input.userId !== "anonymous"
    ? input.userId
    : linkedPhoneUserId;
  if (env.AISTORY_PLATFORM_BILLING_ENABLED === "true") {
    if (!billingUserId) {
      return {
        allowed: false,
        mode,
        status: 401,
        code: "PHONE_VERIFICATION_REQUIRED",
        message: "此操作将使用平台积分，请先完成手机号验证码登录。",
      };
    }
    return { allowed: true, mode, billingUserId };
  }

  if (env.AISTORY_PLATFORM_MANAGED_ENABLED !== "true") {
    return {
      allowed: false,
      mode,
      status: 403,
      code: "PLATFORM_MANAGED_DISABLED",
      message: "平台积分模式尚未开放，请使用我的 API（BYOK）。",
    };
  }

  const allowlist = readAllowlist(env.AISTORY_PLATFORM_MANAGED_ALLOWLIST);
  if (!billingUserId) {
    return {
      allowed: false,
      mode,
      status: 401,
      code: "PHONE_VERIFICATION_REQUIRED",
      message: "此操作将使用平台积分，请先完成手机号验证码登录。",
    };
  }
  if (!allowlist.has(billingUserId)) {
    return {
      allowed: false,
      mode,
      status: 403,
      code: "PLATFORM_MANAGED_FORBIDDEN",
      message: "当前账户不在平台积分内部测试范围。",
    };
  }
  return { allowed: true, mode, billingUserId };
}

export function hasByokPayload(value: unknown): boolean {
  return !!value
    && typeof value === "object"
    && Object.keys(value as Record<string, unknown>).length > 0;
}

export function assertCompleteByok(value: unknown): void {
  const byo = value as {
    text?: { apiKey?: unknown };
    image?: { apiKey?: unknown };
    vision?: { apiKey?: unknown };
  } | undefined;
  for (const modality of ["text", "image", "vision"] as const) {
    if (
      !byo?.[modality]
      || typeof byo[modality]?.apiKey !== "string"
      || !byo[modality]!.apiKey!.trim()
    ) {
      throw new Error(
        `Missing BYO configuration for ${modality}; platform fallback is disabled`,
      );
    }
  }
}
export function redactCredentialError(
  error: unknown,
  secrets: string[] = [],
): string {
  let raw = error instanceof Error ? error.message : String(error || "");
  for (const secret of secrets) {
    if (secret) raw = raw.split(secret).join("[REDACTED]");
  }
  return raw
    .replace(/(?:sk|tp)-[A-Za-z0-9_-]{6,}/g, "[REDACTED]")
    .replace(
      /(api[_-]?key|authorization|x-api-key)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[REDACTED]",
    )
    .replace(/[?&](?:key|api_key|token)=[^&\s]+/gi, "")
    .slice(0, 300) || "Credential request failed";
}

export function coercePublicPrefetchDepth(value: unknown): 0 | 1 {
  return Number(value) === 0 ? 0 : 1;
}
