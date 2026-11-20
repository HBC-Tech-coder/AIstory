import "server-only";
import { NextResponse } from "next/server";
import { USER_SESSION_COOKIE, userSessionCookieOptions } from "./userSession";
import { logoutAiUserBusinessSession } from "./aiUserOidcCallbackServer";
import { revokeAiUserAccountLinkSessionsForLogout } from "./aiUserAccountLinkLogout";
import { logoutLinghaoPassportV4ProductSession } from "./linghaoPassportV4Boundary";
import { hasLinghaoPassportV4ProductCookieHeader } from "./linghaoPassportV4ProductionCookies";

export type AccountLogoutRouteDependencies = Readonly<{
  revokeLinkSessions(request: Request): Promise<boolean>;
  logoutBusinessSession(request: Request, response: Response): Promise<boolean>;
  logoutPassportSession?(request: Request, response: Response): Promise<boolean>;
}>;

/** Route-level ordering: durable link tombstones precede every apparent logout success. */
export function createAccountLogoutRouteHandler(deps: AccountLogoutRouteDependencies) {
  return async function handle(request: Request): Promise<Response> {
    if (hasLinghaoPassportV4ProductCookieHeader(request.headers.get("cookie"))) {
      const passportResponse = NextResponse.json(
        { ok: true },
        { headers: { "Cache-Control": "no-store" } },
      );
      if (
        !deps.logoutPassportSession ||
        !(await deps.logoutPassportSession(request, passportResponse))
      ) {
        return NextResponse.json(
          { ok: false, code: "ACCOUNT_LOGOUT_UNAVAILABLE" },
          { status: 503, headers: { "Cache-Control": "no-store" } },
        );
      }
      // Passport logout is deliberately isolated. Preserve every legacy phone,
      // AIUser and Supabase cookie so rollback remains available after this
      // browser authority has been durably tombstoned.
      return passportResponse;
    }
    const response = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    // NextResponse.cookies snapshots and rewrites Set-Cookie. Seed the legacy
    // clear before the AIUser helper appends its product/lineage cookie clears.
    response.cookies.set(USER_SESSION_COOKIE, "", {
      ...userSessionCookieOptions(),
      maxAge: 0,
    });
    if (!(await deps.revokeLinkSessions(request))
      || !(await deps.logoutBusinessSession(request, response))) {
      // Return a new response so a failed durable barrier cannot expose any of
      // the optimistic cookie clears already staged on the success response.
      return NextResponse.json({ ok: false, code: "ACCOUNT_LOGOUT_UNAVAILABLE" },
        { status: 503, headers: { "Cache-Control": "no-store" } });
    }
    return response;
  };
}

const productionAccountLogout = createAccountLogoutRouteHandler({
  logoutPassportSession: logoutLinghaoPassportV4ProductSession,
  revokeLinkSessions: revokeAiUserAccountLinkSessionsForLogout,
  logoutBusinessSession: logoutAiUserBusinessSession,
});

export async function handleAccountLogout(request: Request): Promise<Response> {
  return productionAccountLogout(request);
}
