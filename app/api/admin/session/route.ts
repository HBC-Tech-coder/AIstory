import { NextResponse } from "next/server";

import {
  createLocalAdminToken,
  isLocalAdminEnabled,
  LOCAL_ADMIN_COOKIE,
  localAdminCookieOptions,
  localSecretMatches,
  resolveAdminActor,
} from "@/lib/admin/security";
import {
  handleIndependentAdminPrincipalProductionLogin,
  handleIndependentAdminPrincipalProductionLogout,
  handleIndependentAdminPrincipalProductionMe,
  hasIndependentAdminPrincipalModeValue,
  INDEPENDENT_ADMIN_PRINCIPAL_PRODUCTION_COOKIE,
  independentAdminPrincipalProductionCookieOptions,
  isIndependentAdminPrincipalProductionModeSelected,
} from "@/lib/admin/independentPrincipalServer";
import { isLoopbackHost } from "@/lib/security/host";
import { getAdminRepositoryForActor } from "@/lib/admin/service";

export const runtime = "nodejs";

const MAX_LOCAL_LOGIN_BODY_BYTES = 4096;

function copyResponse(response: Response): NextResponse {
  return new NextResponse(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function noStoreJson(body: Record<string, unknown>, status: number): Response {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function localSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host || !isLoopbackHost(host)) return false;
  try {
    const parsedOrigin = new URL(origin);
    const requestUrl = new URL(request.url);
    return isLoopbackHost(requestUrl.host)
      && (requestUrl.protocol === "http:" || requestUrl.protocol === "https:")
      && parsedOrigin.origin === requestUrl.origin
      && host.trim().toLowerCase() === requestUrl.host.toLowerCase();
  } catch {
    return false;
  }
}

async function parseExactJson(
  request: Request,
  expectedKeys: readonly string[],
  maximumBytes: number,
): Promise<Record<string, unknown> | undefined> {
  if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(
    request.headers.get("content-type")?.trim() ?? "",
  )) return undefined;
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes)) {
    return undefined;
  }
  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw, "utf8") > maximumBytes) return undefined;
    const value = JSON.parse(raw) as unknown;
    if (
      !value
      || typeof value !== "object"
      || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype
    ) return undefined;
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== expectedKeys.length
      || keys.some((key) => {
        if (typeof key !== "string" || !expectedKeys.includes(key)) return true;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return !descriptor
          || !("value" in descriptor)
          || descriptor.get !== undefined
          || descriptor.set !== undefined;
      })
    ) return undefined;
    return value as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function clearIndependentCookie(response: NextResponse): void {
  response.cookies.set(INDEPENDENT_ADMIN_PRINCIPAL_PRODUCTION_COOKIE, "", {
    ...independentAdminPrincipalProductionCookieOptions(),
    maxAge: 0,
  });
}

export async function GET(): Promise<Response> {
  if (isIndependentAdminPrincipalProductionModeSelected()) {
    const { cookies } = await import("next/headers");
    const token = (await cookies()).get(
      INDEPENDENT_ADMIN_PRINCIPAL_PRODUCTION_COOKIE,
    )?.value;
    const result = await handleIndependentAdminPrincipalProductionMe(token);
    const response = copyResponse(result.response);
    if (response.status === 401) {
      clearIndependentCookie(response);
    }
    return response;
  }
  if (hasIndependentAdminPrincipalModeValue()) {
    return noStoreJson(
      { error: "Administrator sign-in is unavailable." },
      503,
    );
  }
  const actor = await resolveAdminActor();
  if (actor) {
    try {
      await getAdminRepositoryForActor(actor);
    } catch {
      return noStoreJson(
        { error: "Administrator repository is unavailable." },
        503,
      );
    }
  }
  return noStoreJson({
    authenticated: !!actor,
    authMode: actor?.mode,
    roles: actor?.roles || [],
    localAdminAvailable: isLocalAdminEnabled(),
  }, 200);
}

export async function POST(request: Request): Promise<Response> {
  if (isIndependentAdminPrincipalProductionModeSelected()) {
    const result = await handleIndependentAdminPrincipalProductionLogin(
      request,
    );
    const response = copyResponse(result.response);
    if (result.sessionToken) {
      response.cookies.set(
        INDEPENDENT_ADMIN_PRINCIPAL_PRODUCTION_COOKIE,
        result.sessionToken,
        independentAdminPrincipalProductionCookieOptions(),
      );
    }
    return response;
  }
  if (hasIndependentAdminPrincipalModeValue()) {
    return noStoreJson(
      { error: "Administrator sign-in is unavailable." },
      503,
    );
  }
  if (!localSameOrigin(request)) {
    return noStoreJson({ error: "Forbidden" }, 403);
  }
  const disabledIndependentBody = await parseExactJson(
    request.clone(),
    ["username", "password"],
    MAX_LOCAL_LOGIN_BODY_BYTES,
  );
  if (disabledIndependentBody) {
    return noStoreJson(
      { error: "Administrator sign-in is unavailable." },
      503,
    );
  }
  if (!isLocalAdminEnabled()) {
    return noStoreJson({ error: "Forbidden" }, 403);
  }
  const body = await parseExactJson(
    request,
    ["secret"],
    MAX_LOCAL_LOGIN_BODY_BYTES,
  );
  const secret = typeof body?.secret === "string" ? body.secret : "";
  if (!body || !localSecretMatches(secret)) {
    return noStoreJson({ error: "Forbidden" }, 403);
  }
  const response = NextResponse.json(
    { ok: true, authMode: "local" },
    { headers: { "Cache-Control": "no-store" } },
  );
  response.cookies.set(
    LOCAL_ADMIN_COOKIE,
    createLocalAdminToken(),
    localAdminCookieOptions(),
  );
  return response;
}

export async function DELETE(request: Request): Promise<Response> {
  if (isIndependentAdminPrincipalProductionModeSelected()) {
    const { cookies } = await import("next/headers");
    const token = (await cookies()).get(
      INDEPENDENT_ADMIN_PRINCIPAL_PRODUCTION_COOKIE,
    )?.value;
    const result = await handleIndependentAdminPrincipalProductionLogout(
      request,
      token,
    );
    const response = copyResponse(result);
    if (response.status === 200) clearIndependentCookie(response);
    return response;
  }
  if (hasIndependentAdminPrincipalModeValue()) {
    const response = copyResponse(noStoreJson(
      { error: "Administrator sign-in is unavailable." },
      503,
    ));
    clearIndependentCookie(response);
    return response;
  }
  if (!localSameOrigin(request)) {
    return noStoreJson({ error: "Forbidden" }, 403);
  }
  const body = await parseExactJson(request, [], 128);
  if (!body) return noStoreJson({ error: "Forbidden" }, 403);
  const response = NextResponse.json(
    { ok: true },
    { headers: { "Cache-Control": "no-store" } },
  );
  response.cookies.set(LOCAL_ADMIN_COOKIE, "", {
    ...localAdminCookieOptions(),
    maxAge: 0,
  });
  return response;
}
