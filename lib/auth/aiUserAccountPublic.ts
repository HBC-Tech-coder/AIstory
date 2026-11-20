/** Browser-safe projection: never a phone UUID, provider subject, token or ledger entries. */
export type AiUserPublicAccount = {
  authType: "aiuser";
  displayName: "AIUser 用户";
  status: "active";
  expiresAt: number;
  balance: number | null;
  ledger: [];
  /** Mapping has its own authenticated, uncached endpoint; no guessed negative. */
  accountLinked: boolean | null;
  capabilities: {
    platformBilling: boolean;
    hostedByok: false;
    cloudProgress: false;
    administrator: false;
  };
};

export const AIUSER_ACCOUNT_PATH = "/auth/aiuser";

/**
 * A browser may show the linked phone ledger only when every public gate says
 * it is usable. A login, a guessed link, `null`, or a numeric-looking value is
 * never enough on its own.
 */
export function resolveAiUserLinkedBillingBalance(
  account: Pick<
    AiUserPublicAccount,
    "accountLinked" | "balance" | "capabilities"
  >,
): number | null {
  return account.accountLinked === true
    && account.capabilities.platformBilling === true
    && Number.isSafeInteger(account.balance)
    && Number(account.balance) >= 0
    ? Number(account.balance)
    : null;
}

export function aiUserPublicAccount(expiresAt: number, billing?: {
  accountLinked: boolean;
  balance: number | null;
  platformBilling: boolean;
}): AiUserPublicAccount {
  return {
    authType: "aiuser", displayName: "AIUser 用户", status: "active", expiresAt,
    balance: billing?.balance ?? null, ledger: [], accountLinked: billing?.accountLinked ?? null,
    capabilities: { platformBilling: billing?.platformBilling ?? false,
      hostedByok: false, cloudProgress: false, administrator: false },
  };
}
