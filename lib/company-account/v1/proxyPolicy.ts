import "server-only";

import {
  COMPANY_ACCOUNT_AUDIENCE,
  COMPANY_ACCOUNT_CHANNEL_ID,
  COMPANY_ACCOUNT_CLIENT_CONTEXT_KEYS,
  COMPANY_ACCOUNT_CLIENT_ID,
  COMPANY_ACCOUNT_PRODUCT_ID,
  COMPANY_ACCOUNT_SCHEMA_VERSION,
  hasExactOwnKeys,
  isSafePublicId,
  readOwnDataValue,
  readStrictRecord,
  type CompanyAccountErrorCode,
} from "./contracts";

export const HARNESSDESK_PROXY_CAPABILITY_ID = "platform_model_proxy" as const;
export const HARNESSDESK_PROXY_OPERATION = "chat.completions" as const;
export const HARNESSDESK_PROXY_ADAPTER_ID = "deepseek" as const;
export const HARNESSDESK_PROXY_UPSTREAM_ID = "deepseek_official_api_v1" as const;
export const HARNESSDESK_PROXY_MODEL_ALLOWLIST = [
  "deepseek-chat",
  "deepseek-reasoner",
] as const;

type HarnessDeskProxyModel = (typeof HARNESSDESK_PROXY_MODEL_ALLOWLIST)[number];

export type HarnessDeskProxyPolicyConfig = {
  enabled: boolean;
  productId: typeof COMPANY_ACCOUNT_PRODUCT_ID;
  capabilityId: typeof HARNESSDESK_PROXY_CAPABILITY_ID;
  operation: typeof HARNESSDESK_PROXY_OPERATION;
  adapterId: typeof HARNESSDESK_PROXY_ADAPTER_ID;
  upstreamId: typeof HARNESSDESK_PROXY_UPSTREAM_ID;
  allowedModels: readonly HarnessDeskProxyModel[];
  billingPosture: "unavailable" | "ready";
  quoteCapability: boolean;
  reservationCapability: boolean;
  credentialCapability: boolean;
};

export const HARNESSDESK_PROXY_DISABLED_CONFIG: HarnessDeskProxyPolicyConfig =
  Object.freeze({
    enabled: false,
    productId: COMPANY_ACCOUNT_PRODUCT_ID,
    capabilityId: HARNESSDESK_PROXY_CAPABILITY_ID,
    operation: HARNESSDESK_PROXY_OPERATION,
    adapterId: HARNESSDESK_PROXY_ADAPTER_ID,
    upstreamId: HARNESSDESK_PROXY_UPSTREAM_ID,
    allowedModels: Object.freeze([]),
    billingPosture: "unavailable",
    quoteCapability: false,
    reservationCapability: false,
    credentialCapability: false,
  });

export type HarnessDeskProxyPreflight = {
  schemaVersion: typeof COMPANY_ACCOUNT_SCHEMA_VERSION;
  productId: typeof COMPANY_ACCOUNT_PRODUCT_ID;
  audience: typeof COMPANY_ACCOUNT_AUDIENCE;
  capabilityId: typeof HARNESSDESK_PROXY_CAPABILITY_ID;
  operation: typeof HARNESSDESK_PROXY_OPERATION;
  adapterId: typeof HARNESSDESK_PROXY_ADAPTER_ID;
  upstreamId: typeof HARNESSDESK_PROXY_UPSTREAM_ID;
  model: HarnessDeskProxyModel;
  maxOutputTokens: number;
  idempotencyKey: string;
};

export class HarnessDeskProxyPolicyError extends Error {
  constructor(readonly code: CompanyAccountErrorCode) {
    super(code);
    this.name = "HarnessDeskProxyPolicyError";
  }
}

