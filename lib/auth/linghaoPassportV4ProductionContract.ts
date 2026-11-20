import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import {
  LINGHAO_PASSPORT_V4_PRODUCTION_CALLBACK,
  LINGHAO_PASSPORT_V4_PRODUCTION_CLIENT_ID,
  LINGHAO_PASSPORT_V4_PRODUCTION_ISSUER,
  LINGHAO_PASSPORT_V4_PRODUCTION_ORIGIN,
  LINGHAO_PASSPORT_V4_PRODUCTION_POST_LOGOUT,
  LINGHAO_PASSPORT_V4_PRODUCTION_SCOPES,
} from "./linghaoPassportV4ProductionPublic";

export const LINGHAO_PASSPORT_V4_PRODUCTION_REGISTRATION = Object.freeze({
  schema: "aistory.linghao-passport-v4-production-registration.v1" as const,
  version: "production-v1" as const,
  productId: "aistory" as const,
  publicOrigin: LINGHAO_PASSPORT_V4_PRODUCTION_ORIGIN,
  issuer: LINGHAO_PASSPORT_V4_PRODUCTION_ISSUER,
  clientId: LINGHAO_PASSPORT_V4_PRODUCTION_CLIENT_ID,
  redirectUri: LINGHAO_PASSPORT_V4_PRODUCTION_CALLBACK,
  postLogoutRedirectUri: LINGHAO_PASSPORT_V4_PRODUCTION_POST_LOGOUT,
  clientType: "confidential_web" as const,
  responseType: "code" as const,
  pkceMethod: "S256" as const,
  tokenEndpointAuthMethod: "client_secret_basic" as const,
  idTokenSigningAlgorithm: "RS256" as const,
  idTokenAudience: LINGHAO_PASSPORT_V4_PRODUCTION_CLIENT_ID,
  accessResource: null,
  scopes: LINGHAO_PASSPORT_V4_PRODUCTION_SCOPES,
  credentialReference: Object.freeze({
    kind: "protected_file" as const,
    referenceId: "ref_aistory_linghao_passport_v4_production_v1" as const,
  }),
  effects: Object.freeze({
    legacyAccountRead: "none" as const,
    legacyAccountLink: "none" as const,
    administratorGrant: "none" as const,
    creditGrant: "none" as const,
    membershipGrant: "none" as const,
  }),
});

export const LINGHAO_PASSPORT_V4_PRODUCTION_REGISTRATION_SHA256 = createHash(
  "sha256",
)
  .update(JSON.stringify(LINGHAO_PASSPORT_V4_PRODUCTION_REGISTRATION), "utf8")
  .digest("hex");

export const LINGHAO_PASSPORT_V4_PRODUCTION_MODE_ENV =
  "AISTORY_LINGHAO_PASSPORT_V4_PRODUCTION_MODE";
export const LINGHAO_PASSPORT_V4_PRODUCTION_MODE =
  "aistory-linghao-passport-v4-production-v1:enabled";
export const LINGHAO_PASSPORT_V4_PRODUCTION_CONFIG_FILE_ENV =
  "AISTORY_LINGHAO_PASSPORT_V4_PRODUCTION_CONFIG_FILE";
export const LINGHAO_PASSPORT_V4_PUBLIC_ENTRY_MODE_ENV =
  "AISTORY_LINGHAO_PASSPORT_V4_PUBLIC_ENTRY_MODE";
export const LINGHAO_PASSPORT_V4_PUBLIC_ENTRY_MODE =
  "aistory-linghao-passport-v4-public-entry-v1:enabled";

