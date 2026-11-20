import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  handleIndependentAdminPrincipalLoginRequest,
  INDEPENDENT_ADMIN_PRINCIPAL_CREDENTIAL_FILE_ENV,
  INDEPENDENT_ADMIN_PRINCIPAL_MODE_ENV,
  INDEPENDENT_ADMIN_PRINCIPAL_PRODUCTION_MODE,
  independentAdminPrincipalCookieOptions,
  loadIndependentAdminPrincipalCredential,
  inspectIndependentAdminPrincipalLoginRequest,
  projectIndependentAdminPrincipalCredentialBinding,
  resolveIndependentAdminPrincipalSessionContext,
  verifyFirstChangeIndependentAdminPassword,
  rotateFirstChangeIndependentAdminPassword,
  type IndependentAdminPrincipalAuthStateStore,
  type IndependentAdminPrincipalRuntime,
} from "./independentPrincipal";
import {
  createSupabaseIndependentAdminPrincipalRepository,
  INDEPENDENT_ADMIN_PRINCIPAL_DB_GATE_ENV,
  INDEPENDENT_ADMIN_PRINCIPAL_DB_GATE_VERSION,
  INDEPENDENT_ADMIN_PRINCIPAL_ORIGIN_ENV,
  IndependentAdminPrincipalRepositoryError,
  type IndependentAdminPrincipalDatabaseSessionContext,
  type IndependentAdminPrincipalRpcClient,
  type SupabaseIndependentAdminPrincipalRepository,
} from "./independentPrincipalRepository";
import {
  assertProductionDatabaseGateReady,
  createProductionSupabaseServiceClient,
  inspectProductionDatabaseGate,
  ProductionDatabaseGateError,
} from "@/lib/production/databaseGate";
import { resolveSmsRequestIp } from "@/lib/auth/trustedClientIp";
import type { AdminActor } from "./types";
import { FIRST_PASSWORD_CHANGE_ENV, FIRST_PASSWORD_CHANGE_POLICY,
  readFirstPasswordState, FirstPasswordChangeRepository, exactFirstChangeRecord,
} from "./independentFirstPasswordChange";

export const INDEPENDENT_ADMIN_PRINCIPAL_PRODUCTION_COOKIE =
  "__Host-aistory_admin_principal_v2";
export const INDEPENDENT_ADMIN_PRINCIPAL_PUBLIC_ACTOR_ID =
  "independent-admin";

const MAX_LOGOUT_BODY_BYTES = 128;

type PrincipalServerEnvironment = Record<string, string | undefined>;

export type IndependentAdminPrincipalProductionGateStatus = Readonly<{
  ready: boolean;
  expectedVersion: typeof INDEPENDENT_ADMIN_PRINCIPAL_DB_GATE_VERSION;
  missing: readonly (
    | "mode"
    | "credential_reference"
    | "database_gate_version"
    | "public_origin"
    | "trusted_proxy"
    | "local_admin_disabled"
    | "production_database"
    | "first_password_change"
  )[];
}>;

export type IndependentAdminPrincipalServerOptions = Readonly<{
  env?: PrincipalServerEnvironment;
  workspaceRoot?: string;
  now?: number;
  client?: SupabaseClient & IndependentAdminPrincipalRpcClient;
  clientBucket?: string;
  loadCredentialFile?: (
    fileReference: string,
    workspaceRoot: string,
  ) => Promise<string>;
  randomSessionBytes?: () => Buffer;
}>;

export type IndependentAdminPrincipalAuthorizedContext = Readonly<{
  actor: AdminActor;
  databaseContext: IndependentAdminPrincipalDatabaseSessionContext;
  repository: SupabaseIndependentAdminPrincipalRepository;
  client: SupabaseClient;
}>;

const unreachableStore: IndependentAdminPrincipalAuthStateStore = {
  reserveLoginAttempts: async () => {
    throw new IndependentAdminPrincipalRepositoryError();
  },
  recordInvalidCredentials: async () => {
    throw new IndependentAdminPrincipalRepositoryError();
  },
  commitLoginSuccess: async () => {
    throw new IndependentAdminPrincipalRepositoryError();
  },
  isSessionCurrent: async () => {
    throw new IndependentAdminPrincipalRepositoryError();
  },
  revokeSession: async () => {
    throw new IndependentAdminPrincipalRepositoryError();
  },
  rotateSession: async () => {
    throw new IndependentAdminPrincipalRepositoryError();
  },
  appendSecurityEvent: async () => {
    throw new IndependentAdminPrincipalRepositoryError();
  },
};

