import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

type CompanyAccountProductGrantPolicy = import("../lib/company-account/v1/productGrant").CompanyAccountProductGrantPolicy;
type CompanyAccountProductGrantPrincipalContext = import("../lib/company-account/v1/productGrant").CompanyAccountProductGrantPrincipalContext;
type CompanyAccountProductGrantRepository = import("../lib/company-account/v1/productGrant").CompanyAccountProductGrantRepository;
type CompanyAccountSessionRepository = import("../lib/company-account/v1/session").CompanyAccountSessionRepository;
type HarnessDeskProxyPipelineDependencies = import("../lib/company-account/v1/proxyPolicy").HarnessDeskProxyPipelineDependencies;
type HarnessDeskProxyPolicyConfig = import("../lib/company-account/v1/proxyPolicy").HarnessDeskProxyPolicyConfig;

let networkCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = (async () => {
  networkCalls += 1;
  throw new Error("network_forbidden");
}) as typeof fetch;

const [capabilityRoute, contracts, grants, proxyPolicy, sessions] =
  await Promise.all([
    import("../app/api/company-account/v1/capabilities/route"),
    import("../lib/company-account/v1/contracts"),
    import("../lib/company-account/v1/productGrant"),
    import("../lib/company-account/v1/proxyPolicy"),
    import("../lib/company-account/v1/session"),
  ]);
const { GET: getCapabilities } = capabilityRoute;
const {
  COMPANY_ACCOUNT_AUDIENCE,
  COMPANY_ACCOUNT_BRAND,
  COMPANY_ACCOUNT_CHANNEL_ID,
  COMPANY_ACCOUNT_CLIENT_ID,
  COMPANY_ACCOUNT_NO_STORE_HEADERS,
  COMPANY_ACCOUNT_PRODUCT_ID,
  COMPANY_ACCOUNT_SCHEMA_VERSION,
  buildCompanyAccountCapabilities,
  buildCompanyAccountClientContext,
  buildCompanyAccountErrorDto,
  parseCompanyAccountClientContext,
} = contracts;
const {
  MemoryCompanyAccountProductGrantRepository,
  COMPANY_ACCOUNT_PRODUCT_GRANT_DISABLED_POLICY,
  CompanyAccountProductGrantError,
  createCompanyAccountProductGrantService: createProductGrantServiceContract,
  productGrantSemanticFingerprint,
} = grants;
const {
  HARNESSDESK_PROXY_ADAPTER_ID,
  HARNESSDESK_PROXY_CAPABILITY_ID,
  HARNESSDESK_PROXY_DISABLED_CONFIG,
  HARNESSDESK_PROXY_OPERATION,
  HARNESSDESK_PROXY_UPSTREAM_ID,
  HarnessDeskProxyPolicyError,
  runFakeHarnessDeskProxyContractPipeline,
} = proxyPolicy;
const {
  COMPANY_ACCOUNT_SESSION_ISSUER,
  COMPANY_ACCOUNT_SESSION_SCOPES,
  MemoryCompanyAccountSessionRepository,
  CompanyAccountSessionError,
  createCompanyAccountSessionService,
  derivePkceS256Challenge,
} = sessions;

const clientContext = buildCompanyAccountClientContext();
assert.deepEqual(clientContext, {
  schemaVersion: 1,
  productId: "harnessdesk-desktop",
  clientId: "harnessdesk-windows",
  audience: "urn:hbc:company-account:harnessdesk-desktop",
  channelId: "harnessdesk-windows",
});
assert.equal(COMPANY_ACCOUNT_SCHEMA_VERSION, 1);
assert.equal(COMPANY_ACCOUNT_BRAND, "HarnessDesk");
assert.equal(COMPANY_ACCOUNT_PRODUCT_ID, "harnessdesk-desktop");
assert.equal(COMPANY_ACCOUNT_CLIENT_ID, "harnessdesk-windows");
assert.equal(COMPANY_ACCOUNT_CHANNEL_ID, "harnessdesk-windows");
assert.equal(
  COMPANY_ACCOUNT_AUDIENCE,
  "urn:hbc:company-account:harnessdesk-desktop",
);
assert.deepEqual(parseCompanyAccountClientContext(clientContext), clientContext);

const SUPERSEDED_COMPANY_ACCOUNT_IDENTIFIERS = Object.freeze({
  brand: "TriLife Desk",
  edition: "Harness Edition",
  productId: "trilife-harness-desktop",
  clientId: "trilife-desk-windows",
  audience: "urn:hbc:company-account:trilife-harness-desktop",
  channelId: "trilife-desk-windows",
  grantVersion: "trilife-harness-launch-v1",
  sessionHashNamespace: "trilife-company-account-v1",
});

for (const invalid of [
  null,
  [],
  { ...clientContext, schemaVersion: 2 },
  {
    ...clientContext,
    productId: SUPERSEDED_COMPANY_ACCOUNT_IDENTIFIERS.productId,
  },
  {
    ...clientContext,
    clientId: SUPERSEDED_COMPANY_ACCOUNT_IDENTIFIERS.clientId,
  },
  {
    ...clientContext,
    audience: SUPERSEDED_COMPANY_ACCOUNT_IDENTIFIERS.audience,
  },
  {
    ...clientContext,
    channelId: SUPERSEDED_COMPANY_ACCOUNT_IDENTIFIERS.channelId,
  },
  { ...clientContext, clientId: "aistory-web" },
  { ...clientContext, audience: "deepseek" },
  { ...clientContext, channelId: "desktop" },
  { ...clientContext, tenantId: "attacker" },
  { ...clientContext, token: "PRIVATE_TOKEN_MARKER" },
]) {
  assert.equal(parseCompanyAccountClientContext(invalid), null);
}

const inheritedContext = Object.create({ productId: COMPANY_ACCOUNT_PRODUCT_ID });
Object.assign(inheritedContext, clientContext);
assert.equal(parseCompanyAccountClientContext(inheritedContext), null);

const accessorContext = { ...clientContext } as Record<string, unknown>;
Object.defineProperty(accessorContext, "productId", {
  enumerable: true,
  get: () => COMPANY_ACCOUNT_PRODUCT_ID,
});
assert.equal(parseCompanyAccountClientContext(accessorContext), null);

const symbolContext = { ...clientContext } as Record<PropertyKey, unknown>;
symbolContext[Symbol("secret")] = "PRIVATE_SYMBOL_MARKER";
assert.equal(parseCompanyAccountClientContext(symbolContext), null);

const hiddenContext = { ...clientContext } as Record<string, unknown>;
Object.defineProperty(hiddenContext, "secret", {
  enumerable: false,
  value: "PRIVATE_HIDDEN_MARKER",
});
assert.equal(parseCompanyAccountClientContext(hiddenContext), null);

const revokedContext = Proxy.revocable({ ...clientContext }, {});
revokedContext.revoke();
assert.doesNotThrow(() => parseCompanyAccountClientContext(revokedContext.proxy));
assert.equal(parseCompanyAccountClientContext(revokedContext.proxy), null);

const safeError = buildCompanyAccountErrorDto("INVALID_REQUEST", {
  requestId: "SECRET_TOKEN_MARKER",
  retryAfterSeconds: 60,
});
assert.deepEqual(safeError, {
  error: {
    code: "INVALID_REQUEST",
    message: "请求格式无效。",
    retryAfterSeconds: 60,
  },
});
assert.deepEqual(
  buildCompanyAccountErrorDto("SERVICE_UNAVAILABLE", {
    requestId: "ca1-0123456789abcdef0123456789abcdef",
  }).error.requestId,
  "ca1-0123456789abcdef0123456789abcdef",
);
assert.deepEqual(COMPANY_ACCOUNT_NO_STORE_HEADERS, {
  "Cache-Control": "no-store, private",
  Pragma: "no-cache",
  Vary: "Origin, Authorization, Cookie",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
});

