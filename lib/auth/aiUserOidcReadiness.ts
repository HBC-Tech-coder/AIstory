import "server-only";

import { createHash } from "node:crypto";

export const AIUSER_OIDC_READINESS_SCHEMA =
  "aistory.aiuser-oidc-readiness-projection.v1" as const;
export const AIUSER_OIDC_READINESS_CAPABILITY =
  "AIUSER_OIDC_READINESS_ONLY" as const;
export const AIUSER_OIDC_READINESS_MODE_ENV =
  "AISTORY_AIUSER_OIDC_READINESS_MODE" as const;
export const AIUSER_OIDC_LOCAL_VALIDATE_MODE =
  "aistory-aiuser-oidc-readiness-v1:local_validate_only" as const;
export const AIUSER_OIDC_DISABLED_MODE = "disabled" as const;

const ADAPTER_SCHEMA = "aistory.aiuser-oidc-adapter-contract" as const;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const CONTRACT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{4,95}$/;
const CONTRACT_VERSION_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const CLIENT_ID_PATTERN = /^[\x21-\x7e]{3,256}$/;
const REFERENCE_ID_PATTERN = /^ref_[a-z0-9][a-z0-9_-]{7,127}$/;
const CLAIM_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/;
const SCOPE_PATTERN = /^[A-Za-z0-9._:/-]{1,128}$/;
const CONTRACT_TEXT_PATTERN = /^[A-Za-z0-9._:/-]{3,128}$/;
const SAFE_ID_TOKEN_ALGORITHMS = new Set(["ES256", "PS256", "RS256"]);

export const AIUSER_OIDC_REQUIRED_ADAPTER_INPUTS = Object.freeze([
  "schema",
  "version",
  "contractId",
  "contractFingerprintSha256",
  "environment",
  "issuerUrl",
  "authorizationEndpointUrl",
  "tokenEndpointUrl",
  "jwksUri",
  "client.clientId",
  "client.authenticationMethod",
  "client.credentialReference.kind",
  "client.credentialReference.referenceId",
  "redirectUri",
  "audience",
  "scopes",
  "responseType",
  "pkceMethod",
  "stateRequired",
  "nonceRequired",
  "acceptedIdTokenAlgorithms",
  "claims.subject",
  "claims.tenant",
  "claims.accountStatus",
  "timePolicy.authorizationCodeTtlSeconds",
  "timePolicy.tokenClockSkewSeconds",
  "timePolicy.jwksCacheMaxAgeSeconds",
  "lifecycle.logoutContract",
  "lifecycle.revocationContract",
  "lifecycle.errorContract",
  "effects.membership",
  "effects.entitlement",
  "effects.credits",
] as const);

export const AIUSER_OIDC_REQUIRED_AUTHORITY_PIN_INPUTS = Object.freeze([
  "version",
  "contractFingerprintSha256",
] as const);

export type AiUserOidcReadinessStatus =
  | "DISABLED"
  | "BLOCKED_INVALID_CONFIGURATION"
  | "BLOCKED_ADAPTER_CONTRACT_REQUIRED"
  | "BLOCKED_ADAPTER_AUTHORITY_PIN_REQUIRED"
  | "BLOCKED_INVALID_ADAPTER_CONTRACT"
  | "BLOCKED_INVALID_ADAPTER_AUTHORITY_PIN"
  | "LOCAL_CONFIGURATION_VALIDATED_ONLY";

export type AiUserOidcReadinessBlocker =
  | "invalid_readiness_mode"
  | "versioned_aiuser_adapter_contract_required"
  | "adapter_contract_authority_pin_required"
  | "invalid_aiuser_adapter_contract"
  | "invalid_adapter_contract_authority_pin"
  | "oidc_runtime_not_implemented"
  | "oidc_login_not_authorized"
  | "membership_and_entitlement_side_effects_forbidden";

