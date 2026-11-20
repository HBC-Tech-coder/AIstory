import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  HostedCredentialUnavailableError,
  inspectHostedCredentialFeature,
  readHostedCredentialConfig,
  type HostedCredentialConfig,
} from "@/lib/credentials/hosted/config";
import {
  decryptHostedCredential,
  encryptHostedCredential,
  rewrapHostedCredentialDek,
  type HostedCredentialEnvelope,
} from "@/lib/credentials/hosted/crypto";
import type {
  HostedCredentialMutation,
  HostedCredentialMutationResult,
  HostedCredentialRepository,
} from "@/lib/credentials/hosted/repository";
import {
  createHostedCredential,
  deleteHostedCredential,
  HOSTED_BYOK_PLATFORM_CREDIT_COST,
  listHostedCredentials,
  replaceHostedCredential,
  rotateHostedCredentialEnvelope,
  withResolvedHostedCredential,
  type HostedCredentialActor,
} from "@/lib/credentials/hosted/service";
import type { HostedCredentialSummary } from "@/lib/credentials/hosted/types";
import { PRODUCTION_IDENTITY_DB_GATE_VERSION } from "@/lib/production/databaseGate";

const USER_ID = "018f47ac-2e26-7a4f-9e4e-8c7e14bda001";
const OTHER_USER_ID = "018f47ac-2e26-7a4f-9e4e-8c7e14bda002";
const NOW = Date.parse("2026-08-01T12:00:00.000Z");
const HOSTED_BYOK_RUNTIME_GATE_VERSION = "20260802113000";
const PLAINTEXT = {
  apiKey: "synthetic-test-key-never-networked",
  baseUrl: "https://provider.invalid",
  model: "fixture-text-model",
};

function config(activeVersion = "v1"): HostedCredentialConfig {
  return {
    keyRing: {
      activeVersion,
      keys: new Map([
        ["v1", Buffer.alloc(32, 17)],
        ["v2", Buffer.alloc(32, 29)],
      ]),
    },
    providerRules: [{
      provider: "openai_compatible",
      capabilities: ["text", "image", "vision"],
      baseUrlOrigins: ["https://provider.invalid"],
      models: ["fixture-text-model"],
    }],
    stepUpMaxAgeMs: 300_000,
  };
}

const actor: HostedCredentialActor = {
  userId: USER_ID,
  tenantId: "platform",
  authType: "phone",
  verifiedAt: NOW - 30_000,
};

function summary(
  envelope: HostedCredentialEnvelope,
  status: HostedCredentialSummary["status"] = "active",
): HostedCredentialSummary {
  return {
    id: envelope.credentialId,
    provider: envelope.provider,
    capabilities: [...envelope.capabilities],
    defaultFor: [...envelope.defaultFor],
    maskedLabel: envelope.maskedLabel,
    status,
    createdAt: "2026-08-01T12:00:00.000Z",
    updatedAt: "2026-08-01T12:00:00.000Z",
  };
}

class FakeHostedCredentialRepository implements HostedCredentialRepository {
  readonly source = "fake" as const;
  readonly records = new Map<string, HostedCredentialEnvelope>();
  readonly receipts = new Map<string, {
    fingerprint: string;
    result: HostedCredentialMutationResult;
  }>();
  readonly audit: Array<{
    action: string;
    actorUserId: string;
    credentialId: string;
    reason: string;
    idempotencyKey: string;
    fingerprint: string;
  }> = [];
  readCount = 0;
  markUsedCount = 0;
  private queue: Promise<void> = Promise.resolve();

  async assertReady(): Promise<void> {}

  async list(ownerUserId: string, tenantId: string): Promise<HostedCredentialSummary[]> {
    return [...this.records.values()]
      .filter((item) => item.ownerUserId === ownerUserId && item.tenantId === tenantId)
      .map((item) => summary(item));
  }

  async readEncrypted(input: {
    ownerUserId: string;
    tenantId: string;
    credentialId: string;
    capability?: string;
  }): Promise<HostedCredentialEnvelope | undefined> {
    this.readCount += 1;
    const value = this.records.get(input.credentialId);
    return value
      && value.ownerUserId === input.ownerUserId
      && value.tenantId === input.tenantId
      && (!input.capability || value.capabilities.includes(input.capability as never))
      ? structuredClone(value)
      : undefined;
  }

