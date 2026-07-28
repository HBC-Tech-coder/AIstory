import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { LocalAdminRepository } from "@/lib/admin/localRepository";
import { SupabaseAdminRepository } from "@/lib/admin/supabaseRepository";
import {
  adjustCredits,
  createUserWithInitialGrant,
  getAdminRepositoryForActor,
} from "@/lib/admin/service";
import type { AdminActor } from "@/lib/admin/types";
import type { AdminAuditLog, UserProjection } from "@/lib/admin/types";
import {
  SupabasePhoneIdentityRepository,
  type PhoneIdentityRpcClient,
} from "@/lib/auth/phoneIdentityRepository";
import {
  requestPhoneOtp,
  verifyPhoneOtp,
  type SmsVerificationProvider,
} from "@/lib/auth/phoneAuthService";
import {
  createUserSessionToken,
  verifyUserSessionToken,
} from "@/lib/auth/userSession";
import {
  inspectProductionDatabaseGate,
  PRODUCTION_IDENTITY_DB_GATE_VERSION,
  ProductionDatabaseGateError,
} from "@/lib/production/databaseGate";
import { prepareGenerationBilling } from "@/lib/billing/generationGate";

type RpcResult = {
  data: unknown;
  error: { message?: string; code?: string } | null;
};

class IdentityRpcFixture {
  readonly calls: Array<{ name: string; args?: Record<string, unknown> }> = [];
  readonly challenges = new Map<string, {
    phoneHash: string;
    otpHash: string;
    status: "pending" | "sent" | "consumed" | "invalidated";
  }>();
  readonly users = new Map<string, string>();
  readonly userStatuses = new Map<
    string,
    "active" | "frozen" | "deleted"
  >();
  readonly grants = new Set<string>();
  private queue: Promise<void> = Promise.resolve();

  readonly client: PhoneIdentityRpcClient = {
    rpc: async (name, args) => this.rpc(name, args as Record<string, unknown>),
  };

  private async serialized<T>(operation: () => T): Promise<T> {
    const previous = this.queue;
    let release = () => undefined;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return operation();
    } finally {
      release();
    }
  }

  async rpc(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<RpcResult> {
    this.calls.push({ name, args });
    if (name === "aistory_database_gate_status") {
      return { data: PRODUCTION_IDENTITY_DB_GATE_VERSION, error: null };
    }
    if (name === "aistory_create_phone_challenge") {
      const challenge = args?.challenge as Record<string, string>;
      this.challenges.set(challenge.id, {
        phoneHash: challenge.phone_hash,
        otpHash: challenge.otp_hash,
        status: "pending",
      });
      return { data: challenge.id, error: null };
    }
    if (name === "aistory_mark_phone_challenge_sent") {
      const challenge = this.challenges.get(String(args?.challenge_id));
      if (!challenge || challenge.status !== "pending") {
        return { data: false, error: null };
      }
      challenge.status = "sent";
      return { data: true, error: null };
    }
    if (name === "aistory_invalidate_phone_challenge") {
      const challenge = this.challenges.get(String(args?.challenge_id));
      if (challenge) challenge.status = "invalidated";
      return { data: true, error: null };
    }
    if (name === "aistory_validate_phone_session") {
      const userId = String(args?.app_user_id || "");
      return {
        data:
          [...this.users.values()].includes(userId)
          && this.userStatuses.get(userId) === "active",
        error: null,
      };
    }
    if (name === "aistory_verify_phone_and_register") {
      return this.serialized(() => {
        const verification = args?.verification as Record<string, string>;
        const challenge = this.challenges.get(verification.challenge_id);
        if (
          !challenge
          || challenge.status !== "sent"
          || challenge.phoneHash !== verification.phone_hash
          || challenge.otpHash !== verification.otp_hash
        ) {
          return {
            data: { status: "invalid" },
            error: null,
          };
        }
        challenge.status = "consumed";
        let userId = this.users.get(verification.phone_hash);
        const created = !userId;
        userId ||= "018f47ac-2e26-7a4f-9e4e-8c7e14bda001";
        if (!created && this.userStatuses.get(userId) !== "active") {
          return {
            data: { status: "invalid" },
            error: null,
          };
        }
        this.users.set(verification.phone_hash, userId);
        this.userStatuses.set(userId, "active");
        const initialGrantApplied = !this.grants.has(userId);
        this.grants.add(userId);
        return {
          data: {
            status: "verified",
            user_id: userId,
            masked_phone: verification.masked_phone,
            created,
            initial_grant_applied: initialGrantApplied,
            balance: 1000,
          },
          error: null,
        };
      });
    }
    return { data: null, error: { message: "fixture RPC missing" } };
  }
}