export type AiUserOidcReadinessProjection = Readonly<{
  schema: typeof AIUSER_OIDC_READINESS_SCHEMA;
  capability: typeof AIUSER_OIDC_READINESS_CAPABILITY;
  mode:
    | typeof AIUSER_OIDC_DISABLED_MODE
    | typeof AIUSER_OIDC_LOCAL_VALIDATE_MODE
    | "invalid";
  status: AiUserOidcReadinessStatus;
  blockerCodes: readonly AiUserOidcReadinessBlocker[];
  requiredAdapterInputs: typeof AIUSER_OIDC_REQUIRED_ADAPTER_INPUTS;
  requiredAuthorityPinInputs:
    typeof AIUSER_OIDC_REQUIRED_AUTHORITY_PIN_INPUTS;
  validatedAdapter?: Readonly<{
    version: string;
    contractFingerprintSha256: string;
  }>;
  loginEnabled: false;
  callbackEnabled: false;
  tokenExchangeAllowed: false;
  sessionIssuanceAllowed: false;
  accountLinkingAllowed: false;
  membershipMutationAllowed: false;
  entitlementMutationAllowed: false;
  creditGrantAllowed: false;
  networkAllowed: false;
  networkCalls: 0;
  writesPerformed: 0;
}>;

type AdapterContractCore = Readonly<{
  schema: typeof ADAPTER_SCHEMA;
  version: string;
  contractId: string;
  environment: "local" | "production";
  issuerUrl: string;
  authorizationEndpointUrl: string;
  tokenEndpointUrl: string;
  jwksUri: string;
  client: Readonly<{
    clientId: string;
    authenticationMethod: "client_secret_basic" | "private_key_jwt";
    credentialReference: Readonly<{
      kind: "protected_runtime_reference";
      referenceId: string;
    }>;
  }>;
  redirectUri: string;
  audience: string;
  scopes: readonly string[];
  responseType: "code";
  pkceMethod: "S256";
  stateRequired: true;
  nonceRequired: true;
  acceptedIdTokenAlgorithms: readonly ("ES256" | "PS256" | "RS256")[];
  claims: Readonly<{
    subject: string;
    tenant: string | null;
    accountStatus: string | null;
  }>;
  timePolicy: Readonly<{
    authorizationCodeTtlSeconds: number;
    tokenClockSkewSeconds: number;
    jwksCacheMaxAgeSeconds: number;
  }>;
  lifecycle: Readonly<{
    logoutContract: string;
    revocationContract: string;
    errorContract: string;
  }>;
  effects: Readonly<{
    membership: "none";
    entitlement: "none";
    credits: "none";
  }>;
}>;

export type AiUserOidcAdapterContract = AdapterContractCore &
  Readonly<{ contractFingerprintSha256: string }>;

export type AiUserOidcAdapterAuthorityPin = Readonly<{
  version: string;
  contractFingerprintSha256: string;
}>;

export class AiUserOidcReadinessError extends Error {
  readonly code:
    | "invalid_configuration"
    | "invalid_adapter_contract";

  constructor(
    code: "invalid_configuration" | "invalid_adapter_contract",
  ) {
    super(code);
    this.name = "AiUserOidcReadinessError";
    this.code = code;
  }
}

function failContract(): never {
  throw new AiUserOidcReadinessError("invalid_adapter_contract");
}

function exactDataObject(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return failContract();
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) return failContract();
  const sortedActual = (keys as string[]).slice().sort();
  const sortedExpected = expectedKeys.slice().sort();
  if (
    sortedActual.length !== sortedExpected.length
    || sortedActual.some((key, index) => key !== sortedExpected[index])
  ) {
    return failContract();
  }
  for (const key of sortedActual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      return failContract();
    }
  }
  return value as Record<string, unknown>;
}

function exactDataArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return failContract();
  }
  if (Reflect.ownKeys(value).some((key) => {
    if (typeof key === "symbol") return true;
    return key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key);
  })) {
    return failContract();
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      return failContract();
    }
  }
  return value;
}