  async applyMutation(
    mutation: HostedCredentialMutation,
  ): Promise<HostedCredentialMutationResult> {
    const previous = this.queue;
    let release = () => undefined;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const receiptKey = `${mutation.tenantId}:${mutation.actorUserId}:${mutation.idempotencyKey}`;
      const prior = this.receipts.get(receiptKey);
      if (prior) {
        if (prior.fingerprint !== mutation.mutationFingerprint) {
          throw new Error("idempotency conflict");
        }
        return { ...prior.result, replayed: true };
      }
      let resultSummary: HostedCredentialSummary;
      if (mutation.action === "delete") {
        const existing = this.records.get(mutation.credentialId);
        if (!existing || existing.ownerUserId !== mutation.actorUserId) {
          throw new Error("credential unavailable");
        }
        this.records.delete(mutation.credentialId);
        resultSummary = summary(existing, "deleted");
      } else {
        if (!mutation.envelope) throw new Error("envelope required");
        const existing = this.records.get(mutation.credentialId);
        if (mutation.action === "create" && existing) throw new Error("already exists");
        if (mutation.action !== "create" && !existing) throw new Error("missing");
        this.records.set(mutation.credentialId, structuredClone(mutation.envelope));
        resultSummary = summary(mutation.envelope);
      }
      const result = { credential: resultSummary, replayed: false };
      this.receipts.set(receiptKey, {
        fingerprint: mutation.mutationFingerprint,
        result,
      });
      this.audit.push({
        action: mutation.action,
        actorUserId: mutation.actorUserId,
        credentialId: mutation.credentialId,
        reason: mutation.reason,
        idempotencyKey: mutation.idempotencyKey,
        fingerprint: mutation.mutationFingerprint,
      });
      return result;
    } finally {
      release();
    }
  }

  async markUsed(): Promise<void> {
    this.markUsedCount += 1;
  }
}

const repository = new FakeHostedCredentialRepository();
const deps = { config: config(), repository, now: () => NOW };

const created = await createHostedCredential({
  actor,
  provider: "openai_compatible",
  capabilities: ["text"],
  plaintext: PLAINTEXT,
  idempotencyKey: "hosted-create-fixture-0001",
  reason: "user opted into cross-device credential storage",
}, deps);
assert.equal(created.provider, "openai_compatible");
assert.deepEqual(created.capabilities, ["text"]);
assert.equal(JSON.stringify(created).includes(PLAINTEXT.apiKey), false);
assert.equal(JSON.stringify(created).includes(PLAINTEXT.baseUrl), false);
assert.equal(JSON.stringify(created).includes(PLAINTEXT.model), false);

const replay = await createHostedCredential({
  actor,
  provider: "openai_compatible",
  capabilities: ["text"],
  plaintext: PLAINTEXT,
  idempotencyKey: "hosted-create-fixture-0001",
  reason: "user opted into cross-device credential storage",
}, deps);
assert.deepEqual(replay, created);
assert.equal(repository.audit.length, 1, "create replay must append no second audit");

await assert.rejects(
  createHostedCredential({
    actor,
    provider: "openai_compatible",
    capabilities: ["text"],
    plaintext: { ...PLAINTEXT, apiKey: "different-synthetic-key" },
    idempotencyKey: "hosted-create-fixture-0001",
    reason: "user opted into cross-device credential storage",
  }, deps),
  /idempotency conflict/,
);

const stored = repository.records.get(created.id)!;
assert.deepEqual(decryptHostedCredential(stored, config()), PLAINTEXT);
await assert.rejects(
  Promise.resolve().then(() => decryptHostedCredential({
    ...stored,
    ciphertext: `${stored.ciphertext.slice(0, -2)}AA`,
  }, config())),
  HostedCredentialUnavailableError,
  "ciphertext tampering must fail closed",
);
await assert.rejects(
  Promise.resolve().then(() => decryptHostedCredential({
    ...stored,
    ownerUserId: OTHER_USER_ID,
  }, config())),
  HostedCredentialUnavailableError,
  "AAD must bind the owner UUID",
);
await assert.rejects(
  Promise.resolve().then(() => decryptHostedCredential({
    ...stored,
    kekVersion: "missing",
  }, config())),
  HostedCredentialUnavailableError,
);

