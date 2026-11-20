import "server-only";

import {
  createClient,
  type SupabaseClient,
} from "@supabase/supabase-js";

export const PRODUCTION_IDENTITY_DB_GATE_VERSION = "20260811193000";

export type ProductionDatabaseCapability =
  | "identity"
  | "sms"
  | "billing"
  | "credentials"
  | "video_assets";

export type DatabaseGateEnvironment = Partial<Record<
  | "AISTORY_PRODUCTION_IDENTITY_ENABLED"
  | "AISTORY_IDENTITY_REPOSITORY"
  | "AISTORY_ADMIN_REPOSITORY"
  | "AISTORY_DATABASE_GATE_VERSION"
  | "AISTORY_ANONYMOUS_SESSION_SECRET"
  | "AISTORY_ANONYMOUS_SUBJECT_PEPPER"
  | "AISTORY_SUPABASE_SERVER_URL"
  | "NEXT_PUBLIC_SUPABASE_URL"
  | "SUPABASE_SERVICE_ROLE_KEY",
  string | undefined
>>;

export type ProductionDatabaseGateStatus = {
  ready: boolean;
  expectedVersion: string;
  missing: Array<
    | "production_identity_enabled"
    | "identity_repository"
    | "admin_repository"
    | "database_gate_version"
    | "anonymous_session_secret"
    | "anonymous_subject_pepper"
    | "supabase_url"
    | "service_role"
  >;
};

export class ProductionDatabaseGateError extends Error {
  readonly code = "PRODUCTION_IDENTITY_DB_UNAVAILABLE";
  readonly status = 503;

  constructor() {
    super("生产账户与积分仓储尚未就绪，未执行外部调用或正式记账。");
    this.name = "ProductionDatabaseGateError";
  }
}

export function inspectProductionDatabaseGate(
  env: DatabaseGateEnvironment = process.env as DatabaseGateEnvironment,
): ProductionDatabaseGateStatus {
  const missing: ProductionDatabaseGateStatus["missing"] = [];
  if (env.AISTORY_PRODUCTION_IDENTITY_ENABLED !== "true") {
    missing.push("production_identity_enabled");
  }
  if (env.AISTORY_IDENTITY_REPOSITORY !== "supabase") {
    missing.push("identity_repository");
  }
  if (env.AISTORY_ADMIN_REPOSITORY !== "supabase") {
    missing.push("admin_repository");
  }
  if (
    env.AISTORY_DATABASE_GATE_VERSION?.trim()
    !== PRODUCTION_IDENTITY_DB_GATE_VERSION
  ) {
    missing.push("database_gate_version");
  }
  if ((env.AISTORY_ANONYMOUS_SESSION_SECRET?.trim().length || 0) < 32) {
    missing.push("anonymous_session_secret");
  }
  if ((env.AISTORY_ANONYMOUS_SUBJECT_PEPPER?.trim().length || 0) < 32) {
    missing.push("anonymous_subject_pepper");
  }
  if (!getProductionSupabaseServerUrl(env)) {
    missing.push("supabase_url");
  }
  if (!env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    missing.push("service_role");
  }
  return {
    ready: missing.length === 0,
    expectedVersion: PRODUCTION_IDENTITY_DB_GATE_VERSION,
    missing,
  };
}

export function getProductionSupabaseServerUrl(
  env: DatabaseGateEnvironment = process.env as DatabaseGateEnvironment,
): string {
  return (
    env.AISTORY_SUPABASE_SERVER_URL?.trim()
    || env.NEXT_PUBLIC_SUPABASE_URL?.trim()
    || ""
  );
}

function sameOrigin(left: URL, right: URL): boolean {
  return left.protocol === right.protocol
    && left.hostname === right.hostname
    && left.port === right.port;
}