export const LINGHAO_PASSPORT_V4_PRODUCTION_PATHS = Object.freeze({
  configFile: "/etc/aistory/linghao-passport-v4/production-v1.json" as const,
  clientSecretFile:
    "/etc/aistory/linghao-passport-v4/client-secret.v1" as const,
  stateSealKeyFile:
    "/etc/aistory/linghao-passport-v4/state-seal-key.v1" as const,
  registryReceiptFile:
    "/etc/aistory/linghao-passport-v4/registry-receipt-v1.json" as const,
  hostReceiptFile:
    "/etc/aistory/linghao-passport-v4/host-acceptance-v1.json" as const,
  stateDirectory: "/var/lib/aistory/linghao-passport-v4/state-v1" as const,
});

const HASH = /^[a-f0-9]{64}$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export type LinghaoPassportV4ProductionEnvironment = Readonly<
  Record<string, string | undefined>
>;

export type LinghaoPassportV4ProductionConfiguration = Readonly<{
  schema: "aistory.linghao-passport-v4-production-config.v1";
  registrationSha256: string;
  secretRef: string;
  secretFile: string;
  stateSealKeyRef: string;
  stateSealKeyFile: string;
  registryReceiptFile: string;
  registryReceiptSha256: string;
  hostReceiptFile: string;
  hostReceiptSha256: string;
  stateDirectory: string;
  recipientUid: number;
  recipientGid: number;
  proxyRequestOrigin: string;
  authRepository: "supabase";
  authDatabaseGateVersion: "20261119120000";
  ingressRateBucketHeader: "x-aistory-passport-rate-bucket";
}>;

function reject(): never {
  throw new Error("linghao_passport_v4_production_rejected");
}

function inertData(value: unknown, depth = 0): unknown {
  if (depth > 8) reject();
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object") reject();

  const array = Array.isArray(value);
  if (
    Object.getPrototypeOf(value) !==
    (array ? Array.prototype : Object.prototype)
  ) {
    reject();
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > 64) reject();
  const output: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    if (array && key === "length") continue;
    if (
      typeof key !== "string" ||
      key === "__proto__" ||
      key === "constructor" ||
      key === "prototype"
    ) {
      reject();
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      reject();
    }
    output[key] = inertData(descriptor.value, depth + 1);
  }
  if (!array) return Object.fromEntries(Object.entries(output));
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > 16 ||
    keys.length !== length + 1
  ) {
    reject();
  }
  return Array.from({ length }, (_, index) => {
    const key = String(index);
    return Object.hasOwn(output, key) ? output[key] : reject();
  });
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  const data = inertData(value);
  if (!data || typeof data !== "object" || Array.isArray(data)) reject();
  const record = data as Record<string, unknown>;
  if (
    Object.keys(record).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(record, key))
  ) {
    reject();
  }
  return record;
}

function safeEqual(left: unknown, right: string): boolean {
  if (typeof left !== "string" || left.length > 4096) return false;
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  if (leftBytes.length !== rightBytes.length) {
    timingSafeEqual(leftBytes, leftBytes);
    return false;
  }
  return timingSafeEqual(leftBytes, rightBytes);
}

function exactHash(value: unknown): string {
  if (typeof value !== "string" || !HASH.test(value)) reject();
  return value;
}

function exactInteger(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 2_147_483_647
  ) {
    reject();
  }
  return value;
}

function exactProxyOrigin(value: unknown): string {
  if (typeof value !== "string" || value.length > 128) reject();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return reject();
  }
  if (
    url.protocol !== "https:" ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    !url.port ||
    url.origin !== value ||
    url.pathname !== "/" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    reject();
  }
  return value;
}

export function linghaoPassportV4ProductionModeRequested(
  environment: LinghaoPassportV4ProductionEnvironment,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return (
    platform === "linux" &&
    environment.NODE_ENV === "production" &&
    environment[LINGHAO_PASSPORT_V4_PRODUCTION_MODE_ENV] ===
      LINGHAO_PASSPORT_V4_PRODUCTION_MODE
  );
}

