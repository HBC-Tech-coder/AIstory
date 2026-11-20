import "server-only";

import {
  currentGpuExecutionOwner,
  releaseGpuExecution,
  transferGpuExecution,
  tryAcquireGpuExecution,
} from "@/lib/generation-jobs/executionGate";

import {
  registrationMatchesRuntimeBinding,
  storedConnectorMatchesRuntimeBinding,
  type GpuConnectorRuntimeBinding,
} from "./connectorCompatibility";
import {
  compareConnectorVersions,
  coordinatorFingerprint,
  CoordinatorProtocolError,
  validateCoordinatorAssetTicket,
} from "./protocol";
import type {
  CoordinatorClock,
  CoordinatorGenerationJobPort,
  CoordinatorIdSource,
  CoordinatorUploadTicketIssuer,
  GpuCoordinatorRepository,
} from "./ports";
import {
  CENTRAL_RECONCILE_AUTHORITATIVE_STATES,
  GPU_COORDINATOR_MIN_CONNECTOR_VERSION,
  GPU_COORDINATOR_PROTOCOL_VERSION,
  type ConnectorAcknowledgeRequest,
  type ConnectorCancelPollRequest,
  type ConnectorCancelledRequest,
  type ConnectorCompleteRequest,
  type ConnectorFailRequest,
  type ConnectorHeartbeatRequest,
  type ConnectorLeaseIdentityRequest,
  type ConnectorLeaseRequest,
  type ConnectorProgressRequest,
  type ConnectorReconcileRequest,
  type ConnectorRegistrationRequest,
  type ConnectorRenewRequest,
  type ConnectorUploadTicketRequest,
  type CoordinatorControl,
  type CoordinatorErrorCode,
  type CoordinatorOperationRequestMap,
  type CoordinatorOperationResponseMap,
  type CoordinatorRequestContext,
  type GpuCoordinatorOperation,
  type StoredCoordinatorConnector,
  type StoredCoordinatorLease,
} from "./types";

export class CoordinatorServiceError extends Error {
  constructor(
    readonly code: CoordinatorErrorCode,
    readonly retryable = false,
    readonly status = 409,
  ) {
    super(code);
    this.name = "CoordinatorServiceError";
  }
}

type CoordinatorServiceOptions = {
  repository: GpuCoordinatorRepository;
  ticketIssuer: CoordinatorUploadTicketIssuer;
  clock: CoordinatorClock;
  idSource: CoordinatorIdSource;
  generationJobs?: CoordinatorGenerationJobPort;
  allowedConnectorId: string;
  minimumConnectorVersion?: string;
  currentKeyId: string;
  acceptedKeyIds?: readonly string[];
  heartbeatIntervalMs?: number;
  leasePollIntervalMs?: number;
  leaseDurationMs?: number;
  runtimeBinding: GpuConnectorRuntimeBinding;
};

function assertLeaseIdentity(
  lease: StoredCoordinatorLease | undefined,
  request: ConnectorLeaseIdentityRequest,
  now: Date,
): StoredCoordinatorLease {
  if (
    !lease ||
    lease.connectorId !== request.connectorId ||
    lease.idempotencyKey !== request.idempotencyKey
  ) {
    throw new CoordinatorServiceError("lease_identity_mismatch");
  }
  if (
    !["succeeded", "failed", "cancelled"].includes(lease.state) &&
    Date.parse(lease.expiresAt) <= now.getTime()
  ) {
    releaseGpuExecution({ kind: "lan_lab", jobId: lease.jobId });
    throw new CoordinatorServiceError("lease_expired", true);
  }
  return lease;
}

function assertPromptIdentity(
  lease: StoredCoordinatorLease,
  promptIdentitySha256: string,
): void {
  if (
    lease.promptIdentitySha256 &&
    lease.promptIdentitySha256 !== promptIdentitySha256
  ) {
    throw new CoordinatorServiceError("lease_identity_mismatch");
  }
}

