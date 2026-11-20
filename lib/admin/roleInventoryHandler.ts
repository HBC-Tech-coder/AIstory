import { NextResponse } from "next/server";
import type { AdminRepository } from "./repositories";
import { projectAdminRoleInventory } from "./roleInventory";
import type { AdminActor } from "./types";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;
const ROLE_INVENTORY_UNAVAILABLE = "管理员角色数据暂时不可用。";

type AdminRoleInventoryRepository = Pick<
  AdminRepository,
  "listRoles" | "listUsers"
>;

export type AdminRoleInventoryRouteDeps = Readonly<{
  authorize: () => Promise<AdminActor | NextResponse>;
  getRepository: (
    actor: AdminActor,
  ) => Promise<AdminRoleInventoryRepository>;
  now: () => string;
}>;

function unavailableResponse(): NextResponse {
  return NextResponse.json(
    { error: ROLE_INVENTORY_UNAVAILABLE },
    { status: 503, headers: NO_STORE_HEADERS },
  );
}

/**
 * Authorization runs before the repository is loaded so an unauthorized actor
 * can never cause a control-plane read. The handler takes the concrete
 * dependencies from its caller: the GET route always passes the real
 * super-admin-only, non-independent administrator gate, while focused tests
 * inject fakes.
 */
export async function handleAdminRoleInventoryGet(
  deps: AdminRoleInventoryRouteDeps,
): Promise<Response> {
  let actor: AdminActor | NextResponse;
  try {
    actor = await deps.authorize();
  } catch {
    return unavailableResponse();
  }
  if (actor instanceof NextResponse) {
    actor.headers.set("Cache-Control", "no-store");
    return actor;
  }

  try {
    const repository = await deps.getRepository(actor);
    const [roleRecords, users] = await Promise.all([
      repository.listRoles(),
      repository.listUsers(),
    ]);
    return NextResponse.json(
      projectAdminRoleInventory(roleRecords, users, deps.now()),
      { headers: NO_STORE_HEADERS },
    );
  } catch {
    return unavailableResponse();
  }
}
