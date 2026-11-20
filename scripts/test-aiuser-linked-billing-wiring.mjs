import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const paths = {
  gate: "lib/billing/generationGate.ts",
  server: "lib/billing/linkedBillingServer.ts",
  policy: "lib/credentials/serverPolicy.ts",
  readiness: "app/api/account/generation-readiness/route.ts",
  account: "app/api/account/me/route.ts",
  publicAccount: "lib/auth/aiUserAccountPublic.ts",
  speculative: "app/api/speculative-branch/route.ts",
  tts: "app/api/tts-provider/route.ts",
};
const files = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, path]) =>
  [key, await readFile(path, "utf8")])));

assert.match(files.server, /aiUserLinkedBillingSelected\(\)/);
assert.match(files.server, /AISTORY_PLATFORM_BILLING_ENABLED === "true"/);
assert.match(files.server, /readAiUserBusinessSession\(\)/);
assert.match(files.server, /productionAiUserLinkedBillingRepository\(\)/);
assert.match(files.gate, /resolveLinkedPhoneForBilling\(input\.auth\.aiuser\)/);
assert.match(files.gate, /verifiedLinkedPhoneUserId,/);
assert.match(files.gate, /userId: decision\.billingUserId/);
assert.doesNotMatch(files.gate, /input\.auth\.authType\s*=\s*"phone"/);
assert.match(files.policy, /verifiedLinkedPhoneUserId\?: AiUserLinkedBillingPhoneUserId/);
assert.match(files.policy, /allowlist\.has\(billingUserId\)/);
assert.match(files.readiness, /resolveLinkedPhoneForBilling\(auth\.aiuser\)/);
assert.match(files.readiness, /linked\.state === "linked" \? \{ kind: "phone", userId: linked\.phoneUserId \}/);
assert.match(files.account, /aiUserPublicAccount\(auth\.aiuser\.expiresAt/);
assert.match(files.account, /balance,\s+platformBilling: process\.env\.AISTORY_PLATFORM_BILLING_ENABLED === "true"/);
assert.match(files.publicAccount, /hostedByok: false, cloudProgress: false, administrator: false/);
assert.match(files.speculative, /resolveLinkedPhoneForBilling\(auth\.aiuser\)/);
assert.match(files.tts, /resolveLinkedPhoneForBilling\(auth\.aiuser\)/);
console.log("PASS_AIUSER_LINKED_BILLING_WIRING");
