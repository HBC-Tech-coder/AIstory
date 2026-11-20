import "server-only";

import Credential, {
  EnvironmentVariableCredentialsProvider,
} from "@alicloud/credentials";
import Dysmsapi20170525, {
  SendSmsRequest,
} from "@alicloud/dysmsapi20170525";
import { Config as OpenApiConfig } from "@alicloud/openapi-client";
import { RuntimeOptions } from "@alicloud/tea-util";

import {
  PhoneAuthError,
  type SmsVerificationProvider,
} from "./smsProvider";
import { PHONE_OTP_COOLDOWN_SECONDS } from "./phoneOtpPolicy";

export const ALIYUN_SMS_API_VERSION = "2017-05-25";
export const ALIYUN_SMS_DEFAULT_ENDPOINT = "dysmsapi.aliyuncs.com";
export const ALIYUN_SMS_DEFAULT_REGION = "cn-hangzhou";
const DEFAULT_CONNECT_TIMEOUT_MS = 3_000;
const DEFAULT_READ_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 30_000;
const TEMPLATE_PARAM_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const TEMPLATE_CODE_PATTERN = /^SMS_[A-Za-z0-9]{4,64}$/;
const DOMESTIC_PHONE_PATTERN = /^\+86(1\d{10})$/;
const OTP_PATTERN = /^\d{6}$/;
const SAFE_PROVIDER_CODE = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const SAFE_REQUEST_ID = /^(?=.*[A-Za-z])[A-Za-z0-9_.:-]{8,128}$/;
const RATE_LIMIT_CODE_PATTERN =
  /(THROTTL|RATE|FREQUENCY|BUSINESS_LIMIT_CONTROL|QUOTA)/i;
const REGION_PATTERN = /^cn-[a-z0-9-]{2,32}$/;

type Env = Record<string, string | undefined>;

type AliyunSmsConfig = {
  endpoint: string;
  region: string;
  signName: string;
  templateCode: string;
  templateParamName: string;
  connectTimeoutMs: number;
  readTimeoutMs: number;
};

export type AliyunSmsTransportInput = {
  phoneNumbers: string;
  signName: string;
  templateCode: string;
  templateParam: string;
};

export type AliyunSmsTransportResult = {
  code?: string;
  requestId?: string;
};

export interface AliyunSmsTransport {
  sendSms(input: AliyunSmsTransportInput): Promise<AliyunSmsTransportResult>;
}

export type AliyunSmsDiagnostic = {
  outcome: "sent" | "rate_limited" | "unavailable";
  providerCode?: string;
  requestId?: string;
  durationMs: number;
};

function unavailable(): PhoneAuthError {
  return new PhoneAuthError(
    "SMS_PROVIDER_UNAVAILABLE",
    503,
    "短信服务暂时不可用，请稍后再试。",
  );
}

function rateLimited(): PhoneAuthError {
  return new PhoneAuthError(
    "SMS_RATE_LIMITED",
    429,
    "验证码请求过于频繁，请稍后再试。",
    PHONE_OTP_COOLDOWN_SECONDS,
  );
}

function parseTimeout(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 500 || parsed > MAX_TIMEOUT_MS) {
    return fallback;
  }
  return parsed;
}

function validSignName(value: string): boolean {
  return (
    value.length >= 1
    && value.length <= 70
    && !/[\u0000-\u001F\u007F]/.test(value)
  );
}

function readConfig(env: Env): AliyunSmsConfig | undefined {
  const accessKeyId = env.ALIBABA_CLOUD_ACCESS_KEY_ID?.trim();
  const accessKeySecret = env.ALIBABA_CLOUD_ACCESS_KEY_SECRET?.trim();
  const endpoint =
    env.ALIYUN_SMS_ENDPOINT?.trim() || ALIYUN_SMS_DEFAULT_ENDPOINT;
  const region = env.ALIYUN_SMS_REGION?.trim() || ALIYUN_SMS_DEFAULT_REGION;
  const signName = env.ALIYUN_SMS_SIGN_NAME?.trim();
  const templateCode = env.ALIYUN_SMS_TEMPLATE_CODE_LOGIN?.trim();
  const templateParamName =
    env.ALIYUN_SMS_TEMPLATE_PARAM_CODE_KEY?.trim() || "code";
  if (
    !accessKeyId
    || !accessKeySecret
    || endpoint !== ALIYUN_SMS_DEFAULT_ENDPOINT
    || !REGION_PATTERN.test(region)
    || !signName
    || !templateCode
    || !validSignName(signName)
    || !TEMPLATE_CODE_PATTERN.test(templateCode)
    || !TEMPLATE_PARAM_NAME_PATTERN.test(templateParamName)
  ) {
    return undefined;
  }
  return {
    endpoint,
    region,
    signName,
    templateCode,
    templateParamName,
    connectTimeoutMs: parseTimeout(
      env.ALIYUN_SMS_CONNECT_TIMEOUT_MS,
      DEFAULT_CONNECT_TIMEOUT_MS,
    ),
    readTimeoutMs: parseTimeout(
      env.ALIYUN_SMS_READ_TIMEOUT_MS,
      DEFAULT_READ_TIMEOUT_MS,
    ),
  };
}

