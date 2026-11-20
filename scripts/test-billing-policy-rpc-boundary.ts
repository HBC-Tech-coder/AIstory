import assert from "node:assert/strict";

import type {
  AdminRepository,
  AtomicAdminMutation,
} from "../lib/admin/repositories";
import { saveBillingPolicy } from "../lib/admin/service";
import type {
  AdminActor,
  AdminAuditLog,
  BillingPolicy,
} from "../lib/admin/types";
import {
  buildCostBetaPricingCandidate,
  costBetaPricingFingerprint,
} from "../lib/billing/costBetaPricing";
import type { FixedBetaRuntimeConfig } from "../lib/billing/fixedBetaPricing";
import {
  PLATFORM_CANONICAL_PROVIDER_BINDINGS,
} from "../lib/billing/platformCostEnvelopeServer";

// This is an in-memory contract test. The fake receipts below are not database
// evidence and never represent a real RPC, Supabase project, provider call, or
// network request.
const PLATFORM_TENANT = "platform";
const INJECTED_TENANT = "tenant-untrusted";
const INITIAL_POLICY: BillingPolicy = {
  version: "fake-initial-v0",
  markupBasisPoints: 10_000,
  initialGrantCredits: 1_000,
  providerCurrency: "CNY",
  providerMinorUnitScale: 2,
  creditUnitsPerProviderMinor: 1,
  entries: [],
  updatedAt: new Date(0).toISOString(),
  updatedBy: "fixture",
};

const REQUIRED_ROLES: Record<AtomicAdminMutation["kind"], readonly string[]> = {
  "user.save": ["super_admin", "ops", "moderator", "support"],
  "role.add": ["super_admin"],
  "billing_policy.save": ["super_admin", "finance"],
  "settings.save": ["super_admin", "ops"],
  "payment_config.save": ["super_admin", "finance"],
  "provider_config.save": ["super_admin", "ops"],
  "domain.save": ["super_admin", "ops"],
  "channel_app.save": ["super_admin", "ops"],
};

type FakeReceipt = {
  readonly fake: "in-memory-fake";
  readonly source: "supabase";
  readonly kind: AtomicAdminMutation["kind"];
  readonly payloadTenant: string | null;
  readonly auditTenant: string;
  readonly actorId: string;
  readonly applied: boolean;
};

const fakeReceipts: FakeReceipt[] = [];
let networkCalls = 0;
globalThis.fetch = (async () => {
  networkCalls += 1;
  throw new Error("NETWORK_FORBIDDEN");
}) as typeof fetch;

function makeRuntime(): FixedBetaRuntimeConfig {
  return {
    text: { ...PLATFORM_CANONICAL_PROVIDER_BINDINGS.text },
    image: { ...PLATFORM_CANONICAL_PROVIDER_BINDINGS.image },
    vision: { ...PLATFORM_CANONICAL_PROVIDER_BINDINGS.vision },
    tts: {
      provider: PLATFORM_CANONICAL_PROVIDER_BINDINGS.tts.provider,
      speechModel: PLATFORM_CANONICAL_PROVIDER_BINDINGS.tts.model,
      baseUrl: PLATFORM_CANONICAL_PROVIDER_BINDINGS.tts.baseUrl,
    },
  };
}

function makeV2Candidate() {
  return buildCostBetaPricingCandidate(makeRuntime(), "beta");
}

function policyInput(
  value: unknown,
): Omit<BillingPolicy, "updatedAt" | "updatedBy"> {
  // Fixtures are validated by the service itself; this cast only bridges the
  // readonly candidate type to the caller-facing mutable DTO.
  return value as Omit<BillingPolicy, "updatedAt" | "updatedBy">;
}

function makeLegacyPolicy(): Omit<BillingPolicy, "updatedAt" | "updatedBy"> {
  return {
    version: "tenant-envelope-legacy-v1",
    markupBasisPoints: 10_000,
    initialGrantCredits: 1_000,
    providerCurrency: "CNY",
    providerMinorUnitScale: 2,
    creditUnitsPerProviderMinor: 1,
    entries: [
      {
        operation: "story.start",
        modality: "text",
        provider: "openai_compatible",
        model: "legacy-fixture-model-v1",
        providerCostMinor: 100,
        enabled: true,
        pricingMode: "provider_cost_v1",
      },
    ],
  };
}

function makeActor(
  roles: AdminActor["roles"] = ["super_admin"],
): AdminActor {
  return {
    userId: "fixture-admin-1",
    roles,
    mode: "production",
  };
}

