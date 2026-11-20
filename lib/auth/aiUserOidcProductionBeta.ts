import "server-only";

import { createHash } from "node:crypto";
import {
  AIUSER_OIDC_DISABLED_MODE,
  AIUSER_OIDC_LOCAL_VALIDATE_MODE,
  validateAiUserOidcAdapterAuthorityPin,
  validateAiUserOidcAdapterContract,
  type AiUserOidcAdapterContract,
} from "@/lib/auth/aiUserOidcReadiness";

// Public registration metadata selected by AIstory; not an accepted IdP release.
export const AIUSER_OIDC_PRODUCTION_BETA_REGISTRATION = Object.freeze({
  schema: "aistory.aiuser-oidc-client-registration.v2",
  version: "production-beta-v2",
  productId: "aistory",
  environment: "production",
  publicOrigin: "https://play.hibcglobal.com",
  authorityOrigin: "https://id.hibcglobal.com",
  issuerUrl: "https://id.hibcglobal.com",
  clientId: "aistory-web-production-beta-v1",
  redirectUri: "https://play.hibcglobal.com/api/auth/aiuser/callback",
  audience: "urn:hibc:aiuser:aistory:production-beta:v1",
  resource: "urn:hibc:aiuser:aistory:production-beta:v1",
  authenticationMethod: "client_secret_basic",
  credentialReference: Object.freeze({
    kind: "protected_runtime_reference",
    referenceId: "ref_aistory_aiuser_oidc_production_beta_v1",
  }),
  scopes: Object.freeze(["openid", "product.access"]),
  responseType: "code",
  pkceMethod: "S256",
  stateRequired: true,
  nonceRequired: true,
  effects: Object.freeze({
    membership: "none",
    entitlement: "none",
    credits: "none",
  }),
} as const);

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(
    (key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
  ).join(",")}}`;
}

function exactRegistration(value: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== "object") return value === expected;
  if (value === null || typeof value !== "object") return false;
  if (Object.getPrototypeOf(value) !== Object.getPrototypeOf(expected)) return false;
  const keys = Reflect.ownKeys(value);
  const expectedKeys = Reflect.ownKeys(expected);
  if (keys.length !== expectedKeys.length) return false;
  return keys.every((key) => {
    if (typeof key !== "string" || !expectedKeys.includes(key)) return false;
    const actual = Object.getOwnPropertyDescriptor(value, key);
    const wanted = Object.getOwnPropertyDescriptor(expected, key);
    return !!actual && !!wanted && "value" in actual && "value" in wanted
      && actual.enumerable === wanted.enumerable
      && exactRegistration(actual.value, wanted.value);
  });
}

export function serializeAiUserOidcProductionBetaRegistration(
  value: unknown = AIUSER_OIDC_PRODUCTION_BETA_REGISTRATION,
): string {
  try {
    if (exactRegistration(value, AIUSER_OIDC_PRODUCTION_BETA_REGISTRATION)) {
      return canonicalJson(AIUSER_OIDC_PRODUCTION_BETA_REGISTRATION);
    }
  } catch {
    // Do not reflect a hostile object's exception or fields.
  }
  throw new Error("invalid_aistory_oidc_registration");
}

export const AIUSER_OIDC_PRODUCTION_BETA_REGISTRATION_SHA256 = createHash("sha256")
  .update(serializeAiUserOidcProductionBetaRegistration(), "utf8")
  .digest("hex");

type Status =
  | "DISABLED"
  | "BLOCKED_INVALID_CONFIGURATION"
  | "BLOCKED_ADAPTER_CONTRACT_REQUIRED"
  | "BLOCKED_INVALID_ADAPTER_CONTRACT"
  | "BLOCKED_PRODUCTION_BINDING_MISMATCH"
  | "BLOCKED_ADAPTER_AUTHORITY_PIN_REQUIRED"
  | "BLOCKED_INVALID_ADAPTER_AUTHORITY_PIN"
  | "LOCAL_PRODUCTION_BINDING_VALIDATED_ONLY";

type Blocker =
  | "invalid_configuration"
  | "adapter_contract_required"
  | "invalid_adapter_contract"
  | "production_binding_mismatch"
  | "adapter_authority_pin_required"
  | "invalid_adapter_authority_pin"
  | "oidc_runtime_not_implemented"
  | "credential_reference_not_resolved"
  | "login_business_side_effects_forbidden";

function projection(status: Status, blocker?: Blocker, adapterHash?: string) {
  return Object.freeze({
    schema: "aistory.aiuser-oidc-production-beta-projection.v1" as const,
    status,
    registrationFingerprintSha256: AIUSER_OIDC_PRODUCTION_BETA_REGISTRATION_SHA256,
    blockerCodes: Object.freeze([
      ...(blocker ? [blocker] : []),
      "oidc_runtime_not_implemented",
      "credential_reference_not_resolved",
      "login_business_side_effects_forbidden",
    ] as Blocker[]),
    ...(adapterHash ? { matchedAdapterFingerprintSha256: adapterHash } : {}),
    loginEnabled: false as const,
    callbackEnabled: false as const,
    tokenExchangeAllowed: false as const,
    sessionIssuanceAllowed: false as const,
    accountLinkingAllowed: false as const,
    membershipMutationAllowed: false as const,
    entitlementMutationAllowed: false as const,
    creditGrantAllowed: false as const,
    networkAllowed: false as const,
    networkCalls: 0 as const,
    writesPerformed: 0 as const,
  });
}

export type AiUserOidcProductionBetaProjection = ReturnType<typeof projection>;

function readOptions(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object"
    || Object.getPrototypeOf(input) !== Object.prototype) throw new Error();
  const allowed = ["mode", "adapterContract", "adapterAuthorityPin"];
  const output: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !allowed.includes(key)) throw new Error();
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error();
    output[key] = descriptor.value;
  }
  return output;
}

function matchesProductionBinding(contract: AiUserOidcAdapterContract): boolean {
  const selected = AIUSER_OIDC_PRODUCTION_BETA_REGISTRATION;
  return contract.environment === selected.environment
    && contract.issuerUrl === selected.issuerUrl
    && contract.client.clientId === selected.clientId
    && contract.client.authenticationMethod === selected.authenticationMethod
    && contract.client.credentialReference.kind === selected.credentialReference.kind
    && contract.client.credentialReference.referenceId === selected.credentialReference.referenceId
    && contract.redirectUri === selected.redirectUri
    && contract.audience === selected.audience
    && contract.scopes.length === selected.scopes.length
    && contract.scopes.every((scope, index) => scope === selected.scopes[index])
    && [contract.issuerUrl, contract.authorizationEndpointUrl, contract.tokenEndpointUrl, contract.jwksUri]
      .every((value) => new URL(value).origin === selected.authorityOrigin);
}

// The caller injects a separately trusted registry pin. This function does not
// discover authority, resolve credentials, authenticate users or grant access.
export function evaluateAiUserOidcProductionBeta(
  input: unknown = {},
): AiUserOidcProductionBetaProjection {
  let options: Record<string, unknown>;
  try {
    options = readOptions(input);
  } catch {
    return projection("BLOCKED_INVALID_CONFIGURATION", "invalid_configuration");
  }
  const { mode } = options;
  if (mode === undefined || mode === null || mode === "" || mode === AIUSER_OIDC_DISABLED_MODE) {
    return projection("DISABLED");
  }
  if (mode !== AIUSER_OIDC_LOCAL_VALIDATE_MODE) {
    return projection("BLOCKED_INVALID_CONFIGURATION", "invalid_configuration");
  }
  if (options.adapterContract === undefined) {
    return projection("BLOCKED_ADAPTER_CONTRACT_REQUIRED", "adapter_contract_required");
  }
  let contract: AiUserOidcAdapterContract;
  try {
    contract = validateAiUserOidcAdapterContract(options.adapterContract);
  } catch {
    return projection("BLOCKED_INVALID_ADAPTER_CONTRACT", "invalid_adapter_contract");
  }
  if (!matchesProductionBinding(contract)) {
    return projection("BLOCKED_PRODUCTION_BINDING_MISMATCH", "production_binding_mismatch");
  }
  if (options.adapterAuthorityPin === undefined) {
    return projection("BLOCKED_ADAPTER_AUTHORITY_PIN_REQUIRED", "adapter_authority_pin_required");
  }
  try {
    const pin = validateAiUserOidcAdapterAuthorityPin(options.adapterAuthorityPin);
    if (pin.version !== contract.version
      || pin.contractFingerprintSha256 !== contract.contractFingerprintSha256) throw new Error();
  } catch {
    return projection("BLOCKED_INVALID_ADAPTER_AUTHORITY_PIN", "invalid_adapter_authority_pin");
  }
  return projection("LOCAL_PRODUCTION_BINDING_VALIDATED_ONLY", undefined, contract.contractFingerprintSha256);
}
