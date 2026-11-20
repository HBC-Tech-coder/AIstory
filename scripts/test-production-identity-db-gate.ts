import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
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
  assertProductionDatabaseGateReady,
  inspectProductionDatabaseGate,
  PRODUCTION_IDENTITY_DB_GATE_VERSION,
  ProductionDatabaseGateError,
  rewriteSupabaseRestUrlForPostgrestRoot,
} from "@/lib/production/databaseGate";
import { prepareGenerationBilling } from "@/lib/billing/generationGate";

type RpcResult = {
  data: unknown;
  error: { message?: string; code?: string } | null;
};

const PHONE_ADMIN_DB_GATE_VERSION = "20260809113000";
const VIDEO_ASSET_DB_GATE_VERSION = "20260811193000";
const VIDEO_ASSET_GATE_BYTES = 36034;
const VIDEO_ASSET_GATE_SHA256 =
  "2b506307e1b5e42a16ca79d4c3973e44d410cdd00d4228faed012252b3960dc6";

assert.equal(
  PRODUCTION_IDENTITY_DB_GATE_VERSION,
  VIDEO_ASSET_DB_GATE_VERSION,
  "the runtime database gate must track the forward-only Gate14 migration",
);

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
    if (name === "aistory_database_security_posture") {
      return { data: true, error: null };
    }
    if (name === "aistory_admin_rpc_security_posture") {
      return { data: true, error: null };
    }
    if (name === "aistory_phone_admin_security_posture") {
      return { data: true, error: null };
    }
    if (name === "aistory_hosted_byok_security_posture") {
      return { data: true, error: null };
    }
    if (name === "aistory_video_asset_security_posture") {
      return { data: true, error: null };
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
    if (name === "aistory_verify_phone_register_and_claim") {
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
            claim: {
              status: "not_found",
              accepted_story_record_ids: [],
              accepted_assignment_keys: [],
              accepted_assignments: [],
              counts: {
                submitted_stories: 0,
                inherited_stories: 0,
                inherited_checkpoints: 0,
                inherited_cache_references: 0,
                inherited_assignments: 0,
                skipped: 0,
              },
              skipped_by_reason: {},
            },
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
const baseMigrationPath = path.join(
  process.cwd(),
  "supabase",
  "migrations",
  "20260729093000_production_identity_billing_gate.sql",
);
const claimMigrationPath = path.join(
  process.cwd(),
  "supabase",
  "migrations",
  "20260729183000_anonymous_phone_claim_gate.sql",
);
const hardeningMigrationPath = path.join(
  process.cwd(),
  "supabase",
  "migrations",
  "20260731120000_sensitive_identity_billing_privilege_hardening.sql",
);
const adminRpcMigrationPath = path.join(
  process.cwd(),
  "supabase",
  "migrations",
  "20260731183000_admin_identity_rpc_read_gate.sql",
);
const hostedByokMigrationPath = path.join(
  process.cwd(),
  "supabase",
  "migrations",
  "20260801193000_hosted_byok_vault_gate.sql",
);
const hostedByokAmbiguityHardeningMigrationPath = path.join(
  process.cwd(),
  "supabase",
  "migrations",
  "20260801213000_hosted_byok_rpc_ambiguity_hardening.sql",
);
const hostedByokRuntimeHardeningMigrationPath = path.join(
  process.cwd(),
  "supabase",
  "migrations",
  "20260802113000_hosted_byok_rpc_runtime_qualification_hardening.sql",
);
const phoneAdminIdentityMigrationPath = path.join(
  process.cwd(),
  "supabase",
  "migrations",
  `${PHONE_ADMIN_DB_GATE_VERSION}_phone_admin_identity_gate.sql`,
);
const videoAssetMetadataMigrationPath = path.join(
  process.cwd(),
  "supabase",
  "migrations",
  `${VIDEO_ASSET_DB_GATE_VERSION}_production_video_asset_metadata_gate.sql`,
);
const originalEnv = { ...process.env };

function restoreEnvironment(snapshot: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) delete process.env[key];
  }
  Object.assign(process.env, snapshot);
}

