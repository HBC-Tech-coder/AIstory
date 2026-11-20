import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

/** Same immutable PG16 image and isolation posture as the AIUser account-link runner. */
const approvedImages = [
  "postgres@sha256:f1c3376c26f2609ab9f29f71f824103fe2fcd8ee0346485cb6122a4f93df6f94",
  "docker.m.daocloud.io/library/postgres@sha256:f1c3376c26f2609ab9f29f71f824103fe2fcd8ee0346485cb6122a4f93df6f94",
];
const image = process.argv.length === 2 ? approvedImages[0] :
  process.argv.length === 4 && process.argv[2] === "--image" && approvedImages.includes(process.argv[3])
    ? process.argv[3] : null;
assert.ok(image, "STUDIO_PG16_IMAGE_ARGUMENTS_REJECTED");

const label = "aistory.purpose=studio-online-pg16-qualification";
const name = `aistory-studio-pg16-${process.pid}-${randomBytes(4).toString("hex")}`;
const migrationPath = "supabase/migrations/20261115090000_studio_online_projects.sql";
const expectedVersion = "160015|16.15 (Debian 16.15-1.pgdg13+2)|postgres|postgres|1|t|f";
const gates = [];
let containerId = null;
let imageId = null;
let created = false;
let originalImages = null;
let originalVolumes = null;
let cleanupVerified = false;
let failure = null;
let passPayload = null;

function docker(args, input, timeout = 60_000) {
  const result = spawnSync("docker", args, {
    input, encoding: "utf8", windowsHide: true, timeout, maxBuffer: 8_000_000,
  });
  if (result.status !== 0 || result.signal || result.error) {
    throw new Error(`DOCKER_${args[0]}:${result.error?.code ?? result.status}:${String(result.stderr).slice(0, 350)}`);
  }
  return result.stdout.trim();
}

function sql(source, title = "SQL") {
  const result = spawnSync("docker", [
    "exec", "-i", containerId, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-Atq", "-U", "postgres", "-d", "postgres",
  ], { input: source, encoding: "utf8", windowsHide: true, timeout: 60_000, maxBuffer: 8_000_000 });
  if (result.status !== 0 || result.signal || result.error) {
    throw new Error(`${title}:${result.error?.code ?? result.status}:${String(result.stderr).slice(0, 500)}`);
  }
  return result.stdout.trim();
}

function expectSqlFailure(source, title, pattern = /permission denied/i) {
  const result = spawnSync("docker", [
    "exec", "-i", containerId, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-Atq", "-U", "postgres", "-d", "postgres",
  ], { input: source, encoding: "utf8", windowsHide: true, timeout: 60_000, maxBuffer: 8_000_000 });
  assert.equal(result.error, undefined, `${title}: docker transport error`);
  assert.equal(result.signal, null, `${title}: docker process terminated by signal`);
  assert.equal(result.status, 3, `${title}: expected psql ON_ERROR_STOP SQL failure (exit 3)`);
  assert.match(String(result.stderr), pattern, `${title}: wrong failure`);
}

function quote(value) { return `'${String(value).replaceAll("'", "''")}'`; }
function json(value) { return `${quote(JSON.stringify(value))}::jsonb`; }
function rpc(name, ...args) {
  const value = sql(`select public.${name}(${args.join(",")});`, name);
  return value === "" ? null : JSON.parse(value);
}
function expectOutcome(value, outcome) {
  assert.equal(value?.outcome, outcome);
  return value;
}
function exactContainer(expectedRunning) {
  const value = JSON.parse(docker(["inspect", containerId, "--format", "{{json .}}"]));
  assert.equal(value.Id, containerId);
  assert.equal(value.Name, `/${name}`);
  assert.equal(value.Image, imageId);
  assert.equal(value.Config.Image, image);
  assert.equal(value.Config.Labels["aistory.purpose"], "studio-online-pg16-qualification");
  assert.equal(value.HostConfig.NetworkMode, "none");
  assert.equal(value.HostConfig.AutoRemove, true);
  assert.equal(value.HostConfig.PublishAllPorts, false);
  assert.ok(!value.HostConfig.PortBindings || Object.keys(value.HostConfig.PortBindings).length === 0);
  assert.deepEqual(value.HostConfig.Tmpfs, {
    "/var/lib/postgresql/data": "rw,noexec,nosuid,size=768m",
    "/var/run/postgresql": "rw,nosuid,size=64m",
  });
  assert.equal(value.State.Running, expectedRunning);
}

