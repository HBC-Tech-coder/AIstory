import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { handleIndependentAdminPasswordChange, INDEPENDENT_ADMIN_PRINCIPAL_PRODUCTION_COOKIE,
  independentAdminPrincipalProductionCookieOptions } from "@/lib/admin/independentPrincipalServer";

export const runtime = "nodejs";
export async function POST(request: Request): Promise<Response> {
  const token = (await cookies()).get(INDEPENDENT_ADMIN_PRINCIPAL_PRODUCTION_COOKIE)?.value;
  const result = await handleIndependentAdminPasswordChange(request, token);
  const response = new NextResponse(result.response.body, { status: result.response.status, headers: result.response.headers });
  if (response.status === 200) response.cookies.set(INDEPENDENT_ADMIN_PRINCIPAL_PRODUCTION_COOKIE, "", {
    ...independentAdminPrincipalProductionCookieOptions(), maxAge: 0,
  });
  return response;
}