function safeStringArray(value: unknown): string[] | null {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      return null;
    }
    const ownKeys = Reflect.ownKeys(value);
    const expectedKeys = [
      ...Array.from({ length: value.length }, (_, index) => String(index)),
      "length",
    ];
    if (
      ownKeys.some((key) => typeof key !== "string") ||
      !hasExactOwnKeys(value as unknown as Record<string, unknown>, expectedKeys)
    ) {
      return null;
    }
    for (const key of ownKeys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return null;
    }
    return value.every((item) => typeof item === "string") ? [...value] : null;
  } catch {
    return null;
  }
}

function parseConfig(input: HarnessDeskProxyPolicyConfig): HarnessDeskProxyPolicyConfig {
  const record = readStrictRecord(input);
  if (
    !record ||
    !hasExactOwnKeys(record, [
      "enabled",
      "productId",
      "capabilityId",
      "operation",
      "adapterId",
      "upstreamId",
      "allowedModels",
      "billingPosture",
      "quoteCapability",
      "reservationCapability",
      "credentialCapability",
    ]) ||
    typeof readOwnDataValue(record, "enabled") !== "boolean" ||
    readOwnDataValue(record, "productId") !== COMPANY_ACCOUNT_PRODUCT_ID ||
    readOwnDataValue(record, "capabilityId") !==
      HARNESSDESK_PROXY_CAPABILITY_ID ||
    readOwnDataValue(record, "operation") !== HARNESSDESK_PROXY_OPERATION ||
    readOwnDataValue(record, "adapterId") !== HARNESSDESK_PROXY_ADAPTER_ID ||
    readOwnDataValue(record, "upstreamId") !== HARNESSDESK_PROXY_UPSTREAM_ID ||
    (readOwnDataValue(record, "billingPosture") !== "unavailable" &&
      readOwnDataValue(record, "billingPosture") !== "ready") ||
    typeof readOwnDataValue(record, "quoteCapability") !== "boolean" ||
    typeof readOwnDataValue(record, "reservationCapability") !== "boolean" ||
    typeof readOwnDataValue(record, "credentialCapability") !== "boolean"
  ) {
    throw new HarnessDeskProxyPolicyError("SERVICE_UNAVAILABLE");
  }
  const allowedModels = safeStringArray(
    readOwnDataValue(record, "allowedModels"),
  );
  if (
    !allowedModels ||
    new Set(allowedModels).size !== allowedModels.length ||
    allowedModels.some(
      (model) =>
        !HARNESSDESK_PROXY_MODEL_ALLOWLIST.includes(model as HarnessDeskProxyModel),
    )
  ) {
    throw new HarnessDeskProxyPolicyError("SERVICE_UNAVAILABLE");
  }
  return {
    enabled: readOwnDataValue(record, "enabled") as boolean,
    productId: COMPANY_ACCOUNT_PRODUCT_ID,
    capabilityId: HARNESSDESK_PROXY_CAPABILITY_ID,
    operation: HARNESSDESK_PROXY_OPERATION,
    adapterId: HARNESSDESK_PROXY_ADAPTER_ID,
    upstreamId: HARNESSDESK_PROXY_UPSTREAM_ID,
    allowedModels: allowedModels as HarnessDeskProxyModel[],
    billingPosture: readOwnDataValue(record, "billingPosture") as
      | "unavailable"
      | "ready",
    quoteCapability: readOwnDataValue(record, "quoteCapability") as boolean,
    reservationCapability: readOwnDataValue(
      record,
      "reservationCapability",
    ) as boolean,
    credentialCapability: readOwnDataValue(
      record,
      "credentialCapability",
    ) as boolean,
  };
}

