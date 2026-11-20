import { createHash } from "node:crypto";

import {
  CONNECTOR_HEARTBEAT_REQUEST_STATES,
  CONNECTOR_RECONCILE_REQUEST_STATES,
  CONNECTOR_RUNNER_MODES,
  GPU_COORDINATOR_MAX_BODY_BYTES,
  GPU_COORDINATOR_OPERATIONS,
  GPU_COORDINATOR_PROTOCOL_VERSION,
  type ConnectorAcknowledgeRequest,
  type ConnectorCancelPollRequest,
  type ConnectorCancelledRequest,
  type ConnectorCompleteRequest,
  type ConnectorFailRequest,
  type ConnectorHeartbeatRequest,
  type ConnectorLeaseRequest,
  type ConnectorNetworkPosture,
  type ConnectorProgressRequest,
  type ConnectorReconcileRequest,
  type ConnectorRegistrationRequest,
  type ConnectorRenewRequest,
  type ConnectorUploadTicketRequest,
  type CoordinatorArtifactDescriptor,
  type CoordinatorAssetTicket,
  type CoordinatorLeasePayload,
  type CoordinatorOperationRequestMap,
  type GpuCoordinatorOperation,
} from "./types";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/;
const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const SEMVER_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_ERROR_PATTERN = /^[a-z][a-z0-9_]{2,79}$/;
const SAFE_PARAMETER_KEYS = new Set([
  "prompt",
  "negativePrompt",
  "seed",
  "width",
  "height",
  "frames",
  "fps",
  "preserveAudio",
  "orientation",
  "visualStyleRevision",
  "characterStateRevision",
  "referenceRevision",
]);
const MEDIA_TYPES = new Set<CoordinatorAssetTicket["mimeType"]>([
  "image/png",
  "image/jpeg",
  "image/webp",
  "video/mp4",
  "video/webm",
]);

export const GPU_COORDINATOR_ENDPOINTS: Record<
  GpuCoordinatorOperation,
  string
> = Object.fromEntries(
  GPU_COORDINATOR_OPERATIONS.map((operation) => [
    operation,
    `/api/gpu-coordinator/v1/${operation}`,
  ]),
) as Record<GpuCoordinatorOperation, string>;

export class CoordinatorProtocolError extends Error {
  constructor(
    readonly code:
      | "bad_request"
      | "idempotency_conflict"
      | "lease_expired"
      | "ticket_invalid"
      | "connector_version_unsupported",
  ) {
    super(code);
    this.name = "CoordinatorProtocolError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function strictRecord(
  value: unknown,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (!isRecord(value)) throw new CoordinatorProtocolError("bad_request");
  const allowed = new Set(allowedKeys);
  const snapshot: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new CoordinatorProtocolError("bad_request");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new CoordinatorProtocolError("bad_request");
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function strictExactRecord(
  value: unknown,
  requiredKeys: readonly string[],
): Record<string, unknown> {
  const snapshot = strictRecord(value, requiredKeys);
  if (Object.keys(snapshot).length !== requiredKeys.length) {
    throw new CoordinatorProtocolError("bad_request");
  }
  return snapshot;
}

function cleanId(value: unknown): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new CoordinatorProtocolError("bad_request");
  }
  return value;
}

function cleanNodeId(value: unknown): string {
  if (typeof value !== "string" || !NODE_ID_PATTERN.test(value)) {
    throw new CoordinatorProtocolError("bad_request");
  }
  return value;
}

function cleanHash(value: unknown): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new CoordinatorProtocolError("bad_request");
  }
  return value;
}

function cleanVersion(value: unknown): string {
  if (typeof value !== "string" || !SEMVER_PATTERN.test(value)) {
    throw new CoordinatorProtocolError("bad_request");
  }
  return value;
}

function cleanSequence(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new CoordinatorProtocolError("bad_request");
  }
  return Number(value);
}

function cleanIsoDate(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new CoordinatorProtocolError("bad_request");
  }
  return value;
}

function protocolVersion(value: unknown): typeof GPU_COORDINATOR_PROTOCOL_VERSION {
  if (value !== GPU_COORDINATOR_PROTOCOL_VERSION) {
    throw new CoordinatorProtocolError("bad_request");
  }
  return GPU_COORDINATOR_PROTOCOL_VERSION;
}

