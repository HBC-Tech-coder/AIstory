import assert from "node:assert/strict";
import {
  LINGHAO_PASSPORT_V4_PRODUCTION_CONFIG_FILE_ENV,
  LINGHAO_PASSPORT_V4_PRODUCTION_MODE,
  LINGHAO_PASSPORT_V4_PRODUCTION_MODE_ENV,
  LINGHAO_PASSPORT_V4_PRODUCTION_PATHS,
  LINGHAO_PASSPORT_V4_PRODUCTION_REGISTRATION,
  LINGHAO_PASSPORT_V4_PRODUCTION_REGISTRATION_SHA256,
  LINGHAO_PASSPORT_V4_PUBLIC_ENTRY_MODE,
  LINGHAO_PASSPORT_V4_PUBLIC_ENTRY_MODE_ENV,
  linghaoPassportV4ProductionConfigFileReference,
  linghaoPassportV4ProductionModeRequested,
  linghaoPassportV4PublicEntryRequested,
  validateLinghaoPassportV4HostReceipt,
  validateLinghaoPassportV4ProductionConfiguration,
  validateLinghaoPassportV4RegistryReceipt,
} from "../lib/auth/linghaoPassportV4ProductionContract";
import {
  createLinghaoPassportV4ProductSessionCandidate,
  decideLinghaoPassportV4EntryCutover,
  decideLinghaoPassportV4SessionPrecedence,
  deriveLinghaoPassportV4PrincipalKey,
  linghaoPassportV4PublicAccount,
} from "../lib/auth/linghaoPassportV4ProductionSession";
import {
  assertLinghaoPassportV4ProtectedFile,
  decodeLinghaoPassportV4StateSealKey,
} from "../lib/auth/linghaoPassportV4ProductionLoader";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const UID = 950;
const GID = 950;

const protectedMetadata = {
  regular: true,
  symbolicLink: false,
  uid: UID,
  gid: GID,
  mode: 0o100400,
  nlink: 1,
  size: 64,
};
assert.doesNotThrow(() =>
  assertLinghaoPassportV4ProtectedFile(protectedMetadata, UID, GID, 128),
);
assert.throws(
  () =>
    assertLinghaoPassportV4ProtectedFile(
      { ...protectedMetadata, symbolicLink: true },
      UID,
      GID,
      128,
    ),
  /production_runtime_unavailable/,
);
assert.throws(
  () =>
    assertLinghaoPassportV4ProtectedFile(
      { ...protectedMetadata, mode: 0o100644 },
      UID,
      GID,
      128,
    ),
  /production_runtime_unavailable/,
);
assert.equal(
  decodeLinghaoPassportV4StateSealKey(
    Buffer.alloc(32, 17).toString("base64url"),
  ).byteLength,
  32,
);
assert.throws(
  () => decodeLinghaoPassportV4StateSealKey("not-a-key"),
  /production_runtime_unavailable/,
);

function expectRejected(operation: () => unknown): void {
  assert.throws(operation, /linghao_passport_v4_(production|session)_rejected/);
}

function configuration() {
  return {
    schema: "aistory.linghao-passport-v4-production-config.v1",
    registrationSha256:
      LINGHAO_PASSPORT_V4_PRODUCTION_REGISTRATION_SHA256,
    secretRef:
      LINGHAO_PASSPORT_V4_PRODUCTION_REGISTRATION.credentialReference
        .referenceId,
    secretFile: LINGHAO_PASSPORT_V4_PRODUCTION_PATHS.clientSecretFile,
    stateSealKeyRef: "ref_aistory_linghao_passport_v4_state_seal_v1",
    stateSealKeyFile:
      LINGHAO_PASSPORT_V4_PRODUCTION_PATHS.stateSealKeyFile,
    registryReceiptFile:
      LINGHAO_PASSPORT_V4_PRODUCTION_PATHS.registryReceiptFile,
    registryReceiptSha256: HASH_A,
    hostReceiptFile: LINGHAO_PASSPORT_V4_PRODUCTION_PATHS.hostReceiptFile,
    hostReceiptSha256: HASH_B,
    stateDirectory: LINGHAO_PASSPORT_V4_PRODUCTION_PATHS.stateDirectory,
    recipientUid: UID,
    recipientGid: GID,
    proxyRequestOrigin: "https://127.0.0.1:4200",
    authRepository: "supabase" as const,
    authDatabaseGateVersion: "20261119120000" as const,
    ingressRateBucketHeader: "x-aistory-passport-rate-bucket" as const,
  };
}

