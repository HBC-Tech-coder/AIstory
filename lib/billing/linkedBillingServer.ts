import "server-only";

import { aiUserLinkedBillingSelected } from "@/lib/auth/aiUserLinkedBillingConfig";
import { productionAiUserLinkedBillingRepository,
  toAiUserLinkedBillingPhoneUserId } from "@/lib/auth/aiUserLinkedBillingRepository";
import { readAiUserBusinessSession } from "@/lib/auth/aiUserOidcCallbackServer";
import type { AiUserBusinessSession } from "@/lib/auth/aiUserProductSession";
import { resolveAiUserBillingIdentity } from "./linkedBillingIdentity";

/** Keeps the AIUser product identity intact while resolving a server-private debit account. */
export async function resolveLinkedPhoneForBilling(aiuser: AiUserBusinessSession | undefined) {
  const result = await resolveAiUserBillingIdentity(aiuser, {
    selected: () => aiUserLinkedBillingSelected()
      && process.env.AISTORY_PLATFORM_BILLING_ENABLED === "true",
    now: Date.now,
    async readSession() {
      const current = await readAiUserBusinessSession();
      return current.state === "authenticated" ? current.session : null;
    },
    async resolvePhoneUserId(principalKey) {
      const repository = await productionAiUserLinkedBillingRepository();
      return repository.resolvePhoneUserId(principalKey);
    },
  });
  return result.state === "linked"
    ? { state: "linked" as const, phoneUserId: toAiUserLinkedBillingPhoneUserId(result.phoneUserId) }
    : result;
}