function makeAudit(actor: AdminActor): AdminAuditLog {
  return {
    id: "fixture-audit-1",
    tenantId: PLATFORM_TENANT,
    actorId: actor.userId,
    actorRoles: actor.roles,
    action: "billing.policy_save",
    targetType: "billing_policy",
    targetId: "fixture-target",
    reason: "fixture",
    requestId: "fixture-request",
    createdAt: new Date(0).toISOString(),
  };
}

function asAdminRepository(fake: FakeBillingRepository): AdminRepository {
  return fake as unknown as AdminRepository;
}

class FakeBillingRepository {
  readonly source: "supabase" | "local_development";
  private policy: BillingPolicy;
  readonly receipts: FakeReceipt[] = [];
  mutationCalls = 0;
  getPolicyCalls = 0;
  localSaveCalls = 0;
  appendAuditCalls = 0;
  atomicallyApplied = false;
  failAtomic = false;
  lastMutation: AtomicAdminMutation | undefined;
  lastAudit: AdminAuditLog | undefined;

  constructor(
    source: "supabase" | "local_development",
    policy: BillingPolicy = INITIAL_POLICY,
  ) {
    this.source = source;
    this.policy = policy;
  }

  get currentPolicy(): BillingPolicy {
    return this.policy;
  }

  async getBillingPolicy(): Promise<BillingPolicy> {
    this.getPolicyCalls += 1;
    return this.policy;
  }

  async saveBillingPolicy(policy: BillingPolicy): Promise<void> {
    this.localSaveCalls += 1;
    this.policy = policy;
  }

  async appendAudit(log: AdminAuditLog): Promise<void> {
    this.appendAuditCalls += 1;
    this.lastAudit = log;
  }

  // Mirrors the production SQL wrapper gates that matter for this regression:
  // payload tenant equals audit tenant, then the mutation's required role.
  assertAtomicGate(
    mutation: AtomicAdminMutation,
    audit: AdminAuditLog,
  ): void {
    const payload = mutation.payload as unknown as Record<string, unknown>;
    const payloadTenant = typeof payload.tenantId === "string"
      ? payload.tenantId
      : null;
    if (
      audit.tenantId.length === 0
      || payloadTenant === null
      || payloadTenant !== audit.tenantId
    ) {
      throw new Error("admin mutation tenant mismatch");
    }
    const required = REQUIRED_ROLES[mutation.kind];
    if (
      !required
      || !audit.actorRoles.some((role) => required.includes(role))
    ) {
      throw new Error("admin mutation forbidden");
    }
  }

  async applyAdminMutationAtomically(
    mutation: AtomicAdminMutation,
    audit: AdminAuditLog,
  ): Promise<void> {
    this.mutationCalls += 1;
    this.lastMutation = mutation;
    this.lastAudit = audit;
    this.assertAtomicGate(mutation, audit);
    if (this.failAtomic) {
      throw new Error("fake atomic RPC failure");
    }
    this.atomicallyApplied = true;
    const payload = mutation.payload as unknown as Record<string, unknown>;
    const receipt: FakeReceipt = {
      fake: "in-memory-fake",
      source: "supabase",
      kind: mutation.kind,
      payloadTenant: typeof payload.tenantId === "string"
        ? payload.tenantId
        : null,
      auditTenant: audit.tenantId,
      actorId: audit.actorId,
      applied: true,
    };
    this.receipts.push(receipt);
    fakeReceipts.push(receipt);
  }
}

type Test = readonly [name: string, fn: () => Promise<void> | void];

