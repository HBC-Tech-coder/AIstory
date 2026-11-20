import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  AIUSER_OIDC_LOCAL_VALIDATE_MODE,
  AIUSER_OIDC_READINESS_MODE_ENV,
  AIUSER_OIDC_REQUIRED_ADAPTER_INPUTS,
  AIUSER_OIDC_REQUIRED_AUTHORITY_PIN_INPUTS,
  computeAiUserOidcAdapterContractFingerprint,
  evaluateAiUserOidcReadiness,
  evaluateAiUserOidcReadinessFromEnvironment,
  validateAiUserOidcAdapterContract,
} from "../lib/auth/aiUserOidcReadiness";

const ORIGINAL_FETCH = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = (async () => {
  fetchCalls += 1;
  throw new Error("network_forbidden");
}) as typeof fetch;

function syntheticContractCore() {
  return {
    schema: "aistory.aiuser-oidc-adapter-contract",
    version: "synthetic-aiuser-adapter-v1",
    contractId: "synthetic.aiuser.local.v1",
    environment: "local",
    issuerUrl: "https://issuer.synthetic.invalid/",
    authorizationEndpointUrl:
      "https://issuer.synthetic.invalid/oauth2/authorize",
    tokenEndpointUrl: "https://issuer.synthetic.invalid/oauth2/token",
    jwksUri: "https://issuer.synthetic.invalid/.well-known/jwks.json",
    client: {
      clientId: "synthetic-local-client",
      authenticationMethod: "client_secret_basic",
      credentialReference: {
        kind: "protected_runtime_reference",
        referenceId: "ref_aiuser_oidc_local_v1",
      },
    },
    redirectUri: "http://127.0.0.1:49152/synthetic/callback",
    audience: "urn:synthetic:aiuser:local",
    scopes: ["profile", "openid"],
    responseType: "code",
    pkceMethod: "S256",
    stateRequired: true,
    nonceRequired: true,
    acceptedIdTokenAlgorithms: ["RS256", "ES256"],
    claims: {
      subject: "sub",
      tenant: "synthetic_tenant",
      accountStatus: "synthetic_status",
    },
    timePolicy: {
      authorizationCodeTtlSeconds: 120,
      tokenClockSkewSeconds: 30,
      jwksCacheMaxAgeSeconds: 3600,
    },
    lifecycle: {
      logoutContract: "synthetic-logout-v1",
      revocationContract: "synthetic-revocation-v1",
      errorContract: "synthetic-error-v1",
    },
    effects: {
      membership: "none",
      entitlement: "none",
      credits: "none",
    },
  };
}

function syntheticContract() {
  const core = syntheticContractCore();
  return {
    ...core,
    contractFingerprintSha256:
      computeAiUserOidcAdapterContractFingerprint(core),
  };
}

function syntheticAuthorityPin() {
  const contract = syntheticContract();
  return {
    version: contract.version,
    contractFingerprintSha256: contract.contractFingerprintSha256,
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function expectBlocked(contract: unknown) {
  const result = evaluateAiUserOidcReadiness({
    mode: AIUSER_OIDC_LOCAL_VALIDATE_MODE,
    adapterContract: contract,
    adapterAuthorityPin: syntheticAuthorityPin(),
  });
  assert.equal(result.status, "BLOCKED_INVALID_ADAPTER_CONTRACT");
  assert.deepEqual(result.blockerCodes, [
    "invalid_aiuser_adapter_contract",
    "oidc_runtime_not_implemented",
    "oidc_login_not_authorized",
    "membership_and_entitlement_side_effects_forbidden",
  ]);
  assert.equal("validatedAdapter" in result, false);
  assertClosed(result);
}

function assertClosed(result: ReturnType<typeof evaluateAiUserOidcReadiness>) {
  assert.equal(result.loginEnabled, false);
  assert.equal(result.callbackEnabled, false);
  assert.equal(result.tokenExchangeAllowed, false);
  assert.equal(result.sessionIssuanceAllowed, false);
  assert.equal(result.accountLinkingAllowed, false);
  assert.equal(result.membershipMutationAllowed, false);
  assert.equal(result.entitlementMutationAllowed, false);
  assert.equal(result.creditGrantAllowed, false);
  assert.equal(result.networkAllowed, false);
  assert.equal(result.networkCalls, 0);
  assert.equal(result.writesPerformed, 0);
}

function reverseKeyOrder(value: unknown): unknown {
  if (Array.isArray(value)) return [...value].reverse().map(reverseKeyOrder);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, entry]) => [key, reverseKeyOrder(entry)]),
    );
  }
  return value;
}

