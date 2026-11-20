import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.AISTORY_GENERATION_JOB_DIR = await mkdtemp(
  path.join(os.tmpdir(), "aistory-lan-gpu-jobs-"),
);

let networkCalls = 0;
globalThis.fetch = (async () => {
  networkCalls += 1;
  throw new Error("network_forbidden_in_gpu_coordinator_test");
}) as typeof fetch;

const {
  COORDINATOR_HMAC_HEADERS,
  COORDINATOR_HMAC_TEST_VECTOR_EXPECTED,
  COORDINATOR_HMAC_TEST_VECTOR_INPUT,
  canonicalCoordinatorPath,
  decodeCoordinatorHmacSecret,
  signCoordinatorRequest,
  signCoordinatorResponse,
  verifyCoordinatorResponse,
} = await import("../lib/gpu-coordinator/hmac");
const {
  FakeCoordinatorUploadTicketIssuer,
  FakeGpuCoordinatorRepository,
} = await import("../lib/gpu-coordinator/fake");
const {
  CoordinatorProtocolError,
  parseCoordinatorRequest,
  projectCoordinatorLeaseForOrdinaryUser,
} = await import("../lib/gpu-coordinator/protocol");
const {
  GPU_COORDINATOR_EXPECTED_BUILD_SHA_ENV,
  GPU_COORDINATOR_EXPECTED_CAPABILITY_DIGEST_ENV,
  GPU_COORDINATOR_EXPECTED_CENTRAL_CONTRACT_SHA_ENV,
  GPU_COORDINATOR_EXPECTED_RELEASE_SHA_ENV,
  GPU_COORDINATOR_EXPECTED_RUNNER_MODE_ENV,
  GPU_CONNECTOR_NO_WORK_NETWORK_POSTURE,
} = await import("../lib/gpu-coordinator/connectorCompatibility");
const {
  CENTRAL_RECONCILE_AUTHORITATIVE_STATES,
  CONNECTOR_HEARTBEAT_REQUEST_STATES,
  CONNECTOR_RECONCILE_REQUEST_STATES,
} = await import("../lib/gpu-coordinator/types");
const {
  GpuCoordinatorService,
  CoordinatorServiceError,
  mapCoordinatorError,
} = await import("../lib/gpu-coordinator/service");
const {
  LanLabCoordinatorRepository,
} = await import("../lib/gpu-coordinator/labRepository");
const {
  configuredLanGpuAdminStatus,
  configuredLanGpuWorkflows,
  inspectLanGpuCoordinatorEnvironment,
  isLanGpuCoordinatorHostAllowed,
  parseLanGpuWorkflowAllowlist,
  resetLanGpuCoordinatorRuntimeForTests,
} = await import("../lib/gpu-coordinator/server");
const {
  mapLanGpuJobToLease,
  projectLanGpuCoordinatorStudioStatus,
  submitLanGpuVideoJob,
} = await import("../lib/gpu-coordinator/generationJobAdapter");
const { LTX23_R0_LAN_LAB_CANDIDATE } = await import(
  "../lib/gpu-coordinator/labCandidates"
);
const {
  resetGpuExecutionGateForTests,
  currentGpuExecutionOwner,
  tryAcquireGpuExecution,
} = await import("../lib/generation-jobs/executionGate");
const { getStoredGenerationJob, updateStoredGenerationJob } = await import(
  "../lib/generation-jobs/store"
);
const { adoptGenerationVideoAsset } = await import(
  "../lib/video-assets/server"
);

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const HASH_E = "e".repeat(64);
const LTX_WORKFLOW_SHA =
  "f3465cacbf88e139a0f4708ed887d875edab72cc5d28c0c6b40c91519362794e";
const NOW = new Date("2026-07-31T00:00:00.000Z");
const NO_WORK_RUNTIME_BINDING = {
  expectedBuildSha256: HASH_A,
  expectedReleaseSha256: HASH_B,
  expectedCapabilityDigestSha256: HASH_C,
  expectedCentralContractSha256: HASH_D,
  expectedNetworkPosture: { ...GPU_CONNECTOR_NO_WORK_NETWORK_POSTURE },
};
const FOREGROUND_RUNTIME_BINDING = {
  ...NO_WORK_RUNTIME_BINDING,
  expectedNetworkPosture: {
    productionNetworkEnabled: false as const,
    lanLabNetworkEnabled: true as const,
    runnerMode: "foreground_once" as const,
  },
};
const secret = decodeCoordinatorHmacSecret(
  COORDINATOR_HMAC_TEST_VECTOR_INPUT.secretBase64,
);

function context(operation: string, requestId: string) {
  return {
    operation,
    requestId,
    keyId: "lan-lab-current",
    now: NOW,
  } as never;
}