function identity(
  value: unknown,
): {
  protocolVersion: typeof GPU_COORDINATOR_PROTOCOL_VERSION;
  connectorId: string;
  sessionId: string;
  sequence: number;
  jobId: string;
  leaseId: string;
  idempotencyKey: string;
} {
  const input = strictRecord(value, [
    "protocolVersion",
    "connectorId",
    "sessionId",
    "sequence",
    "jobId",
    "leaseId",
    "idempotencyKey",
    "promptIdentitySha256",
    "progressSequence",
    "percent",
    "phase",
    "artifact",
    "terminalSequence",
    "errorCode",
    "retryable",
    "cancellationId",
  ]);
  return {
    protocolVersion: protocolVersion(input.protocolVersion),
    connectorId: cleanId(input.connectorId),
    sessionId: cleanId(input.sessionId),
    sequence: cleanSequence(input.sequence),
    jobId: cleanId(input.jobId),
    leaseId: cleanId(input.leaseId),
    idempotencyKey: cleanId(input.idempotencyKey),
  };
}

function promptIdentity(value: unknown): string {
  return cleanHash(value);
}

function artifact(value: unknown): CoordinatorArtifactDescriptor {
  const input = strictRecord(value, [
    "mimeType",
    "bytes",
    "sha256",
    "outputNodeId",
    "outputSlot",
  ]);
  if (!MEDIA_TYPES.has(input.mimeType as CoordinatorAssetTicket["mimeType"])) {
    throw new CoordinatorProtocolError("bad_request");
  }
  if (
    !Number.isSafeInteger(input.bytes) ||
    Number(input.bytes) <= 0 ||
    Number(input.bytes) > 10 * 1024 * 1024 * 1024
  ) {
    throw new CoordinatorProtocolError("bad_request");
  }
  if (
    !Number.isSafeInteger(input.outputSlot) ||
    Number(input.outputSlot) < 0 ||
    Number(input.outputSlot) > 255
  ) {
    throw new CoordinatorProtocolError("bad_request");
  }
  return {
    mimeType: input.mimeType as CoordinatorArtifactDescriptor["mimeType"],
    bytes: Number(input.bytes),
    sha256: cleanHash(input.sha256),
    outputNodeId: cleanNodeId(input.outputNodeId),
    outputSlot: Number(input.outputSlot),
  };
}

function terminalArtifact(
  value: unknown,
): Pick<CoordinatorArtifactDescriptor, "mimeType" | "bytes" | "sha256"> {
  const input = strictRecord(value, ["mimeType", "bytes", "sha256"]);
  if (!MEDIA_TYPES.has(input.mimeType as CoordinatorAssetTicket["mimeType"])) {
    throw new CoordinatorProtocolError("bad_request");
  }
  if (
    !Number.isSafeInteger(input.bytes) ||
    Number(input.bytes) <= 0 ||
    Number(input.bytes) > 10 * 1024 * 1024 * 1024
  ) {
    throw new CoordinatorProtocolError("bad_request");
  }
  return {
    mimeType: input.mimeType as CoordinatorArtifactDescriptor["mimeType"],
    bytes: Number(input.bytes),
    sha256: cleanHash(input.sha256),
  };
}

function registration(value: unknown): ConnectorRegistrationRequest {
  const input = strictExactRecord(value, [
    "protocolVersion",
    "connectorId",
    "connectorVersion",
    "buildSha256",
    "releaseSha256",
    "capabilityDigestSha256",
    "centralContractSha256",
    "networkPosture",
  ]);
  return {
    protocolVersion: protocolVersion(input.protocolVersion),
    connectorId: cleanId(input.connectorId),
    connectorVersion: cleanVersion(input.connectorVersion),
    buildSha256: cleanHash(input.buildSha256),
    releaseSha256: cleanHash(input.releaseSha256),
    capabilityDigestSha256: cleanHash(input.capabilityDigestSha256),
    centralContractSha256: cleanHash(input.centralContractSha256),
    networkPosture: networkPosture(input.networkPosture),
  };
}

