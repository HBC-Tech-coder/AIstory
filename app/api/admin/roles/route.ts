import { handleAdminRoleInventoryGet } from "@/lib/admin/roleInventoryHandler";
import { requireAdmin } from "@/lib/admin/security";
import { getAdminRepositoryForActor } from "@/lib/admin/service";

export const runtime = "nodejs";

/**
 * Read-only role inventory endpoint. The Next.js route module may only export
 * the runtime segment config and HTTP methods, so both the projection helper
 * and the injectable handler live in `lib/admin`. This handler always invokes
 * the real default (super-admin-only, non-independent) administrator gate.
 */
export async function GET(): Promise<Response> {
  return handleAdminRoleInventoryGet({
    authorize: () => requireAdmin(["super_admin"]),
    getRepository: (actor) => getAdminRepositoryForActor(actor),
    now: () => new Date().toISOString(),
  });
}
