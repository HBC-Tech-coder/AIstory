import { handleLinghaoPassportV4Request } from "@/lib/auth/linghaoPassportV4Boundary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleLinghaoPassportV4Request("draft", request);
}

export async function PUT(request: Request): Promise<Response> {
  return handleLinghaoPassportV4Request("draft", request);
}