function assertOperationState(
  lease: StoredCoordinatorLease,
  states: StoredCoordinatorLease["state"][],
): void {
  if (!states.includes(lease.state)) {
    throw new CoordinatorServiceError("operation_out_of_order");
  }
}

function artifactMatches(
  left: { mimeType: string; bytes: number; sha256: string } | undefined,
  right: { mimeType: string; bytes: number; sha256: string },
): boolean {
  return Boolean(
    left &&
      left.mimeType === right.mimeType &&
      left.bytes === right.bytes &&
      left.sha256 === right.sha256,
  );
}

function projectLeasePayload(
  lease: StoredCoordinatorLease,
): CoordinatorOperationResponseMap["lease"] {
  return {
    kind: "lease",
    lease: {
      jobId: lease.jobId,
      leaseId: lease.leaseId,
      idempotencyKey: lease.idempotencyKey,
      promptIdentitySha256: lease.promptIdentitySha256,
      modality: lease.modality,
      workflowId: lease.workflowId,
      workflowSha256: lease.workflowSha256,
      parameterBindingSha256: lease.parameterBindingSha256,
      allowedOutputs: lease.allowedOutputs.map((output) => ({ ...output })),
      businessParameters: { ...lease.businessParameters },
      inputTickets: structuredClone(lease.inputTickets),
      expiresAt: lease.expiresAt,
    },
  };
}

export class GpuCoordinatorService {
  private readonly minimumConnectorVersion: string;
  private readonly heartbeatIntervalMs: number;
  private readonly leasePollIntervalMs: number;
  private readonly leaseDurationMs: number;

  constructor(private readonly options: CoordinatorServiceOptions) {
    this.minimumConnectorVersion =
      options.minimumConnectorVersion ?? GPU_COORDINATOR_MIN_CONNECTOR_VERSION;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;
    this.leasePollIntervalMs = options.leasePollIntervalMs ?? 3_000;
    this.leaseDurationMs = options.leaseDurationMs ?? 120_000;
  }

  control(revoked = false): CoordinatorControl {
    return {
      revoked,
      minimumConnectorVersion: this.minimumConnectorVersion,
      currentKeyId: this.options.currentKeyId,
      acceptedKeyIds: [
        ...new Set(
          this.options.acceptedKeyIds ?? [this.options.currentKeyId],
        ),
      ],
    };
  }

  private assertCurrentConnectorRequest(
    connector: StoredCoordinatorConnector | undefined,
    operation: Exclude<GpuCoordinatorOperation, "register">,
    request: CoordinatorOperationRequestMap[
      Exclude<GpuCoordinatorOperation, "register">
    ],
    identity: {
      connectorId: string;
      sessionId: string;
      sequence: number;
    },
  ): asserts connector is StoredCoordinatorConnector {
    if (
      !connector ||
      !storedConnectorMatchesRuntimeBinding(
        connector,
        this.options.runtimeBinding,
      )
    ) {
      throw new CoordinatorServiceError("connector_not_allowed", false, 403);
    }
    if (
      connector.sessionId !== identity.sessionId ||
      connector.status === "revoked"
    ) {
      throw new CoordinatorServiceError(
        connector.status === "revoked"
          ? "connector_revoked"
          : "session_invalid",
        false,
        403,
      );
    }
    if (!connector.firstHeartbeatAccepted) {
      const firstHeartbeat = request as ConnectorHeartbeatRequest;
      if (
        operation !== "heartbeat" ||
        identity.sequence !== 0 ||
        firstHeartbeat.state !== "idle"
      ) {
        throw new CoordinatorServiceError("operation_out_of_order");
      }
    }
    if (
      connector.networkPosture.runnerMode === "no_work_only" &&
      !["heartbeat", "lease", "reconcile"].includes(operation)
    ) {
      throw new CoordinatorServiceError("operation_out_of_order");
    }
  }