export function linghaoPassportV4ProductionConfigFileReference(
  environment: LinghaoPassportV4ProductionEnvironment,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (!linghaoPassportV4ProductionModeRequested(environment, platform)) {
    return null;
  }
  return environment[LINGHAO_PASSPORT_V4_PRODUCTION_CONFIG_FILE_ENV] ===
    LINGHAO_PASSPORT_V4_PRODUCTION_PATHS.configFile
    ? LINGHAO_PASSPORT_V4_PRODUCTION_PATHS.configFile
    : null;
}

export function validateLinghaoPassportV4ProductionConfiguration(
  value: unknown,
): LinghaoPassportV4ProductionConfiguration {
  const data = exactRecord(value, [
    "schema",
    "registrationSha256",
    "secretRef",
    "secretFile",
    "stateSealKeyRef",
    "stateSealKeyFile",
    "registryReceiptFile",
    "registryReceiptSha256",
    "hostReceiptFile",
    "hostReceiptSha256",
    "stateDirectory",
    "recipientUid",
    "recipientGid",
    "proxyRequestOrigin",
    "authRepository",
    "authDatabaseGateVersion",
    "ingressRateBucketHeader",
  ]);
  if (
    data.schema !== "aistory.linghao-passport-v4-production-config.v1" ||
    !safeEqual(
      data.registrationSha256,
      LINGHAO_PASSPORT_V4_PRODUCTION_REGISTRATION_SHA256,
    ) ||
    !safeEqual(
      data.secretRef,
      LINGHAO_PASSPORT_V4_PRODUCTION_REGISTRATION.credentialReference
        .referenceId,
    ) ||
    data.secretFile !== LINGHAO_PASSPORT_V4_PRODUCTION_PATHS.clientSecretFile ||
    data.stateSealKeyRef !==
      "ref_aistory_linghao_passport_v4_state_seal_v1" ||
    data.stateSealKeyFile !==
      LINGHAO_PASSPORT_V4_PRODUCTION_PATHS.stateSealKeyFile ||
    data.registryReceiptFile !==
      LINGHAO_PASSPORT_V4_PRODUCTION_PATHS.registryReceiptFile ||
    data.hostReceiptFile !==
      LINGHAO_PASSPORT_V4_PRODUCTION_PATHS.hostReceiptFile ||
    data.stateDirectory !==
      LINGHAO_PASSPORT_V4_PRODUCTION_PATHS.stateDirectory ||
    data.authRepository !== "supabase" ||
    data.authDatabaseGateVersion !== "20261119120000" ||
    data.ingressRateBucketHeader !== "x-aistory-passport-rate-bucket"
  ) {
    reject();
  }
  exactHash(data.registryReceiptSha256);
  exactHash(data.hostReceiptSha256);
  exactInteger(data.recipientUid);
  exactInteger(data.recipientGid);
  exactProxyOrigin(data.proxyRequestOrigin);
  return Object.freeze(data) as LinghaoPassportV4ProductionConfiguration;
}

export function validateLinghaoPassportV4RegistryReceipt(value: unknown): void {
  const data = exactRecord(value, [
    "schema",
    "registrationSha256",
    "issuer",
    "clientId",
    "redirectUri",
    "postLogoutRedirectUri",
    "tokenEndpointAuthMethod",
    "idTokenSigningAlgorithm",
    "scopes",
    "registered",
    "issuerLiveVerified",
    "discoveryIssuerVerified",
    "jwksVerified",
    "wrongRedirectRejected",
    "wrongLogoutRedirectRejected",
  ]);
  const registration = LINGHAO_PASSPORT_V4_PRODUCTION_REGISTRATION;
  if (
    data.schema !== "aistory.linghao-passport-v4-registry-receipt.v1" ||
    !safeEqual(
      data.registrationSha256,
      LINGHAO_PASSPORT_V4_PRODUCTION_REGISTRATION_SHA256,
    ) ||
    !safeEqual(data.issuer, registration.issuer) ||
    !safeEqual(data.clientId, registration.clientId) ||
    !safeEqual(data.redirectUri, registration.redirectUri) ||
    !safeEqual(data.postLogoutRedirectUri, registration.postLogoutRedirectUri) ||
    data.tokenEndpointAuthMethod !== registration.tokenEndpointAuthMethod ||
    data.idTokenSigningAlgorithm !== registration.idTokenSigningAlgorithm ||
    !Array.isArray(data.scopes) ||
    data.scopes.length !== registration.scopes.length ||
    data.scopes.some((scope, index) => scope !== registration.scopes[index])
  ) {
    reject();
  }
  for (const key of [
    "registered",
    "issuerLiveVerified",
    "discoveryIssuerVerified",
    "jwksVerified",
    "wrongRedirectRejected",
    "wrongLogoutRedirectRejected",
  ]) {
    if (data[key] !== true) reject();
  }
}