function heartbeat(value: unknown): ConnectorHeartbeatRequest {
  const input = strictRecord(value, [
    "protocolVersion",
    "connectorId",
    "sessionId",
    "sequence",
    "observedAt",
    "state",
    "capacity",
    "gpu",
    "activeLease",
  ]);
  const capacity = strictRecord(input.capacity, [
    "maxConcurrent",
    "availableSlots",
  ]);
  const gpu = strictRecord(input.gpu, [
    "utilizationPercent",
    "vramUsedMiB",
    "vramTotalMiB",
  ]);
  if (
    capacity.maxConcurrent !== 1 ||
    ![0, 1].includes(Number(capacity.availableSlots))
  ) {
    throw new CoordinatorProtocolError("bad_request");
  }
  const state = String(input.state);
  if (
    !(CONNECTOR_HEARTBEAT_REQUEST_STATES as readonly string[]).includes(state)
  ) {
    throw new CoordinatorProtocolError("bad_request");
  }
  const utilization = Number(gpu.utilizationPercent);
  const used = Number(gpu.vramUsedMiB);
  const total = Number(gpu.vramTotalMiB);
  if (
    !Number.isFinite(utilization) ||
    utilization < 0 ||
    utilization > 100 ||
    !Number.isFinite(used) ||
    !Number.isFinite(total) ||
    used < 0 ||
    total <= 0 ||
    used > total
  ) {
    throw new CoordinatorProtocolError("bad_request");
  }
  let activeLease: ConnectorHeartbeatRequest["activeLease"];
  if (input.activeLease !== undefined) {
    const active = strictRecord(input.activeLease, [
      "jobId",
      "leaseId",
      "idempotencyKey",
      "promptIdentitySha256",
    ]);
    activeLease = {
      jobId: cleanId(active.jobId),
      leaseId: cleanId(active.leaseId),
      idempotencyKey: cleanId(active.idempotencyKey),
      promptIdentitySha256: cleanHash(active.promptIdentitySha256),
    };
  }
  return {
    protocolVersion: protocolVersion(input.protocolVersion),
    connectorId: cleanId(input.connectorId),
    sessionId: cleanId(input.sessionId),
    sequence: cleanSequence(input.sequence),
    observedAt: cleanIsoDate(input.observedAt),
    state: state as ConnectorHeartbeatRequest["state"],
    capacity: {
      maxConcurrent: 1,
      availableSlots: Number(capacity.availableSlots) as 0 | 1,
    },
    gpu: {
      utilizationPercent: utilization,
      vramUsedMiB: used,
      vramTotalMiB: total,
    },
    ...(activeLease ? { activeLease } : {}),
  };
}

function leaseRequest(value: unknown): ConnectorLeaseRequest {
  const input = strictRecord(value, [
    "protocolVersion",
    "connectorId",
    "sessionId",
    "sequence",
  ]);
  return {
    protocolVersion: protocolVersion(input.protocolVersion),
    connectorId: cleanId(input.connectorId),
    sessionId: cleanId(input.sessionId),
    sequence: cleanSequence(input.sequence),
  };
}

function acknowledge(value: unknown): ConnectorAcknowledgeRequest {
  const input = strictRecord(value, [
    "protocolVersion",
    "connectorId",
    "sessionId",
    "sequence",
    "jobId",
    "leaseId",
    "idempotencyKey",
    "promptIdentitySha256",
  ]);
  return {
    ...identity(input),
    promptIdentitySha256: promptIdentity(input.promptIdentitySha256),
  };
}

function renew(value: unknown): ConnectorRenewRequest {
  const input = strictRecord(value, [
    "protocolVersion",
    "connectorId",
    "sessionId",
    "sequence",
    "jobId",
    "leaseId",
    "idempotencyKey",
    "promptIdentitySha256",
    "progressSequence",
  ]);
  return {
    ...identity(input),
    promptIdentitySha256: promptIdentity(input.promptIdentitySha256),
    progressSequence: cleanSequence(input.progressSequence),
  };
}

function cancelPoll(value: unknown): ConnectorCancelPollRequest {
  const input = strictRecord(value, [
    "protocolVersion",
    "connectorId",
    "sessionId",
    "sequence",
    "jobId",
    "leaseId",
    "idempotencyKey",
    "promptIdentitySha256",
  ]);
  return {
    ...identity(input),
    promptIdentitySha256: promptIdentity(input.promptIdentitySha256),
  };
}

function networkPosture(value: unknown): ConnectorNetworkPosture {
  const input = strictExactRecord(value, [
    "productionNetworkEnabled",
    "lanLabNetworkEnabled",
    "runnerMode",
  ]);
  if (
    input.productionNetworkEnabled !== false ||
    input.lanLabNetworkEnabled !== true ||
    !(CONNECTOR_RUNNER_MODES as readonly unknown[]).includes(input.runnerMode)
  ) {
    throw new CoordinatorProtocolError("bad_request");
  }
  return {
    productionNetworkEnabled: false,
    lanLabNetworkEnabled: true,
    runnerMode: input.runnerMode as ConnectorNetworkPosture["runnerMode"],
  };
}

