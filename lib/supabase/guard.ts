import { NextResponse } from "next/server";
import { readPhoneRegistrationSession } from "@/lib/auth/userSession";
import { AUTH_ENABLED } from "./config";
import {
  readAiUserBusinessSession,
  type AiUserUserRead,
} from "@/lib/auth/aiUserOidcCallbackServer";
import type { AiUserBusinessSession } from "@/lib/auth/aiUserProductSession";
import { readLinghaoPassportV4ProductSession } from "@/lib/auth/linghaoPassportV4Boundary";
import type {
  LinghaoPassportV4ProductSession,
  LinghaoPassportV4ProductSessionRead,
} from "@/lib/auth/linghaoPassportV4ProductionSession";
import { createClient } from "./server";

type RequireUserOptions = {
  allowAnonymousWhenAuthDisabled?: boolean;
};

export type RequiredUser = {
  userId: string;
  authType: "anonymous" | "phone" | "supabase" | "aiuser" | "passport_v4";
  aiuser?: AiUserBusinessSession;
  passport?: LinghaoPassportV4ProductSession;
};

export type RequireUserDependencies = Readonly<{
  authEnabled: boolean;
  readPassportSession: () => Promise<LinghaoPassportV4ProductSessionRead>;
  readAiUserSession: () => Promise<AiUserUserRead>;
  readPhoneSession: typeof readPhoneRegistrationSession;
  readSupabaseSubject: () => Promise<string | null>;
}>;

export function createRequireUser(dependencies: RequireUserDependencies) {
  return async function requireUserWithDependencies(
    options: RequireUserOptions = {},
  ): Promise<RequiredUser | NextResponse> {
    const passport = await dependencies.readPassportSession();
    if (passport.state === "authenticated") return {
      userId: passport.session.userId,
      authType: "passport_v4",
      passport: passport.session,
    };
    if (passport.state === "invalid") return NextResponse.json(
      { error: "Session expired or unavailable.", code: "PASSPORT_V4_SESSION_UNAVAILABLE" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
    const aiuser = await dependencies.readAiUserSession();
    if (aiuser.state === "authenticated") return {
      userId: `aiuser:${aiuser.session.principalKey}`, authType: "aiuser", aiuser: aiuser.session,
    };
    if (aiuser.state === "invalid") return NextResponse.json(
      { error: "Session expired or unavailable.", code: "AIUSER_SESSION_UNAVAILABLE" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
    const phoneSession = await dependencies.readPhoneSession();
    if (phoneSession) {
      return {
        userId: phoneSession.userId,
        authType: "phone",
      };
    }
    if (options.allowAnonymousWhenAuthDisabled === true && !dependencies.authEnabled) {
      return { userId: "anonymous", authType: "anonymous" };
    }
    if (!dependencies.authEnabled) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const supabaseSubject = await dependencies.readSupabaseSubject();
    if (supabaseSubject) {
      return { userId: supabaseSubject, authType: "supabase" };
    }
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  };
}

const requireUserWithProductionDependencies = createRequireUser({
  authEnabled: AUTH_ENABLED,
  readPassportSession: readLinghaoPassportV4ProductSession,
  readAiUserSession: readAiUserBusinessSession,
  readPhoneSession: readPhoneRegistrationSession,
  readSupabaseSubject: async () => {
    const supabase = await createClient();
    const claims = await supabase.auth.getClaims();
    const subject = claims.data?.claims?.sub;
    return claims.error || typeof subject !== "string" || subject.length === 0
      ? null
      : subject;
  },
});

export async function requireUser(
  options: RequireUserOptions = {},
): Promise<RequiredUser | NextResponse> {
  return requireUserWithProductionDependencies(options);
}

export function rejectUnboundCloudProgressPrincipal(
  auth: RequiredUser,
): NextResponse | undefined {
  if (auth.authType !== "phone" && auth.authType !== "aiuser" && auth.authType !== "passport_v4") return undefined;
  return NextResponse.json(
    {
      error: "Cloud progress is unavailable for this session.",
      code: "CLOUD_PROGRESS_PRINCIPAL_UNAVAILABLE",
    },
    {
      status: 503,
      headers: { "Cache-Control": "private, no-store" },
    },
  );
}