const oldEnvelope = encryptHostedCredential({
  config: config("v1"),
  credentialId: "018f47ac-2e26-7a4f-9e4e-8c7e14bda020",
  ownerUserId: USER_ID,
  tenantId: "platform",
  provider: "openai_compatible",
  capabilities: ["text"],
  defaultFor: ["text"],
  maskedLabel: "openai_compatible · text",
  plaintext: PLAINTEXT,
});
const rotated = rewrapHostedCredentialDek(oldEnvelope, config("v2"));
assert.equal(rotated.kekVersion, "v2");
assert.equal(rotated.ciphertext, oldEnvelope.ciphertext);
assert.deepEqual(decryptHostedCredential(rotated, config("v2")), PLAINTEXT);

let callbackCredential: { apiKey: string; baseUrl: string; model: string } | undefined;
const resolvedModel = await withResolvedHostedCredential({
  actor,
  credentialId: created.id,
  capability: "text",
  speculativeDepth: 1,
  speculative: false,
  async operation(credential) {
    callbackCredential = credential as typeof callbackCredential;
    return credential.model;
  },
}, deps);
assert.equal(resolvedModel, PLAINTEXT.model);
assert.deepEqual(callbackCredential, { apiKey: "", baseUrl: "", model: "" });
assert.equal(repository.markUsedCount, 1);

const readsBeforeDepthZero = repository.readCount;
await assert.rejects(
  withResolvedHostedCredential({
    actor,
    credentialId: created.id,
    capability: "text",
    speculativeDepth: 0,
    speculative: true,
    async operation() {
      throw new Error("must not execute");
    },
  }, deps),
  HostedCredentialUnavailableError,
);
assert.equal(repository.readCount, readsBeforeDepthZero, "depth zero must not read/decrypt");
assert.equal(HOSTED_BYOK_PLATFORM_CREDIT_COST, 0);

const replaced = await replaceHostedCredential({
  actor,
  credentialId: created.id,
  capabilities: ["text", "vision"],
  defaultFor: ["text"],
  plaintext: PLAINTEXT,
  idempotencyKey: "hosted-replace-fixture-0001",
  reason: "user replaced the credential profile",
}, deps);
assert.deepEqual(replaced.capabilities, ["text", "vision"]);
assert.equal(repository.audit.length, 2);
const replaceReplay = await replaceHostedCredential({
  actor,
  credentialId: created.id,
  capabilities: ["text", "vision"],
  defaultFor: ["text"],
  plaintext: PLAINTEXT,
  idempotencyKey: "hosted-replace-fixture-0001",
  reason: "user replaced the credential profile",
}, deps);
assert.deepEqual(replaceReplay, replaced);
assert.equal(repository.audit.length, 2, "replace replay must append no audit");

const rotatedProfile = await rotateHostedCredentialEnvelope({
  actor,
  credentialId: created.id,
  idempotencyKey: "hosted-rotate-fixture-0001",
  reason: "user credential envelope key rotation",
}, { ...deps, config: config("v2") });
assert.equal(rotatedProfile.id, created.id);
assert.equal(repository.records.get(created.id)?.kekVersion, "v2");
assert.equal(repository.audit.length, 3);
const rotateReplay = await rotateHostedCredentialEnvelope({
  actor,
  credentialId: created.id,
  idempotencyKey: "hosted-rotate-fixture-0001",
  reason: "user credential envelope key rotation",
}, { ...deps, config: config("v2") });
assert.deepEqual(rotateReplay, rotatedProfile);
assert.equal(repository.audit.length, 3, "rotate replay must append no audit");

const listed = await listHostedCredentials(actor, deps);
assert.equal(listed.length, 1);
assert.equal(JSON.stringify(listed).includes("ciphertext"), false);
assert.equal(JSON.stringify(listed).includes("wrappedDek"), false);

const deleted = await deleteHostedCredential({
  actor,
  credentialId: created.id,
  idempotencyKey: "hosted-delete-fixture-0001",
  reason: "user removed the hosted credential profile",
}, deps);
assert.equal(deleted.status, "deleted");
const deleteReplay = await deleteHostedCredential({
  actor,
  credentialId: created.id,
  idempotencyKey: "hosted-delete-fixture-0001",
  reason: "user removed the hosted credential profile",
}, deps);
assert.deepEqual(deleteReplay, deleted);
assert.equal(repository.audit.length, 4, "delete replay must append no audit");
assert.equal((await listHostedCredentials(actor, deps)).length, 0);

