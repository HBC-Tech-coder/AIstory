export const CREDIT_CARD_SCHEMA_VERSION = "aistory.credit-card.v1" as const;
export const CREDIT_CARD_RUNTIME_SCHEMA_VERSION =
  "aistory.credit-card-runtime.v1" as const;
export const CREDIT_CARD_DATABASE_GATE_VERSION = "20260828234500" as const;

export const CREDIT_CARD_STATUS = Object.freeze({
  disabled: "DISABLED",
  ready: "READY",
} as const);

export const CREDIT_CARD_PUBLIC_ERROR = Object.freeze({
  unavailable: "CREDIT_CARD_UNAVAILABLE",
  invalidRequest: "CREDIT_CARD_INVALID_REQUEST",
  sessionRequired: "CREDIT_CARD_SESSION_REQUIRED",
  rateLimited: "CREDIT_CARD_RATE_LIMITED",
} as const);

const IDEMPOTENCY_PATTERN = /^ccr_[A-Za-z0-9_-]{24,96}$/;
const BATCH_ID_PATTERN = /^ccb_[A-Za-z0-9_-]{24,96}$/;
const CROCKFORD_PATTERN = /^[0-9A-HJKMNP-TV-Z]+$/;
const CARD_PAYLOAD_LENGTH = 26;
const PIN_LENGTH = 26;

export type CreditCardBatchState =
  | "pending_activation"
  | "active"
  | "disabled";

export type CreditCardBatchSummary = Readonly<{
  batchId: string;
  denominationCredits: number;
  quantity: number;
  redeemedCount: number;
  remainingCount: number;
  disabledCount: number;
  expiredCount: number;
  state: CreditCardBatchState;
  createdAt: string;
  expiresAt: string;
  activatedAt?: string;
  disabledAt?: string;
}>;

export type CreditCardAdminSnapshot = Readonly<{
  schemaVersion: typeof CREDIT_CARD_SCHEMA_VERSION;
  status: typeof CREDIT_CARD_STATUS.ready;
  policyVersion: string;
  allowedDenominations: readonly number[];
  allowedValidityDays: readonly number[];
  maxBatchCount: number;
  maxBatchCredits: number;
  batches: readonly CreditCardBatchSummary[];
}>;

export type CreditCardOneTimeCard = Readonly<{
  cardNumber: string;
  pin: string;
}>;

export type CreditCardOneTimeDelivery = Readonly<{
  batchId: string;
  activationToken: string;
  cards: readonly CreditCardOneTimeCard[];
}>;

export type CreditCardIssueResponse = Readonly<{
  schemaVersion: typeof CREDIT_CARD_SCHEMA_VERSION;
  status: "PENDING_ACTIVATION";
  batch: CreditCardBatchSummary;
  oneTimeDelivery?: CreditCardOneTimeDelivery;
  deliveryAvailable: boolean;
}>;

export type CreditCardMutationResponse = Readonly<{
  schemaVersion: typeof CREDIT_CARD_SCHEMA_VERSION;
  ok: true;
  batch: CreditCardBatchSummary;
}>;

export type CreditCardRedeemResponse = Readonly<{
  schemaVersion: typeof CREDIT_CARD_SCHEMA_VERSION;
  ok: true;
  creditedCredits: number;
  balanceAfter: number;
  redeemedAt: string;
  replayed: boolean;
}>;

export type CreditCardIssueAction = Readonly<{
  action: "issue";
  denominationCredits: number;
  quantity: number;
  validityDays: number;
  idempotencyKey: string;
}>;

export type CreditCardActivateAction = Readonly<{
  action: "activate";
  batchId: string;
  activationToken: string;
}>;

export type CreditCardDisableBatchAction = Readonly<{
  action: "disable_batch";
  batchId: string;
}>;

export type CreditCardDisableCardAction = Readonly<{
  action: "disable_card";
  cardNumber: string;
}>;

export type CreditCardAdminAction =
  | CreditCardIssueAction
  | CreditCardActivateAction
  | CreditCardDisableBatchAction
  | CreditCardDisableCardAction;

export type CreditCardRedeemAction = Readonly<{
  cardNumber: string;
  pin: string;
  idempotencyKey: string;
}>;

function isPlainDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expectedKeys.length) return false;
  return keys.every((key) => {
    if (typeof key !== "string" || !expectedKeys.includes(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !!descriptor
      && "value" in descriptor
      && descriptor.get === undefined
      && descriptor.set === undefined;
  });
}

function safeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

export function isCreditCardIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && IDEMPOTENCY_PATTERN.test(value);
}

export function isCreditCardBatchId(value: unknown): value is string {
  return typeof value === "string" && BATCH_ID_PATTERN.test(value);
}

