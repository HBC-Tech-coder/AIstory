import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(path, "utf8");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const [
  migration,
  envelope,
  repository,
  config,
  predecessorMigration,
  predecessorEnvelope,
  pg16,
] = await Promise.all([
  read("supabase/migrations/20261115000000_aiuser_linked_billing_gate.sql"),
  read("scripts/apply-aiuser-linked-billing-ledger.psql"),
  read("lib/auth/aiUserLinkedBillingRepository.ts"),
  read("lib/auth/aiUserLinkedBillingConfig.ts"),
  read("supabase/migrations/20260901040000_aiuser_account_link_gate.sql"),
  read("scripts/apply-aiuser-account-link-ledger.psql"),
  read("scripts/test-aiuser-linked-billing-postgres16.mjs"),
]);

let checks = 0;
const migrationHash = sha256(migration);
const predecessorHash = sha256(predecessorMigration);
const productionPredecessorHash = "2b506307e1b5e42a16ca79d4c3973e44d410cdd00d4228faed012252b3960dc6";
assert.match(migrationHash, /^[a-f0-9]{64}$/);
checks++;
assert.equal(envelope.split(migrationHash).length, 3, "ledger insert and postflight must pin exact migration bytes");
checks++;
assert.equal(envelope.split("\\ir ../supabase/migrations/20261115000000_aiuser_linked_billing_gate.sql").length, 2);
checks++;

// The predecessor SQL and its ledger remain byte-identical to the snapshot.
assert.equal(predecessorHash, "da47fb94396b290e4c00d515e5d8039f010113d87307e2ff5298079a66bf3bec");
checks++;
assert.equal(predecessorEnvelope.split(predecessorHash).length, 3);
checks++;

export function validatePgAreBoundedRepetitions(sqlText) {
  assert.equal(typeof sqlText, "string", "PostgreSQL ARE source must be text");
  const repetitions = [...sqlText.matchAll(/\{(\d+)(?:,(\d*))?\}/g)];
  assert.ok(repetitions.length > 0, "migration must expose its PostgreSQL bounded repetitions to static review");
  for (const match of repetitions) {
    const lower = Number(match[1]);
    const upper = match[2] === undefined ? lower : match[2] === "" ? null : Number(match[2]);
    assert.ok(lower <= 255 && (upper === null || upper <= 255), `PostgreSQL ARE bound exceeds 255: ${match[0]}`);
  }
  return repetitions.map((match) => match[0]);
}
const pgBoundedRepetitions = validatePgAreBoundedRepetitions(migration);
checks += pgBoundedRepetitions.length + 1;
assert.throws(() => validatePgAreBoundedRepetitions("value ~ 'x{1,300}'"), /PostgreSQL ARE bound exceeds 255: \{1,300\}/);
checks++;

// --- Atomic ledger envelope -------------------------------------------------
for (const marker of [
  "\\set ON_ERROR_STOP on", "begin;", "commit;", "set local search_path=pg_catalog;",
  "set local check_function_bodies=on;", "set local plpgsql.extra_errors='shadowed_variables';",
  "select pg_advisory_xact_lock(20261115,150000);",
  "lock table supabase_migrations.schema_migrations in share row exclusive mode;",
  "LINKED_BILLING_LEDGER_OWNER_REJECTED", "LINKED_BILLING_LEDGER_SHAPE_REJECTED",
  "LINKED_BILLING_LEDGER_PREDECESSOR_REJECTED", "LINKED_BILLING_LEDGER_POSTFLIGHT_REJECTED",
  "PASS_AIUSER_LINKED_BILLING_ATOMIC_LEDGER",
]) {
  assert.ok(envelope.includes(marker), `ledger marker missing: ${marker}`);
  checks++;
}
assert.match(envelope, /perform 1 from supabase_migrations\.schema_migrations where version in \('20260811193000','20260901040000'\) for update;/);
checks++;
for (const identity of [
  ["20260811193000", "20260811193000_production_video_asset_metadata_gate.sql", productionPredecessorHash],
  ["20260901040000", "20260901040000_aiuser_account_link_gate.sql", predecessorHash],
]) {
  assert.ok(envelope.includes(`version='${identity[0]}'`), `predecessor version missing: ${identity[0]}`);
  assert.ok(envelope.includes(identity[1]), `predecessor name missing: ${identity[1]}`);
  assert.ok(envelope.includes(identity[2]), `predecessor sha missing: ${identity[2]}`);
  checks += 3;
}
const includeIndex = envelope.indexOf("\\ir ../supabase/migrations/20261115000000_aiuser_linked_billing_gate.sql");
const firstLedgerInsert = envelope.indexOf("insert into supabase_migrations.schema_migrations");
assert.ok(includeIndex > 0 && firstLedgerInsert > includeIndex, "ledger row must be appended only after migration DDL");
checks++;
assert.doesNotMatch(envelope, /create table supabase_migrations|alter table supabase_migrations|create schema supabase_migrations/i);
checks++;