const capabilities = buildCompanyAccountCapabilities();
assert.equal(capabilities.brand, "HarnessDesk");
assert.equal("edition" in capabilities, false);
assert.equal(capabilities.productionEnabled, false);
assert.equal(capabilities.capabilities.unifiedLogin.status, "unavailable");
assert.equal(capabilities.capabilities.productGrant.status, "unavailable");
assert.equal(capabilities.capabilities.platformProxy.status, "unavailable");
assert.equal(capabilities.capabilities.platformProxy.adapter, "deepseek");
assert.equal(capabilities.capabilities.hostedByok.status, "unavailable");
assert.equal(capabilities.capabilities.payments.status, "unavailable");
assert.deepEqual(capabilities.capabilities.localContractTest, {
  status: "implemented",
  evidenceLevel: "E2_LOCAL_ZERO_NETWORK",
});

const routeResponse = await getCapabilities(
  new Request("http://127.0.0.1:49321/api/company-account/v1/capabilities", {
    headers: { host: "127.0.0.1:49321" },
  }),
);
assert.equal(routeResponse.status, 200);
assert.deepEqual(await routeResponse.json(), capabilities);
assert.equal(routeResponse.headers.get("cache-control"), "no-store, private");
assert.equal(routeResponse.headers.get("pragma"), "no-cache");
assert.equal(routeResponse.headers.get("x-content-type-options"), "nosniff");
assert.equal(routeResponse.headers.get("referrer-policy"), "no-referrer");
assert.equal(routeResponse.headers.get("access-control-allow-origin"), null);

const remoteResponse = await getCapabilities(
  new Request("http://example.test/api/company-account/v1/capabilities", {
    headers: { host: "example.test" },
  }),
);
assert.equal(remoteResponse.status, 403);
assert.equal((await remoteResponse.json()).error.code, "ORIGIN_NOT_ALLOWED");

const queryResponse = await getCapabilities(
  new Request(
    "http://127.0.0.1:49321/api/company-account/v1/capabilities?tenantId=platform",
    { headers: { host: "127.0.0.1:49321" } },
  ),
);
assert.equal(queryResponse.status, 400);
assert.equal((await queryResponse.json()).error.code, "INVALID_REQUEST");

function opaqueSequence() {
  let counter = 0;
  return () => {
    counter += 1;
    const bytes = Buffer.alloc(32);
    bytes.writeUInt32BE(counter, 28);
    return bytes.toString("base64url");
  };
}

