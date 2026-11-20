import "server-only";

export type SmsProviderId = "local_mock" | "aliyun_dysms";

export interface SmsVerificationProvider {
  readonly id: SmsProviderId;
  readonly available: boolean;
  sendVerificationCode(input: {
    phone: string;
    code: string;
    expiresInSeconds: number;
  }): Promise<void>;
}

export type PhoneAuthErrorCode =
  | "PHONE_INVALID"
  | "SMS_PROVIDER_UNAVAILABLE"
  | "SMS_RATE_LIMITED"
  | "OTP_INVALID_OR_EXPIRED"
  | "PHONE_AUTH_NOT_CONFIGURED";

export class PhoneAuthError extends Error {
  constructor(
    readonly code: PhoneAuthErrorCode,
    readonly status: number,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "PhoneAuthError";
  }
}