// --- Forward-only resolver migration ---------------------------------------
for (const marker of [
  "set local search_path = pg_catalog;", "set local check_function_bodies = on;",
  "LINKED_BILLING_GATE_UNAVAILABLE", "LINKED_BILLING_UNAVAILABLE", "LINKED_BILLING_POSTURE_FAILED",
  "LINKED_BILLING_IMMUTABLE",
]) {
  assert.ok(migration.includes(marker), `migration marker missing: ${marker}`);
  checks++;
}
assert.match(migration, /to_regprocedure\('public\.aistory_aiuser_link_posture\(\)'\) is null/);
assert.match(migration, /public\.aistory_aiuser_link_posture\(\) is distinct from '20260901040000'/);
assert.match(migration, /public\.aistory_database_gate_status\(\) is distinct from '20260811193000'/);
assert.match(migration, /gate_name='aiuser_account_link'\) is distinct from '20260901040000'/);
checks += 4;
assert.doesNotMatch(migration, /\bdrop\s+(?:table|function|trigger|schema)\b/i);
checks++;
assert.doesNotMatch(migration, /create\s+(?:or\s+replace\s+)?function\s+public\.aistory_aiuser_link_/i);
checks++;
assert.doesNotMatch(migration, /insert\s+into\s+public\.aiuser_account_link_catalog_manifest/i);
checks++;
for (const forbidden of [
  /insert\s+into\s+public\.aiuser_account_links/i,
  /update\s+public\.aiuser_account_links/i,
  /delete\s+from\s+public\.aiuser_account_links/i,
  /truncate\s+public\.aiuser_account_links/i,
  /insert\s+into\s+public\.app_users/i,
  /update\s+public\.app_users/i,
  /delete\s+from\s+public\.app_users/i,
  /insert\s+into\s+public\.(?:credit_|credits|ledger)/i,
  /update\s+public\.(?:credit_|credits|ledger)/i,
  /hosted_credentials/i,
  /independent_admin/i,
  /authType/i,
  /auth_type\s*=/i,
]) {
  assert.doesNotMatch(migration, forbidden);
  checks++;
}