  async handle<K extends GpuCoordinatorOperation>(
    operation: K,
    request: CoordinatorOperationRequestMap[K],
    context: CoordinatorRequestContext,
  ): Promise<CoordinatorOperationResponseMap[K]> {
    if (operation === "register") {
      return (await this.register(
        request as ConnectorRegistrationRequest,
        context,
      )) as CoordinatorOperationResponseMap[K];
    }
    const identity = request as CoordinatorOperationRequestMap[
      Exclude<GpuCoordinatorOperation, "register">
    ] & {
      connectorId: string;
      sessionId: string;
      sequence: number;
    };
    if (identity.connectorId !== this.options.allowedConnectorId) {
      throw new CoordinatorServiceError("connector_not_allowed", false, 403);
    }
    const currentConnector = await this.options.repository.getConnector(
      identity.connectorId,
    );
    this.assertCurrentConnectorRequest(
      currentConnector,
      operation as Exclude<GpuCoordinatorOperation, "register">,
      request as CoordinatorOperationRequestMap[
        Exclude<GpuCoordinatorOperation, "register">
      ],
      identity,
    );
    const result = await this.options.repository.runIdempotent(
      `connector:${identity.connectorId}`,
      context.requestId,
      coordinatorFingerprint({ operation, request }),
      async () => {
        const connector = await this.options.repository.mutateConnector(
          identity.connectorId,
          (stored) => {
            this.assertCurrentConnectorRequest(
              stored,
              operation as Exclude<GpuCoordinatorOperation, "register">,
              request as CoordinatorOperationRequestMap[
                Exclude<GpuCoordinatorOperation, "register">
              ],
              identity,
            );
            if (!stored.firstHeartbeatAccepted) {
              stored.firstHeartbeatAccepted = true;
            }
            if (identity.sequence <= stored.lastHeartbeatSequence) {
              throw new CoordinatorServiceError("operation_out_of_order");
            }
            stored.lastHeartbeatSequence = identity.sequence;
            stored.lastSeenAt = context.now.toISOString();
          },
        );
        return this.dispatch(
          operation as Exclude<GpuCoordinatorOperation, "register">,
          request as CoordinatorOperationRequestMap[
            Exclude<GpuCoordinatorOperation, "register">
          ],
          context,
          connector,
        );
      },
    );
    return result.value as CoordinatorOperationResponseMap[K];
  }

  private async register(
    request: ConnectorRegistrationRequest,
    context: CoordinatorRequestContext,
  ): Promise<CoordinatorOperationResponseMap["register"]> {
    if (request.connectorId !== this.options.allowedConnectorId) {
      throw new CoordinatorServiceError("connector_not_allowed", false, 403);
    }
    const compatibility = registrationMatchesRuntimeBinding(
      request,
      this.options.runtimeBinding,
    );
    if (compatibility === "identity_mismatch") {
      throw new CoordinatorServiceError(
        "connector_version_unsupported",
        false,
        426,
      );
    }
    if (compatibility === "posture_mismatch") {
      throw new CoordinatorServiceError("connector_not_allowed", false, 403);
    }
    if (
      compareConnectorVersions(
        request.connectorVersion,
        this.minimumConnectorVersion,
      ) < 0
    ) {
      throw new CoordinatorServiceError(
        "connector_version_unsupported",
        false,
        426,
      );
    }
    const result = await this.options.repository.runIdempotent(
      `register:${request.connectorId}`,
      context.requestId,
      coordinatorFingerprint(request),
      async () => {
        const existing = await this.options.repository.getConnector(
          request.connectorId,
        );
        if (existing?.status === "revoked") {
          throw new CoordinatorServiceError("connector_revoked", false, 403);
        }
        const connector: StoredCoordinatorConnector = {
          connectorId: request.connectorId,
          connectorVersion: request.connectorVersion,
          buildSha256: request.buildSha256,
          releaseSha256: request.releaseSha256,
          capabilityDigestSha256: request.capabilityDigestSha256,
          centralContractSha256: request.centralContractSha256,
          networkPosture: { ...request.networkPosture },
          sessionId: this.options.idSource.next("session"),
          status: existing?.status ?? "active",
          firstHeartbeatAccepted: false,
          lastHeartbeatSequence: -1,
          lastSeenAt: context.now.toISOString(),
        };
        await this.options.repository.saveConnector(connector);
        return {
          connectorId: connector.connectorId,
          sessionId: connector.sessionId,
          heartbeatIntervalMs: this.heartbeatIntervalMs,
          leasePollIntervalMs: this.leasePollIntervalMs,
          leaseDurationMs: this.leaseDurationMs,
          clockSkewWindowSeconds: 300,
        };
      },
    );
    return result.value;
  }

