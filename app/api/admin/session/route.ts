import { NextResponse } from "next/server";
import {
  createLocalAdminToken,
  isLocalAdminEnabled,
  isLoopbackHost,
  LOCAL_ADMIN_COOKIE,
  localAdminCookieOptions,
  localSecretMatches,
  resolveAdminActor,
} from "@/lib/admin/security";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const actor = await resolveAdminActor();
  return NextResponse.json({
    authenticated: !!actor,
    mode: actor?.mode,
    roles: actor?.roles || [],
    localAdminAvailable: isLocalAdminEnabled(),
  });
}

export async function POST(request: Request): Promise<Response> {
  if (!isLoopbackHost(request.headers.get("host")) || !isLocalAdminEnabled()) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  let secret = "";
  try {
    const body = await request.json() as { secret?: unknown };
    secret = typeof body.secret === "string" ? body.secret : "";
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!localSecretMatches(secret)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const response = NextResponse.json({ ok: true, mode: "local" });
  response.cookies.set(
    LOCAL_ADMIN_COOKIE,
    createLocalAdminToken(),
    localAdminCookieOptions(),
  );
  return response;
}

export async function DELETE(): Promise<Response> {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(LOCAL_ADMIN_COOKIE, "", {
    ...localAdminCookieOptions(),
    maxAge: 0,
  });
  return response;
}
