import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import {
  AIUSER_OIDC_LOCAL_VALIDATE_MODE,
  computeAiUserOidcAdapterContractFingerprint,
} from "../lib/auth/aiUserOidcReadiness";

const originalFetch = globalThis.fetch;
let networkCalls = 0;
let writesPerformed = 0;
let accessorCalls = 0;
let assertions = 0;
const restorations: (() => void)[] = [];

globalThis.fetch = (async () => {
  networkCalls += 1;
  throw new Error("network_forbidden");
}) as typeof fetch;
for (const [target, names] of [
  [fs, ["writeFile", "writeFileSync", "appendFile", "appendFileSync", "rename", "renameSync", "mkdir", "mkdirSync", "rm", "rmSync", "unlink", "unlinkSync"]],
  [fsPromises, ["writeFile", "appendFile", "rename", "mkdir", "rm", "unlink"]],
] as const) {
  for (const name of names) {
    const original = Object.getOwnPropertyDescriptor(target, name)!;
    Object.defineProperty(target, name, {
      ...original,
      value: () => { writesPerformed += 1; throw new Error("write_forbidden"); },
    });
    restorations.push(() => Object.defineProperty(target, name, original));
  }
}

try {
  const {
    AIUSER_OIDC_PRODUCTION_BETA_REGISTRATION: selected,
    AIUSER_OIDC_PRODUCTION_BETA_REGISTRATION_SHA256: registrationHash,
    evaluateAiUserOidcProductionBeta: evaluate,
    serializeAiUserOidcProductionBetaRegistration: serialize,
  } = await import("../lib/auth/aiUserOidcProductionBeta");

  function assertClosed(result: ReturnType<typeof evaluate>) {
    assertions += 1;
    for (const key of [
      "loginEnabled", "callbackEnabled", "tokenExchangeAllowed", "sessionIssuanceAllowed",
      "accountLinkingAllowed", "membershipMutationAllowed", "entitlementMutationAllowed",
      "creditGrantAllowed", "networkAllowed",
    ] as const) assert.equal(result[key], false);
    assert.equal(result.networkCalls, 0);
    assert.equal(result.writesPerformed, 0);
    assert.equal(result.registrationFingerprintSha256, registrationHash);
    assert.ok(result.blockerCodes.includes("login_business_side_effects_forbidden"));
    assert.ok(result.blockerCodes.includes("oidc_runtime_not_implemented"));
    assert.ok(result.blockerCodes.includes("credential_reference_not_resolved"));
    const json = JSON.stringify(result);
    for (const forbidden of [
      selected.clientId, selected.redirectUri, selected.audience,
      selected.credentialReference.referenceId, selected.authorityOrigin,
      "synthetic-forbidden-value", "SENSITIVE_RAW_EXCEPTION",
      '"password":', '"clientSecret":', '"accessToken":', '"refreshToken":',
    ]) assert.equal(json.includes(forbidden), false);
    if (result.status !== "LOCAL_PRODUCTION_BINDING_VALIDATED_ONLY") {
      assert.equal("matchedAdapterFingerprintSha256" in result, false);
    }
  }

  function syntheticCore() {
    // Authority-supplied URLs with fake claims/lifecycle/pin; never a registry release.
    return {
      schema: "aistory.aiuser-oidc-adapter-contract",
      version: "synthetic-production-beta-test-v2",
      contractId: "synthetic.aistory.production.beta.v2",
      environment: selected.environment,
      issuerUrl: selected.issuerUrl,
      authorizationEndpointUrl: `${selected.authorityOrigin}/v1/oauth/authorize`,
      tokenEndpointUrl: `${selected.authorityOrigin}/v1/oauth/token`,
      jwksUri: `${selected.authorityOrigin}/v1/oauth/jwks`,
      client: {
        clientId: selected.clientId,
        authenticationMethod: selected.authenticationMethod,
        credentialReference: structuredClone(selected.credentialReference),
      },
      redirectUri: selected.redirectUri,
      audience: selected.audience,
      scopes: [...selected.scopes],
      responseType: selected.responseType,
      pkceMethod: selected.pkceMethod,
      stateRequired: selected.stateRequired,
      nonceRequired: selected.nonceRequired,
      acceptedIdTokenAlgorithms: ["ES256"],
      claims: { subject: "sub", tenant: null, accountStatus: "synthetic_status" },
      timePolicy: { authorizationCodeTtlSeconds: 90, tokenClockSkewSeconds: 5, jwksCacheMaxAgeSeconds: 300 },
      lifecycle: { logoutContract: "synthetic-logout-v1", revocationContract: "synthetic-revoke-v1", errorContract: "synthetic-error-v1" },
      effects: structuredClone(selected.effects),
    };
  }

  function optionsFor(core: unknown = syntheticCore()) {
    const hash = computeAiUserOidcAdapterContractFingerprint(core);
    const record = core as Record<string, unknown>;
    return {
      mode: AIUSER_OIDC_LOCAL_VALIDATE_MODE,
      adapterContract: { ...record, contractFingerprintSha256: hash },
      adapterAuthorityPin: { version: record.version, contractFingerprintSha256: hash },
    };
  }

  function replace(root: unknown, path: string[], value: unknown) {
    let node = root as Record<string, unknown>;
    for (const key of path.slice(0, -1)) node = node[key] as Record<string, unknown>;
    node[path.at(-1)!] = value;
  }

  function reverseKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(reverseKeys);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reverseKeys(entry)]));
    }
    return value;
  }

  assert.equal(selected.clientId, "aistory-web-production-beta-v1");
  assert.equal(selected.redirectUri, "https://play.hibcglobal.com/api/auth/aiuser/callback");
  assert.equal(selected.audience, "urn:hibc:aiuser:aistory:production-beta:v1");
  assert.equal(selected.resource, selected.audience);
  assert.equal(selected.authenticationMethod, "client_secret_basic");
  assert.equal(selected.credentialReference.referenceId, "ref_aistory_aiuser_oidc_production_beta_v1");
  assert.equal(selected.schema, "aistory.aiuser-oidc-client-registration.v2");
  assert.equal(selected.version, "production-beta-v2");
  assert.equal(selected.issuerUrl, "https://id.hibcglobal.com");
  assert.deepEqual(selected.scopes, ["openid", "product.access"]);
  assert.equal((selected.scopes as readonly string[]).includes("offline_access"), false);
  assert.equal(selected.pkceMethod, "S256");
  assert.equal(new URL(selected.redirectUri).origin, selected.publicOrigin);
  assert.equal(Object.isFrozen(selected), true);
  assert.equal(Object.isFrozen(selected.credentialReference), true);
  assert.equal(Object.isFrozen(selected.scopes), true);
  assert.equal(Object.isFrozen(selected.effects), true);
  const canonical = serialize();
  assert.equal(registrationHash, "62e0420083beb1f9295f049b1c82e0e4d4a532ac79dbd31f36657426ea7371d6");
  assert.equal(serialize(JSON.parse(canonical)), canonical);
  assert.equal(serialize(reverseKeys(selected)), canonical);
  assert.equal(registrationHash, createHash("sha256").update(canonical, "utf8").digest("hex"));

  for (const mode of [undefined, null, "", "disabled"]) {
    const result = evaluate({ mode });
    assert.equal(result.status, "DISABLED");
    assertClosed(result);
  }
  assert.equal(evaluate().status, "DISABLED");
  for (const mode of [true, false, "enabled", "production", "true", "local_validate_only", ` ${AIUSER_OIDC_LOCAL_VALIDATE_MODE}`, {}, Symbol("bad")]) {
    const result = evaluate({ mode });
    assert.equal(result.status, "BLOCKED_INVALID_CONFIGURATION");
    assertClosed(result);
  }
  const missing = evaluate({ mode: AIUSER_OIDC_LOCAL_VALIDATE_MODE });
  assert.equal(missing.status, "BLOCKED_ADAPTER_CONTRACT_REQUIRED");
  assertClosed(missing);

  const good = optionsFor();
  const success = evaluate(good);
  assert.equal(success.status, "LOCAL_PRODUCTION_BINDING_VALIDATED_ONLY");
  assertClosed(success);
  assert.equal(JSON.stringify(evaluate(good)), JSON.stringify(success));
  const reordered = reverseKeys(syntheticCore()) as ReturnType<typeof syntheticCore>;
  reordered.acceptedIdTokenAlgorithms.reverse();
  reordered.scopes.reverse();
  assert.deepEqual(evaluate(optionsFor(reordered)), success);

  const tupleDrifts: [string[], unknown][] = [
    [["environment"], "local"],
    [["client", "clientId"], "different-product-client"],
    [["client", "authenticationMethod"], "private_key_jwt"],
    [["client", "credentialReference", "referenceId"], "ref_other_product_v1"],
    [["redirectUri"], "https://play.hibcglobal.com/auth/callback"],
    [["redirectUri"], `${selected.redirectUri}/`],
    [["redirectUri"], "https://other.synthetic.invalid/api/auth/aiuser/callback"],
    [["audience"], "urn:synthetic:other-product"],
    [["scopes"], ["openid", "profile"]],
    [["scopes"], ["openid"]],
    [["scopes"], ["openid", "offline_access"]],
    [["scopes"], ["openid", "product.access", "offline_access"]],
    [["issuerUrl"], `${selected.issuerUrl}/`],
    [["issuerUrl"], `${selected.issuerUrl}/synthetic/issuer`],
    ...["issuerUrl", "authorizationEndpointUrl", "tokenEndpointUrl", "jwksUri"].map(
      (field): [string[], unknown] => [[field], "https://other.synthetic.invalid/"],
    ),
  ];
  for (const [path, value] of tupleDrifts) {
    const core = syntheticCore();
    replace(core, path, value);
    // Rehash AND repin: exact AIstory binding cannot be bypassed with a valid self-hash.
    const result = evaluate(optionsFor(core));
    assert.equal(result.status, "BLOCKED_PRODUCTION_BINDING_MISMATCH");
    assertClosed(result);
  }

  const contractDrifts: [string[], unknown][] = [
    [["schema"], "unknown"], [["version"], "unknown"], [["contractId"], "unknown"],
    [["contractFingerprintSha256"], "0".repeat(64)],
    [["client", "authenticationMethod"], "none"],
    [["client", "credentialReference", "kind"], "inline"],
    [["client", "clientSecret"], "synthetic-forbidden-value"],
    [["redirectUri"], `${selected.redirectUri}?next=forbidden`],
    [["responseType"], "token"], [["pkceMethod"], "plain"],
    [["stateRequired"], false], [["nonceRequired"], false],
    [["effects", "membership"], "grant"], [["effects", "entitlement"], "derive"], [["effects", "credits"], "grant"],
    [["scopes"], ["openid", "openid"]], [["acceptedIdTokenAlgorithms"], ["HS256"]],
    [["password"], "synthetic-forbidden-value"],
  ];
  for (const [path, value] of contractDrifts) {
    const input = structuredClone(good);
    replace(input.adapterContract, path, value);
    const result = evaluate(input);
    assert.equal(result.status, "BLOCKED_INVALID_ADAPTER_CONTRACT");
    assertClosed(result);
  }
  const issuerSpellingDrift = structuredClone(good);
  replace(issuerSpellingDrift.adapterContract, ["issuerUrl"], `${selected.issuerUrl}/`);
  const staleIssuerHash = evaluate(issuerSpellingDrift);
  assert.equal(staleIssuerHash.status, "BLOCKED_INVALID_ADAPTER_CONTRACT");
  assertClosed(staleIssuerHash);
  const missingPin = evaluate({ mode: good.mode, adapterContract: good.adapterContract });
  assert.equal(missingPin.status, "BLOCKED_ADAPTER_AUTHORITY_PIN_REQUIRED");
  assertClosed(missingPin);
  for (const pin of [null, { ...good.adapterAuthorityPin, version: "drift-v1" }, { ...good.adapterAuthorityPin, contractFingerprintSha256: "f".repeat(64) }, { ...good.adapterAuthorityPin, extra: true }]) {
    const result = evaluate({ ...good, adapterAuthorityPin: pin });
    assert.equal(result.status, "BLOCKED_INVALID_ADAPTER_AUTHORITY_PIN");
    assertClosed(result);
  }

  for (const location of ["options", "contract", "client", "reference", "scopes", "pin", "effects"] as const) {
    for (const attack of ["accessor", "symbol", "prototype", "hidden", "missing"] as const) {
      const input = structuredClone(good);
      const record = input.adapterContract as Record<string, unknown>;
      const client = record.client as Record<string, unknown>;
      const target = {
        options: input, contract: record, client, reference: client.credentialReference,
        scopes: record.scopes, pin: input.adapterAuthorityPin, effects: record.effects,
      }[location] as Record<PropertyKey, unknown>;
      const key = Object.keys(target)[0]!;
      if (attack === "accessor") Object.defineProperty(target, key, {
        enumerable: true, get() { accessorCalls += 1; throw new Error("SENSITIVE_RAW_EXCEPTION"); },
      });
      if (attack === "symbol") target[Symbol("synthetic")] = true;
      if (attack === "prototype") Object.setPrototypeOf(target, { polluted: true });
      if (attack === "hidden") Object.defineProperty(target, key, { enumerable: false });
      if (attack === "missing") delete target[key];
      const result = evaluate(input);
      // Removing the optional mode intentionally returns default-off, never a pass.
      assert.notEqual(result.status, "LOCAL_PRODUCTION_BINDING_VALIDATED_ONLY");
      assertClosed(result);
    }
  }

  for (const attack of [null, [], Object.create(null), { ...good, unexpected: true }, new Proxy({}, { ownKeys() { throw new Error("SENSITIVE_RAW_EXCEPTION"); } })]) {
    const result = evaluate(attack);
    assert.equal(result.status, "BLOCKED_INVALID_CONFIGURATION");
    assertClosed(result);
  }
  for (const path of [["clientId"], ["resource"], ["version"], ["redirectUri"], ["authenticationMethod"], ["credentialReference", "referenceId"], ["effects", "credits"]]) {
    const registration = structuredClone(selected);
    replace(registration, path, "synthetic-forbidden-value");
    assert.throws(() => serialize(registration), { message: "invalid_aistory_oidc_registration" });
  }
  const oldRegistration = JSON.parse(canonical) as Record<string, unknown>;
  oldRegistration.schema = "aistory.aiuser-oidc-client-registration.v1";
  oldRegistration.version = "production-beta-v1";
  oldRegistration.scopes = ["openid"];
  delete oldRegistration.issuerUrl;
  assert.throws(() => serialize(oldRegistration), { message: "invalid_aistory_oidc_registration" });
  assert.notEqual(registrationHash, "f117ef2925e5def943d65437d5016ee7aa7afedd2d8d91ccc8c53367aeb87d0f");
  for (const location of ["root", "reference", "scopes", "effects"]) {
    for (const attack of ["accessor", "symbol", "prototype", "hidden", "missing", "extra"]) {
      const registration = structuredClone(selected);
      const target = ({ root: registration, reference: registration.credentialReference, scopes: registration.scopes, effects: registration.effects } as Record<string, unknown>)[location] as Record<PropertyKey, unknown>;
      const key = Object.keys(target)[0]!;
      if (attack === "accessor") Object.defineProperty(target, key, { enumerable: true, get() { accessorCalls += 1; throw new Error("SENSITIVE_RAW_EXCEPTION"); } });
      if (attack === "symbol") target[Symbol("bad")] = true;
      if (attack === "prototype") Object.setPrototypeOf(target, null);
      if (attack === "hidden") Object.defineProperty(target, key, { enumerable: false });
      if (attack === "missing") delete target[key];
      if (attack === "extra") target.extra = true;
      assert.throws(() => serialize(registration), { message: "invalid_aistory_oidc_registration" });
    }
  }
  assert.throws(() => serialize(new Proxy({}, { getPrototypeOf() { throw new Error("SENSITIVE_RAW_EXCEPTION"); } })), { message: "invalid_aistory_oidc_registration" });

  for (const [path, allowedImports] of [
    ["../lib/auth/aiUserOidcProductionBeta.ts", ["server-only", "node:crypto", "@/lib/auth/aiUserOidcReadiness"]],
    ["../lib/auth/aiUserOidcReadiness.ts", ["server-only", "node:crypto"]],
  ] as const) {
    const source = await fsPromises.readFile(new URL(path, import.meta.url), "utf8");
    const imports = [...source.matchAll(/(?:from\s*|import\s*)["']([^"']+)["']/g)].map((match) => match[1]).sort();
    assert.deepEqual(imports, [...allowedImports].sort());
    assert.equal(/\b(?:fetch|require|import)\s*\(|process\.env|XMLHttpRequest|WebSocket/.test(source), false);
  }
  const runbook = await fsPromises.readFile(new URL("../runbooks/aiuser-oidc-readiness-v1.md", import.meta.url), "utf8");
  for (const value of [selected.clientId, selected.redirectUri, selected.audience, selected.credentialReference.referenceId]) assert.ok(runbook.includes(value));
  assert.equal(networkCalls, 0);
  assert.equal(writesPerformed, 0);
  assert.equal(accessorCalls, 0);
  console.log(JSON.stringify({
    status: "PASS_LOCAL_AIUSER_PRODUCTION_BETA_BINDING_ONLY",
    registrationFingerprintSha256: registrationHash,
    evaluatedCases: assertions,
    exactBindingDrifts: tupleDrifts.length,
    malformedContractDrifts: contractDrifts.length,
    loginEnabled: false, callbackEnabled: false,
    membershipMutationAllowed: false, entitlementMutationAllowed: false, creditGrantAllowed: false,
    networkCalls, writesPerformed, accessorCalls,
  }));
} finally {
  globalThis.fetch = originalFetch;
  for (const restore of restorations.reverse()) restore();
}