function parseRequest(input: unknown): Omit<HarnessDeskProxyPreflight, "upstreamId"> {
  const record = readStrictRecord(input);
  const requiredKeys = [
    ...COMPANY_ACCOUNT_CLIENT_CONTEXT_KEYS,
    "capabilityId",
    "operation",
    "adapterId",
    "model",
    "maxOutputTokens",
  ];
  if (record && hasExactOwnKeys(record, requiredKeys)) {
    throw new HarnessDeskProxyPolicyError("IDEMPOTENCY_KEY_REQUIRED");
  }
  if (
    !record ||
    !hasExactOwnKeys(record, [
      ...requiredKeys,
      "idempotencyKey",
    ]) ||
    readOwnDataValue(record, "schemaVersion") !==
      COMPANY_ACCOUNT_SCHEMA_VERSION ||
    readOwnDataValue(record, "productId") !== COMPANY_ACCOUNT_PRODUCT_ID ||
    readOwnDataValue(record, "clientId") !== COMPANY_ACCOUNT_CLIENT_ID ||
    readOwnDataValue(record, "audience") !== COMPANY_ACCOUNT_AUDIENCE ||
    readOwnDataValue(record, "channelId") !== COMPANY_ACCOUNT_CHANNEL_ID ||
    readOwnDataValue(record, "capabilityId") !==
      HARNESSDESK_PROXY_CAPABILITY_ID ||
    readOwnDataValue(record, "operation") !== HARNESSDESK_PROXY_OPERATION ||
    readOwnDataValue(record, "adapterId") !== HARNESSDESK_PROXY_ADAPTER_ID
  ) {
    throw new HarnessDeskProxyPolicyError("INVALID_REQUEST");
  }
  const model = readOwnDataValue(record, "model");
  const maxOutputTokens = readOwnDataValue(record, "maxOutputTokens");
  const idempotencyKey = readOwnDataValue(record, "idempotencyKey");
  if (idempotencyKey === undefined || idempotencyKey === null || idempotencyKey === "") {
    throw new HarnessDeskProxyPolicyError("IDEMPOTENCY_KEY_REQUIRED");
  }
  if (
    typeof model !== "string" ||
    !HARNESSDESK_PROXY_MODEL_ALLOWLIST.includes(model as HarnessDeskProxyModel) ||
    typeof maxOutputTokens !== "number" ||
    !Number.isSafeInteger(maxOutputTokens) ||
    maxOutputTokens < 1 ||
    maxOutputTokens > 32_768 ||
    !isSafePublicId(idempotencyKey, 8, 128)
  ) {
    throw new HarnessDeskProxyPolicyError("INVALID_REQUEST");
  }
  return {
    schemaVersion: COMPANY_ACCOUNT_SCHEMA_VERSION,
    productId: COMPANY_ACCOUNT_PRODUCT_ID,
    audience: COMPANY_ACCOUNT_AUDIENCE,
    capabilityId: HARNESSDESK_PROXY_CAPABILITY_ID,
    operation: HARNESSDESK_PROXY_OPERATION,
    adapterId: HARNESSDESK_PROXY_ADAPTER_ID,
    model: model as HarnessDeskProxyModel,
    maxOutputTokens,
    idempotencyKey,
  };
}

function parseQuoteResult(
  input: unknown,
): { quoteId: string; maxChargeCredits: number } | null {
  const record = readStrictRecord(input);
  if (!record || !hasExactOwnKeys(record, ["quoteId", "maxChargeCredits"])) {
    return null;
  }
  const quoteId = readOwnDataValue(record, "quoteId");
  const maxChargeCredits = readOwnDataValue(record, "maxChargeCredits");
  return isSafePublicId(quoteId, 8, 128) &&
    typeof maxChargeCredits === "number" &&
    Number.isSafeInteger(maxChargeCredits) &&
    maxChargeCredits >= 0 &&
    maxChargeCredits <= 1_000_000
    ? { quoteId, maxChargeCredits }
    : null;
}

function parseReservationResult(input: unknown): { reservationId: string } | null {
  const record = readStrictRecord(input);
  if (!record || !hasExactOwnKeys(record, ["reservationId"])) return null;
  const reservationId = readOwnDataValue(record, "reservationId");
  return isSafePublicId(reservationId, 8, 128) ? { reservationId } : null;
}

function parseCredentialResult(input: unknown): { credentialHandle: unknown } | null {
  const record = readStrictRecord(input);
  if (!record || !hasExactOwnKeys(record, ["credentialHandle"])) return null;
  const credentialHandle = readOwnDataValue(record, "credentialHandle");
  return credentialHandle === null || credentialHandle === undefined
    ? null
    : { credentialHandle };
}

