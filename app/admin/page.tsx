import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { resolveAdminActor } from "@/lib/admin/security";
import { INDEPENDENT_ADMIN_PRINCIPAL_PRODUCTION_COOKIE, independentAdminNavigationState } from "@/lib/admin/independentPrincipalServer";
import {
  buildAdminSnapshot,
  getAdminRepositoryForActor,
} from "@/lib/admin/service";
import { AdminConsole } from "./AdminConsole";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "超级管理员控制台 · AIstory",
  robots: { index: false, follow: false },
};

export default async function AdminPage() {
  if (await independentAdminNavigationState((await cookies()).get(INDEPENDENT_ADMIN_PRINCIPAL_PRODUCTION_COOKIE)?.value)
    === "password_change_required") redirect("/admin/password-change");
  const actor = await resolveAdminActor();
  if (!actor) {
    const hadIndependentSession = (await cookies()).has(
      INDEPENDENT_ADMIN_PRINCIPAL_PRODUCTION_COOKIE,
    );
    redirect(
      hadIndependentSession
        ? "/admin/login?state=session-ended"
        : "/admin/login",
    );
  }
  const repository = await getAdminRepositoryForActor(actor);
  const snapshot = await buildAdminSnapshot(repository);
  return (
    <AdminConsole
      initialSnapshot={snapshot}
      actor={{ roles: actor.roles, mode: actor.mode }}
    />
  );
}