function canonicalHumanToken(
  value: unknown,
  prefix: string,
  expectedLength: number,
): string | undefined {
  if (typeof value !== "string" || value.length > 80) return undefined;
  const upper = value.trim().toUpperCase();
  if (!upper || /[^0-9A-Z -]/.test(upper)) return undefined;
  const compact = upper.replace(/[ -]/g, "");
  if (!compact.startsWith(prefix)) return undefined;
  const payload = compact.slice(prefix.length);
  if (
    payload.length !== expectedLength
    || !CROCKFORD_PATTERN.test(payload)
  ) return undefined;
  return `${prefix}${payload}`;
}

export function normalizeCreditCardNumber(
  value: unknown,
): string | undefined {
  return canonicalHumanToken(value, "AC1", CARD_PAYLOAD_LENGTH);
}

export function normalizeCreditCardPin(value: unknown): string | undefined {
  return canonicalHumanToken(value, "", PIN_LENGTH);
}

export function parseCreditCardAdminAction(
  value: unknown,
): CreditCardAdminAction | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const actionDescriptor = Object.getOwnPropertyDescriptor(value, "action");
  if (
    !actionDescriptor
    || !("value" in actionDescriptor)
    || typeof actionDescriptor.value !== "string"
  ) return undefined;
  if (actionDescriptor.value === "issue") {
    if (!isPlainDataRecord(value, [
      "action",
      "denominationCredits",
      "quantity",
      "validityDays",
      "idempotencyKey",
    ])) return undefined;
    if (
      value.action !== "issue"
      || !safeInteger(value.denominationCredits)
      || !safeInteger(value.quantity)
      || !safeInteger(value.validityDays)
      || !isCreditCardIdempotencyKey(value.idempotencyKey)
    ) return undefined;
    return Object.freeze({
      action: "issue",
      denominationCredits: value.denominationCredits,
      quantity: value.quantity,
      validityDays: value.validityDays,
      idempotencyKey: value.idempotencyKey,
    });
  }
  if (actionDescriptor.value === "activate") {
    if (!isPlainDataRecord(value, [
      "action",
      "batchId",
      "activationToken",
    ])) return undefined;
    const activationToken = normalizeCreditCardPin(value.activationToken);
    if (
      value.action !== "activate"
      || !isCreditCardBatchId(value.batchId)
      || !activationToken
    ) return undefined;
    return Object.freeze({
      action: "activate",
      batchId: value.batchId,
      activationToken,
    });
  }
  if (actionDescriptor.value === "disable_batch") {
    if (!isPlainDataRecord(value, ["action", "batchId"])) return undefined;
    if (
      value.action !== "disable_batch"
      || !isCreditCardBatchId(value.batchId)
    ) return undefined;
    return Object.freeze({ action: "disable_batch", batchId: value.batchId });
  }
  if (actionDescriptor.value === "disable_card") {
    if (!isPlainDataRecord(value, ["action", "cardNumber"])) return undefined;
    const cardNumber = normalizeCreditCardNumber(value.cardNumber);
    if (value.action !== "disable_card" || !cardNumber) return undefined;
    return Object.freeze({ action: "disable_card", cardNumber });
  }
  return undefined;
}

export function parseCreditCardRedeemAction(
  value: unknown,
): CreditCardRedeemAction | undefined {
  if (!isPlainDataRecord(value, ["cardNumber", "pin", "idempotencyKey"])) {
    return undefined;
  }
  const cardNumber = normalizeCreditCardNumber(value.cardNumber);
  const pin = normalizeCreditCardPin(value.pin);
  if (
    !cardNumber
    || !pin
    || !isCreditCardIdempotencyKey(value.idempotencyKey)
  ) return undefined;
  return Object.freeze({
    cardNumber,
    pin,
    idempotencyKey: value.idempotencyKey,
  });
}

export function formatCreditCardNumber(compact: string): string {
  const normalized = normalizeCreditCardNumber(compact);
  if (!normalized) throw new Error("Invalid card number.");
  const payload = normalized.slice(3);
  return `AC1-${payload.slice(0, 5)}-${payload.slice(5, 10)}-${
    payload.slice(10, 15)
  }-${payload.slice(15, 20)}-${payload.slice(20)}`;
}

export function formatCreditCardPin(compact: string): string {
  const normalized = normalizeCreditCardPin(compact);
  if (!normalized) throw new Error("Invalid PIN.");
  return `${normalized.slice(0, 5)}-${normalized.slice(5, 10)}-${
    normalized.slice(10, 15)
  }-${normalized.slice(15, 20)}-${normalized.slice(20)}`;
}