  private async dispatch(
    operation: Exclude<GpuCoordinatorOperation, "register">,
    request: CoordinatorOperationRequestMap[
      Exclude<GpuCoordinatorOperation, "register">
    ],
    context: CoordinatorRequestContext,
    connector: StoredCoordinatorConnector,
  ): Promise<unknown> {
    switch (operation) {
      case "heartbeat":
        return {
          acceptedSequence: (request as ConnectorHeartbeatRequest).sequence,
          nextHeartbeatAfterMs: this.heartbeatIntervalMs,
          shouldDrain: connector.status === "draining",
        };
      case "lease":
        return (await this.lease(
          request as ConnectorLeaseRequest,
          context,
          connector,
        ));
      case "acknowledge":
        return (await this.acknowledge(
          request as ConnectorAcknowledgeRequest,
          context,
        ));
      case "renew":
        return (await this.renew(
          request as ConnectorRenewRequest,
          context,
        ));
      case "cancel-poll":
        return (await this.cancelPoll(
          request as ConnectorCancelPollRequest,
          context,
        ));
      case "progress":
        return (await this.progress(
          request as ConnectorProgressRequest,
          context,
        ));
      case "upload-ticket":
        return (await this.uploadTicket(
          request as ConnectorUploadTicketRequest,
          context,
        ));
      case "complete":
        return (await this.complete(
          request as ConnectorCompleteRequest,
          context,
        ));
      case "fail":
        return (await this.fail(
          request as ConnectorFailRequest,
          context,
        ));
      case "cancelled":
        return (await this.cancelled(
          request as ConnectorCancelledRequest,
          context,
        ));
      case "reconcile":
        return (await this.reconcile(
          request as ConnectorReconcileRequest,
        ));
    }
  }

  private async lease(
    _request: ConnectorLeaseRequest,
    context: CoordinatorRequestContext,
    connector: StoredCoordinatorConnector,
  ): Promise<CoordinatorOperationResponseMap["lease"]> {
    if (connector.networkPosture.runnerMode === "no_work_only") {
      return {
        kind: "no_work",
        nextPollAfterMs: this.leasePollIntervalMs,
        reason: "runner_mode_no_work_only",
      };
    }
    if (connector.status === "draining") {
      return {
        kind: "no_work",
        nextPollAfterMs: this.leasePollIntervalMs,
        reason: "connector_draining",
      };
    }
    await this.releaseExpiredCapacity(context.now);
    const reservationId = `lease-pending:${context.requestId}`;
    if (!tryAcquireGpuExecution({ kind: "lan_lab", jobId: reservationId })) {
      return {
        kind: "no_work",
        nextPollAfterMs: this.leasePollIntervalMs,
        reason: "capacity_busy",
      };
    }
    const claimed = await this.options.repository.claimLease({
      connectorId: connector.connectorId,
      now: context.now,
      leaseDurationMs: this.leaseDurationMs,
    });
    if (claimed.kind === "no_work") {
      releaseGpuExecution({ kind: "lan_lab", jobId: reservationId });
      return {
        kind: "no_work",
        nextPollAfterMs: this.leasePollIntervalMs,
        reason: claimed.reason,
      };
    }
    if (
      !transferGpuExecution(
        { kind: "lan_lab", jobId: reservationId },
        { kind: "lan_lab", jobId: claimed.lease.jobId },
      )
    ) {
      throw new CoordinatorServiceError("coordinator_unavailable", true, 503);
    }
    return projectLeasePayload(claimed.lease);
  }

