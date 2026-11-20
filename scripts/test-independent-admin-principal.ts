import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import {
  authenticateIndependentAdminPrincipal,
  createIndependentAdminPrincipalCredential,
  handleIndependentAdminPrincipalLoginRequest,
  independentAdminPrincipalCookieOptions,
  INDEPENDENT_ADMIN_PRINCIPAL_COOKIE,
  INDEPENDENT_ADMIN_PRINCIPAL_CREDENTIAL_FILE_ENV,
  INDEPENDENT_ADMIN_PRINCIPAL_MODE,
  INDEPENDENT_ADMIN_PRINCIPAL_MODE_ENV,
  InMemoryIndependentAdminPrincipalAuthStateStore,
  parseIndependentAdminPrincipalCredential,
  requireIndependentAdminPrincipalRole,
  revokeIndependentAdminPrincipalSession,
  serializeIndependentAdminPrincipalCredential,
  validateIndependentAdminPrincipalCredential,
  validateIndependentAdminPrincipalFileReference,
  verifyIndependentAdminPrincipalSession,
  type IndependentAdminPrincipalRuntime,
} from "@/lib/admin/independentPrincipal";
import { isIndependentAdminPasswordAllowed } from "@/lib/admin/independentPasswordPolicy";

const fixtureUsername = "synthetic_admin";
const fixturePassword = "synthetic-only-password-7M!q2V#9pL";
const wrongPassword = "synthetic-only-password-4X!r8K#1zN";
const fixtureNow = Date.parse("2026-08-28T12:00:00.000Z");
const credentialReference =
  "/run/credentials/aistory-iy.service/admin-principal-v1.json";

let randomFill = 1;
const credential = await createIndependentAdminPrincipalCredential({
  username: fixtureUsername,
  password: fixturePassword,
  random: (bytes) => Buffer.alloc(bytes, randomFill++),
});
const credentialRaw = serializeIndependentAdminPrincipalCredential(credential);

function runtime(
  store = new InMemoryIndependentAdminPrincipalAuthStateStore(),
  overrides: Partial<IndependentAdminPrincipalRuntime> = {},
): IndependentAdminPrincipalRuntime {
  let sessionFill = 40;
  return {
    env: {
      [INDEPENDENT_ADMIN_PRINCIPAL_MODE_ENV]:
        INDEPENDENT_ADMIN_PRINCIPAL_MODE,
      [INDEPENDENT_ADMIN_PRINCIPAL_CREDENTIAL_FILE_ENV]:
        credentialReference,
    },
    workspaceRoot: "/opt/aistory/current",
    now: fixtureNow,
    loadCredentialFile: async () => credentialRaw,
    store,
    randomSessionBytes: () => Buffer.alloc(32, sessionFill++),
    ...overrides,
  };
}

function loginRequest(body: unknown, options: {
  origin?: string;
  host?: string;
  contentType?: string;
  url?: string;
} = {}): Request {
  return new Request(
    options.url ?? "http://127.0.0.1:4200/api/admin/session",
    {
    method: "POST",
    headers: {
      origin: options.origin ?? "http://127.0.0.1:4200",
      host: options.host ?? "127.0.0.1:4200",
      "content-type": options.contentType ?? "application/json",
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
    },
  );
}

async function responseReceipt(response: Response): Promise<{
  status: number;
  body: string;
}> {
  return { status: response.status, body: await response.text() };
}

const originalFetch = globalThis.fetch;
let fetchCalls = 0;
Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  value: async () => {
    fetchCalls += 1;
    throw new Error("network forbidden");
  },
});