const tests: Test[] = [
  [
    "pre-fix envelope missing payload.tenantId reproduces the production RPC rejection",
    async () => {
      const candidate = makeV2Candidate();
      const repository = new FakeBillingRepository("supabase");
      const actor = makeActor();
      // Exact pre-fix service envelope: { kind, payload: policy }.
      const unpatchedMutation = {
        kind: "billing_policy.save",
        payload: candidate.policy,
      } as AtomicAdminMutation;

      await assert.rejects(
        repository.applyAdminMutationAtomically(
          unpatchedMutation,
          makeAudit(actor),
        ),
        /admin mutation tenant mismatch/,
      );
      assert.equal(repository.atomicallyApplied, false);
      assert.equal(repository.receipts.length, 0);
    },
  ],
  [
    "legitimate v2 save passes with platform tenant envelope only",
    async () => {
      const candidate = makeV2Candidate();
      const repository = new FakeBillingRepository("supabase");
      const actor = makeActor(["finance"]);

      const returned = await saveBillingPolicy(
        asAdminRepository(repository),
        actor,
        policyInput(candidate.policy),
        "fixture v2 save",
        "fixture-request-v2",
      );

      assert.equal(repository.getPolicyCalls, 1);
      assert.equal(repository.mutationCalls, 1);
      assert.equal(repository.localSaveCalls, 0);
      assert.equal(repository.appendAuditCalls, 0);
      assert.equal(repository.atomicallyApplied, true);
      assert.equal(repository.receipts.length, 1);
      const receipt = repository.receipts[0]!;
      assert.equal(receipt.fake, "in-memory-fake");
      assert.equal(receipt.payloadTenant, PLATFORM_TENANT);
      assert.equal(receipt.auditTenant, PLATFORM_TENANT);
      assert.equal(receipt.applied, true);
      assert.equal(repository.lastAudit?.tenantId, PLATFORM_TENANT);

      // Envelope carries the tenant, but the returned DTO never does.
      const wire = repository.lastMutation!.payload as unknown as Record<
        string,
        unknown
      >;
      assert.equal(wire.tenantId, PLATFORM_TENANT);
      const wirePolicy = { ...wire };
      delete wirePolicy.tenantId;
      assert.deepEqual(wirePolicy, returned);
      assert.equal(Object.hasOwn(returned, "tenantId"), false);

      // Canonical v2 fingerprint and policy content are unchanged.
      assert.equal(costBetaPricingFingerprint(returned), candidate.fingerprint);
      const { updatedAt, updatedBy, ...content } = returned;
      assert.deepEqual(content, candidate.policy);
      assert.ok(Number.isFinite(Date.parse(updatedAt)));
      assert.equal(updatedBy, actor.userId);
    },
  ],
  [
    "v2 extra tenantId is rejected by the validator and never reaches the RPC",
    async () => {
      const candidate = makeV2Candidate();
      const repository = new FakeBillingRepository("supabase");
      const actor = makeActor(["super_admin"]);
      const injected = {
        ...candidate.policy,
        tenantId: INJECTED_TENANT,
      };

      await assert.rejects(
        saveBillingPolicy(
          asAdminRepository(repository),
          actor,
          policyInput(injected),
          "fixture rejected v2 tenant",
          "fixture-request-v2-injected",
        ),
        /成本 β 定价合同无效/,
      );

      assert.equal(repository.getPolicyCalls, 0);
      assert.equal(repository.mutationCalls, 0);
      assert.equal(repository.localSaveCalls, 0);
      assert.equal(repository.appendAuditCalls, 0);
      assert.equal(repository.receipts.length, 0);
    },
  ],
  [
    "legacy injected tenant cannot override the platform envelope tenant",
    async () => {
      const repository = new FakeBillingRepository("supabase");
      const actor = makeActor(["super_admin"]);
      const injected = {
        ...makeLegacyPolicy(),
        tenantId: INJECTED_TENANT,
      };

      const returned = await saveBillingPolicy(
        asAdminRepository(repository),
        actor,
        policyInput(injected),
        "fixture legacy injected tenant",
        "fixture-request-legacy-injected",
      );

      const wire = repository.lastMutation!.payload as unknown as Record<
        string,
        unknown
      >;
      assert.equal(wire.tenantId, PLATFORM_TENANT);
      assert.equal(repository.lastAudit?.tenantId, PLATFORM_TENANT);
      assert.equal(repository.receipts[0]?.payloadTenant, PLATFORM_TENANT);
      assert.equal(repository.receipts[0]?.auditTenant, PLATFORM_TENANT);
      // Only the wire envelope gained the platform tenant; the returned DTO
      // keeps exactly what the caller supplied.
      assert.equal(
        (returned as unknown as Record<string, unknown>).tenantId,
        INJECTED_TENANT,
      );
    },
  ],
  [
    "fake atomic role gate rejects a non-billing role even with a valid tenant envelope",
    () => {
      const candidate = makeV2Candidate();
      const repository = new FakeBillingRepository("supabase");
      const actor = makeActor(["support"]);
      const mutation = {
        kind: "billing_policy.save",
        payload: { ...candidate.policy, tenantId: PLATFORM_TENANT },
      } as AtomicAdminMutation;

      assert.throws(
        () => repository.assertAtomicGate(mutation, makeAudit(actor)),
        /admin mutation forbidden/,
      );
      assert.equal(repository.receipts.length, 0);
    },
  ],
  [
    "unauthorized role makes no mutation, save or audit",
    async () => {
      const candidate = makeV2Candidate();
      const repository = new FakeBillingRepository("supabase");
      const actor = makeActor(["support"]);

      await assert.rejects(
        saveBillingPolicy(
          asAdminRepository(repository),
          actor,
          policyInput(candidate.policy),
          "fixture unauthorized",
          "fixture-request-unauthorized",
        ),
        /当前管理员角色无权执行此操作/,
      );

      assert.equal(repository.getPolicyCalls, 0);
      assert.equal(repository.mutationCalls, 0);
      assert.equal(repository.localSaveCalls, 0);
      assert.equal(repository.appendAuditCalls, 0);
      assert.equal(repository.receipts.length, 0);
      assert.equal(repository.atomicallyApplied, false);
    },
  ],
  [
    "atomic RPC failure propagates without local save or audit fallback",
    async () => {
      const candidate = makeV2Candidate();
      const repository = new FakeBillingRepository("supabase");
      const actor = makeActor(["super_admin"]);
      repository.failAtomic = true;

      await assert.rejects(
        saveBillingPolicy(
          asAdminRepository(repository),
          actor,
          policyInput(candidate.policy),
          "fixture atomic failure",
          "fixture-request-atomic-failure",
        ),
        /fake atomic RPC failure/,
      );

      assert.equal(repository.mutationCalls, 1);
      assert.equal(repository.localSaveCalls, 0);
      assert.equal(repository.appendAuditCalls, 0);
      assert.equal(repository.receipts.length, 0);
      assert.equal(repository.atomicallyApplied, false);
      assert.equal(repository.currentPolicy.version, INITIAL_POLICY.version);
      const wire = repository.lastMutation!.payload as unknown as Record<
        string,
        unknown
      >;
      assert.equal(wire.tenantId, PLATFORM_TENANT);
    },
  ],
  [
    "local repository path stores no envelope tenant on policy or audit fallback",
    async () => {
      const repository = new FakeBillingRepository("local_development");
      const actor = makeActor(["super_admin"]);

      const returned = await saveBillingPolicy(
        asAdminRepository(repository),
        actor,
        makeLegacyPolicy(),
        "fixture local path",
        "fixture-request-local",
      );

      assert.equal(repository.mutationCalls, 0);
      assert.equal(repository.localSaveCalls, 1);
      assert.equal(repository.appendAuditCalls, 1);
      assert.equal(Object.hasOwn(repository.currentPolicy, "tenantId"), false);
      assert.equal(Object.hasOwn(returned, "tenantId"), false);
      assert.equal(repository.lastAudit?.tenantId, PLATFORM_TENANT);
    },
  ],
];