function omitOwnKey(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

const canonicalPath = canonicalCoordinatorPath(
  COORDINATOR_HMAC_TEST_VECTOR_INPUT.path,
);
assert.equal(
  canonicalPath,
  COORDINATOR_HMAC_TEST_VECTOR_EXPECTED.canonicalPath,
);
const vectorBody = new TextEncoder().encode(
  COORDINATOR_HMAC_TEST_VECTOR_INPUT.bodyUtf8,
);
const vectorHeaders = signCoordinatorRequest({
  method: "POST",
  path: COORDINATOR_HMAC_TEST_VECTOR_INPUT.path,
  body: vectorBody,
  key: {
    keyId: COORDINATOR_HMAC_TEST_VECTOR_INPUT.keyId,
    secret,
  },
  timestamp: COORDINATOR_HMAC_TEST_VECTOR_INPUT.timestamp,
  nonce: COORDINATOR_HMAC_TEST_VECTOR_INPUT.nonce,
  requestId: COORDINATOR_HMAC_TEST_VECTOR_INPUT.requestId,
});
assert.equal(
  vectorHeaders.get(COORDINATOR_HMAC_HEADERS.contentSha256),
  COORDINATOR_HMAC_TEST_VECTOR_EXPECTED.requestBodySha256,
);
assert.equal(
  vectorHeaders.get(COORDINATOR_HMAC_HEADERS.signature),
  `v1=${COORDINATOR_HMAC_TEST_VECTOR_EXPECTED.requestSignatureHex}`,
);
const vectorEnvelope = JSON.parse(
  COORDINATOR_HMAC_TEST_VECTOR_INPUT.responseBodyUtf8,
);
const signedResponse = signCoordinatorResponse({
  envelope: vectorEnvelope,
  status: COORDINATOR_HMAC_TEST_VECTOR_INPUT.responseStatus,
  path: COORDINATOR_HMAC_TEST_VECTOR_INPUT.path,
  key: {
    keyId: COORDINATOR_HMAC_TEST_VECTOR_INPUT.keyId,
    secret,
  },
  now: new Date(COORDINATOR_HMAC_TEST_VECTOR_INPUT.timestamp * 1_000),
  nonce: COORDINATOR_HMAC_TEST_VECTOR_INPUT.responseNonce,
});
assert.equal(
  signedResponse.headers.get(COORDINATOR_HMAC_HEADERS.contentSha256),
  COORDINATOR_HMAC_TEST_VECTOR_EXPECTED.responseBodySha256,
);
assert.equal(
  signedResponse.headers.get(COORDINATOR_HMAC_HEADERS.signature),
  `v1=${COORDINATOR_HMAC_TEST_VECTOR_EXPECTED.responseSignatureHex}`,
);
assert.doesNotThrow(() =>
  verifyCoordinatorResponse({
    status: 200,
    path: COORDINATOR_HMAC_TEST_VECTOR_INPUT.path,
    headers: signedResponse.headers,
    body: signedResponse.body,
    keyRing: {
      current: {
        keyId: COORDINATOR_HMAC_TEST_VECTOR_INPUT.keyId,
        secret,
      },
    },
    now: new Date(COORDINATOR_HMAC_TEST_VECTOR_INPUT.timestamp * 1_000),
  }),
);

assert.equal(
  inspectLanGpuCoordinatorEnvironment({ NODE_ENV: "test" }).reason,
  "disabled",
);
assert.equal(
  inspectLanGpuCoordinatorEnvironment({
    NODE_ENV: "test",
    AISTORY_GPU_LAN_LAB_ENABLED: "true",
  }).reason,
  "missing_connector_id",
);
const baseEnv = {
  NODE_ENV: "test" as const,
  AISTORY_GPU_LAN_LAB_ENABLED: "true",
  AISTORY_GPU_LAN_LAB_CONNECTOR_ID: "gpu-lab-4090",
  AISTORY_GPU_LAN_LAB_EXPECTED_CONNECTOR_BUILD_SHA256: HASH_A,
  AISTORY_GPU_LAN_LAB_EXPECTED_CONNECTOR_RELEASE_SHA256: HASH_B,
  AISTORY_GPU_LAN_LAB_EXPECTED_CAPABILITY_DIGEST_SHA256: HASH_C,
  AISTORY_GPU_LAN_LAB_EXPECTED_CENTRAL_CONTRACT_SHA256: HASH_D,
  AISTORY_GPU_LAN_LAB_EXPECTED_RUNNER_MODE: "no_work_only",
  AISTORY_GPU_LAN_LAB_HMAC_KEY_ID: "lan-lab-current",
  AISTORY_GPU_LAN_LAB_HMAC_SECRET_BASE64:
    COORDINATOR_HMAC_TEST_VECTOR_INPUT.secretBase64,
  AISTORY_GPU_LAN_LAB_STORE_DIR: "relative-test-store",
  AISTORY_GPU_LAN_LAB_COORDINATOR_ORIGIN: "https://coordinator.invalid",
  AISTORY_GPU_LAN_LAB_UPLOAD_ORIGIN: "https://coordinator.invalid",
};
assert.equal(
  inspectLanGpuCoordinatorEnvironment({
    ...baseEnv,
    AISTORY_GPU_LAN_LAB_EXPECTED_CONNECTOR_BUILD_SHA256: "",
  }).reason,
  "missing_expected_build_sha256",
);
assert.equal(
  inspectLanGpuCoordinatorEnvironment({
    ...baseEnv,
    AISTORY_GPU_LAN_LAB_EXPECTED_CONNECTOR_RELEASE_SHA256: "",
  }).reason,
  "missing_expected_release_sha256",
);
assert.equal(
  inspectLanGpuCoordinatorEnvironment({
    ...baseEnv,
    AISTORY_GPU_LAN_LAB_EXPECTED_CAPABILITY_DIGEST_SHA256: "",
  }).reason,
  "missing_expected_capability_digest_sha256",
);
assert.equal(
  inspectLanGpuCoordinatorEnvironment({
    ...baseEnv,
    AISTORY_GPU_LAN_LAB_EXPECTED_CENTRAL_CONTRACT_SHA256: "",
  }).reason,
  "missing_expected_central_contract_sha256",
);
assert.equal(
  inspectLanGpuCoordinatorEnvironment({
    ...baseEnv,
    AISTORY_GPU_LAN_LAB_EXPECTED_RUNNER_MODE: "foreground_once",
  }).reason,
  "invalid_expected_runner_mode",
);
assert.equal(
  inspectLanGpuCoordinatorEnvironment({
    ...baseEnv,
    AISTORY_GPU_LAN_LAB_HMAC_KEY_ID: "",
  }).reason,
  "missing_hmac_key_id",
);
assert.equal(
  inspectLanGpuCoordinatorEnvironment(baseEnv).reason,
  "missing_store",
);
const absoluteBaseEnv = {
  ...baseEnv,
  AISTORY_GPU_LAN_LAB_STORE_DIR: "D:\\ignored-test-store",
};
assert.equal(
  inspectLanGpuCoordinatorEnvironment({
    ...absoluteBaseEnv,
    AISTORY_GPU_LAN_LAB_COORDINATOR_ORIGIN: "",
  }).reason,
  "missing_coordinator_origin",
);
assert.equal(
  inspectLanGpuCoordinatorEnvironment(absoluteBaseEnv).reason,
  "workflow_allowlist_empty",
);
assert.equal(
  isLanGpuCoordinatorHostAllowed(
    new Headers({ host: "coordinator.invalid" }),
    absoluteBaseEnv,
  ),
  true,
);
assert.equal(
  isLanGpuCoordinatorHostAllowed(
    new Headers({
      host: "untrusted.invalid",
      "x-forwarded-host": "coordinator.invalid",
    }),
    absoluteBaseEnv,
  ),
  false,
);
const allowlistJson = JSON.stringify([
  {
    workflowId: "ltx23-original-av-lab",
    workflowSha256: LTX_WORKFLOW_SHA,
    modality: "video",
  },
]);
const allowlist = parseLanGpuWorkflowAllowlist(allowlistJson);
assert.equal(allowlist.length, 1);
assert.equal(
  allowlist[0]?.workflowSha256,
  LTX23_R0_LAN_LAB_CANDIDATE.workflowSha256,
);
assert.deepEqual(allowlist[0]?.outputSlots, [
  { nodeId: "21", slot: 0, mimeType: "video/mp4" },
]);
assert.equal(allowlist[0]?.purpose, "generate");
assert.deepEqual(allowlist[0]?.fixedParameters, {
  width: 768,
  height: 480,
  frames: 81,
  fps: 24,
  seed: 40902000,
});
assert.deepEqual(allowlist[0]?.inputSlots, []);
assert.equal(
  parseLanGpuWorkflowAllowlist(
    JSON.stringify([
      {
        workflowId: "ltx23-original-av-lab",
        workflowSha256: HASH_B,
        modality: "video",
      },
    ]),
  ).length,
  0,
);
assert.deepEqual(parseLanGpuWorkflowAllowlist('[{"workflowId":"x"}]'), []);
assert.equal(
  inspectLanGpuCoordinatorEnvironment({
    ...absoluteBaseEnv,
    AISTORY_GPU_LAN_LAB_WORKFLOW_ALLOWLIST_JSON: allowlistJson,
  }).reason,
  "ready",
);

const runtimeProjectionRoot = await mkdtemp(
  path.join(os.tmpdir(), "aistory-gpu-no-work-projection-"),
);
Object.assign(process.env, {
  ...absoluteBaseEnv,
  AISTORY_GPU_LAN_LAB_STORE_DIR: runtimeProjectionRoot,
  AISTORY_GPU_LAN_LAB_WORKFLOW_ALLOWLIST_JSON: allowlistJson,
});
resetLanGpuCoordinatorRuntimeForTests();
assert.deepEqual(configuredLanGpuWorkflows(), []);
const noWorkAdminStatus = await configuredLanGpuAdminStatus();
assert.equal(noWorkAdminStatus.mode, "disabled");
assert.equal(noWorkAdminStatus.state, "offline");
assert.equal(noWorkAdminStatus.workflowCount, 0);
for (const envName of [
  "AISTORY_GPU_LAN_LAB_ENABLED",
  "AISTORY_GPU_LAN_LAB_CONNECTOR_ID",
  GPU_COORDINATOR_EXPECTED_BUILD_SHA_ENV,
  GPU_COORDINATOR_EXPECTED_RELEASE_SHA_ENV,
  GPU_COORDINATOR_EXPECTED_CAPABILITY_DIGEST_ENV,
  GPU_COORDINATOR_EXPECTED_CENTRAL_CONTRACT_SHA_ENV,
  GPU_COORDINATOR_EXPECTED_RUNNER_MODE_ENV,
  "AISTORY_GPU_LAN_LAB_HMAC_KEY_ID",
  "AISTORY_GPU_LAN_LAB_HMAC_SECRET_BASE64",
  "AISTORY_GPU_LAN_LAB_STORE_DIR",
  "AISTORY_GPU_LAN_LAB_COORDINATOR_ORIGIN",
  "AISTORY_GPU_LAN_LAB_UPLOAD_ORIGIN",
  "AISTORY_GPU_LAN_LAB_WORKFLOW_ALLOWLIST_JSON",
]) {
  delete process.env[envName];
}
resetLanGpuCoordinatorRuntimeForTests();

const noWorkRegistrationRaw = {
  protocolVersion: "1.0",
  connectorId: "gpu-lab-4090",
  connectorVersion: "0.2.0",
  buildSha256: HASH_A,
  releaseSha256: HASH_B,
  capabilityDigestSha256: HASH_C,
  centralContractSha256: HASH_D,
  networkPosture: { ...GPU_CONNECTOR_NO_WORK_NETWORK_POSTURE },
};
const heartbeatRaw = {
  protocolVersion: "1.0",
  connectorId: "gpu-lab-4090",
  sessionId: "session-placeholder-0001",
  sequence: 0,
  observedAt: NOW.toISOString(),
  state: "idle",
  capacity: { maxConcurrent: 1, availableSlots: 1 },
  gpu: {
    utilizationPercent: 0,
    vramUsedMiB: 100,
    vramTotalMiB: 24_576,
  },
};

assert.deepEqual(CONNECTOR_HEARTBEAT_REQUEST_STATES, [
  "idle",
  "leased",
  "running",
  "draining",
  "recovery_required",
  "revoked",
]);
assert.deepEqual(CONNECTOR_RECONCILE_REQUEST_STATES, [
  "received",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
assert.deepEqual(CENTRAL_RECONCILE_AUTHORITATIVE_STATES, [
  "offered",
  "acknowledged",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "unknown",
]);

for (const state of CONNECTOR_HEARTBEAT_REQUEST_STATES) {
  assert.equal(
    parseCoordinatorRequest("heartbeat", { ...heartbeatRaw, state }).state,
    state,
  );
}
for (const invalidState of ["registered", "unknown", "ambiguous"]) {
  assert.throws(
    () =>
      parseCoordinatorRequest("heartbeat", {
        ...heartbeatRaw,
        state: invalidState,
      }),
    (error: unknown) =>
      error instanceof CoordinatorProtocolError && error.code === "bad_request",
  );
}

const invalidRegistrations: unknown[] = [
  ...[
    "buildSha256",
    "releaseSha256",
    "capabilityDigestSha256",
    "centralContractSha256",
    "networkPosture",
  ].map((key) => omitOwnKey(noWorkRegistrationRaw, key)),
  { ...noWorkRegistrationRaw, unknownField: "PRIVATE_REGISTER_MARKER" },
  {
    ...noWorkRegistrationRaw,
    networkPosture: {
      productionNetworkEnabled: true,
      lanLabNetworkEnabled: true,
      runnerMode: "no_work_only",
    },
  },
  {
    ...noWorkRegistrationRaw,
    networkPosture: {
      productionNetworkEnabled: true,
      lanLabNetworkEnabled: false,
      runnerMode: "no_work_only",
    },
  },
  {
    ...noWorkRegistrationRaw,
    networkPosture: {
      productionNetworkEnabled: false,
      lanLabNetworkEnabled: false,
      runnerMode: "no_work_only",
    },
  },
  {
    ...noWorkRegistrationRaw,
    networkPosture: {
      productionNetworkEnabled: false,
      lanLabNetworkEnabled: true,
      runnerMode: "no_work_only",
      unknownField: true,
    },
  },
  ...[
    "productionNetworkEnabled",
    "lanLabNetworkEnabled",
    "runnerMode",
  ].map((key) => ({
    ...noWorkRegistrationRaw,
    networkPosture: omitOwnKey(
      noWorkRegistrationRaw.networkPosture,
      key,
    ),
  })),
  Object.assign(Object.create({ inherited: true }), noWorkRegistrationRaw),
];
const accessorRegistration = { ...noWorkRegistrationRaw } as Record<
  string,
  unknown
>;
Object.defineProperty(accessorRegistration, "releaseSha256", {
  enumerable: true,
  get() {
    throw new Error("PRIVATE_ACCESSOR_MARKER");
  },
});
invalidRegistrations.push(accessorRegistration);
const symbolRegistration = { ...noWorkRegistrationRaw } as Record<
  PropertyKey,
  unknown
>;
symbolRegistration[Symbol("private")] = "PRIVATE_SYMBOL_MARKER";
invalidRegistrations.push(symbolRegistration);
for (const invalid of invalidRegistrations) {
  assert.throws(
    () => parseCoordinatorRequest("register", invalid),
    (error: unknown) =>
      error instanceof CoordinatorProtocolError && error.code === "bad_request",
  );
}

const noWorkRepository = new FakeGpuCoordinatorRepository();
let noWorkClaimCalls = 0;
let noWorkListCalls = 0;
let noWorkMutateLeaseCalls = 0;
const originalNoWorkClaim = noWorkRepository.claimLease.bind(noWorkRepository);
const originalNoWorkList = noWorkRepository.listLeases.bind(noWorkRepository);
const originalNoWorkMutate = noWorkRepository.mutateLease.bind(noWorkRepository);
noWorkRepository.claimLease = async (input) => {
  noWorkClaimCalls += 1;
  return originalNoWorkClaim(input);
};
noWorkRepository.listLeases = async () => {
  noWorkListCalls += 1;
  return originalNoWorkList();
};
noWorkRepository.mutateLease = async (...args) => {
  noWorkMutateLeaseCalls += 1;
  return originalNoWorkMutate(...args);
};
let noWorkGenerationCalls = 0;
let noWorkId = 0;
const noWorkIdSource = {
  next(prefix: "session" | "lease" | "ticket" | "correlation") {
    noWorkId += 1;
    return `${prefix}-no-work-${String(noWorkId).padStart(4, "0")}`;
  },
};
const noWorkService = new GpuCoordinatorService({
  repository: noWorkRepository,
  ticketIssuer: new FakeCoordinatorUploadTicketIssuer(noWorkIdSource),
  clock: { now: () => NOW },
  idSource: noWorkIdSource,
  generationJobs: {
    async progress() {
      noWorkGenerationCalls += 1;
    },
    async complete() {
      noWorkGenerationCalls += 1;
    },
    async fail() {
      noWorkGenerationCalls += 1;
    },
    async cancelled() {
      noWorkGenerationCalls += 1;
    },
  },
  allowedConnectorId: "gpu-lab-4090",
  currentKeyId: "lan-lab-current",
  runtimeBinding: NO_WORK_RUNTIME_BINDING,
});
const noWorkRegistered = await noWorkService.handle(
  "register",
  parseCoordinatorRequest("register", noWorkRegistrationRaw),
  context("register", "request-no-work-register"),
);
await assert.rejects(
  noWorkService.handle(
    "lease",
    parseCoordinatorRequest("lease", {
      protocolVersion: "1.0",
      connectorId: "gpu-lab-4090",
      sessionId: noWorkRegistered.sessionId,
      sequence: 0,
    }),
    context("lease", "request-before-first-heartbeat"),
  ),
  (error: unknown) =>
    error instanceof CoordinatorServiceError &&
    error.code === "operation_out_of_order",
);
await assert.rejects(
  noWorkService.handle(
    "heartbeat",
    parseCoordinatorRequest("heartbeat", {
      ...heartbeatRaw,
      sessionId: noWorkRegistered.sessionId,
      state: "leased",
    }),
    context("heartbeat", "request-first-heartbeat-not-idle"),
  ),
  (error: unknown) =>
    error instanceof CoordinatorServiceError &&
    error.code === "operation_out_of_order",
);
await noWorkService.handle(
  "heartbeat",
  parseCoordinatorRequest("heartbeat", {
    ...heartbeatRaw,
    sessionId: noWorkRegistered.sessionId,
  }),
  context("heartbeat", "request-first-heartbeat-idle"),
);
resetGpuExecutionGateForTests();
assert.equal(
  tryAcquireGpuExecution({
    kind: "lan_lab",
    jobId: "existing-owner-must-survive-no-work",
  }),
  true,
);
for (const sequence of [1, 2, 3]) {
  const noWork = await noWorkService.handle(
    "lease",
    parseCoordinatorRequest("lease", {
      protocolVersion: "1.0",
      connectorId: "gpu-lab-4090",
      sessionId: noWorkRegistered.sessionId,
      sequence,
    }),
    context("lease", `request-no-work-lease-${sequence}`),
  );
  assert.deepEqual(noWork, {
    kind: "no_work",
    nextPollAfterMs: 3_000,
    reason: "runner_mode_no_work_only",
  });
}
assert.equal(noWorkClaimCalls, 0);
assert.equal(noWorkListCalls, 0);
assert.equal(noWorkMutateLeaseCalls, 0);
assert.equal(noWorkGenerationCalls, 0);
assert.equal(currentGpuExecutionOwner()?.kind, "lan_lab");
assert.equal(
  currentGpuExecutionOwner()?.jobId,
  "existing-owner-must-survive-no-work",
);
resetGpuExecutionGateForTests();

const reconcileRecordRaw = {
  jobId: "job-reconcile-fixture",
  leaseId: "lease-reconcile-fixture",
  idempotencyKey: "idempotency-reconcile-fixture",
  workflowId: "workflow-reconcile-fixture",
  workflowSha256: HASH_A,
  parameterBindingSha256: HASH_B,
  promptIdentitySha256: HASH_C,
  modality: "video",
  expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
  state: "received",
};
for (const state of CONNECTOR_RECONCILE_REQUEST_STATES) {
  const parsed = parseCoordinatorRequest("reconcile", {
    protocolVersion: "1.0",
    connectorId: "gpu-lab-4090",
    sessionId: noWorkRegistered.sessionId,
    sequence: 4,
    records: [{ ...reconcileRecordRaw, state }],
  });
  assert.equal(parsed.records[0]?.state, state);
}
for (const invalidState of [
  "ambiguous",
  "acknowledged",
  "offered",
  "unknown",
  "registered",
]) {
  assert.throws(
    () =>
      parseCoordinatorRequest("reconcile", {
        protocolVersion: "1.0",
        connectorId: "gpu-lab-4090",
        sessionId: noWorkRegistered.sessionId,
        sequence: 4,
        records: [{ ...reconcileRecordRaw, state: invalidState }],
      }),
    (error: unknown) =>
      error instanceof CoordinatorProtocolError && error.code === "bad_request",
  );
}

const reconcileLeaseStates = [
  "offered",
  "acknowledged",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;
for (const state of reconcileLeaseStates) {
  await noWorkRepository.enqueueLease({
    jobId: `job-reconcile-${state}`,
    leaseId: `lease-reconcile-${state}`,
    idempotencyKey: `idempotency-reconcile-${state}`,
    modality: "video",
    workflowId: "workflow-reconcile-fixture",
    workflowSha256: HASH_A,
    parameterBindingSha256: HASH_B,
    allowedOutputs: [],
    businessParameters: {},
    inputTickets: {},
    expiresAt: reconcileRecordRaw.expiresAt,
    state,
    promptIdentitySha256: HASH_C,
    progressSequence: 0,
    cancelRequested: false,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  });
}
const reconcileRecords = [
  ...reconcileLeaseStates.map((state) => ({
    ...reconcileRecordRaw,
    jobId: `job-reconcile-${state}`,
    leaseId: `lease-reconcile-${state}`,
    idempotencyKey: `idempotency-reconcile-${state}`,
    state:
      state === "succeeded" || state === "failed" || state === "cancelled"
        ? state
        : state === "running"
          ? "running"
          : "received",
  })),
  {
    ...reconcileRecordRaw,
    jobId: "job-reconcile-missing",
    leaseId: "lease-reconcile-missing",
    idempotencyKey: "idempotency-reconcile-missing",
  },
];
const reconciled = await noWorkService.handle(
  "reconcile",
  parseCoordinatorRequest("reconcile", {
    protocolVersion: "1.0",
    connectorId: "gpu-lab-4090",
    sessionId: noWorkRegistered.sessionId,
    sequence: 4,
    records: reconcileRecords,
  }),
  context("reconcile", "request-reconcile-all-authoritative-states"),
);
assert.deepEqual(
  reconciled.records.map((record) => record.authoritativeState),
  CENTRAL_RECONCILE_AUTHORITATIVE_STATES,
);
assert.equal(noWorkClaimCalls, 0);
assert.equal(noWorkListCalls, 0);
assert.equal(noWorkMutateLeaseCalls, 0);
assert.equal(noWorkGenerationCalls, 0);

const reRegistered = await noWorkService.handle(
  "register",
  parseCoordinatorRequest("register", noWorkRegistrationRaw),
  context("register", "request-no-work-reregister"),
);
assert.notEqual(reRegistered.sessionId, noWorkRegistered.sessionId);
await assert.rejects(
  noWorkService.handle(
    "heartbeat",
    parseCoordinatorRequest("heartbeat", {
      ...heartbeatRaw,
      sessionId: noWorkRegistered.sessionId,
      sequence: 5,
    }),
    context("heartbeat", "request-superseded-session"),
  ),
  (error: unknown) =>
    error instanceof CoordinatorServiceError && error.code === "session_invalid",
);
await assert.rejects(
  noWorkService.handle(
    "lease",
    parseCoordinatorRequest("lease", {
      protocolVersion: "1.0",
      connectorId: "gpu-lab-4090",
      sessionId: noWorkRegistered.sessionId,
      sequence: 1,
    }),
    context("lease", "request-no-work-lease-1"),
  ),
  (error: unknown) =>
    error instanceof CoordinatorServiceError && error.code === "session_invalid",
);
await assert.rejects(
  noWorkService.handle(
    "lease",
    parseCoordinatorRequest("lease", {
      protocolVersion: "1.0",
      connectorId: "gpu-lab-4090",
      sessionId: reRegistered.sessionId,
      sequence: 0,
    }),
    context("lease", "request-reregister-before-idle"),
  ),
  (error: unknown) =>
    error instanceof CoordinatorServiceError &&
    error.code === "operation_out_of_order",
);
await noWorkService.handle(
  "heartbeat",
  parseCoordinatorRequest("heartbeat", {
    ...heartbeatRaw,
    sessionId: reRegistered.sessionId,
  }),
  context("heartbeat", "request-reregister-first-idle"),
);
const reRegisteredNoWork = await noWorkService.handle(
  "lease",
  parseCoordinatorRequest("lease", {
    protocolVersion: "1.0",
    connectorId: "gpu-lab-4090",
    sessionId: reRegistered.sessionId,
    sequence: 1,
  }),
  context("lease", "request-reregister-no-work"),
);
assert.equal(reRegisteredNoWork.kind, "no_work");
assert.equal(noWorkClaimCalls, 0);
assert.equal(noWorkListCalls, 0);
assert.equal(noWorkMutateLeaseCalls, 0);

await noWorkRepository.mutateConnector("gpu-lab-4090", (connector) => {
  connector.buildSha256 = HASH_E;
});
await assert.rejects(
  noWorkService.handle(
    "lease",
    parseCoordinatorRequest("lease", {
      protocolVersion: "1.0",
      connectorId: "gpu-lab-4090",
      sessionId: reRegistered.sessionId,
      sequence: 1,
    }),
    context("lease", "request-reregister-no-work"),
  ),
  (error: unknown) => {
    assert.equal(String(error).includes(HASH_E), false);
    return (
      error instanceof CoordinatorServiceError &&
      error.code === "connector_not_allowed"
    );
  },
);
assert.equal(noWorkClaimCalls, 0);
assert.equal(noWorkListCalls, 0);
assert.equal(noWorkMutateLeaseCalls, 0);
assert.equal(noWorkGenerationCalls, 0);

const mismatchRepositoryBacking = new FakeGpuCoordinatorRepository();
let mismatchRepositoryCalls = 0;
const mismatchRepository = new Proxy(mismatchRepositoryBacking, {
  get(target, property) {
    const value = Reflect.get(target, property, target);
    if (typeof value !== "function") return value;
    return (...args: unknown[]) => {
      mismatchRepositoryCalls += 1;
      return Reflect.apply(value, target, args);
    };
  },
});
const mismatchService = new GpuCoordinatorService({
  repository: mismatchRepository,
  ticketIssuer: new FakeCoordinatorUploadTicketIssuer(noWorkIdSource),
  clock: { now: () => NOW },
  idSource: noWorkIdSource,
  allowedConnectorId: "gpu-lab-4090",
  currentKeyId: "lan-lab-current",
  runtimeBinding: NO_WORK_RUNTIME_BINDING,
});
for (const drift of [
  { buildSha256: HASH_E },
  { releaseSha256: HASH_E },
  { capabilityDigestSha256: HASH_E },
  { centralContractSha256: HASH_E },
]) {
  await assert.rejects(
    mismatchService.handle(
      "register",
      parseCoordinatorRequest("register", {
        ...noWorkRegistrationRaw,
        ...drift,
      }),
      context("register", `request-binding-drift-${Object.keys(drift)[0]}`),
    ),
    (error: unknown) => {
      assert.equal(String(error).includes(HASH_E), false);
      return (
        error instanceof CoordinatorServiceError &&
        error.code === "connector_version_unsupported" &&
        error.status === 426
      );
    },
  );
}
await assert.rejects(
  mismatchService.handle(
    "register",
    parseCoordinatorRequest("register", {
      ...noWorkRegistrationRaw,
      networkPosture: {
        productionNetworkEnabled: false,
        lanLabNetworkEnabled: true,
        runnerMode: "foreground_once",
      },
    }),
    context("register", "request-binding-drift-posture"),
  ),
  (error: unknown) =>
    error instanceof CoordinatorServiceError &&
    error.code === "connector_not_allowed" &&
    error.status === 403,
);
assert.equal(mismatchRepositoryCalls, 0);

const legacyRepository = new FakeGpuCoordinatorRepository();
await legacyRepository.saveConnector({
  connectorId: "gpu-lab-4090",
  connectorVersion: "0.2.0",
  buildSha256: HASH_E,
  releaseSha256: HASH_B,
  capabilityDigestSha256: HASH_C,
  sessionId: "session-legacy-attestation",
  status: "active",
  lastHeartbeatSequence: 4,
  lastSeenAt: NOW.toISOString(),
} as never);
const legacyService = new GpuCoordinatorService({
  repository: legacyRepository,
  ticketIssuer: new FakeCoordinatorUploadTicketIssuer(noWorkIdSource),
  clock: { now: () => NOW },
  idSource: noWorkIdSource,
  allowedConnectorId: "gpu-lab-4090",
  currentKeyId: "lan-lab-current",
  runtimeBinding: NO_WORK_RUNTIME_BINDING,
});
await assert.rejects(
  legacyService.handle(
    "heartbeat",
    parseCoordinatorRequest("heartbeat", {
      ...heartbeatRaw,
      sessionId: "session-legacy-attestation",
      sequence: 5,
    }),
    context("heartbeat", "request-legacy-attestation"),
  ),
  (error: unknown) => {
    const serialized = JSON.stringify({
      name: error instanceof Error ? error.name : "unknown",
      message: error instanceof Error ? error.message : String(error),
    });
    assert.equal(serialized.includes(HASH_E), false);
    return (
      error instanceof CoordinatorServiceError &&
      error.code === "connector_not_allowed"
    );
  },
);
const migratedRegistration = await legacyService.handle(
  "register",
  parseCoordinatorRequest("register", noWorkRegistrationRaw),
  context("register", "request-replace-legacy-attestation"),
);
assert.notEqual(migratedRegistration.sessionId, "session-legacy-attestation");
assert.equal(
  (await legacyRepository.getConnector("gpu-lab-4090"))
    ?.firstHeartbeatAccepted,
  false,
);

const fakeRepository = new FakeGpuCoordinatorRepository();
let singleFlightCalls = 0;
const [singleFlightOne, singleFlightTwo] = await Promise.all([
  fakeRepository.runIdempotent(
    "scope",
    "request-0001",
    HASH_A,
    async () => {
      singleFlightCalls += 1;
      await Promise.resolve();
      return { ok: true };
    },
  ),
  fakeRepository.runIdempotent(
    "scope",
    "request-0001",
    HASH_A,
    async () => {
      singleFlightCalls += 1;
      return { ok: false };
    },
  ),
]);
assert.equal(singleFlightCalls, 1);
assert.deepEqual(singleFlightOne.value, { ok: true });
assert.deepEqual(singleFlightTwo.value, { ok: true });
await assert.rejects(
  fakeRepository.runIdempotent(
    "scope",
    "request-0001",
    HASH_B,
    async () => ({ ok: false }),
  ),
  (error: unknown) =>
    error instanceof CoordinatorProtocolError &&
    error.code === "idempotency_conflict",
);

let idCounter = 0;
const generationEvents: string[] = [];
const service = new GpuCoordinatorService({
  repository: fakeRepository,
  ticketIssuer: new FakeCoordinatorUploadTicketIssuer({
    next(prefix) {
      idCounter += 1;
      return `${prefix}-test-${idCounter.toString().padStart(4, "0")}`;
    },
  }),
  clock: { now: () => NOW },
  idSource: {
    next(prefix) {
      idCounter += 1;
      return `${prefix}-test-${idCounter.toString().padStart(4, "0")}`;
    },
  },
  generationJobs: {
    async progress() {
      generationEvents.push("progress");
    },
    async complete() {
      generationEvents.push("complete");
    },
    async fail() {
      generationEvents.push("fail");
    },
    async cancelled() {
      generationEvents.push("cancelled");
    },
  },
  allowedConnectorId: "gpu-lab-4090",
  currentKeyId: "lan-lab-current",
  runtimeBinding: FOREGROUND_RUNTIME_BINDING,
});

await assert.rejects(
  service.handle(
    "register",
    {
      protocolVersion: "1.0",
      connectorId: "gpu-lab-4090",
      connectorVersion: "0.1.9",
      buildSha256: HASH_A,
      releaseSha256: HASH_B,
      capabilityDigestSha256: HASH_C,
      centralContractSha256: HASH_D,
      networkPosture: { ...FOREGROUND_RUNTIME_BINDING.expectedNetworkPosture },
    },
    context("register", "request-old-version"),
  ),
  (error: unknown) =>
    error instanceof CoordinatorServiceError &&
    error.code === "connector_version_unsupported",
);
const registered = await service.handle(
  "register",
  {
    protocolVersion: "1.0",
    connectorId: "gpu-lab-4090",
    connectorVersion: "0.2.0",
    buildSha256: HASH_A,
    releaseSha256: HASH_B,
    capabilityDigestSha256: HASH_C,
    centralContractSha256: HASH_D,
    networkPosture: { ...FOREGROUND_RUNTIME_BINDING.expectedNetworkPosture },
  },
  context("register", "request-register-0001"),
);
assert.equal(registered.connectorId, "gpu-lab-4090");

await service.handle(
  "heartbeat",
  {
    protocolVersion: "1.0",
    connectorId: "gpu-lab-4090",
    sessionId: registered.sessionId,
    sequence: 0,
    observedAt: NOW.toISOString(),
    state: "idle",
    capacity: { maxConcurrent: 1, availableSlots: 1 },
    gpu: {
      utilizationPercent: 0,
      vramUsedMiB: 100,
      vramTotalMiB: 24_576,
    },
  },
  context("heartbeat", "request-heartbeat-0001"),
);

const leaseRecord = {
  jobId: "job-test-0001",
  leaseId: "lease-test-0001",
  idempotencyKey: "idem-test-0001",
  modality: "video" as const,
  workflowId: "wan-official-verified",
  workflowSha256: HASH_A,
  parameterBindingSha256: HASH_B,
  allowedOutputs: [
    { nodeId: "output-node-1", slot: 0, mimeType: "video/mp4" as const },
  ],
  businessParameters: {
    prompt: "test prompt",
    negativePrompt: "",
    seed: 42,
    width: 1280,
    height: 720,
    frames: 81,
    fps: 24,
  },
  inputTickets: {},
  expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
  state: "queued" as const,
  promptIdentitySha256: HASH_C,
  progressSequence: 0,
  cancelRequested: false,
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
};
await fakeRepository.enqueueLease(leaseRecord);
resetGpuExecutionGateForTests();
const leased = await service.handle(
  "lease",
  {
    protocolVersion: "1.0",
    connectorId: "gpu-lab-4090",
    sessionId: registered.sessionId,
    sequence: 1,
  },
  context("lease", "request-lease-0001"),
);
assert.equal(leased.kind, "lease");
assert.deepEqual(
  leased.kind === "lease" ? Object.keys(leased.lease).sort() : [],
  [
    "allowedOutputs",
    "businessParameters",
    "expiresAt",
    "idempotencyKey",
    "inputTickets",
    "jobId",
    "leaseId",
    "modality",
    "parameterBindingSha256",
    "promptIdentitySha256",
    "workflowId",
    "workflowSha256",
  ].sort(),
);
assert.equal(
  leased.kind === "lease" ? leased.lease.promptIdentitySha256 : "",
  HASH_C,
);
assert.equal(
  leased.kind === "lease" && "state" in leased.lease,
  false,
);
assert.equal(currentGpuExecutionOwner()?.kind, "lan_lab");
assert.deepEqual(
  projectCoordinatorLeaseForOrdinaryUser(
    leased.kind === "lease" ? leased.lease : leaseRecord,
  ),
  {
    jobId: "job-test-0001",
    modality: "video",
    status: "remote_pending",
  },
);
assert.equal(
  JSON.stringify(projectCoordinatorLeaseForOrdinaryUser(leaseRecord)).includes(
    "prompt",
  ),
  false,
);
await service.handle(
  "acknowledge",
  {
    protocolVersion: "1.0",
    connectorId: "gpu-lab-4090",
    sessionId: registered.sessionId,
    sequence: 2,
    jobId: leaseRecord.jobId,
    leaseId: leaseRecord.leaseId,
    idempotencyKey: leaseRecord.idempotencyKey,
    promptIdentitySha256: HASH_C,
  },
  context("acknowledge", "request-ack-0001"),
);
await service.handle(
  "progress",
  {
    protocolVersion: "1.0",
    connectorId: "gpu-lab-4090",
    sessionId: registered.sessionId,
    sequence: 3,
    jobId: leaseRecord.jobId,
    leaseId: leaseRecord.leaseId,
    idempotencyKey: leaseRecord.idempotencyKey,
    promptIdentitySha256: HASH_C,
    progressSequence: 1,
    percent: 25,
    phase: "generating",
  },
  context("progress", "request-progress-0001"),
);
await fakeRepository.requestCancellation({
  jobId: leaseRecord.jobId,
  leaseId: leaseRecord.leaseId,
  cancellationId: "cancel-test-0001",
  reasonCode: "operator_request",
});
const cancelPoll = await service.handle(
  "cancel-poll",
  {
    protocolVersion: "1.0",
    connectorId: "gpu-lab-4090",
    sessionId: registered.sessionId,
    sequence: 4,
    jobId: leaseRecord.jobId,
    leaseId: leaseRecord.leaseId,
    idempotencyKey: leaseRecord.idempotencyKey,
    promptIdentitySha256: HASH_C,
  },
  context("cancel-poll", "request-cancel-poll-0001"),
);
assert.equal(cancelPoll.cancelRequested, true);
await service.handle(
  "cancelled",
  {
    protocolVersion: "1.0",
    connectorId: "gpu-lab-4090",
    sessionId: registered.sessionId,
    sequence: 5,
    jobId: leaseRecord.jobId,
    leaseId: leaseRecord.leaseId,
    idempotencyKey: leaseRecord.idempotencyKey,
    promptIdentitySha256: HASH_C,
    terminalSequence: 2,
    cancellationId: "cancel-test-0001",
  },
  context("cancelled", "request-cancelled-0001"),
);
assert.deepEqual(generationEvents, ["progress", "cancelled"]);
assert.equal(currentGpuExecutionOwner(), undefined);

const expiredLease = {
  ...leaseRecord,
  jobId: "job-expired-0001",
  leaseId: "lease-expired-0001",
  idempotencyKey: "idem-expired-0001",
  state: "running" as const,
  expiresAt: new Date(NOW.getTime() - 1_000).toISOString(),
};
const nextLease = {
  ...leaseRecord,
  jobId: "job-next-0001",
  leaseId: "lease-next-0001",
  idempotencyKey: "idem-next-0001",
  state: "queued" as const,
};
await fakeRepository.enqueueLease(expiredLease);
await fakeRepository.enqueueLease(nextLease);
assert.equal(
  tryAcquireGpuExecution({ kind: "lan_lab", jobId: expiredLease.jobId }),
  true,
);
const replacementLease = await service.handle(
  "lease",
  {
    protocolVersion: "1.0",
    connectorId: "gpu-lab-4090",
    sessionId: registered.sessionId,
    sequence: 6,
  },
  context("lease", "request-lease-after-expiry"),
);
assert.equal(replacementLease.kind, "lease");
assert.equal(
  replacementLease.kind === "lease" ? replacementLease.lease.jobId : "",
  nextLease.jobId,
);
assert.equal(currentGpuExecutionOwner()?.jobId, nextLease.jobId);
assert.equal(
  (await fakeRepository.getLease(expiredLease.jobId, expiredLease.leaseId))
    ?.terminalErrorCode,
  "lease_expired",
);
assert.equal(generationEvents.at(-1), "fail");
await fakeRepository.mutateLease(
  nextLease.jobId,
  nextLease.leaseId,
  (stored) => {
    stored.state = "failed";
    stored.terminalErrorCode = "test_cleanup";
  },
);
resetGpuExecutionGateForTests();

const studioProjection = projectLanGpuCoordinatorStudioStatus({
  ready: true,
  status: {
    mode: "lan_lab",
    state: "online",
    lastHeartbeatAt: NOW.toISOString(),
    activeJob: {
      jobId: "private-job-id",
      status: "pending",
      progress: 40,
      cancelRequested: false,
    },
    recentJobs: [],
    workflowCount: 1,
    concurrency: 1,
    speculativePrefetch: false,
  },
});
assert.equal(studioProjection.active?.progress, 40);
assert.equal(JSON.stringify(studioProjection).includes("private-job-id"), false);
assert.equal(JSON.stringify(studioProjection).includes("workflow"), false);

const privateErrorMarker = `PRIVATE_ERROR_${HASH_E}`;
const mappedPrivateError = mapCoordinatorError(new Error(privateErrorMarker));
const safeErrorDto = {
  code: mappedPrivateError.code,
  retryable: mappedPrivateError.retryable,
  status: mappedPrivateError.status,
};
const readyCapability = inspectLanGpuCoordinatorEnvironment({
  ...absoluteBaseEnv,
  AISTORY_GPU_LAN_LAB_WORKFLOW_ALLOWLIST_JSON: allowlistJson,
});
const publicSecurityProjection = JSON.stringify({
  capability: readyCapability,
  error: safeErrorDto,
  studio: studioProjection,
});
const secretFingerprint = createHash("sha256")
  .update(COORDINATOR_HMAC_TEST_VECTOR_INPUT.secretBase64)
  .digest("hex");
for (const privateMarker of [
  HASH_A,
  HASH_B,
  HASH_C,
  HASH_D,
  HASH_E,
  privateErrorMarker,
  secretFingerprint,
  COORDINATOR_HMAC_TEST_VECTOR_INPUT.secretBase64,
  absoluteBaseEnv.AISTORY_GPU_LAN_LAB_STORE_DIR,
  absoluteBaseEnv.AISTORY_GPU_LAN_LAB_COORDINATOR_ORIGIN,
  absoluteBaseEnv.AISTORY_GPU_LAN_LAB_UPLOAD_ORIGIN,
]) {
  assert.equal(publicSecurityProjection.includes(privateMarker), false);
}
const loggingSource = await Promise.all(
  [
    "connectorCompatibility.ts",
    "protocol.ts",
    "service.ts",
    "server.ts",
  ].map((name) =>
    readFile(path.join(process.cwd(), "lib", "gpu-coordinator", name), "utf8"),
  ),
);
assert.equal(
  loggingSource.some((source) => /\bconsole\.(?:debug|info|log|warn|error)\s*\(/.test(source)),
  false,
);

await assert.rejects(
  service.handle(
    "heartbeat",
    {
      protocolVersion: "1.0",
      connectorId: "gpu-lab-4090",
      sessionId: registered.sessionId,
      sequence: 5,
      observedAt: NOW.toISOString(),
      state: "idle",
      capacity: { maxConcurrent: 1, availableSlots: 1 },
      gpu: {
        utilizationPercent: 0,
        vramUsedMiB: 100,
        vramTotalMiB: 24_576,
      },
    },
    context("heartbeat", "request-order-conflict"),
  ),
  (error: unknown) =>
    error instanceof CoordinatorServiceError &&
    error.code === "operation_out_of_order",
);

const completeLease = {
  ...leaseRecord,
  jobId: "job-test-0002",
  leaseId: "lease-test-0002",
  idempotencyKey: "idem-test-0002",
  state: "queued" as const,
  cancelRequested: false,
};
await fakeRepository.enqueueLease(completeLease);
const leasedForComplete = await service.handle(
  "lease",
  {
    protocolVersion: "1.0",
    connectorId: "gpu-lab-4090",
    sessionId: registered.sessionId,
    sequence: 7,
  },
  context("lease", "request-lease-0002"),
);
assert.equal(leasedForComplete.kind, "lease");
await service.handle(
  "acknowledge",
  {
    protocolVersion: "1.0",
    connectorId: "gpu-lab-4090",
    sessionId: registered.sessionId,
    sequence: 8,
    jobId: completeLease.jobId,
    leaseId: completeLease.leaseId,
    idempotencyKey: completeLease.idempotencyKey,
    promptIdentitySha256: HASH_C,
  },
  context("acknowledge", "request-ack-0002"),
);
await service.handle(
  "progress",
  {
    protocolVersion: "1.0",
    connectorId: "gpu-lab-4090",
    sessionId: registered.sessionId,
    sequence: 9,
    jobId: completeLease.jobId,
    leaseId: completeLease.leaseId,
    idempotencyKey: completeLease.idempotencyKey,
    promptIdentitySha256: HASH_C,
    progressSequence: 1,
    percent: 90,
    phase: "uploading_output",
  },
  context("progress", "request-progress-0002"),
);
const completedArtifact = {
  mimeType: "video/mp4" as const,
  bytes: 24,
  sha256: HASH_B,
  outputNodeId: "output-node-1",
  outputSlot: 0,
};
await service.handle(
  "upload-ticket",
  {
    protocolVersion: "1.0",
    connectorId: "gpu-lab-4090",
    sessionId: registered.sessionId,
    sequence: 10,
    jobId: completeLease.jobId,
    leaseId: completeLease.leaseId,
    idempotencyKey: completeLease.idempotencyKey,
    promptIdentitySha256: HASH_C,
    artifact: completedArtifact,
  },
  context("upload-ticket", "request-ticket-0002"),
);
const completed = await service.handle(
  "complete",
  {
    protocolVersion: "1.0",
    connectorId: "gpu-lab-4090",
    sessionId: registered.sessionId,
    sequence: 11,
    jobId: completeLease.jobId,
    leaseId: completeLease.leaseId,
    idempotencyKey: completeLease.idempotencyKey,
    promptIdentitySha256: HASH_C,
    terminalSequence: 2,
    artifact: {
      mimeType: completedArtifact.mimeType,
      bytes: completedArtifact.bytes,
      sha256: completedArtifact.sha256,
    },
  },
  context("complete", "request-complete-0002"),
);
assert.equal(completed.authoritativeState, "succeeded");
assert.equal(currentGpuExecutionOwner(), undefined);

const failedLease = {
  ...leaseRecord,
  jobId: "job-test-0003",
  leaseId: "lease-test-0003",
  idempotencyKey: "idem-test-0003",
  state: "queued" as const,
  cancelRequested: false,
};
await fakeRepository.enqueueLease(failedLease);
await service.handle(
  "lease",
  {
    protocolVersion: "1.0",
    connectorId: "gpu-lab-4090",
    sessionId: registered.sessionId,
    sequence: 12,
  },
  context("lease", "request-lease-0003"),
);
await service.handle(
  "acknowledge",
  {
    protocolVersion: "1.0",
    connectorId: "gpu-lab-4090",
    sessionId: registered.sessionId,
    sequence: 13,
    jobId: failedLease.jobId,
    leaseId: failedLease.leaseId,
    idempotencyKey: failedLease.idempotencyKey,
    promptIdentitySha256: HASH_C,
  },
  context("acknowledge", "request-ack-0003"),
);
const failed = await service.handle(
  "fail",
  {
    protocolVersion: "1.0",
    connectorId: "gpu-lab-4090",
    sessionId: registered.sessionId,
    sequence: 14,
    jobId: failedLease.jobId,
    leaseId: failedLease.leaseId,
    idempotencyKey: failedLease.idempotencyKey,
    promptIdentitySha256: HASH_C,
    terminalSequence: 1,
    errorCode: "gpu_out_of_memory",
    retryable: true,
  },
  context("fail", "request-fail-0003"),
);
assert.equal(failed.authoritativeState, "failed");
assert.deepEqual(generationEvents, [
  "progress",
  "cancelled",
  "fail",
  "progress",
  "complete",
  "fail",
]);

const labRoot = await mkdtemp(path.join(os.tmpdir(), "aistory-gpu-lab-"));
const labRepository = new LanLabCoordinatorRepository(
  labRoot,
  ["coordinator.invalid"],
  "https://coordinator.invalid",
  1024 * 1024,
);
const fakeMp4 = Uint8Array.from([
  0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
  0, 0, 0, 0, 0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x32,
]);
const videoHash = createHash("sha256").update(fakeMp4).digest("hex");
const storedLease = {
  ...leaseRecord,
  jobId: "job-upload-0001",
  leaseId: "lease-upload-0001",
  state: "running" as const,
};
await labRepository.enqueueLease(storedLease);
const ticket = await labRepository.issue({
  lease: storedLease,
  artifact: {
    mimeType: "video/mp4",
    bytes: fakeMp4.byteLength,
    sha256: videoHash,
    outputNodeId: "output-node-1",
    outputSlot: 0,
  },
  now: NOW,
});
assert.equal(ticket.chunkBytes, 1024 * 1024);
assert.equal(new URL(ticket.url).hostname, "coordinator.invalid");
await labRepository.acceptUpload({
  ticketId: ticket.ticketId,
  bytes: fakeMp4,
  declaredType: "video/mp4",
  now: NOW,
});
assert.equal(
  Buffer.from(
    await labRepository.readAcceptedArtifact({
      jobId: storedLease.jobId,
      sha256: videoHash,
      bytes: fakeMp4.byteLength,
      mimeType: "video/mp4",
    }),
  ).toString("hex"),
  Buffer.from(fakeMp4).toString("hex"),
);
await assert.rejects(
  labRepository.acceptUpload({
    ticketId: ticket.ticketId,
    bytes: fakeMp4,
    declaredType: "video/mp4",
    now: NOW,
  }),
);

const input = {
  taskType: "generate" as const,
  workflowId: "ltx23-original-av-lab",
  workflowSha256: LTX_WORKFLOW_SHA,
  prompt: "A safe foreground prompt",
  seed: 40902000,
  width: 768,
  height: 480,
  frames: 81,
  fps: 24,
  projectId: 100,
  idempotencyKey: "request-job-0001",
};
await assert.rejects(
  submitLanGpuVideoJob({
    job: input,
    allowlist: [],
    repository: labRepository,
    now: NOW,
  }),
  /not allowlisted/,
);
const submitted = await submitLanGpuVideoJob({
  job: input,
  allowlist,
  repository: labRepository,
  now: NOW,
});
assert.equal(submitted.provider, "gpu-connector-lan");
assert.equal(JSON.stringify(submitted).includes(input.prompt), false);
const storedJob = await getStoredGenerationJob(submitted.id);
assert.equal(storedJob?.provider, "gpu-connector-lan");
if (!storedJob || storedJob.provider !== "gpu-connector-lan") {
  throw new Error("LAN GPU job was not stored.");
}
const mapped = mapLanGpuJobToLease(storedJob, NOW, allowlist[0]!);
assert.equal(mapped.workflowSha256, LTX_WORKFLOW_SHA);
assert.equal(mapped.businessParameters.prompt, input.prompt);
assert.equal(mapped.inputTickets && Object.keys(mapped.inputTickets).length, 0);
const submittedLease = (await labRepository.listLeases()).find(
  (item) => item.jobId === submitted.id,
);
if (!submittedLease) throw new Error("Submitted LAN GPU lease was not stored.");
const submittedTicket = await labRepository.issue({
  lease: submittedLease,
  artifact: {
    mimeType: "video/mp4",
    bytes: fakeMp4.byteLength,
    sha256: videoHash,
    outputNodeId: "21",
    outputSlot: 0,
  },
  now: NOW,
});
await labRepository.acceptUpload({
  ticketId: submittedTicket.ticketId,
  bytes: fakeMp4,
  declaredType: "video/mp4",
  now: NOW,
});
await updateStoredGenerationJob(submitted.id, (job) => {
  job.status = "succeeded";
  job.progress = 100;
  job.artifact = {
    url: `/api/aistory-cache/media/${videoHash}.mp4`,
    contentType: "video/mp4",
    bytes: fakeMp4.byteLength,
  };
});
const upscaleWorkflow = {
  workflowId: "ltx23-video-upscale-1280x800-lab",
  workflowSha256: HASH_C,
  purpose: "upscale" as const,
  modality: "video" as const,
  classification: "non_publishable" as const,
  parameterBindingSha256: HASH_B,
  fixedParameters: {
    width: 1280,
    height: 800,
    frames: 81,
    fps: 24,
    preserveAudio: true as const,
  },
  inputSlots: ["sourceVideo"] as const,
  outputSlots: [
    { nodeId: "upscale-output", slot: 0, mimeType: "video/mp4" as const },
  ],
};
const upscaled = await submitLanGpuVideoJob({
  job: {
    taskType: "upscale",
    workflowId: upscaleWorkflow.workflowId,
    workflowSha256: upscaleWorkflow.workflowSha256,
    sourceJobId: submitted.id,
    width: 1280,
    height: 800,
    frames: 81,
    fps: 24,
    preserveAudio: true,
    projectId: 100,
    idempotencyKey: "request-upscale-0001",
  },
  allowlist: [upscaleWorkflow],
  repository: labRepository,
  now: NOW,
});
const upscaleLease = (await labRepository.listLeases()).find(
  (item) => item.jobId === upscaled.id,
);
assert.equal(upscaleLease?.businessParameters.preserveAudio, true);
assert.equal(upscaleLease?.inputTickets.sourceVideo?.method, "GET");
assert.equal(upscaleLease?.inputTickets.sourceVideo?.sha256, videoHash);
const inputTicket = upscaleLease?.inputTickets.sourceVideo;
if (!inputTicket) throw new Error("Upscale source ticket was not issued.");
const downloaded = await labRepository.consumeInput({
  ticketId: inputTicket.ticketId,
  now: NOW,
});
assert.equal(downloaded.sha256, videoHash);
assert.equal(Buffer.from(downloaded.bytes).toString("hex"), Buffer.from(fakeMp4).toString("hex"));
await assert.rejects(
  labRepository.consumeInput({ ticketId: inputTicket.ticketId, now: NOW }),
);
await assert.rejects(
  adoptGenerationVideoAsset(
    {
      userId: "local-admin",
      roles: ["super_admin"],
      mode: "local",
    },
    {
      jobId: submitted.id,
      title: "LAN LAB candidate",
      idempotencyKey: "video-adopt-lab-0001",
      requestId: "request-adopt-lab-0001",
    },
    { allowTestAdapter: true },
  ),
  /非发布级/,
);

await rm(labRoot, { recursive: true, force: true });
await rm(runtimeProjectionRoot, { recursive: true, force: true });
await rm(process.env.AISTORY_GENERATION_JOB_DIR!, {
  recursive: true,
  force: true,
});

assert.equal(networkCalls, 0);
console.log("GPU coordinator LAN LAB contract tests passed.");
