import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  createFirstChangeIndependentAdminCredential,
  INDEPENDENT_ADMIN_PRINCIPAL_CREDENTIAL_FILE_ENV,
  INDEPENDENT_ADMIN_PRINCIPAL_MODE_ENV,
  INDEPENDENT_ADMIN_PRINCIPAL_PRODUCTION_MODE,
  projectIndependentAdminPrincipalCredentialBinding,
  rotateIndependentAdminPrincipalSession,
  serializeIndependentAdminPrincipalCredential,
  type IndependentAdminPrincipalRuntime,
} from "@/lib/admin/independentPrincipal";
import { FIRST_PASSWORD_CHANGE_ENV, FIRST_PASSWORD_CHANGE_POLICY, FIRST_PASSWORD_CHANGE_GATE,
  firstChangeBinding, firstChangePasswordState } from "@/lib/admin/independentFirstPasswordChange";
import {
  createSupabaseIndependentAdminPrincipalRepository,
  INDEPENDENT_ADMIN_PRINCIPAL_DB_GATE_ENV,
  INDEPENDENT_ADMIN_PRINCIPAL_DB_GATE_VERSION,
  INDEPENDENT_ADMIN_PRINCIPAL_ORIGIN_ENV,
  type IndependentAdminPrincipalRpcClient,
} from "@/lib/admin/independentPrincipalRepository";
import {
  handleIndependentAdminPrincipalProductionLogin,
  handleIndependentAdminPrincipalProductionLogout,
  handleIndependentAdminPrincipalProductionMe,
  INDEPENDENT_ADMIN_PRINCIPAL_PRODUCTION_COOKIE,
  INDEPENDENT_ADMIN_PRINCIPAL_PUBLIC_ACTOR_ID,
  independentAdminPrincipalProductionCookieOptions,
  inspectIndependentAdminPrincipalProductionGate,
  resolveIndependentAdminPrincipalAuthorizedContext,
  type IndependentAdminPrincipalServerOptions,
} from "@/lib/admin/independentPrincipalServer";
import {
  independentAdminPrincipalInitializerRequestId,
  parseIndependentAdminPrincipalInitializerArguments,
  runIndependentAdminPrincipalInitializerForTest,
} from "./initialize-production-independent-admin-principal";

const fixtureNow = Date.parse("2026-08-28T13:00:00.000Z");
const origin = "https://admin.example.invalid";
const credentialReference =
  "/run/credentials/aistory-iy.service/admin-principal-v1.json";
const fixtureUsername = "synthetic_founder_admin";
const fixturePassword = "Synthetic-only-admin-password!9qL7#mZ2";
const wrongPassword = "Synthetic-only-admin-password!4xR8#nK1";

const credential = await createFirstChangeIndependentAdminCredential({
  username: fixtureUsername,
  password: fixturePassword,
});
const credentialRaw = serializeIndependentAdminPrincipalCredential(credential);
const binding = projectIndependentAdminPrincipalCredentialBinding(credential);

const productionEnv: Record<string, string> = {
  [FIRST_PASSWORD_CHANGE_ENV]: FIRST_PASSWORD_CHANGE_POLICY,
  [INDEPENDENT_ADMIN_PRINCIPAL_MODE_ENV]:
    INDEPENDENT_ADMIN_PRINCIPAL_PRODUCTION_MODE,
  [INDEPENDENT_ADMIN_PRINCIPAL_CREDENTIAL_FILE_ENV]: credentialReference,
  [INDEPENDENT_ADMIN_PRINCIPAL_DB_GATE_ENV]:
    INDEPENDENT_ADMIN_PRINCIPAL_DB_GATE_VERSION,
  [INDEPENDENT_ADMIN_PRINCIPAL_ORIGIN_ENV]: origin,
  AISTORY_TRUST_PROXY_HEADERS: "true",
  AISTORY_PRODUCTION_IDENTITY_ENABLED: "true",
  AISTORY_IDENTITY_REPOSITORY: "supabase",
  AISTORY_ADMIN_REPOSITORY: "supabase",
  AISTORY_DATABASE_GATE_VERSION: "20260811193000",
  AISTORY_ANONYMOUS_SESSION_SECRET: "s".repeat(48),
  AISTORY_ANONYMOUS_SUBJECT_PEPPER: "p".repeat(48),
  AISTORY_SUPABASE_SERVER_URL: "https://database.example.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "synthetic-service-role-only",
};

const SNAPSHOT_KEYS = [
  "users",
  "roles",
  "accounts",
  "ledger",
  "events",
  "settings",
  "payment_configs",
  "provider_configs",
  "domains",
  "channel_apps",
  "audit",
  "billing_policies",
] as const;

function emptySnapshot(): Record<string, unknown> {
  return Object.fromEntries(SNAPSHOT_KEYS.map((key) => [key, []]));
}

class FakePrincipalRpcClient implements IndependentAdminPrincipalRpcClient {
  readonly calls: Array<{ name: string; args?: Record<string, unknown> }> = [];
  readonly events: string[] = [];
  activeSessionHash?: string;
  revoked = false;
  denyRate = false;
  failRevoke = false;
  independentGateVersion = INDEPENDENT_ADMIN_PRINCIPAL_DB_GATE_VERSION;
  independentPosture = true;
  snapshot: unknown = emptySnapshot();
  reserveOverride?: unknown;
  initializeBinding?: string;
  initializeRequest?: string;
  credentialBinding = binding.credentialBindingSha256;
  readonly replacements = new Map<string, string>();

  count(name: string): number {
    return this.calls.filter((call) => call.name === name).length;
  }

  async rpc(name: string, args?: Record<string, unknown>) {
    this.calls.push({ name, ...(args ? { args } : {}) });
    switch (name) {
      case "aistory_iap_first_change_posture": return { data: FIRST_PASSWORD_CHANGE_GATE, error: null };
      case "aistory_iap_first_change_read_credential": return { data: {
        password_state: firstChangePasswordState(credential), must_change_password: false, revision: 2,
        binding: firstChangeBinding(credential),
      }, error: null };
      case "aistory_database_gate_status":
        return { data: "20260811193000", error: null };
      case "aistory_database_security_posture":
      case "aistory_admin_rpc_security_posture":
      case "aistory_phone_admin_security_posture":
      case "aistory_hosted_byok_security_posture":
      case "aistory_video_asset_security_posture":
        return { data: true, error: null };
      case "aistory_independent_admin_gate_status":
        return { data: this.independentGateVersion, error: null };
      case "aistory_independent_admin_security_posture":
        return { data: this.independentPosture, error: null };
      case "aistory_independent_admin_reserve_login":
        return {
          data: this.reserveOverride ?? (this.denyRate
            ? { allowed: false, retry_after_seconds: 60 }
            : { allowed: true, retry_after_seconds: 0 }),
          error: null,
        };
      case "aistory_independent_admin_append_security_event": {
        const payload = args?.security_event as Record<string, unknown>;
        this.events.push(String(payload?.event ?? ""));
        return { data: true, error: null };
      }
      case "aistory_independent_admin_commit_login": {
        const payload = args?.login as Record<string, unknown>;
        this.activeSessionHash = String(payload.session_hash);
        this.revoked = false;
        return { data: true, error: null };
      }
      case "aistory_independent_admin_verify_session":
      case "aistory_iap_first_change_verify_session": {
        const payload = (args?.session ?? args?.request_payload) as Record<string, unknown>;
        const requested = String(payload.session_hash);
        if (this.replacements.has(requested)) {
          this.activeSessionHash = undefined;
          this.revoked = true;
          return { data: null, error: null };
        }
        return {
          data: !this.revoked && requested === this.activeSessionHash
            ? name === "aistory_iap_first_change_verify_session"
              ? { active: true, must_change_password: false } : { active: true, role: "super_admin" }
            : null,
          error: null,
        };
      }
      case "aistory_independent_admin_rotate_session": {
        const payload = args?.rotation as Record<string, unknown>;
        const current = String(payload.current_session_hash);
        const next = String(payload.next_session_hash);
        if (
          this.replacements.get(current) === next
          && this.activeSessionHash === next
          && !this.revoked
        ) return { data: true, error: null };
        if (this.activeSessionHash !== current || this.revoked) {
          return { data: null, error: { message: "unavailable" } };
        }
        this.replacements.set(current, next);
        this.activeSessionHash = next;
        return { data: true, error: null };
      }
      case "aistory_independent_admin_revoke_session": {
        if (this.failRevoke) {
          return { data: null, error: { message: "uncertain" } };
        }
        const payload = args?.session as Record<string, unknown>;
        if (String(payload.session_hash) !== this.activeSessionHash) {
          return { data: false, error: null };
        }
        this.activeSessionHash = undefined;
        this.revoked = true;
        return { data: true, error: null };
      }
      case "aistory_independent_admin_read_snapshot": {
        const payload = args?.request_payload as Record<string, unknown>;
        if (
          !payload
          || Object.hasOwn(args ?? {}, "authorization")
          || payload.tenant_id !== "platform"
        ) return { data: null, error: { message: "unavailable" } };
        return { data: this.snapshot, error: null };
      }
      case "aistory_independent_admin_initialize": {
        const payload = args?.registration as Record<string, unknown>;
        const nextBinding = String(payload.credential_binding_sha256);
        const nextRequest = String(payload.request_id);
        if (!this.initializeBinding) {
          this.initializeBinding = nextBinding;
          this.initializeRequest = nextRequest;
          return {
            data: { initialized: true, replayed: false },
            error: null,
          };
        }
        if (
          this.initializeBinding === nextBinding
          && this.initializeRequest === nextRequest
        ) {
          return {
            data: { initialized: true, replayed: true },
            error: null,
          };
        }
        return { data: null, error: { message: "conflict" } };
      }
      case "aistory_independent_admin_rotate_credential": {
        const payload = args?.rotation as Record<string, unknown>;
        if (
          String(payload.current_credential_binding_sha256)
            !== this.credentialBinding
        ) return { data: null, error: { message: "conflict" } };
        const next = payload.next as Record<string, unknown>;
        this.credentialBinding = String(next.credential_binding_sha256);
        return { data: { rotated: true, replayed: false }, error: null };
      }
      default:
        return { data: null, error: { message: "unexpected" } };
    }
  }
}