async function main(): Promise<void> {
  const previousBillingFlag = process.env.AISTORY_PLATFORM_BILLING_ENABLED;
  const previousManagedFlag = process.env.AISTORY_PLATFORM_MANAGED_ENABLED;
  delete process.env.AISTORY_PLATFORM_BILLING_ENABLED;
  delete process.env.AISTORY_PLATFORM_MANAGED_ENABLED;

  let failed = 0;
  try {
    for (const [name, fn] of tests) {
      try {
        await fn();
        console.log(`ok - ${name}`);
      } catch (error) {
        failed += 1;
        console.error(`not ok - ${name}`);
        console.error(error);
      }
    }
  } finally {
    if (previousBillingFlag === undefined) {
      delete process.env.AISTORY_PLATFORM_BILLING_ENABLED;
    } else {
      process.env.AISTORY_PLATFORM_BILLING_ENABLED = previousBillingFlag;
    }
    if (previousManagedFlag === undefined) {
      delete process.env.AISTORY_PLATFORM_MANAGED_ENABLED;
    } else {
      process.env.AISTORY_PLATFORM_MANAGED_ENABLED = previousManagedFlag;
    }
  }

  assert.equal(networkCalls, 0, "this test must never call the network");
  // Explicit receipts: fake-only, in-memory, never a real database assertion.
  console.log(
    `fake receipts: ${fakeReceipts.length} (in-memory only; no database or network contacted)`,
  );

  if (failed > 0) {
    console.error(`\n${failed} billing-policy RPC boundary test(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log(`\n${tests.length} billing-policy RPC boundary test(s) passed.`);
  }
}

void main();