try {
  assert.equal(docker(["ps", "-aq", "--no-trunc", "--filter", `label=${label}`]), "", "label residue");
  assert.equal(docker(["ps", "-aq", "--no-trunc", "--filter", `name=^/${name}$`]), "", "name residue");
  originalImages = docker(["image", "ls", "-q", "--no-trunc"]).split(/\r?\n/).filter(Boolean).sort();
  originalVolumes = docker(["volume", "ls", "-q"]).split(/\r?\n/).filter(Boolean).sort();
  const inspectedImage = JSON.parse(docker(["image", "inspect", image, "--format", "{{json .}}"]));
  assert.equal(inspectedImage.Os, "linux");
  assert.equal(inspectedImage.Architecture, "amd64");
  assert.ok(inspectedImage.RepoDigests.includes(image));
  assert.match(inspectedImage.Id, /^sha256:[a-f0-9]{64}$/);
  imageId = inspectedImage.Id;
  gates.push("exact_digest_image");

  created = true;
  containerId = docker([
    "create", "--pull=never", "--rm", "--name", name, "--label", label,
    "--network", "none",
    "--tmpfs", "/var/lib/postgresql/data:rw,noexec,nosuid,size=768m",
    "--tmpfs", "/var/run/postgresql:rw,nosuid,size=64m",
    "-e", "POSTGRES_HOST_AUTH_METHOD=trust", image,
    "-c", "listen_addresses=", "-c", "unix_socket_directories=/var/run/postgresql",
    "-c", "check_function_bodies=on",
  ]);
  assert.match(containerId, /^[a-f0-9]{64}$/);
  exactContainer(false);
  assert.equal(docker(["start", containerId]), containerId);
  exactContainer(true);
  let stable = 0;
  let lastProbe = "not_attempted";
  const readyDeadline = Date.now() + 60_000;
  while (Date.now() < readyDeadline) {
    const probe = spawnSync("docker", ["exec", containerId, "psql", "-X", "-Atq", "-U", "postgres", "-d", "postgres",
      "-c", "select concat_ws('|',current_setting('server_version_num'),current_setting('server_version'),current_database(),current_user,split_part(pg_read_file('postmaster.pid'),E'\\n',1),inet_server_addr() is null,pg_is_in_recovery());"],
      { encoding: "utf8", windowsHide: true, timeout: 5_000 });
    const observation = probe.stdout?.trim() ?? "";
    if (probe.status === 0 && probe.signal === null && !probe.error && observation === expectedVersion) {
      stable += 1;
      lastProbe = observation;
      if (stable === 2) break;
    } else {
      stable = 0;
      lastProbe = JSON.stringify({ status: probe.status, signal: probe.signal,
        transport: probe.error?.code ?? null, observed: observation.slice(0, 150),
        stderr: (probe.stderr ?? "").trim().slice(0, 150) });
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(stable, 2, `STUDIO_PG16_FINAL_POSTMASTER_UNAVAILABLE:${lastProbe}`);
  gates.push("pg16_15_unix_socket_no_network");

  sql(`create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin bypassrls;
create schema auth;
create table public.aistory_schema_gates (
  gate_name text primary key, version text not null, installed_at timestamptz not null default now()
);`, "SYNTHETIC_BASE");
  const migrationBytes = await readFile(migrationPath);
  const migrationSha256 = createHash("sha256").update(migrationBytes).digest("hex");
  expectSqlFailure(`begin; create table public.studio_projects(id uuid);\n${migrationBytes.toString("utf8")}`,
    "PREEXISTING_SCHEMA_REJECTED", /STUDIO_PROJECT_GATE_PRESTATE_REJECTED/);
  assert.equal(sql("select to_regclass('public.studio_projects') is null;"), "t");
  sql(`begin;\n${migrationBytes.toString("utf8")}\ncommit;`, "STUDIO_MIGRATION");
  assert.equal(sql("select public.aistory_studio_projects_gate_status();"), "20261115090000");
  assert.equal(sql("select public.aistory_studio_project_security_posture();"), "t");
  gates.push("migration_applies_and_posture_true");

  const acl = sql(`select concat_ws('|',
    (select relrowsecurity from pg_class where oid='public.studio_projects'::regclass),
    (select relforcerowsecurity from pg_class where oid='public.studio_projects'::regclass),
    (select count(*) from pg_policies where schemaname='public' and tablename='studio_projects'),
    has_table_privilege('anon','public.studio_projects','select'),
    has_table_privilege('authenticated','public.studio_projects','select'),
    has_table_privilege('service_role','public.studio_projects','select'),
    has_function_privilege('anon','public.aistory_studio_project_create(jsonb)','execute'),
    has_function_privilege('authenticated','public.aistory_studio_project_create(jsonb)','execute'),
    has_function_privilege('service_role','public.aistory_studio_project_create(jsonb)','execute'));`, "ACL");
  assert.equal(acl, "t|t|0|f|f|f|f|f|t");
  const catalog = sql(`select concat_ws('|',
    (select count(*) from pg_constraint where conrelid='public.studio_projects'::regclass),
    (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'aistory_studio_%' and p.prosecdef),
    (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'aistory_studio_%' and p.proconfig is not null));`, "CATALOG");
  assert.equal(catalog, "10|9|11");
  assert.ok(Number(sql("select count(*) from public.studio_project_catalog_manifest;")) >= 20);
  assert.equal(sql("set role service_role; select public.aistory_studio_project_security_posture(); reset role;", "SERVICE_ROLE_RPC"), "t");
  expectSqlFailure("set role anon; select public.aistory_studio_project_create('{}'::jsonb);", "ANON_RPC_DENIED");
  expectSqlFailure("set role service_role; select count(*) from public.studio_projects;", "SERVICE_ROLE_TABLE_DENIED");
  gates.push("forced_rls_acl_catalog");

  const ownerA = "a".repeat(64), ownerB = "b".repeat(64);
  const draft = { v: 1, title: "Private title", authoringNotes: "private-notes-token", scenes: [
    { id: "scene-1", heading: "Opening", body: "Private draft text" },
  ] };
  const published = { v: 1, title: "Public title", synopsis: "Shared safely", scenes: [
    { id: "scene-1", heading: "Opening", body: "Published scene text" },
  ] };
  const createdProject = expectOutcome(rpc("aistory_studio_project_create", json({
    owner_key: ownerA, draft, draft_hash: "c".repeat(64),
  })), "created").project;
  const id = createdProject.id;
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(createdProject.revision, 1);
  assert.equal(createdProject.visibility, "hidden");
  assert.equal(createdProject.published, false);
  assert.equal(rpc("aistory_studio_project_get_public", quote(id) + "::uuid"), null);
  const own = rpc("aistory_studio_project_get_owner", quote(ownerA), quote(id) + "::uuid");
  assert.equal(own.draft.authoringNotes, "private-notes-token");
  assert.equal(rpc("aistory_studio_project_get_owner", quote(ownerB), quote(id) + "::uuid"), null);
  const ownerList = rpc("aistory_studio_project_list_owner", quote(ownerA), "0", "20");
  assert.equal(ownerList.items.length, 1);
  assert.equal(rpc("aistory_studio_project_list_owner", quote(ownerB), "0", "20").items.length, 0);
  gates.push("create_owner_read_list_private_draft");

  const extraGrantProbe = sql(`begin;
create role studio_extra nologin;
grant usage on schema public to studio_extra;
grant execute on function public.aistory_studio_project_get_owner(text,uuid) to studio_extra;
select public.aistory_studio_project_security_posture();
set role studio_extra;
select public.aistory_studio_project_get_owner(${quote(ownerA)},${quote(id)}::uuid);
reset role;
rollback;`, "EXTRA_GRANT_PROBE").split(/\r?\n/);
  assert.equal(extraGrantProbe[0], "f");
  assert.ok(extraGrantProbe.some((line) => line.includes("private-notes-token")),
    "extra grant must demonstrate private-draft exposure");
  assert.equal(sql("select public.aistory_studio_project_security_posture();"), "t");

  assert.equal(sql(`begin;
create or replace function public.aistory_studio_project_get_owner(owner_key text, project_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog, public as $tamper$
begin return '{}'::jsonb; end;
$tamper$;
select public.aistory_studio_project_security_posture();
rollback;`, "BODY_DRIFT_PROBE"), "f");
  assert.equal(sql("select public.aistory_studio_project_security_posture();"), "t");
  assert.equal(rpc("aistory_studio_project_get_owner", quote(ownerA), quote(id) + "::uuid").draft.authoringNotes,
    "private-notes-token");
  gates.push("extra_grant_and_body_drift_fail_closed_then_rollback");

  const revisedDraft = { ...draft, title: "Revised private title" };
  expectOutcome(rpc("aistory_studio_project_revise", json({
    owner_key: ownerB, project_id: id, expected_revision: 1, draft: revisedDraft, draft_hash: "d".repeat(64),
  })), "not_found");
  expectOutcome(rpc("aistory_studio_project_revise", json({
    owner_key: ownerA, project_id: id, expected_revision: 2, draft: revisedDraft, draft_hash: "d".repeat(64),
  })), "conflict");
  const revised = expectOutcome(rpc("aistory_studio_project_revise", json({
    owner_key: ownerA, project_id: id, expected_revision: 1, draft: revisedDraft, draft_hash: "d".repeat(64),
  })), "updated").project;
  assert.equal(revised.revision, 2);
  gates.push("cross_owner_denial_and_revision_conflict");

  const publication = expectOutcome(rpc("aistory_studio_project_publish", json({
    owner_key: ownerA, project_id: id, expected_revision: 2,
    published, published_hash: "e".repeat(64), visibility: "public",
  })), "published").project;
  assert.equal(publication.revision, 3);
  const visible = rpc("aistory_studio_project_get_public", quote(id) + "::uuid");
  assert.equal(visible.title, "Public title");
  assert.equal(visible.scenes[0].body, "Published scene text");
  assert.ok(!JSON.stringify(visible).includes("private-notes-token"));
  assert.ok(!JSON.stringify(visible).includes(ownerA));
  gates.push("explicit_safe_publish_public_projection");

  expectOutcome(rpc("aistory_studio_project_set_visibility", json({
    owner_key: ownerB, project_id: id, expected_revision: 3, visibility: "hidden",
  })), "not_found");
  const hidden = expectOutcome(rpc("aistory_studio_project_set_visibility", json({
    owner_key: ownerA, project_id: id, expected_revision: 3, visibility: "hidden",
  })), "updated").project;
  assert.equal(hidden.revision, 4);
  assert.equal(rpc("aistory_studio_project_get_public", quote(id) + "::uuid"), null);
  expectOutcome(rpc("aistory_studio_project_set_visibility", json({
    owner_key: ownerA, project_id: id, expected_revision: 3, visibility: "public",
  })), "conflict");
  const unhidden = expectOutcome(rpc("aistory_studio_project_set_visibility", json({
    owner_key: ownerA, project_id: id, expected_revision: 4, visibility: "public",
  })), "updated").project;
  assert.equal(unhidden.revision, 5);
  assert.equal(rpc("aistory_studio_project_get_public", quote(id) + "::uuid").title, "Public title");
  gates.push("hide_unhide_and_stale_revision");

  passPayload = { status: "PASS_STUDIO_ONLINE_POSTGRES16", image,
    migrationSha256, gates, network: "none", publishedPorts: 0, productionEnabled: false, deployment: false };
} catch (error) {
  failure = error;
} finally {
  const cleanupErrors = [];
  try {
    if (created) {
      const ids = docker(["ps", "-aq", "--no-trunc", "--filter", `name=^/${name}$`]).split(/\r?\n/).filter(Boolean);
      assert.ok(ids.length <= 1);
      const target = containerId && /^[a-f0-9]{64}$/.test(containerId) ? containerId : ids[0];
      if (target) {
        assert.match(target, /^[a-f0-9]{64}$/);
        const inspected = JSON.parse(docker(["inspect", target, "--format", "{{json .}}"]));
        assert.equal(inspected.Name, `/${name}`);
        assert.equal(inspected.Config.Labels["aistory.purpose"], "studio-online-pg16-qualification");
        docker(["rm", "-f", target]);
      }
    }
    assert.equal(docker(["ps", "-aq", "--no-trunc", "--filter", `label=${label}`]), "");
    assert.equal(docker(["ps", "-aq", "--no-trunc", "--filter", `name=^/${name}$`]), "");
    if (originalImages) assert.deepEqual(docker(["image", "ls", "-q", "--no-trunc"]).split(/\r?\n/).filter(Boolean).sort(), originalImages);
    if (originalVolumes) assert.deepEqual(docker(["volume", "ls", "-q"]).split(/\r?\n/).filter(Boolean).sort(), originalVolumes);
    cleanupVerified = true;
  } catch (error) { cleanupErrors.push(error); }
  if (failure && cleanupErrors.length) throw new AggregateError([failure, ...cleanupErrors], "STUDIO_PG16_AND_CLEANUP_FAILED");
  if (failure) throw failure;
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "STUDIO_PG16_CLEANUP_FAILED");
}
assert.ok(cleanupVerified);
assert.ok(passPayload);
console.log(JSON.stringify({ ...passPayload, cleanupVerified, containerResidues: 0,
  labelResidues: 0, nameResidues: 0, imageResidues: 0, volumeResidues: 0 }));
