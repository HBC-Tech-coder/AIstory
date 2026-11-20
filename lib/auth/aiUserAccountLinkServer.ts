import "server-only";
import { createHash } from "node:crypto";
import { loadAiUserBusinessRuntime } from "./aiUserOidcCallbackServer";
import { verifyUserSessionToken, USER_SESSION_COOKIE } from "./userSession";
import { phoneRegistrationSessionBindingIsCurrent } from "./phoneInviteBetaGate";
import { getProductionPhoneIdentityRepository } from "./phoneIdentityRepository";
import { productionAiUserAccountLinkRepository } from "./aiUserAccountLinkRepository";
import { createAiUserAccountLinkService, sameAiUserLinkProofs } from "./aiUserAccountLinkService";
import { decideAiUserAccountLink, type AiUserProof, type PhoneProof } from "./aiUserAccountLinkPolicy";
import type { AiUserBusinessSession } from "./aiUserProductSession";
import { AIUSER_LINK_ENV, AIUSER_LINK_MODE, aiUserAccountLinkSelected } from "./aiUserAccountLinkConfig";

export { AIUSER_LINK_ENV, AIUSER_LINK_MODE };
function projection(session: AiUserBusinessSession): AiUserProof | null {
  if (session.idpAuthenticatedAt === null) return null;
  return { principalKey: session.principalKey, sessionBinding: session.sessionBinding,
    authenticatedAt: session.idpAuthenticatedAt, expiresAt: session.expiresAt, membershipGeneration: session.membershipGeneration };
}
/** Consumes an existing signed production OTP session. Never requests OTP, registers, claims or grants. */
export async function readAiUserLinkPhoneProof(request: Request): Promise<PhoneProof | null> {
  const raw = request.headers.get("cookie") ?? "";
  const tokens = raw.split(";").map((x) => x.trim()).filter((x) => x.startsWith(`${USER_SESSION_COOKIE}=`));
  if (raw.length > 16384 || tokens.length !== 1) return null;
  const token = tokens[0]!.slice(USER_SESSION_COOKIE.length + 1);
  if (token.length > 4096) return null;
  const session = verifyUserSessionToken(token);
  if (!session || session.version !== 2 || !await phoneRegistrationSessionBindingIsCurrent(
    session.inviteBetaPolicyFingerprint, session.phoneRegistrationPolicy)
    || !await getProductionPhoneIdentityRepository().validateActiveUser(session.userId)) return null;
  return { userId: session.userId, sessionBinding: createHash("sha256").update(`aistory.aiuser.phone-proof.v1\0${token}`).digest("hex"),
    authenticatedAt: session.issuedAt, expiresAt: session.expiresAt, active: true };
}
let minute = -1;
const mutationCounts = new Map<string, number>();
function allowMutation(principalKey: string) {
  const next = Math.floor(Date.now() / 60000);
  if (next !== minute) { minute = next; mutationCounts.clear(); }
  const count = (mutationCounts.get(principalKey) ?? 0) + 1;
  mutationCounts.set(principalKey, count);
  return count <= 30;
}
export async function isAiUserAccountLinkAvailable(request: Request): Promise<boolean> {
  try {
    if (!aiUserAccountLinkSelected()) return false;
    const runtime = await loadAiUserBusinessRuntime(); if (!runtime) return false;
    const session = await runtime.read(request); if (!session) return false;
    const aiuser = projection(session); if (!aiuser) return false;
    const phone = await readAiUserLinkPhoneProof(request); if (!phone) return false;
    const now = Date.now();
    const decision = decideAiUserAccountLink({ schema: "aistory.aiuser-account-link-proof.v1",
      confirmation: { confirmLink: true }, aiuser, phone,
      intent: { id: "0".repeat(64), principalKey: aiuser.principalKey, phoneUserId: phone.userId,
        aiuserSessionBinding: aiuser.sessionBinding, phoneSessionBinding: phone.sessionBinding,
        createdAt: now, expiresAt: now + 60000, consumed: false },
      existingByAiuser: null, existingByPhone: null }, now);
    if (!decision.ok) return false;
    await productionAiUserAccountLinkRepository().assertReady();
    const currentSession = await runtime.read(request); if (!currentSession) return false;
    const currentAiuser = projection(currentSession); if (!currentAiuser) return false;
    const currentPhone = await readAiUserLinkPhoneProof(request); if (!currentPhone) return false;
    if (!sameAiUserLinkProofs({ aiuser, phone }, { aiuser: currentAiuser, phone: currentPhone })) return false;
    const currentNow = Date.now();
    if (!decideAiUserAccountLink({ schema: "aistory.aiuser-account-link-proof.v1",
      confirmation: { confirmLink: true }, aiuser: currentAiuser, phone: currentPhone,
      intent: { id: "0".repeat(64), principalKey: currentAiuser.principalKey, phoneUserId: currentPhone.userId,
        aiuserSessionBinding: currentAiuser.sessionBinding, phoneSessionBinding: currentPhone.sessionBinding,
        createdAt: currentNow, expiresAt: currentNow + 60000, consumed: false },
      existingByAiuser: null, existingByPhone: null }, currentNow).ok) return false;
    return true;
  } catch { return false; }
}
export async function handleAiUserAccountLink(request: Request): Promise<Response> {
  try {
    if (!aiUserAccountLinkSelected()) throw Error("disabled");
    const runtime = await loadAiUserBusinessRuntime(); if (!runtime) throw Error("disabled");
    const readAiuser = async (input: Request) => { const session = await runtime.read(input); return session ? projection(session) : null; };
    return await createAiUserAccountLinkService({ now: Date.now, allowMutation,
      readProofs: async (input) => {
        const aiuser = await readAiuser(input); if (!aiuser) return null;
        const phone = await readAiUserLinkPhoneProof(input); return phone ? { aiuser, phone } : null;
      }, intents: runtime.linkIntents, assertOrigin: runtime.assertLinkOrigin,
      repository: productionAiUserAccountLinkRepository(),
    })(request);
  } catch { return Response.json({ ok: false, code: "ACCOUNT_LINK_UNAVAILABLE" },
    { status: 503, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } }); }
}