function safeDiagnosticToken(
  value: unknown,
  pattern: RegExp,
  sensitive: string[],
): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (
    !pattern.test(normalized)
    || sensitive.some((item) => item && normalized.includes(item))
  ) {
    return undefined;
  }
  return normalized;
}

function errorFacts(error: unknown, sensitive: string[]): {
  providerCode?: string;
  requestId?: string;
  rateLimited: boolean;
} {
  if (!error || typeof error !== "object") {
    return { rateLimited: false };
  }
  const value = error as {
    code?: unknown;
    statusCode?: unknown;
    requestId?: unknown;
    data?: Record<string, unknown>;
  };
  const providerCode = safeDiagnosticToken(
    value.code ?? value.data?.Code ?? value.data?.code,
    SAFE_PROVIDER_CODE,
    sensitive,
  );
  const requestId = safeDiagnosticToken(
    value.requestId ?? value.data?.RequestId ?? value.data?.requestId,
    SAFE_REQUEST_ID,
    sensitive,
  );
  return {
    providerCode,
    requestId,
    rateLimited:
      value.statusCode === 429
      || Boolean(providerCode && RATE_LIMIT_CODE_PATTERN.test(providerCode)),
  };
}

function emitDiagnostic(
  listener: ((event: AliyunSmsDiagnostic) => void) | undefined,
  event: AliyunSmsDiagnostic,
): void {
  try {
    listener?.(event);
  } catch {
    // Diagnostics must never alter authentication behavior.
  }
}

function createSdkTransport(config: AliyunSmsConfig): AliyunSmsTransport {
  const credentialProvider =
    EnvironmentVariableCredentialsProvider.builder().build();
  const credential = new Credential(null, credentialProvider);
  const clientConfig = new OpenApiConfig({
    credential,
    endpoint: config.endpoint,
    regionId: config.region,
    protocol: "https",
    connectTimeout: config.connectTimeoutMs,
    readTimeout: config.readTimeoutMs,
  });
  const client = new Dysmsapi20170525(clientConfig);
  const runtime = new RuntimeOptions({
    autoretry: false,
    maxAttempts: 1,
    connectTimeout: config.connectTimeoutMs,
    readTimeout: config.readTimeoutMs,
  });
  return {
    async sendSms(input): Promise<AliyunSmsTransportResult> {
      const response = await client.sendSmsWithOptions(
        new SendSmsRequest(input),
        runtime,
      );
      return {
        code: response.body?.code,
        requestId: response.body?.requestId,
      };
    },
  };
}

export function createAliyunSmsProvider(input: {
  env?: Env;
  transport?: AliyunSmsTransport;
  onDiagnostic?: (event: AliyunSmsDiagnostic) => void;
} = {}): SmsVerificationProvider {
  const env = input.env ?? process.env;
  const config = readConfig(env);
  let sdkTransport: AliyunSmsTransport | undefined;
  return {
    id: "aliyun_dysms",
    available: Boolean(config),
    async sendVerificationCode(request): Promise<void> {
      if (!config) throw unavailable();
      const domesticPhone = DOMESTIC_PHONE_PATTERN.exec(request.phone)?.[1];
      if (!domesticPhone) {
        throw new PhoneAuthError(
          "PHONE_INVALID",
          400,
          "当前短信登录仅支持中国大陆手机号。",
        );
      }
      if (!OTP_PATTERN.test(request.code)) throw unavailable();
      const startedAt = Date.now();
      const sensitive = [
        domesticPhone,
        request.phone,
        request.code,
        config.signName,
        config.templateCode,
      ];
      try {
        sdkTransport ??= input.transport ?? createSdkTransport(config);
        const result = await sdkTransport.sendSms({
          phoneNumbers: domesticPhone,
          signName: config.signName,
          templateCode: config.templateCode,
          templateParam: JSON.stringify({
            [config.templateParamName]: request.code,
          }),
        });
        const providerCode = safeDiagnosticToken(
          result.code,
          SAFE_PROVIDER_CODE,
          sensitive,
        );
        const requestId = safeDiagnosticToken(
          result.requestId,
          SAFE_REQUEST_ID,
          sensitive,
        );
        if (result.code !== "OK") {
          const isRateLimited = Boolean(
            providerCode && RATE_LIMIT_CODE_PATTERN.test(providerCode),
          );
          emitDiagnostic(input.onDiagnostic, {
            outcome: isRateLimited ? "rate_limited" : "unavailable",
            providerCode,
            requestId,
            durationMs: Date.now() - startedAt,
          });
          throw isRateLimited ? rateLimited() : unavailable();
        }
        emitDiagnostic(input.onDiagnostic, {
          outcome: "sent",
          providerCode: "OK",
          requestId,
          durationMs: Date.now() - startedAt,
        });
      } catch (error) {
        if (error instanceof PhoneAuthError) throw error;
        const facts = errorFacts(error, sensitive);
        emitDiagnostic(input.onDiagnostic, {
          outcome: facts.rateLimited ? "rate_limited" : "unavailable",
          providerCode: facts.providerCode,
          requestId: facts.requestId,
          durationMs: Date.now() - startedAt,
        });
        throw facts.rateLimited ? rateLimited() : unavailable();
      }
    },
  };
}
