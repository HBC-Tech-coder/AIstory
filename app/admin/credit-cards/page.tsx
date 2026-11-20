import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AdminCreditCardPanel } from "@/components/AdminCreditCardPanel";
import { resolveAdminActor } from "@/lib/admin/security";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "管理员积分卡 · AIstory",
  robots: { index: false, follow: false },
};

export default async function AdminCreditCardsPage() {
  const actor = await resolveAdminActor();
  if (!actor || actor.mode !== "independent") redirect("/admin/login");
  return <AdminCreditCardPanel />;
}
