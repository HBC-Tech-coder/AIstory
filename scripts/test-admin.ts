import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { LocalAdminRepository } from "../lib/admin/localRepository";
import {
  addAdminRole,
  adjustCredits,
  buildAdminSnapshot,
  createUserWithInitialGrant,
  ingestGameplayEvent,
  maskSecretReference,
  publishBrandingVersion,
  saveBrandingDraft,
  saveDomainBinding,
  savePaymentMetadata,
  updateUserStatus,
} from "../lib/admin/service";
import {
  createLocalAdminToken,
  isLoopbackHost,
  verifyLocalAdminToken,
} from "../lib/admin/security";
import type {
  AdminActor,
  GameplayEvent,
  PlatformBranding,
} from "../lib/admin/types";

const directory = await mkdtemp(path.join(os.tmpdir(), "aistory-admin-test-"));
const repository = new LocalAdminRepository(path.join(directory, "store.json"));
const actor: AdminActor = {
  userId: "local-admin",
  roles: ["super_admin"],
  mode: "local",
};

try {
  const empty = await buildAdminSnapshot(repository);
  assert.equal(empty.source, "local_development");
  assert.equal(empty.overview.registeredUsers, 0);
  assert.equal(empty.overview.statisticsEnabled, false);

  const first = await createUserWithInitialGrant(repository, {
    userId: "user-1",
    tenantId: "platform",
    displayName: "测试用户一",
    status: "active",
    userType: "player",
    locale: "zh-CN",
  });
  assert.equal(first.userId, "user-1");
  assert.equal(
    (await repository.listLedger("user-1")).reduce(
      (sum, entry) => sum + entry.amount,
      0,
    ),
    1000,
  );

  const branding: PlatformBranding = {
    projectName: "AIstory Preview",
    shortName: "AIstory",
    primaryColor: "#8A5A2B",
    defaultLocale: "zh-CN",
    defaultInitialCredits: 1500,
  };
  const draft = await saveBrandingDraft(
    repository,
    actor,
    branding,
    "request-brand-preview",
  );
  await publishBrandingVersion(
    repository,
    actor,
    draft.id,
    "测试发布配置",
    "request-brand-publish",
  );
  await createUserWithInitialGrant(repository, {
    userId: "user-2",
    tenantId: "platform",
    displayName: "测试用户二",
    status: "active",
    userType: "player",
  });
  const ledger = await repository.listLedger();
  assert.equal(
    ledger.filter((entry) => entry.userId === "user-1")
      .reduce((sum, entry) => sum + entry.amount, 0),
    1000,
    "changing the default must not alter existing balances",
  );
  assert.equal(
    ledger.filter((entry) => entry.userId === "user-2")
      .reduce((sum, entry) => sum + entry.amount, 0),
    1500,
    "new accounts use the published default",
  );

  await updateUserStatus(repository, actor, {
    userId: "user-2",
    status: "frozen",
    tags: ["support-review"],
    reason: "测试冻结审计",
    requestId: "request-user-freeze",
  });
  assert.equal((await repository.getUser("user-2"))?.status, "frozen");
  await addAdminRole(repository, actor, {
    userId: "user-1",
    tenantId: "platform",
    role: "support",
    reason: "测试角色分配审计",
    requestId: "request-role-add",
  });
  assert.equal((await repository.listRoles("user-1"))[0]?.role, "support");

  const adjustment = {
    userId: "user-1",
    amount: 75,
    reason: "本地并发幂等测试",
    idempotencyKey: "manual:test:user-1:001",
    requestId: "request-credit-1",
  };
  const adjustedFirst = await adjustCredits(repository, actor, adjustment);
  const adjustedAgain = await adjustCredits(repository, actor, {
    ...adjustment,
    requestId: "request-credit-2",
  });
  assert.equal(adjustedAgain.id, adjustedFirst.id);
  assert.equal(
    (await repository.listLedger("user-1"))
      .filter((entry) => entry.kind === "manual_adjustment").length,
    1,
  );

  await savePaymentMetadata(repository, actor, {
    id: "payment-stripe",
    tenantId: "platform",
    provider: "stripe",
    enabled: false,
    sandbox: true,
    status: "unconfigured",
    secretReference: "env:STRIPE_SECRET_KEY",
    webhookPath: "/api/webhooks/stripe",
    updatedAt: new Date().toISOString(),
  }, "测试配置元数据", "request-payment-1");
  const paymentSnapshot = await buildAdminSnapshot(repository);
  assert.equal(
    paymentSnapshot.paymentConfigs[0]?.secretReference,
    "env:STR••••",
  );
  assert.equal(maskSecretReference("secret:PAYMENTS/STRIPE"), "secret:PAY••••");
  assert.doesNotMatch(JSON.stringify(paymentSnapshot), /STRIPE_SECRET_KEY/);

  const domain = await saveDomainBinding(repository, actor, {
    id: "domain-local",
    tenantId: "platform",
    domain: "admin.example.com",
    purpose: "canonical",
  }, "仅记录待验证域名", "request-domain-1");
  assert.equal(domain.infrastructureApplied, false);
  assert.equal(domain.verificationStatus, "pending");

  const baseEvent: Omit<GameplayEvent, "id" | "event" | "createdAt"> = {
    tenantId: "platform",
    channelId: "web",
    userId: "user-1",
    sessionId: "session-1",
    storyId: "story-1",
    branchId: "branch-main",
    device: "desktop",
  };
  for (const event of [
    { event: "play_started" as const },
    {
      event: "generation_requested" as const,
      provider: "bailian",
      modality: "text" as const,
      estimatedCost: 0.01,
      cacheHit: false,
    },
    {
      event: "cache_hit" as const,
      provider: "bailian",
      modality: "image" as const,
      cacheHit: true,
    },
    { event: "choice_selected" as const, choiceId: "choice-a" },
    { event: "rate_limited" as const, errorCode: "429" },
  ]) {
    await ingestGameplayEvent(repository, {
      ...baseEvent,
      ...event,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    });
  }
  const overview = await repository.aggregateOverview();
  assert.equal(overview.playSessions, 1);
  assert.equal(overview.choiceSelections, 1);
  assert.equal(overview.generationCalls, 1);
  assert.equal(overview.cacheHitRate, 0.5);
  assert.equal(overview.rateLimited, 1);
  assert.equal(overview.estimatedProviderCost, 0.01);
  assert.equal(overview.statisticsEnabled, true);

  assert.equal(await repository.markBootstrapUsed(actor), true);
  assert.equal(await repository.markBootstrapUsed(actor), false);
  assert.ok((await repository.listAudit()).length >= 5);

  process.env.AISTORY_LOCAL_ADMIN_ENABLED = "true";
  process.env.AISTORY_LOCAL_ADMIN_SECRET = "test-only-random-secret-123456789";
  assert.equal(isLoopbackHost("localhost:4200"), true);
  assert.equal(isLoopbackHost("127.0.0.1:4200"), true);
  assert.equal(isLoopbackHost("192.168.1.12:4200"), false);
  const token = createLocalAdminToken(1_000_000);
  assert.equal(
    verifyLocalAdminToken(token, "localhost:4200", 1_000_001)?.roles[0],
    "super_admin",
  );
  assert.equal(
    verifyLocalAdminToken(token, "192.168.1.12:4200", 1_000_001),
    undefined,
  );
  assert.equal(
    verifyLocalAdminToken(`${token}tampered`, "localhost:4200", 1_000_001),
    undefined,
  );
  assert.equal(
    verifyLocalAdminToken(
      token,
      "localhost:4200",
      1_000_000 + 4 * 60 * 60 * 1000 + 1,
    ),
    undefined,
  );

  console.log("admin P1 tests passed");
} finally {
  await rm(directory, { recursive: true, force: true });
}
