/**
 * Isolated PG16.15 qualification candidate for the AIUser linked-phone billing
 * resolver. It extends the copied account-link runner only through this new
 * file: container/image helpers and SQL-failure classifiers are imported from
 * `test-aiuser-account-link-postgres16.mjs`, which is never modified here.
 *
 * This runner is intentionally fail-closed. It reports BLOCKED (never PASS)
 * when the Docker daemon or the full migration baseline is unavailable. A PASS
 * requires an actual isolated PG16.15 container and the complete baseline list.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, readFile } from "node:fs/promises";

import {
  approvedImageReferences,
  checked,
  selectImageReference,
  validateImageMetadata,
  validateExpectedSqlFailure,
} from "./test-aiuser-account-link-postgres16.mjs";

const baseline = [
  "20260624135618_stories.sql", "20260628095015_upsert_story_if_newer.sql", "20260726174500_admin_console_p1.sql",
  "20260727193000_platform_provider_credentials.sql", "20260728193000_phone_billing_p1.sql",
  "20260729093000_production_identity_billing_gate.sql", "20260729183000_anonymous_phone_claim_gate.sql",
  "20260731120000_sensitive_identity_billing_privilege_hardening.sql", "20260731183000_admin_identity_rpc_read_gate.sql",
  "20260801193000_hosted_byok_vault_gate.sql", "20260801213000_hosted_byok_rpc_ambiguity_hardening.sql",
  "20260802113000_hosted_byok_rpc_runtime_qualification_hardening.sql", "20260809113000_phone_admin_identity_gate.sql",
  "20260811193000_production_video_asset_metadata_gate.sql",
];
const linkMigrationName = "20260901040000_aiuser_account_link_gate.sql";
const linkEnvelopeName = "scripts/apply-aiuser-account-link-ledger.psql";
const billingMigrationName = "20261115000000_aiuser_linked_billing_gate.sql";
const billingEnvelopeName = "scripts/apply-aiuser-linked-billing-ledger.psql";
const expectedServer = "160015|16.15 (Debian 16.15-1.pgdg13+2)|postgres|postgres|1|t|f";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const containerName = `aistory-aiuser-linked-billing-pg16-${process.pid}-${randomBytes(4).toString("hex")}`;
const gates = [];
const image = selectImageReference(process.argv.slice(2));
let containerId;
let stage = "PREFLIGHT";
let imageId;
let databaseExecuted = false;

function finish(status, extra = {}, exitCode = 0) {
  console.log(JSON.stringify({ status, ...extra }));
  if (exitCode) process.exitCode = exitCode;
}

function docker(args, input, timeoutMs = 60000) {
  return spawnSync("docker", args, {
    input,
    encoding: "utf8",
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 4_000_000,
  });
}

const psqlArgs = (database = "postgres") => ["exec", "-i", containerId, "psql", "-h", "/var/run/postgresql",
  "-U", "postgres", "-d", database, "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-1"];
const sql = (text, label) => { stage = label; databaseExecuted = true;
  return checked(docker(psqlArgs(), `\\set VERBOSITY verbose\n${text}`), label); };
const mustFail = (text, label, expected) => {
  stage = label;
  databaseExecuted = true;
  validateExpectedSqlFailure(docker(psqlArgs(), `\\set VERBOSITY verbose\n${text}`), label, expected);
  gates.push(label);
};
function plainObject(value) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), "PG16_POSTURE_SHAPE_REJECTED");
  return value;
}
function inspectJson(args, label) {
  stage = label;
  const value = JSON.parse(checked(docker(args), label));
  assert.ok(Array.isArray(value) && value.length === 1, `${label}_SHAPE_REJECTED`);
  return plainObject(value[0]);
}
function verifyContainerPosture(container, running) {
  stage = running ? "RUNNING_CONTAINER_POSTURE" : "CREATED_CONTAINER_POSTURE";
  const config = plainObject(container.Config), host = plainObject(container.HostConfig);
  const network = plainObject(container.NetworkSettings), state = plainObject(container.State);
  assert.equal(container.Id, containerId);
  assert.equal(container.Name, `/${containerName}`);
  assert.equal(container.Image, imageId);
  assert.equal(config.Image, image);
  assert.equal(container.Platform, "linux");
  assert.equal(state.Running, running);
  assert.equal(plainObject(config.Labels)["aistory.purpose"], "aiuser-linked-billing-qualification");
  assert.equal(host.NetworkMode, "none");
  assert.equal(host.AutoRemove, true);
  assert.equal(host.PublishAllPorts, false);
  assert.ok(!host.PortBindings || Object.keys(plainObject(host.PortBindings)).length === 0);
  const tmpfs = plainObject(host.Tmpfs);
  assert.deepEqual(Object.keys(tmpfs).sort(), ["/var/lib/postgresql/data", "/var/run/postgresql"]);
  assert.equal(tmpfs["/var/lib/postgresql/data"], "rw,noexec,nosuid,size=768m");
  assert.equal(tmpfs["/var/run/postgresql"], "rw,nosuid,size=64m");
  assert.ok(Array.isArray(container.Mounts) && container.Mounts.length <= 2);
  if (container.Mounts.length) {
    assert.ok(container.Mounts.every((mount) => plainObject(mount).Type === "tmpfs"));
    assert.deepEqual(container.Mounts.map((mount) => mount.Destination).sort(), Object.keys(tmpfs).sort());
  }
  assert.ok(!network.Ports || Object.values(plainObject(network.Ports)).every((item) => item === null));
}
const expectedSqlFailure = Object.freeze({
  billingUnavailable: { sqlStates: ["42501"], message: /^LINKED_BILLING_UNAVAILABLE$/ },
  billingImmutable: { sqlStates: ["42501"], message: /^LINKED_BILLING_IMMUTABLE$/ },
  migrationReplay: { sqlStates: ["55000"], message: /^LINKED_BILLING_GATE_UNAVAILABLE$/ },
  ledgerPredecessor: { sqlStates: ["P0001"], message: /^LINKED_BILLING_LEDGER_PREDECESSOR_REJECTED$/ },
  tablePrivilege: { sqlStates: ["42501"], message: /^permission denied for (?:table|relation) aiuser_linked_billing_catalog_manifest$/ },
});
const userId = (n) => `12345678-1234-4${String(n).padStart(3, "0")}-8${String(n).padStart(3, "0")}-123456789${String(n).padStart(3, "0")}`;
function payload(seed) {
  const now = Date.now(), principal = hash(`principal-${seed}`), phone = userId(seed);
  const aiSession = hash(`ai-session-${seed}`), phoneSession = hash(`phone-session-${seed}`);
  return {
    schema: "aistory.aiuser-account-link-proof.v1", confirmation: { confirmLink: true },
    aiuser: { principalKey: principal, sessionBinding: aiSession, authenticatedAt: now - 1000,
      expiresAt: now + 899000, membershipGeneration: 1 },
    phone: { userId: phone, sessionBinding: phoneSession, authenticatedAt: now - 1000,
      expiresAt: now + 600000, active: true },
    intent: { id: hash(`intent-${seed}-${randomBytes(8).toString("hex")}`), principalKey: principal,
      phoneUserId: phone, aiuserSessionBinding: aiSession, phoneSessionBinding: phoneSession,
      createdAt: now, expiresAt: now + 60000, consumed: false },
  };
}
const roleCall = (name, value) => `set local role service_role;set local request.jwt.claim.role='service_role';select public.${name}($json$${JSON.stringify(value)}$json$::jsonb);`;
const resolveCall = (principal) => `set local role service_role;set local request.jwt.claim.role='service_role';select public.aistory_aiuser_linked_billing_resolve($json$${principal}$json$);`;
const fixtureSql = (from, to) => Array.from({ length: to - from + 1 }, (_, offset) => {
  const n = from + offset, id = userId(n);
  return `insert into public.app_users(id,tenant_id,identity_type,status) values('${id}','platform','phone','active');
insert into public.phone_identities(phone_hash,user_id,masked_phone,last_verified_at) values('${hash(`phone-${n}`)}','${id}','138****${String(n).padStart(4, "0")}',clock_timestamp());`;
}).join("\n");

async function liveQualification() {
  stage = "IMAGE_POSTURE";
  imageId = validateImageMetadata(inspectJson(["image", "inspect", image], "IMAGE_INSPECT"), image);
  stage = "PREFLIGHT_NAME_RESIDUE";
  assert.equal(checked(docker(["ps", "-aq", "--no-trunc", "--filter", `name=^/${containerName}$`]), "PREFLIGHT_NAME_RESIDUE"), "");
  stage = "CREATE";
  const createResult = checked(docker(["create", "--pull=never", "--rm", "--name", containerName,
    "--label", "aistory.purpose=aiuser-linked-billing-qualification", "--network", "none",
    "--tmpfs", "/var/lib/postgresql/data:rw,noexec,nosuid,size=768m",
    "--tmpfs", "/var/run/postgresql:rw,nosuid,size=64m", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", image,
    "-c", "listen_addresses=", "-c", "unix_socket_directories=/var/run/postgresql",
    "-c", "check_function_bodies=on"]), "CREATE");
  assert.match(createResult, /^[a-f0-9]{64}$/);
  containerId = createResult;
  verifyContainerPosture(inspectJson(["inspect", containerId], "CREATED_CONTAINER_INSPECT"), false);
  stage = "START";
  assert.equal(checked(docker(["start", containerId]), "START"), containerId);
  verifyContainerPosture(inspectJson(["inspect", containerId], "RUNNING_CONTAINER_INSPECT"), true);
  let stable = 0, last = "";
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const probe = docker(psqlArgs(), "select concat_ws('|',current_setting('server_version_num'),current_setting('server_version'),current_database(),current_user,split_part(pg_read_file('postmaster.pid'),E'\\n',1),inet_server_addr() is null,pg_is_in_recovery());");
    if (probe.status === 0 && probe.stdout.trim() === expectedServer) {
      stable = last === probe.stdout.trim() ? stable + 1 : 1;
      last = probe.stdout.trim();
      if (stable === 2) break;
    } else { stable = 0; last = ""; }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  stage = "SERVER_POSTURE";
  assert.equal(stable, 2, "PG16_LINKED_BILLING_SERVER_MISMATCH");
  sql(`create role anon nologin noinherit;create role authenticated nologin noinherit;create role service_role nologin bypassrls;
create schema auth;create schema supabase_migrations authorization postgres;
create table supabase_migrations.schema_migrations(version text primary key,name text not null,sha256 text not null,applied_at timestamptz not null default now());
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
create function auth.role() returns text language sql stable as $$select nullif(current_setting('request.jwt.claim.role',true),'')$$;
grant usage on schema auth to anon,authenticated,service_role;grant execute on function auth.uid(),auth.role() to anon,authenticated,service_role;`, "SYNTHETIC_BASE");
  for (const name of baseline) {
    const bytes = await readFile(`supabase/migrations/${name}`);
    sql(bytes.toString(), name);
    sql(`insert into supabase_migrations.schema_migrations(version,name,sha256) values('${name.slice(0, 14)}','${name}','${hash(bytes)}');`, "BASE_LEDGER");
  }
  const linkMigration = await readFile(`supabase/migrations/${linkMigrationName}`);
  const linkEnvelope = await readFile(linkEnvelopeName, "utf8");
  const linkInclude = `\\ir ../supabase/migrations/${linkMigrationName}`;
  assert.equal(linkEnvelope.split(linkInclude).length, 2);
  assert.ok(linkEnvelope.includes(hash(linkMigration)));
  sql(linkEnvelope.replace(linkInclude, () => linkMigration.toString()), "LINK_ENVELOPE");
  assert.equal(sql("select public.aistory_aiuser_link_posture();", "LINK_POSTURE"), "20260901040000");
  sql(fixtureSql(1, 20), "PHONE_FIXTURES");
  const billingMigration = await readFile(`supabase/migrations/${billingMigrationName}`);
  const billingEnvelope = await readFile(billingEnvelopeName, "utf8");
  const billingInclude = `\\ir ../supabase/migrations/${billingMigrationName}`;
  assert.equal(billingEnvelope.split(billingInclude).length, 2);
  assert.ok(billingEnvelope.includes(hash(billingMigration)));
  const applyBilling = billingEnvelope.replace(billingInclude, () => billingMigration.toString());
  sql(applyBilling, "BILLING_ENVELOPE");
  assert.equal(sql("select public.aistory_aiuser_linked_billing_posture();", "BILLING_POSTURE"), "20261115000000");
  assert.equal(sql(`select concat_ws('|',(select count(*) from supabase_migrations.schema_migrations where version='20261115000000'
    and name='${billingMigrationName}' and sha256='${hash(billingMigration)}' and applied_at is not null),
    (select version from public.aistory_schema_gates where gate_name='aiuser_linked_billing'),
    (select count(*) from public.aiuser_linked_billing_catalog_manifest));`, "BILLING_IDENTITY"), "1|20261115000000|8");

  const linked = payload(1);
  sql(roleCall("aistory_aiuser_link_prepare", linked), "LINK_PREPARE");
  assert.equal(sql(roleCall("aistory_aiuser_link_confirm", linked), "LINK_CONFIRM"), "linked");
  assert.equal(sql(resolveCall(linked.aiuser.principalKey), "RESOLVE_LINKED"), linked.phone.userId);
  gates.push("resolver_returns_unique_linked_phone_uuid");
  assert.equal(sql(resolveCall(hash("unlinked-principal")), "UNLINKED_IS_NULL"), "");
  gates.push("unlinked_is_null_not_a_uuid");
  sql(`update public.app_users set status='frozen' where id='${linked.phone.userId}';`, "DEACTIVATE_PHONE");
  assert.equal(sql(resolveCall(linked.aiuser.principalKey), "INACTIVE_IS_NULL"), "");
  sql(`update public.app_users set identity_type='supabase' where id='${linked.phone.userId}';`, "WRONG_IDENTITY_CLASS");
  assert.equal(sql(resolveCall(linked.aiuser.principalKey), "WRONG_IDENTITY_IS_NULL"), "");
  sql(`update public.app_users set identity_type='phone',status='active' where id='${linked.phone.userId}';`, "REACTIVATE_PHONE");
  assert.equal(sql(resolveCall(linked.aiuser.principalKey), "RESOLVE_AFTER_REACTIVATE"), linked.phone.userId);
  gates.push("frozen_or_wrong_phone_account_fails_closed");
  sql(`delete from public.phone_identities where user_id='${linked.phone.userId}';`, "REMOVE_VERIFIED_PHONE_RECORD");
  assert.equal(sql(resolveCall(linked.aiuser.principalKey), "MISSING_PHONE_IDENTITY_IS_NULL"), "");
  gates.push("missing_verified_phone_record_fails_closed");
  mustFail(resolveCall("NOT-A-HASH"), "malformed_principal_fails_closed", expectedSqlFailure.billingUnavailable);
  assert.equal(sql(`select concat_ws('|',
    has_function_privilege('service_role','public.aistory_aiuser_linked_billing_resolve(text)','EXECUTE'),
    has_function_privilege('anon','public.aistory_aiuser_linked_billing_resolve(text)','EXECUTE'),
    has_function_privilege('authenticated','public.aistory_aiuser_linked_billing_resolve(text)','EXECUTE'),
    has_function_privilege('service_role','public.aistory_aiuser_linked_billing_posture()','EXECUTE'));`, "FUNCTION_ACL"), "t|f|f|t");
  for (const role of ["anon", "authenticated", "service_role"]) {
    assert.equal(sql(`select bool_and(not has_table_privilege('${role}','public.aiuser_linked_billing_catalog_manifest',p))
      from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']::text[]) p;`,
    `TABLE_ACL_${role}`), "t");
  }
  for (const [label, hostile] of [
    ["POSTURE_RESOLVER_SEARCH_PATH", "alter function public.aistory_aiuser_linked_billing_resolve(text) set search_path=public;"],
    ["POSTURE_RESOLVER_ACL", "grant execute on function public.aistory_aiuser_linked_billing_resolve(text) to authenticated;"],
    ["POSTURE_TABLE_TRIGGER", "alter table public.aiuser_linked_billing_catalog_manifest disable trigger aiuser_linked_billing_catalog_manifest_immutable;"],
    ["POSTURE_TABLE_RLS", "alter table public.aiuser_linked_billing_catalog_manifest disable row level security;"],
  ]) {
    assert.equal(sql(`begin;${hostile}select public.aistory_aiuser_linked_billing_posture() is null;rollback;`, label), "t");
  }
  mustFail("update public.aiuser_linked_billing_catalog_manifest set definition_sha256=repeat('0',64);",
    "immutable_manifest_update", expectedSqlFailure.billingImmutable);
  mustFail("delete from public.aiuser_linked_billing_catalog_manifest;",
    "immutable_manifest_delete", expectedSqlFailure.billingImmutable);
  mustFail("truncate public.aiuser_linked_billing_catalog_manifest cascade;",
    "immutable_manifest_truncate", expectedSqlFailure.billingImmutable);
  assert.equal(sql(`select concat_ws('|',
    (select count(*) from public.aiuser_account_links),
    (select count(*) from public.aiuser_account_link_audit));`, "NO_LINK_WRITE_FROM_RESOLVER"), "1|1");
  mustFail(applyBilling, "ledger_replay", expectedSqlFailure.ledgerPredecessor);
  mustFail(billingMigration.toString(), "migration_replay", expectedSqlFailure.migrationReplay);
  assert.equal(sql("select public.aistory_aiuser_link_posture();", "LINK_POSTURE_PRESERVED"), "20260901040000");
  assert.equal(sql("select public.aistory_database_gate_status();", "BASE_GATE_PRESERVED"), "20260811193000");
  gates.push("old_link_posture_and_ledger_preserved");
  return {
    image,
    imageId,
    migrationSha256: hash(billingMigration),
    gates: gates.length,
    network: "none",
    publishedPorts: 0,
    productionEnabled: false,
    deployment: false,
  };
}

function safeValue(value) {
  if (value === null || typeof value === "boolean" || Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && value.length <= 160 && /^[A-Za-z0-9_|.\/:=\-]*$/.test(value)) return value;
  if (Array.isArray(value) && value.length <= 10) {
    const items = value.map(safeValue);
    return items.every((item) => item !== undefined) ? items : undefined;
  }
  return undefined;
}
function diagnostic(error) {
  const result = { stage, errorClass: error?.code === "ERR_ASSERTION" ? "ASSERTION" : "RUNNER" };
  const message = typeof error?.message === "string" ? error.message : "";
  let evidence;
  const checkedMatch = message.match(/^([A-Za-z0-9_.-]{3,100}):(\{.*\})$/s);
  try { evidence = JSON.parse(checkedMatch?.[2] ?? (message.startsWith("{") ? message : "null")); }
  catch { evidence = null; }
  if (checkedMatch) result.stage = checkedMatch[1];
  if (evidence && typeof evidence === "object" && !Array.isArray(evidence)) {
    for (const field of ["status", "signal", "transportCode", "sqlState", "marker", "hasServerError",
      "observedSqlState", "observedMarker", "expectedSqlStates", "expectedMessage"]) {
      const safe = safeValue(evidence[field]);
      if (safe !== undefined) result[field] = safe;
    }
    if (typeof evidence.label === "string" && /^[A-Z0-9_]{3,80}$/.test(evidence.label)) result.stage = evidence.label;
    if (typeof evidence.expectedMessage === "string") {
      result.expectedMarker = evidence.expectedMessage.match(/[A-Z][A-Z0-9_]{2,}/)?.[0] ?? null;
    }
  }
  for (const field of ["actual", "expected"]) {
    const safe = safeValue(error?.[field]);
    if (safe !== undefined) result[field] = safe;
  }
  if (typeof error?.code === "string" && /^[A-Z_]{3,40}$/.test(error.code)) result.errorCode = error.code;
  return result;
}

let result = null;
let failure = null;
let cleanupVerified = true;
let cleanupDiagnostic = null;
try {
  stage = "DOCKER_VERSION";
  const dockerVersion = docker(["version", "--format", "{{.Server.Version}}"], undefined, 15000);
  if (dockerVersion.status !== 0 || dockerVersion.signal !== null || dockerVersion.error) {
    finish("PG16_LINKED_BILLING_BLOCKED", {
      code: "BLOCKED_DOCKER_UNAVAILABLE",
      approvedImage: approvedImageReferences[0],
      productionEnabled: false,
      deployment: false,
      databaseExecuted: false,
      pgPassClaimed: false,
    }, 2);
  } else {
    stage = "BASELINE_READABILITY";
    const missing = [];
    for (const name of [...baseline, linkMigrationName, billingMigrationName]) {
      try { await access(`supabase/migrations/${name}`, fsConstants.R_OK); }
      catch { missing.push(name); }
    }
    if (missing.length > 0) {
      finish("PG16_LINKED_BILLING_BLOCKED", {
        code: "BLOCKED_BASELINE_MIGRATIONS_ABSENT",
        missing,
        approvedImage: approvedImageReferences[0],
        productionEnabled: false,
        deployment: false,
        databaseExecuted: false,
        pgPassClaimed: false,
      }, 2);
    } else {
      result = await liveQualification();
    }
  }
} catch (error) {
  failure = diagnostic(error);
} finally {
  if (containerId && /^[a-f0-9]{64}$/.test(containerId)) {
    const removal = docker(["rm", "-f", containerId], undefined, 30000);
    const byId = docker(["ps", "-aq", "--no-trunc", "--filter", `id=${containerId}`], undefined, 15000);
    const byName = docker(["ps", "-aq", "--no-trunc", "--filter", `name=^/${containerName}$`], undefined, 15000);
    cleanupVerified = byId.status === 0 && byId.signal === null && !byId.error && byId.stdout.trim() === ""
      && byName.status === 0 && byName.signal === null && !byName.error && byName.stdout.trim() === "";
    if (!cleanupVerified) cleanupDiagnostic = {
      stage: "CLEANUP", removalStatus: removal.status ?? null, removalSignal: removal.signal ?? null,
      removalTransportCode: removal.error?.code ?? null,
      idProbeStatus: byId.status ?? null, nameProbeStatus: byName.status ?? null,
      idResidue: byId.status === 0 && byId.stdout.trim() !== "",
      nameResidue: byName.status === 0 && byName.stdout.trim() !== "",
    };
  }
}
if (!cleanupVerified) {
  finish("PG16_LINKED_BILLING_FAILED", { code: "CLEANUP_UNVERIFIED", diagnostic: cleanupDiagnostic,
    priorFailure: failure, productionEnabled: false, deployment: false, databaseExecuted, pgPassClaimed: false }, 1);
} else if (failure) {
  finish("PG16_LINKED_BILLING_FAILED", { code: "QUALIFICATION_FAILED", diagnostic: failure,
    cleanupVerified, productionEnabled: false, deployment: false, databaseExecuted, pgPassClaimed: false }, 1);
} else if (result) {
  finish("PASS_AIUSER_LINKED_BILLING_POSTGRES16", { ...result, cleanupVerified, pgPassClaimed: true });
}
