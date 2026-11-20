import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

export const approvedImageReferences = Object.freeze([
  "postgres@sha256:f1c3376c26f2609ab9f29f71f824103fe2fcd8ee0346485cb6122a4f93df6f94",
  "docker.m.daocloud.io/library/postgres@sha256:f1c3376c26f2609ab9f29f71f824103fe2fcd8ee0346485cb6122a4f93df6f94",
]);

export function selectImageReference(args) {
  assert.ok(Array.isArray(args), "PG16_IMAGE_ARGUMENTS_REJECTED");
  if (args.length === 0) return approvedImageReferences[0];
  assert.ok(args.length === 2 && args[0] === "--image" && approvedImageReferences.includes(args[1]),
    "PG16_IMAGE_ARGUMENTS_REJECTED");
  return args[1];
}

function record(value) {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), "PG16_METADATA_SHAPE_REJECTED");
  assert.ok([Object.prototype, null].includes(Object.getPrototypeOf(value)), "PG16_METADATA_SHAPE_REJECTED");
  for (const key of Reflect.ownKeys(value)) {
    assert.ok(typeof key === "string" && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value"),
      "PG16_METADATA_SHAPE_REJECTED");
  }
  return value;
}

export function validateImageMetadata(value, image) {
  assert.ok(approvedImageReferences.includes(image), "PG16_IMAGE_REFERENCE_REJECTED");
  const metadata = record(value);
  assert.match(metadata.Id, /^sha256:[a-f0-9]{64}$/);
  assert.equal(metadata.Os, "linux"); assert.equal(metadata.Architecture, "amd64");
  assert.ok(metadata.Variant === undefined || metadata.Variant === "");
  assert.ok(Array.isArray(metadata.RepoDigests) && metadata.RepoDigests.includes(image));
  assert.equal(new Set(metadata.RepoDigests).size, metadata.RepoDigests.length);
  assert.ok(metadata.RepoDigests.every((item) => typeof item === "string" && /^[^\s@]+@sha256:[a-f0-9]{64}$/.test(item)));
  return metadata.Id;
}

export function validateContainerMetadata(value, expected) {
  const container = record(value), config = record(container.Config), host = record(container.HostConfig);
  const network = record(container.NetworkSettings), state = record(container.State);
  assert.equal(container.Id, expected.id); assert.equal(container.Name, `/${expected.name}`);
  assert.equal(container.Image, expected.imageId); assert.equal(config.Image, expected.image);
  assert.equal(container.Platform, "linux"); assert.equal(state.Running, expected.running);
  assert.equal(record(config.Labels)["aistory.purpose"], "aiuser-account-link-qualification");
  assert.equal(host.NetworkMode, "none"); assert.equal(host.AutoRemove, true); assert.equal(host.PublishAllPorts, false);
  assert.ok(!host.PortBindings || Object.keys(record(host.PortBindings)).length === 0);
  const tmpfs = record(host.Tmpfs);
  assert.deepEqual(Object.keys(tmpfs).sort(), ["/var/lib/postgresql/data", "/var/run/postgresql"]);
  assert.equal(tmpfs["/var/lib/postgresql/data"], "rw,noexec,nosuid,size=768m");
  assert.equal(tmpfs["/var/run/postgresql"], "rw,nosuid,size=64m");
  assert.ok(Array.isArray(container.Mounts) && (container.Mounts.length === 0 || container.Mounts.length === 2));
  if (container.Mounts.length) {
    assert.ok(container.Mounts.every((mount) => record(mount).Type === "tmpfs"));
    assert.deepEqual(container.Mounts.map((mount) => mount.Destination).sort(), Object.keys(tmpfs).sort());
  }
  assert.ok(!network.Ports || Object.values(record(network.Ports)).every((item) => item === null));
}

const baseline = [
  "20260624135618_stories.sql", "20260628095015_upsert_story_if_newer.sql", "20260726174500_admin_console_p1.sql",
  "20260727193000_platform_provider_credentials.sql", "20260728193000_phone_billing_p1.sql",
  "20260729093000_production_identity_billing_gate.sql", "20260729183000_anonymous_phone_claim_gate.sql",
  "20260731120000_sensitive_identity_billing_privilege_hardening.sql", "20260731183000_admin_identity_rpc_read_gate.sql",
  "20260801193000_hosted_byok_vault_gate.sql", "20260801213000_hosted_byok_rpc_ambiguity_hardening.sql",
  "20260802113000_hosted_byok_rpc_runtime_qualification_hardening.sql", "20260809113000_phone_admin_identity_gate.sql",
  "20260811193000_production_video_asset_metadata_gate.sql",
];
const migrationName = "20260901040000_aiuser_account_link_gate.sql";
const envelopeName = "scripts/apply-aiuser-account-link-ledger.psql";
const expectedServer = "160015|16.15 (Debian 16.15-1.pgdg13+2)|postgres|postgres|1|t|f";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const containerName = `aistory-aiuser-link-pg16-${process.pid}-${randomBytes(4).toString("hex")}`;
let requestedSignal = null;
let cleanupInProgress = false;
function throwIfSignalled() {
  if (requestedSignal && !cleanupInProgress) throw new Error(`PG16_RUNNER_SIGNALLED:${requestedSignal}`);
}
const run = (args, input, timeoutMs = 60000) => {
  throwIfSignalled();
  const result = spawnSync("docker", args, { input, encoding: "utf8", windowsHide: true,
    timeout: timeoutMs, maxBuffer: 4_000_000 });
  throwIfSignalled();
  return result;
};
export function checked(result, label) {
  if (result?.status !== 0 || result?.signal != null || result?.error) {
    const serverError = typeof result?.stderr === "string"
      ? result.stderr.match(/ERROR:\s+(?:([0-9A-Z]{5}):\s*)?([^\r\n]+)/) : null;
    const marker = serverError?.[2]?.match(/[A-Z][A-Z0-9_]{2,}/)?.[0] ?? null;
    throw new Error(`${label}:${JSON.stringify({ status: result?.status ?? null, signal: result?.signal ?? null,
      transportCode: result?.error?.code ?? result?.error?.name ?? null,
      sqlState: serverError?.[1] ?? null, marker })}`);
  }
  return result.stdout.trim();
}

const activeProtectedDockerChildren = new Set();
export function activeProtectedDockerChildCount() { return activeProtectedDockerChildren.size; }
export function observeProtectedDockerChild(child) {
  activeProtectedDockerChildren.add(child);
  return new Promise((resolve) => {
    let stdout = "", stderr = "", transportCode = null;
    const append = (current, part, streamName) => {
      const next = current + part;
      if (next.length <= 4_000_000) return next;
      transportCode ??= `${streamName}_OVERFLOW`;
      return next.slice(0, 4_000_000);
    };
    child.stdout.on("data", (part) => { stdout = append(stdout, part, "STDOUT"); });
    child.stderr.on("data", (part) => { stderr = append(stderr, part, "STDERR"); });
    child.stdout.once("error", (streamError) => {
      transportCode ??= `STDOUT_${streamError.code ?? streamError.name ?? "ERROR"}`;
    });
    child.stderr.once("error", (streamError) => {
      transportCode ??= `STDERR_${streamError.code ?? streamError.name ?? "ERROR"}`;
    });
    child.once("error", (spawnError) => {
      transportCode ??= `SPAWN_${spawnError.code ?? spawnError.name ?? "ERROR"}`;
    });
    child.once("close", (status, signal) => {
      activeProtectedDockerChildren.delete(child);
      const transportError = transportCode
        ? Object.assign(new Error(transportCode), { code: transportCode }) : undefined;
      resolve({ status, signal: signal ?? null, stdout, stderr, error: transportError });
    });
  });
}
function runProtectedDocker(args) {
  throwIfSignalled();
  let child;
  try {
    child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: true });
  } catch (spawnError) {
    return Promise.resolve({ status: null, signal: null, stdout: "", stderr: "", error: spawnError });
  }
  return observeProtectedDockerChild(child);
}