await assert.rejects(
  createHostedCredential({
    actor: { ...actor, tenantId: "other-tenant" as "platform" },
    provider: "openai_compatible",
    capabilities: ["text"],
    plaintext: PLAINTEXT,
    idempotencyKey: "hosted-create-fixture-cross-tenant",
    reason: "invalid cross tenant attempt",
  }, deps),
  HostedCredentialUnavailableError,
);
await assert.rejects(
  createHostedCredential({
    actor: { ...actor, userId: "anonymous" },
    provider: "openai_compatible",
    capabilities: ["text"],
    plaintext: PLAINTEXT,
    idempotencyKey: "hosted-create-fixture-0002",
    reason: "invalid anonymous attempt",
  }, deps),
  HostedCredentialUnavailableError,
);
await assert.rejects(
  createHostedCredential({
    actor: { ...actor, verifiedAt: NOW - 301_000 },
    provider: "openai_compatible",
    capabilities: ["text"],
    plaintext: PLAINTEXT,
    idempotencyKey: "hosted-create-fixture-0003",
    reason: "expired step up attempt",
  }, deps),
  HostedCredentialUnavailableError,
);

const readyEnv: NodeJS.ProcessEnv = {
  AISTORY_HOSTED_BYOK_ENABLED: "true",
  AISTORY_HOSTED_BYOK_REPOSITORY: "supabase",
  AISTORY_HOSTED_BYOK_STEP_UP_ENABLED: "true",
  AISTORY_HOSTED_BYOK_ACTIVE_KEK_VERSION: "v1",
  AISTORY_HOSTED_BYOK_KEK_RING_JSON: JSON.stringify({
    v1: Buffer.alloc(32, 7).toString("base64"),
  }),
  AISTORY_HOSTED_BYOK_PROVIDER_ALLOWLIST_JSON: JSON.stringify([{
    provider: "openai_compatible",
    capabilities: ["text"],
    baseUrlOrigins: ["https://provider.invalid"],
    models: ["fixture-text-model"],
  }]),
  AISTORY_HOSTED_BYOK_STEP_UP_MAX_AGE_SECONDS: "300",
  AISTORY_SMS_PROVIDER: "aliyun_dysms",
  ALIBABA_CLOUD_ACCESS_KEY_ID: "fixture-access-key-id",
  ALIBABA_CLOUD_ACCESS_KEY_SECRET: "fixture-access-key-secret",
  ALIYUN_SMS_SIGN_NAME: "fixture-sign-name",
  ALIYUN_SMS_TEMPLATE_CODE_LOGIN: "SMS_FixtureLogin01",
  AISTORY_PRODUCTION_IDENTITY_ENABLED: "true",
  AISTORY_IDENTITY_REPOSITORY: "supabase",
  AISTORY_ADMIN_REPOSITORY: "supabase",
  AISTORY_DATABASE_GATE_VERSION: PRODUCTION_IDENTITY_DB_GATE_VERSION,
  AISTORY_ANONYMOUS_SESSION_SECRET: "synthetic-anonymous-session-secret-000000",
  AISTORY_ANONYMOUS_SUBJECT_PEPPER: "synthetic-anonymous-subject-pepper-000000",
  NEXT_PUBLIC_SUPABASE_URL: "https://fixture.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "synthetic-service-role-never-networked",
};
assert.equal(inspectHostedCredentialFeature(readyEnv).code, "ready");
assert.equal(readHostedCredentialConfig(readyEnv).keyRing.activeVersion, "v1");
assert.equal(inspectHostedCredentialFeature({ ...readyEnv, AISTORY_HOSTED_BYOK_ENABLED: "false" }).code, "disabled");
assert.equal(inspectHostedCredentialFeature({ ...readyEnv, AISTORY_HOSTED_BYOK_KEK_RING_JSON: "" }).code, "encryption_unavailable");
assert.equal(inspectHostedCredentialFeature({ ...readyEnv, AISTORY_DATABASE_GATE_VERSION: "20260731183000" }).code, "identity_gate_unavailable");
assert.equal(inspectHostedCredentialFeature({ ...readyEnv, ALIYUN_SMS_TEMPLATE_CODE_LOGIN: "" }).code, "step_up_unavailable");