export class IndependentAdminPrincipalServerError extends Error {
  readonly code = "INDEPENDENT_ADMIN_PRINCIPAL_UNAVAILABLE";
  readonly status = 503;

  constructor() {
    super("Administrator sign-in is unavailable.");
    this.name = "IndependentAdminPrincipalServerError";
  }
}

function fail(): never {
  throw new IndependentAdminPrincipalServerError();
}

function parseProductionOrigin(value: string | undefined): string | undefined {
  if (!value || value !== value.trim()) return undefined;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:"
      || parsed.username !== ""
      || parsed.password !== ""
      || parsed.pathname !== "/"
      || parsed.search !== ""
      || parsed.hash !== ""
    ) return undefined;
    return parsed.origin;
  } catch {
    return undefined;
  }
}

export function inspectIndependentAdminPrincipalProductionGate(
  env: PrincipalServerEnvironment = process.env,
): IndependentAdminPrincipalProductionGateStatus {
  const missing: Array<
    IndependentAdminPrincipalProductionGateStatus["missing"][number]
  > = [];
  if (
    env[INDEPENDENT_ADMIN_PRINCIPAL_MODE_ENV]
      !== INDEPENDENT_ADMIN_PRINCIPAL_PRODUCTION_MODE
  ) missing.push("mode");
  if (!env[INDEPENDENT_ADMIN_PRINCIPAL_CREDENTIAL_FILE_ENV]?.trim()) {
    missing.push("credential_reference");
  }
  if (
    env[INDEPENDENT_ADMIN_PRINCIPAL_DB_GATE_ENV]?.trim()
      !== INDEPENDENT_ADMIN_PRINCIPAL_DB_GATE_VERSION
  ) missing.push("database_gate_version");
  if (!parseProductionOrigin(env[INDEPENDENT_ADMIN_PRINCIPAL_ORIGIN_ENV])) {
    missing.push("public_origin");
  }
  if (env.AISTORY_TRUST_PROXY_HEADERS !== "true") {
    missing.push("trusted_proxy");
  }
  if (
    env.AISTORY_LOCAL_ADMIN_ENABLED === "true"
    || !!env.AISTORY_LOCAL_ADMIN_SECRET?.trim()
  ) missing.push("local_admin_disabled");
  if (!inspectProductionDatabaseGate(env).ready) {
    missing.push("production_database");
  }
  if (env[FIRST_PASSWORD_CHANGE_ENV] !== FIRST_PASSWORD_CHANGE_POLICY) missing.push("first_password_change");
  return Object.freeze({
    ready: missing.length === 0,
    expectedVersion: INDEPENDENT_ADMIN_PRINCIPAL_DB_GATE_VERSION,
    missing: Object.freeze(missing),
  });
}

export function isIndependentAdminPrincipalProductionModeSelected(
  env: PrincipalServerEnvironment = process.env,
): boolean {
  return env[INDEPENDENT_ADMIN_PRINCIPAL_MODE_ENV]
    === INDEPENDENT_ADMIN_PRINCIPAL_PRODUCTION_MODE;
}

export function hasIndependentAdminPrincipalModeValue(
  env: PrincipalServerEnvironment = process.env,
): boolean {
  return !!env[INDEPENDENT_ADMIN_PRINCIPAL_MODE_ENV]?.trim();
}

export function isIndependentAdminPrincipalSameOriginRequest(
  request: Request,
  expectedOrigin: string,
): boolean {
  try {
    const expected = new URL(expectedOrigin);
    const requestUrl = new URL(request.url);
    const origin = request.headers.get("origin");
    const host = request.headers.get("host");
    if (!origin || !host) return false;
    const parsedOrigin = new URL(origin);
    return expected.protocol === "https:"
      && expected.pathname === "/"
      && expected.search === ""
      && expected.hash === ""
      && parsedOrigin.protocol === "https:"
      && parsedOrigin.username === ""
      && parsedOrigin.password === ""
      && parsedOrigin.pathname === "/"
      && parsedOrigin.search === ""
      && parsedOrigin.hash === ""
      && parsedOrigin.origin === expected.origin
      && requestUrl.origin === expected.origin
      && host.trim().toLowerCase() === expected.host.toLowerCase();
  } catch {
    return false;
  }
}