// Manifest table: owner-only, forced RLS, immutable.
assert.match(migration, /create table public\.aiuser_linked_billing_catalog_manifest \(/);
assert.match(migration, /alter table public\.aiuser_linked_billing_catalog_manifest enable row level security/);
assert.match(migration, /alter table public\.aiuser_linked_billing_catalog_manifest force row level security/);
assert.match(migration, /revoke all on public\.aiuser_linked_billing_catalog_manifest from public,anon,authenticated,service_role;/);
assert.match(migration, /create trigger aiuser_linked_billing_catalog_manifest_immutable[\s\S]*for each statement execute function public\.aistory_aiuser_linked_billing_immutable\(\);/);
checks += 5;

// Resolver: exact service-role-only shape and read-only query.
assert.match(migration, /create function public\.aistory_aiuser_linked_billing_resolve\(principal_hash text\) returns uuid/);
assert.match(migration, /language plpgsql stable security definer set search_path=pg_catalog/);
assert.match(migration, /current_setting\('request\.jwt\.claim\.role',true\) is distinct from 'service_role'/);
assert.match(migration, /public\.aistory_aiuser_linked_billing_posture\(\) is distinct from '20261115000000'/);
assert.match(migration, /principal_hash !~ '\^\[a-f0-9\]\{64\}\$'/);
assert.match(migration, /from public\.aiuser_account_links l\s+join public\.app_users u on u\.id=l\.phone_user_id/);
assert.match(migration, /join public\.phone_identities p on p\.user_id=u\.id/);
assert.match(migration, /l\.tenant_id='platform'/);
assert.match(migration, /u\.tenant_id='platform'/);
assert.match(migration, /u\.identity_type='phone'/);
assert.match(migration, /u\.status='active'/);
assert.match(migration, /if v_phone_user_id is null then return null; end if;/);
checks += 11;
const resolveStart = migration.indexOf("create function public.aistory_aiuser_linked_billing_resolve");
const resolveEnd = migration.indexOf("create function public.aistory_aiuser_linked_billing_catalog", resolveStart);
const resolverBody = migration.slice(resolveStart, resolveEnd);
assert.ok(resolveStart >= 0 && resolveEnd > resolveStart);
checks++;
for (const write of [/\binsert\b/i, /\bupdate\b/i, /\bdelete\b/i, /\btruncate\b/i, /\bmerge\b/i]) {
  assert.doesNotMatch(resolverBody, write);
  checks++;
}

// Independent posture: new gate + old link gate + exact mechanical shape/ACL.
assert.match(migration, /create or replace function public\.aistory_aiuser_linked_billing_posture\(\) returns text/);
assert.match(migration, /return '20261115000000';/);
assert.match(migration, /public\.aistory_aiuser_link_posture\(\) is distinct from '20260901040000'/);
assert.match(migration, /public\.aistory_database_gate_status\(\) is distinct from '20260811193000'/);
assert.match(migration, /gate_name='aiuser_linked_billing'\) is distinct from '20261115000000'/);
assert.match(migration, /proowner='postgres'::regrole/);
assert.match(migration, /proconfig=array\['search_path=pg_catalog'\]/);
assert.match(migration, /not proleakproof/);
assert.match(migration, /prosecdef=/);
assert.match(migration, /provolatile='s'/);
assert.match(migration, /has_function_privilege\('service_role',v_function,'EXECUTE'\)/);
assert.match(migration, /proargtypes\[0\]='text'::regtype/);
assert.match(migration, /prorettype='uuid'::regtype/);
assert.match(migration, /tgtype=58/);
assert.match(migration, /except select object_key,definition_sha256 from public\.aiuser_linked_billing_catalog_manifest/);
assert.match(migration, /except select object_key,definition_sha256 from public\.aistory_aiuser_linked_billing_catalog\(\)/);
assert.match(migration, /tgtype=58/);
checks += 17;
for (const fn of [
  "aistory_aiuser_linked_billing_resolve(text)",
  "aistory_aiuser_linked_billing_posture()",
  "aistory_aiuser_linked_billing_catalog()",
  "aistory_aiuser_linked_billing_immutable()",
]) {
  assert.ok(migration.includes(fn));
  checks++;
}
assert.match(migration, /revoke all on function public\.aistory_aiuser_linked_billing_posture\(\),\s+public\.aistory_aiuser_linked_billing_resolve\(text\) from public,anon,authenticated,service_role;/);
assert.match(migration, /grant execute on function public\.aistory_aiuser_linked_billing_posture\(\),\s+public\.aistory_aiuser_linked_billing_resolve\(text\) to service_role;/);
checks += 2;
assert.doesNotMatch(migration, /grant\s+execute\s+on\s+function[^;]+to\s+(?:public|anon|authenticated)/i);
checks++;
assert.doesNotMatch(migration, /grant\s+(?:select|insert|update|delete|truncate|all)\s+on\s+(?:table\s+)?public\./i);
checks++;
assert.match(migration, /insert into public\.aiuser_linked_billing_catalog_manifest\(object_key,definition_sha256\)/);
assert.match(migration, /insert into public\.aistory_schema_gates\(gate_name,version\) values\('aiuser_linked_billing','20261115000000'\);/);
assert.match(migration, /if public\.aistory_aiuser_linked_billing_posture\(\) is distinct from '20261115000000'/);
checks += 3;