try {
  assert.deepEqual(
    parseIndependentAdminPrincipalCredential(credentialRaw),
    credential,
  );
  assert.equal(
    credentialRaw,
    serializeIndependentAdminPrincipalCredential(
      parseIndependentAdminPrincipalCredential(credentialRaw),
    ),
  );
  assert.equal(credentialRaw.includes(fixtureUsername), false);
  assert.equal(credentialRaw.includes(fixturePassword), false);
  assert.equal(credentialRaw.includes(wrongPassword), false);
  assert.equal(
    INDEPENDENT_ADMIN_PRINCIPAL_COOKIE,
    "__Host-aistory_admin_principal_v1",
  );
  assert.deepEqual(independentAdminPrincipalCookieOptions(), {
    httpOnly: true,
    sameSite: "strict",
    secure: true,
    path: "/",
    maxAge: 900,
  });
  await assert.rejects(
    createIndependentAdminPrincipalCredential({
      username: fixtureUsername,
      password: "a".repeat(32),
    }),
  );
  assert.equal(
    isIndependentAdminPasswordAllowed(`${fixtureUsername}Aa1!`),
    true,
  );

  for (const invalid of [
    { ...credential, schemaVersion: 2 },
    { ...credential, policyId: "unknown" },
    { ...credential, principalId: "founder" },
    { ...credential, status: "disabled" },
    { ...credential, usernameVerifierHmacSha256: "f".repeat(63) },
    { ...credential, keyMaterialBase64url: "short" },
    { ...credential, unexpected: true },
    {
      ...credential,
      passwordVerifier: { ...credential.passwordVerifier, N: 1024 },
    },
    {
      ...credential,
      passwordVerifier: {
        ...credential.passwordVerifier,
        unexpected: true,
      },
    },
  ]) assert.throws(() => validateIndependentAdminPrincipalCredential(invalid));
  const missing = { ...credential } as Record<string, unknown>;
  delete missing.credentialEpoch;
  assert.throws(() => validateIndependentAdminPrincipalCredential(missing));
  const nullPrototype = Object.assign(Object.create(null), credential);
  assert.throws(
    () => validateIndependentAdminPrincipalCredential(nullPrototype),
  );
  const accessor = { ...credential } as Record<string, unknown>;
  Object.defineProperty(accessor, "principalId", {
    enumerable: true,
    get: () => credential.principalId,
  });
  assert.throws(() => validateIndependentAdminPrincipalCredential(accessor));
  const symbolRecord = { ...credential } as Record<PropertyKey, unknown>;
  symbolRecord[Symbol("hidden")] = true;
  assert.throws(() => validateIndependentAdminPrincipalCredential(symbolRecord));
  assert.throws(
    () => parseIndependentAdminPrincipalCredential(JSON.stringify(credential)),
  );
  assert.throws(
    () => parseIndependentAdminPrincipalCredential(`\uFEFF${credentialRaw}`),
  );
  assert.throws(
    () => parseIndependentAdminPrincipalCredential(
      credentialRaw.replace(
        '  "schemaVersion": 1,',
        '  "schemaVersion": 1,\n  "schemaVersion": 1,',
      ),
    ),
  );

  assert.equal(
    validateIndependentAdminPrincipalFileReference(
      credentialReference,
      "/opt/aistory/current",
      "linux",
    ),
    credentialReference,
  );
  for (const invalidReference of [
    "relative/credential.json",
    "//network/credential.json",
    "/opt/aistory/current/credential.json",
  ]) assert.throws(() => validateIndependentAdminPrincipalFileReference(
    invalidReference,
    "/opt/aistory/current",
    "linux",
  ));
  assert.throws(() => validateIndependentAdminPrincipalFileReference(
    credentialReference,
    "/opt/aistory/current",
    "win32",
  ));

  let disabledLoaderCalls = 0;
  const disabledRuntime = runtime(undefined, {
    env: {},
    loadCredentialFile: async () => {
      disabledLoaderCalls += 1;
      return credentialRaw;
    },
  });
  await assert.rejects(
    authenticateIndependentAdminPrincipal({
      username: fixtureUsername,
      password: fixturePassword,
      clientBucket: "direct-client",
      runtime: disabledRuntime,
    }),
    (error: unknown) =>
      error instanceof Error
      && error.message === "Administrator sign-in is unavailable.",
  );
  assert.equal(disabledLoaderCalls, 0);
  const disabledHandlerStore = new InMemoryIndependentAdminPrincipalAuthStateStore();
  const disabledHandler = await handleIndependentAdminPrincipalLoginRequest(
    loginRequest({ username: fixtureUsername, password: fixturePassword }),
    runtime(disabledHandlerStore, {
      env: {},
      loadCredentialFile: async () => {
        disabledLoaderCalls += 1;
        return credentialRaw;
      },
    }),
  );
  assert.equal(disabledHandler.response.status, 503);
  assert.equal(disabledHandler.response.headers.get("cache-control"), "no-store");
  assert.equal(disabledLoaderCalls, 0);
  assert.deepEqual(disabledHandlerStore.listAudit(), []);

  const enumerationReceipts: Array<{ status: number; body: string }> = [];
  for (const body of [
    { username: "unknown_admin", password: fixturePassword },
    { username: fixtureUsername, password: wrongPassword },
  ]) {
    let kdfCalls = 0;
    const attempt = await handleIndependentAdminPrincipalLoginRequest(
      loginRequest(body),
      runtime(undefined, { onPasswordKdf: () => { kdfCalls += 1; } }),
    );
    enumerationReceipts.push(await responseReceipt(attempt.response));
    assert.equal(attempt.sessionToken, undefined);
    assert.equal(kdfCalls, 1);
  }
  let missingFieldKdfCalls = 0;
  const missingFieldAttempt = await handleIndependentAdminPrincipalLoginRequest(
    loginRequest({ username: fixtureUsername }),
    runtime(undefined, {
      onPasswordKdf: () => { missingFieldKdfCalls += 1; },
    }),
  );
  enumerationReceipts.push(await responseReceipt(missingFieldAttempt.response));
  assert.equal(missingFieldAttempt.sessionToken, undefined);
  assert.equal(missingFieldKdfCalls, 0);
  assert.deepEqual(enumerationReceipts, [
    enumerationReceipts[0],
    enumerationReceipts[0],
    enumerationReceipts[0],
  ]);
  assert.equal(enumerationReceipts[0]?.status, 403);
  assert.equal(enumerationReceipts[0]?.body.includes(fixtureUsername), false);
  assert.equal(enumerationReceipts[0]?.body.includes(fixturePassword), false);

  const hostileBodyRuntime = runtime();
  let hostileKdfCalls = 0;
  hostileBodyRuntime.onPasswordKdf = () => { hostileKdfCalls += 1; };
  const hostileBody = await handleIndependentAdminPrincipalLoginRequest(
    loginRequest({
      username: fixtureUsername,
      password: fixturePassword,
      role: "super_admin",
    }),
    hostileBodyRuntime,
  );
  assert.equal(hostileBody.response.status, 403);
  assert.equal(hostileKdfCalls, 0);

  const csrfStore = new InMemoryIndependentAdminPrincipalAuthStateStore();
  const csrf = await handleIndependentAdminPrincipalLoginRequest(
    loginRequest(
      { username: fixtureUsername, password: fixturePassword },
      { origin: "https://attacker.invalid" },
    ),
    runtime(csrfStore),
  );
  assert.equal(csrf.response.status, 403);
  assert.equal(csrf.sessionToken, undefined);
  assert.deepEqual(
    csrfStore.listAudit().map((event) => event.event),
    ["origin_rejected"],
  );
  for (const hostileOrigin of [
    loginRequest(
      { username: fixtureUsername, password: fixturePassword },
      { origin: "https://127.0.0.1:4200" },
    ),
    loginRequest(
      { username: fixtureUsername, password: fixturePassword },
      { origin: "http://127.0.0.1:4200/path" },
    ),
    loginRequest(
      { username: fixtureUsername, password: fixturePassword },
      { origin: "http://127.0.0.1:4200/?query=forbidden" },
    ),
    loginRequest(
      { username: fixtureUsername, password: fixturePassword },
      { origin: "http://user:pass@127.0.0.1:4200" },
    ),
    loginRequest(
      { username: fixtureUsername, password: fixturePassword },
      {
        origin: "http://example.invalid",
        host: "example.invalid",
        url: "http://example.invalid/api/admin/session",
      },
    ),
  ]) {
    const rejected = await handleIndependentAdminPrincipalLoginRequest(
      hostileOrigin,
      runtime(),
    );
    assert.equal(rejected.response.status, 403);
    assert.equal(rejected.response.headers.get("cache-control"), "no-store");
    assert.equal(rejected.sessionToken, undefined);
  }
  const hostileContentType = await handleIndependentAdminPrincipalLoginRequest(
    loginRequest(
      { username: fixtureUsername, password: fixturePassword },
      { contentType: "application/json-evil" },
    ),
    runtime(),
  );
  assert.equal(hostileContentType.response.status, 403);
  assert.equal(hostileContentType.sessionToken, undefined);
  const missingOrigin = new Request(
    "http://127.0.0.1:4200/api/admin/session",
    {
      method: "POST",
      headers: {
        host: "127.0.0.1:4200",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        username: fixtureUsername,
        password: fixturePassword,
      }),
    },
  );
  assert.equal(
    (await handleIndependentAdminPrincipalLoginRequest(
      missingOrigin,
      runtime(),
    )).response.status,
    403,
  );

  const sessionStore = new InMemoryIndependentAdminPrincipalAuthStateStore();
  const sessionRuntime = runtime(sessionStore);
  const first = await authenticateIndependentAdminPrincipal({
    username: fixtureUsername,
    password: fixturePassword,
    clientBucket: "direct-client",
    runtime: sessionRuntime,
  });
  assert.deepEqual(first.actor.roles, ["super_admin"]);
  assert.ok(await requireIndependentAdminPrincipalRole(
    first.sessionToken,
    "super_admin",
    sessionRuntime,
  ));
  const second = await authenticateIndependentAdminPrincipal({
    username: fixtureUsername,
    password: fixturePassword,
    clientBucket: "direct-client",
    runtime: sessionRuntime,
  });
  assert.notEqual(second.sessionToken, first.sessionToken);
  assert.equal(
    await verifyIndependentAdminPrincipalSession(
      first.sessionToken,
      sessionRuntime,
    ),
    undefined,
  );
  assert.ok(await verifyIndependentAdminPrincipalSession(
    second.sessionToken,
    sessionRuntime,
  ));
  assert.equal(
    await verifyIndependentAdminPrincipalSession(
      "x".repeat(4097),
      sessionRuntime,
    ),
    undefined,
  );
  assert.equal(
    await verifyIndependentAdminPrincipalSession(
      `${second.sessionToken}tampered`,
      sessionRuntime,
    ),
    undefined,
  );
  const expiredRuntime = { ...sessionRuntime, now: fixtureNow + 16 * 60 * 1000 };
  assert.equal(
    await verifyIndependentAdminPrincipalSession(
      second.sessionToken,
      expiredRuntime,
    ),
    undefined,
  );
  const driftedCredential = validateIndependentAdminPrincipalCredential({
    ...credential,
    credentialEpoch: Buffer.alloc(16, 99).toString("base64url"),
  });
  assert.equal(
    await verifyIndependentAdminPrincipalSession(
      second.sessionToken,
      {
        ...sessionRuntime,
        loadCredentialFile: async () =>
          serializeIndependentAdminPrincipalCredential(driftedCredential),
      },
    ),
    undefined,
  );
  await revokeIndependentAdminPrincipalSession(
    second.sessionToken,
    sessionRuntime,
  );
  assert.equal(
    await verifyIndependentAdminPrincipalSession(
      second.sessionToken,
      sessionRuntime,
    ),
    undefined,
  );
  assert.deepEqual(
    sessionStore.listAudit().map((event) => event.event),
    ["login_succeeded", "session_rotated", "login_succeeded", "logout"],
  );

  const rateStore = new InMemoryIndependentAdminPrincipalAuthStateStore();
  let rateKdfCalls = 0;
  const rateRuntime = runtime(rateStore, {
    onPasswordKdf: () => { rateKdfCalls += 1; },
  });
  for (let index = 0; index < 5; index += 1) {
    await assert.rejects(authenticateIndependentAdminPrincipal({
      username: fixtureUsername,
      password: wrongPassword,
      clientBucket: "direct-client",
      runtime: rateRuntime,
    }));
  }
  const limited = await handleIndependentAdminPrincipalLoginRequest(
    loginRequest({ username: fixtureUsername, password: wrongPassword }),
    rateRuntime,
  );
  assert.equal(limited.response.status, 429);
  assert.match(limited.response.headers.get("retry-after") ?? "", /^\d+$/);
  assert.equal(rateKdfCalls, 5);
  assert.equal(
    rateStore.listAudit().filter((event) => event.event === "rate_limited").length,
    1,
  );

  for (const auditText of [
    JSON.stringify(sessionStore.listAudit()),
    JSON.stringify(rateStore.listAudit()),
    JSON.stringify(csrfStore.listAudit()),
  ]) {
    for (const sensitive of [
      fixtureUsername,
      fixturePassword,
      wrongPassword,
      credential.usernameVerifierHmacSha256,
      credential.keyMaterialBase64url,
      credentialReference,
      "127.0.0.1",
    ]) assert.equal(auditText.includes(sensitive), false);
  }

  const root = process.cwd();
  const [
    moduleSource,
    initializerSource,
    securitySource,
    formSource,
    pageSource,
    bootstrapRouteSource,
    adminSessionRouteSource,
    productionRunbook,
    phoneAdminRunbook,
  ] = await Promise.all([
    readFile(path.join(root, "lib/admin/independentPrincipal.ts"), "utf8"),
    readFile(
      path.join(root, "scripts/initialize-independent-admin-principal.ts"),
      "utf8",
    ),
    readFile(path.join(root, "lib/admin/security.ts"), "utf8"),
    readFile(path.join(root, "app/admin/login/AdminLoginForm.tsx"), "utf8"),
    readFile(path.join(root, "app/admin/login/page.tsx"), "utf8"),
    readFile(path.join(root, "app/api/admin/bootstrap/route.ts"), "utf8"),
    readFile(path.join(root, "app/api/admin/session/route.ts"), "utf8"),
    readFile(path.join(root, "runbooks/production-identity-db-gate.md"), "utf8"),
    readFile(path.join(root, "runbooks/phone-admin-gate13.md"), "utf8"),
  ]);
  assert.match(moduleSource, /scrypt\(/);
  assert.match(moduleSource, /N: SCRYPT_N/);
  assert.match(moduleSource, /O_NOFOLLOW/);
  assert.match(moduleSource, /timingSafeEqual/);
  assert.match(moduleSource, /local_fake_only/);
  assert.doesNotMatch(moduleSource, /console\.(?:log|warn|error)/);
  assert.doesNotMatch(moduleSource, /NEXT_PUBLIC_|readPhoneUserSession|resolveProductionAdminRoles/);
  assert.doesNotMatch(moduleSource, /node:(?:http|https|net|tls)|undici|fetch\(/);
  assert.match(initializerSource, /process\.stdin\.isTTY/);
  assert.match(initializerSource, /setRawMode\(true\)/);
  assert.match(initializerSource, /process\.umask\(0o077\)/);
  assert.match(initializerSource, /open\(staging, "wx", 0o600\)/);
  assert.match(initializerSource, /await link\(staging, outputPath\)/);
  assert.match(initializerSource, /installed\.dev !== stagingDevice/);
  assert.match(initializerSource, /await unlink\(outputPath\)/);
  assert.match(initializerSource, /assertIndependentAdminPrincipalProtectedDirectoryChain/);
  assert.doesNotMatch(initializerSource, /process\.env/);
  assert.doesNotMatch(initializerSource, /--username|--password/);
  assert.doesNotMatch(securitySource, /readPhoneUserSession/);
  assert.doesNotMatch(formSource, /\/api\/admin\/bootstrap/);
  assert.match(formSource, /独立管理员账号/);
  assert.match(formSource, /高熵密码/);
  assert.doesNotMatch(formSource, /AuthModal|手机号登录|\/api\/auth\/phone/);
  assert.match(pageSource, /<I18nProvider/);
  assert.doesNotMatch(pageSource, /readPhoneUserSession/);
  assert.doesNotMatch(bootstrapRouteSource, /readPhoneUserSession/);
  assert.doesNotMatch(bootstrapRouteSource, /aistory_bootstrap_phone_super_admin/);
  assert.match(bootstrapRouteSource, /isExactSameOrigin\(request\)/);
  assert.match(bootstrapRouteSource, /bootstrap:\$\{userId\}/);
  assert.match(adminSessionRouteSource, /independentPrincipalServer/);
  assert.match(productionRunbook, /SUPERSEDED ADMINISTRATOR PROCEDURE/);
  assert.match(productionRunbook, /DO NOT EXECUTE PHONE BOOTSTRAP/);
  assert.match(phoneAdminRunbook, /SUPERSEDED \/ HISTORICAL EVIDENCE ONLY/);
  for (const abandonedPath of [
    "lib/admin/verifiedPhoneAdminBootstrap.ts",
    "scripts/test-admin-verified-phone-bootstrap.ts",
    "supabase/migrations/20260828213000_verified_phone_admin_bootstrap_gate.sql",
  ]) await assert.rejects(stat(path.join(root, abandonedPath)), { code: "ENOENT" });

  assert.equal(fetchCalls, 0);
  console.log("independent administrator principal local-fake tests passed");
} finally {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: originalFetch,
  });
}
