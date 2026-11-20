import "server-only";
import { aiUserAccountLinkRevocationSelected } from "./aiUserAccountLinkConfig";
import { productionAiUserAccountLinkRepository } from "./aiUserAccountLinkRepository";
import { readAiUserBusinessSession } from "./aiUserOidcCallbackServer";
import { readAiUserLinkPhoneProof } from "./aiUserAccountLinkServer";
import type { AiUserLinkSessionRevocations } from "./aiUserAccountLinkService";

type AiUserLinkLogoutAiuser = NonNullable<AiUserLinkSessionRevocations["aiuser"]>;
type AiUserLinkLogoutPhone = NonNullable<AiUserLinkSessionRevocations["phone"]>;
export type AiUserAccountLinkLogoutBarrierDependencies = Readonly<{
  revocationSelected(): boolean;
  readAiuser(request: Request): Promise<AiUserLinkLogoutAiuser | null>;
  readPhone(request: Request): Promise<AiUserLinkLogoutPhone | null>;
  revokeSessions(input: AiUserLinkSessionRevocations): Promise<void>;
}>;

/**
 * Durably tombstones both link-session bindings before account logout can be
 * acknowledged. Revocation is intentionally independent of admission so a
 * draining/older enabled worker cannot confirm after a newer worker logs out.
 */
export function createAiUserAccountLinkLogoutBarrier(deps: AiUserAccountLinkLogoutBarrierDependencies) {
  return async function revoke(request: Request): Promise<boolean> {
    if (!deps.revocationSelected()) return true;
    try {
      const [aiuser, phone] = await Promise.all([deps.readAiuser(request), deps.readPhone(request)]);
      if (!aiuser && !phone) return true;
      await deps.revokeSessions({ aiuser, phone });
      return true;
    } catch { return false; }
  };
}

const productionBarrier = createAiUserAccountLinkLogoutBarrier({
  revocationSelected: aiUserAccountLinkRevocationSelected,
  async readAiuser(request) {
    const result = await readAiUserBusinessSession(request);
    return result.state === "authenticated" ? {
      principalKey: result.session.principalKey,
      sessionBinding: result.session.sessionBinding,
    } : null;
  },
  async readPhone(request) {
    const phone = await readAiUserLinkPhoneProof(request);
    return phone ? { userId: phone.userId, sessionBinding: phone.sessionBinding } : null;
  },
  async revokeSessions(input) {
    await productionAiUserAccountLinkRepository().revokeSessions(input);
  },
});

export async function revokeAiUserAccountLinkSessionsForLogout(request: Request): Promise<boolean> {
  return productionBarrier(request);
}
