import {
  COMPANY_ACCOUNT_NO_STORE_HEADERS,
  buildCompanyAccountCapabilities,
  buildCompanyAccountErrorDto,
} from "@/lib/company-account/v1/contracts";
import { isLoopbackReadRequest } from "@/lib/security/localMutation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: COMPANY_ACCOUNT_NO_STORE_HEADERS,
  });
}

export async function GET(request: Request): Promise<Response> {
  if (!isLoopbackReadRequest(request)) {
    return json(buildCompanyAccountErrorDto("ORIGIN_NOT_ALLOWED"), 403);
  }
  const url = new URL(request.url);
  if ([...url.searchParams].length > 0) {
    return json(buildCompanyAccountErrorDto("INVALID_REQUEST"), 400);
  }
  return json(buildCompanyAccountCapabilities());
}
