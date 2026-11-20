import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const POSTGRES_IMAGE =
  "postgres@sha256:f1c3376c26f2609ab9f29f71f824103fe2fcd8ee0346485cb6122a4f93df6f94";
const POSTGRES_IMAGE_DIGEST_SUFFIX = POSTGRES_IMAGE.slice(
  POSTGRES_IMAGE.indexOf("@sha256:"),
);
const POSTGRES_SOCKET_DIRECTORY = "/var/run/postgresql";
const POSTGRES_PORT = "5432";
const EXPECTED_POSTGRES_SERVER_VERSION =
  "16.15 (Debian 16.15-1.pgdg13+2)";
const EXPECTED_POSTGRES_SERVER_VERSION_NUM = "160015";
const POSTGRES_VERSION_GATE_TIMEOUT_MS = 60_000;
const POSTGRES_VERSION_GATE_COMMAND_TIMEOUT_MS = 5_000;
const POSTGRES_VERSION_GATE_STABILITY_DELAY_MS = 250;
const POSTGRES_VERSION_GATE_IDENTITY_SQL = [
  "select jsonb_build_object(",
  "  'serverVersion', current_setting('server_version'),",
  "  'serverVersionNum', current_setting('server_version_num'),",
  "  'currentDatabase', current_database(),",
  "  'currentUser', current_user,",
  "  'postmasterPid', split_part(pg_read_file('postmaster.pid'), E'\\n', 1)::integer,",
  "  'socketDirectories', current_setting('unix_socket_directories'),",
  "  'serverAddress', inet_server_addr(),",
  "  'serverPort', inet_server_port(),",
  "  'inRecovery', pg_is_in_recovery(),",
  "  'postmasterStartTime', extract(epoch from pg_postmaster_start_time())::text",
  ")::text;",
].join("\n");
const POSTGRES_IMAGE_METADATA_FORMAT = [
  "{",
  '"id":{{json .Id}},',
  '"repoDigests":{{json .RepoDigests}}',
  "}",
].join("");
const CONTAINER_METADATA_FORMAT = [
  "{",
  '"id":{{json .Id}},',
  '"name":{{json .Name}},',
  '"imageId":{{json .Image}},',
  '"imageRef":{{json .Config.Image}},',
  '"purposeLabel":{{json (index .Config.Labels "aistory.purpose")}},',
  '"running":{{json .State.Running}},',
  '"autoRemove":{{json .HostConfig.AutoRemove}},',
  '"networkMode":{{json .HostConfig.NetworkMode}},',
  '"portBindings":{{json .HostConfig.PortBindings}},',
  '"publishAllPorts":{{json .HostConfig.PublishAllPorts}},',
  '"tmpfs":{{json .HostConfig.Tmpfs}},',
  '"networkPorts":{{json .NetworkSettings.Ports}},',
  '"mounts":[',
  "{{range $index, $mount := .Mounts}}{{if $index}},{{end}}",
  "{",
  '"destination":{{json $mount.Destination}},',
  '"type":{{json $mount.Type}},',
  '"rw":{{json $mount.RW}}',
  "}",
  "{{end}}",
  "]}",
].join("");
const EXPECTED_REPLACEMENT_BYTES = 57_208;
const EXPECTED_REPLACEMENT_SHA256 =
  "29c23ec6ef72ae04a9037d5c191ccc2b9d0e7fee614284f26a611bb4c4ef2b97";
const REPLACEMENT_MIGRATION =
  "20260828233000_independent_admin_principal_pg16_gate.sql";
const RETIREMENT_MIGRATION =
  "20260829063000_independent_admin_qualification_residue_retirement_gate.sql";
const GATE15_LEDGER_NAME = REPLACEMENT_MIGRATION;
const GATE16_LEDGER_NAME = RETIREMENT_MIGRATION;
const SUPERSEDED_INFERRED_GATE15_LEDGER_NAME =
  "independent_admin_principal_pg16_gate";
const EXPECTED_RETIREMENT_BYTES = 66_767;
const EXPECTED_RETIREMENT_SHA256 =
  "4c958ca8af443e97f254fef1cfb1c2e6ea48f1907466d1b1c2ebc2282f598644";
const GATE16_LEDGER_APPLICATOR =
  "apply-independent-admin-gate16-ledger.psql";
const EXPECTED_GATE16_LEDGER_APPLICATOR_BYTES = 11_011;
const EXPECTED_GATE16_LEDGER_APPLICATOR_SHA256 =
  "c1ac48723bdc9ad60edd6dd7f08a30f8389a47b71fe35cc16519297c6d3e6879";
const SUPERSEDED_MIGRATION =
  "20260828230000_independent_admin_principal_gate.sql";
const BASE_MIGRATIONS = [
  "20260624135618_stories.sql",
  "20260628095015_upsert_story_if_newer.sql",
  "20260726174500_admin_console_p1.sql",
  "20260727193000_platform_provider_credentials.sql",
  "20260728193000_phone_billing_p1.sql",
  "20260729093000_production_identity_billing_gate.sql",
  "20260729183000_anonymous_phone_claim_gate.sql",
  "20260731120000_sensitive_identity_billing_privilege_hardening.sql",
  "20260731183000_admin_identity_rpc_read_gate.sql",
  "20260801193000_hosted_byok_vault_gate.sql",
  "20260801213000_hosted_byok_rpc_ambiguity_hardening.sql",
  "20260802113000_hosted_byok_rpc_runtime_qualification_hardening.sql",
  "20260809113000_phone_admin_identity_gate.sql",
  "20260811193000_production_video_asset_metadata_gate.sql",
];

const root = process.cwd();
const migrationDirectory = path.join(root, "supabase", "migrations");
const gate16LedgerApplicatorPath = path.join(
  root,
  "scripts",
  GATE16_LEDGER_APPLICATOR,
);
const containerName = `aistory-p05-pg16-${process.pid}-${randomBytes(4).toString("hex")}`;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const EMPTY_DATABASE = "gate16_empty";
const ACTIVE_DATABASE = "gate16_active";
const REAL_DATABASE = "gate16_real";
const DRIFT_DATABASE = "gate16_drift";
const CONCURRENT_DATABASE = "gate16_concurrent";
const LEGACY_LEDGER_DATABASE = "gate16_legacy_ledger";
const APPEND_FAILURE_DATABASE = "gate16_append_failure";
const APPLY_CONCURRENT_DATABASE = "gate16_apply_concurrent";
const LEDGER_SHAPE_DATABASE = "gate16_ledger_shape";
const LEDGER_TRIGGER_DATABASE = "gate16_ledger_trigger";
const LEDGER_PREDECESSOR_STEM_DATABASE = "gate16_ledger_predecessor_stem";
const LEDGER_PREDECESSOR_ALIAS_DATABASE = "gate16_ledger_predecessor_alias";
const LEDGER_PREDECESSOR_VERSION_DATABASE = "gate16_ledger_predecessor_version";
const LEDGER_PREDECESSOR_SHA_DATABASE = "gate16_ledger_predecessor_sha";
const LEDGER_PREDECESSOR_APPLIED_AT_DATABASE =
  "gate16_ledger_predecessor_applied_at";