async function run() {
  assert.equal(
    AIUSER_OIDC_READINESS_MODE_ENV,
    "AISTORY_AIUSER_OIDC_READINESS_MODE",
  );

  for (const mode of [undefined, null, "", "disabled"] as const) {
    const result = evaluateAiUserOidcReadiness({ mode });
    assert.equal(result.status, "DISABLED");
    assert.equal(result.mode, "disabled");
    assertClosed(result);
  }
  for (const mode of [
    "true",
    "false",
    "local_validate_only",
    " aistory-aiuser-oidc-readiness-v1:local_validate_only",
    true,
    1,
    {},
  ]) {
    const result = evaluateAiUserOidcReadiness({ mode });
    assert.equal(result.status, "BLOCKED_INVALID_CONFIGURATION");
    assert.equal(result.mode, "invalid");
    assertClosed(result);
  }

  const missingContract = evaluateAiUserOidcReadiness({
    mode: AIUSER_OIDC_LOCAL_VALIDATE_MODE,
  });
  assert.equal(
    missingContract.status,
    "BLOCKED_ADAPTER_CONTRACT_REQUIRED",
  );
  assertClosed(missingContract);

  const contract = syntheticContract();
  const authorityPin = syntheticAuthorityPin();
  const bareIssuerCore = syntheticContractCore();
  bareIssuerCore.issuerUrl = "https://issuer.synthetic.invalid";
  const bareIssuerHash = computeAiUserOidcAdapterContractFingerprint(bareIssuerCore);
  const bareIssuerContract = { ...bareIssuerCore, contractFingerprintSha256: bareIssuerHash };
  assert.equal(validateAiUserOidcAdapterContract(bareIssuerContract).issuerUrl, bareIssuerCore.issuerUrl);
  assert.notEqual(bareIssuerHash, contract.contractFingerprintSha256);
  const bareIssuerReady = evaluateAiUserOidcReadiness({
    mode: AIUSER_OIDC_LOCAL_VALIDATE_MODE,
    adapterContract: bareIssuerContract,
    adapterAuthorityPin: { version: bareIssuerCore.version, contractFingerprintSha256: bareIssuerHash },
  });
  assert.equal(bareIssuerReady.status, "LOCAL_CONFIGURATION_VALIDATED_ONLY");
  assertClosed(bareIssuerReady);
  expectBlocked({ ...bareIssuerContract, issuerUrl: `${bareIssuerCore.issuerUrl}/` });
  // A canonical issuer path is preserved too, not reduced to an origin.
  const pathIssuerCore = { ...bareIssuerCore, issuerUrl: "https://issuer.synthetic.invalid/tenant" };
  assert.equal(validateAiUserOidcAdapterContract({
    ...pathIssuerCore, contractFingerprintSha256: computeAiUserOidcAdapterContractFingerprint(pathIssuerCore),
  }).issuerUrl, pathIssuerCore.issuerUrl);
  for (const issuerUrl of [
    "https://issuer.synthetic.invalid/?", "https://issuer.synthetic.invalid/#",
    "https://issuer.synthetic.invalid?query=forbidden", "https://issuer.synthetic.invalid#fragment",
    " https://issuer.synthetic.invalid", "https://issuer.synthetic.invalid ",
    "HTTPS://issuer.synthetic.invalid", "https://ISSUER.synthetic.invalid",
    "https://issuer.synthetic.invalid:443", "https://user:pass@issuer.synthetic.invalid",
    "http://issuer.synthetic.invalid", "https://issuer.synthetic.invalid/a/../",
    "https://issuer.synthetic.invalid/\tpath", "https://issuer.synthetic.invalid\\path",
  ]) {
    assert.throws(() => computeAiUserOidcAdapterContractFingerprint({ ...bareIssuerCore, issuerUrl }), {
      message: "invalid_adapter_contract",
    });
  }
  for (const field of ["authorizationEndpointUrl", "tokenEndpointUrl", "jwksUri", "redirectUri"]) {
    assert.throws(() => computeAiUserOidcAdapterContractFingerprint({
      ...bareIssuerCore, [field]: "https://issuer.synthetic.invalid",
    }), { message: "invalid_adapter_contract" });
  }
  const validatedContract = validateAiUserOidcAdapterContract(contract);
  assert.equal(
    validatedContract.contractFingerprintSha256,
    contract.contractFingerprintSha256,
  );
  const ready = evaluateAiUserOidcReadiness({
    mode: AIUSER_OIDC_LOCAL_VALIDATE_MODE,
    adapterContract: contract,
    adapterAuthorityPin: authorityPin,
  });
  assert.equal(ready.status, "LOCAL_CONFIGURATION_VALIDATED_ONLY");
  assert.deepEqual(ready.validatedAdapter, {
    version: "synthetic-aiuser-adapter-v1",
    contractFingerprintSha256: contract.contractFingerprintSha256,
  });
  assert.deepEqual(
    ready.requiredAdapterInputs,
    AIUSER_OIDC_REQUIRED_ADAPTER_INPUTS,
  );
  assert.deepEqual(
    ready.requiredAuthorityPinInputs,
    AIUSER_OIDC_REQUIRED_AUTHORITY_PIN_INPUTS,
  );
  assertClosed(ready);

  const sensitiveValues = [
    contract.issuerUrl,
    contract.authorizationEndpointUrl,
    contract.tokenEndpointUrl,
    contract.jwksUri,
    contract.client.clientId,
    contract.client.credentialReference.referenceId,
    contract.redirectUri,
    contract.audience,
    contract.claims.tenant,
    contract.claims.accountStatus,
  ];
  const publicJson = JSON.stringify(ready);
  for (const value of sensitiveValues) {
    assert.equal(publicJson.includes(value), false);
  }
  for (const forbiddenKey of [
    "clientSecret",
    "password",
    "accessToken",
    "refreshToken",
    "idToken",
    "authorizationCode",
  ]) {
    assert.equal(publicJson.includes(`"${forbiddenKey}":`), false);
  }

  const reorderedCore = reverseKeyOrder(syntheticContractCore());
  assert.equal(
    computeAiUserOidcAdapterContractFingerprint(reorderedCore),
    contract.contractFingerprintSha256,
  );
  const reorderedContract = {
    ...(reorderedCore as ReturnType<typeof syntheticContractCore>),
    contractFingerprintSha256: contract.contractFingerprintSha256,
  };
  const reorderedProjection = evaluateAiUserOidcReadiness({
    mode: AIUSER_OIDC_LOCAL_VALIDATE_MODE,
    adapterContract: reorderedContract,
    adapterAuthorityPin: authorityPin,
  });
  assert.equal(JSON.stringify(reorderedProjection), JSON.stringify(ready));

  const driftedFingerprint = clone(contract);
  driftedFingerprint.contractFingerprintSha256 = "0".repeat(64);
  expectBlocked(driftedFingerprint);

  const missingAuthorityPin = evaluateAiUserOidcReadiness({
    mode: AIUSER_OIDC_LOCAL_VALIDATE_MODE,
    adapterContract: contract,
  });
  assert.equal(
    missingAuthorityPin.status,
    "BLOCKED_ADAPTER_AUTHORITY_PIN_REQUIRED",
  );
  assertClosed(missingAuthorityPin);
  for (const badPin of [
    { ...authorityPin, version: "different-adapter-v1" },
    { ...authorityPin, contractFingerprintSha256: "f".repeat(64) },
    { ...authorityPin, extra: true },
  ]) {
    const blockedPin = evaluateAiUserOidcReadiness({
      mode: AIUSER_OIDC_LOCAL_VALIDATE_MODE,
      adapterContract: contract,
      adapterAuthorityPin: badPin,
    });
    assert.equal(
      blockedPin.status,
      "BLOCKED_INVALID_ADAPTER_AUTHORITY_PIN",
    );
    assertClosed(blockedPin);
  }

  const fromEnvironment = evaluateAiUserOidcReadinessFromEnvironment({
    environment: {
      [AIUSER_OIDC_READINESS_MODE_ENV]: AIUSER_OIDC_LOCAL_VALIDATE_MODE,
    },
    adapterContract: contract,
    adapterAuthorityPin: authorityPin,
  });
  assert.equal(JSON.stringify(fromEnvironment), JSON.stringify(ready));
  let environmentAccessorCalls = 0;
  const accessorEnvironment = {};
  Object.defineProperty(accessorEnvironment, AIUSER_OIDC_READINESS_MODE_ENV, {
    enumerable: true,
    get() {
      environmentAccessorCalls += 1;
      return AIUSER_OIDC_LOCAL_VALIDATE_MODE;
    },
  });
  assert.equal(
    evaluateAiUserOidcReadinessFromEnvironment({
      environment: accessorEnvironment,
    }).status,
    "BLOCKED_INVALID_CONFIGURATION",
  );
  assert.equal(environmentAccessorCalls, 0);

  const hostileCases: unknown[] = [];
  const extraRoot = clone(contract) as Record<string, unknown>;
  extraRoot.clientSecret = "synthetic-forbidden-value";
  hostileCases.push(extraRoot);

  const missingAudience = clone(contract) as Record<string, unknown>;
  delete missingAudience.audience;
  hostileCases.push(missingAudience);

  const wrongSchema = clone(contract);
  wrongSchema.schema = "aistory.aiuser-oidc-adapter-contract-v0";
  hostileCases.push(wrongSchema);

  const badIssuer = clone(contract);
  badIssuer.issuerUrl = "http://issuer.synthetic.invalid/";
  hostileCases.push(badIssuer);

  const issuerQuery = clone(contract);
  issuerQuery.issuerUrl =
    "https://issuer.synthetic.invalid/?client_secret=forbidden";
  hostileCases.push(issuerQuery);

  const badEndpoint = clone(contract);
  badEndpoint.tokenEndpointUrl = "https://user:pass@issuer.synthetic.invalid/token";
  hostileCases.push(badEndpoint);

  const badRedirect = clone(contract);
  badRedirect.redirectUri = "http://example.invalid/callback";
  hostileCases.push(badRedirect);

  const missingOpenId = clone(contract);
  missingOpenId.scopes = ["profile"];
  hostileCases.push(missingOpenId);

  const duplicateScope = clone(contract);
  duplicateScope.scopes = ["openid", "openid"];
  hostileCases.push(duplicateScope);

  const weakAlgorithm = clone(contract);
  weakAlgorithm.acceptedIdTokenAlgorithms = ["HS256"];
  hostileCases.push(weakAlgorithm);

  const noPkce = clone(contract);
  noPkce.pkceMethod = "plain";
  hostileCases.push(noPkce);

  const noState = clone(contract);
  noState.stateRequired = false;
  hostileCases.push(noState);

  const embeddedCredential = clone(contract);
  (embeddedCredential.client as unknown as Record<string, unknown>).clientSecret =
    "synthetic-forbidden-value";
  hostileCases.push(embeddedCredential);

  const wrongStorage = clone(contract);
  wrongStorage.client.credentialReference.kind = "inline";
  hostileCases.push(wrongStorage);

  const rawCredentialReference = clone(contract);
  rawCredentialReference.client.credentialReference.referenceId =
    "synthetic-inline-secret-value";
  hostileCases.push(rawCredentialReference);

  const membershipMutation = clone(contract);
  membershipMutation.effects.membership = "grant";
  hostileCases.push(membershipMutation);

  const entitlementMutation = clone(contract);
  entitlementMutation.effects.entitlement = "derive";
  hostileCases.push(entitlementMutation);

  const creditMutation = clone(contract);
  creditMutation.effects.credits = "grant";
  hostileCases.push(creditMutation);

  const accessor = clone(contract);
  Object.defineProperty(accessor, "audience", {
    enumerable: true,
    get() {
      throw new Error("accessor_must_not_run");
    },
  });
  hostileCases.push(accessor);

  const prototype = clone(contract);
  Object.setPrototypeOf(prototype, { polluted: true });
  hostileCases.push(prototype);

  const symbol = clone(contract) as Record<PropertyKey, unknown>;
  symbol[Symbol("forbidden")] = true;
  hostileCases.push(symbol);

  const sparseScopes = clone(contract);
  sparseScopes.scopes = new Array(2) as string[];
  sparseScopes.scopes[1] = "openid";
  hostileCases.push(sparseScopes);

  for (const hostile of hostileCases) expectBlocked(hostile);

  const modulePath = fileURLToPath(
    new URL("../lib/auth/aiUserOidcReadiness.ts", import.meta.url),
  );
  const source = await readFile(modulePath, "utf8");
  for (const forbiddenImport of [
    "company-account",
    "userSession",
    "phoneAuth",
    "billing",
    "independentPrincipal",
    "supabase",
    "app/auth/callback",
    "openid-client",
    "oauth4webapi",
    "jose",
  ]) {
    assert.equal(source.includes(forbiddenImport), false);
  }
  assert.equal(/\bfetch\s*\(/.test(source), false);
  assert.equal(source.includes("process.env"), false);
  assert.equal(fetchCalls, 0);

  console.log(
    JSON.stringify({
      status: "PASS_LOCAL_AIUSER_OIDC_READINESS_ONLY",
      validatedStatus: ready.status,
      requiredInputs: AIUSER_OIDC_REQUIRED_ADAPTER_INPUTS.length,
      loginEnabled: ready.loginEnabled,
      membershipMutationAllowed: ready.membershipMutationAllowed,
      entitlementMutationAllowed: ready.entitlementMutationAllowed,
      networkCalls: fetchCalls,
      writesPerformed: ready.writesPerformed,
    }),
  );
}

try {
  await run();
} finally {
  globalThis.fetch = ORIGINAL_FETCH;
}
