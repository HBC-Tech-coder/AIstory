import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin/security";
import {
  buildAdminSnapshot,
  getAdminRepository,
} from "@/lib/admin/service";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const actor = await requireAdmin();
  if (actor instanceof NextResponse) return actor;
  const snapshot = await buildAdminSnapshot(getAdminRepository());
  return NextResponse.json(snapshot, {
    headers: { "Cache-Control": "no-store" },
  });
}