function exactString(
  value: unknown,
  pattern: RegExp,
  maxLength: number,
): string {
  if (
    typeof value !== "string"
    || value.length > maxLength
    || !pattern.test(value)
  ) {
    return failContract();
  }
  return value;
}

function optionalClaimName(value: unknown): string | null {
  if (value === null) return null;
  return exactString(value, CLAIM_NAME_PATTERN, 128);
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    return failContract();
  }
  return value as number;
}

function exactBoolean(value: unknown, expected: true): true {
  if (value !== expected) return failContract();
  return true;
}

function exactLiteral<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    return failContract();
  }
  return value as T;
}

function strictHttpsUrl(value: unknown, allowBareOrigin = false): string {
  if (typeof value !== "string" || value.length > 2048) return failContract();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return failContract();
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.hash
    || url.search
    || value.includes("?")
    || value.includes("#")
    || !url.hostname
    || (url.toString() !== value && !(
      allowBareOrigin && url.origin === value && url.pathname === "/"
      && url.toString() === `${value}/`
    ))
  ) {
    return failContract();
  }
  // Issuer is an exact identifier: validating a bare origin must not add '/'.
  return value;
}

function explicitRedirectUri(
  value: unknown,
  environment: "local" | "production",
): string {
  if (typeof value !== "string" || value.length > 2048) return failContract();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return failContract();
  }
  const isLoopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  const schemeAllowed = url.protocol === "https:"
    || (environment === "local" && url.protocol === "http:" && isLoopback);
  if (
    !schemeAllowed
    || url.username
    || url.password
    || url.hash
    || url.search
    || !url.hostname
    || url.toString() !== value
  ) {
    return failContract();
  }
  return value;
}

function uniqueSortedStrings(
  value: unknown,
  validate: (entry: unknown) => string,
  minimum: number,
  maximum: number,
): readonly string[] {
  const array = exactDataArray(value);
  if (array.length < minimum || array.length > maximum) return failContract();
  const entries = array.map(validate);
  const sorted = [...entries].sort();
  if (new Set(sorted).size !== sorted.length) return failContract();
  return Object.freeze(sorted);
}