export function validateLinghaoPassportV4HostReceipt(
  value: unknown,
  configuration: LinghaoPassportV4ProductionConfiguration,
): void {
  const data = exactRecord(value, [
    "schema",
    "registrationSha256",
    "registryReceiptSha256",
    "secretRef",
    "secretFile",
    "stateSealKeyRef",
    "stateSealKeyFile",
    "stateDirectory",
    "recipientUid",
    "recipientGid",
    "proxyRequestOrigin",
    "authRepository",
    "authDatabaseGateVersion",
    "ingressRateBucketHeader",
    "distinctSecretDelivered",
    "clientAndStateKeysDistinctVerified",
    "recipientAclVerified",
    "durableStateVerified",
    "databasePostureVerified",
    "multiWorkerVerified",
    "restartPersistenceVerified",
    "ingressRedactionVerified",
    "startRateLimitVerified",
    "loopbackIngressVerified",
    "forwardedHeaderScrubbingVerified",
    "legacyRollbackVerified",
    "noLegacyMigrationVerified",
  ]);
  if (
    data.schema !== "aistory.linghao-passport-v4-host-acceptance.v1" ||
    !safeEqual(data.registrationSha256, configuration.registrationSha256) ||
    !safeEqual(
      data.registryReceiptSha256,
      configuration.registryReceiptSha256,
    ) ||
    !safeEqual(data.secretRef, configuration.secretRef) ||
    data.secretFile !== configuration.secretFile ||
    data.stateSealKeyRef !== configuration.stateSealKeyRef ||
    data.stateSealKeyFile !== configuration.stateSealKeyFile ||
    data.stateDirectory !== configuration.stateDirectory ||
    data.recipientUid !== configuration.recipientUid ||
    data.recipientGid !== configuration.recipientGid ||
    data.proxyRequestOrigin !== configuration.proxyRequestOrigin
    || data.authRepository !== configuration.authRepository
    || data.authDatabaseGateVersion !== configuration.authDatabaseGateVersion
    || data.ingressRateBucketHeader !== configuration.ingressRateBucketHeader
  ) {
    reject();
  }
  for (const key of [
    "distinctSecretDelivered",
    "clientAndStateKeysDistinctVerified",
    "recipientAclVerified",
    "durableStateVerified",
    "databasePostureVerified",
    "multiWorkerVerified",
    "restartPersistenceVerified",
    "ingressRedactionVerified",
    "startRateLimitVerified",
    "loopbackIngressVerified",
    "forwardedHeaderScrubbingVerified",
    "legacyRollbackVerified",
    "noLegacyMigrationVerified",
  ]) {
    if (data[key] !== true) reject();
  }
}

export function linghaoPassportV4PublicEntryRequested(
  environment: LinghaoPassportV4ProductionEnvironment,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return linghaoPassportV4ProductionModeRequested(environment, platform)
    && environment[LINGHAO_PASSPORT_V4_PUBLIC_ENTRY_MODE_ENV]
      === LINGHAO_PASSPORT_V4_PUBLIC_ENTRY_MODE;
}