function noStoreJson(body: Record<string, unknown>, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

// Optional exact adapter for canonical Next behind an independently qualified
// loopback HTTPS proxy. Neither the public origin nor internal origin is inferred
// from request headers; missing/unqualified configuration never widens admission.
function normalizeIndependentAdminSessionTransport(
  request: Request,
  env: PrincipalServerEnvironment,
  expectedOrigin: string,
  pathname: "/api/admin/session" | "/api/admin/password-change",
  methods: readonly string[],
): Request | undefined {
  try {
    const actual = new URL(request.url);
    if (actual.pathname !== pathname || actual.search || actual.hash
      || !methods.includes(request.method)) return;
    if (actual.origin === expectedOrigin) return request;
    const configured = env.AISTORY_ADMIN_PRINCIPAL_INTERNAL_ORIGIN;
    if (!configured || env.AISTORY_TRUST_PROXY_HEADERS !== "true") return;
    const internal = new URL(configured), external = new URL(expectedOrigin);
    if (configured !== internal.origin || internal.protocol !== "https:"
      || !["localhost", "127.0.0.1", "[::1]"].includes(internal.hostname)
      || !internal.port || internal.username || internal.password
      || actual.origin !== internal.origin
      || request.headers.get("origin") !== external.origin
      || request.headers.get("host") !== external.host
      || request.headers.get("x-forwarded-host") !== external.host
      || request.headers.get("x-forwarded-proto") !== "https"
      || request.headers.has("forwarded")
      || request.headers.get("sec-fetch-site") !== "same-origin") return;
    return new Request(external.origin + actual.pathname, request);
  } catch { return; }
}

async function readBoundedLogoutBody(
  request: Request,
): Promise<string | undefined> {
  const declared = request.headers.get("content-length");
  if (
    declared
    && (!/^\d+$/.test(declared) || Number(declared) > MAX_LOGOUT_BODY_BYTES)
  ) return undefined;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = Buffer.from(result.value);
      total += chunk.byteLength;
      if (total > MAX_LOGOUT_BODY_BYTES) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(chunk);
    }
  } catch {
    return undefined;
  }
  if (declared && Number(declared) !== total) return undefined;
  return Buffer.concat(chunks, total).toString("utf8");
}

function createClient(
  options: IndependentAdminPrincipalServerOptions,
): SupabaseClient & IndependentAdminPrincipalRpcClient {
  return options.client ?? createProductionSupabaseServiceClient(
    options.env,
  ) as SupabaseClient & IndependentAdminPrincipalRpcClient;
}

async function createRuntime(
  options: IndependentAdminPrincipalServerOptions = {},
): Promise<Readonly<{
  runtime: IndependentAdminPrincipalRuntime;
  repository: SupabaseIndependentAdminPrincipalRepository;
  client: SupabaseClient;
}>> {
  const env = options.env ?? process.env;
  const gate = inspectIndependentAdminPrincipalProductionGate(env);
  if (!gate.ready) fail();
  const expectedOrigin = parseProductionOrigin(
    env[INDEPENDENT_ADMIN_PRINCIPAL_ORIGIN_ENV],
  );
  if (!expectedOrigin) fail();
  const loadRuntime: IndependentAdminPrincipalRuntime = {
    env,
    workspaceRoot: options.workspaceRoot,
    now: options.now,
    loadCredentialFile: options.loadCredentialFile,
    store: unreachableStore,
    expectedMode: INDEPENDENT_ADMIN_PRINCIPAL_PRODUCTION_MODE,
    actorMode: "production",
    expectedOrigin,
    clientBucket: "production-origin",
    ...(options.clientBucket ? { clientBucket: options.clientBucket } : {}),
  };
  let credential;
  try {
    credential = await loadIndependentAdminPrincipalCredential(loadRuntime);
  } catch {
    fail();
  }
  const client = createClient(options);
  try {
    await assertProductionDatabaseGateReady("identity", client, env);
    const baseRepository = createSupabaseIndependentAdminPrincipalRepository(
      client,
      projectIndependentAdminPrincipalCredentialBinding(credential),
    );
    await baseRepository.assertGateReady();
    const state = await readFirstPasswordState(client, credential);
    const repository = new FirstPasswordChangeRepository(client, state);
    return Object.freeze({
      client,
      repository,
      runtime: Object.freeze({
        ...loadRuntime,
        credential: state.credential,
        passwordSubject: "principal" as const,
        mustChangePassword: state.mustChangePassword,
        store: repository,
        randomSessionBytes: options.randomSessionBytes,
      }),
    });
  } catch (error) {
    if (
      error instanceof ProductionDatabaseGateError
      || error instanceof IndependentAdminPrincipalRepositoryError
    ) fail();
    throw error;
  }
}

