import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { LocalAdminRepository } from "@/lib/admin/localRepository";
import { createUserWithInitialGrant, saveBillingPolicy } from "@/lib/admin/service";
import { toAiUserLinkedBillingPhoneUserId } from "@/lib/auth/aiUserLinkedBillingRepository";
import { resolveAiUserBillingIdentity } from "@/lib/billing/linkedBillingIdentity";
import { refundPlatformOperation, reservePlatformOperation, settlePlatformOperation } from "@/lib/billing/service";
import { authorizeCredentialAccess } from "@/lib/credentials/serverPolicy";

const root = await mkdtemp(path.join(os.tmpdir(), "aistory-linked-ledger-"));
const phoneUserId = "123e4567-e89b-42d3-a456-426614174000";
const principalKey = "a".repeat(64);
const proof = Object.freeze({ principalKey, sessionBinding: "b".repeat(64), lineage: "c".repeat(64),
  expiresAt: 1000, membershipGeneration: 1 });

try {
  const repository = new LocalAdminRepository(path.join(root, "admin.json"));
  await saveBillingPolicy(repository, { userId: "local-admin", roles: ["super_admin"], mode: "local" }, {
    version: "linked-ledger-fixture-v1", markupBasisPoints: 20_000, initialGrantCredits: 1000,
    providerCurrency: "CNY", providerMinorUnitScale: 2, creditUnitsPerProviderMinor: 1,
    entries: [{ operation: "story.start", modality: "mixed", provider: "fixture",
      model: "fixture-model", providerCostMinor: 123, enabled: true }],
  }, "linked billing fixture", "linked-ledger-policy-1");
  await createUserWithInitialGrant(repository, { userId: phoneUserId, tenantId: "platform",
    displayName: "Verified phone fixture", maskedContact: "+8613******00", status: "active", userType: "player" });
  const initial = await repository.listLedger(phoneUserId);
  assert.equal(initial.filter((entry) => entry.kind === "initial_grant").length, 1);
  assert.equal(initial.reduce((sum, entry) => sum + entry.amount, 0), 1000);

  const resolved = await resolveAiUserBillingIdentity(proof, {
    selected: () => true, now: () => 500, readSession: async () => proof,
    resolvePhoneUserId: async (key) => key === principalKey ? phoneUserId : null,
  });
  assert.equal(resolved.state, "linked");
  if (resolved.state !== "linked") throw Error("LINK_REQUIRED");
  const decision = authorizeCredentialAccess({ requestedMode: "platform_managed", hasByok: false,
    userId: `aiuser:${principalKey}`, authType: "aiuser",
    verifiedLinkedPhoneUserId: toAiUserLinkedBillingPhoneUserId(resolved.phoneUserId),
    env: { AISTORY_PLATFORM_BILLING_ENABLED: "true" } });
  assert.equal(decision.allowed, true);
  if (!decision.allowed || decision.mode !== "platform_managed") throw Error("BILLING_REQUIRED");
  assert.equal(decision.billingUserId, phoneUserId);

  const first = await reservePlatformOperation(repository, { userId: decision.billingUserId,
    operation: "story.start", idempotencyKey: "linked-billing:start:1" });
  assert.equal(first.entry.userId, phoneUserId);
  assert.equal(first.entry.accountId, (await repository.getAccount(phoneUserId, "platform"))?.id);
  assert.equal(first.quote.estimatedCredits, 246);
  const settle = await settlePlatformOperation(repository, first);
  assert.equal(settle.userId, phoneUserId);
  assert.equal(settle.billingOperationId, first.entry.billingOperationId);
  assert.equal((await repository.listLedger(phoneUserId)).reduce((sum, entry) => sum + entry.amount, 0), 754);

  const second = await reservePlatformOperation(repository, { userId: decision.billingUserId,
    operation: "story.start", idempotencyKey: "linked-billing:start:2" });
  const refund = await refundPlatformOperation(repository, second, "fixture generation failed before provider start");
  assert.equal(refund.userId, phoneUserId);
  assert.equal(refund.billingOperationId, second.entry.billingOperationId);
  const final = await repository.listLedger(phoneUserId);
  assert.equal(final.reduce((sum, entry) => sum + entry.amount, 0), 754);
  assert.equal(final.filter((entry) => entry.kind === "initial_grant").length, 1,
    "linking and linked spending must not mint a second grant");
  assert.equal((await repository.listLedger(`aiuser:${principalKey}`)).length, 0);
  console.log("PASS_AIUSER_LINKED_BILLING_LEDGER");
} finally {
  const temp = path.resolve(os.tmpdir()) + path.sep;
  const resolved = path.resolve(root);
  if (!resolved.startsWith(temp) || !path.basename(resolved).startsWith("aistory-linked-ledger-")) {
    throw Error("UNSAFE_TEST_CLEANUP_PATH");
  }
  await rm(resolved, { recursive: true, force: true });
}