const routeSource = await readFile(
  path.join(process.cwd(), "app", "api", "credentials", "hosted", "route.ts"),
  "utf8",
);
for (const fragment of [
  "isSameOriginMutation(request)",
  "readPhoneUserSession()",
  "session.version !== 2",
  "Cache-Control",
  "no-store",
]) assert.equal(routeSource.includes(fragment), true, `route contract missing ${fragment}`);
for (const forbidden of ["console.log", "searchParams.get(\"apiKey\")", "NEXT_PUBLIC_HOSTED"] ) {
  assert.equal(routeSource.includes(forbidden), false, `route leaks unsafe pattern ${forbidden}`);
}

const migration = await readFile(
  path.join(
    process.cwd(),
    "supabase",
    "migrations",
    "20260801193000_hosted_byok_vault_gate.sql",
  ),
  "utf8",
);
const ambiguityHardeningMigration = await readFile(
  path.join(
    process.cwd(),
    "supabase",
    "migrations",
    "20260801213000_hosted_byok_rpc_ambiguity_hardening.sql",
  ),
  "utf8",
);
const runtimeHardeningMigration = await readFile(
  path.join(
    process.cwd(),
    "supabase",
    "migrations",
    `${HOSTED_BYOK_RUNTIME_GATE_VERSION}_hosted_byok_rpc_runtime_qualification_hardening.sql`,
  ),
  "utf8",
);
for (const fragment of [
  "alter table public.hosted_byok_credentials force row level security",
  "alter table public.hosted_byok_audit_logs force row level security",
  "from public, anon, authenticated, service_role",
  "grant execute on function public.aistory_hosted_byok_apply_mutation(jsonb)",
  "to service_role",
  "hosted credential audit is append-only",
  "hosted credential idempotency conflict",
  "values ('production_identity_billing', '20260801193000')",
]) assert.equal(migration.includes(fragment), true, `migration contract missing ${fragment}`);
for (const fragment of [
  "#variable_conflict error",
  "audit.actor_user_id = v_actor_user_id",
  "credential.owner_user_id = hosted_list.owner_user_id",
  "credential.id = hosted_read.credential_id",
  "credential.id = hosted_mark.credential_id",
  "hosted credential idempotency conflict",
  "hosted credential security posture unavailable",
  "values ('production_identity_billing', '20260801213000')",
]) assert.equal(
  ambiguityHardeningMigration.includes(fragment),
  true,
  `gate11 ambiguity hardening migration contract missing ${fragment}`,
);
assert.equal(
  createHash("sha256").update(migration).digest("hex"),
  "71380ad32f6488796a92fd7befbaa69a5040e8a536a5b4f6443d253499597738",
  "gate10 migration hash drifted",
);
assert.equal(
  createHash("sha256").update(ambiguityHardeningMigration).digest("hex"),
  "47932687c67c98fb0aa3f2484ac06414f491086ef4ac512b92827ffba1a646de",
  "gate11 migration hash drifted",
);
for (const fragment of [
  "20260801213000",
  "v_mutation := $1",
  "app_user.id = v_owner_user_id",
  "credential.id = v_credential_id",
  "v_existing.provider <> v_mutation->>'provider'",
  "hosted credential security posture unavailable",
  `values ('production_identity_billing', '${HOSTED_BYOK_RUNTIME_GATE_VERSION}')`,
]) assert.equal(
  runtimeHardeningMigration.includes(fragment),
  true,
  `gate12 runtime hardening migration contract missing ${fragment}`,
);
for (const forbiddenRuntimeQualifier of [
  "hosted_mutation.mutation",
  "hosted_list.owner_user_id",
  "hosted_read.credential_id",
  "hosted_mark.credential_id",
]) assert.equal(
  runtimeHardeningMigration.includes(forbiddenRuntimeQualifier),
  false,
  `gate12 retains block-label SQL qualifier ${forbiddenRuntimeQualifier}`,
);
assert.equal(
  createHash("sha256").update(runtimeHardeningMigration).digest("hex"),
  "92e514c3d73228e64e02865a34e560e7e0d52933c8d9202f0786445eedc407c1",
  "gate12 migration hash drifted",
);

const serializedEvidence = JSON.stringify({
  summaries: listed,
  audit: repository.audit,
  feature: inspectHostedCredentialFeature({}),
});
for (const secret of [PLAINTEXT.apiKey, PLAINTEXT.baseUrl, PLAINTEXT.model]) {
  assert.equal(serializedEvidence.includes(secret), false, "DTO/audit evidence must not contain credential material");
}

console.log("hosted BYOK vault tests passed");