function normalizeAdapterContractCore(value: unknown): AdapterContractCore {
  const root = exactDataObject(value, [
    "schema",
    "version",
    "contractId",
    "environment",
    "issuerUrl",
    "authorizationEndpointUrl",
    "tokenEndpointUrl",
    "jwksUri",
    "client",
    "redirectUri",
    "audience",
    "scopes",
    "responseType",
    "pkceMethod",
    "stateRequired",
    "nonceRequired",
    "acceptedIdTokenAlgorithms",
    "claims",
    "timePolicy",
    "lifecycle",
    "effects",
  ]);
  if (root.schema !== ADAPTER_SCHEMA) return failContract();
  const environment = exactLiteral(root.environment, ["local", "production"]);
  const client = exactDataObject(root.client, [
    "clientId",
    "authenticationMethod",
    "credentialReference",
  ]);
  const credentialReference = exactDataObject(client.credentialReference, [
    "kind",
    "referenceId",
  ]);
  const claims = exactDataObject(root.claims, [
    "subject",
    "tenant",
    "accountStatus",
  ]);
  const timePolicy = exactDataObject(root.timePolicy, [
    "authorizationCodeTtlSeconds",
    "tokenClockSkewSeconds",
    "jwksCacheMaxAgeSeconds",
  ]);
  const lifecycle = exactDataObject(root.lifecycle, [
    "logoutContract",
    "revocationContract",
    "errorContract",
  ]);
  const effects = exactDataObject(root.effects, [
    "membership",
    "entitlement",
    "credits",
  ]);
  const scopes = uniqueSortedStrings(
    root.scopes,
    (entry) => exactString(entry, SCOPE_PATTERN, 128),
    1,
    24,
  );
  if (!scopes.includes("openid")) return failContract();
  const algorithms = uniqueSortedStrings(
    root.acceptedIdTokenAlgorithms,
    (entry) => {
      const algorithm = exactString(entry, /^[A-Z0-9]{4,12}$/, 12);
      if (!SAFE_ID_TOKEN_ALGORITHMS.has(algorithm)) return failContract();
      return algorithm;
    },
    1,
    SAFE_ID_TOKEN_ALGORITHMS.size,
  ) as readonly ("ES256" | "PS256" | "RS256")[];

  return Object.freeze({
    schema: ADAPTER_SCHEMA,
    version: exactString(root.version, CONTRACT_VERSION_PATTERN, 64),
    contractId: exactString(root.contractId, CONTRACT_ID_PATTERN, 96),
    environment,
    issuerUrl: strictHttpsUrl(root.issuerUrl, true),
    authorizationEndpointUrl: strictHttpsUrl(root.authorizationEndpointUrl),
    tokenEndpointUrl: strictHttpsUrl(root.tokenEndpointUrl),
    jwksUri: strictHttpsUrl(root.jwksUri),
    client: Object.freeze({
      clientId: exactString(root.client && client.clientId, CLIENT_ID_PATTERN, 256),
      authenticationMethod: exactLiteral(client.authenticationMethod, [
        "client_secret_basic",
        "private_key_jwt",
      ]),
      credentialReference: Object.freeze({
        kind: exactLiteral(credentialReference.kind, [
          "protected_runtime_reference",
        ]),
        referenceId: exactString(
          credentialReference.referenceId,
          REFERENCE_ID_PATTERN,
          132,
        ),
      }),
    }),
    redirectUri: explicitRedirectUri(root.redirectUri, environment),
    audience: exactString(root.audience, /^[\x21-\x7e]{3,256}$/, 256),
    scopes,
    responseType: exactLiteral(root.responseType, ["code"]),
    pkceMethod: exactLiteral(root.pkceMethod, ["S256"]),
    stateRequired: exactBoolean(root.stateRequired, true),
    nonceRequired: exactBoolean(root.nonceRequired, true),
    acceptedIdTokenAlgorithms: algorithms,
    claims: Object.freeze({
      subject: exactString(claims.subject, CLAIM_NAME_PATTERN, 128),
      tenant: optionalClaimName(claims.tenant),
      accountStatus: optionalClaimName(claims.accountStatus),
    }),
    timePolicy: Object.freeze({
      authorizationCodeTtlSeconds: boundedInteger(
        timePolicy.authorizationCodeTtlSeconds,
        30,
        600,
      ),
      tokenClockSkewSeconds: boundedInteger(
        timePolicy.tokenClockSkewSeconds,
        0,
        300,
      ),
      jwksCacheMaxAgeSeconds: boundedInteger(
        timePolicy.jwksCacheMaxAgeSeconds,
        60,
        86_400,
      ),
    }),
    lifecycle: Object.freeze({
      logoutContract: exactString(
        lifecycle.logoutContract,
        CONTRACT_TEXT_PATTERN,
        128,
      ),
      revocationContract: exactString(
        lifecycle.revocationContract,
        CONTRACT_TEXT_PATTERN,
        128,
      ),
      errorContract: exactString(
        lifecycle.errorContract,
        CONTRACT_TEXT_PATTERN,
        128,
      ),
    }),
    effects: Object.freeze({
      membership: exactLiteral(effects.membership, ["none"]),
      entitlement: exactLiteral(effects.entitlement, ["none"]),
      credits: exactLiteral(effects.credits, ["none"]),
    }),
  });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function computeAiUserOidcAdapterContractFingerprint(
  contractWithoutFingerprint: unknown,
): string {
  const normalized = normalizeAdapterContractCore(contractWithoutFingerprint);
  return createHash("sha256").update(canonicalJson(normalized)).digest("hex");
}

export function validateAiUserOidcAdapterContract(
  value: unknown,
): AiUserOidcAdapterContract {
  const root = exactDataObject(value, [
    "schema",
    "version",
    "contractId",
    "contractFingerprintSha256",
    "environment",
    "issuerUrl",
    "authorizationEndpointUrl",
    "tokenEndpointUrl",
    "jwksUri",
    "client",
    "redirectUri",
    "audience",
    "scopes",
    "responseType",
    "pkceMethod",
    "stateRequired",
    "nonceRequired",
    "acceptedIdTokenAlgorithms",
    "claims",
    "timePolicy",
    "lifecycle",
    "effects",
  ]);
  const fingerprint = exactString(
    root.contractFingerprintSha256,
    FINGERPRINT_PATTERN,
    64,
  );
  const { contractFingerprintSha256: _fingerprint, ...coreInput } = root;
  void _fingerprint;
  const core = normalizeAdapterContractCore(coreInput);
  const expected = createHash("sha256")
    .update(canonicalJson(core))
    .digest("hex");
  if (fingerprint !== expected) return failContract();
  return Object.freeze({ ...core, contractFingerprintSha256: fingerprint });
}

export function validateAiUserOidcAdapterAuthorityPin(
  value: unknown,
): AiUserOidcAdapterAuthorityPin {
  const pin = exactDataObject(value, [
    "version",
    "contractFingerprintSha256",
  ]);
  return Object.freeze({
    version: exactString(pin.version, CONTRACT_VERSION_PATTERN, 64),
    contractFingerprintSha256: exactString(
      pin.contractFingerprintSha256,
      FINGERPRINT_PATTERN,
      64,
    ),
  });
}

function projection(input: {
  mode: AiUserOidcReadinessProjection["mode"];
  status: AiUserOidcReadinessStatus;
  blockerCodes: readonly AiUserOidcReadinessBlocker[];
  validatedAdapter?: AiUserOidcReadinessProjection["validatedAdapter"];
}): AiUserOidcReadinessProjection {
  return Object.freeze({
    schema: AIUSER_OIDC_READINESS_SCHEMA,
    capability: AIUSER_OIDC_READINESS_CAPABILITY,
    mode: input.mode,
    status: input.status,
    blockerCodes: Object.freeze([...input.blockerCodes]),
    requiredAdapterInputs: AIUSER_OIDC_REQUIRED_ADAPTER_INPUTS,
    requiredAuthorityPinInputs: AIUSER_OIDC_REQUIRED_AUTHORITY_PIN_INPUTS,
    ...(input.validatedAdapter
      ? { validatedAdapter: Object.freeze({ ...input.validatedAdapter }) }
      : {}),
    loginEnabled: false,
    callbackEnabled: false,
    tokenExchangeAllowed: false,
    sessionIssuanceAllowed: false,
    accountLinkingAllowed: false,
    membershipMutationAllowed: false,
    entitlementMutationAllowed: false,
    creditGrantAllowed: false,
    networkAllowed: false,
    networkCalls: 0,
    writesPerformed: 0,
  });
}

export function evaluateAiUserOidcReadiness(input: {
  mode: unknown;
  adapterContract?: unknown;
  adapterAuthorityPin?: unknown;
}): AiUserOidcReadinessProjection {
  if (
    input.mode === undefined
    || input.mode === null
    || input.mode === ""
    || input.mode === AIUSER_OIDC_DISABLED_MODE
  ) {
    return projection({
      mode: AIUSER_OIDC_DISABLED_MODE,
      status: "DISABLED",
      blockerCodes: [
        "oidc_runtime_not_implemented",
        "oidc_login_not_authorized",
        "membership_and_entitlement_side_effects_forbidden",
      ],
    });
  }
  if (input.mode !== AIUSER_OIDC_LOCAL_VALIDATE_MODE) {
    return projection({
      mode: "invalid",
      status: "BLOCKED_INVALID_CONFIGURATION",
      blockerCodes: [
        "invalid_readiness_mode",
        "oidc_runtime_not_implemented",
        "oidc_login_not_authorized",
        "membership_and_entitlement_side_effects_forbidden",
      ],
    });
  }
  if (input.adapterContract === undefined) {
    return projection({
      mode: AIUSER_OIDC_LOCAL_VALIDATE_MODE,
      status: "BLOCKED_ADAPTER_CONTRACT_REQUIRED",
      blockerCodes: [
        "versioned_aiuser_adapter_contract_required",
        "oidc_runtime_not_implemented",
        "oidc_login_not_authorized",
        "membership_and_entitlement_side_effects_forbidden",
      ],
    });
  }
  let contract: AiUserOidcAdapterContract;
  try {
    contract = validateAiUserOidcAdapterContract(input.adapterContract);
  } catch {
    return projection({
      mode: AIUSER_OIDC_LOCAL_VALIDATE_MODE,
      status: "BLOCKED_INVALID_ADAPTER_CONTRACT",
      blockerCodes: [
        "invalid_aiuser_adapter_contract",
        "oidc_runtime_not_implemented",
        "oidc_login_not_authorized",
        "membership_and_entitlement_side_effects_forbidden",
      ],
    });
  }
  if (input.adapterAuthorityPin === undefined) {
    return projection({
      mode: AIUSER_OIDC_LOCAL_VALIDATE_MODE,
      status: "BLOCKED_ADAPTER_AUTHORITY_PIN_REQUIRED",
      blockerCodes: [
        "adapter_contract_authority_pin_required",
        "oidc_runtime_not_implemented",
        "oidc_login_not_authorized",
        "membership_and_entitlement_side_effects_forbidden",
      ],
    });
  }
  try {
    const pin = validateAiUserOidcAdapterAuthorityPin(
      input.adapterAuthorityPin,
    );
    if (
      pin.version !== contract.version
      || pin.contractFingerprintSha256
        !== contract.contractFingerprintSha256
    ) {
      throw new AiUserOidcReadinessError("invalid_configuration");
    }
  } catch {
    return projection({
      mode: AIUSER_OIDC_LOCAL_VALIDATE_MODE,
      status: "BLOCKED_INVALID_ADAPTER_AUTHORITY_PIN",
      blockerCodes: [
        "invalid_adapter_contract_authority_pin",
        "oidc_runtime_not_implemented",
        "oidc_login_not_authorized",
        "membership_and_entitlement_side_effects_forbidden",
      ],
    });
  }
  return projection({
    mode: AIUSER_OIDC_LOCAL_VALIDATE_MODE,
    status: "LOCAL_CONFIGURATION_VALIDATED_ONLY",
    blockerCodes: [
      "oidc_runtime_not_implemented",
      "oidc_login_not_authorized",
      "membership_and_entitlement_side_effects_forbidden",
    ],
    validatedAdapter: {
      version: contract.version,
      contractFingerprintSha256: contract.contractFingerprintSha256,
    },
  });
}

export function evaluateAiUserOidcReadinessFromEnvironment(input: {
  environment: unknown;
  adapterContract?: unknown;
  adapterAuthorityPin?: unknown;
}): AiUserOidcReadinessProjection {
  let mode: unknown;
  if (typeof input.environment === "object" && input.environment !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(
      input.environment,
      AIUSER_OIDC_READINESS_MODE_ENV,
    );
    mode = descriptor && "value" in descriptor
      ? descriptor.value
      : descriptor
        ? Symbol("invalid_environment_accessor")
        : undefined;
  } else if (input.environment !== undefined) {
    mode = Symbol("invalid_environment");
  }
  return evaluateAiUserOidcReadiness({
    mode,
    adapterContract: input.adapterContract,
    adapterAuthorityPin: input.adapterAuthorityPin,
  });
}