function loginRequest(body: unknown, overrides: {
  requestOrigin?: string;
  host?: string;
  contentType?: string;
  contentLength?: string;
  forwardedFor?: string;
} = {}): Request {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const headers: Record<string, string> = {
    origin: overrides.requestOrigin ?? origin,
    host: overrides.host ?? "admin.example.invalid",
    "content-type": overrides.contentType ?? "application/json",
    "x-forwarded-for": overrides.forwardedFor ?? "192.0.2.20",
  };
  if (overrides.contentLength) headers["content-length"] = overrides.contentLength;
  return new Request(`${origin}/api/admin/session`, {
    method: "POST",
    headers,
    body: raw,
  });
}

function logoutRequest(overrides: {
  requestOrigin?: string;
  contentType?: string;
  body?: string;
} = {}): Request {
  return new Request(`${origin}/api/admin/session`, {
    method: "DELETE",
    headers: {
      origin: overrides.requestOrigin ?? origin,
      host: "admin.example.invalid",
      "content-type": overrides.contentType ?? "application/json",
    },
    body: overrides.body ?? "{}",
  });
}

function options(
  client: FakePrincipalRpcClient,
  overrides: Partial<IndependentAdminPrincipalServerOptions> = {},
): IndependentAdminPrincipalServerOptions {
  return {
    env: productionEnv,
    workspaceRoot: "D:\\AIstory",
    now: fixtureNow,
    client: client as unknown as IndependentAdminPrincipalServerOptions["client"],
    loadCredentialFile: async () => credentialRaw,
    randomSessionBytes: () => Buffer.alloc(32, 51),
    ...overrides,
  };
}