export async function handleIndependentAdminPrincipalProductionLogin(
  request: Request,
  options: IndependentAdminPrincipalServerOptions = {},
): Promise<Readonly<{ response: Response; sessionToken?: string }>> {
  const env = options.env ?? process.env;
  const gate = inspectIndependentAdminPrincipalProductionGate(env);
  const expectedOrigin = parseProductionOrigin(
    env[INDEPENDENT_ADMIN_PRINCIPAL_ORIGIN_ENV],
  );
  if (!gate.ready || !expectedOrigin) {
    return Object.freeze({
      response: noStoreJson(
        { error: "Administrator sign-in is unavailable." },
        503,
      ),
    });
  }
  const normalized = normalizeIndependentAdminSessionTransport(request, env, expectedOrigin, "/api/admin/session", ["POST"]);
  if (!normalized) return Object.freeze({ response: noStoreJson({ error: "Administrator sign-in failed." }, 403) });
  request = normalized;
  const inspection = await inspectIndependentAdminPrincipalLoginRequest(
    request,
    expectedOrigin,
  );
  if (inspection.kind !== "valid") {
    return Object.freeze({
      response: noStoreJson({ error: "Administrator sign-in failed." }, 403),
    });
  }
  try {
    const { runtime } = await createRuntime({
      ...options,
      clientBucket: resolveSmsRequestIp(
        request.headers,
        env.AISTORY_TRUST_PROXY_HEADERS === "true",
      ),
    });
    // DB state alone selects the restricted/console stage. Pending accounts do
    // not expire with a manual window; public defaults are first-claim-wins,
    // not evidence of deployment ownership. No role is issued at this stage.
    return await handleIndependentAdminPrincipalLoginRequest(
      request,
      runtime,
      inspection,
    );
  } catch {
    return Object.freeze({
      response: noStoreJson(
        { error: "Administrator sign-in is unavailable." },
        503,
      ),
    });
  }
}

export async function resolveIndependentAdminPrincipalAuthorizedContext(
  token: string | undefined,
  options: IndependentAdminPrincipalServerOptions = {},
): Promise<IndependentAdminPrincipalAuthorizedContext | undefined> {
  try {
    const { runtime, repository, client } = await createRuntime(options);
    const context = await resolveIndependentAdminPrincipalSessionContext(
      token,
      runtime,
    );
    if (!context) return undefined;
    if (context.mustChangePassword) {
      if (repository instanceof FirstPasswordChangeRepository) await repository.recordRestrictedAccess(context.sessionIdHash);
      return undefined;
    }
    return Object.freeze({
      actor: Object.freeze({
        userId: INDEPENDENT_ADMIN_PRINCIPAL_PUBLIC_ACTOR_ID,
        roles: ["super_admin"] as AdminActor["roles"],
        mode: "independent",
      }),
      databaseContext: Object.freeze({
        binding: context.binding,
        sessionIdHash: context.sessionIdHash,
      }),
      repository,
      client,
    });
  } catch (error) {
    if (error instanceof IndependentAdminPrincipalServerError) throw error;
    fail();
  }
}

export async function handleIndependentAdminPrincipalProductionMe(
  token: string | undefined,
  options: IndependentAdminPrincipalServerOptions = {},
): Promise<Readonly<{ response: Response }>> {
  try {
    const { runtime } = await createRuntime(options);
    const context = await resolveIndependentAdminPrincipalSessionContext(
      token,
      runtime,
    );
    if (!context) {
      return Object.freeze({
        response: noStoreJson({ authenticated: false }, 401),
      });
    }
    if (context.mustChangePassword) return Object.freeze({
      response: noStoreJson({ authenticated: false, state: "password_change_required" }, 200),
    });
    return Object.freeze({
      response: noStoreJson({
        authenticated: true,
        authMode: "independent",
        roles: ["super_admin"],
        state: "console",
      }, 200),
    });
  } catch {
    return Object.freeze({
      response: noStoreJson(
        { error: "Administrator repository is unavailable." },
        503,
      ),
    });
  }
}