  private async releaseExpiredCapacity(now: Date): Promise<void> {
    const owner = currentGpuExecutionOwner();
    if (
      owner?.kind !== "lan_lab" ||
      owner.jobId.startsWith("lease-pending:")
    ) {
      return;
    }
    const lease = (await this.options.repository.listLeases()).find(
      (item) => item.jobId === owner.jobId,
    );
    if (
      lease &&
      !["succeeded", "failed", "cancelled"].includes(lease.state) &&
      Date.parse(lease.expiresAt) > now.getTime()
    ) {
      return;
    }
    try {
      if (
        lease &&
        ["offered", "acknowledged", "running"].includes(lease.state)
      ) {
        await this.options.generationJobs?.fail({
          jobId: lease.jobId,
          errorCode: "lease_expired",
          retryable: true,
        });
        await this.options.repository.mutateLease(
          lease.jobId,
          lease.leaseId,
          (stored) => {
            stored.state = "failed";
            stored.terminalErrorCode = "lease_expired";
            stored.updatedAt = now.toISOString();
          },
        );
      }
    } finally {
      releaseGpuExecution(owner);
    }
  }

  private async loadLease(
    request: ConnectorLeaseIdentityRequest,
    context: CoordinatorRequestContext,
  ): Promise<StoredCoordinatorLease> {
    return assertLeaseIdentity(
      await this.options.repository.getLease(request.jobId, request.leaseId),
      request,
      context.now,
    );
  }

  private async acknowledge(
    request: ConnectorAcknowledgeRequest,
    context: CoordinatorRequestContext,
  ): Promise<CoordinatorOperationResponseMap["acknowledge"]> {
    const lease = await this.loadLease(request, context);
    assertOperationState(lease, ["offered", "acknowledged"]);
    assertPromptIdentity(lease, request.promptIdentitySha256);
    const updated = await this.options.repository.mutateLease(
      lease.jobId,
      lease.leaseId,
      (stored) => {
        stored.state = "acknowledged";
        stored.promptIdentitySha256 = request.promptIdentitySha256;
        stored.updatedAt = context.now.toISOString();
      },
    );
    return { acknowledged: true, expiresAt: updated.expiresAt };
  }

  private async renew(
    request: ConnectorRenewRequest,
    context: CoordinatorRequestContext,
  ): Promise<CoordinatorOperationResponseMap["renew"]> {
    const lease = await this.loadLease(request, context);
    assertOperationState(lease, ["acknowledged", "running"]);
    assertPromptIdentity(lease, request.promptIdentitySha256);
    if (request.progressSequence < lease.progressSequence) {
      throw new CoordinatorServiceError("operation_out_of_order");
    }
    const previousExpiresAt = lease.expiresAt;
    const updated = await this.options.repository.mutateLease(
      lease.jobId,
      lease.leaseId,
      (stored) => {
        stored.expiresAt = new Date(
          context.now.getTime() + this.leaseDurationMs,
        ).toISOString();
        stored.progressSequence = request.progressSequence;
        stored.updatedAt = context.now.toISOString();
      },
    );
    return {
      renewed: true,
      previousExpiresAt,
      expiresAt: updated.expiresAt,
    };
  }

  private async cancelPoll(
    request: ConnectorCancelPollRequest,
    context: CoordinatorRequestContext,
  ): Promise<CoordinatorOperationResponseMap["cancel-poll"]> {
    const lease = await this.loadLease(request, context);
    assertPromptIdentity(lease, request.promptIdentitySha256);
    return {
      cancelRequested: lease.cancelRequested,
      ...(lease.cancellationId
        ? { cancellationId: lease.cancellationId }
        : {}),
      ...(lease.cancellationReasonCode
        ? { reasonCode: lease.cancellationReasonCode }
        : {}),
      nextPollAfterMs: this.leasePollIntervalMs,
    };
  }