function registryReceipt() {
  const registration = LINGHAO_PASSPORT_V4_PRODUCTION_REGISTRATION;
  return {
    schema: "aistory.linghao-passport-v4-registry-receipt.v1",
    registrationSha256:
      LINGHAO_PASSPORT_V4_PRODUCTION_REGISTRATION_SHA256,
    issuer: registration.issuer,
    clientId: registration.clientId,
    redirectUri: registration.redirectUri,
    postLogoutRedirectUri: registration.postLogoutRedirectUri,
    tokenEndpointAuthMethod: registration.tokenEndpointAuthMethod,
    idTokenSigningAlgorithm: registration.idTokenSigningAlgorithm,
    scopes: [...registration.scopes],
    registered: true,
    issuerLiveVerified: true,
    discoveryIssuerVerified: true,
    jwksVerified: true,
    wrongRedirectRejected: true,
    wrongLogoutRedirectRejected: true,
  };
}

function hostReceipt() {
  const config = configuration();
  return {
    schema: "aistory.linghao-passport-v4-host-acceptance.v1",
    registrationSha256: config.registrationSha256,
    registryReceiptSha256: config.registryReceiptSha256,
    secretRef: config.secretRef,
    secretFile: config.secretFile,
    stateSealKeyRef: config.stateSealKeyRef,
    stateSealKeyFile: config.stateSealKeyFile,
    stateDirectory: config.stateDirectory,
    recipientUid: config.recipientUid,
    recipientGid: config.recipientGid,
    proxyRequestOrigin: config.proxyRequestOrigin,
    authRepository: config.authRepository,
    authDatabaseGateVersion: config.authDatabaseGateVersion,
    ingressRateBucketHeader: config.ingressRateBucketHeader,
    distinctSecretDelivered: true,
    clientAndStateKeysDistinctVerified: true,
    recipientAclVerified: true,
    durableStateVerified: true,
    databasePostureVerified: true,
    multiWorkerVerified: true,
    restartPersistenceVerified: true,
    ingressRedactionVerified: true,
    startRateLimitVerified: true,
    loopbackIngressVerified: true,
    forwardedHeaderScrubbingVerified: true,
    legacyRollbackVerified: true,
    noLegacyMigrationVerified: true,
  };
}

const registration = LINGHAO_PASSPORT_V4_PRODUCTION_REGISTRATION;
assert.deepEqual(registration.scopes, ["openid", "profile", "email"]);
assert.equal(registration.publicOrigin, "https://play.hibcglobal.com");
assert.equal(registration.issuer, "https://passport.hibcglobal.com");
assert.equal(registration.clientId, "aistory-production-passport-v4-web");
assert.equal(registration.idTokenAudience, registration.clientId);
assert.equal(registration.accessResource, null);
assert.equal(registration.effects.legacyAccountRead, "none");
assert.equal(registration.effects.legacyAccountLink, "none");
assert.equal(registration.effects.administratorGrant, "none");
assert.equal(registration.effects.creditGrant, "none");
assert.match(
  LINGHAO_PASSPORT_V4_PRODUCTION_REGISTRATION_SHA256,
  /^[a-f0-9]{64}$/,
);
assert.doesNotMatch(
  JSON.stringify(registration),
  /127\.0\.0\.1|localhost|aistory-local-passport-v4-web|id\.hibcglobal\.com/,
);