export function rewriteSupabaseRestUrlForPostgrestRoot(
  requestUrl: string | URL,
  supabaseServerUrl = getProductionSupabaseServerUrl(),
): string {
  const configured = new URL(supabaseServerUrl);
  const rewritten = new URL(requestUrl.toString());
  if (sameOrigin(rewritten, configured)) {
    if (rewritten.pathname === "/rest/v1") {
      rewritten.pathname = "/";
    } else if (rewritten.pathname.startsWith("/rest/v1/")) {
      rewritten.pathname = rewritten.pathname.slice("/rest/v1".length);
    }
  }
  return rewritten.toString();
}

function createPostgrestRootFetch(
  supabaseServerUrl = getProductionSupabaseServerUrl(),
): typeof fetch {
  return async (input, init) => {
    const requestUrl = typeof input === "string" || input instanceof URL
      ? input
      : input.url;
    const rewrittenUrl = rewriteSupabaseRestUrlForPostgrestRoot(
      requestUrl,
      supabaseServerUrl,
    );
    if (input instanceof Request) {
      return fetch(new Request(rewrittenUrl, input), init);
    }
    return fetch(rewrittenUrl, init);
  };
}

export function createProductionSupabaseServiceClient(
  env: DatabaseGateEnvironment = process.env as DatabaseGateEnvironment,
): SupabaseClient {
  const supabaseServerUrl = getProductionSupabaseServerUrl(env);
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!supabaseServerUrl || !serviceRoleKey) {
    throw new ProductionDatabaseGateError();
  }
  return createClient(supabaseServerUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: createPostgrestRootFetch(supabaseServerUrl),
    },
  });
}

export function assertProductionDatabaseGate(
  _capability: ProductionDatabaseCapability,
  env: DatabaseGateEnvironment = process.env as DatabaseGateEnvironment,
): void {
  if (!inspectProductionDatabaseGate(env).ready) {
    throw new ProductionDatabaseGateError();
  }
}

export interface DatabaseGateRpcClient {
  rpc(
    name: string,
  ): PromiseLike<{ data: unknown; error: { message?: string } | null }>;
}

let verifiedDatabaseGate = false;

export async function assertProductionDatabaseGateReady(
  capability: ProductionDatabaseCapability,
  client?: DatabaseGateRpcClient,
  env: DatabaseGateEnvironment = process.env as DatabaseGateEnvironment,
): Promise<void> {
  assertProductionDatabaseGate(capability, env);
  if (verifiedDatabaseGate && !client) return;
  const rpcClient = client ?? createProductionSupabaseServiceClient();
  const result = await rpcClient.rpc("aistory_database_gate_status");
  if (
    result.error
    || result.data !== PRODUCTION_IDENTITY_DB_GATE_VERSION
  ) {
    throw new ProductionDatabaseGateError();
  }
  const posture = await rpcClient.rpc("aistory_database_security_posture");
  if (posture.error || posture.data !== true) {
    throw new ProductionDatabaseGateError();
  }
  const adminPosture = await rpcClient.rpc(
    "aistory_admin_rpc_security_posture",
  );
  if (adminPosture.error || adminPosture.data !== true) {
    throw new ProductionDatabaseGateError();
  }
  const phoneAdminPosture = await rpcClient.rpc(
    "aistory_phone_admin_security_posture",
  );
  if (phoneAdminPosture.error || phoneAdminPosture.data !== true) {
    throw new ProductionDatabaseGateError();
  }
  const hostedCredentialPosture = await rpcClient.rpc(
    "aistory_hosted_byok_security_posture",
  );
  if (
    hostedCredentialPosture.error
    || hostedCredentialPosture.data !== true
  ) {
    throw new ProductionDatabaseGateError();
  }
  const videoAssetPosture = await rpcClient.rpc(
    "aistory_video_asset_security_posture",
  );
  if (videoAssetPosture.error || videoAssetPosture.data !== true) {
    throw new ProductionDatabaseGateError();
  }
  if (!client) verifiedDatabaseGate = true;
}