  private async progress(
    request: ConnectorProgressRequest,
    context: CoordinatorRequestContext,
  ): Promise<CoordinatorOperationResponseMap["progress"]> {
    const lease = await this.loadLease(request, context);
    assertOperationState(lease, ["acknowledged", "running"]);
    assertPromptIdentity(lease, request.promptIdentitySha256);
    if (request.progressSequence <= lease.progressSequence) {
      throw new CoordinatorServiceError("operation_out_of_order");
    }
    const updated = await this.options.repository.mutateLease(
      lease.jobId,
      lease.leaseId,
      (stored) => {
        stored.state = "running";
        stored.progressSequence = request.progressSequence;
        stored.updatedAt = context.now.toISOString();
      },
    );
    await this.options.generationJobs?.progress({
      jobId: lease.jobId,
      percent: request.percent,
      phase: request.phase,
    });
    return {
      acceptedSequence: updated.progressSequence,
      cancelRequested: updated.cancelRequested,
    };
  }

  private async uploadTicket(
    request: ConnectorUploadTicketRequest,
    context: CoordinatorRequestContext,
  ): Promise<CoordinatorOperationResponseMap["upload-ticket"]> {
    const lease = await this.loadLease(request, context);
    assertOperationState(lease, ["running"]);
    assertPromptIdentity(lease, request.promptIdentitySha256);
    const allowedOutput = lease.allowedOutputs.some(
      (output) =>
        output.nodeId === request.artifact.outputNodeId &&
        output.slot === request.artifact.outputSlot &&
        output.mimeType === request.artifact.mimeType,
    );
    if (!allowedOutput) {
      throw new CoordinatorServiceError("artifact_invalid");
    }
    const ticket = validateCoordinatorAssetTicket(
      await this.options.ticketIssuer.issue({
        lease,
        artifact: request.artifact,
        now: context.now,
      }),
      {
        now: context.now,
        exactHosts: this.options.ticketIssuer.exactUploadHosts,
        expectedMethod: "PUT",
      },
    );
    await this.options.repository.mutateLease(
      lease.jobId,
      lease.leaseId,
      (stored) => {
        stored.uploadArtifact = structuredClone(request.artifact);
        stored.updatedAt = context.now.toISOString();
      },
    );
    return { ticket };
  }

  private async complete(
    request: ConnectorCompleteRequest,
    context: CoordinatorRequestContext,
  ): Promise<CoordinatorOperationResponseMap["complete"]> {
    const lease = await this.loadLease(request, context);
    if (lease.state === "succeeded") {
      return { accepted: true, authoritativeState: "succeeded" };
    }
    assertOperationState(lease, ["running"]);
    assertPromptIdentity(lease, request.promptIdentitySha256);
    if (
      !artifactMatches(lease.uploadArtifact, request.artifact) ||
      request.terminalSequence <= lease.progressSequence
    ) {
      throw new CoordinatorServiceError("artifact_invalid");
    }
    await this.options.generationJobs?.complete({
      jobId: lease.jobId,
      artifact: {
        ...request.artifact,
        outputNodeId: lease.uploadArtifact!.outputNodeId,
        outputSlot: lease.uploadArtifact!.outputSlot,
      },
    });
    await this.options.repository.mutateLease(
      lease.jobId,
      lease.leaseId,
      (stored) => {
        stored.state = "succeeded";
        stored.terminalSequence = request.terminalSequence;
        stored.terminalArtifact = structuredClone(request.artifact);
        stored.updatedAt = context.now.toISOString();
      },
    );
    releaseGpuExecution({ kind: "lan_lab", jobId: lease.jobId });
    return { accepted: true, authoritativeState: "succeeded" };
  }

