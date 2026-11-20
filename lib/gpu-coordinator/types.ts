export const GPU_COORDINATOR_PROTOCOL_VERSION = "1.0" as const;
export const GPU_COORDINATOR_MIN_CONNECTOR_VERSION = "0.2.0" as const;
export const GPU_COORDINATOR_MAX_BODY_BYTES = 128 * 1024;
export const GPU_COORDINATOR_STREAM_CHUNK_BYTES = 1024 * 1024;

export const CONNECTOR_HEARTBEAT_REQUEST_STATES = [
  "idle",
  "leased",
  "running",
  "draining",
  "recovery_required",
  "revoked",
] as const;

export const CONNECTOR_RECONCILE_REQUEST_STATES = [
  "received",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export const CENTRAL_RECONCILE_AUTHORITATIVE_STATES = [
  "offered",
  "acknowledged",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "unknown",
] as const;

export const CONNECTOR_RUNNER_MODES = [
  "no_work_only",
  "foreground_once",
] as const;

export const GPU_COORDINATOR_OPERATIONS = [
  "register",
  "heartbeat",
  "lease",
  "acknowledge",
  "renew",
  "cancel-poll",
  "progress",
  "upload-ticket",
  "complete",
  "fail",
  "cancelled",
  "reconcile",
] as const;

export type GpuCoordinatorOperation =
  (typeof GPU_COORDINATOR_OPERATIONS)[number];

export type CoordinatorErrorCode =
  | "artifact_invalid"
  | "bad_request"
  | "connector_not_allowed"
  | "connector_revoked"
  | "connector_version_unsupported"
  | "coordinator_unavailable"
  | "hmac_replay_rejected"
  | "hmac_signature_invalid"
  | "idempotency_conflict"
  | "lease_expired"
  | "lease_identity_mismatch"
  | "operation_out_of_order"
  | "request_stale"
  | "session_invalid"
  | "state_recovery_requires_operator"
  | "ticket_invalid"
  | "workflow_not_allowed";

export type CoordinatorError = {
  code: CoordinatorErrorCode;
  retryable: boolean;
  correlationId: string;
};

export type CoordinatorControl = {
  revoked: boolean;
  minimumConnectorVersion: string;
  currentKeyId: string;
  acceptedKeyIds: string[];
  previousKeyValidUntil?: string;
};

export type CoordinatorResponseEnvelope<T = unknown> = {
  protocolVersion: typeof GPU_COORDINATOR_PROTOCOL_VERSION;
  requestId: string;
  serverTime: string;
  sequence: number;
  ok: boolean;
  control: CoordinatorControl;
  data?: T;
  error?: CoordinatorError;
};

export type ConnectorState =
  (typeof CONNECTOR_HEARTBEAT_REQUEST_STATES)[number];

export type ConnectorRunnerMode = (typeof CONNECTOR_RUNNER_MODES)[number];

export type ConnectorNetworkPosture = {
  productionNetworkEnabled: false;
  lanLabNetworkEnabled: true;
  runnerMode: ConnectorRunnerMode;
};

export type ConnectorRegistrationRequest = {
  protocolVersion: typeof GPU_COORDINATOR_PROTOCOL_VERSION;
  connectorId: string;
  connectorVersion: string;
  buildSha256: string;
  releaseSha256: string;
  capabilityDigestSha256: string;
  centralContractSha256: string;
  networkPosture: ConnectorNetworkPosture;
};

export type ConnectorRegistrationResponse = {
  connectorId: string;
  sessionId: string;
  heartbeatIntervalMs: number;
  leasePollIntervalMs: number;
  leaseDurationMs: number;
  clockSkewWindowSeconds: number;
};

export type ConnectorActiveLeaseIdentity = {
  jobId: string;
  leaseId: string;
  idempotencyKey: string;
  promptIdentitySha256: string;
};

export type ConnectorHeartbeatRequest = {
  protocolVersion: typeof GPU_COORDINATOR_PROTOCOL_VERSION;
  connectorId: string;
  sessionId: string;
  sequence: number;
  observedAt: string;
  state: ConnectorState;
  capacity: {
    maxConcurrent: 1;
    availableSlots: 0 | 1;
  };
  gpu: {
    utilizationPercent: number;
    vramUsedMiB: number;
    vramTotalMiB: number;
  };
  activeLease?: ConnectorActiveLeaseIdentity;
};

export type ConnectorHeartbeatResponse = {
  acceptedSequence: number;
  nextHeartbeatAfterMs: number;
  shouldDrain: boolean;
};

export type CoordinatorAssetTicket = {
  ticketId: string;
  url: string;
  exactHost: string;
  method: "GET" | "PUT";
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "video/mp4" | "video/webm";
  bytes: number;
  sha256: string;
  expiresAt: string;
  checksumHeader: {
    name: "x-aistory-content-sha256";
    value: string;
  };
  chunkBytes: typeof GPU_COORDINATOR_STREAM_CHUNK_BYTES;
};

export type CoordinatorLeasePayload = {
  jobId: string;
  leaseId: string;
  idempotencyKey: string;
  promptIdentitySha256: string;
  modality: "image" | "video";
  workflowId: string;
  workflowSha256: string;
  parameterBindingSha256: string;
  allowedOutputs: Array<{
    nodeId: string;
    slot: number;
    mimeType: "video/mp4" | "video/webm";
  }>;
  businessParameters: Record<string, string | number | boolean>;
  inputTickets: Partial<
    Record<
      "referenceImage" | "firstFrame" | "lastFrame" | "sourceVideo",
      CoordinatorAssetTicket
    >
  >;
  expiresAt: string;
};

export type ConnectorLeaseRequest = {
  protocolVersion: typeof GPU_COORDINATOR_PROTOCOL_VERSION;
  connectorId: string;
  sessionId: string;
  sequence: number;
};

export type ConnectorLeaseResponse =
  | {
      kind: "no_work";
      nextPollAfterMs: number;
      reason:
        | "queue_empty"
        | "capacity_busy"
        | "connector_draining"
        | "runner_mode_no_work_only";
    }
  | {
      kind: "lease";
      lease: CoordinatorLeasePayload;
    };

export type ConnectorLeaseIdentityRequest = {
  protocolVersion: typeof GPU_COORDINATOR_PROTOCOL_VERSION;
  connectorId: string;
  sessionId: string;
  sequence: number;
  jobId: string;
  leaseId: string;
  idempotencyKey: string;
};

export type ConnectorAcknowledgeRequest = ConnectorLeaseIdentityRequest & {
  promptIdentitySha256: string;
};

export type ConnectorAcknowledgeResponse = {
  acknowledged: true;
  expiresAt: string;
};

export type ConnectorRenewRequest = ConnectorLeaseIdentityRequest & {
  promptIdentitySha256: string;
  progressSequence: number;
};

export type ConnectorRenewResponse = {
  renewed: true;
  previousExpiresAt: string;
  expiresAt: string;
};

export type ConnectorCancelPollRequest = ConnectorLeaseIdentityRequest & {
  promptIdentitySha256: string;
};

export type ConnectorCancelPollResponse = {
  cancelRequested: boolean;
  cancellationId?: string;
  reasonCode?: string;
  nextPollAfterMs: number;
};

export type ConnectorProgressPhase =
  | "preparing"
  | "downloading_inputs"
  | "submitting"
  | "generating"
  | "verifying_output"
  | "uploading_output";

export type ConnectorProgressRequest = ConnectorLeaseIdentityRequest & {
  promptIdentitySha256: string;
  progressSequence: number;
  percent: number;
  phase: ConnectorProgressPhase;
};

export type ConnectorProgressResponse = {
  acceptedSequence: number;
  cancelRequested: boolean;
};

export type CoordinatorArtifactDescriptor = {
  mimeType: CoordinatorAssetTicket["mimeType"];
  bytes: number;
  sha256: string;
  outputNodeId: string;
  outputSlot: number;
};

export type ConnectorUploadTicketRequest = ConnectorLeaseIdentityRequest & {
  promptIdentitySha256: string;
  artifact: CoordinatorArtifactDescriptor;
};

export type ConnectorUploadTicketResponse = {
  ticket: CoordinatorAssetTicket;
};

export type ConnectorCompleteRequest = ConnectorLeaseIdentityRequest & {
  promptIdentitySha256: string;
  terminalSequence: number;
  artifact: Pick<
    CoordinatorArtifactDescriptor,
    "mimeType" | "bytes" | "sha256"
  >;
};

export type ConnectorFailRequest = ConnectorLeaseIdentityRequest & {
  promptIdentitySha256: string;
  terminalSequence: number;
  errorCode: string;
  retryable: boolean;
};

export type ConnectorCancelledRequest = ConnectorLeaseIdentityRequest & {
  promptIdentitySha256: string;
  terminalSequence: number;
  cancellationId: string;
};

export type ConnectorTerminalResponse = {
  accepted: true;
  authoritativeState: "succeeded" | "failed" | "cancelled";
};

export type ConnectorReconcileRecord = {
  jobId: string;
  leaseId: string;
  idempotencyKey: string;
  workflowId: string;
  workflowSha256: string;
  parameterBindingSha256: string;
  promptIdentitySha256: string;
  modality: "image" | "video";
  expiresAt: string;
  state: (typeof CONNECTOR_RECONCILE_REQUEST_STATES)[number];
  artifact?: Pick<
    CoordinatorArtifactDescriptor,
    "mimeType" | "bytes" | "sha256"
  >;
};

export type ConnectorReconcileRequest = {
  protocolVersion: typeof GPU_COORDINATOR_PROTOCOL_VERSION;
  connectorId: string;
  sessionId: string;
  sequence: number;
  records: ConnectorReconcileRecord[];
};

export type ConnectorReconcileResponse = {
  records: Array<{
    jobId: string;
    leaseId: string;
    authoritativeState:
      (typeof CENTRAL_RECONCILE_AUTHORITATIVE_STATES)[number];
    reportTerminal: boolean;
    resubmit: false;
  }>;
};

export type CoordinatorOperationRequestMap = {
  register: ConnectorRegistrationRequest;
  heartbeat: ConnectorHeartbeatRequest;
  lease: ConnectorLeaseRequest;
  acknowledge: ConnectorAcknowledgeRequest;
  renew: ConnectorRenewRequest;
  "cancel-poll": ConnectorCancelPollRequest;
  progress: ConnectorProgressRequest;
  "upload-ticket": ConnectorUploadTicketRequest;
  complete: ConnectorCompleteRequest;
  fail: ConnectorFailRequest;
  cancelled: ConnectorCancelledRequest;
  reconcile: ConnectorReconcileRequest;
};

export type CoordinatorOperationResponseMap = {
  register: ConnectorRegistrationResponse;
  heartbeat: ConnectorHeartbeatResponse;
  lease: ConnectorLeaseResponse;
  acknowledge: ConnectorAcknowledgeResponse;
  renew: ConnectorRenewResponse;
  "cancel-poll": ConnectorCancelPollResponse;
  progress: ConnectorProgressResponse;
  "upload-ticket": ConnectorUploadTicketResponse;
  complete: ConnectorTerminalResponse;
  fail: ConnectorTerminalResponse;
  cancelled: ConnectorTerminalResponse;
  reconcile: ConnectorReconcileResponse;
};

export type StoredCoordinatorConnector = {
  connectorId: string;
  connectorVersion: string;
  buildSha256: string;
  releaseSha256: string;
  capabilityDigestSha256: string;
  centralContractSha256: string;
  networkPosture: ConnectorNetworkPosture;
  sessionId: string;
  status: "active" | "draining" | "revoked";
  firstHeartbeatAccepted: boolean;
  lastHeartbeatSequence: number;
  lastSeenAt: string;
};

export type CoordinatorLeaseState =
  | "queued"
  | "offered"
  | "acknowledged"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type StoredCoordinatorLease = CoordinatorLeasePayload & {
  connectorId?: string;
  state: CoordinatorLeaseState;
  progressSequence: number;
  terminalSequence?: number;
  cancelRequested: boolean;
  cancellationId?: string;
  cancellationReasonCode?: string;
  uploadArtifact?: CoordinatorArtifactDescriptor;
  terminalArtifact?: Pick<
    CoordinatorArtifactDescriptor,
    "mimeType" | "bytes" | "sha256"
  >;
  terminalErrorCode?: string;
  createdAt: string;
  updatedAt: string;
};

export type CoordinatorRequestContext = {
  operation: GpuCoordinatorOperation;
  requestId: string;
  keyId: string;
  now: Date;
};
