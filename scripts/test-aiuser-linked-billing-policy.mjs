import assert from "node:assert/strict";
import { authorizeCredentialAccess } from "../lib/credentials/serverPolicy.ts";

const phone = "123e4567-e89b-42d3-a456-426614174000";
const otherPhone = "123e4567-e89b-42d3-a456-426614174001";
const formal = { AISTORY_PLATFORM_BILLING_ENABLED: "true" };
const linkedAiUser = { requestedMode: "platform_managed", hasByok: false,
  userId: `aiuser:${"a".repeat(64)}`, authType: "aiuser" };

const noMapping = authorizeCredentialAccess({ ...linkedAiUser, env: formal });
assert.equal(noMapping.allowed, false);
assert.equal(noMapping.code, "PHONE_VERIFICATION_REQUIRED");

const spoofedUserId = authorizeCredentialAccess({ ...linkedAiUser, userId: phone, env: formal });
assert.equal(spoofedUserId.allowed, false);

for (const invalid of ["", "phone_123", otherPhone.toUpperCase(), "a".repeat(64)]) {
  assert.equal(authorizeCredentialAccess({ ...linkedAiUser, verifiedLinkedPhoneUserId: invalid,
    env: formal }).allowed, false);
}

assert.deepEqual(authorizeCredentialAccess({ ...linkedAiUser, verifiedLinkedPhoneUserId: phone,
  env: formal }), { allowed: true, mode: "platform_managed", billingUserId: phone });

const internal = { AISTORY_PLATFORM_MANAGED_ENABLED: "true", AISTORY_PLATFORM_MANAGED_ALLOWLIST: phone };
assert.equal(authorizeCredentialAccess({ ...linkedAiUser, verifiedLinkedPhoneUserId: phone,
  env: internal }).allowed, true);
assert.equal(authorizeCredentialAccess({ ...linkedAiUser, verifiedLinkedPhoneUserId: otherPhone,
  env: internal }).allowed, false);

assert.deepEqual(authorizeCredentialAccess({ requestedMode: "platform_managed", hasByok: false,
  userId: otherPhone, authType: "phone", verifiedLinkedPhoneUserId: phone, env: formal }),
  { allowed: true, mode: "platform_managed", billingUserId: otherPhone });

assert.deepEqual(authorizeCredentialAccess({ ...linkedAiUser, requestedMode: "user_byok",
  hasByok: true, env: formal }), { allowed: true, mode: "user_byok" });
assert.equal(authorizeCredentialAccess({ ...linkedAiUser, authType: "supabase",
  verifiedLinkedPhoneUserId: phone, env: formal }).allowed, false);

console.log("PASS_AIUSER_LINKED_BILLING_POLICY");