try {
  const migration = await readFile(baseMigrationPath, "utf8");
  const claimMigration = await readFile(claimMigrationPath, "utf8");
  const hardeningMigration = await readFile(hardeningMigrationPath, "utf8");
  const adminRpcMigration = await readFile(adminRpcMigrationPath, "utf8");
  const hostedByokMigration = await readFile(hostedByokMigrationPath, "utf8");
  const hostedByokAmbiguityHardeningMigration = await readFile(
    hostedByokAmbiguityHardeningMigrationPath,
    "utf8",
  );
  const hostedByokRuntimeHardeningMigration = await readFile(
    hostedByokRuntimeHardeningMigrationPath,
    "utf8",
  );
  const phoneAdminIdentityMigration = await readFile(
    phoneAdminIdentityMigrationPath,
    "utf8",
  );
  const videoAssetMetadataMigration = await readFile(
    videoAssetMetadataMigrationPath,
    "utf8",
  );
  const adminSecuritySource = await readFile(
    path.join(process.cwd(), "lib", "admin", "security.ts"),
    "utf8",
  );
  const adminRepositorySource = await readFile(
    path.join(process.cwd(), "lib", "admin", "supabaseRepository.ts"),
    "utf8",
  );
  const bootstrapRouteSource = await readFile(
    path.join(process.cwd(), "app", "api", "admin", "bootstrap", "route.ts"),
    "utf8",
  );
  const adminLoginSource = await readFile(
    path.join(process.cwd(), "app", "admin", "login", "AdminLoginForm.tsx"),
    "utf8",
  );
  const stagingHarnessSource = await readFile(
    path.join(process.cwd(), "scripts", "test-admin-staging-integration.ts"),
    "utf8",
  );
  const environmentExample = await readFile(
    path.join(process.cwd(), ".env.example"),
    "utf8",
  );
  const agentGuide = await readFile(
    path.join(process.cwd(), "AGENTS.md"),
    "utf8",
  );
  const productionGateRunbook = await readFile(
    path.join(process.cwd(), "runbooks", "production-identity-db-gate.md"),
    "utf8",
  );
  const phoneAdminRunbook = await readFile(
    path.join(process.cwd(), "runbooks", "phone-admin-gate13.md"),
    "utf8",
  );
  const videoAssetRunbook = await readFile(
    path.join(
      process.cwd(),
      "runbooks",
      "production-video-assets-aliyun-oss.md",
    ),
    "utf8",
  );
  for (
    const fragment of [
      "create table if not exists public.aistory_schema_gates (",
      "gate_name text primary key",
      "version text not null",
      "installed_at timestamptz not null default now()",
    ]
  ) {
    assert.equal(
      migration.includes(fragment),
      true,
      `base gate schema contract drifted: ${fragment}`,
    );
  }
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
  for (
    const fragment of [
      "create table if not exists public.anonymous_subject_bindings",
      "create table if not exists public.anonymous_subject_claims",
      "create table if not exists public.anonymous_story_claims",
      "create table if not exists public.user_experiment_assignments",
      "create table if not exists public.identity_audit_logs",
      "create or replace function public.aistory_verify_phone_register_and_claim",
      "create or replace function public.aistory_get_anonymous_claim_receipt",
      "deferrable initially deferred",
      "pg_advisory_xact_lock",
      "identity claim records are append-only",
      "values ('production_identity_billing', '20260729183000')",
      "grant execute on function public.aistory_verify_phone_register_and_claim(jsonb)",
      "revoke insert, update, delete on public.anonymous_subject_claims",
    ]
  ) {
    assert.equal(
      claimMigration.includes(fragment),
      true,
      `missing anonymous-claim SQL: ${fragment}`,
    );
  }
  for (
    const fragment of [
      "create or replace function public.aistory_reject_direct_sensitive_write",
      "security invoker",
      "before insert or update or delete on public.%I",
      "alter table public.%I force row level security",
      "revoke all privileges on table public.%I from public, anon, authenticated",
      "create policy user_roles_select_own",
      "grant select on table public.user_roles to authenticated",
      "revoke insert, update, delete on table",
      "from service_role",
      "alter default privileges in schema public",
      "rename to aistory_admin_apply_mutation_v1_legacy",
      "payload_tenant <> audit_tenant",
      "admin mutation tenant mismatch",
      "create or replace function public.aistory_database_security_posture",
      "has_table_privilege('authenticated', 'public.user_roles', 'INSERT')",
      "has_function_privilege(",
      "public.aistory_admin_adjust_credits(jsonb)",
      "public.aistory_verify_phone_register_and_claim(jsonb)",
      "insert into public.aistory_schema_gates (gate_name, version)",
      "values ('production_identity_billing', '20260731120000')",
      "set version = excluded.version",
      "installed_at = now()",
    ]
  ) {
    assert.equal(
      hardeningMigration.includes(fragment),
      true,
      `missing hardening SQL: ${fragment}`,
    );
  }
  for (const driftedColumn of ["gate_version", "applied_at"]) {
    assert.equal(
      new RegExp(`\\b${driftedColumn}\\b`).test(hardeningMigration),
      false,
      `hardening migration must not use drifted gate column ${driftedColumn}`,
    );
  }
  for (
    const tableName of [
      "app_users",
      "phone_identities",
      "phone_otp_challenges",
      "credit_accounts",
      "credit_ledger",
      "billing_policies",
      "user_roles",
      "admin_audit_logs",
      "anonymous_subject_bindings",
      "anonymous_subject_claims",
      "anonymous_story_claims",
      "anonymous_public_cache_claims",
      "user_experiment_assignments",
      "identity_audit_logs",
    ]
  ) {
    assert.equal(
      hardeningMigration.includes(`'${tableName}'`),
      true,
      `hardening posture must cover ${tableName}`,
    );
  }
  assert.equal(
    hardeningMigration.includes("alter table public.stories"),
    false,
    "identity hardening must not change public story access",
  );
  for (
    const fragment of [
      "create or replace function public.aistory_admin_resolve_actor",
      "create or replace function public.aistory_admin_read_snapshot",
      "create or replace function public.aistory_service_read_dataset",
      "create or replace function public.bootstrap_super_admin",
      "pg_catalog.pg_advisory_xact_lock",
      "bootstrap idempotency conflict",
      "one-time production bootstrap",
      "create or replace function public.aistory_admin_rpc_security_posture",
      "revoke all on function public.aistory_admin_read_snapshot(uuid, text)",
      "grant execute on function public.aistory_admin_read_snapshot(uuid, text)",
      "to service_role",
      "to authenticated",
      "insert into public.aistory_schema_gates (gate_name, version)",
      "values ('production_identity_billing', '20260731183000')",
    ]
  ) {
    assert.equal(
      adminRpcMigration.includes(fragment),
      true,
      `missing admin RPC SQL: ${fragment}`,
    );
  }
  assert.equal(
    /grant\s+execute[\s\S]{0,160}aistory_admin_(?:resolve_actor|read_snapshot)[\s\S]{0,80}\b(?:anon|authenticated)\b/i
      .test(adminRpcMigration),
    false,
    "admin identity/read RPCs must never be executable by browser roles",
  );
  assert.equal(
    adminRpcMigration.includes("client_secret_hash"),
    false,
    "the admin snapshot must not project channel client secret hashes",
  );
  for (const fragment of [
    "create table if not exists public.hosted_byok_credentials",
    "create table if not exists public.hosted_byok_audit_logs",
    "force row level security",
    "create or replace function public.aistory_hosted_byok_apply_mutation",
    "create or replace function public.aistory_hosted_byok_read_encrypted",
    "create or replace function public.aistory_hosted_byok_security_posture",
    "hosted credential audit is append-only",
    "hosted credential idempotency conflict",
    "from public, anon, authenticated, service_role",
    "to service_role",
    "insert into public.aistory_schema_gates (gate_name, version)",
    "values ('production_identity_billing', '20260801193000')",
  ]) {
    assert.equal(
      hostedByokMigration.includes(fragment),
      true,
      `missing hosted BYOK SQL: ${fragment}`,
    );
  }
  assert.equal(
    /grant\s+execute[\s\S]{0,180}aistory_hosted_byok_(?:apply_mutation|read_encrypted)[\s\S]{0,100}\b(?:anon|authenticated)\b/i
      .test(hostedByokMigration),
    false,
    "hosted credential RPCs must never be executable by browser roles",
  );
  for (const forbidden of ["api_key", "base_url", "model_name", "plaintext"]) {
    assert.equal(
      new RegExp(`\\b${forbidden}\\b`, "i").test(hostedByokMigration),
      false,
      `hosted vault migration must not add plaintext column ${forbidden}`,
    );
  }
  assert.equal(
    createHash("sha256").update(hostedByokMigration).digest("hex"),
    "71380ad32f6488796a92fd7befbaa69a5040e8a536a5b4f6443d253499597738",
    "already-applied gate10 migration must remain byte-identical",
  );
  for (const fragment of [
    "create or replace function public.aistory_hosted_byok_list",
    "create or replace function public.aistory_hosted_byok_read_encrypted",
    "create or replace function public.aistory_hosted_byok_apply_mutation",
    "create or replace function public.aistory_hosted_byok_mark_used",
    "#variable_conflict error",
    "audit.actor_user_id = v_actor_user_id",
    "credential.tenant_id = hosted_read.owner_tenant",
    "credential.id = hosted_mark.credential_id",
    "hosted_mark.requested_capability = any(credential.capabilities)",
    "v_existing.provider <> hosted_mutation.mutation->>'provider'",
    "not has_table_privilege('service_role', 'public.hosted_byok_credentials', 'UPDATE')",
    "hosted credential security posture unavailable",
    "values ('production_identity_billing', '20260801213000')",
  ]) {
    assert.equal(
      hostedByokAmbiguityHardeningMigration.includes(fragment),
      true,
      `missing hosted BYOK gate11 ambiguity hardening SQL: ${fragment}`,
    );
  }
  assert.equal(
    createHash("sha256")
      .update(hostedByokAmbiguityHardeningMigration)
      .digest("hex"),
    "47932687c67c98fb0aa3f2484ac06414f491086ef4ac512b92827ffba1a646de",
    "already-applied gate11 migration must remain byte-identical",
  );
  for (const fragment of [
    "20260801213000",
    "create or replace function public.aistory_hosted_byok_list",
    "create or replace function public.aistory_hosted_byok_read_encrypted",
    "create or replace function public.aistory_hosted_byok_apply_mutation",
    "create or replace function public.aistory_hosted_byok_mark_used",
    "v_mutation := $1",
    "app_user.id = v_owner_user_id",
    "credential.id = v_credential_id",
    "v_existing.provider <> v_mutation->>'provider'",
    "hosted credential security posture unavailable",
    "values ('production_identity_billing', '20260802113000')",
  ]) {
    assert.equal(
      hostedByokRuntimeHardeningMigration.includes(fragment),
      true,
      `missing hosted BYOK gate12 runtime hardening SQL: ${fragment}`,
    );
  }
  for (const forbiddenRuntimeQualifier of [
    "hosted_mutation.mutation",
    "hosted_list.owner_user_id",
    "hosted_read.credential_id",
    "hosted_mark.credential_id",
  ]) {
    assert.equal(
      hostedByokRuntimeHardeningMigration.includes(forbiddenRuntimeQualifier),
      false,
      `gate12 must not retain block-label SQL qualifier ${forbiddenRuntimeQualifier}`,
    );
  }
  assert.equal(
    createHash("sha256")
      .update(hostedByokRuntimeHardeningMigration)
      .digest("hex"),
    "92e514c3d73228e64e02865a34e560e7e0d52933c8d9202f0786445eedc407c1",
    "gate12 runtime qualification migration must remain byte-identical",
  );
  assert.equal(
    hostedByokRuntimeHardeningMigration.match(/#variable_conflict error/g)?.length,
    4,
    "every hosted PL/pgSQL RPC must compile with ambiguity errors enabled",
  );
  const hostedDeclareBlocks = [
    ...hostedByokRuntimeHardeningMigration.matchAll(/\bdeclare\b([\s\S]*?)\bbegin\b/gi),
  ].map((match) => match[1]);
  for (const declareBlock of hostedDeclareBlocks) {
    assert.equal(
      /^\s+(?:actor_user_id|tenant_id|credential_id|request_id|provider|capability)\s+[^;]+;/im
        .test(declareBlock),
      false,
      "hosted RPC locals must not reuse security-sensitive column names",
    );
  }
  for (const identifier of [
    "actor_user_id",
    "tenant_id",
    "credential_id",
    "request_id",
    "provider",
    "capability",
  ]) {
    assert.equal(
      new RegExp(`(?<![.\\w])${identifier}\\s*(?:=|<>|\\bis\\b|\\bin\\b)`, "i")
        .test(hostedByokRuntimeHardeningMigration),
      false,
      `hosted RPC security identifier must be qualified: ${identifier}`,
    );
  }
  assert.equal(
    hostedByokRuntimeHardeningMigration.includes("20260801213000"),
    true,
    "gate12 must document its immutable gate11 predecessor",
  );
  for (const fragment of [
    "phone admin gate requires gate12",
    "user_roles_user_id_app_user_fkey",
    "user_roles_created_by_app_user_fkey",
    "admin_audit_logs_actor_id_app_user_fkey",
    "admin_bootstrap_allowlist_user_id_app_user_fkey",
    "create or replace function public.aistory_bootstrap_phone_super_admin",
    "phone bootstrap service role required",
    "phone bootstrap identity unavailable",
    "phone bootstrap idempotency conflict",
    "one-time production phone bootstrap",
    "create or replace function public.aistory_phone_admin_security_posture",
    "to service_role",
    `values ('production_identity_billing', '${PHONE_ADMIN_DB_GATE_VERSION}')`,
  ]) {
    assert.equal(
      phoneAdminIdentityMigration.includes(fragment),
      true,
      `missing phone admin gate SQL: ${fragment}`,
    );
  }
  assert.equal(
    /grant\s+execute[\s\S]{0,180}aistory_bootstrap_phone_super_admin[\s\S]{0,100}\b(?:anon|authenticated)\b/i
      .test(phoneAdminIdentityMigration),
    false,
    "phone bootstrap RPC must never be executable by browser roles",
  );
  assert.equal(
    phoneAdminIdentityMigration.includes("insert into public.auth.users"),
    false,
    "phone administrator identities must not forge Supabase Auth users",
  );
  const phoneAdminMigrationDigest = createHash("sha256")
    .update(phoneAdminIdentityMigration)
    .digest("hex");
  assert.equal(
    phoneAdminMigrationDigest,
    "b922f10078f0eccda9fbb8fc9b821d4d6eb55acb1014db076f96d1788936d32e",
    "reviewed Gate13 migration must remain byte-identical",
  );
  for (const [label, source] of [
    ["environment example", environmentExample],
    ["agent guide", agentGuide],
    ["production gate runbook", productionGateRunbook],
  ] as const) {
    assert.equal(
      source.includes(PRODUCTION_IDENTITY_DB_GATE_VERSION),
      true,
      `${label} must name the current Gate14 version`,
    );
  }
  assert.equal(
    phoneAdminRunbook.includes(PHONE_ADMIN_DB_GATE_VERSION),
    true,
    "the immutable Gate13 runbook must retain its own reviewed version",
  );
  assert.equal(
    agentGuide.includes(
      "supabase/migrations/20260809113000_phone_admin_identity_gate.sql",
    ),
    true,
    "agent guide must include the current Gate13 migration",
  );
  assert.equal(
    productionGateRunbook.includes(
      `AISTORY_DATABASE_GATE_VERSION=${PRODUCTION_IDENTITY_DB_GATE_VERSION}`,
    ),
    true,
    "production runbook must configure the same gate expected by runtime",
  );
  assert.equal(
    phoneAdminRunbook.includes(phoneAdminMigrationDigest),
    true,
    "Gate13 runbook must publish the reviewed migration digest",
  );
  for (const fragment of [
    "video asset metadata gate requires gate13",
    "create table if not exists public.video_assets",
    "create table if not exists public.video_asset_idempotency",
    "alter table public.video_assets force row level security",
    "alter table public.video_asset_idempotency force row level security",
    "create or replace function public.aistory_video_asset_create",
    "create or replace function public.aistory_video_asset_mutate",
    "create or replace function public.aistory_video_asset_security_posture",
    `values ('production_identity_billing', '${VIDEO_ASSET_DB_GATE_VERSION}')`,
  ]) {
    assert.equal(
      videoAssetMetadataMigration.includes(fragment),
      true,
      `missing production video-asset Gate14 SQL: ${fragment}`,
    );
  }
  assert.equal(
    videoAssetMetadataMigration.includes(PHONE_ADMIN_DB_GATE_VERSION),
    true,
    "Gate14 must require the immutable Gate13 predecessor",
  );
  assert.equal(
    Buffer.byteLength(videoAssetMetadataMigration, "utf8"),
    VIDEO_ASSET_GATE_BYTES,
    "the reviewed Gate14 migration byte length must remain frozen",
  );
  const videoAssetGateDigest = createHash("sha256")
    .update(videoAssetMetadataMigration)
    .digest("hex");
  assert.equal(
    videoAssetGateDigest,
    VIDEO_ASSET_GATE_SHA256,
    "the reviewed Gate14 migration digest must remain frozen",
  );
  assert.match(videoAssetRunbook, new RegExp(`bytes: .${VIDEO_ASSET_GATE_BYTES}.`));
  assert.equal(videoAssetRunbook.includes(VIDEO_ASSET_GATE_SHA256), true);
  for (const invariant of [
    "pg_catalog.pg_advisory_xact_lock",
    "for update",
    "asset_row.revision = v_expected_revision",
    "insert into public.video_assets",
    "insert into public.video_asset_idempotency",
    "insert into public.admin_audit_logs",
    "video_asset_idempotency_append_only",
    "video_assets_object_key_check",
    "video_assets_probe_check",
    "video_assets_binding_check",
    "video_assets_tenant_object_key_idx",
  ]) {
    assert.match(
      videoAssetMetadataMigration,
      new RegExp(invariant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
      `Gate14 must retain ${invariant}`,
    );
  }
  assert.doesNotMatch(
    videoAssetMetadataMigration,
    /video_assets_object_key_unique/i,
    "multiple metadata assets may safely reference one content-addressed object",
  );
  for (const rpc of [
    "aistory_video_asset_list\\(text, integer\\)",
    "aistory_video_asset_get\\(text, text\\)",
    "aistory_video_asset_find_idempotency\\(text, text\\)",
    "aistory_video_asset_has_object_reference\\(text, text\\)",
    "aistory_video_asset_create\\(jsonb\\)",
    "aistory_video_asset_mutate\\(jsonb\\)",
  ]) {
    assert.match(
      videoAssetMetadataMigration,
      new RegExp(
        `revoke all on function public\\.${rpc}\\s+from public, anon, authenticated, service_role`,
        "i",
      ),
    );
  }
  for (const rpc of [
    "aistory_video_asset_list",
    "aistory_video_asset_get",
    "aistory_video_asset_find_idempotency",
    "aistory_video_asset_has_object_reference",
    "aistory_video_asset_create",
    "aistory_video_asset_mutate",
    "aistory_video_asset_security_posture",
  ]) {
    assert.match(
      videoAssetMetadataMigration,
      new RegExp(
        `create or replace function public\\.${rpc}[\\s\\S]*?security definer[\\s\\S]*?set search_path = pg_catalog, public`,
        "i",
      ),
      `${rpc} must remain SECURITY DEFINER with a fixed search_path`,
    );
  }
  const auditSummaryBody = /create or replace function public\.aistory_video_asset_audit_summary[\s\S]*?\$\$;/.exec(
    videoAssetMetadataMigration,
  )?.[0] ?? "";
  assert.ok(auditSummaryBody);
  assert.doesNotMatch(
    auditSummaryBody,
    /storage|object_key|etag|generation|provider_task|workflow|prompt|local_path/i,
  );
  assert.match(
    videoAssetMetadataMigration.trim(),
    new RegExp(
      `insert into public\\.aistory_schema_gates[\\s\\S]*?'${VIDEO_ASSET_DB_GATE_VERSION}'[\\s\\S]*?installed_at = now\\(\\);$`,
      "i",
    ),
    "the Gate14 version advance must be the final migration action",
  );
  assert.equal(
    stagingHarnessSource.includes("AISTORY_STAGING_HOSTED_BYOK_TEST_ENABLED"),
    true,
    "staging harness must provide an explicit hosted RPC validation gate",
  );
  assert.equal(
    adminSecuritySource.includes("resolveProductionAdminRoles(userId)"),
    true,
    "production admin roles must resolve through the service-side RPC port",
  );
  assert.equal(
    adminSecuritySource.includes(
      "resolveProductionAdminRoles(phoneSession.userId)",
    ),
    false,
    "ordinary verified phone sessions must never resolve administrator roles",
  );
  assert.equal(
    adminSecuritySource.includes("readPhoneUserSession"),
    false,
    "administrator authorization must remain independent from phone sessions",
  );
  assert.equal(
    adminSecuritySource.includes('.from("user_roles")'),
    false,
    "admin login must not query user_roles directly",
  );
  for (
    const rpcName of [
      "aistory_admin_read_snapshot",
      "aistory_service_read_dataset",
    ]
  ) {
    assert.equal(
      adminRepositorySource.includes(rpcName),
      true,
      `production repository must use ${rpcName}`,
    );
  }
  for (
    const forbiddenDirectRead of [
      "profiles",
      "user_roles",
      "credit_accounts",
      "credit_ledger",
      "billing_policies",
      "platform_settings",
      "payment_provider_configs",
      "platform_provider_configs",
      "admin_audit_logs",
    ]
  ) {
    assert.equal(
      adminRepositorySource.includes(`.from("${forbiddenDirectRead}")`),
      false,
      `production repository must not read ${forbiddenDirectRead} directly`,
    );
  }
  assert.equal(
    bootstrapRouteSource.includes('supabase.rpc("bootstrap_super_admin"'),
    true,
    "the historical Supabase bootstrap must remain on its isolated RPC",
  );
  assert.equal(
    bootstrapRouteSource.includes("bootstrap:${userId}"),
    true,
    "legacy bootstrap retries must use one stable identity-bound request id",
  );
  assert.equal(
    bootstrapRouteSource.includes("isExactSameOrigin(request)"),
    true,
    "legacy bootstrap must reject cross-origin POST requests",
  );
  assert.equal(
    bootstrapRouteSource.includes("originUrl.origin === requestUrl.origin"),
    true,
    "legacy bootstrap must compare the exact request and Origin schemes/ports",
  );
  assert.equal(
    bootstrapRouteSource.includes("aistory_bootstrap_phone_super_admin"),
    false,
    "the bootstrap route must not promote a verified phone identity",
  );
  assert.equal(
    bootstrapRouteSource.includes("phone-bootstrap:${phoneSession.userId}"),
    false,
    "the bootstrap route must not derive requests from a phone session",
  );
  assert.equal(
    bootstrapRouteSource.includes("readPhoneUserSession"),
    false,
    "the legacy bootstrap must remain independent from phone authentication",
  );
  assert.equal(
    adminLoginSource.includes('/api/admin/bootstrap'),
    false,
    "ordinary phone login must not invoke administrator bootstrap",
  );
  assert.equal(
    stagingHarnessSource.indexOf(
      "admin staging integration skipped (zero-network default)",
    ) < stagingHarnessSource.indexOf("AISTORY_STAGING_SUPABASE_URL"),
    true,
    "staging harness must stop before reading connection settings by default",
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

  const snapshotRpcCalls: string[] = [];
  const snapshotRepository = new SupabaseAdminRepository(
    {
      async rpc(name: string, args: Record<string, unknown>) {
        snapshotRpcCalls.push(name);
        assert.equal(name, "aistory_admin_read_snapshot");
        assert.deepEqual(args, {
          actor_user_id: mutationAudit.actorId,
          actor_tenant: "platform",
        });
        return {
          data: {
            users: [{
              user_id: projectedUser.userId,
              tenant_id: "platform",
              display_name: projectedUser.displayName,
              masked_contact: projectedUser.maskedContact,
              status: projectedUser.status,
              user_type: projectedUser.userType,
              tags: projectedUser.tags,
              created_at: projectedUser.createdAt,
            }],
            roles: [],
            accounts: [],
            ledger: [],
            events: [],
            settings: [],
            payment_configs: [],
            provider_configs: [],
            domains: [],
            channel_apps: [],
            audit: [],
            billing_policies: [],
          },
          error: null,
        };
      },
      from() {
        throw new Error("sensitive admin reads must not use direct table access");
      },
    } as never,
    {
      actorId: mutationAudit.actorId,
      tenantId: "platform",
    },
  );
  assert.deepEqual(await snapshotRepository.listUsers(), [projectedUser]);
  assert.deepEqual(await snapshotRepository.listLedger(), []);
  assert.deepEqual(await snapshotRepository.listAudit(), []);
  assert.deepEqual(snapshotRpcCalls, ["aistory_admin_read_snapshot"]);

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
    AISTORY_ANONYMOUS_SESSION_SECRET:
      "fixture-anonymous-session-secret-123456789",
    AISTORY_ANONYMOUS_SUBJECT_PEPPER:
      "fixture-anonymous-subject-pepper-123456789",
    NEXT_PUBLIC_SUPABASE_URL: "https://fixture.invalid",
    SUPABASE_SERVICE_ROLE_KEY: secretFixture,
  };
  const ready = inspectProductionDatabaseGate(readyEnvironment);
  assert.equal(ready.ready, true);
  assert.equal(JSON.stringify(ready).includes(secretFixture), false);
  const serverOnlyReady = inspectProductionDatabaseGate({
    ...readyEnvironment,
    NEXT_PUBLIC_SUPABASE_URL: undefined,
    AISTORY_SUPABASE_SERVER_URL: "http://127.0.0.1:15432",
  });
  assert.equal(serverOnlyReady.ready, true);
  assert.equal(
    rewriteSupabaseRestUrlForPostgrestRoot(
      "http://127.0.0.1:15432/rest/v1/rpc/aistory_database_gate_status",
      "http://127.0.0.1:15432",
    ),
    "http://127.0.0.1:15432/rpc/aistory_database_gate_status",
    "server-only production client must bridge supabase-js /rest/v1 to raw PostgREST",
  );
  assert.deepEqual(
    inspectProductionDatabaseGate({}).missing.sort(),
    [
      "admin_repository",
      "anonymous_session_secret",
      "anonymous_subject_pepper",
      "database_gate_version",
      "identity_repository",
      "production_identity_enabled",
      "service_role",
      "supabase_url",
    ].sort(),
  );
  assert.equal(
    inspectProductionDatabaseGate({
      ...readyEnvironment,
      AISTORY_DATABASE_GATE_VERSION: "20260801193000",
    }).ready,
    false,
    "the applied gate10 must not pass the gate12 runtime hardening check",
  );
  assert.equal(
    inspectProductionDatabaseGate({
      ...readyEnvironment,
      AISTORY_DATABASE_GATE_VERSION: "20260801213000",
    }).ready,
    false,
    "the applied gate11 must not pass the gate12 runtime hardening check",
  );
  Object.assign(process.env, readyEnvironment);
  await assertProductionDatabaseGateReady("identity", {
    async rpc(name: string) {
      if (name === "aistory_database_gate_status") {
        return { data: PRODUCTION_IDENTITY_DB_GATE_VERSION, error: null };
      }
      if (name === "aistory_database_security_posture") {
        return { data: true, error: null };
      }
      if (name === "aistory_hosted_byok_security_posture") {
        return { data: true, error: null };
      }
      return { data: true, error: null };
    },
  });
  await assert.rejects(
    assertProductionDatabaseGateReady("identity", {
      async rpc(name: string) {
        if (name === "aistory_database_gate_status") {
          return { data: PRODUCTION_IDENTITY_DB_GATE_VERSION, error: null };
        }
        if (name === "aistory_video_asset_security_posture") {
          return { data: false, error: null };
        }
        return { data: true, error: null };
      },
    }),
    ProductionDatabaseGateError,
    "Gate14 must fail closed when the database-owned video posture is false",
  );
  await assert.rejects(
    assertProductionDatabaseGateReady("identity", {
      async rpc(name: string) {
        if (name === "aistory_database_gate_status") {
          return { data: PRODUCTION_IDENTITY_DB_GATE_VERSION, error: null };
        }
        if (name === "aistory_database_security_posture") {
          return { data: true, error: null };
        }
        if (name === "aistory_hosted_byok_security_posture") {
          return { data: true, error: null };
        }
        return { data: false, error: null };
      },
    }),
    ProductionDatabaseGateError,
    "the version must not pass when the DB-owned security posture is false",
  );

  Object.assign(process.env, {
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