function isPlainRecord(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function parsePlainJsonRecord(raw, label) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${label} returned malformed JSON`);
  }
  assert.ok(isPlainRecord(parsed), `${label} must return a plain JSON object`);
  return parsed;
}

function assertExactKeys(value, keys, label) {
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), label);
}

function assertEmptyRecordOrNull(value, label) {
  if (value === null) return;
  assert.ok(isPlainRecord(value), `${label} must be null or a plain object`);
  assert.deepEqual(Object.keys(value), [], `${label} must contain no bindings`);
}

function assertTmpfsOptions(raw, expectedFlags, expectedSizes, label) {
  assert.equal(typeof raw, "string", `${label} options must be a string`);
  const options = raw.split(",");
  assert.ok(options.every((option) => option.length > 0), `${label} has empty options`);
  assert.equal(new Set(options).size, options.length, `${label} has duplicate options`);
  const sizeOptions = options.filter((option) => option.startsWith("size="));
  assert.equal(sizeOptions.length, 1, `${label} must have one size option`);
  assert.ok(
    expectedSizes.includes(sizeOptions[0].slice("size=".length)),
    `${label} has an unexpected size`,
  );
  assert.deepEqual(
    options.filter((option) => !option.startsWith("size=")).sort(),
    [...expectedFlags].sort(),
    `${label} has unexpected flags`,
  );
}

class PostgresVersionGateError extends Error {
  constructor(category, code, attempts = 0) {
    super(`${category}:${code}`);
    this.name = "PostgresVersionGateError";
    this.category = category;
    this.code = code;
    this.attempts = attempts;
  }
}

function postgresVersionGateFailureReceipt(error) {
  return {
    status: "BLOCKED_GATE16_POSTGRES_VERSION_GATE",
    phase: "POSTGRES_VERSION_GATE",
    category: error.category,
    code: error.code,
    attempts: error.attempts,
    expectedServerVersion: EXPECTED_POSTGRES_SERVER_VERSION,
    expectedServerVersionNum: EXPECTED_POSTGRES_SERVER_VERSION_NUM,
    connection: "container_unix_socket_only",
    networkMode: "none",
    hostPorts: 0,
    secretsRead: 0,
    externalNetworkCalls: 0,
  };
}

function versionGateError(category, code, attempts = 0) {
  return new PostgresVersionGateError(category, code, attempts);
}

function parsePostgresIdentity(raw) {
  let identity;
  try {
    identity = JSON.parse(raw);
  } catch {
    throw versionGateError(
      "POSTGRES_PROBE_PROTOCOL_INVALID",
      "IDENTITY_MALFORMED",
    );
  }
  const keys = [
    "currentDatabase",
    "currentUser",
    "inRecovery",
    "postmasterPid",
    "postmasterStartTime",
    "serverAddress",
    "serverPort",
    "serverVersion",
    "serverVersionNum",
    "socketDirectories",
  ];
  if (!isPlainRecord(identity)
      || Object.keys(identity).length !== keys.length
      || !keys.every((key) => Object.hasOwn(identity, key))) {
    throw versionGateError(
      "POSTGRES_PROBE_PROTOCOL_INVALID",
      "IDENTITY_SHAPE_INVALID",
    );
  }
  if (typeof identity.serverVersion !== "string"
      || typeof identity.serverVersionNum !== "string") {
    throw versionGateError(
      "POSTGRES_PROBE_PROTOCOL_INVALID",
      "VERSION_FIELDS_INVALID",
    );
  }
  if (identity.serverVersion !== EXPECTED_POSTGRES_SERVER_VERSION
      || identity.serverVersionNum !== EXPECTED_POSTGRES_SERVER_VERSION_NUM) {
    throw versionGateError(
      "POSTGRES_VERSION_MISMATCH",
      "UNAPPROVED_EXACT_VERSION",
    );
  }
  if (identity.currentDatabase !== "postgres"
      || identity.currentUser !== "postgres"
      || identity.socketDirectories !== POSTGRES_SOCKET_DIRECTORY
      || identity.serverAddress !== null
      || identity.serverPort !== null
      || identity.inRecovery !== false) {
    throw versionGateError(
      "POSTGRES_CONNECTION_POSTURE_INVALID",
      "IDENTITY_POSTURE_INVALID",
    );
  }
  if (!Number.isSafeInteger(identity.postmasterPid)
      || identity.postmasterPid <= 0
      || typeof identity.postmasterStartTime !== "string"
      || !/^\d+(?:\.\d+)?$/.test(identity.postmasterStartTime)) {
    throw versionGateError(
      "POSTGRES_PROBE_PROTOCOL_INVALID",
      "POSTMASTER_FIELDS_INVALID",
    );
  }
  return identity;
}

function commandSucceeded(result) {
  return result !== null
    && typeof result === "object"
    && !result.error
    && result.status === 0;
}

function probeFinalPostgresOnce(execute, targetContainerId) {
  const inspection = execute([
    "container",
    "inspect",
    "--format",
    "{{json .State.Running}}",
    targetContainerId,
  ]);
  if (!commandSucceeded(inspection)) {
    return { state: "retry", code: "CONTAINER_INSPECTION_UNAVAILABLE" };
  }
  if (inspection.stdout.trim() !== "true") {
    return {
      state: "fatal",
      error: versionGateError(
        "POSTGRES_CONNECTION_FAILURE",
        "CONTAINER_EXITED",
      ),
    };
  }

  const pidOne = execute([
    "exec",
    targetContainerId,
    "cat",
    "/proc/1/comm",
  ]);
  if (!commandSucceeded(pidOne) || pidOne.stdout.trim() !== "postgres") {
    return { state: "retry", code: "FINAL_POSTMASTER_NOT_READY" };
  }

  const socketReady = execute([
    "exec",
    targetContainerId,
    "pg_isready",
    "-q",
    "-h",
    POSTGRES_SOCKET_DIRECTORY,
    "-p",
    POSTGRES_PORT,
    "-U",
    "postgres",
    "-d",
    "postgres",
    "-t",
    "2",
  ]);
  if (!commandSucceeded(socketReady)) {
    return { state: "retry", code: "POSTGRES_SOCKET_UNAVAILABLE" };
  }

  const sqlProbe = execute([
    "exec",
    "-i",
    targetContainerId,
    "psql",
    "-X",
    "-w",
    "-h",
    POSTGRES_SOCKET_DIRECTORY,
    "-p",
    POSTGRES_PORT,
    "-U",
    "postgres",
    "-d",
    "postgres",
    "-A",
    "-t",
    "-q",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    POSTGRES_VERSION_GATE_IDENTITY_SQL,
  ]);
  if (!commandSucceeded(sqlProbe)) {
    return { state: "retry", code: "POSTGRES_SQL_CONNECTION_UNAVAILABLE" };
  }
  const identity = parsePostgresIdentity(sqlProbe.stdout.trim());
  if (identity.postmasterPid !== 1) {
    return { state: "retry", code: "TEMPORARY_POSTMASTER_REJECTED" };
  }
  return { state: "ready", identity };
}

function advancePostgresProbeStability(previousIdentity, probe) {
  if (probe.state === "fatal") throw probe.error;
  if (probe.state !== "ready") {
    return {
      complete: false,
      stableIdentity: null,
      lastCode: probe.code,
    };
  }
  if (previousIdentity === null) {
    return {
      complete: false,
      stableIdentity: probe.identity,
      lastCode: "POSTGRES_STABILITY_CONFIRMATION_PENDING",
    };
  }
  if (previousIdentity.postmasterStartTime
      !== probe.identity.postmasterStartTime) {
    throw versionGateError(
      "POSTGRES_CONNECTION_POSTURE_INVALID",
      "POSTMASTER_RESTARTED_DURING_GATE",
    );
  }
  return {
    complete: true,
    stableIdentity: probe.identity,
    lastCode: "POSTGRES_FINAL_SERVER_STABLE",
  };
}

function syntheticCommandResult(status, stdout = "", stderr = "", error) {
  return { status, stdout, stderr, error };
}

function syntheticPostgresIdentity(overrides = {}) {
  return JSON.stringify({
    serverVersion: EXPECTED_POSTGRES_SERVER_VERSION,
    serverVersionNum: EXPECTED_POSTGRES_SERVER_VERSION_NUM,
    currentDatabase: "postgres",
    currentUser: "postgres",
    postmasterPid: 1,
    socketDirectories: POSTGRES_SOCKET_DIRECTORY,
    serverAddress: null,
    serverPort: null,
    inRecovery: false,
    postmasterStartTime: "1788076800.123456",
    ...overrides,
  });
}

function runPostgresConnectionVersionContractTests() {
  const targetContainerId = "a".repeat(64);
  const calls = [];
  const results = [
    syntheticCommandResult(0, "true\n"),
    syntheticCommandResult(0, "postgres\n"),
    syntheticCommandResult(0),
    syntheticCommandResult(0, syntheticPostgresIdentity()),
  ];
  const probe = probeFinalPostgresOnce((args) => {
    calls.push(args);
    return results.shift();
  }, targetContainerId);
  assert.equal(probe.state, "ready");
  assert.equal(results.length, 0);
  assert.deepEqual(calls[0], [
    "container", "inspect", "--format", "{{json .State.Running}}", targetContainerId,
  ]);
  assert.deepEqual(calls[1], [
    "exec", targetContainerId, "cat", "/proc/1/comm",
  ]);
  assert.deepEqual(calls[2].slice(0, 4), [
    "exec", targetContainerId, "pg_isready", "-q",
  ]);
  assert.ok(calls[2].includes(POSTGRES_SOCKET_DIRECTORY));
  assert.ok(calls[3].includes("psql"));
  assert.ok(calls[3].includes("-w"));
  assert.ok(calls[3].includes(POSTGRES_SOCKET_DIRECTORY));
  assert.ok(!calls.flat().includes(containerName));

  const temporary = probeFinalPostgresOnce((args) => {
    if (args[0] === "container") return syntheticCommandResult(0, "true");
    return syntheticCommandResult(0, "docker-entrypoint.sh");
  }, targetContainerId);
  assert.deepEqual(temporary, {
    state: "retry",
    code: "FINAL_POSTMASTER_NOT_READY",
  });

  const unavailableSentinel = "postgresql://user:fake-password@invalid D:\\private";
  const socketUnavailableResults = [
    syntheticCommandResult(0, "true"),
    syntheticCommandResult(0, "postgres"),
    syntheticCommandResult(2, "", unavailableSentinel),
  ];
  const socketUnavailable = probeFinalPostgresOnce(
    () => socketUnavailableResults.shift(),
    targetContainerId,
  );
  assert.equal(socketUnavailable.code, "POSTGRES_SOCKET_UNAVAILABLE");
  const safeFailure = postgresVersionGateFailureReceipt(versionGateError(
    "POSTGRES_CONNECTION_FAILURE",
    socketUnavailable.code,
    12,
  ));
  assert.equal(JSON.stringify(safeFailure).includes(unavailableSentinel), false);

  const sqlUnavailableResults = [
    syntheticCommandResult(0, "true"),
    syntheticCommandResult(0, "postgres"),
    syntheticCommandResult(0),
    syntheticCommandResult(2, "", unavailableSentinel),
  ];
  assert.equal(probeFinalPostgresOnce(
    () => sqlUnavailableResults.shift(),
    targetContainerId,
  ).code, "POSTGRES_SQL_CONNECTION_UNAVAILABLE");

  const exited = probeFinalPostgresOnce(
    () => syntheticCommandResult(0, "false"),
    targetContainerId,
  );
  assert.equal(exited.state, "fatal");
  assert.equal(exited.error.code, "CONTAINER_EXITED");

  const identityHostiles = [
    "",
    "[]",
    syntheticPostgresIdentity({ extra: true }),
    syntheticPostgresIdentity({ currentDatabase: "template1" }),
    syntheticPostgresIdentity({ currentUser: "other" }),
    syntheticPostgresIdentity({ socketDirectories: "/tmp" }),
    syntheticPostgresIdentity({ serverAddress: "127.0.0.1" }),
    syntheticPostgresIdentity({ serverPort: 5432 }),
    syntheticPostgresIdentity({ inRecovery: true }),
    syntheticPostgresIdentity({ postmasterStartTime: "not-a-timestamp" }),
  ];
  for (const hostile of identityHostiles) {
    assert.throws(() => parsePostgresIdentity(hostile), PostgresVersionGateError);
  }
  for (const version of [
    { serverVersion: "16.14", serverVersionNum: "160014" },
    { serverVersion: "15.14", serverVersionNum: "150014" },
    { serverVersion: "17.7", serverVersionNum: "170007" },
  ]) {
    assert.throws(
      () => parsePostgresIdentity(syntheticPostgresIdentity(version)),
      (error) => error instanceof PostgresVersionGateError
        && error.category === "POSTGRES_VERSION_MISMATCH",
    );
  }

  const temporaryIdentityResults = [
    syntheticCommandResult(0, "true"),
    syntheticCommandResult(0, "postgres"),
    syntheticCommandResult(0),
    syntheticCommandResult(0, syntheticPostgresIdentity({ postmasterPid: 42 })),
  ];
  assert.equal(probeFinalPostgresOnce(
    () => temporaryIdentityResults.shift(),
    targetContainerId,
  ).code, "TEMPORARY_POSTMASTER_REJECTED");

  const exactIdentity = parsePostgresIdentity(syntheticPostgresIdentity());
  let stability = advancePostgresProbeStability(null, {
    state: "ready",
    identity: exactIdentity,
  });
  assert.equal(stability.complete, false);
  stability = advancePostgresProbeStability(stability.stableIdentity, {
    state: "retry",
    code: "POSTGRES_SQL_CONNECTION_UNAVAILABLE",
  });
  assert.equal(stability.stableIdentity, null);
  stability = advancePostgresProbeStability(stability.stableIdentity, {
    state: "ready",
    identity: exactIdentity,
  });
  stability = advancePostgresProbeStability(stability.stableIdentity, {
    state: "ready",
    identity: exactIdentity,
  });
  assert.equal(stability.complete, true);
  assert.throws(() => advancePostgresProbeStability(exactIdentity, {
    state: "ready",
    identity: parsePostgresIdentity(syntheticPostgresIdentity({
      postmasterStartTime: "1788076801.123456",
    })),
  }), (error) => error instanceof PostgresVersionGateError
      && error.code === "POSTMASTER_RESTARTED_DURING_GATE");
}

function validatePinnedImageMetadata(metadata) {
  assertExactKeys(metadata, ["id", "repoDigests"], "image metadata shape drifted");
  assert.match(metadata.id, /^sha256:[a-f0-9]{64}$/);
  assert.ok(Array.isArray(metadata.repoDigests));
  assert.ok(metadata.repoDigests.length > 0);
  assert.equal(new Set(metadata.repoDigests).size, metadata.repoDigests.length);
  for (const repoDigest of metadata.repoDigests) {
    assert.equal(typeof repoDigest, "string");
    assert.match(repoDigest, /^[^\s@]+@sha256:[a-f0-9]{64}$/);
  }
  assert.ok(
    metadata.repoDigests.some((repoDigest) => (
      repoDigest.endsWith(POSTGRES_IMAGE_DIGEST_SUFFIX)
    )),
    "local image does not expose the pinned PostgreSQL content digest",
  );
  return metadata.id;
}

function validateContainerMetadata(metadata, expected) {
  assertExactKeys(metadata, [
    "autoRemove",
    "id",
    "imageId",
    "imageRef",
    "mounts",
    "name",
    "networkMode",
    "networkPorts",
    "portBindings",
    "publishAllPorts",
    "purposeLabel",
    "running",
    "tmpfs",
  ], "container metadata shape drifted");
  assert.equal(metadata.id, expected.containerId);
  assert.equal(metadata.name, `/${expected.containerName}`);
  assert.equal(metadata.imageId, expected.imageId);
  assert.equal(typeof metadata.imageRef, "string");
  assert.match(metadata.imageRef, /^[^\s@]+@sha256:[a-f0-9]{64}$/);
  assert.ok(
    metadata.imageRef.endsWith(POSTGRES_IMAGE_DIGEST_SUFFIX),
    "container image reference digest drifted",
  );
  assert.equal(metadata.purposeLabel, "p05-postgresql16-qualification");
  assert.equal(metadata.running, true);
  assert.equal(metadata.autoRemove, true);
  assert.equal(metadata.networkMode, "none");
  assertEmptyRecordOrNull(metadata.portBindings, "container port bindings");
  assert.equal(metadata.publishAllPorts, false);
  assert.ok(isPlainRecord(metadata.tmpfs), "container tmpfs metadata must be plain");
  assert.deepEqual(Object.keys(metadata.tmpfs).sort(), [
    "/var/lib/postgresql/data",
    "/var/run/postgresql",
  ]);
  assertTmpfsOptions(
    metadata.tmpfs["/var/lib/postgresql/data"],
    ["rw", "noexec", "nosuid"],
    ["768m", "805306368"],
    "PostgreSQL data tmpfs",
  );
  assertTmpfsOptions(
    metadata.tmpfs["/var/run/postgresql"],
    ["rw", "nosuid"],
    ["64m", "67108864"],
    "PostgreSQL socket tmpfs",
  );
  if (metadata.networkPorts !== null) {
    assert.ok(isPlainRecord(metadata.networkPorts), "network ports metadata must be plain");
    for (const [port, bindings] of Object.entries(metadata.networkPorts)) {
      assert.match(port, /^\d{1,5}\/(?:tcp|udp|sctp)$/);
      assert.ok(
        bindings === null || (Array.isArray(bindings) && bindings.length === 0),
        `network port ${port} must not have a host binding`,
      );
    }
  }
  assert.deepEqual(
    metadata.mounts
      .map((mount) => ({
        destination: mount.destination,
        type: mount.type,
        rw: mount.rw,
      }))
      .sort((left, right) => left.destination.localeCompare(right.destination)),
    [
      {
        destination: "/package/scripts/apply-independent-admin-gate16-ledger.psql",
        type: "bind",
        rw: false,
      },
      {
        destination: "/package/supabase/migrations",
        type: "bind",
        rw: false,
      },
    ],
  );
}

function runContainerMetadataContractTests() {
  const expected = {
    containerId: "a".repeat(64),
    containerName: "aistory-p05-pg16-metadata-fixture",
    imageId: `sha256:${"b".repeat(64)}`,
  };
  const valid = {
    id: expected.containerId,
    name: `/${expected.containerName}`,
    imageId: expected.imageId,
    imageRef: `approved-mirror.invalid/postgres${POSTGRES_IMAGE_DIGEST_SUFFIX}`,
    purposeLabel: "p05-postgresql16-qualification",
    running: true,
    autoRemove: true,
    networkMode: "none",
    portBindings: {},
    publishAllPorts: false,
    tmpfs: {
      "/var/lib/postgresql/data": "nosuid,size=805306368,rw,noexec",
      "/var/run/postgresql": "size=67108864,nosuid,rw",
    },
    networkPorts: { "5432/tcp": null },
    mounts: [
      {
        destination: "/package/supabase/migrations",
        type: "bind",
        rw: false,
      },
      {
        destination: "/package/scripts/apply-independent-admin-gate16-ledger.psql",
        type: "bind",
        rw: false,
      },
    ],
  };
  validateContainerMetadata(structuredClone(valid), expected);
  const hostileCases = [
    (value) => { value.id = "c".repeat(64); },
    (value) => { value.imageId = `sha256:${"d".repeat(64)}`; },
    (value) => { value.imageRef = `approved-mirror.invalid/postgres@sha256:${"e".repeat(64)}`; },
    (value) => { value.networkMode = "bridge"; },
    (value) => { value.portBindings = { "5432/tcp": [{ HostPort: "5432" }] }; },
    (value) => { value.publishAllPorts = true; },
    (value) => { value.tmpfs["/var/lib/postgresql/data"] = "rw,nosuid,size=805306368"; },
    (value) => { delete value.tmpfs["/var/run/postgresql"]; },
    (value) => { value.mounts[0].rw = true; },
    (value) => { value.mounts.push({ destination: "/extra", type: "bind", rw: false }); },
    (value) => { value.networkPorts["5432/tcp"] = [{ HostPort: "5432" }]; },
  ];
  for (const mutate of hostileCases) {
    const hostile = structuredClone(valid);
    mutate(hostile);
    assert.throws(() => validateContainerMetadata(hostile, expected));
  }
}

function runSync(args, input, label) {
  const result = spawnSync("docker", args, {
    cwd: root,
    encoding: "utf8",
    input,
    maxBuffer: MAX_OUTPUT_BYTES,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const detail = `${result.stdout}\n${result.stderr}`.trim().slice(0, 1_000);
    throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout.trim();
}

function runExpectedFailure(args, input, label, expectedError) {
  const result = spawnSync("docker", args, {
    cwd: root,
    encoding: "utf8",
    input,
    maxBuffer: MAX_OUTPUT_BYTES,
    windowsHide: true,
  });
  if (result.error || result.status === 0) {
    throw new Error(`${label} did not fail closed`);
  }
  const output = `${result.stdout}\n${result.stderr}`;
  if (expectedError) assert.match(output, expectedError, label);
  return output;
}

function runAsync(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const append = (current, chunk) => {
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next, "utf8") > MAX_OUTPUT_BYTES) {
        child.kill();
        reject(new Error("bounded PostgreSQL output exceeded"));
      }
      return next;
    };
    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    child.once("error", () => reject(new Error("docker execution failed")));
    child.once("close", (status) => resolve({
      status,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    }));
    child.stdin.end(input);
  });
}

function psqlArgs(extra = []) {
  return psqlArgsFor("postgres", extra);
}

function psqlArgsFor(database, extra = []) {
  assert.match(database, /^[a-z][a-z0-9_]{0,62}$/);
  assert.match(containerId, /^[a-f0-9]{64}$/);
  return [
    "exec",
    "-i",
    containerId,
    "psql",
    "-X",
    "-w",
    "-h",
    POSTGRES_SOCKET_DIRECTORY,
    "-p",
    POSTGRES_PORT,
    "-U",
    "postgres",
    "-d",
    database,
    "-A",
    "-t",
    "-q",
    "-v",
    "ON_ERROR_STOP=1",
    ...extra,
  ];
}

function psql(sql, label, extra = ["-1"]) {
  return runSync(psqlArgs(extra), sql, label);
}

function psqlMustFail(sql, label, extra = ["-1"]) {
  return psqlMustFailFor("postgres", sql, label, extra);
}

function psqlFor(database, sql, label, extra = ["-1"]) {
  return runSync(psqlArgsFor(database, extra), sql, label);
}

function psqlMustFailFor(
  database,
  sql,
  label,
  extra = ["-1"],
  expectedError,
) {
  return runExpectedFailure(
    psqlArgsFor(database, extra),
    sql,
    label,
    expectedError,
  );
}

function runAsyncFor(database, input, extra = ["-1"]) {
  return runAsync(psqlArgsFor(database, extra), input);
}

function serviceRoleSql(expression) {
  return `
set request.jwt.claim.role = 'service_role';
set role service_role;
select ${expression};
`;
}

function applyGate16WithLedger(database, label) {
  return runSync(psqlArgsFor(database, [
    "-f",
    `/package/scripts/${GATE16_LEDGER_APPLICATOR}`,
  ]), undefined, label);
}

function applyGate16WithLedgerMustFail(database, label, expectedError) {
  return runExpectedFailure(psqlArgsFor(database, [
    "-f",
    `/package/scripts/${GATE16_LEDGER_APPLICATOR}`,
  ]), undefined, label, expectedError);
}

function sqlLiteral(value) {
  assert.equal(typeof value, "string");
  return `'${value.replaceAll("'", "''")}'`;
}