function progress(value: unknown): ConnectorProgressRequest {
  const input = strictRecord(value, [
    "protocolVersion",
    "connectorId",
    "sessionId",
    "sequence",
    "jobId",
    "leaseId",
    "idempotencyKey",
    "promptIdentitySha256",
    "progressSequence",
    "percent",
    "phase",
  ]);
  const percent = Number(input.percent);
  const phase = String(input.phase);
  if (
    !Number.isFinite(percent) ||
    percent < 0 ||
    percent > 100 ||
    ![
      "preparing",
      "downloading_inputs",
      "submitting",
      "generating",
      "verifying_output",
      "uploading_output",
    ].includes(phase)
  ) {
    throw new CoordinatorProtocolError("bad_request");
  }
  return {
    ...identity(input),
    promptIdentitySha256: promptIdentity(input.promptIdentitySha256),
    progressSequence: cleanSequence(input.progressSequence),
    percent,
    phase: phase as ConnectorProgressRequest["phase"],
  };
}

function uploadTicket(value: unknown): ConnectorUploadTicketRequest {
  const input = strictRecord(value, [
    "protocolVersion",
    "connectorId",
    "sessionId",
    "sequence",
    "jobId",
    "leaseId",
    "idempotencyKey",
    "promptIdentitySha256",
    "artifact",
  ]);
  return {
    ...identity(input),
    promptIdentitySha256: promptIdentity(input.promptIdentitySha256),
    artifact: artifact(input.artifact),
  };
}

function complete(value: unknown): ConnectorCompleteRequest {
  const input = strictRecord(value, [
    "protocolVersion",
    "connectorId",
    "sessionId",
    "sequence",
    "jobId",
    "leaseId",
    "idempotencyKey",
    "promptIdentitySha256",
    "terminalSequence",
    "artifact",
  ]);
  return {
    ...identity(input),
    promptIdentitySha256: promptIdentity(input.promptIdentitySha256),
    terminalSequence: cleanSequence(input.terminalSequence),
    artifact: terminalArtifact(input.artifact),
  };
}

function fail(value: unknown): ConnectorFailRequest {
  const input = strictRecord(value, [
    "protocolVersion",
    "connectorId",
    "sessionId",
    "sequence",
    "jobId",
    "leaseId",
    "idempotencyKey",
    "promptIdentitySha256",
    "terminalSequence",
    "errorCode",
    "retryable",
  ]);
  if (
    typeof input.errorCode !== "string" ||
    !SAFE_ERROR_PATTERN.test(input.errorCode) ||
    typeof input.retryable !== "boolean"
  ) {
    throw new CoordinatorProtocolError("bad_request");
  }
  return {
    ...identity(input),
    promptIdentitySha256: promptIdentity(input.promptIdentitySha256),
    terminalSequence: cleanSequence(input.terminalSequence),
    errorCode: input.errorCode,
    retryable: input.retryable,
  };
}

function cancelled(value: unknown): ConnectorCancelledRequest {
  const input = strictRecord(value, [
    "protocolVersion",
    "connectorId",
    "sessionId",
    "sequence",
    "jobId",
    "leaseId",
    "idempotencyKey",
    "promptIdentitySha256",
    "terminalSequence",
    "cancellationId",
  ]);
  return {
    ...identity(input),
    promptIdentitySha256: promptIdentity(input.promptIdentitySha256),
    terminalSequence: cleanSequence(input.terminalSequence),
    cancellationId: cleanId(input.cancellationId),
  };
}