const root = await mkdtemp(path.join(os.tmpdir(), "aistory-production-db-"));
const localStore = path.join(root, "admin.json");
const localPhoneStore = path.join(root, "phone.json");
const migrationPath = path.join(
  process.cwd(),
  "supabase",
  "migrations",
  `${PRODUCTION_IDENTITY_DB_GATE_VERSION}_production_identity_billing_gate.sql`,
);
const originalEnv = { ...process.env };

function restoreEnvironment(snapshot: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) delete process.env[key];
  }
  Object.assign(process.env, snapshot);
}

try {
  const migration = await readFile(migrationPath, "utf8");
  const requiredSql = [
    "create table if not exists public.app_users",
    "create table if not exists public.phone_identities",
    "create table if not exists public.phone_otp_challenges",
    "create or replace function public.aistory_verify_phone_and_register",
    "create or replace function public.aistory_validate_phone_session",
    "create or replace function public.aistory_admin_adjust_credits",
    "create or replace function public.aistory_admin_apply_mutation",
    "create or replace function public.aistory_reserve_credits",
    "create or replace function public.aistory_append_billing_terminal",
    "set search_path = pg_catalog, public",
    "pg_advisory_xact_lock",
    "credit_ledger_append_only",
    "admin_audit_logs_append_only",
    "grant execute on function public.aistory_verify_phone_and_register(jsonb) to service_role",
    "revoke all on function public.aistory_verify_phone_and_register(jsonb) from anon, authenticated",
    "grant execute on function public.aistory_admin_apply_mutation(jsonb, jsonb) to service_role",
    "credit adjustment idempotency conflict",
    "existing_entry.amount <> adjustment_amount",
    "existing_entry.actor_id is distinct from actor_user_id",
    "admin_audit_one_credit_adjustment_per_entry",
    "mutation_fingerprint",
    "'actorId', actor_user_id",
    "existing_fingerprint = canonical_fingerprint",
    "(existing_audit.before_summary->>'balance')::bigint",
    "credit user inactive or unavailable",
    "and app_user.status = 'active'",
    "grant execute on function public.aistory_validate_phone_session(uuid) to service_role",
    "revoke all on function public.aistory_validate_phone_session(uuid) from anon, authenticated",
    "revoke insert, update, delete on public.admin_audit_logs",
  ];
  for (const fragment of requiredSql) {
    assert.equal(migration.includes(fragment), true, `missing SQL: ${fragment}`);
  }
  assert.equal(
    /grant\s+execute[\s\S]{0,160}aistory_verify_phone_and_register[\s\S]{0,80}\b(?:anon|authenticated)\b/i
      .test(migration),
    false,
    "phone identity RPC must never be granted to browser roles",
  );
  assert.equal(
    /before update or delete on public\.credit_ledger/i.test(migration),
    true,
  );
  assert.equal(
    /before update or delete on public\.admin_audit_logs/i.test(migration),
    true,
  );
  assert.equal(
    /insert into public\.admin_audit_logs[\s\S]+return true;[\s\S]+end;[\s\S]+\$\$;[\s\S]+-- Replace the earlier billing functions/i
      .test(migration),
    true,
    "generic admin business mutation and audit must share one SQL function",
  );

  const adminRpcCalls: Array<{
    name: string;
    args: Record<string, unknown>;
  }> = [];
  const mutationFingerprints = new Map<string, string>();
  const productionAdminRepository = new SupabaseAdminRepository({
    async rpc(name: string, args: Record<string, unknown>) {
      adminRpcCalls.push({ name, args });
      if (name === "aistory_admin_apply_mutation") {
        const mutation = structuredClone(
          args.mutation as Record<string, unknown>,
        );
        const audit = args.audit as Record<string, unknown>;
        const requestId = String(audit.request_id || "");
        const payload = mutation.payload as Record<string, unknown>;
        for (
          const key of [
            "createdAt",
            "createdBy",
            "updatedAt",
            "updatedBy",
            "publishedAt",
          ]
        ) {
          delete payload[key];
        }
        const fingerprint = JSON.stringify({
          actorId: audit.actor_id,
          mutation,
        });
        const existing = mutationFingerprints.get(requestId);
        if (existing && existing !== fingerprint) {
          return {
            data: null,
            error: { message: "admin mutation idempotency conflict" },
          };
        }
        mutationFingerprints.set(requestId, fingerprint);
      }
      return { data: true, error: null };
    },
  } as never);
  const projectedUser: UserProjection = {
    userId: "018f47ac-2e26-7a4f-9e4e-8c7e14bda002",
    tenantId: "platform",
    displayName: "fixture",
    maskedContact: "+8613******00",
    status: "frozen",
    userType: "player",
    tags: ["fixture"],
    createdAt: new Date(0).toISOString(),
  };
  const mutationAudit: AdminAuditLog = {
    id: randomUUID(),
    tenantId: "platform",
    actorId: "018f47ac-2e26-7a4f-9e4e-8c7e14bda003",
    actorRoles: ["super_admin"],
    action: "user.status_update",
    targetType: "profile",
    targetId: projectedUser.userId,
    beforeSummary: { status: "active" },
    afterSummary: { status: "frozen" },
    reason: "fixture production mutation",
    requestId: "request-production-admin-fixture",
    createdAt: new Date(0).toISOString(),
  };
  await productionAdminRepository.applyAdminMutationAtomically(
    { kind: "user.save", payload: projectedUser },
    mutationAudit,
  );
  assert.equal(adminRpcCalls.length, 1);
  assert.equal(adminRpcCalls[0]?.name, "aistory_admin_apply_mutation");
  await productionAdminRepository.applyAdminMutationAtomically(
    { kind: "user.save", payload: projectedUser },
    mutationAudit,
  );
  await assert.rejects(
    productionAdminRepository.applyAdminMutationAtomically(
      {
        kind: "user.save",
        payload: { ...projectedUser, status: "active" },
      },
      mutationAudit,
    ),
    /Production admin mutation is unavailable/,
    "the same request id must reject a semantically different payload",
  );
  await assert.rejects(
    productionAdminRepository.applyAdminMutationAtomically(
      { kind: "user.save", payload: projectedUser },
      {
        ...mutationAudit,
        actorId: "018f47ac-2e26-7a4f-9e4e-8c7e14bda004",
      },
    ),
    /Production admin mutation is unavailable/,
    "the same request id must not be replayed by a different actor",
  );
  await assert.rejects(
    productionAdminRepository.appendAudit(mutationAudit),
    /controlled transactional audit RPC/,
  );

  const localBindingRepository = new LocalAdminRepository(
    path.join(root, "actor-binding.json"),
  );
  const productionActor: AdminActor = {
    userId: mutationAudit.actorId,
    roles: ["super_admin"],
    mode: "production",
  };
  const localActor: AdminActor = {
    userId: "local-admin",
    roles: ["super_admin"],
    mode: "local",
  };
  assert.equal(
    await getAdminRepositoryForActor(productionActor, {
      productionRepository: productionAdminRepository,
      assertProductionReady: async () => undefined,
    }),
    productionAdminRepository,
  );
  await assert.rejects(
    getAdminRepositoryForActor(productionActor, {
      productionRepository: localBindingRepository,
      assertProductionReady: async () => undefined,
    }),
    /Production administrator repository mismatch/,
  );
  await assert.rejects(
    getAdminRepositoryForActor(productionActor, {
      productionRepository: productionAdminRepository,
      assertProductionReady: async () => {
        throw new ProductionDatabaseGateError();
      },
    }),
    ProductionDatabaseGateError,
    "a production actor must never fall back when the DB gate is unavailable",
  );
  process.env.AISTORY_ADMIN_REPOSITORY = "supabase";
  assert.equal(
    await getAdminRepositoryForActor(localActor, {
      localRepository: localBindingRepository,
    }),
    localBindingRepository,
    "a local actor must remain explicitly bound to the local repository",
  );
  await assert.rejects(
    getAdminRepositoryForActor(localActor, {
      localRepository: productionAdminRepository,
    }),
    /Local administrator repository mismatch/,
  );

  const secretFixture = "fixture-service-role-value-never-serialize";
  const readyEnvironment = {
    AISTORY_PRODUCTION_IDENTITY_ENABLED: "true",
    AISTORY_IDENTITY_REPOSITORY: "supabase",
    AISTORY_ADMIN_REPOSITORY: "supabase",
    AISTORY_DATABASE_GATE_VERSION: PRODUCTION_IDENTITY_DB_GATE_VERSION,
    NEXT_PUBLIC_SUPABASE_URL: "https://fixture.invalid",
    SUPABASE_SERVICE_ROLE_KEY: secretFixture,
  };
  const ready = inspectProductionDatabaseGate(readyEnvironment);
  assert.equal(ready.ready, true);
  assert.equal(JSON.stringify(ready).includes(secretFixture), false);
  assert.deepEqual(
    inspectProductionDatabaseGate({}).missing.sort(),
    [
      "admin_repository",
      "database_gate_version",
      "identity_repository",
      "production_identity_enabled",
      "service_role",
      "supabase_url",
    ].sort(),
  );

  Object.assign(process.env, readyEnvironment, {
    AISTORY_SMS_PROVIDER: "aliyun_dysms",
    AISTORY_PHONE_ID_PEPPER: "fixture-phone-pepper-12345678901234567890",
    AISTORY_SMS_OTP_SECRET: "fixture-otp-secret-1234567890123456789012",
    AISTORY_USER_SESSION_SECRET:
      "fixture-session-secret-123456789012345678",
    AISTORY_PHONE_AUTH_STORE_PATH: localPhoneStore,
  });

  const identityFixture = new IdentityRpcFixture();
  const identityRepository = new SupabasePhoneIdentityRepository(
    identityFixture.client,
  );
  let deliveredCode = "";
  const provider: SmsVerificationProvider = {
    id: "aliyun_dysms",
    available: true,
    async sendVerificationCode({ code }) {
      deliveredCode = code;
    },
  };
  const requested = await requestPhoneOtp({
    phone: "13800138000",
    ip: "203.0.113.5",
    provider,
    identityRepository,
  });
  const account = await verifyPhoneOtp(
    new LocalAdminRepository(localStore),
    {
      phone: "13800138000",
      challengeId: requested.challengeId,
      code: deliveredCode,
      identityRepository,
    },
  );
  assert.match(account.userId, /^[0-9a-f-]{36}$/i);
  assert.equal(account.initialGrantApplied, true);
  assert.equal(account.balance, 1000);
  assert.equal(await identityRepository.validateActiveUser(account.userId), true);
  await assert.rejects(
    verifyPhoneOtp(new LocalAdminRepository(localStore), {
      phone: "13800138000",
      challengeId: requested.challengeId,
      code: deliveredCode,
      identityRepository,
    }),
    (error: unknown) =>
      error instanceof Error && error.message.includes("无效或已过期"),
  );

  const serializedCalls = JSON.stringify(identityFixture.calls);
  assert.equal(serializedCalls.includes("13800138000"), false);
  assert.equal(serializedCalls.includes(deliveredCode), false);
  assert.equal(serializedCalls.includes(secretFixture), false);

  const uuidSession = createUserSessionToken(account.userId);
  assert.equal(verifyUserSessionToken(uuidSession)?.userId, account.userId);
  process.env.AISTORY_PRODUCTION_IDENTITY_ENABLED = "false";
  assert.equal(
    verifyUserSessionToken(uuidSession),
    undefined,
    "a previously signed production cookie must fail closed after the gate closes",
  );
  assert.throws(
    () => createUserSessionToken(account.userId),
    /stable UUID user identity/,
  );
  process.env.AISTORY_PRODUCTION_IDENTITY_ENABLED = "true";
  assert.equal(verifyUserSessionToken(uuidSession)?.userId, account.userId);

  identityFixture.userStatuses.set(account.userId, "frozen");
  assert.equal(await identityRepository.validateActiveUser(account.userId), false);
  const frozenRequest = await requestPhoneOtp({
    phone: "13800138000",
    ip: "203.0.113.7",
    provider,
    identityRepository,
  });
  await assert.rejects(
    verifyPhoneOtp(new LocalAdminRepository(localStore), {
      phone: "13800138000",
      challengeId: frozenRequest.challengeId,
      code: deliveredCode,
      identityRepository,
    }),
    (error: unknown) =>
      error instanceof Error && error.message.includes("无效或已过期"),
    "a correct OTP must not issue a session for a frozen account",
  );
  identityFixture.userStatuses.set(account.userId, "active");

  process.env.AISTORY_IDENTITY_REPOSITORY = "local";
  process.env.AISTORY_SMS_PROVIDER = "local_mock";
  assert.equal(
    verifyUserSessionToken(uuidSession),
    undefined,
    "a production UUID cookie must fail closed if identity storage falls back",
  );
  const legacy = createUserSessionToken(
    `phone_${"a".repeat(32)}`,
  );
  assert.match(verifyUserSessionToken(legacy)?.userId || "", /^phone_/);
  process.env.AISTORY_IDENTITY_REPOSITORY = "supabase";
  process.env.AISTORY_SMS_PROVIDER = "aliyun_dysms";
  assert.equal(
    verifyUserSessionToken(legacy),
    undefined,
    "legacy local phone sessions must be rejected in production mode",
  );

  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  let sendCalls = 0;
  await assert.rejects(
    requestPhoneOtp({
      phone: "13900139000",
      ip: "203.0.113.6",
      provider: {
        id: "aliyun_dysms",
        available: true,
        async sendVerificationCode() {
          sendCalls += 1;
        },
      },
    }),
    ProductionDatabaseGateError,
  );
  assert.equal(sendCalls, 0, "missing DB gate must fail before SMS transport");
  await assert.rejects(stat(localPhoneStore), { code: "ENOENT" });
  process.env.AISTORY_PLATFORM_BILLING_ENABLED = "true";
  const blockedBilling = await prepareGenerationBilling({
    request: new Request("http://127.0.0.1:4200/api/start", {
      method: "POST",
    }),
    auth: { userId: "anonymous", authType: "anonymous" },
    requestedMode: "platform_managed",
    hasByok: false,
    operation: "story.start",
  });
  assert.equal(blockedBilling instanceof Response, true);
  const blockedResponse = blockedBilling as Response;
  assert.equal(blockedResponse.status, 503);
  const blockedBody = JSON.stringify(await blockedResponse.json());
  assert.equal(blockedBody.includes(secretFixture), false);
  assert.equal(blockedBody.includes("quote"), false);

  restoreEnvironment(originalEnv);
  const repository = new LocalAdminRepository(localStore);
  const actor: AdminActor = {
    userId: "local-admin",
    roles: ["super_admin"],
    mode: "local",
  };
  const userId = `phone_${"b".repeat(32)}`;
  await createUserWithInitialGrant(repository, {
    userId,
    tenantId: "platform",
    displayName: "fixture",
    maskedContact: "+8613******00",
    status: "active",
    userType: "player",
  });
  const adjustment = {
    userId,
    amount: 88,
    reason: "并发幂等赠分专项测试",
    idempotencyKey: "admin_grant:production-gate:1",
    requestId: "request-production-gate-1",
  };
  const [first, replay] = await Promise.all([
    adjustCredits(repository, actor, adjustment),
    adjustCredits(repository, actor, {
      ...adjustment,
      requestId: "request-production-gate-replay",
    }),
  ]);
  assert.equal(first.id, replay.id);
  assert.equal(
    (await repository.listLedger(userId)).filter(
      (entry) => entry.idempotencyKey === adjustment.idempotencyKey,
    ).length,
    1,
  );
  assert.equal(
    (await repository.listAudit()).filter(
      (entry) => entry.action === "credit.manual_adjustment",
    ).length,
    1,
    "ledger and audit must commit in the same local atomic mutation",
  );

  const originalAdjustment = {
    actor,
    tenantId: "platform",
    userId,
    amount: 40,
    reason: "验证原始余额可重放",
    idempotencyKey: "admin_grant:original-balances:1",
    requestId: "request-original-balances-1",
    entryId: randomUUID(),
    auditId: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  const originalResult = await repository.adjustCreditsAtomically(
    originalAdjustment,
  );
  await repository.adjustCreditsAtomically({
    ...originalAdjustment,
    amount: 20,
    reason: "后续独立积分调整",
    idempotencyKey: "admin_grant:later-balance:1",
    requestId: "request-later-balance-1",
    entryId: randomUUID(),
    auditId: randomUUID(),
  });
  const replayedOriginal = await repository.adjustCreditsAtomically({
    ...originalAdjustment,
    requestId: "request-original-balances-replay",
    entryId: randomUUID(),
    auditId: randomUUID(),
  });
  assert.equal(replayedOriginal.replayed, true);
  assert.equal(replayedOriginal.entry.id, originalResult.entry.id);
  assert.equal(replayedOriginal.balanceBefore, originalResult.balanceBefore);
  assert.equal(replayedOriginal.balanceAfter, originalResult.balanceAfter);
  assert.equal(
    (await repository.listAudit()).filter(
      (entry) =>
        entry.action === "credit.manual_adjustment"
        && entry.afterSummary?.entryId === originalResult.entry.id,
    ).length,
    1,
    "an adjustment entry must have exactly one audit even after replay",
  );
  await assert.rejects(
    repository.adjustCreditsAtomically({
      ...originalAdjustment,
      amount: 41,
      requestId: "request-original-balances-conflict",
      entryId: randomUUID(),
      auditId: randomUUID(),
    }),
    /idempotency conflict/,
  );

  console.log("production identity and database gate contract tests passed");
} finally {
  restoreEnvironment(originalEnv);
  await rm(root, { recursive: true, force: true });
}
