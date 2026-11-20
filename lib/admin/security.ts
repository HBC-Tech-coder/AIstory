import "server-only";

import {
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";
import { AUTH_ENABLED } from "@/lib/supabase/config";
import { createClient } from "@/lib/supabase/server";
import { ProductionDatabaseGateError } from "@/lib/production/databaseGate";
import { isLoopbackHost } from "@/lib/security/host";
import { LINGHAO_PASSPORT_V4_PRODUCT_SESSION_COOKIE } from "@/lib/auth/linghaoPassportV4ProductionCookies";
import { resolveProductionAdminRoles } from "./productionIdentity";
import {
  hasIndependentAdminPrincipalModeValue,
  INDEPENDENT_ADMIN_PRINCIPAL_PRODUCTION_COOKIE,
  IndependentAdminPrincipalServerError,
  isIndependentAdminPrincipalProductionModeSelected,
  resolveIndependentAdminPrincipalAuthorizedContext,
} from "./independentPrincipalServer";
import { ADMIN_ROLES, type AdminActor, type AdminRole } from "./types";

export const LOCAL_ADMIN_COOKIE = "aistory_local_admin";
const LOCAL_SESSION_SECONDS = 60 * 60 * 4;

function localAdminSecret(): string | undefined {
  const secret = process.env.AISTORY_LOCAL_ADMIN_SECRET?.trim();
  return secret && secret.length >= 24 ? secret : undefined;
}

export { isLoopbackHost } from "@/lib/security/host";

export function isLocalAdminEnabled(): boolean {
  return process.env.AISTORY_LOCAL_ADMIN_ENABLED === "true"
    && !!localAdminSecret();
}

function signature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function createLocalAdminToken(now = Date.now()): string {
  const secret = localAdminSecret();
  if (!isLocalAdminEnabled() || !secret) {
    throw new Error("Local admin mode is not configured");
  }
  const payload = Buffer.from(JSON.stringify({
    sub: "local-admin",
    roles: ["super_admin"],
    exp: Math.floor(now / 1000) + LOCAL_SESSION_SECONDS,
    nonce: randomUUID(),
  })).toString("base64url");
  return `${payload}.${signature(payload, secret)}`;
}

export function verifyLocalAdminToken(
  token: string | undefined,
  host: string | null,
  now = Date.now(),
): AdminActor | undefined {
  const secret = localAdminSecret();
  if (!token || !secret || !isLocalAdminEnabled() || !isLoopbackHost(host)) {
    return undefined;
  }
  const [payload, supplied] = token.split(".");
  if (!payload || !supplied) return undefined;
  const expected = signature(payload, secret);
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return undefined;
  try {
    const parsed = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as { sub?: string; roles?: string[]; exp?: number };
    if (
      parsed.sub !== "local-admin"
      || !parsed.roles?.includes("super_admin")
      || !parsed.exp
      || parsed.exp <= Math.floor(now / 1000)
    ) return undefined;
    return {
      userId: parsed.sub,
      roles: ["super_admin"],
      mode: "local",
    };
  } catch {
    return undefined;
  }
}

export function localSecretMatches(candidate: string): boolean {
  const secret = localAdminSecret();
  if (!secret || !isLocalAdminEnabled()) return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(secret);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function resolveAdminActor(): Promise<AdminActor | undefined> {
  const headerStore = await headers();
  const cookieStore = await cookies();
  if (isIndependentAdminPrincipalProductionModeSelected()) {
    const independentToken = cookieStore.get(
      INDEPENDENT_ADMIN_PRINCIPAL_PRODUCTION_COOKIE,
    )?.value;
    if (!independentToken) return undefined;
    return (
      await resolveIndependentAdminPrincipalAuthorizedContext(independentToken)
    )?.actor;
  }
  // Any non-empty unknown/local-fake principal mode blocks legacy fallback.
  // P0.4 local_fake_only is evidence, not a production authentication mode.
  if (hasIndependentAdminPrincipalModeValue()) return undefined;

  const local = verifyLocalAdminToken(
    cookieStore.get(LOCAL_ADMIN_COOKIE)?.value,
    headerStore.get("host"),
  );
  if (local) return local;

  // A Passport product cookie, including a stale or malformed one, owns the
  // browser identity boundary. It can never fall through to legacy Supabase
  // administrator identity; explicit Passport logout restores rollback.
  if (cookieStore.get(LINGHAO_PASSPORT_V4_PRODUCT_SESSION_COOKIE)) return undefined;

  // AUTH_ENABLED=false must never imply administrator access.
  if (!AUTH_ENABLED) return undefined;
  const supabase = await createClient();
  const claims = await supabase.auth.getClaims();
  const userId = claims.data?.claims?.sub;
  if (claims.error || typeof userId !== "string") return undefined;
  const roles = await resolveProductionAdminRoles(userId);
  if (!roles?.length) return undefined;
  return { userId, roles, mode: "production" };
}

export function requireAdmin(
  allowedRoles?: AdminRole[],
  options?: Readonly<{ allowIndependent?: false | undefined }>,
): Promise<(
  AdminActor & { mode: "local" | "production" }
) | NextResponse>;
export function requireAdmin(
  allowedRoles: AdminRole[] | undefined,
  options: Readonly<{ allowIndependent: true }>,
): Promise<AdminActor | NextResponse>;
export async function requireAdmin(
  allowedRoles: AdminRole[] = [...ADMIN_ROLES],
  options?: Readonly<{ allowIndependent?: boolean }>,
): Promise<AdminActor | NextResponse> {
  let actor: AdminActor | undefined;
  try {
    actor = await resolveAdminActor();
  } catch (error) {
    if (
      error instanceof ProductionDatabaseGateError
      || error instanceof IndependentAdminPrincipalServerError
    ) {
      return NextResponse.json(
        { error: "Administrator repository is unavailable." },
        { status: 503 },
      );
    }
    throw error;
  }
  if (
    !actor
    || (actor.mode === "independent" && !options?.allowIndependent)
    || !actor.roles.some((role) => allowedRoles.includes(role))
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return actor;
}

export function localAdminCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "strict" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: LOCAL_SESSION_SECONDS,
  };
}