const environment = {
  NODE_ENV: "production",
  [LINGHAO_PASSPORT_V4_PRODUCTION_MODE_ENV]:
    LINGHAO_PASSPORT_V4_PRODUCTION_MODE,
  [LINGHAO_PASSPORT_V4_PRODUCTION_CONFIG_FILE_ENV]:
    LINGHAO_PASSPORT_V4_PRODUCTION_PATHS.configFile,
};
assert.equal(
  linghaoPassportV4ProductionModeRequested(environment, "linux"),
  true,
);
assert.equal(
  linghaoPassportV4ProductionModeRequested(environment, "win32"),
  false,
);
assert.equal(
  linghaoPassportV4ProductionModeRequested(
    { ...environment, NODE_ENV: "test" },
    "linux",
  ),
  false,
);
assert.equal(
  linghaoPassportV4ProductionConfigFileReference(environment, "linux"),
  LINGHAO_PASSPORT_V4_PRODUCTION_PATHS.configFile,
);
assert.equal(linghaoPassportV4PublicEntryRequested(environment, "linux"), false);
assert.equal(
  linghaoPassportV4PublicEntryRequested({
    ...environment,
    [LINGHAO_PASSPORT_V4_PUBLIC_ENTRY_MODE_ENV]:
      LINGHAO_PASSPORT_V4_PUBLIC_ENTRY_MODE,
  }, "linux"),
  true,
);
assert.equal(
  linghaoPassportV4ProductionConfigFileReference(
    {
      ...environment,
      [LINGHAO_PASSPORT_V4_PRODUCTION_CONFIG_FILE_ENV]:
        "/etc/aistory/linghao-passport-v4/wrong.json",
    },
    "linux",
  ),
  null,
);

const acceptedConfig = validateLinghaoPassportV4ProductionConfiguration(
  configuration(),
);
validateLinghaoPassportV4RegistryReceipt(registryReceipt());
validateLinghaoPassportV4HostReceipt(hostReceipt(), acceptedConfig);

for (const mutation of [
  { registrationSha256: "0".repeat(64) },
  { secretFile: "/etc/aistory/aiuser-oidc/client-secret" },
  { stateSealKeyFile: "/etc/aistory/aiuser-oidc/client-secret" },
  { stateDirectory: "/var/lib/aistory/aiuser-oidc-replay" },
  { proxyRequestOrigin: "http://127.0.0.1:4200" },
  { proxyRequestOrigin: "https://play.hibcglobal.com" },
  { recipientUid: -1 },
  { authDatabaseGateVersion: "20260811193000" },
]) {
  expectRejected(() =>
    validateLinghaoPassportV4ProductionConfiguration({
      ...configuration(),
      ...mutation,
    }),
  );
}
expectRejected(() =>
  validateLinghaoPassportV4ProductionConfiguration({
    ...configuration(),
    extra: true,
  }),
);
const getterConfig = configuration() as Record<string, unknown>;
Object.defineProperty(getterConfig, "secretFile", {
  enumerable: true,
  get() {
    throw new Error("getter must not run");
  },
});
expectRejected(() =>
  validateLinghaoPassportV4ProductionConfiguration(getterConfig),
);

expectRejected(() =>
  validateLinghaoPassportV4RegistryReceipt({
    ...registryReceipt(),
    clientId: "aistory-local-passport-v4-web",
  }),
);
expectRejected(() =>
  validateLinghaoPassportV4RegistryReceipt({
    ...registryReceipt(),
    issuerLiveVerified: false,
  }),
);
expectRejected(() =>
  validateLinghaoPassportV4RegistryReceipt({
    ...registryReceipt(),
    scopes: ["openid", "profile", "email", "offline_access"],
  }),
);
expectRejected(() =>
  validateLinghaoPassportV4HostReceipt(
    { ...hostReceipt(), durableStateVerified: false },
    acceptedConfig,
  ),
);
expectRejected(() =>
  validateLinghaoPassportV4HostReceipt(
    { ...hostReceipt(), clientAndStateKeysDistinctVerified: false },
    acceptedConfig,
  ),
);
expectRejected(() =>
  validateLinghaoPassportV4HostReceipt(
    { ...hostReceipt(), databasePostureVerified: false },
    acceptedConfig,
  ),
);

