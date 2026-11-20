export const COMPANY_ACCOUNT_SCHEMA_VERSION = 1 as const;
export const COMPANY_ACCOUNT_BRAND = "HarnessDesk" as const;
export const COMPANY_ACCOUNT_PRODUCT_ID = "harnessdesk-desktop" as const;
export const COMPANY_ACCOUNT_CLIENT_ID = "harnessdesk-windows" as const;
export const COMPANY_ACCOUNT_CHANNEL_ID = "harnessdesk-windows" as const;
export const COMPANY_ACCOUNT_AUDIENCE =
  "urn:hbc:company-account:harnessdesk-desktop" as const;

// This value is server-owned. No public parser accepts tenantId from a client.
export const COMPANY_ACCOUNT_SERVER_TENANT_ID = "platform" as const;

export const COMPANY_ACCOUNT_CLIENT_CONTEXT_KEYS = [
  "schemaVersion",
  "productId",
  "clientId",
  "audience",
  "channelId",
] as const;

export type CompanyAccountClientContext = {
  schemaVersion: typeof COMPANY_ACCOUNT_SCHEMA_VERSION;
  productId: typeof COMPANY_ACCOUNT_PRODUCT_ID;
  clientId: typeof COMPANY_ACCOUNT_CLIENT_ID;
  audience: typeof COMPANY_ACCOUNT_AUDIENCE;
  channelId: typeof COMPANY_ACCOUNT_CHANNEL_ID;
};

export const COMPANY_ACCOUNT_ERROR_CODES = [
  "INVALID_REQUEST",
  "UNSUPPORTED_CONTENT_TYPE",
  "BODY_TOO_LARGE",
  "ORIGIN_NOT_ALLOWED",
  "APP_NOT_ALLOWED",
  "SMS_RATE_LIMITED",
  "SMS_UNAVAILABLE",
  "OTP_INVALID_OR_EXPIRED",
  "ACCOUNT_UNAVAILABLE",
  "AUTH_REQUIRED",
  "SESSION_EXPIRED",
  "AUDIENCE_MISMATCH",
  "PRODUCT_FORBIDDEN",
  "PRODUCT_GRANT_UNAVAILABLE",
  "PRODUCT_PRICING_UNAVAILABLE",
  "IDEMPOTENCY_KEY_REQUIRED",
  "IDEMPOTENCY_CONFLICT",
  "INSUFFICIENT_CREDITS",
  "PROVIDER_UNAVAILABLE",
  "BILLING_OUTCOME_PENDING",
  "HOSTED_BYOK_UNAVAILABLE",
  "PAYMENTS_UNAVAILABLE",
  "SERVICE_UNAVAILABLE",
] as const;

export type CompanyAccountErrorCode =
  (typeof COMPANY_ACCOUNT_ERROR_CODES)[number];

const ERROR_MESSAGES: Readonly<Record<CompanyAccountErrorCode, string>> = {
  INVALID_REQUEST: "请求格式无效。",
  UNSUPPORTED_CONTENT_TYPE: "请求内容类型不受支持。",
  BODY_TOO_LARGE: "请求内容超过限制。",
  ORIGIN_NOT_ALLOWED: "请求来源不受允许。",
  APP_NOT_ALLOWED: "客户端应用不受允许。",
  SMS_RATE_LIMITED: "请求过于频繁，请稍后重试。",
  SMS_UNAVAILABLE: "短信服务暂不可用。",
  OTP_INVALID_OR_EXPIRED: "验证失败，请重新获取验证码。",
  ACCOUNT_UNAVAILABLE: "账号服务暂不可用。",
  AUTH_REQUIRED: "需要重新登录。",
  SESSION_EXPIRED: "会话已失效，请重新登录。",
  AUDIENCE_MISMATCH: "会话不适用于当前产品。",
  PRODUCT_FORBIDDEN: "当前产品未获授权。",
  PRODUCT_GRANT_UNAVAILABLE: "产品活动赠额暂不可用。",
  PRODUCT_PRICING_UNAVAILABLE: "产品计价暂不可用。",
  IDEMPOTENCY_KEY_REQUIRED: "缺少有效的幂等标识。",
  IDEMPOTENCY_CONFLICT: "幂等标识与已有请求冲突。",
  INSUFFICIENT_CREDITS: "可用积分不足。",
  PROVIDER_UNAVAILABLE: "模型能力暂不可用。",
  BILLING_OUTCOME_PENDING: "账务结果尚未确认。",
  HOSTED_BYOK_UNAVAILABLE: "托管凭据能力暂不可用。",
  PAYMENTS_UNAVAILABLE: "充值能力暂未开放。",
  SERVICE_UNAVAILABLE: "统一账号合同尚未开放。",
};

const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const PUBLIC_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SENSITIVE_ID_PATTERN =
  /(?:api[_-]?key|access[_-]?key|secret|token|password|cookie|phone|otp)/i;

export function readStrictRecord(
  input: unknown,
): Record<string, unknown> | null {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return null;
    }
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const record = input as Record<string, unknown>;
    const keys = Reflect.ownKeys(record);
    if (
      keys.some(
        (key) => typeof key !== "string" || DANGEROUS_KEYS.has(key),
      )
    ) {
      return null;
    }
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (!descriptor || !("value" in descriptor)) return null;
    }
    return record;
  } catch {
    return null;
  }
}