function reconcile(value: unknown): ConnectorReconcileRequest {
  const input = strictRecord(value, [
    "protocolVersion",
    "connectorId",
    "sessionId",
    "sequence",
    "records",
  ]);
  if (
    !Array.isArray(input.records) ||
    input.records.length > 100
  ) {
    throw new CoordinatorProtocolError("bad_request");
  }
  const connectorId = cleanId(input.connectorId);
  const sessionId = cleanId(input.sessionId);
  const records = input.records.map((raw) => {
    const item = strictRecord(raw, [
      "jobId",
      "leaseId",
      "idempotencyKey",
      "workflowId",
      "workflowSha256",
      "parameterBindingSha256",
      "promptIdentitySha256",
      "modality",
      "expiresAt",
      "state",
      "artifact",
    ]);
    const state = String(item.state);
    const modality = String(item.modality);
    if (
      !(CONNECTOR_RECONCILE_REQUEST_STATES as readonly string[]).includes(
        state,
      ) ||
      !["image", "video"].includes(modality)
    ) {
      throw new CoordinatorProtocolError("bad_request");
    }
    return {
      jobId: cleanId(item.jobId),
      leaseId: cleanId(item.leaseId),
      idempotencyKey: cleanId(item.idempotencyKey),
      workflowId: cleanId(item.workflowId),
      workflowSha256: cleanHash(item.workflowSha256),
      parameterBindingSha256: cleanHash(item.parameterBindingSha256),
      promptIdentitySha256: promptIdentity(item.promptIdentitySha256),
      modality: modality as "image" | "video",
      expiresAt: cleanIsoDate(item.expiresAt),
      state: state as ConnectorReconcileRequest["records"][number]["state"],
      ...(item.artifact !== undefined
        ? { artifact: terminalArtifact(item.artifact) }
        : {}),
    };
  });
  return {
    protocolVersion: protocolVersion(input.protocolVersion),
    connectorId,
    sessionId,
    sequence: cleanSequence(input.sequence),
    records,
  };
}

const REQUEST_PARSERS: {
  [K in GpuCoordinatorOperation]: (
    value: unknown,
  ) => CoordinatorOperationRequestMap[K];
} = {
  register: registration,
  heartbeat,
  lease: leaseRequest,
  acknowledge,
  renew,
  "cancel-poll": cancelPoll,
  progress,
  "upload-ticket": uploadTicket,
  complete,
  fail,
  cancelled,
  reconcile,
};

export function isGpuCoordinatorOperation(
  value: string,
): value is GpuCoordinatorOperation {
  return (GPU_COORDINATOR_OPERATIONS as readonly string[]).includes(value);
}

export function parseCoordinatorRequest<K extends GpuCoordinatorOperation>(
  operation: K,
  value: unknown,
): CoordinatorOperationRequestMap[K] {
  return REQUEST_PARSERS[operation](value);
}

export function parseCoordinatorRequestBytes(
  bytes: Uint8Array,
): unknown {
  if (bytes.byteLength === 0 || bytes.byteLength > GPU_COORDINATOR_MAX_BODY_BYTES) {
    throw new CoordinatorProtocolError("bad_request");
  }
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CoordinatorProtocolError("bad_request");
  }
  try {
    return JSON.parse(decoded);
  } catch {
    throw new CoordinatorProtocolError("bad_request");
  }
}

export function stableCoordinatorJson(value: unknown): string {
  const canonicalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonicalize);
    if (isRecord(input)) {
      return Object.fromEntries(
        Object.keys(input)
          .sort()
          .map((key) => [key, canonicalize(input[key])]),
      );
    }
    return input;
  };
  return JSON.stringify(canonicalize(value));
}

export function coordinatorFingerprint(value: unknown): string {
  return createHash("sha256")
    .update(stableCoordinatorJson(value), "utf8")
    .digest("hex");
}

export function validateCoordinatorAssetTicket(
  value: CoordinatorAssetTicket,
  options: {
    now: Date;
    exactHosts: readonly string[];
    expectedMethod?: "GET" | "PUT";
    maxBytes?: number;
  },
): CoordinatorAssetTicket {
  const url = new URL(value.url);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hostname !== value.exactHost ||
    !options.exactHosts.includes(value.exactHost) ||
    (options.expectedMethod && value.method !== options.expectedMethod) ||
    !MEDIA_TYPES.has(value.mimeType) ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes <= 0 ||
    value.bytes > (options.maxBytes ?? 10 * 1024 * 1024 * 1024) ||
    !SHA256_PATTERN.test(value.sha256) ||
    value.checksumHeader.name !== "x-aistory-content-sha256" ||
    value.checksumHeader.value !== value.sha256 ||
    value.chunkBytes !== 1024 * 1024
  ) {
    throw new CoordinatorProtocolError("ticket_invalid");
  }
  const expiresAt = Date.parse(value.expiresAt);
  const now = options.now.getTime();
  if (
    !Number.isFinite(expiresAt) ||
    expiresAt <= now ||
    expiresAt > now + 60 * 60 * 1_000
  ) {
    throw new CoordinatorProtocolError("ticket_invalid");
  }
  return structuredClone(value);
}

