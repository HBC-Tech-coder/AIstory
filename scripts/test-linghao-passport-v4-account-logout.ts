import assert from "node:assert/strict";
import { createAccountLogoutRouteHandler } from "../lib/auth/accountLogoutRoute";
import { LINGHAO_PASSPORT_V4_PRODUCT_SESSION_COOKIE } from "../lib/auth/linghaoPassportV4ProductionCookies";
import { prepareGenerationBilling } from "../lib/billing/generationGate";
import { createRequireUser } from "../lib/supabase/guard";
import type { LinghaoPassportV4ProductSession } from "../lib/auth/linghaoPassportV4ProductionSession";

const url = "https://play.hibcglobal.com/api/account/me";
const passportCookie = `${LINGHAO_PASSPORT_V4_PRODUCT_SESSION_COOKIE}=${"p".repeat(43)}`;
let passportCalls = 0;
let legacyLinkCalls = 0;
let legacyBusinessCalls = 0;

const success = createAccountLogoutRouteHandler({
  logoutPassportSession: async (request, response) => {
    assert.equal(request.headers.get("cookie"), passportCookie);
    passportCalls += 1;
    response.headers.append(
      "Set-Cookie",
      `${LINGHAO_PASSPORT_V4_PRODUCT_SESSION_COOKIE}=; Path=/; Max-Age=0`,
    );
    return true;
  },
  revokeLinkSessions: async () => { legacyLinkCalls += 1; return true; },
  logoutBusinessSession: async () => { legacyBusinessCalls += 1; return true; },
});
const successfulResponse = await success(new Request(url, {
  method: "DELETE",
  headers: { cookie: passportCookie },
}));
assert.equal(successfulResponse.status, 200);
assert.equal(passportCalls, 1);
assert.equal(legacyLinkCalls, 0);
assert.equal(legacyBusinessCalls, 0);
assert.equal(successfulResponse.headers.getSetCookie().length, 1);

const failure = createAccountLogoutRouteHandler({
  logoutPassportSession: async () => false,
  revokeLinkSessions: async () => { legacyLinkCalls += 1; return true; },
  logoutBusinessSession: async () => { legacyBusinessCalls += 1; return true; },
});
const failedResponse = await failure(new Request(url, {
  method: "DELETE",
  headers: { cookie: passportCookie },
}));
assert.equal(failedResponse.status, 503);
assert.deepEqual(await failedResponse.json(), {
  ok: false,
  code: "ACCOUNT_LOGOUT_UNAVAILABLE",
});
assert.equal(failedResponse.headers.getSetCookie().length, 0);
assert.equal(legacyLinkCalls, 0);
assert.equal(legacyBusinessCalls, 0);

let absentPassportCalls = 0;
const legacy = createAccountLogoutRouteHandler({
  logoutPassportSession: async () => { absentPassportCalls += 1; return true; },
  revokeLinkSessions: async () => { legacyLinkCalls += 1; return true; },
  logoutBusinessSession: async () => { legacyBusinessCalls += 1; return true; },
});
const legacyResponse = await legacy(new Request(url, { method: "DELETE" }));
assert.equal(legacyResponse.status, 200);
assert.equal(absentPassportCalls, 0);
assert.equal(legacyLinkCalls, 1);
assert.equal(legacyBusinessCalls, 1);

const platformDenied = await prepareGenerationBilling({
  request: new Request("https://play.hibcglobal.com/api/scene", { method: "POST" }),
  auth: {
    userId: `passport_v4:${"a".repeat(64)}`,
    authType: "passport_v4",
  },
  requestedMode: "platform_managed",
  hasByok: false,
  operation: "scene",
});
assert.ok(platformDenied instanceof Response);
assert.equal(platformDenied.status, 403);
assert.equal((await platformDenied.json()).code, "PLATFORM_MANAGED_FORBIDDEN");