function parseProviderReceipt(
  input: unknown,
): { receiptDigest: string; usageUnits: number } | null {
  const record = readStrictRecord(input);
  if (!record || !hasExactOwnKeys(record, ["receiptDigest", "usageUnits"])) {
    return null;
  }
  const receiptDigest = readOwnDataValue(record, "receiptDigest");
  const usageUnits = readOwnDataValue(record, "usageUnits");
  return typeof receiptDigest === "string" &&
    /^[a-f0-9]{64}$/.test(receiptDigest) &&
    typeof usageUnits === "number" &&
    Number.isSafeInteger(usageUnits) &&
    usageUnits >= 0
    ? { receiptDigest, usageUnits }
    : null;
}

export type HarnessDeskProviderInvocationOutcome =
  | {
      status: "completed";
      receipt: {
        receiptDigest: string;
        usageUnits: number;
      };
    }
  | { status: "definitive_not_started" }
  | { status: "outcome_unknown" };

function parseProviderInvocationOutcome(
  input: unknown,
): HarnessDeskProviderInvocationOutcome | null {
  const record = readStrictRecord(input);
  if (!record) return null;
  const status = readOwnDataValue(record, "status");
  if (status === "definitive_not_started" || status === "outcome_unknown") {
    return hasExactOwnKeys(record, ["status"]) ? { status } : null;
  }
  if (status !== "completed" || !hasExactOwnKeys(record, ["status", "receipt"])) {
    return null;
  }
  const receipt = parseProviderReceipt(readOwnDataValue(record, "receipt"));
  return receipt ? { status, receipt } : null;
}

export function preflightHarnessDeskProxy(input: {
  request: unknown;
  config?: HarnessDeskProxyPolicyConfig;
}): HarnessDeskProxyPreflight {
  const request = parseRequest(input.request);
  const config = parseConfig(input.config ?? HARNESSDESK_PROXY_DISABLED_CONFIG);
  if (!config.enabled) {
    throw new HarnessDeskProxyPolicyError("SERVICE_UNAVAILABLE");
  }
  if (
    config.billingPosture !== "ready" ||
    !config.quoteCapability ||
    !config.reservationCapability
  ) {
    throw new HarnessDeskProxyPolicyError("PRODUCT_PRICING_UNAVAILABLE");
  }
  if (!config.credentialCapability) {
    throw new HarnessDeskProxyPolicyError("PROVIDER_UNAVAILABLE");
  }
  if (!config.allowedModels.includes(request.model)) {
    throw new HarnessDeskProxyPolicyError("PROVIDER_UNAVAILABLE");
  }
  return {
    schemaVersion: request.schemaVersion,
    productId: request.productId,
    audience: request.audience,
    capabilityId: request.capabilityId,
    operation: request.operation,
    adapterId: request.adapterId,
    upstreamId: config.upstreamId,
    model: request.model,
    maxOutputTokens: request.maxOutputTokens,
    idempotencyKey: request.idempotencyKey,
  };
}

export type HarnessDeskProxyPipelineDependencies = {
  resolveCredential(): Promise<{ credentialHandle: unknown }>;
  quote(input: HarnessDeskProxyPreflight): Promise<{
    quoteId: string;
    maxChargeCredits: number;
  }>;
  reserve(input: {
    preflight: HarnessDeskProxyPreflight;
    quoteId: string;
    maxChargeCredits: number;
  }): Promise<{ reservationId: string }>;
  invokeProvider(input: {
    preflight: HarnessDeskProxyPreflight;
    credentialHandle: unknown;
  }): Promise<unknown>;
  settle(input: {
    reservationId: string;
    receiptDigest: string;
    usageUnits: number;
  }): Promise<void>;
  refund(input: { reservationId: string }): Promise<void>;
};