export function validateExpectedSqlFailure(result, label, expected) {
  assert.ok(expected && Array.isArray(expected.sqlStates) && expected.sqlStates.length > 0
    && expected.sqlStates.every((value) => /^[0-9A-Z]{5}$/.test(value)) && expected.message instanceof RegExp
    && expected.message.flags === "" && expected.message.source.startsWith("^") && expected.message.source.endsWith("$"),
  `PG16_EXPECTED_SQL_FAILURE_CONTRACT_REJECTED:${label}`);
  const serverError = typeof result?.stderr === "string"
    ? result.stderr.match(/ERROR:\s+([0-9A-Z]{5}):\s*([^\r\n]+)/) : null;
  const parsed = serverError ? { sqlState: serverError[1], message: serverError[2].slice(0, 220) } : null;
  const evidence = JSON.stringify({ label, status: result?.status ?? null, signal: result?.signal ?? null,
    transportCode: result?.error?.code ?? result?.error?.name ?? null, hasServerError: Boolean(serverError),
    observedSqlState: parsed?.sqlState ?? null,
    observedMarker: parsed?.message.match(/[A-Z][A-Z0-9_]{2,}/)?.[0] ?? null,
    expectedSqlStates: expected.sqlStates, expectedMessage: expected.message.source });
  assert.equal(result?.error, undefined, evidence);
  assert.equal(result?.signal, null, evidence);
  assert.equal(result?.status, 3, evidence);
  assert.ok(parsed, evidence);
  assert.ok(expected.sqlStates.includes(parsed.sqlState), evidence);
  assert.match(parsed.message, expected.message, evidence);
  return parsed;
}

let containerId;
let imageId;
let passPayload;
let cleanupVerified = false;
let baselineImageIds;
let baselineVolumeIds;
let createAttempted = false;
let createRequestClosed = false;
let containerStartAttempted = false;
let startRequestClosed = false;
const gates = [];
const psqlArgs = (database = "postgres") => ["exec", "-i", containerId, "psql", "-h", "/var/run/postgresql",
  "-U", "postgres", "-d", database, "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-1"];
const psqlSessionArgs = (database = "postgres") => ["exec", "-i", containerId, "psql", "-h", "/var/run/postgresql",
  "-U", "postgres", "-d", database, "-X", "-qAt", "-v", "ON_ERROR_STOP=1"];
const sql = (text, label, database = "postgres") => checked(run(psqlArgs(database), text), label);
const mustFail = (text, label, expected, database = "postgres") => {
  validateExpectedSqlFailure(run(psqlArgs(database), `\\set VERBOSITY verbose\n${text}`), label, expected);
  gates.push(label);
};
const expectedSqlFailure = Object.freeze({
  ledgerPredecessor: { sqlStates: ["P0001"], message: /^ACCOUNT_LINK_LEDGER_PREDECESSOR_REJECTED$/ },
  ledgerShape: { sqlStates: ["P0001"], message: /^ACCOUNT_LINK_LEDGER_SHAPE_REJECTED$/ },
  catalogShape: { sqlStates: ["23514"],
    message: /^new row for relation "aiuser_account_link_catalog_manifest" violates check constraint "aiuser_account_link_catalog_manifest_shape_check"$/ },
  migrationReplay: { sqlStates: ["55000"], message: /^ACCOUNT_LINK_GATE_UNAVAILABLE$/ },
  tablePrivilege: { sqlStates: ["42501"],
    message: /^permission denied for (?:table|relation) aiuser_account_link(?:s|_intents|_session_revocations|_audit|_catalog_manifest)$/ },
  accountRejected: { sqlStates: ["22023"], message: /^ACCOUNT_LINK_REJECTED$/ },
  divisionByZero: { sqlStates: ["22012"], message: /^division by zero$/ },
  immutable: { sqlStates: ["42501"], message: /^ACCOUNT_LINK_IMMUTABLE$/ },
});
const immutableAssignments = Object.freeze({
  aiuser_account_links: "principal_hash=principal_hash",
  aiuser_account_link_intents: "intent_hash=intent_hash",
  aiuser_account_link_session_revocations: "session_hash=session_hash",
  aiuser_account_link_audit: "intent_hash=intent_hash",
  aiuser_account_link_catalog_manifest: "object_key=object_key",
});
export const immutableMutationCases = Object.freeze(Object.entries(immutableAssignments).flatMap(([table, assignment]) => [
  Object.freeze({ table, operation: "update", label: `immutable_${table}_update`,
    sql: `update public.${table} set ${assignment}` }),
  Object.freeze({ table, operation: "delete", label: `immutable_${table}_delete`,
    sql: `delete from public.${table}` }),
  Object.freeze({ table, operation: "truncate", label: `immutable_${table}_truncate`,
    sql: `truncate public.${table} cascade` }),
]));
export const immutableSnapshotSql = `select concat_ws('|',
  (select jsonb_build_object('count',count(*),'rows',coalesce(jsonb_agg(to_jsonb(t) order by t.principal_hash),'[]'::jsonb))
    from public.aiuser_account_links t),
  (select jsonb_build_object('count',count(*),'rows',coalesce(jsonb_agg(to_jsonb(t) order by t.intent_hash),'[]'::jsonb))
    from public.aiuser_account_link_intents t),
  (select jsonb_build_object('count',count(*),'rows',coalesce(jsonb_agg(to_jsonb(t) order by t.session_kind,t.session_hash),'[]'::jsonb))
    from public.aiuser_account_link_session_revocations t),
  (select jsonb_build_object('count',count(*),'rows',coalesce(jsonb_agg(to_jsonb(t) order by t.intent_hash),'[]'::jsonb))
    from public.aiuser_account_link_audit t),
  (select jsonb_build_object('count',count(*),'rows',coalesce(jsonb_agg(to_jsonb(t) order by t.object_key),'[]'::jsonb))
    from public.aiuser_account_link_catalog_manifest t))::text;`;