export function hasExactOwnKeys(
  record: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  try {
    const keys = Reflect.ownKeys(record);
    if (keys.some((key) => typeof key !== "string")) return false;
    const actual = (keys as string[]).sort();
    const expected = [...expectedKeys].sort();
    return (
      actual.length === expected.length &&
      actual.every((key, index) => key === expected[index])
    );
  } catch {
    return false;
  }
}

export function readOwnDataValue(
  record: Record<string, unknown>,
  key: string,
): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

export function isSafePublicId(
  value: unknown,
  minimumLength = 1,
  maximumLength = 128,
): value is string {
  return (
    typeof value === "string" &&
    value.length >= minimumLength &&
    value.length <= maximumLength &&
    PUBLIC_ID_PATTERN.test(value) &&
    !SENSITIVE_ID_PATTERN.test(value)
  );
}

export function isSafeCompanyAccountRequestId(value: unknown): value is string {
  return typeof value === "string" && /^ca1-[a-f0-9]{32}$/.test(value);
}

export function buildCompanyAccountClientContext(): CompanyAccountClientContext {
  return {
    schemaVersion: COMPANY_ACCOUNT_SCHEMA_VERSION,
    productId: COMPANY_ACCOUNT_PRODUCT_ID,
    clientId: COMPANY_ACCOUNT_CLIENT_ID,
    audience: COMPANY_ACCOUNT_AUDIENCE,
    channelId: COMPANY_ACCOUNT_CHANNEL_ID,
  };
}

export function parseCompanyAccountClientContext(
  input: unknown,
): CompanyAccountClientContext | null {
  const record = readStrictRecord(input);
  if (!record || !hasExactOwnKeys(record, COMPANY_ACCOUNT_CLIENT_CONTEXT_KEYS)) {
    return null;
  }
  if (
    readOwnDataValue(record, "schemaVersion") !==
      COMPANY_ACCOUNT_SCHEMA_VERSION ||
    readOwnDataValue(record, "productId") !== COMPANY_ACCOUNT_PRODUCT_ID ||
    readOwnDataValue(record, "clientId") !== COMPANY_ACCOUNT_CLIENT_ID ||
    readOwnDataValue(record, "audience") !== COMPANY_ACCOUNT_AUDIENCE ||
    readOwnDataValue(record, "channelId") !== COMPANY_ACCOUNT_CHANNEL_ID
  ) {
    return null;
  }
  return buildCompanyAccountClientContext();
}

export type CompanyAccountErrorDto = {
  error: {
    code: CompanyAccountErrorCode;
    message: string;
    requestId?: string;
    retryAfterSeconds?: number;
  };
};

export function buildCompanyAccountErrorDto(
  code: CompanyAccountErrorCode,
  options?: {
    requestId?: unknown;
    retryAfterSeconds?: unknown;
  },
): CompanyAccountErrorDto {
  const requestId = isSafeCompanyAccountRequestId(options?.requestId)
    ? options.requestId
    : undefined;
  const retryAfterSeconds =
    typeof options?.retryAfterSeconds === "number" &&
    Number.isSafeInteger(options.retryAfterSeconds) &&
    options.retryAfterSeconds >= 1 &&
    options.retryAfterSeconds <= 86_400
      ? options.retryAfterSeconds
      : undefined;
  return {
    error: {
      code,
      message: ERROR_MESSAGES[code],
      ...(requestId ? { requestId } : {}),
      ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
    },
  };
}

export const COMPANY_ACCOUNT_NO_STORE_HEADERS = Object.freeze({
  "Cache-Control": "no-store, private",
  Pragma: "no-cache",
  Vary: "Origin, Authorization, Cookie",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
});

type UnavailableCapability = {
  status: "unavailable";
  reasonCode:
    | "production_disabled"
    | "product_ledger_not_configured"
    | "hosted_byok_product_gate_missing"
    | "merchant_callback_not_verified";
};

export type CompanyAccountCapabilitiesDto = CompanyAccountClientContext & {
  brand: typeof COMPANY_ACCOUNT_BRAND;
  productionEnabled: false;
  capabilities: {
    unifiedLogin: UnavailableCapability;
    productGrant: UnavailableCapability;
    platformProxy: UnavailableCapability & {
      adapter: "deepseek";
    };
    hostedByok: UnavailableCapability;
    payments: UnavailableCapability;
    localContractTest: {
      status: "implemented";
      evidenceLevel: "E2_LOCAL_ZERO_NETWORK";
    };
  };
};

export function buildCompanyAccountCapabilities(): CompanyAccountCapabilitiesDto {
  return {
    ...buildCompanyAccountClientContext(),
    brand: COMPANY_ACCOUNT_BRAND,
    productionEnabled: false,
    capabilities: {
      unifiedLogin: {
        status: "unavailable",
        reasonCode: "production_disabled",
      },
      productGrant: {
        status: "unavailable",
        reasonCode: "product_ledger_not_configured",
      },
      platformProxy: {
        status: "unavailable",
        reasonCode: "production_disabled",
        adapter: "deepseek",
      },
      hostedByok: {
        status: "unavailable",
        reasonCode: "hosted_byok_product_gate_missing",
      },
      payments: {
        status: "unavailable",
        reasonCode: "merchant_callback_not_verified",
      },
      localContractTest: {
        status: "implemented",
        evidenceLevel: "E2_LOCAL_ZERO_NETWORK",
      },
    },
  };
}
