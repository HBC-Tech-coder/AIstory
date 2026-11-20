import "server-only";

import {
  assertProductionDatabaseGateReady,
  createProductionSupabaseServiceClient,
  ProductionDatabaseGateError,
} from "@/lib/production/databaseGate";
import { ADMIN_ROLES, type AdminRole } from "./types";

type AdminActorProjection = {
  user_id?: unknown;
  tenant_id?: unknown;
  roles?: unknown;
};

function normalizeRoles(value: unknown): AdminRole[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (role): role is AdminRole =>
      typeof role === "string"
      && (ADMIN_ROLES as readonly string[]).includes(role),
  );
}

export async function resolveProductionAdminRoles(
  userId: string,
  tenantId = "platform",
): Promise<AdminRole[] | undefined> {
  await assertProductionDatabaseGateReady("identity");
  const client = createProductionSupabaseServiceClient();
  const result = await client.rpc("aistory_admin_resolve_actor", {
    actor_user_id: userId,
    actor_tenant: tenantId,
  });
  if (result.error) throw new ProductionDatabaseGateError();
  if (!result.data || typeof result.data !== "object") return undefined;
  const projection = result.data as AdminActorProjection;
  if (projection.user_id !== userId || projection.tenant_id !== tenantId) {
    throw new ProductionDatabaseGateError();
  }
  const roles = normalizeRoles(projection.roles);
  return roles.length ? roles : undefined;
}