async function receipt(response: Response) {
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
  const ready = inspectIndependentAdminPrincipalProductionGate(productionEnv);
  assert.equal(ready.ready, true);
  assert.deepEqual(ready.missing, []);
  for (const [key, expectedMissing] of [
    [INDEPENDENT_ADMIN_PRINCIPAL_MODE_ENV, "mode"],
    [INDEPENDENT_ADMIN_PRINCIPAL_CREDENTIAL_FILE_ENV, "credential_reference"],
    [INDEPENDENT_ADMIN_PRINCIPAL_DB_GATE_ENV, "database_gate_version"],
    [INDEPENDENT_ADMIN_PRINCIPAL_ORIGIN_ENV, "public_origin"],
    ["AISTORY_TRUST_PROXY_HEADERS", "trusted_proxy"],
  ] as const) {
    const drifted = { ...productionEnv };
    delete drifted[key];
    const status = inspectIndependentAdminPrincipalProductionGate(drifted);
    assert.equal(status.ready, false);
    assert.ok(status.missing.includes(expectedMissing));
  }
  assert.ok(inspectIndependentAdminPrincipalProductionGate({
    ...productionEnv,
    AISTORY_LOCAL_ADMIN_ENABLED: "true",
    AISTORY_LOCAL_ADMIN_SECRET: "synthetic-local-only",
  }).missing.includes("local_admin_disabled"));

  for (const hostileOrigin of [
    "https://attacker.example.invalid",
    "https://user@admin.example.invalid",
    "https://admin.example.invalid/path",
    "https://admin.example.invalid/?query=1",
    "https://admin.example.invalid/#fragment",
  ]) {
    const fake = new FakePrincipalRpcClient();
    let loads = 0;
    const result = await handleIndependentAdminPrincipalProductionLogin(
      loginRequest(
        { username: fixtureUsername, password: fixturePassword },
        { requestOrigin: hostileOrigin },
      ),
      options(fake, {
        loadCredentialFile: async () => {
          loads += 1;
          return credentialRaw;
        },
      }),
    );
    assert.equal(result.response.status, 403);
    assert.equal(loads, 0);
    assert.equal(fake.calls.length, 0);
  }

  for (const request of [
    loginRequest(
      { username: fixtureUsername, password: fixturePassword },
      { contentType: "text/plain" },
    ),
    loginRequest({ username: fixtureUsername }),
    loginRequest({ username: fixtureUsername, password: fixturePassword, role: "super_admin" }),
    loginRequest("{not-json"),
    loginRequest(
      { username: fixtureUsername, password: fixturePassword },
      { contentLength: "5000" },
    ),
  ]) {
    const fake = new FakePrincipalRpcClient();
    let loads = 0;
    const result = await handleIndependentAdminPrincipalProductionLogin(
      request,
      options(fake, {
        loadCredentialFile: async () => {
          loads += 1;
          return credentialRaw;
        },
      }),
    );
    assert.equal(result.response.status, 403);
    assert.equal(loads, 0);
    assert.equal(fake.calls.length, 0);
  }

  const missingModeFake = new FakePrincipalRpcClient();
  const missingModeEnv = { ...productionEnv };
  delete missingModeEnv[INDEPENDENT_ADMIN_PRINCIPAL_MODE_ENV];
  const missingMode = await handleIndependentAdminPrincipalProductionLogin(
    loginRequest({ username: fixtureUsername, password: fixturePassword }),
    options(missingModeFake, { env: missingModeEnv }),
  );
  assert.equal(missingMode.response.status, 503);
  assert.equal(missingModeFake.calls.length, 0);

  const gate15Fake = new FakePrincipalRpcClient();
  gate15Fake.independentGateVersion = "20260828233000";
  const gate15Blocked = await handleIndependentAdminPrincipalProductionLogin(
    loginRequest({ username: fixtureUsername, password: fixturePassword }),
    options(gate15Fake),
  );
  assert.equal(gate15Blocked.response.status, 503);
  assert.equal(gate15Fake.count("aistory_independent_admin_reserve_login"), 0);
  assert.equal(gate15Fake.count("aistory_independent_admin_commit_login"), 0);

  const enumerationFake = new FakePrincipalRpcClient();
  const unknown = await handleIndependentAdminPrincipalProductionLogin(
    loginRequest({ username: "unknown_synthetic_admin", password: fixturePassword }),
    options(enumerationFake),
  );
  const wrong = await handleIndependentAdminPrincipalProductionLogin(
    loginRequest({ username: fixtureUsername, password: wrongPassword }),
    options(enumerationFake),
  );
  assert.deepEqual(await receipt(unknown.response), await receipt(wrong.response));
  assert.equal(unknown.response.status, 403);

  const rateFake = new FakePrincipalRpcClient();
  rateFake.denyRate = true;
  const limited = await handleIndependentAdminPrincipalProductionLogin(
    loginRequest({ username: fixtureUsername, password: fixturePassword }),
    options(rateFake),
  );
  assert.equal(limited.response.status, 429);
  assert.equal(limited.response.headers.get("retry-after"), "60");

  const fake = new FakePrincipalRpcClient();
  const loggedIn = await handleIndependentAdminPrincipalProductionLogin(
    loginRequest({ username: fixtureUsername, password: fixturePassword }),
    options(fake),
  );
  assert.equal(loggedIn.response.status, 200);
  const loggedInBody = await loggedIn.response.json();
  assert.deepEqual(loggedInBody, {
    ok: true,
    authMode: "independent",
    state: "console",
  });
  assert.ok(loggedIn.sessionToken);
  const token = loggedIn.sessionToken!;
  const payload = JSON.parse(
    Buffer.from(token.split(".")[0]!, "base64url").toString("utf8"),
  ) as Record<string, unknown>;
  assert.deepEqual(Object.keys(payload).sort(), [
    "expiresAt",
    "issuedAt",
    "policyId",
    "schemaVersion",
    "sessionId",
  ]);
  const publicText = JSON.stringify({
    response: loggedInBody,
    payload,
  });
  for (const sensitive of [
    fixtureUsername,
    fixturePassword,
    wrongPassword,
    credential.principalId,
    credential.usernameVerifierHmacSha256,
    credential.keyMaterialBase64url,
    credentialReference,
  ]) assert.equal(publicText.includes(sensitive), false);

  const concurrentMe = await Promise.all([
    handleIndependentAdminPrincipalProductionMe(token, options(fake)),
    handleIndependentAdminPrincipalProductionMe(token, options(fake)),
  ]);
  assert.deepEqual(concurrentMe.map((item) => item.response.status), [200, 200]);
  assert.equal(fake.count("aistory_independent_admin_rotate_session"), 0);
  const authorized = await resolveIndependentAdminPrincipalAuthorizedContext(
    token,
    options(fake),
  );
  assert.ok(authorized);
  assert.deepEqual(authorized!.actor, {
    userId: INDEPENDENT_ADMIN_PRINCIPAL_PUBLIC_ACTOR_ID,
    roles: ["super_admin"],
    mode: "independent",
  });
  assert.equal(JSON.stringify(authorized!.actor).includes(credential.principalId), false);

  const repository = createSupabaseIndependentAdminPrincipalRepository(
    fake as unknown as Parameters<typeof createSupabaseIndependentAdminPrincipalRepository>[0],
    binding,
  );
  const rotationRuntime: IndependentAdminPrincipalRuntime = {
    env: productionEnv,
    workspaceRoot: "D:\\AIstory",
    now: fixtureNow,
    loadCredentialFile: async () => credentialRaw,
    store: repository,
    expectedMode: INDEPENDENT_ADMIN_PRINCIPAL_PRODUCTION_MODE,
    actorMode: "production",
    expectedOrigin: origin,
    clientBucket: "192.0.2.20",
  };
  const rotated = await rotateIndependentAdminPrincipalSession(
    token,
    rotationRuntime,
  );
  const replayedRotation = await rotateIndependentAdminPrincipalSession(
    token,
    rotationRuntime,
  );
  assert.ok(rotated);
  assert.equal(replayedRotation, rotated);
  assert.equal(
    (await handleIndependentAdminPrincipalProductionMe(rotated, options(fake)))
      .response.status,
    200,
  );
  assert.equal(
    (await handleIndependentAdminPrincipalProductionMe(token, options(fake)))
      .response.status,
    401,
  );
  assert.equal(
    (await handleIndependentAdminPrincipalProductionMe(rotated, options(fake)))
      .response.status,
    401,
  );

  const logoutFake = new FakePrincipalRpcClient();
  const logoutLogin = await handleIndependentAdminPrincipalProductionLogin(
    loginRequest({ username: fixtureUsername, password: fixturePassword }),
    options(logoutFake),
  );
  const logoutToken = logoutLogin.sessionToken!;
  const crossOriginLogout = await handleIndependentAdminPrincipalProductionLogout(
    logoutRequest({ requestOrigin: "https://attacker.example.invalid" }),
    logoutToken,
    options(logoutFake),
  );
  assert.equal(crossOriginLogout.status, 403);
  assert.equal(
    (await handleIndependentAdminPrincipalProductionMe(
      logoutToken,
      options(logoutFake),
    )).response.status,
    200,
  );
  logoutFake.failRevoke = true;
  const uncertainLogout = await handleIndependentAdminPrincipalProductionLogout(
    logoutRequest(),
    logoutToken,
    options(logoutFake),
  );
  assert.equal(uncertainLogout.status, 503);
  logoutFake.failRevoke = false;
  const logout = await handleIndependentAdminPrincipalProductionLogout(
    logoutRequest(),
    logoutToken,
    options(logoutFake),
  );
  assert.equal(logout.status, 200);
  assert.equal(
    (await handleIndependentAdminPrincipalProductionMe(
      logoutToken,
      options(logoutFake),
    )).response.status,
    401,
  );

  const initFake = new FakePrincipalRpcClient();
  const initRepository = createSupabaseIndependentAdminPrincipalRepository(
    initFake as unknown as Parameters<typeof createSupabaseIndependentAdminPrincipalRepository>[0],
    binding,
  );
  const initRequestId = independentAdminPrincipalInitializerRequestId(
    "initialize",
    binding.credentialBindingSha256,
  );
  const initialized = await Promise.all([
    initRepository.initializeOnce({ binding, requestId: initRequestId }),
    initRepository.initializeOnce({ binding, requestId: initRequestId }),
  ]);
  assert.deepEqual(initialized.map((item) => item.replayed).sort(), [false, true]);
  await assert.rejects(initRepository.initializeOnce({
    binding,
    requestId: `ipr_${"z".repeat(43)}`,
  }));
  initFake.reserveOverride = { allowed: true, retry_after_seconds: 1 };
  await assert.rejects(initRepository.reserveLoginAttempts(
    ["a".repeat(64), "b".repeat(64)],
    fixtureNow,
  ));
  initFake.snapshot = { ...emptySnapshot(), unexpected: [] };
  await assert.rejects(initRepository.readAdminSnapshot({
    binding,
    sessionIdHash: "c".repeat(64),
  }));
  const hostileBinding = Object.assign(Object.create(null), binding);
  assert.throws(() => createSupabaseIndependentAdminPrincipalRepository(
    initFake as unknown as Parameters<typeof createSupabaseIndependentAdminPrincipalRepository>[0],
    hostileBinding,
  ));

  assert.deepEqual(parseIndependentAdminPrincipalInitializerArguments(["--resume"]), {
    kind: "resume",
  });
  assert.deepEqual(parseIndependentAdminPrincipalInitializerArguments([
    "--resume-rotate",
    "/run/credentials/aistory-iy.service/admin-principal-v2.json",
  ]), {
    kind: "resume_rotate",
    outputPath: "/run/credentials/aistory-iy.service/admin-principal-v2.json",
  });
  assert.throws(() => parseIndependentAdminPrincipalInitializerArguments([
    "--username",
    fixtureUsername,
  ]));
  assert.equal(
    independentAdminPrincipalInitializerRequestId("initialize", "material"),
    independentAdminPrincipalInitializerRequestId("initialize", "material"),
  );
  assert.notEqual(
    independentAdminPrincipalInitializerRequestId("initialize", "material"),
    independentAdminPrincipalInitializerRequestId("rotate", "material"),
  );

  const initializerPath = path.join(
    process.cwd(),
    "scripts/initialize-production-independent-admin-principal.ts",
  );
  const principalModuleUrl = pathToFileURL(path.join(
    process.cwd(),
    "lib/admin/independentPrincipal.ts",
  )).href;
  const initializerModuleUrl = pathToFileURL(initializerPath).href;
  const subprocessEnv = { ...process.env };
  delete subprocessEnv.NODE_OPTIONS;
  for (const key of Object.keys(subprocessEnv)) {
    if (key.startsWith("AISTORY_") || key.startsWith("SUPABASE_")) {
      delete subprocessEnv[key];
    }
  }
  const moduleImport = (moduleUrl: string) =>
    `import(${JSON.stringify(moduleUrl)})`;
  const historicalSentinel = spawnSync(
    process.execPath,
    ["--import", "tsx", "--eval", moduleImport(principalModuleUrl)],
    {
      cwd: process.cwd(),
      env: subprocessEnv,
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true,
    },
  );
  assert.equal(historicalSentinel.error, undefined);
  assert.notEqual(historicalSentinel.status, 0);
  assert.match(
    `${historicalSentinel.stdout}${historicalSentinel.stderr}`,
    /This module cannot be imported from a Client Component module/,
  );

  const conditionedPrincipalImport = spawnSync(
    process.execPath,
    [
      "--conditions=react-server",
      "--import",
      "tsx",
      "--eval",
      moduleImport(principalModuleUrl),
    ],
    {
      cwd: process.cwd(),
      env: subprocessEnv,
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true,
    },
  );
  assert.equal(conditionedPrincipalImport.error, undefined);
  assert.equal(conditionedPrincipalImport.status, 0);
  assert.equal(
    `${conditionedPrincipalImport.stdout}${conditionedPrincipalImport.stderr}`,
    "",
  );

  const defaultInitializerImport = spawnSync(
    process.execPath,
    ["--import", "tsx", "--eval", moduleImport(initializerModuleUrl)],
    {
      cwd: process.cwd(),
      env: subprocessEnv,
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true,
    },
  );
  assert.equal(defaultInitializerImport.error, undefined);
  assert.equal(defaultInitializerImport.status, 0);
  assert.doesNotMatch(
    `${defaultInitializerImport.stdout}${defaultInitializerImport.stderr}`,
    /server-only|Administrator login name|Administrator password|Repeat password/i,
  );

  const conditionedInitializerImport = spawnSync(
    process.execPath,
    [
      "--conditions=react-server",
      "--import",
      "tsx",
      "--eval",
      moduleImport(initializerModuleUrl),
    ],
    {
      cwd: process.cwd(),
      env: subprocessEnv,
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true,
    },
  );
  assert.equal(conditionedInitializerImport.error, undefined);
  assert.equal(conditionedInitializerImport.status, 0);
  assert.equal(
    `${conditionedInitializerImport.stdout}${conditionedInitializerImport.stderr}`,
    "",
  );

  const actualNoninteractiveCli = spawnSync(
    process.execPath,
    ["--import", "tsx", initializerPath, "--resume"],
    {
      cwd: process.cwd(),
      env: subprocessEnv,
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true,
    },
  );
  assert.equal(actualNoninteractiveCli.error, undefined);
  assert.equal(actualNoninteractiveCli.status, 1);
  const actualNoninteractiveCliOutput =
    `${actualNoninteractiveCli.stdout}${actualNoninteractiveCli.stderr}`;
  assert.match(
    actualNoninteractiveCliOutput,
    /Independent administrator initialization failed\./,
  );
  assert.doesNotMatch(
    actualNoninteractiveCliOutput,
    /server-only|Client Component module|Administrator login name|Administrator password|Repeat password/i,
  );

  const symlinkRoot = await mkdtemp(path.join(
    tmpdir(),
    "aistory-independent-admin-initializer-entry-",
  ));
  try {
    const symlinkedSource = path.join(symlinkRoot, "source");
    await symlink(
      process.cwd(),
      symlinkedSource,
      process.platform === "win32" ? "junction" : "dir",
    );
    const symlinkedCli = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join(
          symlinkedSource,
          "scripts/initialize-production-independent-admin-principal.ts",
        ),
        "--resume",
      ],
      {
        cwd: symlinkedSource,
        env: subprocessEnv,
        encoding: "utf8",
        timeout: 20_000,
        windowsHide: true,
      },
    );
    assert.equal(symlinkedCli.error, undefined);
    assert.equal(symlinkedCli.status, 1);
    const symlinkedCliOutput = `${symlinkedCli.stdout}${symlinkedCli.stderr}`;
    assert.match(
      symlinkedCliOutput,
      /Independent administrator initialization failed\./,
    );
    assert.doesNotMatch(
      symlinkedCliOutput,
      /server-only|Client Component module|Administrator login name|Administrator password|Repeat password/i,
    );
  } finally {
    await rm(symlinkRoot, { recursive: true, force: true });
  }

  let blockedPromptCalls = 0;
  let blockedTargetCalls = 0;
  let blockedWriteCalls = 0;
  const blockedErrors: string[] = [];
  const blockedExitCodes: number[] = [];
  await runIndependentAdminPrincipalInitializerForTest(
    ["--initialize", credentialReference],
    {
      env: {},
      platform: "linux",
      effectiveUid: 0,
      workspaceRoot: "/opt/aistory/current",
      loadDependencies: async () => {
        throw new Error(
          "This module cannot be imported from a Client Component module.",
        );
      },
      promptHidden: async () => {
        blockedPromptCalls += 1;
        return "forbidden";
      },
      resolveProtectedAbsentTarget: async () => {
        blockedTargetCalls += 1;
        return credentialReference;
      },
      writeCredential: async () => {
        blockedWriteCalls += 1;
      },
      error: (message) => blockedErrors.push(message),
      setExitCode: (code) => blockedExitCodes.push(code),
    },
  );
  assert.equal(blockedPromptCalls, 0);
  assert.equal(blockedTargetCalls, 0);
  assert.equal(blockedWriteCalls, 0);
  assert.deepEqual(blockedErrors, [
    "Independent administrator initialization failed.",
  ]);
  assert.deepEqual(blockedExitCodes, [1]);
  assert.doesNotMatch(blockedErrors.join("\n"), /server-only|Client Component/);

  const initializerEnv = { ...productionEnv };
  delete initializerEnv[INDEPENDENT_ADMIN_PRINCIPAL_MODE_ENV];
  const initializerFake = new FakePrincipalRpcClient();
  const promptInputs = [fixtureUsername, fixturePassword, fixturePassword];
  const promptLabels: string[] = [];
  const promptLimits: number[] = [];
  const writtenCredentials: Array<{
    outputPath: string;
    serialized: string;
  }> = [];
  const initializerLogs: string[] = [];
  const initializerErrors: string[] = [];
  const initializerExitCodes: number[] = [];
  let resolvedTargets = 0;
  await runIndependentAdminPrincipalInitializerForTest(
    ["--initialize", credentialReference],
    {
      env: initializerEnv,
      platform: "linux",
      effectiveUid: 0,
      workspaceRoot: "/opt/aistory/current",
      client: initializerFake as never,
      promptHidden: async (label, maximumBytes) => {
        promptLabels.push(label);
        promptLimits.push(maximumBytes);
        return promptInputs.shift()!;
      },
      resolveProtectedAbsentTarget: async (outputPath) => {
        resolvedTargets += 1;
        assert.equal(outputPath, credentialReference);
        return credentialReference;
      },
      writeCredential: async (outputPath, serialized) => {
        writtenCredentials.push({ outputPath, serialized });
      },
      log: (message) => initializerLogs.push(message),
      error: (message) => initializerErrors.push(message),
      setExitCode: (code) => initializerExitCodes.push(code),
    },
  );
  assert.deepEqual(promptLabels, [
    "Administrator login name (hidden): ",
    "Administrator password (hidden): ",
    "Repeat password (hidden): ",
  ]);
  assert.deepEqual(promptLimits, [64, 512, 512]);
  assert.equal(promptInputs.length, 0);
  assert.equal(resolvedTargets, 1);
  assert.equal(writtenCredentials.length, 1);
  assert.equal(writtenCredentials[0]!.outputPath, credentialReference);
  assert.equal(
    writtenCredentials[0]!.serialized.includes(fixtureUsername),
    false,
  );
  assert.equal(
    writtenCredentials[0]!.serialized.includes(fixturePassword),
    false,
  );
  assert.equal(
    initializerFake.count("aistory_independent_admin_initialize"),
    1,
  );
  assert.deepEqual(initializerLogs, [
    "Independent administrator initialized.",
  ]);
  assert.deepEqual(initializerErrors, []);
  assert.deepEqual(initializerExitCodes, []);

  assert.equal(INDEPENDENT_ADMIN_PRINCIPAL_PRODUCTION_COOKIE,
    "__Host-aistory_admin_principal_v2");
  assert.deepEqual(independentAdminPrincipalProductionCookieOptions(), {
    httpOnly: true,
    sameSite: "strict",
    secure: true,
    path: "/",
    maxAge: 900,
  });

  const root = process.cwd();
  const [
    migration,
    gate16Migration,
    repositorySource,
    serverSource,
    routeSource,
    securitySource,
    formSource,
    consoleSource,
    initializerSource,
    postgres16HarnessSource,
    ledgerApplicatorSource,
    runbook,
    supersededEvidenceRaw,
    gate16EvidenceRaw,
    ledgerCompatibilityEvidenceRaw,
    predecessorLineageEvidenceRaw,
    migrationNames,
  ] = await Promise.all([
    readFile(path.join(root, "supabase/migrations/20260828233000_independent_admin_principal_pg16_gate.sql"), "utf8"),
    readFile(path.join(
      root,
      "supabase/migrations/20260829063000_independent_admin_qualification_residue_retirement_gate.sql",
    ), "utf8"),
    readFile(path.join(root, "lib/admin/independentPrincipalRepository.ts"), "utf8"),
    readFile(path.join(root, "lib/admin/independentPrincipalServer.ts"), "utf8"),
    readFile(path.join(root, "app/api/admin/session/route.ts"), "utf8"),
    readFile(path.join(root, "lib/admin/security.ts"), "utf8"),
    readFile(path.join(root, "app/admin/login/AdminLoginForm.tsx"), "utf8"),
    readFile(path.join(root, "app/admin/AdminConsole.tsx"), "utf8"),
    readFile(path.join(root, "scripts/initialize-production-independent-admin-principal.ts"), "utf8"),
    readFile(path.join(root, "scripts/test-independent-admin-principal-postgres16.mjs"), "utf8"),
    readFile(path.join(root, "scripts/apply-independent-admin-gate16-ledger.psql"), "utf8"),
    readFile(path.join(root, "runbooks/independent-admin-principal-production-v1.md"), "utf8"),
    readFile(path.join(
      root,
      "release-evidence/superseded/independent-admin-principal-20260828230000.json",
    ), "utf8"),
    readFile(path.join(
      root,
      "release-evidence/independent-admin-qualification-residue-retirement-20260829.json",
    ), "utf8"),
    readFile(path.join(
      root,
      "release-evidence/independent-admin-gate16-ledger-compatibility-20260830.json",
    ), "utf8"),
    readFile(path.join(
      root,
      "release-evidence/independent-admin-gate16-predecessor-lineage-reconciliation-20260830.json",
    ), "utf8"),
    readdir(path.join(root, "supabase/migrations")),
  ]);
  await assert.rejects(
    access(path.join(
      root,
      "supabase/migrations/20260828230000_independent_admin_principal_gate.sql",
    )),
    (error: unknown) => (
      error instanceof Error
      && "code" in error
      && error.code === "ENOENT"
    ),
  );
  assert.equal(
    migrationNames.filter((name) => (
      name === "20260828233000_independent_admin_principal_pg16_gate.sql"
    )).length,
    1,
  );
  assert.equal(
    migrationNames.filter((name) => (
      name === "20260828230000_independent_admin_principal_gate.sql"
    )).length,
    0,
  );
  assert.equal(
    migrationNames.filter((name) => (
      name ===
        "20260829063000_independent_admin_qualification_residue_retirement_gate.sql"
    )).length,
    1,
  );
  const supersededEvidence = JSON.parse(supersededEvidenceRaw) as Record<
    string,
    unknown
  >;
  assert.deepEqual(Object.keys(supersededEvidence).sort(), [
    "applyAllowed",
    "bytes",
    "failureClass",
    "gateName",
    "oldDeltaAggregate",
    "oldImmutablePackageFileName",
    "oldImmutablePackageSha256",
    "oldManifestSha256",
    "replacementPath",
    "replacementVersion",
    "schemaVersion",
    "sha256",
    "status",
    "supersededPath",
    "supersededVersion",
  ]);
  assert.deepEqual(supersededEvidence, {
    schemaVersion: "aistory.superseded-migration-evidence.v1",
    status: "SUPERSEDED_UNAPPLIED_PG16_PARSE_FAILURE",
    applyAllowed: false,
    gateName: "independent_admin_principal",
    supersededVersion: "20260828230000",
    supersededPath:
      "supabase/migrations/20260828230000_independent_admin_principal_gate.sql",
    bytes: 52963,
    sha256:
      "81607ac3f2216a23ffb1e1de66417ecb1eb52feb5baa312d3fd179884182b4e9",
    failureClass: "POSTGRESQL16_RESERVED_PARAMETER_PARSE_FAILURE",
    replacementVersion: "20260828233000",
    replacementPath:
      "supabase/migrations/20260828233000_independent_admin_principal_pg16_gate.sql",
    oldImmutablePackageFileName:
      "aistory-p05-independent-admin-production-source-20260828-224509.zip",
    oldImmutablePackageSha256:
      "92d33942086b012f7fe07b24ec6eb812708618282e9060a96f37f0854e701c49",
    oldDeltaAggregate:
      "027f55443248c450810bb4a4f3843d241600ef079d1a1f7ac3a37e812c4c07ae",
    oldManifestSha256:
      "0a79b5189736195eb375a525f56f906ed391e9263966659755d7f1e08a57c4b2",
  });
  const gate16Evidence = JSON.parse(gate16EvidenceRaw) as Record<
    string,
    unknown
  >;
  assert.deepEqual(gate16Evidence, {
    schemaVersion:
      "aistory.independent-admin.qualification-residue-incident.v1",
    status: "FOUNDER_APPROVED_GATE16_LOCAL_CANDIDATE_ONLY",
    productionActionAllowed: false,
    sourceIncidentReceipt: {
      fileName:
        "CODEX-ALIYUN-AISTORY-P0.5-SYNTHETIC-SINGLETON-BLOCKED-20260829-0540.md",
      bytes: 1011,
      sha256:
        "f38be911c5c8128ed9344e7e094f2ed2604ee21bc451505e62ad10515f0c4ad3",
    },
    qualificationMarkerResult: "NONE",
    gate15: {
      version: "20260828233000",
      migrationPath:
        "supabase/migrations/20260828233000_independent_admin_principal_pg16_gate.sql",
      migrationBytes: 57208,
      migrationSha256:
        "29c23ec6ef72ae04a9037d5c191ccc2b9d0e7fee614284f26a611bb4c4ef2b97",
      immutablePackageSha256:
        "9e34b8387754c7533c47aeb22ac9d9399f14a95fc65718e567f07d565c91412b",
      postQualificationDumpSha256:
        "d85d63ed3cf54f8231207383dd5474cb5661aebaab433ee75c1f04eeeb8d1794",
    },
    gate16: {
      version: "20260829063000",
      migrationPath:
        "supabase/migrations/20260829063000_independent_admin_qualification_residue_retirement_gate.sql",
      migrationBytes: 66767,
      migrationSha256:
        "4c958ca8af443e97f254fef1cfb1c2e6ea48f1907466d1b1c2ebc2282f598644",
    },
    approvedMechanism:
      "OWNER_ONLY_ONE_TIME_ATTESTATION_AND_DATABASE_EXACT_PRE_STATE_COMMITMENT",
    retirementSemantics: "IRREVERSIBLE_REVOKED_HISTORY_NO_DELETE",
    productionSwitchRequiresSeparateAuthorization: true,
    protectedTtyInitializerAllowed: false,
    secretValuesIncluded: false,
  });
  const ledgerCompatibilityEvidence = JSON.parse(
    ledgerCompatibilityEvidenceRaw,
  ) as Record<string, unknown>;
  assert.deepEqual(ledgerCompatibilityEvidence, {
    schemaVersion:
      "aistory.independent-admin.gate16-ledger-envelope-supersession.v1",
    status:
      "SUPERSEDES_LEDGER_APPEND_ENVELOPE_FAILURE_LOCAL_CANDIDATE_ONLY",
    productionActionAllowed: false,
    domainMigration: {
      version: "20260829063000",
      path:
        "supabase/migrations/20260829063000_independent_admin_qualification_residue_retirement_gate.sql",
      bytes: 66767,
      sha256:
        "4c958ca8af443e97f254fef1cfb1c2e6ea48f1907466d1b1c2ebc2282f598644",
      changedByCorrection: false,
    },
    failedPackage: {
      fileName:
        "aistory-p05-independent-admin-gate16-production-source-20260830-102351.zip",
      sha256:
        "4a93f3e0ecdbf4ad00117fb0d78b901fc713eff4455bd4f81c67eb09d0fb3c6c",
      manifestSha256:
        "501359e6a06c08f55ca2264ee80dcb1e72cc29ac98d9e2648e337fdc24ee020b",
      sidecarSha256:
        "b60271c74e5caecdee89402b6cce576d7eef5e88234868f5cb4fbed200a66026",
      failurePhase: "MIGRATION_LEDGER_APPEND",
      missingObjectClass: "COLUMN",
      missingObjectName: "statements",
      rollback: "CONFIRMED_GATE15_1_GATE16_0_NO_PARTIAL_SCHEMA",
    },
    targetLedgerContract: {
      relation: "supabase_migrations.schema_migrations",
      relkind: "r",
      ownerRole: "postgres",
      columns: [
        "version:text:notnull:no-default",
        "name:text:notnull:no-default",
        "sha256:text:notnull:no-default",
        "applied_at:timestamp-with-time-zone:notnull:default-now",
      ],
      primaryKey: ["version"],
      nonInternalTriggerCount: 0,
      nonInternalRuleCount: 0,
    },
    correctedEnvelope: {
      path: "scripts/apply-independent-admin-gate16-ledger.psql",
      mode: "PSQL_OWNER_ONLY_SINGLE_TRANSACTION_EXACT_LEDGER_SHAPE",
      gate15Predecessor: {
        version: "20260828233000",
        name: "independent_admin_principal_pg16_gate",
        sha256:
          "29c23ec6ef72ae04a9037d5c191ccc2b9d0e7fee614284f26a611bb4c4ef2b97",
        appliedAtRequired: true,
        rowLockRequired: true,
      },
      appendColumns: ["version", "name", "sha256"],
      appliedAtSource: "DATABASE_DEFAULT_NOW",
      onConflictAllowed: false,
      ledgerRepairAllowed: false,
      manualMarkAllowed: false,
      unknownShape: "FAIL_CLOSED",
    },
    gate16SemanticsChanged: false,
    p06Paused: true,
    productionDatabaseTouched: false,
    secretValuesIncluded: false,
  });
  const predecessorLineageEvidence = JSON.parse(
    predecessorLineageEvidenceRaw,
  ) as Record<string, unknown>;
  assert.deepEqual(predecessorLineageEvidence, {
    schemaVersion:
      "aistory.independent-admin.gate16-predecessor-lineage-reconciliation.v1",
    status:
      "SUPERSEDES_INFERRED_PREDECESSOR_NAME_LOCAL_CANDIDATE_ONLY",
    productionActionAllowed: false,
    sourceServerReceipt: {
      fileName:
        "CODEX-ALIYUN-AISTORY-GATE16-152452-LEDGER-PREDECESSOR-BLOCKED-20260830-1612.md",
      status:
        "BLOCKED_GATE16_LEDGER_PREDECESSOR_NAME_MISMATCH_PRODUCTION_UNCHANGED",
      databaseMutation: false,
    },
    authoritativePredecessor: {
      version: "20260828233000",
      name: "20260828233000_independent_admin_principal_pg16_gate.sql",
      nameUtf8Bytes: 56,
      nameUtf8Sha256:
        "4ca2dc89471e0ca4348d1b83363caa4e0bb2ff31e7d6403e31538262c4e8e951",
      migrationPath:
        "supabase/migrations/20260828233000_independent_admin_principal_pg16_gate.sql",
      migrationBytes: 57208,
      migrationSha256:
        "29c23ec6ef72ae04a9037d5c191ccc2b9d0e7fee614284f26a611bb4c4ef2b97",
      appliedAtType: "timestamp with time zone",
      appliedAtRequired: true,
      appliedAtExactValueRead: false,
      rowCount: 1,
    },
    originalAuditedApplyRule: {
      cloudAssistantInvocationReference: "t-bj06vdzxmbxw5q8",
      executorLabel: "codex-cloud-assistant",
      invokedAtUtc: "2026-08-28T20:11:25Z",
      scriptBytes: 3616,
      scriptSha256:
        "a968970afaee83590dc6dae318ac8da45f13d79972b84f3511476748916bc78d",
      migrationNameVariable:
        "20260828233000_independent_admin_principal_pg16_gate.sql",
      insertColumns: ["version", "name", "sha256", "applied_at"],
      nameDerivation:
        "FULL_MIGRATION_FILENAME_WITH_VERSION_AND_SQL_EXTENSION",
    },
    supersededInference: {
      packageFileName:
        "aistory-p05-independent-admin-gate16-postgres-connection-stable-production-source-20260830-152452.zip",
      packageSha256:
        "bd0d804631d2e35e9eff36483dc5ddee571b8efdba9e6bf892401ad05670215a",
      inferredName: "independent_admin_principal_pg16_gate",
      inferenceSource: "MIGRATION_FILENAME_STEM",
      acceptedByReplacement: false,
    },
    failClosedPolicy: {
      acceptedPredecessorNames: [
        "20260828233000_independent_admin_principal_pg16_gate.sql",
      ],
      gate16LedgerName:
        "20260829063000_independent_admin_qualification_residue_retirement_gate.sql",
      comparison: "POSTGRES_C_COLLATION_EXACT",
      aliasesAllowed: false,
      caseFoldingAllowed: false,
      trimmingAllowed: false,
      normalizationAllowed: false,
      ledgerRenameAllowed: false,
      manualMarkAllowed: false,
      unknownLineage: "FAIL_CLOSED_BEFORE_DDL",
    },
    gate16DomainMigrationChanged: false,
    gate16TwoPartySemanticsChanged: false,
    p06Paused: true,
    stagingOrProductionDatabaseTouched: false,
    secretValuesIncluded: false,
  });
  for (const table of [
    "independent_admin_principals",
    "independent_admin_login_buckets",
    "independent_admin_session_families",
    "independent_admin_sessions",
    "independent_admin_auth_audit",
  ]) {
    assert.match(migration, new RegExp(`create table public\\.${table}`));
    assert.match(migration, new RegExp(`alter table public\\.${table}\\s+force row level security`));
  }
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.equal(INDEPENDENT_ADMIN_PRINCIPAL_DB_GATE_VERSION, "20260829063000");
  assert.match(migration, /values \('independent_admin_principal', '20260828233000'\)/);
  assert.match(migration, /request_payload jsonb/);
  assert.doesNotMatch(migration, /\bauthorization\s+jsonb\b/i);
  assert.match(migration, /procedure_row\.proargnames = array\['request_payload'\]/);
  assert.match(migration, /pg_catalog\.pg_get_keywords\(\)/);
  assert.match(
    migration,
    /keyword_row\.catcode\s+in\s*\(\s*'R',\s*'T'\s*\)/,
  );
  assert.doesNotMatch(migration, /on conflict \(gate_name\) do update/i);
  assert.match(migration, /superseded or partial gate present/);
  assert.match(migration, /independent_admin_auth_audit_no_truncate/);
  assert.match(migration, /trigger_row\.tgenabled = 'O'/);
  assert.match(migration, /trigger_row\.tgfoid/);
  assert.match(migration, /trigger_row\.tgtype = 34/);
  assert.match(migration, /has_sequence_privilege/);
  assert.match(migration, /aistory_independent_admin_project_snapshot\(text\)/);
  assert.match(migration, /cardinality\(v_newly_locked_hashes\) > 0/);
  assert.match(migration, /v_total_buckets \+ v_missing_buckets > 4096/);
  assert.match(migration, /procedure_row\.provolatile = case/);
  assert.match(migration, /then 's'::"char"\s+else 'v'::"char"/);
  for (const [functionName, initialLookup] of [
    ["verify_session", "where session_row.session_hash = v_session_hash;"],
    [
      "rotate_session",
      "where session_row.session_hash = rotation->>'current_session_hash';",
    ],
    [
      "revoke_session",
      "where session_row.session_hash = session->>'session_hash';",
    ],
  ] as const) {
    const blockStart = migration.indexOf(
      `create function public.aistory_independent_admin_${functionName}(`,
    );
    const blockEnd = migration.indexOf("\ncreate function public.", blockStart + 1);
    const block = migration.slice(
      blockStart,
      blockEnd === -1 ? migration.length : blockEnd,
    );
    const initialLookupIndex = block.indexOf(initialLookup);
    const familyLockIndex = block.indexOf(
      "from public.independent_admin_session_families as family_row",
      initialLookupIndex,
    );
    const sessionLockIndex = block.indexOf(
      "and session_row.family_hash = v_family.family_hash\n  for update;",
      familyLockIndex,
    );
    assert.ok(initialLookupIndex > 0);
    assert.ok(familyLockIndex > initialLookupIndex);
    assert.ok(sessionLockIndex > familyLockIndex);
  }
  assert.match(migration, /v_next_expires_at > v_family\.absolute_expires_at/);
  assert.match(migration, /v_current\.replacement_session_hash = v_next_hash/);
  assert.doesNotMatch(migration, /set absolute_expires_at = v_next_expires_at/);
  assert.doesNotMatch(migration, /select \* from public\./i);
  assert.doesNotMatch(migration, /secret_reference|webhook_secret_reference/i);
  assert.match(migration, /'roles', '\[\]'::jsonb/);
  assert.match(migration, /'billing_policies', '\[\]'::jsonb/);
  assert.doesNotMatch(
    migration.replace(/^--.*$/gm, ""),
    /(?:from|join|insert into|update|delete from)\s+(?:public\.)?(?:app_users|phone_identities|user_roles|admin_bootstrap_allowlist)\b/i,
  );
  assert.match(
    gate16Migration,
    /gate_row\.version\s*=\s*'20260828233000'/,
  );
  assert.match(gate16Migration, /set version = '20260829063000'/);
  assert.match(
    gate16Migration,
    /aistory_independent_admin_assert_database_owner\(\)/,
  );
  assert.match(
    gate16Migration,
    /OWNER_ONLY|owner-only|owner authorization/i,
  );
  assert.match(gate16Migration, /awaiting_attestation/);
  assert.match(gate16Migration, /qualification_residue_retired/);
  assert.match(gate16Migration, /not_required/);
  assert.match(gate16Migration, /authAuditSequence/);
  assert.match(gate16Migration, /sequence_row\.last_value/);
  assert.match(gate16Migration, /sequence_row\.is_called/);
  assert.match(gate16Migration, /collate "C"/);
  assert.match(gate16Migration, /extract\(epoch from/);
  assert.match(gate16Migration, /owner_marker_commitment_sha256/);
  assert.match(gate16Migration, /incident_receipt_sha256/);
  assert.match(
    gate16Migration,
    /f38be911c5c8128ed9344e7e094f2ed2604ee21bc451505e62ad10515f0c4ad3/,
  );
  assert.match(
    gate16Migration,
    /9e34b8387754c7533c47aeb22ac9d9399f14a95fc65718e567f07d565c91412b/,
  );
  assert.match(
    gate16Migration,
    /29c23ec6ef72ae04a9037d5c191ccc2b9d0e7fee614284f26a611bb4c4ef2b97/,
  );
  assert.match(
    gate16Migration,
    /d85d63ed3cf54f8231207383dd5474cb5661aebaab433ee75c1f04eeeb8d1794/,
  );
  assert.doesNotMatch(
    gate16Migration,
    /to_jsonb\((?:principal|bucket|family|session|audit)_row\)/,
  );
  assert.doesNotMatch(
    gate16Migration.replace(/^--.*$/gm, ""),
    /\bdelete\s+from\s+public\.independent_admin_|\btruncate\s+public\.independent_admin_/i,
  );
  assert.doesNotMatch(
    gate16Migration.replace(/^--.*$/gm, ""),
    /(?:from|join|insert into|update|delete from)\s+(?:public\.)?(?:app_users|phone_identities|user_roles|admin_bootstrap_allowlist)\b/i,
  );
  assert.match(ledgerApplicatorSource, /^\\set ON_ERROR_STOP on\r?\n/);
  assert.match(ledgerApplicatorSource, /pg_advisory_xact_lock\(20260829, 63000\)/);
  assert.match(
    ledgerApplicatorSource,
    /to_regclass\('supabase_migrations\.schema_migrations'\)/,
  );
  assert.match(ledgerApplicatorSource, /v_column_count <> 4/);
  assert.match(ledgerApplicatorSource, /attribute_row\.attname = 'sha256'/);
  assert.match(ledgerApplicatorSource, /attribute_row\.attname = 'applied_at'/);
  assert.match(ledgerApplicatorSource, /pg_get_expr\([\s\S]*\) = 'now\(\)'/);
  assert.match(ledgerApplicatorSource, /constraint_row\.conkey = array\[1\]::smallint\[\]/);
  assert.match(ledgerApplicatorSource, /not trigger_row\.tgisinternal/);
  assert.match(ledgerApplicatorSource, /pg_catalog\.pg_rewrite/);
  assert.match(
    ledgerApplicatorSource,
    /\\ir \.\.\/supabase\/migrations\/20260829063000_independent_admin_qualification_residue_retirement_gate\.sql/,
  );
  assert.match(
    ledgerApplicatorSource,
    /insert into supabase_migrations\.schema_migrations\s*\(\s*version,\s*name,\s*sha256\s*\)/,
  );
  assert.match(ledgerApplicatorSource, new RegExp(
    "4c958ca8af443e97f254fef1cfb1c2e6ea48f1907466d1b1c2ebc2282f598644",
  ));
  assert.match(ledgerApplicatorSource, /get diagnostics v_inserted = row_count/);
  assert.match(ledgerApplicatorSource, /PASS_GATE16_ATOMIC_LEDGER_APPLY/);
  assert.doesNotMatch(
    ledgerApplicatorSource.replace(/^--.*$/gm, ""),
    /\bstatements\b|on conflict|\bdigest\s*\(|create\s+(?:schema|table)\s+supabase_migrations|alter\s+table\s+supabase_migrations/i,
  );
  const applicatorPreflight = ledgerApplicatorSource.indexOf(
    "$aistory_gate16_ledger_preflight$",
  );
  const applicatorMigration = ledgerApplicatorSource.indexOf(
    "\\ir ../supabase/migrations/20260829063000_",
  );
  const applicatorAppend = ledgerApplicatorSource.indexOf(
    "$aistory_gate16_ledger_append$",
  );
  const applicatorPostflight = ledgerApplicatorSource.indexOf(
    "$aistory_gate16_ledger_postflight$",
  );
  const applicatorCommit = ledgerApplicatorSource.lastIndexOf("\ncommit;");
  assert.ok(applicatorPreflight > 0);
  assert.ok(applicatorMigration > applicatorPreflight);
  assert.ok(applicatorAppend > applicatorMigration);
  assert.ok(applicatorPostflight > applicatorAppend);
  assert.ok(applicatorCommit > applicatorPostflight);
  assert.match(repositorySource, /request_payload:\s*\{/);
  assert.doesNotMatch(repositorySource, /\bauthorization:\s*\{/);
  assert.match(serverSource, /inspectIndependentAdminPrincipalLoginRequest/);
  assert.match(serverSource, /AISTORY_TRUST_PROXY_HEADERS/);
  assert.doesNotMatch(serverSource, /console\.(?:log|warn|error)|readPhoneUserSession/);
  assert.match(routeSource, /disabledIndependentBody/);
  assert.match(routeSource, /response\.status === 200\) clearIndependentCookie/);
  assert.doesNotMatch(securitySource, /readPhoneUserSession/);
  assert.doesNotMatch(formSource, /AuthModal|\/api\/auth\/phone/);
  assert.match(formSource, /独立管理员账号/);
  assert.match(consoleSource, /生产安全只读/);
  assert.match(initializerSource, /--resume-rotate/);
  assert.match(initializerSource, /nlink !== 1/);
  assert.match(initializerSource, /fileURLToPath/);
  assert.match(initializerSource, /process\.stdin\.isTTY/);
  assert.match(initializerSource, /setRawMode\(true\)/);
  assert.doesNotMatch(initializerSource, /--username|--password/);
  assert.match(initializerSource, /spawnSync\(/);
  assert.match(initializerSource, /"--conditions=react-server"/);
  assert.match(initializerSource, /import\.meta\.resolve\("tsx"\)/);
  assert.match(initializerSource, /stdio: "inherit"/);
  assert.match(initializerSource, /shell: false/);
  assert.match(
    initializerSource,
    /import\("@\/lib\/admin\/independentPrincipal"\)/,
  );
  assert.match(
    initializerSource,
    /import\("@\/lib\/admin\/independentPrincipalRepository"\)/,
  );
  assert.match(
    initializerSource,
    /import\("@\/lib\/admin\/independentPrincipalServer"\)/,
  );
  assert.match(
    initializerSource,
    /import\("@\/lib\/production\/databaseGate"\)/,
  );
  assert.doesNotMatch(
    initializerSource,
    /^import (?!type\b)[^;]+from "@\/lib\/(?:admin\/independentPrincipal(?:Repository|Server)?|production\/databaseGate)";$/gm,
  );
  assert.doesNotMatch(initializerSource, /NODE_OPTIONS/);
  assert.match(postgres16HarnessSource, /POSTGRES_IMAGE_DIGEST_SUFFIX/);
  assert.match(postgres16HarnessSource, /validatePinnedImageMetadata/);
  assert.match(postgres16HarnessSource, /validateContainerMetadata/);
  assert.match(postgres16HarnessSource, /--metadata-contract-only/);
  assert.match(postgres16HarnessSource, /--connection-version-contract-only/);
  assert.match(postgres16HarnessSource, /EXPECTED_POSTGRES_SERVER_VERSION_NUM = "160015"/);
  assert.match(
    postgres16HarnessSource,
    /16\.15 \(Debian 16\.15-1\.pgdg13\+2\)/,
  );
  assert.match(postgres16HarnessSource, /POSTGRES_SOCKET_DIRECTORY = "\/var\/run\/postgresql"/);
  assert.match(postgres16HarnessSource, /TEMPORARY_POSTMASTER_REJECTED/);
  assert.match(postgres16HarnessSource, /POSTMASTER_RESTARTED_DURING_GATE/);
  assert.match(postgres16HarnessSource, /POSTGRES_CONNECTION_FAILURE/);
  assert.match(postgres16HarnessSource, /POSTGRES_VERSION_MISMATCH/);
  assert.match(postgres16HarnessSource, /POSTGRES_PROBE_PROTOCOL_INVALID/);
  assert.match(postgres16HarnessSource, /POSTGRES_CONNECTION_POSTURE_INVALID/);
  assert.match(postgres16HarnessSource, /postgresVersionGateFailureReceipt/);
  assert.match(postgres16HarnessSource, /process\.exitCode = 31/);
  assert.match(postgres16HarnessSource, /identity\.postmasterPid !== 1/);
  assert.match(postgres16HarnessSource, /previousIdentity\.postmasterStartTime/);
  assert.match(postgres16HarnessSource, /"-w",\s*"-h",\s*POSTGRES_SOCKET_DIRECTORY/);
  assert.match(postgres16HarnessSource, /"exec",\s*"-i",\s*containerId,\s*"psql"/);
  assert.doesNotMatch(postgres16HarnessSource, /"-i",\s*containerName,\s*"psql"/);
  assert.match(postgres16HarnessSource, /legacy statements-column ledger append reproduction/);
  assert.match(postgres16HarnessSource, /Gate16 exact migration ledger columns unavailable/);
  assert.match(
    postgres16HarnessSource,
    /superseded inferred Gate15 ledger stem fail closed/,
  );
  assert.match(postgres16HarnessSource, /hostile Gate15 ledger alias fail closed/);
  assert.match(postgres16HarnessSource, /hostile Gate15 ledger version fail closed/);
  assert.match(postgres16HarnessSource, /hostile Gate15 ledger SHA fail closed/);
  assert.match(postgres16HarnessSource, /hostile Gate15 ledger applied_at fail closed/);
  assert.match(postgres16HarnessSource, /databaseScenarios: 16/);
  assert.match(postgres16HarnessSource, /ledgerCompatibilityScenarios: 10/);
  assert.match(postgres16HarnessSource, /version text primary key/);
  assert.match(postgres16HarnessSource, /sha256 text not null/);
  assert.match(
    ledgerApplicatorSource,
    /20260828233000_independent_admin_principal_pg16_gate\.sql/,
  );
  assert.match(
    ledgerApplicatorSource,
    /20260829063000_independent_admin_qualification_residue_retirement_gate\.sql/,
  );
  assert.match(ledgerApplicatorSource, /collate "C"/);
  assert.doesNotMatch(
    ledgerApplicatorSource,
    /ledger_row\.name\s*=\s*'independent_admin_principal_pg16_gate'/,
  );
  assert.match(
    postgres16HarnessSource,
    /const GATE15_LEDGER_NAME = REPLACEMENT_MIGRATION/,
  );
  assert.match(
    postgres16HarnessSource,
    /const GATE16_LEDGER_NAME = RETIREMENT_MIGRATION/,
  );
  assert.match(
    postgres16HarnessSource,
    /name: migration,/,
  );
  assert.match(
    ledgerApplicatorSource,
    /29c23ec6ef72ae04a9037d5c191ccc2b9d0e7fee614284f26a611bb4c4ef2b97/,
  );
  assert.match(ledgerApplicatorSource, /for update;/);
  assert.match(ledgerApplicatorSource, /ledger_row\.applied_at is not null/);
  assert.match(
    postgres16HarnessSource,
    /\["container", "inspect", "--format", CONTAINER_METADATA_FORMAT, containerId\]/,
  );
  assert.doesNotMatch(
    postgres16HarnessSource,
    /\["inspect",\s*containerName\]/,
  );
  assert.doesNotMatch(
    postgres16HarnessSource,
    /\{\{json \.Config\.Env\}\}|\{\{json \.Mounts\}\}/,
  );
  assert.match(runbook, /root-only/i);
  assert.doesNotMatch(runbook, new RegExp(fixtureUsername, "i"));

  const allReceipts = JSON.stringify({
    events: fake.events,
    actor: authorized?.actor,
    gate: ready,
  });
  for (const sensitive of [
    fixtureUsername,
    fixturePassword,
    wrongPassword,
    credential.principalId,
    credential.usernameVerifierHmacSha256,
    credential.keyMaterialBase64url,
    credentialReference,
    productionEnv.SUPABASE_SERVICE_ROLE_KEY!,
  ]) assert.equal(allReceipts.includes(sensitive), false);

  assert.equal(fetchCalls, 0);
  console.log("independent administrator principal production tests passed");
} finally {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: originalFetch,
  });
}