  private async fail(
    request: ConnectorFailRequest,
    context: CoordinatorRequestContext,
  ): Promise<CoordinatorOperationResponseMap["fail"]> {
    const lease = await this.loadLease(request, context);
    if (lease.state === "failed") {
      return { accepted: true, authoritativeState: "failed" };
    }
    assertOperationState(lease, ["acknowledged", "running"]);
    assertPromptIdentity(lease, request.promptIdentitySha256);
    await this.options.generationJobs?.fail({
      jobId: lease.jobId,
      errorCode: request.errorCode,
      retryable: request.retryable,
    });
    await this.options.repository.mutateLease(
      lease.jobId,
      lease.leaseId,
      (stored) => {
        stored.state = "failed";
        stored.terminalSequence = request.terminalSequence;
        stored.terminalErrorCode = request.errorCode;
        stored.updatedAt = context.now.toISOString();
      },
    );
    releaseGpuExecution({ kind: "lan_lab", jobId: lease.jobId });
    return { accepted: true, authoritativeState: "failed" };
  }

  private async cancelled(
    request: ConnectorCancelledRequest,
    context: CoordinatorRequestContext,
  ): Promise<CoordinatorOperationResponseMap["cancelled"]> {
    const lease = await this.loadLease(request, context);
    if (lease.state === "cancelled") {
      return { accepted: true, authoritativeState: "cancelled" };
    }
    assertOperationState(lease, ["acknowledged", "running"]);
    assertPromptIdentity(lease, request.promptIdentitySha256);
    if (
      !lease.cancelRequested ||
      lease.cancellationId !== request.cancellationId
    ) {
      throw new CoordinatorServiceError("operation_out_of_order");
    }
    await this.options.generationJobs?.cancelled({ jobId: lease.jobId });
    await this.options.repository.mutateLease(
      lease.jobId,
      lease.leaseId,
      (stored) => {
        stored.state = "cancelled";
        stored.terminalSequence = request.terminalSequence;
        stored.updatedAt = context.now.toISOString();
      },
    );
    releaseGpuExecution({ kind: "lan_lab", jobId: lease.jobId });
    return { accepted: true, authoritativeState: "cancelled" };
  }

  private async reconcile(
    request: ConnectorReconcileRequest,
  ): Promise<CoordinatorOperationResponseMap["reconcile"]> {
    const records = await Promise.all(
      request.records.map(async (record) => {
        const lease = await this.options.repository.getLease(
          record.jobId,
          record.leaseId,
        );
        if (
          lease &&
          (
            lease.idempotencyKey !== record.idempotencyKey ||
            lease.workflowId !== record.workflowId ||
            lease.workflowSha256 !== record.workflowSha256 ||
            lease.parameterBindingSha256 !== record.parameterBindingSha256 ||
            lease.promptIdentitySha256 !== record.promptIdentitySha256 ||
            lease.modality !== record.modality ||
            lease.expiresAt !== record.expiresAt
          )
        ) {
          throw new CoordinatorServiceError("lease_identity_mismatch");
        }
        const authoritativeState =
          lease &&
          (CENTRAL_RECONCILE_AUTHORITATIVE_STATES as readonly string[]).includes(
            lease.state,
          )
            ? (lease.state as CoordinatorOperationResponseMap["reconcile"]["records"][number]["authoritativeState"])
            : "unknown";
        return {
          jobId: record.jobId,
          leaseId: record.leaseId,
          authoritativeState,
          reportTerminal: Boolean(
            lease &&
              ["succeeded", "failed", "cancelled"].includes(record.state) &&
              !["succeeded", "failed", "cancelled"].includes(lease.state),
          ),
          resubmit: false as const,
        };
      }),
    );
    return { records };
  }

  status(): {
    activeOwner?: ReturnType<typeof currentGpuExecutionOwner>;
  } {
    return { activeOwner: currentGpuExecutionOwner() };
  }
}

export function mapCoordinatorError(error: unknown): CoordinatorServiceError {
  if (error instanceof CoordinatorServiceError) return error;
  if (error instanceof CoordinatorProtocolError) {
    return new CoordinatorServiceError(error.code, false, 400);
  }
  return new CoordinatorServiceError("coordinator_unavailable", true, 503);
}

export const GPU_COORDINATOR_SERVICE_PROTOCOL =
  GPU_COORDINATOR_PROTOCOL_VERSION;