const calls: string[] = [];
const passportSession: LinghaoPassportV4ProductSession = {
  authType: "passport_v4",
  userId: `passport_v4:${"a".repeat(64)}`,
  principalKey: "a".repeat(64),
  sessionBinding: "b".repeat(64),
  accountNamespace: "passport_v4_new_v1",
  authenticatedAtMs: Date.now() - 1_000,
  expiresAtMs: Date.now() + 60_000,
};
const authenticatedPassportGuard = createRequireUser({
  authEnabled: true,
  readPassportSession: async () => {
    calls.push("passport");
    return { state: "authenticated", session: passportSession };
  },
  readAiUserSession: async () => { calls.push("aiuser"); return { state: "absent" }; },
  readPhoneSession: async () => { calls.push("phone"); return undefined; },
  readSupabaseSubject: async () => { calls.push("supabase"); return "legacy-supabase-user"; },
});
assert.deepEqual(await authenticatedPassportGuard(), {
  userId: passportSession.userId,
  authType: "passport_v4",
  passport: passportSession,
});
assert.deepEqual(calls, ["passport"]);

calls.length = 0;
const invalidPassportGuard = createRequireUser({
  authEnabled: true,
  readPassportSession: async () => { calls.push("passport"); return { state: "invalid" }; },
  readAiUserSession: async () => { calls.push("aiuser"); return { state: "absent" }; },
  readPhoneSession: async () => { calls.push("phone"); return undefined; },
  readSupabaseSubject: async () => { calls.push("supabase"); return "legacy-supabase-user"; },
});
const invalidPassportResponse = await invalidPassportGuard();
assert.ok(invalidPassportResponse instanceof Response);
assert.equal(invalidPassportResponse.status, 401);
assert.equal((await invalidPassportResponse.json()).code, "PASSPORT_V4_SESSION_UNAVAILABLE");
assert.deepEqual(calls, ["passport"]);

calls.length = 0;
const legacyResumeGuard = createRequireUser({
  authEnabled: true,
  readPassportSession: async () => { calls.push("passport"); return { state: "absent" }; },
  readAiUserSession: async () => { calls.push("aiuser"); return { state: "absent" }; },
  readPhoneSession: async () => { calls.push("phone"); return undefined; },
  readSupabaseSubject: async () => { calls.push("supabase"); return "legacy-supabase-user"; },
});
assert.deepEqual(await legacyResumeGuard(), {
  userId: "legacy-supabase-user",
  authType: "supabase",
});
assert.deepEqual(calls, ["passport", "aiuser", "phone", "supabase"]);

calls.length = 0;
const authDisabledGuard = createRequireUser({
  authEnabled: false,
  readPassportSession: async () => { calls.push("passport"); return { state: "absent" }; },
  readAiUserSession: async () => { calls.push("aiuser"); return { state: "absent" }; },
  readPhoneSession: async () => { calls.push("phone"); return undefined; },
  readSupabaseSubject: async () => { calls.push("supabase"); return "must-not-run"; },
});
const authDisabledResponse = await authDisabledGuard();
assert.ok(authDisabledResponse instanceof Response);
assert.equal(authDisabledResponse.status, 401);
assert.deepEqual(calls, ["passport", "aiuser", "phone"]);

calls.length = 0;
assert.deepEqual(await authDisabledGuard({ allowAnonymousWhenAuthDisabled: true }), {
  userId: "anonymous",
  authType: "anonymous",
});
assert.deepEqual(calls, ["passport", "aiuser", "phone"]);

console.log("PASS_LINGHAO_PASSPORT_V4_ACCOUNT_LOGOUT_ISOLATION");
console.log(JSON.stringify({
  passportLogoutCalls: passportCalls,
  legacyCallsDuringPassportLogout: 0,
  failureCookieClears: 0,
  legacyRollbackPreserved: true,
  legacySupabaseResumesAfterPassportAbsent: true,
  authDisabledSupabaseCalls: 0,
}));