export async function runFakeHarnessDeskProxyContractPipeline(input: {
  request: unknown;
  config?: HarnessDeskProxyPolicyConfig;
  dependencies: HarnessDeskProxyPipelineDependencies;
}): Promise<{
  status: "contract_test_completed";
  productId: typeof COMPANY_ACCOUNT_PRODUCT_ID;
  adapterId: typeof HARNESSDESK_PROXY_ADAPTER_ID;
  operation: typeof HARNESSDESK_PROXY_OPERATION;
  model: HarnessDeskProxyModel;
}> {
  // Every gate above this line is pure. No dependency may run before it passes.
  const preflight = preflightHarnessDeskProxy({
    request: input.request,
    config: input.config,
  });
  let quote: { quoteId: string; maxChargeCredits: number };
  try {
    const parsed = parseQuoteResult(await input.dependencies.quote(preflight));
    if (!parsed) throw new Error("invalid_quote_contract");
    quote = parsed;
  } catch {
    throw new HarnessDeskProxyPolicyError("PRODUCT_PRICING_UNAVAILABLE");
  }
  let reservation: { reservationId: string };
  try {
    const parsed = parseReservationResult(
      await input.dependencies.reserve({
        preflight,
        quoteId: quote.quoteId,
        maxChargeCredits: quote.maxChargeCredits,
      }),
    );
    if (!parsed) throw new Error("invalid_reservation_contract");
    reservation = parsed;
  } catch {
    throw new HarnessDeskProxyPolicyError("BILLING_OUTCOME_PENDING");
  }
  let credential: { credentialHandle: unknown };
  try {
    const parsed = parseCredentialResult(
      await input.dependencies.resolveCredential(),
    );
    if (!parsed) throw new Error("invalid_credential_contract");
    credential = parsed;
  } catch {
    try {
      await input.dependencies.refund({
        reservationId: reservation.reservationId,
      });
    } catch {
      throw new HarnessDeskProxyPolicyError("BILLING_OUTCOME_PENDING");
    }
    throw new HarnessDeskProxyPolicyError("PROVIDER_UNAVAILABLE");
  }
  let providerOutcome: HarnessDeskProviderInvocationOutcome;
  try {
    const parsed = parseProviderInvocationOutcome(
      await input.dependencies.invokeProvider({
        preflight,
        credentialHandle: credential.credentialHandle,
      }),
    );
    if (!parsed) {
      throw new HarnessDeskProxyPolicyError("BILLING_OUTCOME_PENDING");
    }
    providerOutcome = parsed;
  } catch {
    // A thrown request, timeout, malformed response or otherwise unconfirmed
    // receipt can all mean the provider started work. Preserve the reservation
    // until a later reconciliation proves a terminal outcome.
    throw new HarnessDeskProxyPolicyError("BILLING_OUTCOME_PENDING");
  }
  if (providerOutcome.status === "outcome_unknown") {
    throw new HarnessDeskProxyPolicyError("BILLING_OUTCOME_PENDING");
  }
  if (providerOutcome.status === "definitive_not_started") {
    try {
      await input.dependencies.refund({
        reservationId: reservation.reservationId,
      });
    } catch {
      throw new HarnessDeskProxyPolicyError("BILLING_OUTCOME_PENDING");
    }
    throw new HarnessDeskProxyPolicyError("PROVIDER_UNAVAILABLE");
  }
  const provider = providerOutcome.receipt;
  try {
    await input.dependencies.settle({
      reservationId: reservation.reservationId,
      receiptDigest: provider.receiptDigest,
      usageUnits: provider.usageUnits,
    });
  } catch {
    // A settle transport failure has an unknown commit outcome. Never refund
    // synchronously or claim a terminal result in that state.
    throw new HarnessDeskProxyPolicyError("BILLING_OUTCOME_PENDING");
  }
  return {
    status: "contract_test_completed",
    productId: COMPANY_ACCOUNT_PRODUCT_ID,
    adapterId: HARNESSDESK_PROXY_ADAPTER_ID,
    operation: HARNESSDESK_PROXY_OPERATION,
    model: preflight.model,
  };
}
