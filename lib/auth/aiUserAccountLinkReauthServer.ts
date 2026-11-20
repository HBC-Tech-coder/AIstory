import "server-only";

import { aiUserAccountLinkSelected } from "./aiUserAccountLinkConfig";
import { readAiUserLinkPhoneProof } from "./aiUserAccountLinkServer";
import { productionAiUserAccountLinkRepository } from "./aiUserAccountLinkRepository";
import { loadAiUserBusinessRuntime } from "./aiUserOidcCallbackServer";

const PHONE_RECENT_MS = 300_000;
const HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff" } as const;

/** Reauth is useful only while the same browser has both sessions and a recent verified phone proof. */
async function preflight(request: Request) {
  if (!aiUserAccountLinkSelected()) return null;
  const runtime = await loadAiUserBusinessRuntime();
  if (!runtime) return null;
  const [session, phone] = await Promise.all([runtime.read(request), readAiUserLinkPhoneProof(request)]);
  const now = Date.now();
  if (!session || !phone || session.expiresAt <= now || phone.expiresAt <= now
    || phone.authenticatedAt > now || now - phone.authenticatedAt > PHONE_RECENT_MS) return null;
  await productionAiUserAccountLinkRepository().assertReady();
  const [currentSession, currentPhone] = await Promise.all([
    runtime.read(request), readAiUserLinkPhoneProof(request),
  ]);
  const currentNow = Date.now();
  if (!currentSession || !currentPhone || currentSession.expiresAt <= currentNow
    || currentSession.principalKey !== session.principalKey
    || currentSession.sessionBinding !== session.sessionBinding
    || currentPhone.userId !== phone.userId
    || currentPhone.sessionBinding !== phone.sessionBinding
    || currentPhone.authenticatedAt > currentNow
    || currentNow - currentPhone.authenticatedAt > PHONE_RECENT_MS
    || currentPhone.expiresAt <= currentNow) return null;
  return runtime;
}

export async function isAiUserAccountLinkReauthAvailable(request: Request): Promise<boolean> {
  try { return !!await preflight(request); }
  catch { return false; }
}

export async function handleAiUserAccountLinkReauthStart(request: Request): Promise<Response> {
  try {
    if (!aiUserAccountLinkSelected()) throw Error("disabled");
    const runtime = await loadAiUserBusinessRuntime();
    if (!runtime) throw Error("disabled");
    runtime.assertLinkReauthOrigin(request);
    const ready = await preflight(request);
    if (!ready) throw Error("unavailable");
    // The core start accepts exactly `{}` and binds this fixed purpose into its
    // encrypted transaction. The ordinary login start remains unchanged.
    return await ready.startLinkReauth(request);
  } catch {
    return Response.json({ ok: false, code: "AIUSER_LINK_REAUTH_UNAVAILABLE" },
      { status: 503, headers: HEADERS });
  }
}
