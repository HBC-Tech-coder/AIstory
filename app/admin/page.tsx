import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { resolveAdminActor } from "@/lib/admin/security";
import {
  buildAdminSnapshot,
  getAdminRepository,
} from "@/lib/admin/service";
import { AdminConsole } from "./AdminConsole";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "超级管理员控制台 · AIstory",
  robots: { index: false, follow: false },
};

export default async function AdminPage() {
  const actor = await resolveAdminActor();
  if (!actor) redirect("/admin/login");
  const snapshot = await buildAdminSnapshot(getAdminRepository());
  return <AdminConsole initialSnapshot={snapshot} actor={actor} />;
}