export function validateCoordinatorLeasePayload(
  value: CoordinatorLeasePayload,
  now: Date,
  inputHosts: readonly string[],
): CoordinatorLeasePayload {
  cleanId(value.jobId);
  cleanId(value.leaseId);
  cleanId(value.idempotencyKey);
  cleanHash(value.promptIdentitySha256);
  cleanId(value.workflowId);
  cleanHash(value.workflowSha256);
  cleanHash(value.parameterBindingSha256);
  if (
    !Array.isArray(value.allowedOutputs) ||
    value.allowedOutputs.length === 0 ||
    value.allowedOutputs.length > 8
  ) {
    throw new CoordinatorProtocolError("bad_request");
  }
  const outputKeys = new Set<string>();
  for (const output of value.allowedOutputs) {
    const checked = strictRecord(output, ["nodeId", "slot", "mimeType"]);
    const nodeId = cleanNodeId(checked.nodeId);
    if (
      !Number.isSafeInteger(checked.slot) ||
      Number(checked.slot) < 0 ||
      Number(checked.slot) > 255 ||
      !["video/mp4", "video/webm"].includes(String(checked.mimeType))
    ) {
      throw new CoordinatorProtocolError("bad_request");
    }
    const key = `${nodeId}:${checked.slot}:${checked.mimeType}`;
    if (outputKeys.has(key)) {
      throw new CoordinatorProtocolError("bad_request");
    }
    outputKeys.add(key);
  }
  cleanIsoDate(value.expiresAt);
  if (Date.parse(value.expiresAt) <= now.getTime()) {
    throw new CoordinatorProtocolError("lease_expired");
  }
  if (value.modality !== "image" && value.modality !== "video") {
    throw new CoordinatorProtocolError("bad_request");
  }
  const parameters = strictRecord(
    value.businessParameters,
    [...SAFE_PARAMETER_KEYS],
  );
  for (const [key, parameter] of Object.entries(parameters)) {
    if (
      !["string", "number", "boolean"].includes(typeof parameter) ||
      (typeof parameter === "string" &&
        (parameter.length > (key.includes("Prompt") || key === "prompt" ? 8_000 : 256) ||
          /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(parameter))) ||
      (typeof parameter === "number" && !Number.isFinite(parameter))
    ) {
      throw new CoordinatorProtocolError("bad_request");
    }
  }
  for (const [slot, ticket] of Object.entries(value.inputTickets)) {
    if (
      !["referenceImage", "firstFrame", "lastFrame", "sourceVideo"].includes(
        slot,
      )
    ) {
      throw new CoordinatorProtocolError("ticket_invalid");
    }
    validateCoordinatorAssetTicket(ticket, {
      now,
      exactHosts: inputHosts,
      expectedMethod: "GET",
    });
  }
  return structuredClone(value);
}

export function compareConnectorVersions(
  left: string,
  right: string,
): number {
  const parse = (value: string) => {
    if (!SEMVER_PATTERN.test(value)) {
      throw new CoordinatorProtocolError("bad_request");
    }
    return value
      .split("-", 1)[0]!
      .split(".")
      .map((part) => Number(part));
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return 0;
}

export function projectCoordinatorLeaseForOrdinaryUser(
  lease: CoordinatorLeasePayload,
): {
  jobId: string;
  modality: "image" | "video";
  status: "remote_pending";
} {
  return {
    jobId: lease.jobId,
    modality: lease.modality,
    status: "remote_pending",
  };
}

export const GPU_COORDINATOR_V1_JSON_SCHEMAS = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://aistory.invalid/schemas/gpu-coordinator-v1.json",
  protocolVersion: GPU_COORDINATOR_PROTOCOL_VERSION,
  additionalProperties: false,
  operations: Object.fromEntries(
    GPU_COORDINATOR_OPERATIONS.map((operation) => [
      operation,
      {
        method: "POST",
        path: GPU_COORDINATOR_ENDPOINTS[operation],
        contentType: "application/json",
        maxBodyBytes: GPU_COORDINATOR_MAX_BODY_BYTES,
        authenticatedRequest: true,
        authenticatedResponse: true,
      },
    ]),
  ),
} as const;