export async function handleIndependentAdminPrincipalProductionLogout(
  request: Request,
  token: string | undefined,
  options: IndependentAdminPrincipalServerOptions = {},
): Promise<Response> {
  try {
    const env = options.env ?? process.env;
    const expectedOrigin = parseProductionOrigin(
      env[INDEPENDENT_ADMIN_PRINCIPAL_ORIGIN_ENV],
    );
    const normalized = expectedOrigin && normalizeIndependentAdminSessionTransport(request, env, expectedOrigin, "/api/admin/session", ["DELETE"]);
    if (!normalized) return noStoreJson({ error: "Forbidden" }, 403);
    request = normalized;
    if (
      !expectedOrigin
      || !isIndependentAdminPrincipalSameOriginRequest(
        request,
        expectedOrigin,
      )
      || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(
        request.headers.get("content-type")?.trim() ?? "",
      )
    ) return noStoreJson({ error: "Forbidden" }, 403);
    const raw = await readBoundedLogoutBody(request);
    if (
      raw === undefined
      || raw !== "{}"
    ) return noStoreJson({ error: "Forbidden" }, 403);
    const { runtime } = await createRuntime(options);
    if (token) {
      const context = await resolveIndependentAdminPrincipalSessionContext(
        token,
        runtime,
      );
      if (context) {
        await runtime.store.revokeSession({
          principalId: context.actor.principalId,
          sessionIdHash: context.sessionIdHash,
          now: options.now ?? Date.now(),
        });
      }
    }
    return noStoreJson({ ok: true }, 200);
  } catch {
    return noStoreJson(
      { error: "Administrator repository is unavailable." },
      503,
    );
  }
}

export function independentAdminPrincipalProductionCookieOptions() {
  return independentAdminPrincipalCookieOptions();
}

export async function independentAdminNavigationState(token: string | undefined,
  options: IndependentAdminPrincipalServerOptions = {}): Promise<"password_change_required" | "console" | "signed_out"> {
  if (!token) return "signed_out";
  try {
    const { runtime } = await createRuntime(options);
    const context = await resolveIndependentAdminPrincipalSessionContext(token, runtime);
    return context ? context.mustChangePassword ? "password_change_required" : "console" : "signed_out";
  } catch { return "signed_out"; }
}

export async function handleIndependentAdminPasswordChange(request: Request, token: string | undefined,
  options: IndependentAdminPrincipalServerOptions = {}): Promise<Readonly<{ response: Response; sessionToken?: string }>> {
  const denied = (status = 403) => ({ response: noStoreJson({ error: "Administrator password change failed." }, status) });
  try {
    const env = options.env ?? process.env;
    if (!inspectIndependentAdminPrincipalProductionGate(env).ready) return denied(503);
    const origin = parseProductionOrigin(env[INDEPENDENT_ADMIN_PRINCIPAL_ORIGIN_ENV]);
    const normalized = origin && normalizeIndependentAdminSessionTransport(request, env, origin, "/api/admin/password-change", ["POST"]);
    if (!normalized || !origin) return denied();
    request = normalized;
    if (!isIndependentAdminPrincipalSameOriginRequest(request, origin)
      || request.headers.get("x-aistory-admin-action") !== "first-password-change-v1"
      || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers.get("content-type")?.trim() ?? "")) return denied();
    const { runtime, repository } = await createRuntime(options);
    const context = await resolveIndependentAdminPrincipalSessionContext(token, runtime);
    if (!context?.mustChangePassword || !(repository instanceof FirstPasswordChangeRepository)) return denied();
    const length = request.headers.get("content-length");
    if (length && (!/^\d+$/.test(length) || Number(length) > 2048)) return denied();
    const reader = request.body?.getReader();
    if (!reader) return denied();
    const chunks: Uint8Array[] = []; let count = 0;
    while (true) {
      const part = await reader.read(); if (part.done) break;
      count += part.value.byteLength;
      if (count > 2048) { await reader.cancel(); return denied(); }
      chunks.push(part.value);
    }
    if (length && Number(length) !== count) return denied();
    const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    if (!exactFirstChangeRecord(body, ["currentPassword", "newPassword"])
      || typeof body.currentPassword !== "string" || typeof body.newPassword !== "string"
      || Buffer.byteLength(body.currentPassword) > 512 || Buffer.byteLength(body.newPassword) > 512) return denied();
    const ticket = await repository.reservePasswordChange(context.sessionIdHash);
    if (!ticket) return denied(429);
    const current = repository.state.credential;
    if (!await verifyFirstChangeIndependentAdminPassword(current, body.currentPassword)
      || body.newPassword === body.currentPassword) return denied();
    const next = await rotateFirstChangeIndependentAdminPassword(current, body.newPassword);
    await repository.changePassword({ sessionHash: context.sessionIdHash, ticket, next });
    return Object.freeze({ response: noStoreJson({ ok: true, state: "signed_out", freshLoginRequired: true }, 200) });
  } catch { return denied(); }
}
