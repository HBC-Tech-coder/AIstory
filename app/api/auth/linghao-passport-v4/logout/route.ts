import { handleLinghaoPassportV4Request } from "@/lib/auth/linghaoPassportV4Boundary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handleLinghaoPassportV4Request("logout", request);
}