function uuidSequence() {
  let counter = 0;
  return () => {
    counter += 1;
    return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, "0")}`;
  };
}

const trustedPhonePrincipal = {
  identitySource: "verified_phone_identity",
  authType: "phone",
  userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
} as const;

function sessionHarness(start = Date.UTC(2026, 7, 15, 4, 0, 0)) {
  let currentTime = start;
  let identityGateAvailable = true;
  let resolvedPrincipal: unknown = trustedPhonePrincipal;
  const activeUserIds = new Set([
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  ]);
  const repository = new MemoryCompanyAccountSessionRepository();
  const service = createCompanyAccountSessionService({
    repository,
    async resolveTrustedAuthorizationPrincipal(input) {
      assert.equal(input.productId, COMPANY_ACCOUNT_PRODUCT_ID);
      assert.equal(input.clientId, COMPANY_ACCOUNT_CLIENT_ID);
      assert.equal(input.audience, COMPANY_ACCOUNT_AUDIENCE);
      assert.match(input.authorizationAttemptId, /^authorization-attempt-/);
      return resolvedPrincipal as typeof trustedPhonePrincipal;
    },
    async validateActiveProductUser(input) {
      if (!identityGateAvailable) throw new Error("PRIVATE_IDENTITY_GATE_ERROR");
      assert.equal(input.productId, COMPANY_ACCOUNT_PRODUCT_ID);
      assert.equal(input.clientId, COMPANY_ACCOUNT_CLIENT_ID);
      assert.equal(input.audience, COMPANY_ACCOUNT_AUDIENCE);
      return activeUserIds.has(input.userId);
    },
    now: () => currentTime,
    randomOpaque: opaqueSequence(),
    randomId: uuidSequence(),
  });
  return {
    repository,
    service,
    setTime(value: number) {
      currentTime = value;
    },
    now() {
      return currentTime;
    },
    setIdentityGateAvailable(value: boolean) {
      identityGateAvailable = value;
    },
    setResolvedPrincipal(value: unknown) {
      resolvedPrincipal = value;
    },
    setUserActive(userId: string, active: boolean) {
      if (active) activeUserIds.add(userId);
      else activeUserIds.delete(userId);
    },
  };
}

const rfcVerifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const rfcChallenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
assert.equal(derivePkceS256Challenge(rfcVerifier), rfcChallenge);
assert.equal(derivePkceS256Challenge("a".repeat(42)), null);
assert.equal(derivePkceS256Challenge("a".repeat(129)), null);
assert.equal(derivePkceS256Challenge("测".repeat(43)), null);

function expectedSessionTokenHash(
  domain: "code" | "access" | "refresh",
  value: string,
) {
  return createHash("sha256")
    .update(`harnessdesk-company-account-v1:${domain}\0`, "utf8")
    .update(value, "ascii")
    .digest("hex");
}

let authorizationAttempt = 0;
function authorizationRequest(overrides: Record<string, unknown> = {}) {
  authorizationAttempt += 1;
  return {
    ...clientContext,
    redirectUri: "http://127.0.0.1:49322/callback",
    codeChallenge: rfcChallenge,
    codeChallengeMethod: "S256",
    nonce: "n".repeat(32),
    authorizationAttemptId: `authorization-attempt-${authorizationAttempt}`,
    ...overrides,
  };
}

function exchangeRequest(
  authorizationCode: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    ...clientContext,
    authorizationCode,
    codeVerifier: rfcVerifier,
    redirectUri: "http://127.0.0.1:49322/callback",
    ...overrides,
  };
}

async function expectSessionError(
  promise: Promise<unknown>,
  expected?: string,
) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof CompanyAccountSessionError);
    if (expected) assert.equal(error.code, expected);
    return true;
  });
}

{
  const harness = sessionHarness();
  harness.setResolvedPrincipal({
    ...trustedPhonePrincipal,
    identitySource: "client_body",
    secret: "PRIVATE_PRINCIPAL_MARKER",
  });
  await expectSessionError(
    harness.service.issueAuthorizationCode(authorizationRequest()),
    "ACCOUNT_UNAVAILABLE",
  );
  harness.setResolvedPrincipal(trustedPhonePrincipal);
  await expectSessionError(
    harness.service.issueAuthorizationCode(
      authorizationRequest({ userId: trustedPhonePrincipal.userId }),
    ),
    "INVALID_REQUEST",
  );
  assert.equal((await harness.repository.snapshot()).authorizationCodes.total, 0);
}

{
  const repository = new MemoryCompanyAccountSessionRepository();
  const now = Date.UTC(2026, 7, 15, 6, 45, 0);
  const redirectUri = "http://127.0.0.1:49322/callback";
  const verifierChallenge = "a".repeat(43);
  const legacyCodeHash = "legacy-code-hash";
  const legacyRecord = {
    recordId: "d3e23382-03d7-4f70-9000-000000000001",
    authorizationAttemptId: "legacy-attempt",
    codeHash: legacyCodeHash,
    issuer: COMPANY_ACCOUNT_SESSION_ISSUER,
    schemaVersion: COMPANY_ACCOUNT_SCHEMA_VERSION,
    productId: SUPERSEDED_COMPANY_ACCOUNT_IDENTIFIERS.productId,
    clientId: SUPERSEDED_COMPANY_ACCOUNT_IDENTIFIERS.clientId,
    audience: SUPERSEDED_COMPANY_ACCOUNT_IDENTIFIERS.audience,
    channelId: SUPERSEDED_COMPANY_ACCOUNT_IDENTIFIERS.channelId,
    tenantId: "platform",
    userId: "d3e23382-03d7-4f70-9000-000000000002",
    redirectUri,
    codeChallenge: verifierChallenge,
    nonce: "legacy-nonce",
    scopes: COMPANY_ACCOUNT_SESSION_SCOPES,
    issuedAt: now,
    expiresAt: now + 90_000,
    status: "ready",
  } as unknown as Parameters<typeof repository.createAuthorizationCode>[0];
  assert.equal(await repository.createAuthorizationCode(legacyRecord), true);
  assert.deepEqual(
    await repository.inspectAuthorizationCode({
      codeHash: legacyCodeHash,
      redirectUri,
      verifierChallenge,
      now,
    }),
    { status: "invalid" },
  );

  const currentCodeHash = "current-code-hash";
  const currentRecord = {
    ...legacyRecord,
    recordId: "d3e23382-03d7-4f70-9000-000000000003",
    authorizationAttemptId: "current-attempt",
    codeHash: currentCodeHash,
    productId: COMPANY_ACCOUNT_PRODUCT_ID,
    clientId: COMPANY_ACCOUNT_CLIENT_ID,
    audience: COMPANY_ACCOUNT_AUDIENCE,
    channelId: COMPANY_ACCOUNT_CHANNEL_ID,
  } as unknown as Parameters<typeof repository.createAuthorizationCode>[0];
  assert.equal(await repository.createAuthorizationCode(currentRecord), true);
  const legacyFamilyResult = await repository.exchangeAuthorizationCode({
    codeHash: currentCodeHash,
    redirectUri,
    verifierChallenge,
    now,
    records: {
      family: {
        familyId: "d3e23382-03d7-4f70-9000-000000000004",
        issuer: COMPANY_ACCOUNT_SESSION_ISSUER,
        schemaVersion: COMPANY_ACCOUNT_SCHEMA_VERSION,
        productId: SUPERSEDED_COMPANY_ACCOUNT_IDENTIFIERS.productId,
        clientId: SUPERSEDED_COMPANY_ACCOUNT_IDENTIFIERS.clientId,
        audience: SUPERSEDED_COMPANY_ACCOUNT_IDENTIFIERS.audience,
        channelId: SUPERSEDED_COMPANY_ACCOUNT_IDENTIFIERS.channelId,
        tenantId: "platform",
        userId: "d3e23382-03d7-4f70-9000-000000000002",
        scopes: COMPANY_ACCOUNT_SESSION_SCOPES,
        status: "active",
        createdAt: now,
        absoluteExpiresAt: now + 30 * 24 * 60 * 60_000,
        currentRefreshGeneration: 0,
      },
      access: {
        tokenHash: "legacy-access-hash",
        familyId: "d3e23382-03d7-4f70-9000-000000000004",
        issuedAt: now,
        expiresAt: now + 15 * 60_000,
      },
      refresh: {
        tokenHash: "legacy-refresh-hash",
        familyId: "d3e23382-03d7-4f70-9000-000000000004",
        generation: 0,
        issuedAt: now,
        expiresAt: now + 30 * 24 * 60 * 60_000,
        status: "current",
      },
    },
  } as unknown as Parameters<typeof repository.exchangeAuthorizationCode>[0]);
  assert.deepEqual(legacyFamilyResult, { status: "invalid" });
  assert.equal((await repository.snapshot()).tokenFamilies.total, 0);
}

{
  const harness = sessionHarness();
  const issuedCode = await harness.service.issueAuthorizationCode(
    authorizationRequest(),
  );
  const rawCode = issuedCode.authorizationCode.revealForProtocolResponse();
  assert.equal(JSON.stringify(issuedCode).includes(rawCode), false);
  assert.equal(String(issuedCode.authorizationCode), "[REDACTED]");
  assert.deepEqual(await harness.repository.snapshot(), {
    source: "memory",
    authorizationCodes: { total: 1, ready: 1, consumed: 0, expired: 0 },
    tokenFamilies: { total: 0, active: 0, revoked: 0, compromised: 0 },
    accessTokenRecords: 0,
    refreshTokenRecords: 0,
    rawSecretsStored: false,
  });

  await expectSessionError(
    harness.service.exchangeAuthorizationCode(
      exchangeRequest(rawCode, { codeVerifier: "A".repeat(43) }),
    ),
    "AUTH_REQUIRED",
  );
  assert.equal((await harness.repository.snapshot()).tokenFamilies.total, 0);

  const session = await harness.service.exchangeAuthorizationCode(
    exchangeRequest(rawCode),
  );
  const accessToken = session.secrets.accessToken.revealForProtocolResponse();
  const refreshToken = session.secrets.refreshToken.revealForProtocolResponse();
  assert.equal(JSON.stringify(session).includes(accessToken), false);
  assert.equal(JSON.stringify(session).includes(refreshToken), false);
  assert.equal(
    await harness.repository.containsRawSecretForTest([
      rawCode,
      accessToken,
      refreshToken,
    ]),
    false,
  );
  const principal = await harness.service.authenticateAccessToken({
    ...clientContext,
    accessToken,
  });
  assert.equal(principal.userId, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.equal(principal.productId, COMPANY_ACCOUNT_PRODUCT_ID);
  assert.equal(principal.audience, COMPANY_ACCOUNT_AUDIENCE);

  await expectSessionError(
    harness.service.exchangeAuthorizationCode(
      exchangeRequest(rawCode, { codeVerifier: "B".repeat(43) }),
    ),
    "AUTH_REQUIRED",
  );
  assert.equal(
    (
      await harness.service.authenticateAccessToken({
        ...clientContext,
        accessToken,
      })
    ).familyId,
    session.public.sessionFamilyId,
  );
  await expectSessionError(
    harness.service.exchangeAuthorizationCode(exchangeRequest(rawCode)),
    "AUTH_REQUIRED",
  );
  await expectSessionError(
    harness.service.authenticateAccessToken({ ...clientContext, accessToken }),
    "AUTH_REQUIRED",
  );
}

{
  const memoryRepository = new MemoryCompanyAccountSessionRepository();
  const observed = {
    codeHash: "",
    accessHash: "",
    refreshHash: "",
  };
  const repository: CompanyAccountSessionRepository = {
    createAuthorizationCode(record) {
      observed.codeHash = record.codeHash;
      return memoryRepository.createAuthorizationCode(record);
    },
    inspectAuthorizationCode(input) {
      return memoryRepository.inspectAuthorizationCode(input);
    },
    exchangeAuthorizationCode(input) {
      observed.accessHash = input.records.access.tokenHash;
      observed.refreshHash = input.records.refresh.tokenHash;
      return memoryRepository.exchangeAuthorizationCode(input);
    },
    rotateRefreshToken(input) {
      return memoryRepository.rotateRefreshToken(input);
    },
    resolveAccessToken(input) {
      return memoryRepository.resolveAccessToken(input);
    },
    revokeFamilyByAccessToken(input) {
      return memoryRepository.revokeFamilyByAccessToken(input);
    },
    revokeFamilyById(input) {
      return memoryRepository.revokeFamilyById(input);
    },
    snapshot() {
      return memoryRepository.snapshot();
    },
  };
  const now = Date.UTC(2026, 7, 15, 7, 0, 0);
  const service = createCompanyAccountSessionService({
    repository,
    async resolveTrustedAuthorizationPrincipal() {
      return trustedPhonePrincipal;
    },
    async validateActiveProductUser() {
      return true;
    },
    now: () => now,
    randomOpaque: opaqueSequence(),
    randomId: uuidSequence(),
  });
  const issuedCode = await service.issueAuthorizationCode(authorizationRequest());
  const rawCode = issuedCode.authorizationCode.revealForProtocolResponse();
  assert.equal(observed.codeHash, expectedSessionTokenHash("code", rawCode));

  const issuedSession = await service.exchangeAuthorizationCode(
    exchangeRequest(rawCode),
  );
  const rawAccess = issuedSession.secrets.accessToken.revealForProtocolResponse();
  const rawRefresh = issuedSession.secrets.refreshToken.revealForProtocolResponse();
  assert.equal(observed.accessHash, expectedSessionTokenHash("access", rawAccess));
  assert.equal(observed.refreshHash, expectedSessionTokenHash("refresh", rawRefresh));
  assert.equal(
    new Set([observed.codeHash, observed.accessHash, observed.refreshHash]).size,
    3,
  );
  for (const [domain, raw, currentHash] of [
    ["code", rawCode, observed.codeHash],
    ["access", rawAccess, observed.accessHash],
    ["refresh", rawRefresh, observed.refreshHash],
  ] as const) {
    const supersededHash = createHash("sha256")
      .update(
        `${SUPERSEDED_COMPANY_ACCOUNT_IDENTIFIERS.sessionHashNamespace}:${domain}\0`,
        "utf8",
      )
      .update(raw, "ascii")
      .digest("hex");
    assert.notEqual(currentHash, supersededHash);
  }
}

{
  const harness = sessionHarness();
  const code = await harness.service.issueAuthorizationCode(
    authorizationRequest(),
  );
  const session = await harness.service.exchangeAuthorizationCode(
    exchangeRequest(code.authorizationCode.revealForProtocolResponse()),
  );
  const oldRefresh = session.secrets.refreshToken.revealForProtocolResponse();
  const attempts = await Promise.allSettled([
    harness.service.refreshSession({ ...clientContext, refreshToken: oldRefresh }),
    harness.service.refreshSession({ ...clientContext, refreshToken: oldRefresh }),
  ]);
  assert.equal(attempts.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((item) => item.status === "rejected").length, 1);
  assert.equal((await harness.repository.snapshot()).tokenFamilies.compromised, 1);
  const fulfilled = attempts.find((item) => item.status === "fulfilled");
  assert.ok(fulfilled && fulfilled.status === "fulfilled");
  await expectSessionError(
    harness.service.authenticateAccessToken({
      ...clientContext,
      accessToken:
        fulfilled.value.secrets.accessToken.revealForProtocolResponse(),
    }),
    "AUTH_REQUIRED",
  );
}

{
  const harness = sessionHarness();
  const code = await harness.service.issueAuthorizationCode(
    authorizationRequest(),
  );
  const rawCode = code.authorizationCode.revealForProtocolResponse();
  const attempts = await Promise.allSettled([
    harness.service.exchangeAuthorizationCode(exchangeRequest(rawCode)),
    harness.service.exchangeAuthorizationCode(exchangeRequest(rawCode)),
  ]);
  assert.equal(attempts.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((item) => item.status === "rejected").length, 1);
  const snapshot = await harness.repository.snapshot();
  assert.equal(snapshot.tokenFamilies.total, 1);
  assert.equal(snapshot.tokenFamilies.compromised, 1);
  const fulfilled = attempts.find((item) => item.status === "fulfilled");
  assert.ok(fulfilled && fulfilled.status === "fulfilled");
  await expectSessionError(
    harness.service.authenticateAccessToken({
      ...clientContext,
      accessToken:
        fulfilled.value.secrets.accessToken.revealForProtocolResponse(),
    }),
    "AUTH_REQUIRED",
  );
}

{
  const harness = sessionHarness();
  const forgedPrincipal = {
    ...trustedPhonePrincipal,
    userId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  };
  harness.setResolvedPrincipal(forgedPrincipal);
  await expectSessionError(
    harness.service.issueAuthorizationCode(authorizationRequest()),
    "ACCOUNT_UNAVAILABLE",
  );
  harness.setIdentityGateAvailable(false);
  await expectSessionError(
    harness.service.issueAuthorizationCode(authorizationRequest()),
    "SERVICE_UNAVAILABLE",
  );
  assert.equal((await harness.repository.snapshot()).authorizationCodes.total, 0);
}

{
  const harness = sessionHarness();
  const code = await harness.service.issueAuthorizationCode(
    authorizationRequest(),
  );
  harness.setUserActive(trustedPhonePrincipal.userId, false);
  await expectSessionError(
    harness.service.exchangeAuthorizationCode(
      exchangeRequest(code.authorizationCode.revealForProtocolResponse()),
    ),
    "ACCOUNT_UNAVAILABLE",
  );
  assert.equal((await harness.repository.snapshot()).tokenFamilies.total, 0);
}

{
  const harness = sessionHarness();
  const code = await harness.service.issueAuthorizationCode(
    authorizationRequest(),
  );
  const session = await harness.service.exchangeAuthorizationCode(
    exchangeRequest(code.authorizationCode.revealForProtocolResponse()),
  );
  const accessToken = session.secrets.accessToken.revealForProtocolResponse();
  harness.setUserActive(trustedPhonePrincipal.userId, false);
  await expectSessionError(
    harness.service.authenticateAccessToken({ ...clientContext, accessToken }),
    "ACCOUNT_UNAVAILABLE",
  );
  assert.equal((await harness.repository.snapshot()).tokenFamilies.revoked, 1);
}

{
  const harness = sessionHarness();
  const code = await harness.service.issueAuthorizationCode(
    authorizationRequest(),
  );
  const session = await harness.service.exchangeAuthorizationCode(
    exchangeRequest(code.authorizationCode.revealForProtocolResponse()),
  );
  const refreshToken = session.secrets.refreshToken.revealForProtocolResponse();
  harness.setUserActive(trustedPhonePrincipal.userId, false);
  await expectSessionError(
    harness.service.refreshSession({ ...clientContext, refreshToken }),
    "ACCOUNT_UNAVAILABLE",
  );
  assert.equal((await harness.repository.snapshot()).tokenFamilies.revoked, 1);
}

{
  const harness = sessionHarness();
  const code = await harness.service.issueAuthorizationCode(
    authorizationRequest(),
  );
  harness.setTime(harness.now() + 90_001);
  await expectSessionError(
    harness.service.exchangeAuthorizationCode(
      exchangeRequest(code.authorizationCode.revealForProtocolResponse()),
    ),
    "SESSION_EXPIRED",
  );
  assert.equal((await harness.repository.snapshot()).tokenFamilies.total, 0);
  assert.deepEqual(
    (await harness.repository.snapshot()).authorizationCodes,
    { total: 1, ready: 0, consumed: 0, expired: 1 },
  );
}

{
  const harness = sessionHarness();
  const code = await harness.service.issueAuthorizationCode(
    authorizationRequest(),
  );
  const session = await harness.service.exchangeAuthorizationCode(
    exchangeRequest(code.authorizationCode.revealForProtocolResponse()),
  );
  const oldRefresh = session.secrets.refreshToken.revealForProtocolResponse();
  const rotated = await harness.service.refreshSession({
    ...clientContext,
    refreshToken: oldRefresh,
  });
  const rotatedAccess = rotated.secrets.accessToken.revealForProtocolResponse();
  const rotatedRefresh =
    rotated.secrets.refreshToken.revealForProtocolResponse();
  assert.equal(
    await harness.repository.containsRawSecretForTest([
      oldRefresh,
      rotatedAccess,
      rotatedRefresh,
    ]),
    false,
  );
  assert.equal(
    (
      await harness.service.authenticateAccessToken({
        ...clientContext,
        accessToken: rotatedAccess,
      })
    ).familyId,
    session.public.sessionFamilyId,
  );
  await expectSessionError(
    harness.service.refreshSession({
      ...clientContext,
      refreshToken: oldRefresh,
    }),
    "SESSION_EXPIRED",
  );
  await expectSessionError(
    harness.service.authenticateAccessToken({
      ...clientContext,
      accessToken: rotatedAccess,
    }),
    "AUTH_REQUIRED",
  );
}

{
  const harness = sessionHarness();
  const code = await harness.service.issueAuthorizationCode(
    authorizationRequest(),
  );
  const session = await harness.service.exchangeAuthorizationCode(
    exchangeRequest(code.authorizationCode.revealForProtocolResponse()),
  );
  const accessToken = session.secrets.accessToken.revealForProtocolResponse();
  assert.deepEqual(
    await harness.service.logout({ ...clientContext, accessToken }),
    { ok: true },
  );
  assert.deepEqual(
    await harness.service.logout({ ...clientContext, accessToken }),
    { ok: true },
  );
  await expectSessionError(
    harness.service.authenticateAccessToken({ ...clientContext, accessToken }),
    "AUTH_REQUIRED",
  );
}

{
  const harness = sessionHarness();
  for (const overrides of [
    { productId: SUPERSEDED_COMPANY_ACCOUNT_IDENTIFIERS.productId },
    { clientId: SUPERSEDED_COMPANY_ACCOUNT_IDENTIFIERS.clientId },
    { audience: SUPERSEDED_COMPANY_ACCOUNT_IDENTIFIERS.audience },
    { channelId: SUPERSEDED_COMPANY_ACCOUNT_IDENTIFIERS.channelId },
  ]) {
    await expectSessionError(
      harness.service.issueAuthorizationCode({
        ...authorizationRequest(),
        ...overrides,
      }),
      "INVALID_REQUEST",
    );
  }
  await expectSessionError(
    harness.service.issueAuthorizationCode({
      ...authorizationRequest(),
      productId: "deepseek-harness-agent",
    }),
    "INVALID_REQUEST",
  );
  await expectSessionError(
    harness.service.issueAuthorizationCode({
      ...authorizationRequest(),
      audience: "deepseek",
    }),
    "INVALID_REQUEST",
  );
  await expectSessionError(
    harness.service.issueAuthorizationCode({
      ...authorizationRequest(),
      clientId: "aistory-web",
    }),
    "INVALID_REQUEST",
  );
  await expectSessionError(
    harness.service.issueAuthorizationCode({
      ...authorizationRequest(),
      tenantId: "platform",
    }),
    "INVALID_REQUEST",
  );
  await expectSessionError(
    harness.service.issueAuthorizationCode(
      authorizationRequest({ redirectUri: "http://localhost:49322/callback" }),
    ),
    "INVALID_REQUEST",
  );
  await expectSessionError(
    harness.service.issueAuthorizationCode(
      authorizationRequest({ redirectUri: "http://127.0.0.1:49322/other" }),
    ),
    "INVALID_REQUEST",
  );
  for (const overrides of [
    { codeChallenge: "a".repeat(42) },
    { codeChallenge: `${"a".repeat(43)}=` },
    { codeChallengeMethod: "plain" },
    { codeChallengeMethod: "s256" },
    { redirectUri: "http://user@127.0.0.1:49322/callback" },
    { redirectUri: "http://127.0.0.1:49322/callback?code=x" },
    { redirectUri: "http://127.0.0.1:49322/callback#fragment" },
    { redirectUri: "http://127.0.0.1:1023/callback" },
    { redirectUri: "http://127.0.0.1:65536/callback" },
  ]) {
    await expectSessionError(
      harness.service.issueAuthorizationCode(authorizationRequest(overrides)),
      "INVALID_REQUEST",
    );
  }
  assert.equal((await harness.repository.snapshot()).authorizationCodes.total, 0);
}

async function expectGrantError(promise: Promise<unknown>, expected: string) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof CompanyAccountProductGrantError);
    assert.equal(error.code, expected);
    return true;
  });
}

const grantUserId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const enabledGrantPolicy: CompanyAccountProductGrantPolicy = {
  enabled: true,
  productId: COMPANY_ACCOUNT_PRODUCT_ID,
  grantVersion: "harnessdesk-launch-v1",
  amountCredits: 250,
  reasonCode: "launch_activity",
};
assert.throws(
  () =>
    createCompanyAccountProductGrantService({
      repository: new MemoryCompanyAccountProductGrantRepository(),
      policy: {
        ...enabledGrantPolicy,
        grantVersion: SUPERSEDED_COMPANY_ACCOUNT_IDENTIFIERS.grantVersion,
      },
    }),
  (error: unknown) => {
    assert.ok(error instanceof CompanyAccountProductGrantError);
    assert.equal(error.code, "PRODUCT_GRANT_UNAVAILABLE");
    return true;
  },
);
assert.equal(
  productGrantSemanticFingerprint({
    userId: grantUserId,
    policy: enabledGrantPolicy,
  }),
  "05434a225213ed7a787fa2f44dcf9173cd36debbdb765ff9c9ba177c87686b5b",
);

function grantRequest(
  idempotencyKey: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    ...clientContext,
    grantVersion: "harnessdesk-launch-v1",
    idempotencyKey,
    ...overrides,
  };
}

function trustedGrantPrincipal(overrides: Record<string, unknown> = {}) {
  return {
    identitySource: "company_account_session",
    userId: grantUserId,
    productId: COMPANY_ACCOUNT_PRODUCT_ID,
    audience: COMPANY_ACCOUNT_AUDIENCE,
    active: true,
    ...overrides,
  };
}

function createCompanyAccountProductGrantService(input: {
  repository: CompanyAccountProductGrantRepository;
  policy?: CompanyAccountProductGrantPolicy;
  now?: () => number;
  resolveTrustedPrincipal?: (
    context: Readonly<CompanyAccountProductGrantPrincipalContext>,
  ) => Promise<unknown>;
}) {
  return createProductGrantServiceContract({
    repository: input.repository,
    policy: input.policy,
    now: input.now,
    resolveTrustedPrincipal:
      input.resolveTrustedPrincipal ?? (async () => trustedGrantPrincipal()),
  });
}

{
  const repository = new MemoryCompanyAccountProductGrantRepository();
  const disabled = createCompanyAccountProductGrantService({
    repository,
    policy: COMPANY_ACCOUNT_PRODUCT_GRANT_DISABLED_POLICY,
  });
  await expectGrantError(
    disabled.apply(grantRequest("grant-disabled-0001")),
    "PRODUCT_GRANT_UNAVAILABLE",
  );
  assert.equal((await repository.snapshot()).grants, 0);
}

{
  const repository = new MemoryCompanyAccountProductGrantRepository();
  const service = createCompanyAccountProductGrantService({
    repository,
    policy: enabledGrantPolicy,
    now: () => Date.UTC(2026, 7, 15, 5, 0, 0),
  });
  const first = await service.apply(grantRequest("grant-request-0001"));
  assert.equal(first.replayed, false);
  assert.equal(first.status, "recorded_not_credited");
  assert.equal(first.capability, "local_contract_only");
  assert.equal(first.grant.amountCredits, 250);
  const same = await service.apply(grantRequest("grant-request-0001"));
  assert.equal(same.replayed, true);
  const alias = await service.apply(grantRequest("grant-request-0002"));
  assert.equal(alias.replayed, true);
  assert.equal(alias.grant.grantId, first.grant.grantId);
  assert.deepEqual(await repository.snapshot(), {
    source: "memory",
    capability: "local_contract_only",
    grants: 1,
    receipts: 2,
    audits: 1,
    rawIdempotencyKeysStored: false,
    ledgerWrites: 0,
    balanceMutations: 0,
  });
  assert.equal(
    await repository.containsRawIdempotencyKeyForTest([
      "grant-request-0001",
      "grant-request-0002",
    ]),
    false,
  );

  (first.grant as { amountCredits: number }).amountCredits = 999_999;
  assert.equal(
    (await service.apply(grantRequest("grant-request-0002"))).grant
      .amountCredits,
    250,
  );

  const changedPolicy = createCompanyAccountProductGrantService({
    repository,
    policy: { ...enabledGrantPolicy, amountCredits: 251 },
    now: () => Date.UTC(2026, 7, 15, 5, 1, 0),
  });
  await expectGrantError(
    changedPolicy.apply(grantRequest("grant-request-0001")),
    "IDEMPOTENCY_CONFLICT",
  );
  await expectGrantError(
    changedPolicy.apply(grantRequest("grant-request-new-policy")),
    "IDEMPOTENCY_CONFLICT",
  );
  assert.equal((await repository.snapshot()).audits, 1);
  assert.equal((await repository.snapshot()).receipts, 2);

  await expectGrantError(
    service.apply(grantRequest("grant-request-0003", { tenantId: "platform" })),
    "INVALID_REQUEST",
  );
  await expectGrantError(
    service.apply(
      grantRequest("grant-request-0003", {
        productId: "deepseek-harness-agent",
      }),
    ),
    "INVALID_REQUEST",
  );
  await expectGrantError(
    service.apply(
      grantRequest("grant-request-0003", {
        productId: SUPERSEDED_COMPANY_ACCOUNT_IDENTIFIERS.productId,
      }),
    ),
    "INVALID_REQUEST",
  );
  await expectGrantError(
    service.apply(
      grantRequest("grant-request-0003", {
        userId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      }),
    ),
    "INVALID_REQUEST",
  );
}

{
  const repository = new MemoryCompanyAccountProductGrantRepository();
  let resolverCalls = 0;
  const service = createCompanyAccountProductGrantService({
    repository,
    policy: enabledGrantPolicy,
    resolveTrustedPrincipal: async () => {
      resolverCalls += 1;
      return trustedGrantPrincipal();
    },
  });
  await expectGrantError(
    service.apply(
      grantRequest("grant-client-user-id-forbidden", {
        userId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      }),
    ),
    "INVALID_REQUEST",
  );
  assert.equal(resolverCalls, 0);
  assert.equal((await repository.snapshot()).grants, 0);
}

{
  const missingAudiencePrincipal = trustedGrantPrincipal() as Record<
    string,
    unknown
  >;
  delete missingAudiencePrincipal.audience;
  const invalidPrincipals: unknown[] = [
    null,
    missingAudiencePrincipal,
    trustedGrantPrincipal({ identitySource: "verified_phone_identity" }),
    trustedGrantPrincipal({
      productId: SUPERSEDED_COMPANY_ACCOUNT_IDENTIFIERS.productId,
    }),
    trustedGrantPrincipal({
      audience: SUPERSEDED_COMPANY_ACCOUNT_IDENTIFIERS.audience,
    }),
    trustedGrantPrincipal({ productId: "deepseek-harness-agent" }),
    trustedGrantPrincipal({ audience: "deepseek" }),
    trustedGrantPrincipal({ active: false }),
    trustedGrantPrincipal({ userId: "not-a-stable-uuid" }),
    trustedGrantPrincipal({ unexpected: "PRIVATE_PRINCIPAL_EXTRA" }),
    Object.assign(Object.create({ inherited: true }), trustedGrantPrincipal()),
  ];
  const accessorPrincipal = trustedGrantPrincipal() as Record<string, unknown>;
  Object.defineProperty(accessorPrincipal, "userId", {
    enumerable: true,
    get: () => grantUserId,
  });
  invalidPrincipals.push(accessorPrincipal);
  const symbolPrincipal = trustedGrantPrincipal() as Record<PropertyKey, unknown>;
  symbolPrincipal[Symbol("secret")] = "PRIVATE_PRINCIPAL_SYMBOL";
  invalidPrincipals.push(symbolPrincipal);

  for (const principal of invalidPrincipals) {
    const repository = new MemoryCompanyAccountProductGrantRepository();
    const service = createCompanyAccountProductGrantService({
      repository,
      policy: enabledGrantPolicy,
      resolveTrustedPrincipal: async () => principal,
    });
    await expectGrantError(
      service.apply(grantRequest("grant-invalid-principal")),
      "ACCOUNT_UNAVAILABLE",
    );
    assert.equal((await repository.snapshot()).grants, 0);
  }

  const repository = new MemoryCompanyAccountProductGrantRepository();
  let principalCalls = 0;
  const service = createCompanyAccountProductGrantService({
    repository,
    policy: enabledGrantPolicy,
    resolveTrustedPrincipal: async (context) => {
      principalCalls += 1;
      assert.equal(Object.isFrozen(context), true);
      assert.deepEqual(context, clientContext);
      throw new Error("PRIVATE_IDENTITY_GATE_ERROR");
    },
  });
  await expectGrantError(
    service.apply(grantRequest("grant-principal-unavailable")),
    "ACCOUNT_UNAVAILABLE",
  );
  assert.equal(principalCalls, 1);
  assert.equal((await repository.snapshot()).grants, 0);
}

{
  const repository = new MemoryCompanyAccountProductGrantRepository();
  const service = createCompanyAccountProductGrantService({
    repository,
    policy: enabledGrantPolicy,
    now: () => Date.UTC(2026, 7, 15, 6, 30, 0),
  });
  const concurrent = await Promise.all(
    Array.from({ length: 20 }, () =>
      service.apply(grantRequest("grant-same-key-concurrent")),
    ),
  );
  assert.equal(concurrent.filter((result) => !result.replayed).length, 1);
  assert.deepEqual(await repository.snapshot(), {
    source: "memory",
    capability: "local_contract_only",
    grants: 1,
    receipts: 1,
    audits: 1,
    rawIdempotencyKeysStored: false,
    ledgerWrites: 0,
    balanceMutations: 0,
  });
}

{
  const repository = new MemoryCompanyAccountProductGrantRepository();
  const service = createCompanyAccountProductGrantService({
    repository,
    policy: enabledGrantPolicy,
    now: () => Date.UTC(2026, 7, 15, 6, 0, 0),
  });
  const concurrent = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      service.apply(grantRequest(`grant-concurrent-${String(index).padStart(4, "0")}`)),
    ),
  );
  assert.equal(concurrent.filter((result) => !result.replayed).length, 1);
  assert.equal(new Set(concurrent.map((result) => result.grant.grantId)).size, 1);
  const snapshot = await repository.snapshot();
  assert.equal(snapshot.grants, 1);
  assert.equal(snapshot.receipts, 20);
  assert.equal(snapshot.audits, 1);
}

{
  const repository = new MemoryCompanyAccountProductGrantRepository();
  const v1 = createCompanyAccountProductGrantService({
    repository,
    policy: enabledGrantPolicy,
  });
  const v2Policy: CompanyAccountProductGrantPolicy = {
    ...enabledGrantPolicy,
    grantVersion: "harnessdesk-launch-v2",
    amountCredits: 300,
  };
  const v2 = createCompanyAccountProductGrantService({
    repository,
    policy: v2Policy,
  });
  await v1.apply(grantRequest("grant-version-shared-key"));
  await v2.apply(
    grantRequest("grant-version-v2-new-key", {
      grantVersion: v2Policy.grantVersion,
    }),
  );
  await expectGrantError(
    v2.apply(
      grantRequest("grant-version-shared-key", {
        grantVersion: v2Policy.grantVersion,
      }),
    ),
    "IDEMPOTENCY_CONFLICT",
  );
  const snapshot = await repository.snapshot();
  assert.equal(snapshot.grants, 2);
  assert.equal(snapshot.receipts, 2);
  assert.equal(snapshot.audits, 2);
}

{
  const repository = new MemoryCompanyAccountProductGrantRepository();
  const firstUserService = createCompanyAccountProductGrantService({
    repository,
    policy: enabledGrantPolicy,
  });
  const secondUserService = createCompanyAccountProductGrantService({
    repository,
    policy: enabledGrantPolicy,
    resolveTrustedPrincipal: async () =>
      trustedGrantPrincipal({
        userId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      }),
  });
  await firstUserService.apply(grantRequest("grant-cross-user-key"));
  await secondUserService.apply(grantRequest("grant-cross-user-key"));
  const snapshot = await repository.snapshot();
  assert.equal(snapshot.grants, 2);
  assert.equal(snapshot.receipts, 2);
  assert.equal(snapshot.audits, 2);
}

type ProxyCounters = {
  credential: number;
  quote: number;
  reserve: number;
  provider: number;
  settle: number;
  refund: number;
};

function proxyDependencies(options?: {
  quoteFails?: boolean;
  invalidQuote?: boolean;
  reserveFails?: boolean;
  invalidReservation?: boolean;
  credentialFails?: boolean;
  credentialMissing?: boolean;
  quoteAccessor?: boolean;
  providerAccessor?: boolean;
  providerFails?: boolean;
  providerTimeout?: boolean;
  providerMalformed?: boolean;
  providerOutcomeUnknown?: boolean;
  providerDefinitiveNotStarted?: boolean;
  settleFails?: boolean;
  refundFails?: boolean;
}): {
  counters: ProxyCounters;
  dependencies: HarnessDeskProxyPipelineDependencies;
} {
  const counters: ProxyCounters = {
    credential: 0,
    quote: 0,
    reserve: 0,
    provider: 0,
    settle: 0,
    refund: 0,
  };
  return {
    counters,
    dependencies: {
      async resolveCredential() {
        counters.credential += 1;
        if (options?.credentialFails) throw new Error("PRIVATE_CREDENTIAL_ERROR");
        if (options?.credentialMissing) {
          return { credentialHandle: undefined };
        }
        return { credentialHandle: { marker: "FAKE_CREDENTIAL_MARKER" } };
      },
      async quote() {
        counters.quote += 1;
        if (options?.quoteFails) throw new Error("PRIVATE_QUOTE_ERROR");
        if (options?.quoteAccessor) {
          const hostile: Record<string, unknown> = {
            maxChargeCredits: 2,
          };
          Object.defineProperty(hostile, "quoteId", {
            enumerable: true,
            get() {
              throw new Error("PRIVATE_QUOTE_GETTER_ERROR");
            },
          });
          return hostile as { quoteId: string; maxChargeCredits: number };
        }
        if (options?.invalidQuote) {
          return { quoteId: "x", maxChargeCredits: -1 };
        }
        return { quoteId: "quote-contract-0001", maxChargeCredits: 2 };
      },
      async reserve() {
        counters.reserve += 1;
        if (options?.reserveFails) throw new Error("PRIVATE_RESERVE_ERROR");
        if (options?.invalidReservation) return { reservationId: "x" };
        return { reservationId: "reservation-contract-0001" };
      },
      async invokeProvider() {
        counters.provider += 1;
        if (options?.providerFails) throw new Error("PRIVATE_PROVIDER_ERROR");
        if (options?.providerTimeout) throw new Error("PRIVATE_PROVIDER_TIMEOUT");
        if (options?.providerAccessor) {
          const hostile: Record<string, unknown> = { status: "completed" };
          Object.defineProperty(hostile, "receipt", {
            enumerable: true,
            get() {
              throw new Error("PRIVATE_PROVIDER_GETTER_ERROR");
            },
          });
          return hostile;
        }
        if (options?.providerMalformed) {
          return {
            status: "completed",
            receipt: {
              receiptDigest: "PRIVATE_PROVIDER_RECEIPT_MARKER",
              usageUnits: -1,
            },
          };
        }
        if (options?.providerOutcomeUnknown) {
          return { status: "outcome_unknown" };
        }
        if (options?.providerDefinitiveNotStarted) {
          return { status: "definitive_not_started" };
        }
        return {
          status: "completed",
          receipt: { receiptDigest: "a".repeat(64), usageUnits: 1 },
        };
      },
      async settle() {
        counters.settle += 1;
        if (options?.settleFails) throw new Error("PRIVATE_SETTLE_ERROR");
      },
      async refund() {
        counters.refund += 1;
        if (options?.refundFails) throw new Error("PRIVATE_REFUND_ERROR");
      },
    },
  };
}

const proxyRequest = {
  ...clientContext,
  capabilityId: HARNESSDESK_PROXY_CAPABILITY_ID,
  operation: HARNESSDESK_PROXY_OPERATION,
  adapterId: HARNESSDESK_PROXY_ADAPTER_ID,
  model: "deepseek-chat",
  maxOutputTokens: 1024,
  idempotencyKey: "proxy-request-0001",
};

const enabledProxyConfig: HarnessDeskProxyPolicyConfig = {
  enabled: true,
  productId: COMPANY_ACCOUNT_PRODUCT_ID,
  capabilityId: HARNESSDESK_PROXY_CAPABILITY_ID,
  operation: HARNESSDESK_PROXY_OPERATION,
  adapterId: HARNESSDESK_PROXY_ADAPTER_ID,
  upstreamId: HARNESSDESK_PROXY_UPSTREAM_ID,
  allowedModels: ["deepseek-chat"],
  billingPosture: "ready",
  quoteCapability: true,
  reservationCapability: true,
  credentialCapability: true,
};

async function assertProxyDenied(input: {
  request?: unknown;
  config?: HarnessDeskProxyPolicyConfig;
  expectedCode: string;
}) {
  const fake = proxyDependencies();
  await assert.rejects(
    runFakeHarnessDeskProxyContractPipeline({
      request: input.request ?? proxyRequest,
      config: input.config,
      dependencies: fake.dependencies,
    }),
    (error: unknown) => {
      assert.ok(error instanceof HarnessDeskProxyPolicyError);
      assert.equal(error.code, input.expectedCode);
      return true;
    },
  );
  assert.deepEqual(fake.counters, {
    credential: 0,
    quote: 0,
    reserve: 0,
    provider: 0,
    settle: 0,
    refund: 0,
  });
}

await assertProxyDenied({
  config: HARNESSDESK_PROXY_DISABLED_CONFIG,
  expectedCode: "SERVICE_UNAVAILABLE",
});
await assertProxyDenied({ expectedCode: "SERVICE_UNAVAILABLE" });
await assertProxyDenied({
  config: { ...enabledProxyConfig, billingPosture: "unavailable" },
  expectedCode: "PRODUCT_PRICING_UNAVAILABLE",
});
await assertProxyDenied({
  config: { ...enabledProxyConfig, quoteCapability: false },
  expectedCode: "PRODUCT_PRICING_UNAVAILABLE",
});
await assertProxyDenied({
  config: { ...enabledProxyConfig, reservationCapability: false },
  expectedCode: "PRODUCT_PRICING_UNAVAILABLE",
});
await assertProxyDenied({
  config: { ...enabledProxyConfig, credentialCapability: false },
  expectedCode: "PROVIDER_UNAVAILABLE",
});
await assertProxyDenied({
  config: { ...enabledProxyConfig, allowedModels: [] },
  expectedCode: "PROVIDER_UNAVAILABLE",
});
await assertProxyDenied({
  request: { ...proxyRequest, productId: "deepseek-harness-agent" },
  config: enabledProxyConfig,
  expectedCode: "INVALID_REQUEST",
});
await assertProxyDenied({
  request: {
    ...proxyRequest,
    productId: SUPERSEDED_COMPANY_ACCOUNT_IDENTIFIERS.productId,
  },
  config: enabledProxyConfig,
  expectedCode: "INVALID_REQUEST",
});
await assertProxyDenied({
  request: {
    ...proxyRequest,
    audience: SUPERSEDED_COMPANY_ACCOUNT_IDENTIFIERS.audience,
  },
  config: enabledProxyConfig,
  expectedCode: "INVALID_REQUEST",
});
await assertProxyDenied({
  request: { ...proxyRequest, audience: "deepseek" },
  config: enabledProxyConfig,
  expectedCode: "INVALID_REQUEST",
});
await assertProxyDenied({
  request: { ...proxyRequest, adapterId: "openai" },
  config: enabledProxyConfig,
  expectedCode: "INVALID_REQUEST",
});
await assertProxyDenied({
  request: { ...proxyRequest, model: "unknown-model" },
  config: enabledProxyConfig,
  expectedCode: "INVALID_REQUEST",
});
await assertProxyDenied({
  request: { ...proxyRequest, apiKey: "PRIVATE_API_KEY_MARKER" },
  config: enabledProxyConfig,
  expectedCode: "INVALID_REQUEST",
});
await assertProxyDenied({
  request: { ...proxyRequest, baseUrl: "https://private.invalid" },
  config: enabledProxyConfig,
  expectedCode: "INVALID_REQUEST",
});
await assertProxyDenied({
  request: { ...proxyRequest, prompt: "PRIVATE_PROMPT_MARKER" },
  config: enabledProxyConfig,
  expectedCode: "INVALID_REQUEST",
});
await assertProxyDenied({
  request: { ...proxyRequest, tenantId: "platform" },
  config: enabledProxyConfig,
  expectedCode: "INVALID_REQUEST",
});
await assertProxyDenied({
  request: { ...proxyRequest, idempotencyKey: "token-marker-0001" },
  config: enabledProxyConfig,
  expectedCode: "INVALID_REQUEST",
});
await assertProxyDenied({
  config: {
    ...enabledProxyConfig,
    unknownCredentialMode: "ambient",
  } as unknown as HarnessDeskProxyPolicyConfig,
  expectedCode: "SERVICE_UNAVAILABLE",
});
await assertProxyDenied({
  request: {
    ...clientContext,
    capabilityId: HARNESSDESK_PROXY_CAPABILITY_ID,
    operation: HARNESSDESK_PROXY_OPERATION,
    adapterId: HARNESSDESK_PROXY_ADAPTER_ID,
    model: "deepseek-chat",
    maxOutputTokens: 1024,
  },
  config: enabledProxyConfig,
  expectedCode: "IDEMPOTENCY_KEY_REQUIRED",
});
let hostileToStringCalls = 0;
await assertProxyDenied({
  config: {
    ...enabledProxyConfig,
    billingPosture: {
      toString() {
        hostileToStringCalls += 1;
        return "ready";
      },
    },
  } as unknown as HarnessDeskProxyPolicyConfig,
  expectedCode: "SERVICE_UNAVAILABLE",
});
assert.equal(hostileToStringCalls, 0);

async function assertProxyStageFailure(
  options: Parameters<typeof proxyDependencies>[0],
  expectedCode: string,
  expectedCounters: ProxyCounters,
) {
  const fake = proxyDependencies(options);
  await assert.rejects(
    runFakeHarnessDeskProxyContractPipeline({
      request: proxyRequest,
      config: enabledProxyConfig,
      dependencies: fake.dependencies,
    }),
    (error: unknown) => {
      assert.ok(error instanceof HarnessDeskProxyPolicyError);
      assert.equal(error.code, expectedCode);
      assert.equal(String(error).includes("PRIVATE_"), false);
      return true;
    },
  );
  assert.deepEqual(fake.counters, expectedCounters);
}

await assertProxyStageFailure(
  { quoteFails: true },
  "PRODUCT_PRICING_UNAVAILABLE",
  { credential: 0, quote: 1, reserve: 0, provider: 0, settle: 0, refund: 0 },
);
await assertProxyStageFailure(
  { invalidQuote: true },
  "PRODUCT_PRICING_UNAVAILABLE",
  { credential: 0, quote: 1, reserve: 0, provider: 0, settle: 0, refund: 0 },
);
await assertProxyStageFailure(
  { quoteAccessor: true },
  "PRODUCT_PRICING_UNAVAILABLE",
  { credential: 0, quote: 1, reserve: 0, provider: 0, settle: 0, refund: 0 },
);
await assertProxyStageFailure(
  { reserveFails: true },
  "BILLING_OUTCOME_PENDING",
  { credential: 0, quote: 1, reserve: 1, provider: 0, settle: 0, refund: 0 },
);
await assertProxyStageFailure(
  { invalidReservation: true },
  "BILLING_OUTCOME_PENDING",
  { credential: 0, quote: 1, reserve: 1, provider: 0, settle: 0, refund: 0 },
);
await assertProxyStageFailure(
  { credentialFails: true },
  "PROVIDER_UNAVAILABLE",
  { credential: 1, quote: 1, reserve: 1, provider: 0, settle: 0, refund: 1 },
);
await assertProxyStageFailure(
  { credentialMissing: true },
  "PROVIDER_UNAVAILABLE",
  { credential: 1, quote: 1, reserve: 1, provider: 0, settle: 0, refund: 1 },
);
await assertProxyStageFailure(
  { providerAccessor: true },
  "BILLING_OUTCOME_PENDING",
  { credential: 1, quote: 1, reserve: 1, provider: 1, settle: 0, refund: 0 },
);
await assertProxyStageFailure(
  { providerFails: true },
  "BILLING_OUTCOME_PENDING",
  { credential: 1, quote: 1, reserve: 1, provider: 1, settle: 0, refund: 0 },
);
await assertProxyStageFailure(
  { providerTimeout: true },
  "BILLING_OUTCOME_PENDING",
  { credential: 1, quote: 1, reserve: 1, provider: 1, settle: 0, refund: 0 },
);
await assertProxyStageFailure(
  { providerMalformed: true },
  "BILLING_OUTCOME_PENDING",
  { credential: 1, quote: 1, reserve: 1, provider: 1, settle: 0, refund: 0 },
);
await assertProxyStageFailure(
  { providerOutcomeUnknown: true },
  "BILLING_OUTCOME_PENDING",
  { credential: 1, quote: 1, reserve: 1, provider: 1, settle: 0, refund: 0 },
);
await assertProxyStageFailure(
  { providerDefinitiveNotStarted: true },
  "PROVIDER_UNAVAILABLE",
  { credential: 1, quote: 1, reserve: 1, provider: 1, settle: 0, refund: 1 },
);
await assertProxyStageFailure(
  { providerDefinitiveNotStarted: true, refundFails: true },
  "BILLING_OUTCOME_PENDING",
  { credential: 1, quote: 1, reserve: 1, provider: 1, settle: 0, refund: 1 },
);

{
  const fake = proxyDependencies();
  const result = await runFakeHarnessDeskProxyContractPipeline({
    request: proxyRequest,
    config: enabledProxyConfig,
    dependencies: fake.dependencies,
  });
  assert.deepEqual(result, {
    status: "contract_test_completed",
    productId: COMPANY_ACCOUNT_PRODUCT_ID,
    adapterId: HARNESSDESK_PROXY_ADAPTER_ID,
    operation: HARNESSDESK_PROXY_OPERATION,
    model: "deepseek-chat",
  });
  assert.deepEqual(fake.counters, {
    credential: 1,
    quote: 1,
    reserve: 1,
    provider: 1,
    settle: 1,
    refund: 0,
  });
  assert.equal(JSON.stringify(result).includes("FAKE_CREDENTIAL_MARKER"), false);
}

{
  const fake = proxyDependencies({ providerFails: true });
  await assert.rejects(
    runFakeHarnessDeskProxyContractPipeline({
      request: proxyRequest,
      config: enabledProxyConfig,
      dependencies: fake.dependencies,
    }),
    (error: unknown) => {
      assert.ok(error instanceof HarnessDeskProxyPolicyError);
      assert.equal(error.code, "BILLING_OUTCOME_PENDING");
      assert.equal(String(error).includes("PRIVATE_PROVIDER_ERROR"), false);
      return true;
    },
  );
  assert.equal(fake.counters.refund, 0);
}

{
  const fake = proxyDependencies({ settleFails: true });
  await assert.rejects(
    runFakeHarnessDeskProxyContractPipeline({
      request: proxyRequest,
      config: enabledProxyConfig,
      dependencies: fake.dependencies,
    }),
    (error: unknown) => {
      assert.ok(error instanceof HarnessDeskProxyPolicyError);
      assert.equal(error.code, "BILLING_OUTCOME_PENDING");
      assert.equal(String(error).includes("PRIVATE_SETTLE_ERROR"), false);
      return true;
    },
  );
  assert.equal(fake.counters.refund, 0);
}

const sourceFiles = await Promise.all(
  [
    "../lib/company-account/v1/contracts.ts",
    "../lib/company-account/v1/session.ts",
    "../lib/company-account/v1/productGrant.ts",
    "../lib/company-account/v1/proxyPolicy.ts",
    "../app/api/company-account/v1/capabilities/route.ts",
  ].map((path) => readFile(new URL(path, import.meta.url), "utf8")),
);
const combinedSource = sourceFiles.join("\n");
for (const forbiddenSource of [
  "aistory_user_session",
  "readPhoneUserSession",
  "/api/llm/user-proxy",
  "ALIYUN_SMS_",
  "withResolvedHostedCredential",
  "prepareGenerationBilling",
  "process.env",
  "getAdminRepository",
  "appendLedger",
  "adjustCreditsAtomically",
  "reservePlatformOperation",
  "initial_grant",
  "credit_ledger",
  "trilife-company-account-v1",
  "trilife-product-grant",
  "trilife-harness-launch",
  "trilife-harness-desktop",
  "trilife-desk-windows",
  "TriLife Desk",
  "Harness Edition",
  "node:http",
  "node:https",
  "node:net",
  "node:tls",
  "undici",
  "child_process",
  "globalThis.fetch",
]) {
  assert.equal(
    combinedSource.includes(forbiddenSource),
    false,
    `company account source referenced ${forbiddenSource}`,
  );
}
assert.equal(/\bfetch\s*\(/.test(combinedSource), false);
assert.equal(combinedSource.includes("app/app"), false);
assert.equal(combinedSource.includes("components/components"), false);
assert.equal(combinedSource.includes("lib/lib"), false);

const publicSerialization = JSON.stringify({
  capabilities,
  safeError,
  headers: COMPANY_ACCOUNT_NO_STORE_HEADERS,
}).toLowerCase();
for (const marker of [
  "private_api_key_marker",
  "private_prompt_marker",
  "private_provider_error",
  "private_hidden_marker",
  "private_symbol_marker",
]) {
  assert.equal(publicSerialization.includes(marker), false);
}

assert.equal(networkCalls, 0);
globalThis.fetch = originalFetch;
console.log("Company account v1 tests passed (E2 local contract, zero network). ");