const activeAsyncChildren = new Set();
function trackAsyncChild(child) {
  let markSettled;
  const tracked = { child, settled: new Promise((resolve) => { markSettled = resolve; }) };
  activeAsyncChildren.add(tracked);
  child.once("close", () => { activeAsyncChildren.delete(tracked); markSettled(); });
  return tracked;
}
async function settleAsyncChildren({ terminate = false, timeoutMs = 10000 } = {}) {
  const pending = [...activeAsyncChildren];
  if (terminate) for (const { child } of pending) {
    try { child.kill(); } catch {}
  }
  if (pending.length > 0) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`ASYNC_CHILD_CLEANUP_TIMEOUT:${activeAsyncChildren.size}`)), timeoutMs);
      Promise.all(pending.map(({ settled }) => settled)).then(() => { clearTimeout(timer); resolve(); }, reject);
    });
  }
  assert.equal(activeAsyncChildren.size, 0, "ASYNC_CHILD_RESIDUE");
}
function asyncEvidence(result, label) {
  return JSON.stringify({ label, status: result?.status ?? null, signal: result?.signal ?? null,
    timedOut: result?.timedOut ?? null, transportCode: result?.transportCode ?? null,
    sqlState: result?.sqlState ?? null,
    errorMarker: result?.error?.match(/[A-Z][A-Z0-9_]{2,}/)?.[0] ?? null,
    outputClass: result?.output === "linked" ? "linked" : result?.output === "t" ? "true"
      : result?.output?.split(/\r?\n/).includes("PASS_AIUSER_ACCOUNT_LINK_ATOMIC_LEDGER") ? "ledger_pass"
        : result?.output ? "other" : "empty" });
}
export function validateAsyncSuccess(result, label, expectedOutput) {
  throwIfSignalled();
  const evidence = asyncEvidence(result, label);
  assert.equal(result?.transportCode, null, evidence); assert.equal(result?.timedOut, false, evidence);
  assert.equal(result?.signal, null, evidence); assert.equal(result?.status, 0, evidence);
  assert.equal(result?.sqlState, null, evidence); assert.equal(result?.error, null, evidence);
  if (expectedOutput instanceof RegExp) assert.match(result.output, expectedOutput, evidence);
  else if (expectedOutput !== undefined) assert.equal(result.output, expectedOutput, evidence);
}
export function validateAsyncSqlFailure(result, label, expected) {
  throwIfSignalled();
  const evidence = asyncEvidence(result, label);
  assert.ok(expected && Array.isArray(expected.sqlStates) && expected.message instanceof RegExp
    && expected.message.flags === "" && expected.message.source.startsWith("^") && expected.message.source.endsWith("$"),
    `PG16_EXPECTED_ASYNC_SQL_FAILURE_CONTRACT_REJECTED:${label}`);
  assert.equal(result?.transportCode, null, evidence); assert.equal(result?.timedOut, false, evidence);
  assert.equal(result?.signal, null, evidence);
  assert.equal(result?.status, 3, evidence);
  assert.ok(expected.sqlStates.includes(result?.sqlState), evidence);
  assert.match(result?.error ?? "", expected.message, evidence);
}
export function activeAsyncChildCount() { return activeAsyncChildren.size; }
export function observeAsyncChild(child, { text = "", timeoutMs = 60000, verboseErrors = false } = {}) {
  return new Promise((resolve) => {
    trackAsyncChild(child);
    let output = "", error = "", settled = false, timedOut = false, timer, forceTimer;
    let transportCode = null;
    const finish = (status, signal) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(forceTimer);
      const serverError = error.match(/ERROR:\s+(?:([0-9A-Z]{5}):\s*)?([^\r\n]+)/);
      resolve({ status, signal: signal ?? null, timedOut, output: output.trim().slice(0, 2000),
        sqlState: serverError?.[1] ?? null, error: serverError?.[2]?.slice(0, 220) ?? null,
        transportCode: transportCode ?? (timedOut ? "TIMEOUT" : null) });
    };
    child.stdout.on("data", (part) => { output += part; }); child.stderr.on("data", (part) => { error += part; });
    child.stdout.once("error", (streamError) => {
      transportCode = `STDOUT_${streamError.code ?? streamError.name ?? "ERROR"}`; finish(null, null);
    });
    child.stderr.once("error", (streamError) => {
      transportCode = `STDERR_${streamError.code ?? streamError.name ?? "ERROR"}`; finish(null, null);
    });
    child.once("error", (spawnError) => {
      transportCode = `SPAWN_${spawnError.code ?? spawnError.name ?? "ERROR"}`; finish(null, null);
    });
    child.once("close", (status, signal) => finish(status, signal));
    child.stdin.on("error", (stdinError) => {
      transportCode = `STDIN_${stdinError.code ?? stdinError.name ?? "ERROR"}`; finish(null, null);
    });
    timer = setTimeout(() => {
      timedOut = true; try { child.kill(); } catch {}
      forceTimer = setTimeout(() => finish(null, "TIMEOUT"), 5000);
    }, timeoutMs);
    try { child.stdin.end(verboseErrors ? `\\set VERBOSITY verbose\n${text}` : text); }
    catch (stdinError) {
      transportCode = `STDIN_${stdinError.code ?? stdinError.name ?? "ERROR"}`; finish(null, null);
    }
  });
}
function parallel(text, { singleTransaction = true, timeoutMs = 60000, verboseErrors = false } = {}) {
  const child = spawn("docker", singleTransaction ? psqlArgs() : psqlSessionArgs(),
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  return observeAsyncChild(child, { text, timeoutMs, verboseErrors });
}
export function observeControlledSessionChild(child, timeoutMs = 60000) {
  trackAsyncChild(child);
  let output = "", error = "", closed = false, settled = false, timedOut = false;
  let exitStatus = null, exitSignal = null, transportCode = null, timer, forceTimer;
  child.stdout.on("data", (part) => { output += part; });
  child.stderr.on("data", (part) => { error += part; });
  const result = new Promise((resolve) => {
    const finish = (status, signal) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(forceTimer);
      exitStatus = status; exitSignal = signal ?? null;
      const serverError = error.match(/ERROR:\s+(?:([0-9A-Z]{5}):\s*)?([^\r\n]+)/);
      resolve({ status, signal: exitSignal, timedOut, output: output.trim().slice(0, 2000),
        sqlState: serverError?.[1] ?? null, error: serverError?.[2]?.slice(0, 220) ?? null,
        transportCode: transportCode ?? (timedOut ? "TIMEOUT" : null) });
    };
    child.once("error", (spawnError) => {
      transportCode = `SPAWN_${spawnError.code ?? spawnError.name ?? "ERROR"}`; finish(null, null);
    });
    child.stdout.once("error", (streamError) => {
      transportCode = `STDOUT_${streamError.code ?? streamError.name ?? "ERROR"}`; finish(null, null);
    });
    child.stderr.once("error", (streamError) => {
      transportCode = `STDERR_${streamError.code ?? streamError.name ?? "ERROR"}`; finish(null, null);
    });
    child.once("close", (status, signal) => { closed = true; finish(status, signal); });
    child.stdin.on("error", (stdinError) => {
      transportCode = `STDIN_${stdinError.code ?? stdinError.name ?? "ERROR"}`; finish(null, null);
    });
    timer = setTimeout(() => {
      timedOut = true; try { child.kill(); } catch {}
      forceTimer = setTimeout(() => finish(null, "TIMEOUT"), 5000);
    }, timeoutMs);
  });
  return {
    write(text) { assert.ok(!settled, "PG16_SESSION_ALREADY_SETTLED"); child.stdin.write(text); },
    async waitFor(marker) {
      const deadline = Date.now() + 10000;
      while (!output.includes(marker) && !closed && !settled && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        throwIfSignalled();
      }
      if (!output.includes(marker)) {
        timedOut = true;
        try { child.kill(); } catch {}
        assert.fail(`PG16_SESSION_MARKER_MISSING:${marker}:${exitStatus ?? "running"}:${exitSignal ?? "no_signal"}`);
      }
    },
    finish(text) { if (!settled) child.stdin.end(text); return result; },
  };
}
function controlledSession(timeoutMs = 60000) {
  const child = spawn("docker", psqlSessionArgs(), { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  return observeControlledSessionChild(child, timeoutMs);
}
async function waitForAdvisoryWaiter(applicationName) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const count = sql(`select count(*) from pg_stat_activity a join pg_locks l on l.pid=a.pid
      where a.application_name='${applicationName}' and l.locktype='advisory' and not l.granted;`, "LOCK_WAITER");
    if (count === "1") return;
    await new Promise((resolve) => setTimeout(resolve, 25));
    throwIfSignalled();
  }
  assert.fail(`PG16_ADVISORY_WAITER_MISSING:${applicationName}`);
}
const roleCall = (name, value) => `set local role service_role;set local request.jwt.claim.role='service_role';select public.${name}($json$${JSON.stringify(value)}$json$::jsonb);`;
const taggedRoleCall = (applicationName, name, value) => `set application_name='${applicationName}';${roleCall(name, value)}`;
const userId = (n) => `12345678-1234-4${String(n).padStart(3, "0")}-8${String(n).padStart(3, "0")}-123456789${String(n).padStart(3, "0")}`;
function payload(seed, principal = hash(`principal-${seed}`), phone = userId(seed)) {
  const now = Date.now(), aiSession = hash(`ai-session-${seed}`), phoneSession = hash(`phone-session-${seed}`);
  return {
    schema: "aistory.aiuser-account-link-proof.v1", confirmation: { confirmLink: true },
    aiuser: { principalKey: principal, sessionBinding: aiSession, authenticatedAt: now - 1000,
      expiresAt: now + 899000, membershipGeneration: 1 },
    phone: { userId: phone, sessionBinding: phoneSession, authenticatedAt: now - 1000,
      expiresAt: now + 600000, active: true },
    intent: { id: hash(`intent-${seed}-${randomBytes(8).toString("hex")}`), principalKey: principal, phoneUserId: phone,
      aiuserSessionBinding: aiSession, phoneSessionBinding: phoneSession, createdAt: now,
      expiresAt: now + 60000, consumed: false },
  };
}
const fixtureSql = (from, to) => Array.from({ length: to - from + 1 }, (_, offset) => {
  const n = from + offset, id = userId(n);
  return `insert into public.app_users(id,tenant_id,identity_type,status) values('${id}','platform','phone','active');
insert into public.phone_identities(phone_hash,user_id,masked_phone,last_verified_at) values('${hash(`phone-${n}`)}','${id}','138****${String(n).padStart(4, "0")}',clock_timestamp());`;
}).join("\n");

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const image = selectImageReference(process.argv.slice(2));
  const requestTermination = (signal) => {
    requestedSignal ??= signal;
    for (const { child } of activeAsyncChildren) {
      try { child.kill(); } catch {}
    }
  };
  const onSigint = () => requestTermination("SIGINT");
  const onSigterm = () => requestTermination("SIGTERM");
  process.on("SIGINT", onSigint); process.on("SIGTERM", onSigterm);
  let qualificationError;
  try {
    assert.equal(checked(run(["ps", "-aq", "--no-trunc", "--filter", "label=aistory.purpose=aiuser-account-link-qualification"]),
      "PREFLIGHT_LABEL_RESIDUE"), "");
    assert.equal(checked(run(["ps", "-aq", "--no-trunc", "--filter", `name=^/${containerName}$`]),
      "PREFLIGHT_NAME_RESIDUE"), "");
    baselineImageIds = [...new Set(checked(run(["image", "ls", "-q", "--no-trunc"]), "PREFLIGHT_IMAGES")
      .split(/\r?\n/).filter(Boolean))].sort();
    baselineVolumeIds = checked(run(["volume", "ls", "-q"]), "PREFLIGHT_VOLUMES")
      .split(/\r?\n/).filter(Boolean).sort();
    const imageValue = JSON.parse(checked(run(["image", "inspect", image, "--format", "{{json .}}"]), "IMAGE"));
    imageId = validateImageMetadata(imageValue, image);
    createAttempted = true;
    const createResult = await runProtectedDocker(["create", "--pull=never", "--rm", "--name", containerName,
      "--label", "aistory.purpose=aiuser-account-link-qualification", "--network", "none",
      "--tmpfs", "/var/lib/postgresql/data:rw,noexec,nosuid,size=768m",
      "--tmpfs", "/var/run/postgresql:rw,nosuid,size=64m", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", image,
      "-c", "listen_addresses=", "-c", "unix_socket_directories=/var/run/postgresql", "-c", "check_function_bodies=on"]);
    createRequestClosed = true;
    containerId = checked(createResult, "CREATE");
    assert.match(containerId, /^[a-f0-9]{64}$/);
    validateContainerMetadata(JSON.parse(checked(run(["inspect", containerId, "--format", "{{json .}}"]), "CONTAINER")),
      { id: containerId, name: containerName, image, imageId, running: false });
    throwIfSignalled();
    containerStartAttempted = true;
    const startResult = await runProtectedDocker(["start", containerId]);
    startRequestClosed = true;
    assert.equal(checked(startResult, "START"), containerId);
    throwIfSignalled();
    validateContainerMetadata(JSON.parse(checked(run(["inspect", containerId, "--format", "{{json .}}"]), "CONTAINER_STARTED")),
      { id: containerId, name: containerName, image, imageId, running: true });
    let stable = 0, last = ""; const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const probe = run(psqlArgs(), "select concat_ws('|',current_setting('server_version_num'),current_setting('server_version'),current_database(),current_user,split_part(pg_read_file('postmaster.pid'),E'\\n',1),inet_server_addr() is null,pg_is_in_recovery());");
      if (probe.status === 0 && probe.stdout.trim() === expectedServer) {
        stable = last === probe.stdout.trim() ? stable + 1 : 1; last = probe.stdout.trim(); if (stable === 2) break;
      } else { stable = 0; last = ""; }
      await new Promise((resolve) => setTimeout(resolve, 250));
      throwIfSignalled();
    }
    assert.equal(stable, 2); gates.push("exact_digest_pg16_unix_socket");
    sql(`create role anon nologin noinherit;create role authenticated nologin noinherit;create role service_role nologin bypassrls;
create schema auth;create schema supabase_migrations authorization postgres;
create table supabase_migrations.schema_migrations(version text primary key,name text not null,sha256 text not null,applied_at timestamptz not null default now());
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
create function auth.role() returns text language sql stable as $$select nullif(current_setting('request.jwt.claim.role',true),'')$$;
grant usage on schema auth to anon,authenticated,service_role;grant execute on function auth.uid(),auth.role() to anon,authenticated,service_role;`, "SYNTHETIC_BASE");
    for (const name of baseline) {
      const bytes = await readFile(`supabase/migrations/${name}`); sql(bytes.toString(), name);
      sql(`insert into supabase_migrations.schema_migrations(version,name,sha256) values('${name.slice(0, 14)}','${name}','${hash(bytes)}');`, "BASE_LEDGER");
    }
    const predecessor = await readFile("supabase/migrations/20260811193000_production_video_asset_metadata_gate.sql");
    assert.equal(hash(predecessor), "2b506307e1b5e42a16ca79d4c3973e44d410cdd00d4228faed012252b3960dc6");
    const migration = await readFile(`supabase/migrations/${migrationName}`);
    const envelope = await readFile(envelopeName, "utf8");
    const include = `\\ir ../supabase/migrations/${migrationName}`;
    assert.equal(envelope.split(include).length, 2); assert.ok(envelope.includes(hash(migration)));
    const apply = envelope.replace(include, () => migration.toString());
    const absent = () => assert.equal(sql(`select to_regclass('public.aiuser_account_links') is null
and not exists(select 1 from supabase_migrations.schema_migrations where version='20260901040000');`, "NO_PARTIAL"), "t");
    mustFail(`update supabase_migrations.schema_migrations set name='wrong' where version='20260811193000';\n${apply}`,
      "ledger_wrong_name", expectedSqlFailure.ledgerPredecessor); absent();
    mustFail(`update supabase_migrations.schema_migrations set sha256=repeat('0',64) where version='20260811193000';\n${apply}`,
      "ledger_wrong_sha", expectedSqlFailure.ledgerPredecessor); absent();
    mustFail(`alter table supabase_migrations.schema_migrations add column statements text[];\n${apply}`,
      "ledger_shape_drift", expectedSqlFailure.ledgerShape); absent();
    const ledgerRaceHolder = controlledSession();
    ledgerRaceHolder.write("begin;select pg_advisory_xact_lock(20260901,40001);select 'LOCKED_LEDGER_RACE';\n");
    await ledgerRaceHolder.waitFor("LOCKED_LEDGER_RACE");
    const ledgerContenderNames = [`aistory_link_ledger_a_${process.pid}`, `aistory_link_ledger_b_${process.pid}`];
    const ledgerContenders = ledgerContenderNames.map((applicationName) => parallel(
      `set application_name='${applicationName}';\n${apply}`, { singleTransaction: false, verboseErrors: true }));
    for (const applicationName of ledgerContenderNames) await waitForAdvisoryWaiter(applicationName);
    const ledgerHolderResult = await ledgerRaceHolder.finish("rollback;\n");
    validateAsyncSuccess(ledgerHolderResult, "LEDGER_RACE_LOCK_HOLDER");
    assert.ok(ledgerHolderResult.output.split(/\r?\n/).includes("LOCKED_LEDGER_RACE"));
    const concurrentApply = await Promise.all(ledgerContenders);
    const raceEvidence = JSON.stringify({ concurrentApply: concurrentApply.map((item, index) =>
      JSON.parse(asyncEvidence(item, `concurrent_apply_${index}`))) });
    const winners = concurrentApply.filter((item) => item.status === 0 && item.signal === null && !item.timedOut
      && item.transportCode === null && item.sqlState === null && item.error === null
      && item.output.split(/\r?\n/).includes("PASS_AIUSER_ACCOUNT_LINK_ATOMIC_LEDGER"));
    const losers = concurrentApply.filter((item) => item.status === 3
      && item.signal === null && !item.timedOut && item.transportCode === null && item.sqlState === "P0001"
      && item.error === "ACCOUNT_LINK_LEDGER_PREDECESSOR_REJECTED");
    assert.equal(winners.length, 1, raceEvidence); assert.equal(losers.length, 1, raceEvidence);
    assert.equal(concurrentApply.length, winners.length + losers.length, raceEvidence);
    validateAsyncSuccess(winners[0], "CONCURRENT_LEDGER_WINNER", /(?:^|\n)PASS_AIUSER_ACCOUNT_LINK_ATOMIC_LEDGER(?:\n|$)/);
    validateAsyncSqlFailure(losers[0], "CONCURRENT_LEDGER_LOSER", expectedSqlFailure.ledgerPredecessor);
    const concurrentLedgerState = sql(`select concat_ws('|',
      (select count(*) from supabase_migrations.schema_migrations where version='20260901040000'
        and name='${migrationName}' and sha256='${hash(migration)}' and applied_at is not null),
      coalesce(public.aistory_aiuser_link_posture(),'NULL'),
      coalesce((select version from public.aistory_schema_gates where gate_name='aiuser_account_link'),'NULL'),
      (select count(*) from pg_class where oid in (
        'public.aiuser_account_links'::regclass,'public.aiuser_account_link_intents'::regclass,
        'public.aiuser_account_link_session_revocations'::regclass,'public.aiuser_account_link_audit'::regclass,
        'public.aiuser_account_link_catalog_manifest'::regclass)),
      (select count(*) from supabase_migrations.schema_migrations where version='20260811193000'
        and name='20260811193000_production_video_asset_metadata_gate.sql'
        and sha256='2b506307e1b5e42a16ca79d4c3973e44d410cdd00d4228faed012252b3960dc6'
        and applied_at is not null));`, "CONCURRENT_LEDGER_STATE");
    assert.equal(concurrentLedgerState, "1|20260901040000|20260901040000|5|1",
      JSON.stringify({ concurrentApply, concurrentLedgerState }));
    gates.push("atomic_concurrent_ledger_once");
    assert.equal(sql("select public.aistory_aiuser_link_posture();", "POSTURE"), "20260901040000");
    assert.equal(sql(`select count(*) from supabase_migrations.schema_migrations where version='20260901040000'
and name='${migrationName}' and sha256='${hash(migration)}';`, "LEDGER_IDENTITY"), "1");
    const validBoundaryKeys = [`constraint:~`, `function:${"q".repeat(300)}`];
    const validBoundaryResult = checked(run(psqlSessionArgs(), `begin;
      insert into public.aiuser_account_link_catalog_manifest(object_key,definition_sha256) values
        ('${validBoundaryKeys[0]}',repeat('a',64)),('${validBoundaryKeys[1]}',repeat('b',64));
      select count(*) from public.aiuser_account_link_catalog_manifest where object_key in
        ('${validBoundaryKeys[0]}','${validBoundaryKeys[1]}');rollback;`), "CATALOG_KEY_VALID_BOUNDARIES");
    assert.equal(validBoundaryResult, "2");
    for (const [label, expression] of [
      ["catalog_key_301_suffix", `'constraint:${"q".repeat(301)}'`],
      ["catalog_key_empty_suffix", "'constraint:'"],
      ["catalog_key_invalid_prefix", "'invalid:x'"],
      ["catalog_key_nonprint_suffix", "'constraint:' || chr(31)"],
      ["catalog_key_tab_suffix", "'constraint:' || chr(9)"],
      ["catalog_key_newline_suffix", "'constraint:' || chr(10)"],
      ["catalog_key_del_suffix", "'constraint:' || chr(127)"],
      ["catalog_key_nonascii_suffix", "U&'constraint:\\00E9'"],
    ]) mustFail(`insert into public.aiuser_account_link_catalog_manifest(object_key,definition_sha256)
      select ${expression},repeat('c',64);`, label, expectedSqlFailure.catalogShape);
    assert.equal(sql(`select count(*) from public.aiuser_account_link_catalog_manifest
      where object_key in ('${validBoundaryKeys[0]}','${validBoundaryKeys[1]}');`, "CATALOG_KEY_BOUNDARY_ROLLBACK"), "0");
    gates.push("catalog_manifest_object_key_pg16_boundaries");
    mustFail(apply, "ledger_replay", expectedSqlFailure.ledgerPredecessor);
    mustFail(migration.toString(), "migration_replay", expectedSqlFailure.migrationReplay);
    sql(fixtureSql(1, 20), "PHONE_FIXTURES");
    const tablePrivileges = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
    for (const table of ["aiuser_account_links", "aiuser_account_link_intents", "aiuser_account_link_session_revocations",
      "aiuser_account_link_audit", "aiuser_account_link_catalog_manifest"]) {
      for (const role of ["anon", "authenticated", "service_role"]) {
        assert.equal(sql(`select bool_and(not has_table_privilege('${role}','public.${table}',privilege_name))
          from unnest(array[${tablePrivileges.map((value) => `'${value}'`).join(",")}]::text[]) p(privilege_name);`,
        `ACL_${role}_${table}`), "t");
        mustFail(`set local role ${role};select * from public.${table};`, `rls_${role}_${table}`,
          expectedSqlFailure.tablePrivilege);
      }
    }
    const callableFunctions = ["aistory_aiuser_link_posture()", "aistory_aiuser_link_is_linked(text)",
      "aistory_aiuser_link_prepare(jsonb)", "aistory_aiuser_link_confirm(jsonb)",
      "aistory_aiuser_link_revoke_sessions(jsonb)"];
    const internalFunctions = ["aistory_aiuser_link_immutable()", "aistory_aiuser_link_validate_payload(jsonb)",
      "aistory_aiuser_link_catalog()"];
    for (const signature of [...callableFunctions, ...internalFunctions]) {
      for (const role of ["anon", "authenticated"]) assert.equal(sql(
        `select has_function_privilege('${role}','public.${signature}','EXECUTE');`, `FUNCTION_ACL_${role}_${signature}`), "f");
      assert.equal(sql(`select has_function_privilege('service_role','public.${signature}','EXECUTE');`,
        `FUNCTION_ACL_service_role_${signature}`), callableFunctions.includes(signature) ? "t" : "f");
    }
    gates.push("role_scoped_table_and_function_acl");
    for (const hostile of [
      "alter table public.aiuser_account_link_audit alter column confirmed_at set default 'epoch'::timestamptz;",
      "alter table public.aiuser_account_link_intents disable row level security;",
      "grant select on public.aiuser_account_links to service_role;",
      "alter table public.aiuser_account_link_audit disable trigger aiuser_account_link_audit_immutable;",
      "alter function public.aistory_aiuser_link_confirm(jsonb) set search_path=public;",
    ]) assert.equal(sql(`begin;${hostile}select public.aistory_aiuser_link_posture() is null;rollback;`, "POSTURE_DRIFT"), "t");
    const first = payload(1); assert.equal(sql(roleCall("aistory_aiuser_link_prepare", first), "PREPARE"), "prepared");
    assert.equal(sql(roleCall("aistory_aiuser_link_confirm", first), "CONFIRM"), "linked");
    assert.equal(sql(roleCall("aistory_aiuser_link_confirm", first), "EXACT_REPLAY"), "linked");
    assert.equal(sql("select concat_ws(':',(select count(*) from public.aiuser_account_links),(select count(*) from public.aiuser_account_link_intents),(select count(*) from public.aiuser_account_link_audit));", "COUNTS"), "1:1:1");
    const samePair = payload(2, first.aiuser.principalKey, first.phone.userId);
    assert.equal(sql(roleCall("aistory_aiuser_link_prepare", samePair), "PREPARE_SAME_PAIR"), "prepared");
    assert.equal(sql(roleCall("aistory_aiuser_link_confirm", samePair), "CONFIRM_SAME_PAIR"), "already_linked");
    const race = payload(3); sql(roleCall("aistory_aiuser_link_prepare", race), "PREPARE_RACE");
    const raceResults = await Promise.all([parallel(roleCall("aistory_aiuser_link_confirm", race)),
      parallel(roleCall("aistory_aiuser_link_confirm", race))]);
    for (const [index, item] of raceResults.entries()) validateAsyncSuccess(item, `IDEMPOTENT_CONFIRM_${index}`, "linked");
    gates.push("idempotent_concurrent_exact_replay");
    const revoked = payload(4); sql(roleCall("aistory_aiuser_link_prepare", revoked), "PREPARE_REVOKED");
    assert.equal(sql(roleCall("aistory_aiuser_link_revoke_sessions", { aiuser: {
      principalKey: revoked.aiuser.principalKey, sessionBinding: revoked.aiuser.sessionBinding }, phone: null }), "REVOKE"), "t");
    assert.equal(sql(roleCall("aistory_aiuser_link_revoke_sessions", { aiuser: {
      principalKey: revoked.aiuser.principalKey, sessionBinding: revoked.aiuser.sessionBinding }, phone: null }), "REVOKE_RETRY"), "t");
    assert.equal(sql(`select count(*) from public.aiuser_account_link_session_revocations
      where session_kind='aiuser' and session_hash='${revoked.aiuser.sessionBinding}';`, "REVOKE_RETRY_COUNT"), "1");
    mustFail(roleCall("aistory_aiuser_link_prepare", revoked), "revoked_session_prepare_replay",
      expectedSqlFailure.accountRejected);
    mustFail(roleCall("aistory_aiuser_link_confirm", revoked), "revoked_session_confirm",
      expectedSqlFailure.accountRejected);
    mustFail(roleCall("aistory_aiuser_link_revoke_sessions", { aiuser: {
      principalKey: hash("different-revocation-owner"), sessionBinding: revoked.aiuser.sessionBinding }, phone: null }),
    "different_revocation_proof", expectedSqlFailure.accountRejected);
    const committedThenRevoked = payload(5); sql(roleCall("aistory_aiuser_link_prepare", committedThenRevoked), "PREPARE_CONFIRM_FIRST");
    assert.equal(sql(roleCall("aistory_aiuser_link_confirm", committedThenRevoked), "CONFIRM_FIRST"), "linked");
    assert.equal(sql(roleCall("aistory_aiuser_link_revoke_sessions", { aiuser: {
      principalKey: committedThenRevoked.aiuser.principalKey, sessionBinding: committedThenRevoked.aiuser.sessionBinding },
    phone: { userId: committedThenRevoked.phone.userId, sessionBinding: committedThenRevoked.phone.sessionBinding } }),
    "REVOKE_AFTER_CONFIRM"), "t");
    assert.equal(sql(roleCall("aistory_aiuser_link_revoke_sessions", { aiuser: {
      principalKey: committedThenRevoked.aiuser.principalKey, sessionBinding: committedThenRevoked.aiuser.sessionBinding },
    phone: { userId: committedThenRevoked.phone.userId, sessionBinding: committedThenRevoked.phone.sessionBinding } }),
    "REVOKE_AFTER_CONFIRM_RETRY"), "t");
    assert.equal(sql(`select count(*) from public.aiuser_account_link_session_revocations where
      (session_kind='aiuser' and session_hash='${committedThenRevoked.aiuser.sessionBinding}') or
      (session_kind='phone' and session_hash='${committedThenRevoked.phone.sessionBinding}');`, "COMBINED_REVOKE_RETRY_COUNT"), "2");
    mustFail(roleCall("aistory_aiuser_link_confirm", committedThenRevoked), "confirm_replay_after_logout",
      expectedSqlFailure.accountRejected);
    const phoneRevoked = payload(6); sql(roleCall("aistory_aiuser_link_prepare", phoneRevoked), "PREPARE_PHONE_REVOKED");
    assert.equal(sql(roleCall("aistory_aiuser_link_revoke_sessions", { aiuser: null, phone: {
      userId: phoneRevoked.phone.userId, sessionBinding: phoneRevoked.phone.sessionBinding } }), "REVOKE_PHONE"), "t");
    assert.equal(sql(roleCall("aistory_aiuser_link_revoke_sessions", { aiuser: null, phone: {
      userId: phoneRevoked.phone.userId, sessionBinding: phoneRevoked.phone.sessionBinding } }), "REVOKE_PHONE_RETRY"), "t");
    assert.equal(sql(`select count(*) from public.aiuser_account_link_session_revocations
      where session_kind='phone' and session_hash='${phoneRevoked.phone.sessionBinding}';`, "REVOKE_PHONE_RETRY_COUNT"), "1");
    mustFail(roleCall("aistory_aiuser_link_revoke_sessions", { aiuser: null, phone: {
      userId: userId(20), sessionBinding: phoneRevoked.phone.sessionBinding } }), "different_phone_revocation_proof",
    expectedSqlFailure.accountRejected);
    mustFail(roleCall("aistory_aiuser_link_confirm", phoneRevoked), "revoked_phone_session_confirm",
      expectedSqlFailure.accountRejected);
    for (const malformed of [
      { aiuser: null, phone: null },
      { aiuser: { principalKey: null, sessionBinding: revoked.aiuser.sessionBinding }, phone: null },
      { aiuser: null, phone: { userId: phoneRevoked.phone.userId, sessionBinding: null } },
    ]) mustFail(roleCall("aistory_aiuser_link_revoke_sessions", malformed), "malformed_session_revocation",
      expectedSqlFailure.accountRejected);
    const rolledBack = payload(7); sql(roleCall("aistory_aiuser_link_prepare", rolledBack), "PREPARE_ROLLBACK");
    mustFail(`${roleCall("aistory_aiuser_link_confirm", rolledBack)}select 1/0;`, "outer_transaction_atomic_rollback",
      expectedSqlFailure.divisionByZero);
    assert.equal(sql(`select count(*) from public.aiuser_account_links where principal_hash='${rolledBack.aiuser.principalKey}';`, "ROLLBACK_MAPPING"), "0");
    const logoutFirst = payload(8); sql(roleCall("aistory_aiuser_link_prepare", logoutFirst), "PREPARE_LOCK_LOGOUT_FIRST");
    const logoutHolder = controlledSession();
    logoutHolder.write("begin;select pg_advisory_xact_lock(20260901,40000);select 'LOCKED_LOGOUT_FIRST';\n");
    await logoutHolder.waitFor("LOCKED_LOGOUT_FIRST");
    const confirmWaiterName = `aistory_link_confirm_wait_${process.pid}`;
    const waitingConfirm = parallel(taggedRoleCall(confirmWaiterName, "aistory_aiuser_link_confirm", logoutFirst),
      { verboseErrors: true });
    await waitForAdvisoryWaiter(confirmWaiterName);
    const logoutPayload = { aiuser: { principalKey: logoutFirst.aiuser.principalKey,
      sessionBinding: logoutFirst.aiuser.sessionBinding }, phone: { userId: logoutFirst.phone.userId,
      sessionBinding: logoutFirst.phone.sessionBinding } };
    const [logoutHolderResult, waitingConfirmResult] = await Promise.all([
      logoutHolder.finish(`${roleCall("aistory_aiuser_link_revoke_sessions", logoutPayload)}commit;\n`), waitingConfirm,
    ]);
    validateAsyncSuccess(logoutHolderResult, "LOGOUT_LOCK_HOLDER");
    const logoutHolderLines = logoutHolderResult.output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    assert.ok(logoutHolderLines.includes("LOCKED_LOGOUT_FIRST")); assert.ok(logoutHolderLines.includes("t"));
    validateAsyncSqlFailure(waitingConfirmResult, "CONFIRM_WAITS_BEHIND_LOGOUT", expectedSqlFailure.accountRejected);
    assert.equal(sql(`select concat_ws(':',
      (select count(*) from public.aiuser_account_links where principal_hash='${logoutFirst.aiuser.principalKey}'),
      (select count(*) from public.aiuser_account_link_audit where principal_hash='${logoutFirst.aiuser.principalKey}'),
      (select count(*) from public.aiuser_account_link_intents where principal_hash='${logoutFirst.aiuser.principalKey}'),
      (select count(*) from public.aiuser_account_link_session_revocations where
        session_hash in ('${logoutFirst.aiuser.sessionBinding}','${logoutFirst.phone.sessionBinding}')));`, "LOGOUT_FIRST_STATE"), "0:0:1:2");
    mustFail(roleCall("aistory_aiuser_link_prepare", logoutFirst), "logout_first_prepare_replay",
      expectedSqlFailure.accountRejected);
    gates.push("logout_holds_lock_confirm_waits_then_fails");

    const confirmFirstLocked = payload(9); sql(roleCall("aistory_aiuser_link_prepare", confirmFirstLocked), "PREPARE_LOCK_CONFIRM_FIRST");
    const confirmHolder = controlledSession();
    confirmHolder.write("begin;select pg_advisory_xact_lock(20260901,40000);select 'LOCKED_CONFIRM_FIRST';\n");
    await confirmHolder.waitFor("LOCKED_CONFIRM_FIRST");
    const revokeWaiterName = `aistory_link_revoke_wait_${process.pid}`;
    const confirmFirstRevoke = { aiuser: { principalKey: confirmFirstLocked.aiuser.principalKey,
      sessionBinding: confirmFirstLocked.aiuser.sessionBinding }, phone: { userId: confirmFirstLocked.phone.userId,
      sessionBinding: confirmFirstLocked.phone.sessionBinding } };
    const waitingRevoke = parallel(taggedRoleCall(revokeWaiterName, "aistory_aiuser_link_revoke_sessions", confirmFirstRevoke));
    await waitForAdvisoryWaiter(revokeWaiterName);
    const [confirmHolderResult, waitingRevokeResult] = await Promise.all([
      confirmHolder.finish(`${roleCall("aistory_aiuser_link_confirm", confirmFirstLocked)}commit;\n`), waitingRevoke,
    ]);
    validateAsyncSuccess(confirmHolderResult, "CONFIRM_LOCK_HOLDER");
    const confirmHolderLines = confirmHolderResult.output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    assert.ok(confirmHolderLines.includes("LOCKED_CONFIRM_FIRST")); assert.ok(confirmHolderLines.includes("linked"));
    validateAsyncSuccess(waitingRevokeResult, "REVOKE_WAITS_BEHIND_CONFIRM", "t");
    assert.equal(sql(`select concat_ws(':',
      (select count(*) from public.aiuser_account_links where principal_hash='${confirmFirstLocked.aiuser.principalKey}'),
      (select count(*) from public.aiuser_account_link_audit where principal_hash='${confirmFirstLocked.aiuser.principalKey}'),
      (select count(*) from public.aiuser_account_link_intents where principal_hash='${confirmFirstLocked.aiuser.principalKey}'),
      (select count(*) from public.aiuser_account_link_session_revocations where
        session_hash in ('${confirmFirstLocked.aiuser.sessionBinding}','${confirmFirstLocked.phone.sessionBinding}')));`, "CONFIRM_FIRST_LOCKED_STATE"), "1:1:1:2");
    mustFail(roleCall("aistory_aiuser_link_confirm", confirmFirstLocked), "confirm_first_locked_replay_after_logout",
      expectedSqlFailure.accountRejected);
    gates.push("confirm_holds_lock_revoke_waits_then_blocks_replay");
    const immutableStateBefore = sql(immutableSnapshotSql, "IMMUTABLE_STATE_BEFORE");
    for (const immutableCase of immutableMutationCases) {
      mustFail(immutableCase.sql, immutableCase.label, expectedSqlFailure.immutable);
      assert.equal(sql(immutableSnapshotSql, `IMMUTABLE_STATE_AFTER_${immutableCase.table}_${immutableCase.operation}`),
        immutableStateBefore, `${immutableCase.label}_STATE_CHANGED`);
    }
    assert.equal(sql(immutableSnapshotSql, "IMMUTABLE_STATE_AFTER_ALL"), immutableStateBefore);
    gates.push("immutable_update_delete_truncate_preserve_all_five_tables");
    assert.equal(sql("select public.aistory_database_gate_status();", "BASE_GATE_PRESERVED"), "20260811193000");
    await settleAsyncChildren();
    throwIfSignalled();
    passPayload = { status: "PASS_AIUSER_ACCOUNT_LINK_POSTGRES16", image, migrationSha256: hash(migration),
      gates: gates.length, network: "none", publishedPorts: 0, productionEnabled: false, deployment: false };
  } catch (error) {
    qualificationError = error;
  } finally {
    cleanupInProgress = true;
    if (requestedSignal && !qualificationError) qualificationError = new Error(`PG16_RUNNER_SIGNALLED:${requestedSignal}`);
    const cleanupErrors = [];
    const captureCleanup = async (label, action) => {
      try { await action(); } catch (error) { cleanupErrors.push(new Error(label, { cause: error })); }
    };
    const removeQualificationContainer = (target, label) => {
      assert.match(target, /^[a-f0-9]{64}$/, `${label}_ID_REJECTED`);
      const value = JSON.parse(checked(run(["inspect", target, "--format", "{{json .}}"]), `${label}_INSPECT`));
      assert.equal(value.Id, target); assert.equal(value.Name, `/${containerName}`);
      if (imageId) assert.equal(value.Image, imageId);
      assert.equal(record(value.Config).Labels["aistory.purpose"], "aiuser-account-link-qualification");
      checked(run(["rm", "-f", target]), `${label}_REMOVE`);
    };
    await captureCleanup("CLEANUP_ASYNC_CHILD_SETTLE_BEFORE_CONTAINER", () =>
      settleAsyncChildren({ terminate: true }));
    await captureCleanup("CLEANUP_PROTECTED_DOCKER_REQUESTS_SETTLED", () => {
      assert.equal(activeProtectedDockerChildren.size, 0, "PROTECTED_DOCKER_CHILD_RESIDUE");
      if (createAttempted) assert.equal(createRequestClosed, true, "CREATE_REQUEST_NOT_CLOSED");
      if (containerStartAttempted) assert.equal(startRequestClosed, true, "START_REQUEST_NOT_CLOSED");
    });
    await captureCleanup("CLEANUP_TRUSTED_CONTAINER_ID", () => {
      if (!createAttempted || !containerId || !/^[a-f0-9]{64}$/.test(containerId)) return;
      removeQualificationContainer(containerId, "CLEANUP_TRUSTED_ID");
    });
    await captureCleanup("CLEANUP_EXACT_NAME_FALLBACK", () => {
      if (!createAttempted || !containerId || !/^[a-f0-9]{64}$/.test(containerId)) return;
      const namedIds = checked(run(["ps", "-aq", "--no-trunc", "--filter", `name=^/${containerName}$`]), "CLEANUP_NAME_LOOKUP")
        .split(/\r?\n/).filter(Boolean);
      assert.ok(namedIds.length <= 1 && namedIds.every((value) => /^[a-f0-9]{64}$/.test(value)),
        "CLEANUP_NAME_LOOKUP_REJECTED");
      const fallbackTarget = namedIds[0] ?? null;
      if (fallbackTarget) {
        if (containerId && /^[a-f0-9]{64}$/.test(containerId)) {
          assert.equal(fallbackTarget, containerId, "CLEANUP_CONTAINER_ID_MISMATCH");
        }
        removeQualificationContainer(fallbackTarget, "CLEANUP_NAME_FALLBACK");
      }
    });
    await captureCleanup("CLEANUP_UNTRUSTED_CREATE_RECONCILE", async () => {
      if (!createAttempted || (containerId && /^[a-f0-9]{64}$/.test(containerId))) return;
      assert.equal(createRequestClosed, true, "UNTRUSTED_CREATE_REQUEST_NOT_CLOSED");
      const deadline = Date.now() + 15000;
      let emptyObservations = 0, queryFailures = 0, removalFailures = 0;
      while (Date.now() < deadline) {
        const named = run(["ps", "-aq", "--no-trunc", "--filter", `name=^/${containerName}$`], undefined, 5000);
        if (named.status !== 0 || named.signal != null || named.error) {
          queryFailures++; emptyObservations = 0;
        } else {
          const namedIds = named.stdout.trim().split(/\r?\n/).filter(Boolean);
          assert.ok(namedIds.length <= 1 && namedIds.every((value) => /^[a-f0-9]{64}$/.test(value)),
            "CLEANUP_RECONCILE_ID_REJECTED");
          const lateTarget = namedIds[0] ?? null;
          if (lateTarget) {
            try {
              removeQualificationContainer(lateTarget, "CLEANUP_LATE_NAME_FALLBACK");
              return;
            }
            catch { removalFailures++; }
          } else {
            emptyObservations++;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error(`CLEANUP_UNTRUSTED_CREATE_EXTERNAL_RECONCILIATION_REQUIRED:q${queryFailures}:r${removalFailures}:e${emptyObservations}`);
    });
    await captureCleanup("CLEANUP_ASYNC_CHILD_SETTLE_AFTER_CONTAINER", () =>
      settleAsyncChildren({ terminate: true }));
    await captureCleanup("CLEANUP_CONTAINER_RESIDUE", () => {
      assert.equal(checked(run(["ps", "-aq", "--no-trunc", "--filter", "label=aistory.purpose=aiuser-account-link-qualification"]),
        "CLEANUP_LABEL_RESIDUE"), "");
      assert.equal(checked(run(["ps", "-aq", "--no-trunc", "--filter", `name=^/${containerName}$`]),
        "CLEANUP_NAME_RESIDUE"), "");
    });
    await captureCleanup("CLEANUP_IMAGE_RESIDUE", () => {
      if (!baselineImageIds) return;
      const finalImageIds = [...new Set(checked(run(["image", "ls", "-q", "--no-trunc"]), "CLEANUP_IMAGES")
        .split(/\r?\n/).filter(Boolean))].sort();
      assert.deepEqual(finalImageIds, baselineImageIds, "CLEANUP_IMAGE_RESIDUE");
    });
    await captureCleanup("CLEANUP_VOLUME_RESIDUE", () => {
      if (!baselineVolumeIds) return;
      const finalVolumeIds = checked(run(["volume", "ls", "-q"]), "CLEANUP_VOLUMES")
        .split(/\r?\n/).filter(Boolean).sort();
      assert.deepEqual(finalVolumeIds, baselineVolumeIds, "CLEANUP_VOLUME_RESIDUE");
    });
    await captureCleanup("CLEANUP_ASYNC_CHILD_RESIDUE", () => assert.equal(activeAsyncChildren.size, 0));
    await captureCleanup("CLEANUP_PROTECTED_DOCKER_CHILD_RESIDUE", () =>
      assert.equal(activeProtectedDockerChildren.size, 0));
    await captureCleanup("CLEANUP_SIGNAL_EVENT_LOOP_BARRIER", () =>
      new Promise((resolve) => setImmediate(resolve)));
    if (requestedSignal && !qualificationError) qualificationError = new Error(`PG16_RUNNER_SIGNALLED:${requestedSignal}`);
    process.off("SIGINT", onSigint); process.off("SIGTERM", onSigterm);
    cleanupInProgress = false;
    if (requestedSignal && !qualificationError) qualificationError = new Error(`PG16_RUNNER_SIGNALLED:${requestedSignal}`);
    cleanupVerified = cleanupErrors.length === 0;
    if (qualificationError && cleanupErrors.length > 0) {
      throw new AggregateError([qualificationError, ...cleanupErrors], "PG16_QUALIFICATION_AND_CLEANUP_FAILED");
    }
    if (qualificationError) throw qualificationError;
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "PG16_CLEANUP_FAILED");
  }
  assert.ok(passPayload, "PG16_PASS_PAYLOAD_MISSING");
  console.log(JSON.stringify({ ...passPayload, cleanupVerified, containerResidues: 0, labelResidues: 0,
    nameResidues: 0, imageResidues: 0, volumeResidues: 0, asyncChildResidues: 0 }));
}
