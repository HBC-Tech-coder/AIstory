/** Server-side AIUser billing identity check. This module has no cookie, DB or environment access. */
export type AiUserBillingSessionProof = Readonly<{
  principalKey: string;
  sessionBinding: string;
  lineage: string;
  expiresAt: number;
  membershipGeneration: number;
}>;

export type AiUserBillingIdentityResult =
  | { state: "disabled" | "unlinked" }
  | { state: "linked"; phoneUserId: string };

export type AiUserBillingIdentityDependencies = Readonly<{
  selected(): boolean;
  now(): number;
  readSession(): Promise<AiUserBillingSessionProof | null>;
  resolvePhoneUserId(principalKey: string): Promise<string | null>;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[a-f0-9]{64}$/;

function isSessionProof(value: unknown): value is AiUserBillingSessionProof {
  return typeof value === "object" && value !== null;
}

function sameLiveSession(
  expected: AiUserBillingSessionProof | null | undefined,
  actual: AiUserBillingSessionProof | null | undefined,
  now: number,
): boolean {
  if (!isSessionProof(expected) || !isSessionProof(actual)) return false;
  return HASH.test(expected.principalKey)
    && HASH.test(expected.sessionBinding)
    && HASH.test(actual.principalKey)
    && HASH.test(actual.sessionBinding)
    && Number.isSafeInteger(expected.expiresAt)
    && expected.expiresAt > now
    && actual.expiresAt === expected.expiresAt
    && actual.principalKey === expected.principalKey
    && actual.sessionBinding === expected.sessionBinding
    && actual.lineage === expected.lineage
    && actual.membershipGeneration === expected.membershipGeneration;
}

/**
 * Resolves only a pre-existing explicit mapping. Never accepts a client-supplied
 * phone ID. Rechecks the product session around the uncached database lookup.
 */
export async function resolveAiUserBillingIdentity(
  expected: AiUserBillingSessionProof | undefined,
  deps: AiUserBillingIdentityDependencies,
): Promise<AiUserBillingIdentityResult> {
  if (!deps.selected()) return { state: "disabled" };
  if (!expected) throw Error("LINKED_BILLING_UNAVAILABLE");
  if (!sameLiveSession(expected, await deps.readSession(), deps.now())) {
    throw Error("LINKED_BILLING_UNAVAILABLE");
  }
  const phoneUserId = await deps.resolvePhoneUserId(expected.principalKey);
  if (phoneUserId !== null && !UUID.test(phoneUserId)) {
    throw Error("LINKED_BILLING_UNAVAILABLE");
  }
  if (!sameLiveSession(expected, await deps.readSession(), deps.now())) {
    throw Error("LINKED_BILLING_UNAVAILABLE");
  }
  return phoneUserId === null
    ? { state: "unlinked" }
    : { state: "linked", phoneUserId };
}
