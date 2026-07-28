import "server-only";

import { createClient } from "@supabase/supabase-js";

export const PRODUCTION_IDENTITY_DB_GATE_VERSION = "20260729093000";

export type ProductionDatabaseCapability = "identity" | "sms" | "billing";

type DatabaseGateEnvironment = Partial<Record<
  | "AISTORY_PRODUCTION_IDENTITY_ENABLED"
  | "AISTORY_IDENTITY_REPOSITORY"
  | "AISTORY_ADMIN_REPOSITORY"
  | "AISTORY_DATABASE_GATE_VERSION"
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
  if (!env.NEXT_PUBLIC_SUPABASE_URL?.trim()) {
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
): Promise<void> {
  assertProductionDatabaseGate(capability);
  if (verifiedDatabaseGate && !client) return;
  const rpcClient = client ?? createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!.trim(),
    process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const result = await rpcClient.rpc("aistory_database_gate_status");
  if (
    result.error
    || result.data !== PRODUCTION_IDENTITY_DB_GATE_VERSION
  ) {
    throw new ProductionDatabaseGateError();
  }
  if (!client) verifiedDatabaseGate = true;
}