function migrationLedgerIdentity(migration, bytes) {
  const match = /^(\d{14})_([a-z0-9_]+)\.sql$/.exec(migration);
  assert.ok(match, `invalid migration file name ${migration}`);
  return {
    version: match[1],
    name: migration,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function appendMigrationLedger(database, identity, label) {
  return psqlFor(database, `insert into supabase_migrations.schema_migrations (
      version, name, sha256
    ) values (
      ${sqlLiteral(identity.version)},
      ${sqlLiteral(identity.name)},
      ${sqlLiteral(identity.sha256)}
    );`, label);
}

function ledgerCatalogProjection(database) {
  return JSON.parse(psqlFor(database, `select jsonb_build_object(
      'relkind', relation_row.relkind,
      'owner', pg_catalog.pg_get_userbyid(relation_row.relowner),
      'columns', (
        select jsonb_agg(jsonb_build_object(
          'name', attribute_row.attname,
          'type', pg_catalog.format_type(
            attribute_row.atttypid,
            attribute_row.atttypmod
          ),
          'notnull', attribute_row.attnotnull,
          'default', case when default_row.oid is null then null
            else pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid)
          end,
          'identity', attribute_row.attidentity,
          'generated', attribute_row.attgenerated
        ) order by attribute_row.attnum)
        from pg_catalog.pg_attribute as attribute_row
        left join pg_catalog.pg_attrdef as default_row
          on default_row.adrelid = attribute_row.attrelid
         and default_row.adnum = attribute_row.attnum
        where attribute_row.attrelid = relation_row.oid
          and attribute_row.attnum > 0
          and not attribute_row.attisdropped
      ),
      'primary', (
        select jsonb_agg(attribute_row.attname order by key_row.ordinality)
        from pg_catalog.pg_constraint as constraint_row
        cross join lateral unnest(constraint_row.conkey)
          with ordinality as key_row(attnum, ordinality)
        join pg_catalog.pg_attribute as attribute_row
          on attribute_row.attrelid = constraint_row.conrelid
         and attribute_row.attnum = key_row.attnum
        where constraint_row.conrelid = relation_row.oid
          and constraint_row.contype = 'p'
      ),
      'constraints', (
        select count(*) from pg_catalog.pg_constraint as constraint_row
        where constraint_row.conrelid = relation_row.oid
      ),
      'triggers', (
        select count(*) from pg_catalog.pg_trigger as trigger_row
        where trigger_row.tgrelid = relation_row.oid
          and not trigger_row.tgisinternal
      ),
      'rules', (
        select count(*) from pg_catalog.pg_rewrite as rewrite_row
        where rewrite_row.ev_class = relation_row.oid
      )
    )::text
    from pg_catalog.pg_class as relation_row
    where relation_row.oid =
      pg_catalog.to_regclass('supabase_migrations.schema_migrations');`,
  "migration ledger catalog projection"));
}

function parseJsonResult(result, label) {
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`${label} returned malformed JSON`);
  }
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function jsonbLiteral(value) {
  return `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
}

const INCIDENT_RECEIPT_SHA256 =
  "f38be911c5c8128ed9344e7e094f2ed2604ee21bc451505e62ad10515f0c4ad3";
const GATE15_PACKAGE_SHA256 =
  "9e34b8387754c7533c47aeb22ac9d9399f14a95fc65718e567f07d565c91412b";
const GATE15_MIGRATION_SHA256 = EXPECTED_REPLACEMENT_SHA256;
const POST_QUALIFICATION_DUMP_SHA256 =
  "d85d63ed3cf54f8231207383dd5474cb5661aebaab433ee75c1f04eeeb8d1794";
const AUTHORIZATION_REF = `iar_${"a".repeat(40)}`;

function buildAttestation(capturedCommitment, overrides = {}) {
  const ownerMarkerCommitmentSha256 = sha256([
    "aistory.synthetic-gate16-owner-attestation.v1",
    INCIDENT_RECEIPT_SHA256,
    capturedCommitment,
    "isolated-postgresql16-fixture-only",
  ].join("\n"));
  const payload = {
    schemaVersion:
      "aistory.independent-admin.qualification-retirement-attestation.v1",
    authorizationRef: AUTHORIZATION_REF,
    outcome: "qualification_residue_retired",
    incidentReceiptSha256: INCIDENT_RECEIPT_SHA256,
    gate15PackageSha256: GATE15_PACKAGE_SHA256,
    gate15MigrationSha256: GATE15_MIGRATION_SHA256,
    postQualificationDumpSha256: POST_QUALIFICATION_DUMP_SHA256,
    expectedPreStateCommitmentSha256: capturedCommitment,
    ownerMarkerCommitmentSha256,
    ...overrides,
  };
  return {
    ...payload,
    attestationCommitmentSha256: sha256([
      payload.schemaVersion,
      payload.authorizationRef,
      payload.outcome,
      payload.incidentReceiptSha256,
      payload.gate15PackageSha256,
      payload.gate15MigrationSha256,
      payload.postQualificationDumpSha256,
      payload.expectedPreStateCommitmentSha256,
      payload.ownerMarkerCommitmentSha256,
    ].join("\n")),
  };
}

function legacyPrincipalProjection(database, singletonSlot = 1) {
  assert.ok(singletonSlot === 0 || singletonSlot === 1);
  return psqlFor(database, `select jsonb_build_object(
    'principal_ref', principal_ref,
    'tenant_id', tenant_id,
    'role', role,
    'credential_binding_sha256', credential_binding_sha256,
    'credential_epoch_sha256', credential_epoch_sha256,
    'password_verifier_reference_sha256',
      password_verifier_reference_sha256,
    'password_algorithm', password_algorithm,
    'password_parameters', password_parameters,
    'init_request_id', init_request_id,
    'last_rotation_request_id', last_rotation_request_id,
    'prior_credential_binding_sha256', prior_credential_binding_sha256,
    'credential_revision', credential_revision,
    'created_at_epoch_micros',
      (extract(epoch from created_at) * 1000000)::bigint
  )::text
  from public.independent_admin_principals
  where singleton_slot = ${singletonSlot};`, "legacy principal projection");
}

function immutableHistoryProjection(database) {
  return psqlFor(database, `select jsonb_build_object(
    'login_buckets', (
      select coalesce(jsonb_agg(to_jsonb(item) order by item.bucket_hash), '[]')
      from public.independent_admin_login_buckets as item
    ),
    'session_families', (
      select coalesce(jsonb_agg(to_jsonb(item) order by item.family_hash), '[]')
      from public.independent_admin_session_families as item
    ),
    'sessions', (
      select coalesce(jsonb_agg(to_jsonb(item) order by item.session_hash), '[]')
      from public.independent_admin_sessions as item
    )
  )::text;`, "immutable history projection");
}

async function waitUntilReady() {
  const startedAt = Date.now();
  let attempts = 0;
  let stableIdentity = null;
  let lastCode = "POSTGRES_CONNECTION_UNAVAILABLE";
  const execute = (args, input) => spawnSync("docker", args, {
    cwd: root,
    encoding: "utf8",
    input,
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: POSTGRES_VERSION_GATE_COMMAND_TIMEOUT_MS,
    killSignal: "SIGKILL",
    windowsHide: true,
  });
  while (Date.now() - startedAt < POSTGRES_VERSION_GATE_TIMEOUT_MS) {
    attempts += 1;
    let stability;
    try {
      stability = advancePostgresProbeStability(
        stableIdentity,
        probeFinalPostgresOnce(execute, containerId),
      );
    } catch (error) {
      if (error instanceof PostgresVersionGateError) {
        error.attempts = attempts;
      }
      throw error;
    }
    if (stability.complete) return stability.stableIdentity;
    stableIdentity = stability.stableIdentity;
    lastCode = stability.lastCode;
    await new Promise((resolve) => setTimeout(
      resolve,
      POSTGRES_VERSION_GATE_STABILITY_DELAY_MS,
    ));
  }
  throw versionGateError(
    "POSTGRES_CONNECTION_FAILURE",
    lastCode,
    attempts,
  );
}

const BINDING = `jsonb_build_object(
  'principal_ref','iap_11111111111111111111111111111111',
  'credential_binding_sha256',repeat('2',64),
  'credential_epoch_sha256',repeat('3',64),
  'password_verifier_reference_sha256',repeat('4',64),
  'password_algorithm','scrypt-v1',
  'password_parameters',jsonb_build_object(
    'N',131072,'r',8,'p',1,'keyLength',64,'maxmem',268435456
  )
)`;
const NEXT_BINDING = `jsonb_build_object(
  'principal_ref','iap_11111111111111111111111111111111',
  'credential_binding_sha256',repeat('c',64),
  'credential_epoch_sha256',repeat('d',64),
  'password_verifier_reference_sha256',repeat('e',64),
  'password_algorithm','scrypt-v1',
  'password_parameters',jsonb_build_object(
    'N',131072,'r',8,'p',1,'keyLength',64,'maxmem',268435456
  )
)`;
const REAL_BINDING = `jsonb_build_object(
  'principal_ref','iap_77777777777777777777777777777777',
  'credential_binding_sha256',repeat('8',64),
  'credential_epoch_sha256',repeat('9',64),
  'password_verifier_reference_sha256',repeat('a',64),
  'password_algorithm','scrypt-v1',
  'password_parameters',jsonb_build_object(
    'N',131072,'r',8,'p',1,'keyLength',64,'maxmem',268435456
  )
)`;

let containerStarted = false;
let containerId;
let blockedVersionGateError;
try {
  runContainerMetadataContractTests();
  runPostgresConnectionVersionContractTests();
  if (process.argv.slice(2).includes("--metadata-contract-only")) {
    assert.deepEqual(process.argv.slice(2), ["--metadata-contract-only"]);
    console.log(JSON.stringify({
      status: "PASS_GATE16_DOCKER_METADATA_CONTRACT_ONLY",
      strictPinnedDigest: POSTGRES_IMAGE_DIGEST_SUFFIX,
      externalNetworkCalls: 0,
    }));
    process.exit(0);
  }
  if (process.argv.slice(2).includes("--connection-version-contract-only")) {
    assert.deepEqual(process.argv.slice(2), ["--connection-version-contract-only"]);
    console.log(JSON.stringify({
      status: "PASS_GATE16_POSTGRES_CONNECTION_VERSION_CONTRACT_ONLY",
      expectedServerVersion: EXPECTED_POSTGRES_SERVER_VERSION,
      expectedServerVersionNum: EXPECTED_POSTGRES_SERVER_VERSION_NUM,
      connection: "container_unix_socket_only",
      externalNetworkCalls: 0,
    }));
    process.exit(0);
  }
  assert.deepEqual(process.argv.slice(2), []);
  const migrationNames = await readdir(migrationDirectory);
  assert.equal(migrationNames.filter((name) => name === SUPERSEDED_MIGRATION).length, 0);
  assert.equal(migrationNames.filter((name) => name === REPLACEMENT_MIGRATION).length, 1);
  assert.equal(migrationNames.filter((name) => name === RETIREMENT_MIGRATION).length, 1);
  for (const migration of [
    ...BASE_MIGRATIONS,
    REPLACEMENT_MIGRATION,
    RETIREMENT_MIGRATION,
  ]) {
    assert.ok(migrationNames.includes(migration));
  }

  const replacementPath = path.join(migrationDirectory, REPLACEMENT_MIGRATION);
  const retirementPath = path.join(migrationDirectory, RETIREMENT_MIGRATION);
  const [
    replacementBytes,
    replacementInfo,
    retirementBytes,
    retirementInfo,
    applicatorBytes,
    applicatorInfo,
  ] = await Promise.all([
    readFile(replacementPath),
    stat(replacementPath),
    readFile(retirementPath),
    stat(retirementPath),
    readFile(gate16LedgerApplicatorPath),
    stat(gate16LedgerApplicatorPath),
  ]);
  assert.equal(replacementInfo.size, EXPECTED_REPLACEMENT_BYTES);
  assert.equal(
    createHash("sha256").update(replacementBytes).digest("hex"),
    EXPECTED_REPLACEMENT_SHA256,
  );
  assert.equal(retirementInfo.size, EXPECTED_RETIREMENT_BYTES);
  assert.equal(
    createHash("sha256").update(retirementBytes).digest("hex"),
    EXPECTED_RETIREMENT_SHA256,
  );
  assert.equal(
    applicatorInfo.size,
    EXPECTED_GATE16_LEDGER_APPLICATOR_BYTES,
  );
  assert.equal(
    createHash("sha256").update(applicatorBytes).digest("hex"),
    EXPECTED_GATE16_LEDGER_APPLICATOR_SHA256,
  );

  const migrationLedgerIdentities = new Map();
  for (const migration of [...BASE_MIGRATIONS, REPLACEMENT_MIGRATION]) {
    const bytes = await readFile(path.join(migrationDirectory, migration));
    migrationLedgerIdentities.set(
      migration,
      migrationLedgerIdentity(migration, bytes),
    );
  }

  const pinnedImageMetadata = parsePlainJsonRecord(runSync(
    ["image", "inspect", POSTGRES_IMAGE, "--format", POSTGRES_IMAGE_METADATA_FORMAT],
    undefined,
    "local PostgreSQL 16 image inspection",
  ), "local PostgreSQL 16 image inspection");
  const expectedImageId = validatePinnedImageMetadata(pinnedImageMetadata);

  containerId = runSync([
    "run",
    "--pull=never",
    "--rm",
    "-d",
    "--name",
    containerName,
    "--label",
    "aistory.purpose=p05-postgresql16-qualification",
    "--network",
    "none",
    "--shm-size",
    "256m",
    "--tmpfs",
    "/var/lib/postgresql/data:rw,noexec,nosuid,size=768m",
    "--tmpfs",
    "/var/run/postgresql:rw,nosuid,size=64m",
    "-e",
    "POSTGRES_HOST_AUTH_METHOD=trust",
    "--mount",
    `type=bind,source=${migrationDirectory},target=/package/supabase/migrations,readonly`,
    "--mount",
    `type=bind,source=${gate16LedgerApplicatorPath},target=/package/scripts/${GATE16_LEDGER_APPLICATOR},readonly`,
    POSTGRES_IMAGE,
    "-c",
    "listen_addresses=",
    "-c",
    "unix_socket_directories=/var/run/postgresql",
    "-c",
    "check_function_bodies=on",
  ], undefined, "isolated PostgreSQL 16 start");
  assert.match(containerId, /^[a-f0-9]{64}$/);
  containerStarted = true;
  const finalPostgresIdentity = await waitUntilReady();

  const metadata = parsePlainJsonRecord(runSync(
    ["container", "inspect", "--format", CONTAINER_METADATA_FORMAT, containerId],
    undefined,
    "isolated container inspection",
  ), "isolated container inspection");
  validateContainerMetadata(metadata, {
    containerId,
    containerName,
    imageId: expectedImageId,
  });

  assert.equal(finalPostgresIdentity.serverVersion, EXPECTED_POSTGRES_SERVER_VERSION);
  assert.equal(
    finalPostgresIdentity.serverVersionNum,
    EXPECTED_POSTGRES_SERVER_VERSION_NUM,
  );

  psql(`
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin bypassrls;
create schema auth;
create schema supabase_migrations authorization postgres;
create table supabase_migrations.schema_migrations (
  version text primary key,
  name text not null,
  sha256 text not null,
  applied_at timestamp with time zone not null default now()
);
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid
language sql stable
as $$ select nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create function auth.role() returns text
language sql stable
as $$ select nullif(pg_catalog.current_setting('request.jwt.claim.role', true), '') $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant execute on function auth.role() to anon, authenticated, service_role;
`, "Supabase-compatible local bootstrap");

  for (const migration of BASE_MIGRATIONS) {
    runSync(psqlArgs([
      "-1",
      "-f",
      `/package/supabase/migrations/${migration}`,
    ]), undefined,
      `baseline migration ${migration}`);
    appendMigrationLedger(
      "postgres",
      migrationLedgerIdentities.get(migration),
      `baseline ledger ${migration}`,
    );
  }
  assert.equal(
    psql(`select gate_name || '=' || version
      from public.aistory_schema_gates
      where gate_name in ('production_identity_billing','independent_admin_principal')
      order by gate_name;`, "pre-apply gate identity"),
    "production_identity_billing=20260811193000",
  );

  runSync(psqlArgs([
    "-1",
    "-c",
    "set local check_function_bodies=on; set local plpgsql.extra_warnings='all'; set local plpgsql.extra_errors='shadowed_variables';",
    "-f",
    `/package/supabase/migrations/${REPLACEMENT_MIGRATION}`,
  ]), undefined, "replacement migration PostgreSQL 16 apply");
  appendMigrationLedger(
    "postgres",
    migrationLedgerIdentities.get(REPLACEMENT_MIGRATION),
    "replacement migration ledger",
  );

  for (const database of [
    EMPTY_DATABASE,
    ACTIVE_DATABASE,
    REAL_DATABASE,
    LEGACY_LEDGER_DATABASE,
    APPEND_FAILURE_DATABASE,
    APPLY_CONCURRENT_DATABASE,
    LEDGER_SHAPE_DATABASE,
    LEDGER_TRIGGER_DATABASE,
    LEDGER_PREDECESSOR_STEM_DATABASE,
    LEDGER_PREDECESSOR_ALIAS_DATABASE,
    LEDGER_PREDECESSOR_VERSION_DATABASE,
    LEDGER_PREDECESSOR_SHA_DATABASE,
    LEDGER_PREDECESSOR_APPLIED_AT_DATABASE,
  ]) {
    psqlFor(
      "template1",
      `create database ${database} template postgres;`,
      `Gate15 baseline clone ${database}`,
      [],
    );
  }

  assert.equal(
    psql(`select gate_name || '=' || version
      from public.aistory_schema_gates
      where gate_name in ('production_identity_billing','independent_admin_principal')
      order by gate_name;`, "post-apply gate identity"),
    "independent_admin_principal=20260828233000\nproduction_identity_billing=20260811193000",
  );
  assert.deepEqual(ledgerCatalogProjection("postgres"), {
    relkind: "r",
    owner: "postgres",
    columns: [
      {
        name: "version",
        type: "text",
        notnull: true,
        default: null,
        identity: "",
        generated: "",
      },
      {
        name: "name",
        type: "text",
        notnull: true,
        default: null,
        identity: "",
        generated: "",
      },
      {
        name: "sha256",
        type: "text",
        notnull: true,
        default: null,
        identity: "",
        generated: "",
      },
      {
        name: "applied_at",
        type: "timestamp with time zone",
        notnull: true,
        default: "now()",
        identity: "",
        generated: "",
      },
    ],
    primary: ["version"],
    constraints: 1,
    triggers: 0,
    rules: 0,
  });
  assert.equal(
    psql(`select concat_ws(':', count(*),
        count(*) filter (where version = '20260828233000'),
        count(*) filter (where version = '20260829063000'))
      from supabase_migrations.schema_migrations;`,
    "Gate15 migration ledger baseline"),
    `${BASE_MIGRATIONS.length + 1}:1:0`,
  );
  assert.equal(
    psql(`select concat_ws(':', name, sha256, applied_at is not null)
      from supabase_migrations.schema_migrations
      where version = '20260828233000';`,
    "authoritative Gate15 migration ledger identity"),
    `${GATE15_LEDGER_NAME}:${EXPECTED_REPLACEMENT_SHA256}:t`,
  );
  assert.equal(
    psql(`select count(*) from pg_catalog.pg_proc as procedure_row
      join pg_catalog.pg_namespace as namespace_row
        on namespace_row.oid = procedure_row.pronamespace
      cross join lateral unnest(coalesce(procedure_row.proargnames, '{}'::text[]))
        as argument_row(argument_name)
      join pg_catalog.pg_get_keywords() as keyword_row
        on keyword_row.word = argument_row.argument_name
      where namespace_row.nspname = 'public'
        and procedure_row.proname like 'aistory_independent_admin_%'
        and keyword_row.catcode in ('R','T');`, "reserved argument audit"),
    "0",
  );
  assert.equal(
    psql(`select procedure_row.proargnames::text
      from pg_catalog.pg_proc as procedure_row
      join pg_catalog.pg_namespace as namespace_row
        on namespace_row.oid = procedure_row.pronamespace
      where namespace_row.nspname = 'public'
        and procedure_row.proname = 'aistory_independent_admin_read_snapshot';`,
    "read snapshot argument audit"),
    "{request_payload}",
  );
  assert.equal(
    psql(`select count(*) from pg_catalog.pg_class as relation_row
      join pg_catalog.pg_namespace as namespace_row
        on namespace_row.oid = relation_row.relnamespace
      where namespace_row.nspname = 'public'
        and relation_row.relname = any(array[
          'independent_admin_principals','independent_admin_login_buckets',
          'independent_admin_session_families','independent_admin_sessions',
          'independent_admin_auth_audit'
        ])
        and relation_row.relrowsecurity
        and relation_row.relforcerowsecurity;`, "forced RLS audit"),
    "5",
  );
  assert.equal(
    psql(`select count(*) from pg_catalog.pg_trigger as trigger_row
      join pg_catalog.pg_class as relation_row on relation_row.oid = trigger_row.tgrelid
      join pg_catalog.pg_namespace as namespace_row on namespace_row.oid = relation_row.relnamespace
      join pg_catalog.pg_proc as procedure_row on procedure_row.oid = trigger_row.tgfoid
      where namespace_row.nspname = 'public'
        and relation_row.relname = 'independent_admin_auth_audit'
        and trigger_row.tgenabled = 'O'
        and procedure_row.proname = 'aistory_independent_admin_reject_audit_mutation'
        and trigger_row.tgtype in (27,34);`, "append-only trigger audit"),
    "2",
  );
  assert.equal(
    psql(serviceRoleSql("public.aistory_independent_admin_security_posture()"),
      "security posture"),
    "t",
  );

  const registration = `public.aistory_independent_admin_initialize(
    ${BINDING} || jsonb_build_object(
      'request_id','ipr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    )
  )`;
  const initResults = await Promise.all([
    runAsync(psqlArgs(["-1"]), serviceRoleSql(registration)),
    runAsync(psqlArgs(["-1"]), serviceRoleSql(registration)),
  ]);
  assert.deepEqual(initResults.map((result) => result.status), [0, 0]);
  assert.deepEqual(
    initResults.map((result) => parseJsonResult(result, "initializer").replayed).sort(),
    [false, true],
  );
  psqlMustFail(serviceRoleSql(`public.aistory_independent_admin_initialize(
    ${BINDING} || jsonb_build_object(
      'request_id','ipr_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    )
  )`), "conflicting initializer replay");
  psqlMustFail(serviceRoleSql(`public.aistory_independent_admin_initialize(
    (${BINDING} - 'principal_ref') || jsonb_build_object(
      'principal_ref','iap_99999999999999999999999999999999',
      'request_id','ipr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    )
  )`), "cross-principal initializer");

  const rateAttempt = `public.aistory_independent_admin_reserve_login(
    ${BINDING} || jsonb_build_object(
      'global_bucket_hash',repeat('5',64),
      'subject_bucket_hash',repeat('6',64),
      'occurred_at',clock_timestamp()::text
    )
  )`;
  const rateResults = await Promise.all(Array.from(
    { length: 8 },
    () => runAsync(psqlArgs(["-1"]), serviceRoleSql(rateAttempt)),
  ));
  assert.ok(rateResults.every((result) => result.status === 0));
  const rateAllowed = rateResults.map((result) => (
    parseJsonResult(result, "login rate reservation").allowed
  ));
  assert.equal(rateAllowed.filter(Boolean).length, 5);
  assert.equal(rateAllowed.filter((allowed) => !allowed).length, 3);

  const loginBuckets = ["f".repeat(64), "0".repeat(64)];
  assert.equal(JSON.parse(psql(serviceRoleSql(
    `public.aistory_independent_admin_reserve_login(
      ${BINDING} || jsonb_build_object(
        'global_bucket_hash','${loginBuckets[0]}',
        'subject_bucket_hash','${loginBuckets[1]}',
        'occurred_at',clock_timestamp()::text
      )
    )::text`,
  ), "login reservation")).allowed, true);
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  const commitLogin = `public.aistory_independent_admin_commit_login(
    ${BINDING} || jsonb_build_object(
      'family_hash',repeat('7',64),
      'session_hash',repeat('8',64),
      'bucket_hashes',jsonb_build_array('${loginBuckets[0]}','${loginBuckets[1]}'),
      'occurred_at',clock_timestamp()::text,
      'expires_at','${expiresAt}'
    )
  )`;
  const loginResults = await Promise.all([
    runAsync(psqlArgs(["-1"]), serviceRoleSql(commitLogin)),
    runAsync(psqlArgs(["-1"]), serviceRoleSql(commitLogin)),
  ]);
  assert.deepEqual(loginResults.map((result) => result.status === 0).sort(), [false, true]);
  assert.equal(
    psql(`select count(*) from public.independent_admin_session_families
      where revoked_at is null;`, "active session-family count"),
    "1",
  );
  assert.equal(
    psql(serviceRoleSql(`public.aistory_independent_admin_verify_session(
      ${BINDING} || jsonb_build_object(
        'session_hash',repeat('8',64),'occurred_at',clock_timestamp()::text
      )
    )::text`), "session verification"),
    "{\"role\": \"super_admin\", \"active\": true}",
  );
  const snapshot = JSON.parse(psql(serviceRoleSql(
    `public.aistory_independent_admin_read_snapshot(
      ${BINDING} || jsonb_build_object(
        'session_hash',repeat('8',64),'tenant_id','platform'
      )
    )::text`,
  ), "authorized snapshot"));
  assert.deepEqual(Object.keys(snapshot).sort(), [
    "accounts", "audit", "billing_policies", "channel_apps", "domains",
    "events", "ledger", "payment_configs", "provider_configs", "roles",
    "settings", "users",
  ]);

  const rotateSession = `public.aistory_independent_admin_rotate_session(
    ${BINDING} || jsonb_build_object(
      'current_session_hash',repeat('8',64),
      'next_session_hash',repeat('9',64),
      'occurred_at',clock_timestamp()::text,
      'next_expires_at','${expiresAt}'
    )
  )`;
  const rotateResults = await Promise.all([
    runAsync(psqlArgs(["-1"]), serviceRoleSql(rotateSession)),
    runAsync(psqlArgs(["-1"]), serviceRoleSql(rotateSession)),
  ]);
  assert.ok(rotateResults.every((result) => result.status === 0));
  assert.deepEqual(rotateResults.map((result) => result.stdout), ["t", "t"]);
  assert.equal(
    psql(serviceRoleSql(`public.aistory_independent_admin_verify_session(
      ${BINDING} || jsonb_build_object(
        'session_hash',repeat('9',64),'occurred_at',clock_timestamp()::text
      )
    ) is not null`), "rotated session verification"),
    "t",
  );
  assert.equal(
    psql(serviceRoleSql(`public.aistory_independent_admin_verify_session(
      ${BINDING} || jsonb_build_object(
        'session_hash',repeat('8',64),'occurred_at',clock_timestamp()::text
      )
    ) is null`), "old-session replay rejection"),
    "t",
  );
  assert.equal(
    psql(serviceRoleSql(`public.aistory_independent_admin_verify_session(
      ${BINDING} || jsonb_build_object(
        'session_hash',repeat('9',64),'occurred_at',clock_timestamp()::text
      )
    ) is null`), "replay family revocation"),
    "t",
  );

  const expiresAt2 = new Date(Date.now() + 15 * 60_000).toISOString();
  const secondLoginBuckets = ["1".repeat(64), "2".repeat(64)];
  assert.equal(JSON.parse(psql(serviceRoleSql(
    `public.aistory_independent_admin_reserve_login(
      ${BINDING} || jsonb_build_object(
        'global_bucket_hash','${secondLoginBuckets[0]}',
        'subject_bucket_hash','${secondLoginBuckets[1]}',
        'occurred_at',clock_timestamp()::text
      )
    )::text`,
  ), "second login reservation")).allowed, true);
  assert.equal(
    psql(serviceRoleSql(`public.aistory_independent_admin_commit_login(
      ${BINDING} || jsonb_build_object(
        'family_hash',repeat('a',64),
        'session_hash',repeat('b',64),
        'bucket_hashes',jsonb_build_array(
          '${secondLoginBuckets[0]}','${secondLoginBuckets[1]}'
        ),
        'occurred_at',clock_timestamp()::text,
        'expires_at','${expiresAt2}'
      )
    )`), "second login"),
    "t",
  );
  const revokeSession = `public.aistory_independent_admin_revoke_session(
    ${BINDING} || jsonb_build_object(
      'session_hash',repeat('b',64),'occurred_at',clock_timestamp()::text
    )
  )`;
  const revokeResults = await Promise.all([
    runAsync(psqlArgs(["-1"]), serviceRoleSql(revokeSession)),
    runAsync(psqlArgs(["-1"]), serviceRoleSql(revokeSession)),
  ]);
  assert.ok(revokeResults.every((result) => result.status === 0));
  assert.deepEqual(revokeResults.map((result) => result.stdout).sort(), ["f", "t"]);
  assert.equal(
    psql(serviceRoleSql(`public.aistory_independent_admin_verify_session(
      ${BINDING} || jsonb_build_object(
        'session_hash',repeat('b',64),'occurred_at',clock_timestamp()::text
      )
    ) is null`), "revoked session verification"),
    "t",
  );

  assert.equal(
    psql(serviceRoleSql(`public.aistory_independent_admin_append_security_event(
      ${BINDING} || jsonb_build_object(
        'event','invalid_credentials','occurred_at',clock_timestamp()::text
      )
    )`), "security-event audit"),
    "t",
  );
  const rotateCredential = `public.aistory_independent_admin_rotate_credential(
    jsonb_build_object(
      'current_credential_binding_sha256',repeat('2',64),
      'next',${NEXT_BINDING},
      'request_id','ipr_cccccccccccccccccccccccccccccccc'
    )
  )`;
  const credentialResults = await Promise.all([
    runAsync(psqlArgs(["-1"]), serviceRoleSql(rotateCredential)),
    runAsync(psqlArgs(["-1"]), serviceRoleSql(rotateCredential)),
  ]);
  assert.ok(credentialResults.every((result) => result.status === 0));
  assert.deepEqual(
    credentialResults.map((result) => (
      parseJsonResult(result, "credential rotation").replayed
    )).sort(),
    [false, true],
  );

  psqlMustFail(`set request.jwt.claim.role = 'authenticated';
    set role service_role;
    select public.aistory_independent_admin_verify_session(
      ${NEXT_BINDING} || jsonb_build_object(
        'session_hash',repeat('b',64),'occurred_at',clock_timestamp()::text
      )
    );`, "wrong service-role claim");
  psqlMustFail(`set role anon;
    select public.aistory_independent_admin_gate_status();`,
  "anonymous RPC access");
  psqlMustFail(`set role authenticated;
    select count(*) from public.independent_admin_principals;`,
  "authenticated direct table read");
  psqlMustFail(`set request.jwt.claim.role = 'service_role';
    set role service_role;
    select count(*) from public.independent_admin_principals;`,
  "service-role direct table read");
  psqlMustFail(`set request.jwt.claim.role = 'service_role';
    set role service_role;
    select public.aistory_independent_admin_exact_object('{}'::jsonb,'{}'::text[]);`,
  "service-role helper access");
  psqlMustFailFor("postgres", `update public.independent_admin_auth_audit
    set event = event where sequence = (
      select min(sequence) from public.independent_admin_auth_audit
    );`, "audit update", ["-1"], /audit is append-only/);
  psqlMustFailFor("postgres", `delete from public.independent_admin_auth_audit
    where sequence = (
      select min(sequence) from public.independent_admin_auth_audit
    );`, "audit delete", ["-1"], /audit is append-only/);
  psqlMustFailFor(
    "postgres",
    "truncate public.independent_admin_auth_audit;",
    "audit truncate",
    ["-1"],
    /audit is append-only/,
  );

  const auditEvents = psql(`select distinct event
    from public.independent_admin_auth_audit order by event;`, "audit event inventory")
    .split("\n");
  for (const requiredEvent of [
    "credential_rotated",
    "initialized",
    "invalid_credentials",
    "login_succeeded",
    "logout",
    "rate_limited",
    "session_replay_rejected",
    "session_rotated",
  ]) assert.ok(auditEvents.includes(requiredEvent));

  runExpectedFailure(psqlArgs([
    "-1",
    "-f",
    `/package/supabase/migrations/${REPLACEMENT_MIGRATION}`,
  ]), undefined, "replacement migration replay");
  assert.equal(
    psql(`select count(*) from public.aistory_schema_gates
      where gate_name = 'independent_admin_principal'
        and version = '20260828233000';`, "post-replay gate identity"),
    "1",
  );

  runExpectedFailure(
    psqlArgsFor(LEGACY_LEDGER_DATABASE, []),
    `begin;
\\ir /package/supabase/migrations/${RETIREMENT_MIGRATION}
insert into supabase_migrations.schema_migrations
  (version, statements, name)
values (
  '20260829063000',
  array['sha256:${EXPECTED_RETIREMENT_SHA256}'],
  'independent_admin_qualification_residue_retirement_gate'
);
commit;`,
    "legacy statements-column ledger append reproduction",
    /column "statements" of relation "schema_migrations" does not exist/,
  );
  assert.equal(
    psqlFor(LEGACY_LEDGER_DATABASE, `select concat_ws(':',
      (select count(*) from supabase_migrations.schema_migrations
        where version = '20260828233000'),
      (select count(*) from supabase_migrations.schema_migrations
        where version = '20260829063000'),
      public.aistory_independent_admin_gate_status(),
      to_regclass('public.independent_admin_qualification_resolutions') is null
    );`, "legacy append atomic rollback"),
    "1:0:20260828233000:t",
  );

  psqlFor(
    APPEND_FAILURE_DATABASE,
    "drop table supabase_migrations.schema_migrations;",
    "missing ledger fixture",
  );
  applyGate16WithLedgerMustFail(
    APPEND_FAILURE_DATABASE,
    "missing ledger fail closed",
    /Gate16 exact migration ledger unavailable/,
  );
  assert.equal(
    psqlFor(APPEND_FAILURE_DATABASE, `select concat_ws(':',
      public.aistory_independent_admin_gate_status(),
      to_regclass('public.independent_admin_qualification_resolutions') is null
    );`, "missing ledger domain rollback"),
    "20260828233000:t",
  );

  psqlFor(
    LEDGER_SHAPE_DATABASE,
    "alter table supabase_migrations.schema_migrations add column statements text[];",
    "hostile extra ledger column fixture",
  );
  applyGate16WithLedgerMustFail(
    LEDGER_SHAPE_DATABASE,
    "hostile extra ledger column fail closed",
    /Gate16 exact migration ledger columns unavailable/,
  );
  assert.equal(
    psqlFor(LEDGER_SHAPE_DATABASE, `select concat_ws(':',
      count(*) filter (where version = '20260828233000'),
      count(*) filter (where version = '20260829063000'),
      public.aistory_independent_admin_gate_status(),
      to_regclass('public.independent_admin_qualification_resolutions') is null
    ) from supabase_migrations.schema_migrations;`,
    "hostile extra ledger column rollback"),
    "1:0:20260828233000:t",
  );

  psqlFor(LEDGER_TRIGGER_DATABASE, `create function public.reject_gate16_ledger()
      returns trigger language plpgsql as $$
    begin
      raise exception 'synthetic ledger trigger must never run';
    end;
    $$;
    create trigger reject_gate16_ledger
      before insert on supabase_migrations.schema_migrations
      for each row execute function public.reject_gate16_ledger();`,
  "hostile ledger trigger fixture");
  applyGate16WithLedgerMustFail(
    LEDGER_TRIGGER_DATABASE,
    "hostile ledger trigger fail closed",
    /Gate16 exact migration ledger constraints unavailable/,
  );
  assert.equal(
    psqlFor(LEDGER_TRIGGER_DATABASE, `select concat_ws(':',
      count(*) filter (where version = '20260828233000'),
      count(*) filter (where version = '20260829063000'),
      public.aistory_independent_admin_gate_status(),
      to_regclass('public.independent_admin_qualification_resolutions') is null
    ) from supabase_migrations.schema_migrations;`,
    "hostile ledger trigger rollback"),
    "1:0:20260828233000:t",
  );

  psqlFor(
    LEDGER_PREDECESSOR_STEM_DATABASE,
    `update supabase_migrations.schema_migrations
      set name = ${sqlLiteral(SUPERSEDED_INFERRED_GATE15_LEDGER_NAME)}
      where version = '20260828233000';`,
    "superseded inferred Gate15 ledger stem fixture",
  );
  applyGate16WithLedgerMustFail(
    LEDGER_PREDECESSOR_STEM_DATABASE,
    "superseded inferred Gate15 ledger stem fail closed",
    /Gate16 migration ledger predecessor unavailable/,
  );
  assert.equal(
    psqlFor(LEDGER_PREDECESSOR_STEM_DATABASE, `select concat_ws(':',
      (select name from supabase_migrations.schema_migrations
        where version = '20260828233000'),
      count(*) filter (where version = '20260829063000'),
      public.aistory_independent_admin_gate_status(),
      to_regclass('public.independent_admin_qualification_resolutions') is null
    ) from supabase_migrations.schema_migrations;`,
    "superseded inferred Gate15 ledger stem rollback"),
    `${SUPERSEDED_INFERRED_GATE15_LEDGER_NAME}:0:20260828233000:t`,
  );

  psqlFor(
    LEDGER_PREDECESSOR_ALIAS_DATABASE,
    `update supabase_migrations.schema_migrations
      set name = 'hostile_gate15_name_alias.sql'
      where version = '20260828233000';`,
    "hostile Gate15 ledger alias fixture",
  );
  applyGate16WithLedgerMustFail(
    LEDGER_PREDECESSOR_ALIAS_DATABASE,
    "hostile Gate15 ledger alias fail closed",
    /Gate16 migration ledger predecessor unavailable/,
  );
  assert.equal(
    psqlFor(LEDGER_PREDECESSOR_ALIAS_DATABASE, `select concat_ws(':',
      (select name from supabase_migrations.schema_migrations
        where version = '20260828233000'),
      count(*) filter (where version = '20260829063000'),
      public.aistory_independent_admin_gate_status(),
      to_regclass('public.independent_admin_qualification_resolutions') is null
    ) from supabase_migrations.schema_migrations;`,
    "hostile Gate15 ledger alias rollback"),
    "hostile_gate15_name_alias.sql:0:20260828233000:t",
  );

  psqlFor(
    LEDGER_PREDECESSOR_VERSION_DATABASE,
    `update supabase_migrations.schema_migrations
      set version = '20260828233001'
      where version = '20260828233000';`,
    "hostile Gate15 ledger version fixture",
  );
  applyGate16WithLedgerMustFail(
    LEDGER_PREDECESSOR_VERSION_DATABASE,
    "hostile Gate15 ledger version fail closed",
    /Gate16 migration ledger predecessor unavailable/,
  );
  assert.equal(
    psqlFor(LEDGER_PREDECESSOR_VERSION_DATABASE, `select concat_ws(':',
      (select version from supabase_migrations.schema_migrations
        where name collate "C" = ${sqlLiteral(GATE15_LEDGER_NAME)} collate "C"),
      count(*) filter (where version = '20260829063000'),
      public.aistory_independent_admin_gate_status(),
      to_regclass('public.independent_admin_qualification_resolutions') is null
    ) from supabase_migrations.schema_migrations;`,
    "hostile Gate15 ledger version rollback"),
    "20260828233001:0:20260828233000:t",
  );

  psqlFor(
    LEDGER_PREDECESSOR_SHA_DATABASE,
    `update supabase_migrations.schema_migrations
      set sha256 = repeat('0', 64)
      where version = '20260828233000';`,
    "hostile Gate15 ledger SHA fixture",
  );
  applyGate16WithLedgerMustFail(
    LEDGER_PREDECESSOR_SHA_DATABASE,
    "hostile Gate15 ledger SHA fail closed",
    /Gate16 migration ledger predecessor unavailable/,
  );
  assert.equal(
    psqlFor(LEDGER_PREDECESSOR_SHA_DATABASE, `select concat_ws(':',
      (select sha256 from supabase_migrations.schema_migrations
        where version = '20260828233000'),
      count(*) filter (where version = '20260829063000'),
      public.aistory_independent_admin_gate_status(),
      to_regclass('public.independent_admin_qualification_resolutions') is null
    ) from supabase_migrations.schema_migrations;`,
    "hostile Gate15 ledger SHA rollback"),
    `${"0".repeat(64)}:0:20260828233000:t`,
  );

  psqlFor(
    LEDGER_PREDECESSOR_APPLIED_AT_DATABASE,
    `alter table supabase_migrations.schema_migrations
       alter column applied_at drop not null;
     update supabase_migrations.schema_migrations
       set applied_at = null
       where version = '20260828233000';`,
    "hostile Gate15 ledger applied_at fixture",
  );
  applyGate16WithLedgerMustFail(
    LEDGER_PREDECESSOR_APPLIED_AT_DATABASE,
    "hostile Gate15 ledger applied_at fail closed",
    /Gate16 exact migration ledger columns unavailable/,
  );
  assert.equal(
    psqlFor(LEDGER_PREDECESSOR_APPLIED_AT_DATABASE, `select concat_ws(':',
      (select applied_at is null from supabase_migrations.schema_migrations
        where version = '20260828233000'),
      count(*) filter (where version = '20260829063000'),
      public.aistory_independent_admin_gate_status(),
      to_regclass('public.independent_admin_qualification_resolutions') is null
    ) from supabase_migrations.schema_migrations;`,
    "hostile Gate15 ledger applied_at rollback"),
    "t:0:20260828233000:t",
  );

  const concurrentApplies = await Promise.all([
    runAsyncFor(
      APPLY_CONCURRENT_DATABASE,
      `\\i /package/scripts/${GATE16_LEDGER_APPLICATOR}\n`,
      [],
    ),
    runAsyncFor(
      APPLY_CONCURRENT_DATABASE,
      `\\i /package/scripts/${GATE16_LEDGER_APPLICATOR}\n`,
      [],
    ),
  ]);
  assert.equal(
    concurrentApplies.filter((result) => result.status === 0).length,
    1,
  );
  assert.equal(
    concurrentApplies.filter((result) => result.status !== 0).length,
    1,
  );
  assert.match(
    concurrentApplies.find((result) => result.status === 0).stdout,
    /PASS_GATE16_ATOMIC_LEDGER_APPLY/,
  );
  assert.match(
    concurrentApplies.find((result) => result.status !== 0).stderr,
    /Gate16 migration ledger predecessor unavailable/,
  );
  assert.equal(
    psqlFor(APPLY_CONCURRENT_DATABASE, `select concat_ws(':',
      count(*) filter (where version = '20260828233000'),
      count(*) filter (where version = '20260829063000'),
      public.aistory_independent_admin_gate_status(),
      (select state from public.independent_admin_qualification_resolutions)
    ) from supabase_migrations.schema_migrations;`,
    "concurrent Gate16 apply serialization"),
    "1:1:20260829063000:not_required",
  );

  const legacyPrincipalBefore = legacyPrincipalProjection("postgres");
  const immutableHistoryBefore = immutableHistoryProjection("postgres");
  const auditMaxBefore = psql(`select max(sequence)
    from public.independent_admin_auth_audit;`, "pre-retirement audit maximum");
  const auditBefore = psql(`select coalesce(
      jsonb_agg(to_jsonb(audit_row) order by audit_row.sequence), '[]'
    )::text
    from public.independent_admin_auth_audit as audit_row
    where audit_row.sequence <= ${auditMaxBefore};`, "pre-retirement audit projection");
  const countsBefore = psql(`select concat_ws(':',
      (select count(*) from public.independent_admin_principals),
      (select count(*) from public.independent_admin_login_buckets),
      (select count(*) from public.independent_admin_session_families),
      (select count(*) from public.independent_admin_sessions),
      (select count(*) from public.independent_admin_auth_audit)
    );`, "pre-retirement row counts");

  applyGate16WithLedger(
    "postgres",
    "Gate16 residue atomic ledger apply",
  );
  assert.equal(
    psql(`select concat_ws(':', count(*), min(name), min(sha256))
      from supabase_migrations.schema_migrations
      where version = '20260829063000';`, "Gate16 residue ledger identity"),
    `1:${GATE16_LEDGER_NAME}:${EXPECTED_RETIREMENT_SHA256}`,
  );
  assert.equal(
    psql(`select public.aistory_independent_admin_gate_status() || ':' ||
      state from public.independent_admin_qualification_resolutions;`,
    "pending Gate16 identity"),
    "20260828233000:awaiting_attestation",
  );
  assert.equal(
    psql("select public.aistory_independent_admin_security_posture();",
      "pending Gate16 security posture"),
    "t",
  );
  const capturedCommitment = psql(`select
      expected_pre_state_commitment_sha256
    from public.independent_admin_qualification_resolutions
    where resolution_slot = 1 and state = 'awaiting_attestation';`,
  "captured Gate16 pre-state commitment");
  assert.match(capturedCommitment, /^[a-f0-9]{64}$/);
  assert.equal(
    psql(`set timezone = 'UTC';
      select public.aistory_independent_admin_qualification_pre_state_commitment();
      set timezone = 'Asia/Shanghai';
      select public.aistory_independent_admin_qualification_pre_state_commitment();`,
    "timezone-independent pre-state commitment"),
    `${capturedCommitment}\n${capturedCommitment}`,
  );
  psqlMustFailFor(
    "postgres",
    `set request.jwt.claim.role = 'service_role';
      set role service_role;
      select public.aistory_independent_admin_qualification_pre_state_commitment();`,
    "service-role pre-state helper access",
    ["-1"],
    /permission denied for function/,
  );

  const validAttestation = buildAttestation(capturedCommitment);
  const pendingStateBeforeHostile = psql(`select concat_ws(':',
      public.aistory_independent_admin_gate_status(),
      (select state from public.independent_admin_qualification_resolutions),
      (select singleton_slot from public.independent_admin_principals),
      (select status from public.independent_admin_principals),
      (select count(*) from public.independent_admin_auth_audit)
    );`, "pre-hostile pending state");
  const hostileAttestations = [
    [
      "extra attestation field",
      { ...validAttestation, unexpected: true },
    ],
    [
      "wrong incident receipt",
      buildAttestation(capturedCommitment, {
        incidentReceiptSha256: "0".repeat(64),
      }),
    ],
    [
      "wrong pre-state commitment",
      buildAttestation("0".repeat(64)),
    ],
    [
      "unbound owner marker",
      {
        ...validAttestation,
        ownerMarkerCommitmentSha256: "c".repeat(64),
      },
    ],
    [
      "wrong attestation commitment",
      {
        ...validAttestation,
        attestationCommitmentSha256: "d".repeat(64),
      },
    ],
    [
      "owner marker reuses incident receipt",
      buildAttestation(capturedCommitment, {
        ownerMarkerCommitmentSha256: INCIDENT_RECEIPT_SHA256,
      }),
    ],
  ];
  for (const [label, attestation] of hostileAttestations) {
    psqlMustFailFor(
      "postgres",
      `select public.aistory_independent_admin_finalize_qualification_resolution(
        ${jsonbLiteral(attestation)}
      );`,
      label,
      ["-1"],
      /qualification resolution unavailable/,
    );
    assert.equal(
      psql(`select concat_ws(':',
          public.aistory_independent_admin_gate_status(),
          (select state from public.independent_admin_qualification_resolutions),
          (select singleton_slot from public.independent_admin_principals),
          (select status from public.independent_admin_principals),
          (select count(*) from public.independent_admin_auth_audit)
        );`, `${label} rollback state`),
      pendingStateBeforeHostile,
    );
  }
  psqlMustFailFor(
    "postgres",
    `set request.jwt.claim.role = 'service_role';
      set role service_role;
      select public.aistory_independent_admin_finalize_qualification_resolution(
        ${jsonbLiteral(validAttestation)}
      );`,
    "service-role finalizer access",
    ["-1"],
    /permission denied for function/,
  );

  for (const database of [DRIFT_DATABASE, CONCURRENT_DATABASE]) {
    psqlFor(
      "template1",
      `create database ${database} template postgres;`,
      `Gate16 pending clone ${database}`,
      [],
    );
  }
  psqlFor(
    DRIFT_DATABASE,
    "select nextval('public.independent_admin_auth_audit_sequence_seq');",
    "identity-sequence-only drift",
  );
  psqlMustFailFor(
    DRIFT_DATABASE,
    `select public.aistory_independent_admin_finalize_qualification_resolution(
      ${jsonbLiteral(validAttestation)}
    );`,
    "sequence drift finalization",
    ["-1"],
    /qualification resolution unavailable/,
  );
  assert.equal(
    psqlFor(DRIFT_DATABASE, `select
      public.aistory_independent_admin_gate_status() || ':' || state
      from public.independent_admin_qualification_resolutions;`,
    "sequence drift rollback identity"),
    "20260828233000:awaiting_attestation",
  );

  const concurrentFinalizations = await Promise.all([
    runAsyncFor(CONCURRENT_DATABASE, `select
      public.aistory_independent_admin_finalize_qualification_resolution(
        ${jsonbLiteral(validAttestation)}
      );`),
    runAsyncFor(CONCURRENT_DATABASE, `select
      public.aistory_independent_admin_finalize_qualification_resolution(
        ${jsonbLiteral(validAttestation)}
      );`),
  ]);
  assert.equal(
    concurrentFinalizations.filter((result) => result.status === 0).length,
    1,
  );
  assert.equal(
    concurrentFinalizations.filter((result) => result.status !== 0).length,
    1,
  );
  assert.match(
    concurrentFinalizations.find((result) => result.status !== 0).stderr,
    /qualification resolution unavailable/,
  );
  assert.equal(
    psqlFor(CONCURRENT_DATABASE, `select concat_ws(':',
      public.aistory_independent_admin_gate_status(),
      (select state from public.independent_admin_qualification_resolutions),
      (select count(*) from public.independent_admin_auth_audit
        where event = 'qualification_residue_retired')
    );`, "concurrent finalization identity"),
    "20260829063000:qualification_residue_retired:1",
  );

  assert.match(
    psql(`select public.aistory_independent_admin_finalize_qualification_resolution(
      ${jsonbLiteral(validAttestation)}
    )::text;`, "valid owner-only Gate16 finalization"),
    /qualification_residue_retired/,
  );
  assert.equal(
    psql(`select concat_ws(':',
      public.aistory_independent_admin_gate_status(),
      (select state from public.independent_admin_qualification_resolutions),
      (select singleton_slot from public.independent_admin_principals),
      (select status from public.independent_admin_principals),
      (select count(*) from public.independent_admin_auth_audit
        where event = 'qualification_residue_retired')
    );`, "terminal Gate16 identity"),
    "20260829063000:qualification_residue_retired:0:revoked:1",
  );
  assert.equal(
    psql("select public.aistory_independent_admin_security_posture();",
      "terminal Gate16 security posture"),
    "t",
  );
  assert.equal(legacyPrincipalProjection("postgres", 0), legacyPrincipalBefore);
  assert.equal(immutableHistoryProjection("postgres"), immutableHistoryBefore);
  assert.equal(
    psql(`select coalesce(
        jsonb_agg(to_jsonb(audit_row) order by audit_row.sequence), '[]'
      )::text
      from public.independent_admin_auth_audit as audit_row
      where audit_row.sequence <= ${auditMaxBefore};`,
    "preserved pre-retirement audit projection"),
    auditBefore,
  );
  const countsAfterRetirement = psql(`select concat_ws(':',
      (select count(*) from public.independent_admin_principals),
      (select count(*) from public.independent_admin_login_buckets),
      (select count(*) from public.independent_admin_session_families),
      (select count(*) from public.independent_admin_sessions),
      (select count(*) - 1 from public.independent_admin_auth_audit)
    );`, "post-retirement preserved row counts");
  assert.equal(countsAfterRetirement, countsBefore);
  psqlMustFailFor(
    "postgres",
    `select public.aistory_independent_admin_finalize_qualification_resolution(
      ${jsonbLiteral(validAttestation)}
    );`,
    "Gate16 finalizer replay",
    ["-1"],
    /qualification resolution unavailable/,
  );
  psqlMustFailFor(
    "postgres",
    "update public.independent_admin_principals set status = 'active' where singleton_slot = 0;",
    "retired principal update",
    ["-1"],
    /retired principal is immutable/,
  );
  psqlMustFailFor(
    "postgres",
    "delete from public.independent_admin_principals where singleton_slot = 0;",
    "retired principal delete",
    ["-1"],
    /principal history is immutable/,
  );
  psqlMustFailFor(
    "postgres",
    "truncate public.independent_admin_qualification_resolutions cascade;",
    "qualification resolution truncate",
    ["-1"],
    /qualification resolution is append-only/,
  );

  psqlMustFail(serviceRoleSql(`public.aistory_independent_admin_initialize(
    ${NEXT_BINDING} || jsonb_build_object(
      'request_id','ipr_dddddddddddddddddddddddddddddddd'
    )
  )`), "retired binding initializer replay", ["-1"]);
  psqlMustFail(serviceRoleSql(`public.aistory_independent_admin_append_security_event(
    ${NEXT_BINDING} || jsonb_build_object(
      'event','invalid_credentials','occurred_at',clock_timestamp()::text
    )
  )`), "retired binding security event", ["-1"]);
  assert.equal(
    psql(serviceRoleSql(`public.aistory_independent_admin_verify_session(
      ${NEXT_BINDING} || jsonb_build_object(
        'session_hash',repeat('b',64),'occurred_at',clock_timestamp()::text
      )
    ) is null`), "retired session cannot revive"),
    "t",
  );

  assert.match(
    psql(serviceRoleSql(`public.aistory_independent_admin_initialize(
      ${REAL_BINDING} || jsonb_build_object(
        'request_id','ipr_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
      )
    )::text`), "real principal initialization after retirement"),
    /"initialized": true/,
  );
  assert.equal(
    psql("select public.aistory_independent_admin_security_posture();",
      "post-real-initialization posture"),
    "t",
  );
  assert.equal(
    psql("select string_agg(singleton_slot::text || ':' || status, ',' order by singleton_slot) from public.independent_admin_principals;",
      "retired and real principal inventory"),
    "0:revoked,1:active",
  );
  const realBuckets = ["3".repeat(64), "4".repeat(64)];
  assert.equal(JSON.parse(psql(serviceRoleSql(
    `public.aistory_independent_admin_reserve_login(
      ${REAL_BINDING} || jsonb_build_object(
        'global_bucket_hash','${realBuckets[0]}',
        'subject_bucket_hash','${realBuckets[1]}',
        'occurred_at',clock_timestamp()::text
      )
    )::text`,
  ), "real principal login reservation")).allowed, true);
  const realExpiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  assert.equal(
    psql(serviceRoleSql(`public.aistory_independent_admin_commit_login(
      ${REAL_BINDING} || jsonb_build_object(
        'family_hash',repeat('5',64),
        'session_hash',repeat('6',64),
        'bucket_hashes',jsonb_build_array(
          '${realBuckets[0]}','${realBuckets[1]}'
        ),
        'occurred_at',clock_timestamp()::text,
        'expires_at','${realExpiresAt}'
      )
    )`), "real principal login"),
    "t",
  );
  assert.equal(
    psql(serviceRoleSql(`public.aistory_independent_admin_verify_session(
      ${REAL_BINDING} || jsonb_build_object(
        'session_hash',repeat('6',64),'occurred_at',clock_timestamp()::text
      )
    ) is not null`), "real principal session verification"),
    "t",
  );
  assert.equal(
    psql(serviceRoleSql(`public.aistory_independent_admin_rotate_session(
      ${REAL_BINDING} || jsonb_build_object(
        'current_session_hash',repeat('6',64),
        'next_session_hash',repeat('7',64),
        'occurred_at',clock_timestamp()::text,
        'next_expires_at','${realExpiresAt}'
      )
    )`), "real principal session rotation"),
    "t",
  );
  assert.equal(
    psql(serviceRoleSql(`public.aistory_independent_admin_revoke_session(
      ${REAL_BINDING} || jsonb_build_object(
        'session_hash',repeat('7',64),'occurred_at',clock_timestamp()::text
      )
    )`), "real principal logout"),
    "t",
  );

  applyGate16WithLedger(
    EMPTY_DATABASE,
    "Gate16 empty baseline atomic ledger apply",
  );
  assert.equal(
    psqlFor(EMPTY_DATABASE, `select concat_ws(':',
      public.aistory_independent_admin_gate_status(),
      (select state from public.independent_admin_qualification_resolutions),
      (select count(*) from public.independent_admin_principals),
      (select count(*) from public.independent_admin_auth_audit)
    );`, "empty Gate16 identity"),
    "20260829063000:not_required:0:0",
  );
  assert.equal(
    psqlFor(EMPTY_DATABASE,
      "select public.aistory_independent_admin_security_posture();",
    "empty Gate16 security posture"),
    "t",
  );
  assert.match(
    psqlFor(EMPTY_DATABASE, serviceRoleSql(
      `public.aistory_independent_admin_initialize(
        ${REAL_BINDING} || jsonb_build_object(
          'request_id','ipr_ffffffffffffffffffffffffffffffff'
        )
      )::text`,
    ), "empty baseline real initialization"),
    /"initialized": true/,
  );
  applyGate16WithLedgerMustFail(
    EMPTY_DATABASE,
    "Gate16 empty baseline replay",
    /Gate16 migration ledger predecessor unavailable/,
  );
  assert.equal(
    psqlFor(EMPTY_DATABASE, `select concat_ws(':',
      public.aistory_independent_admin_gate_status(),
      (select state from public.independent_admin_qualification_resolutions),
      (select count(*) from public.independent_admin_principals)
    );`, "empty Gate16 replay preservation"),
    "20260829063000:not_required:1",
  );

  const activeExpiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  psqlFor(ACTIVE_DATABASE, serviceRoleSql(
    `public.aistory_independent_admin_initialize(
      ${REAL_BINDING} || jsonb_build_object(
        'request_id','ipr_gggggggggggggggggggggggggggggggg'
      )
    )`,
  ), "active baseline initialization");
  const activeBuckets = ["c".repeat(64), "d".repeat(64)];
  psqlFor(ACTIVE_DATABASE, serviceRoleSql(
    `public.aistory_independent_admin_reserve_login(
      ${REAL_BINDING} || jsonb_build_object(
        'global_bucket_hash','${activeBuckets[0]}',
        'subject_bucket_hash','${activeBuckets[1]}',
        'occurred_at',clock_timestamp()::text
      )
    )`,
  ), "active baseline reservation");
  psqlFor(ACTIVE_DATABASE, serviceRoleSql(
    `public.aistory_independent_admin_commit_login(
      ${REAL_BINDING} || jsonb_build_object(
        'family_hash',repeat('e',64),
        'session_hash',repeat('f',64),
        'bucket_hashes',jsonb_build_array(
          '${activeBuckets[0]}','${activeBuckets[1]}'
        ),
        'occurred_at',clock_timestamp()::text,
        'expires_at','${activeExpiresAt}'
      )
    )`,
  ), "active baseline login");
  const activeStateBefore = immutableHistoryProjection(ACTIVE_DATABASE);
  applyGate16WithLedgerMustFail(
    ACTIVE_DATABASE,
    "active-session Gate16 rejection",
    /Gate16 data state unavailable/,
  );
  assert.equal(
    psqlFor(ACTIVE_DATABASE, `select concat_ws(':',
      public.aistory_independent_admin_gate_status(),
      to_regclass('public.independent_admin_qualification_resolutions') is null,
      (select count(*) from public.independent_admin_sessions where state='active')
    );`, "active-session Gate16 rollback"),
    "20260828233000:t:1",
  );
  assert.equal(
    immutableHistoryProjection(ACTIVE_DATABASE),
    activeStateBefore,
  );
  assert.equal(
    psqlFor(ACTIVE_DATABASE, serviceRoleSql(
      `public.aistory_independent_admin_verify_session(
        ${REAL_BINDING} || jsonb_build_object(
          'session_hash',repeat('f',64),'occurred_at',clock_timestamp()::text
        )
      ) is not null`,
    ), "active-session preservation"),
    "t",
  );

  psqlFor(REAL_DATABASE, serviceRoleSql(
    `public.aistory_independent_admin_initialize(
      ${REAL_BINDING} || jsonb_build_object(
        'request_id','ipr_hhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh'
      )
    )`,
  ), "real inactive baseline initialization");
  const realInactiveBefore = legacyPrincipalProjection(REAL_DATABASE);
  applyGate16WithLedger(
    REAL_DATABASE,
    "Gate16 real inactive atomic ledger capture",
  );
  psqlMustFailFor(
    REAL_DATABASE,
    `select public.aistory_independent_admin_finalize_qualification_resolution(
      ${jsonbLiteral(validAttestation)}
    );`,
    "cross-pre-state attestation rejection",
    ["-1"],
    /qualification resolution unavailable/,
  );
  assert.equal(
    legacyPrincipalProjection(REAL_DATABASE),
    realInactiveBefore,
  );
  assert.equal(
    psqlFor(REAL_DATABASE, `select concat_ws(':',
      public.aistory_independent_admin_gate_status(),
      (select state from public.independent_admin_qualification_resolutions),
      (select singleton_slot from public.independent_admin_principals),
      (select status from public.independent_admin_principals),
      (select count(*) from public.independent_admin_auth_audit
        where event='qualification_residue_retired')
    );`, "real inactive preservation"),
    "20260828233000:awaiting_attestation:1:active:0",
  );

  console.log(JSON.stringify({
    status: "PASS_GATE16_POSTGRESQL16_ISOLATED",
    postgresMajor: 16,
    networkMode: "none",
    hostPorts: 0,
    baseMigrations: BASE_MIGRATIONS.length,
    replacementVersion: "20260828233000",
    retirementVersion: "20260829063000",
    databaseScenarios: 16,
    ledgerCompatibilityScenarios: 10,
    ledgerShape: "version-name-sha256-applied_at",
    legacyStatementsColumnReproduced: true,
    retiredQualificationPrincipals: 1,
    realPrincipalsAfterRetirement: 1,
    concurrentRateAllowed: 5,
    concurrentRateDenied: 3,
    secretsRead: 0,
    externalNetworkCalls: 0,
  }));
} catch (error) {
  if (error instanceof PostgresVersionGateError) {
    blockedVersionGateError = error;
  } else {
    throw error;
  }
} finally {
  if (containerStarted) {
    spawnSync("docker", ["rm", "-f", containerId], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    });
    const remaining = spawnSync("docker", [
      "ps",
      "-a",
      "--filter",
      `name=^/${containerName}$`,
      "--format",
      "{{.ID}}",
    ], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(remaining.status, 0);
    assert.equal(remaining.stdout.trim(), "");
  }
}
if (blockedVersionGateError) {
  console.error(JSON.stringify(
    postgresVersionGateFailureReceipt(blockedVersionGateError),
  ));
  process.exitCode = 31;
}
