import assert from "node:assert/strict";
import { resolveAiUserBillingIdentity } from "../lib/billing/linkedBillingIdentity.ts";

const phoneUserId = "123e4567-e89b-42d3-a456-426614174000";
const proof = Object.freeze({ principalKey: "a".repeat(64), sessionBinding: "b".repeat(64),
  lineage: "c".repeat(64), expiresAt: 1000, membershipGeneration: 2 });

function deps(overrides = {}) {
  const calls = { read: 0, resolve: 0 };
  return { calls, value: { selected: () => true, now: () => 500,
    readSession: async () => { calls.read++; return proof; },
    resolvePhoneUserId: async () => { calls.resolve++; return phoneUserId; }, ...overrides } };
}

const disabled = deps({ selected: () => false });
assert.deepEqual(await resolveAiUserBillingIdentity(proof, disabled.value), { state: "disabled" });
assert.deepEqual(disabled.calls, { read: 0, resolve: 0 });

const linked = deps();
assert.deepEqual(await resolveAiUserBillingIdentity(proof, linked.value), { state: "linked", phoneUserId });
assert.deepEqual(linked.calls, { read: 2, resolve: 1 });

const unlinked = deps({ resolvePhoneUserId: async () => null });
assert.deepEqual(await resolveAiUserBillingIdentity(proof, unlinked.value), { state: "unlinked" });

const changed = deps({ readSession: async () => ({ ...proof, sessionBinding: "d".repeat(64) }) });
await assert.rejects(resolveAiUserBillingIdentity(proof, changed.value), /LINKED_BILLING_UNAVAILABLE/);
assert.equal(changed.calls.resolve, 0);

let reads = 0;
const revokedAfterLookup = deps({ readSession: async () => ++reads === 1 ? proof : null });
await assert.rejects(resolveAiUserBillingIdentity(proof, revokedAfterLookup.value), /LINKED_BILLING_UNAVAILABLE/);
assert.equal(revokedAfterLookup.calls.resolve, 1);

const malformedFreshSession = deps({ readSession: async () => undefined });
await assert.rejects(
  resolveAiUserBillingIdentity(proof, malformedFreshSession.value),
  (error) => error instanceof Error
    && !(error instanceof TypeError)
    && error.message === "LINKED_BILLING_UNAVAILABLE",
);
assert.equal(malformedFreshSession.calls.resolve, 0);

const expired = deps({ now: () => 1000 });
await assert.rejects(resolveAiUserBillingIdentity(proof, expired.value), /LINKED_BILLING_UNAVAILABLE/);
assert.equal(expired.calls.resolve, 0);

const malformed = deps({ resolvePhoneUserId: async () => "phone_user" });
await assert.rejects(resolveAiUserBillingIdentity(proof, malformed.value), /LINKED_BILLING_UNAVAILABLE/);

const unavailable = deps({ resolvePhoneUserId: async () => { throw Error("database down"); } });
await assert.rejects(resolveAiUserBillingIdentity(proof, unavailable.value), /database down/);

console.log("PASS_AIUSER_LINKED_BILLING_IDENTITY");