const nowMs = 1_800_000_000_000;
const subject = "new-passport-user-01";
const principal = deriveLinghaoPassportV4PrincipalKey(
  registration.issuer,
  registration.clientId,
  subject,
);
assert.match(principal, /^[a-f0-9]{64}$/);
assert.notEqual(
  principal,
  deriveLinghaoPassportV4PrincipalKey(
    registration.issuer,
    registration.clientId,
    "new-passport-user-02",
  ),
);
expectRejected(() =>
  deriveLinghaoPassportV4PrincipalKey(
    "http://127.0.0.1:8000",
    registration.clientId,
    subject,
  ),
);

const session = createLinghaoPassportV4ProductSessionCandidate({
  issuer: registration.issuer,
  clientId: registration.clientId,
  subject,
  sessionBinding: "c".repeat(64),
  authenticatedAtMs: nowMs - 1000,
  expiresAtMs: nowMs + 30 * 60 * 1000,
  nowMs,
});
assert.equal(session.principalKey, principal);
assert.equal(session.userId, `passport_v4:${principal}`);
const account = linghaoPassportV4PublicAccount(session);
assert.equal(account.authType, "passport_v4");
assert.equal(account.balance, null);
assert.deepEqual(account.ledger, []);
assert.equal(account.capabilities.ordinaryProductAccess, true);
assert.equal(account.capabilities.newContentNamespace, true);
for (const denied of [
  "legacyAccountRead",
  "legacyAccountLink",
  "administrator",
  "phoneAccount",
  "formalWallet",
  "platformPaidGeneration",
  "cloudProgress",
  "hostedByok",
] as const) {
  assert.equal(account.capabilities[denied], false);
}
assert.doesNotMatch(JSON.stringify(account), new RegExp(subject));
assert.doesNotMatch(JSON.stringify(account), new RegExp(principal));
assert.doesNotMatch(JSON.stringify(account), /email|phoneUserId|credit/i);

assert.equal(
  decideLinghaoPassportV4SessionPrecedence({ state: "absent" }).state,
  "legacy_fallback_allowed",
);
assert.equal(
  decideLinghaoPassportV4SessionPrecedence({ state: "invalid" }).state,
  "reject_invalid_passport",
);
assert.equal(
  decideLinghaoPassportV4SessionPrecedence({
    state: "authenticated",
    session,
  }).state,
  "passport",
);
assert.deepEqual(
  decideLinghaoPassportV4EntryCutover({
    passportPublicEnabled: true,
    legacyEntryAvailable: true,
  }),
  {
    primaryEntry: "passport_v4",
    legacyRollbackEntry: true,
    finalDeliveryAccepted: true,
  },
);
assert.equal(
  decideLinghaoPassportV4EntryCutover({
    passportPublicEnabled: false,
    legacyEntryAvailable: true,
  }).finalDeliveryAccepted,
  false,
);

console.log("PASS_LINGHAO_PASSPORT_V4_PRODUCTION_CONTRACT");
console.log(
  JSON.stringify({
    assertions: 60,
    registrationSha256:
      LINGHAO_PASSPORT_V4_PRODUCTION_REGISTRATION_SHA256,
    productionEnabled: false,
    remoteRegistration: false,
    credentialAccessed: false,
    oldUserDataAccessed: false,
    administratorGranted: false,
    creditsGranted: 0,
  }),
);

