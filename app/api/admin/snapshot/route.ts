import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin/security";
import {
  buildAdminSnapshot,
  getAdminRepositoryForActor,
} from "@/lib/admin/service";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const actor = await requireAdmin(undefined, { allowIndependent: true });
  if (actor instanceof NextResponse) return actor;
  try {
    const repository = await getAdminRepositoryForActor(actor);
    const snapshot = await buildAdminSnapshot(repository);
    return NextResponse.json(snapshot, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json(
      { error: "管理员数据暂时不可用。" },
      {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
