export const AIUSER_LINKED_BILLING_ENV = "AISTORY_AIUSER_LINKED_BILLING_MODE";
export const AIUSER_LINKED_BILLING_MODE = "aistory-aiuser-linked-billing-v1:enabled";

/**
 * Exact, default-off billing selector. It is deliberately independent of the
 * account-link admission selector and the sticky link-revocation selector:
 * billing may resolve an already committed mapping while admission is closed,
 * and admitting a new link never enables platform-credit billing.
 *
 * The selector is configuration only. It never proves that the database gate,
 * the link posture or an individual mapping is valid; the server-side
 * repository must still read the uncached database posture and resolver.
 */
export function aiUserLinkedBillingSelected(): boolean {
  return process.env[AIUSER_LINKED_BILLING_ENV] === AIUSER_LINKED_BILLING_MODE;
}