// --- Client module static contract ----------------------------------------
assert.match(config, /AISTORY_AIUSER_LINKED_BILLING_MODE/);
assert.match(config, /aistory-aiuser-linked-billing-v1:enabled/);
assert.match(config, /process\.env\[AIUSER_LINKED_BILLING_ENV\] === AIUSER_LINKED_BILLING_MODE/);
assert.doesNotMatch(config, /AISTORY_AIUSER_ACCOUNT_LINK/);
assert.doesNotMatch(config, /aiUserAccountLinkSelected|RevocationSelected/);
checks += 5;
assert.match(repository, /AIUSER_LINKED_BILLING_GATE = "20261115000000"/);
assert.match(repository, /client\.rpc\("aistory_aiuser_linked_billing_posture_claims_v1"\)/);
assert.match(repository, /client\.rpc\("aistory_aiuser_linked_billing_resolve_claims_v1", \{/);
assert.match(repository, /principal_hash: principalKey/);
assert.match(repository, /const PHONE_UUID = \/\^\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[1-8\]\[0-9a-f\]\{3\}-\[89ab\]\[0-9a-f\]\{3\}-\[0-9a-f\]\{12\}\$\//);
assert.match(repository, /const PRINCIPAL_HASH = \/\^\[a-f0-9\]\{64\}\$\//);
assert.match(repository, /async function resolvePhoneUserId\(/);
assert.match(repository, /Promise<AiUserLinkedBillingPhoneUserId \| null>/);
assert.match(repository, /async requirePhoneUserId\(principalKey\)/);
assert.match(repository, /if \(result\.data === null\) return null;/);
assert.match(repository, /if \(phoneUserId === null\) unavailable\(\)/);
assert.match(repository, /class AiUserLinkedBillingUnavailableError extends Error/);
assert.match(repository, /readonly code = "LINKED_BILLING_UNAVAILABLE"/);
assert.match(repository, /if \(!aiUserLinkedBillingSelected\(\)\) unavailable\(\)/);
checks += 8;
assert.doesNotMatch(repository, /phone_user_id|userId|user_id|authType|identity_type/);
checks++;
for (const forbidden of [
  /\.insert\s*\(/, /\.update\s*\(/, /\.delete\s*\(/, /\.upsert\s*\(/,
  /aistory_aiuser_link_prepare|aistory_aiuser_link_confirm|aistory_aiuser_link_revoke_sessions/,
  /aistory_aiuser_link_is_linked/,
  /\bfetch\s*\(/, /\bwindow\b/, /\bdocument\b/, /localStorage|sessionStorage/,
]) {
  assert.doesNotMatch(repository, forbidden);
  checks++;
}

// Replacement tests are self-contained; they do not claim a PG16 pass.
assert.ok(pg16.includes("PG16_LINKED_BILLING_BLOCKED"));
assert.ok(pg16.includes("BLOCKED_DOCKER_UNAVAILABLE"));
assert.ok(pg16.includes("PASS_AIUSER_LINKED_BILLING_POSTGRES16"));
assert.equal((pg16.match(/\bconsole\.log\s*\(/g) ?? []).length, 1);
checks += 4;

console.log(JSON.stringify({
  status: "PASS_AIUSER_LINKED_BILLING_STATIC_CONTRACT",
  checks,
  migrationSha256: migrationHash,
  predecessorSha256: predecessorHash,
  productionPredecessorSha256: productionPredecessorHash,
  externalNetwork: 0,
  credentialsRead: false,
  databaseExecuted: false,
  deployment: false,
}));
