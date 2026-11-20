import type { CoordinatorReplayGuard } from "./hmac";
import type {
  CoordinatorArtifactDescriptor,
  CoordinatorAssetTicket,
  CoordinatorLeasePayload,
  CoordinatorLeaseState,
  StoredCoordinatorConnector,
  StoredCoordinatorLease,
} from "./types";

export type CoordinatorIdempotentResult<T> = {
  value: T;
  replayed: boolean;
};

export interface GpuCoordinatorRepository extends CoordinatorReplayGuard {
  runIdempotent<T>(
    scope: string,
    requestId: string,
    fingerprint: string,
    operation: () => Promise<T> | T,
  ): Promise<CoordinatorIdempotentResult<T>>;

  getConnector(
    connectorId: string,
  ): Promise<StoredCoordinatorConnector | undefined>;

  saveConnector(
    connector: StoredCoordinatorConnector,
  ): Promise<StoredCoordinatorConnector>;

  mutateConnector(
    connectorId: string,
    mutation: (
      connector: StoredCoordinatorConnector,
    ) => void,
  ): Promise<StoredCoordinatorConnector>;

  claimLease(input: {
    connectorId: string;
    now: Date;
    leaseDurationMs: number;
  }): Promise<
    | { kind: "lease"; lease: StoredCoordinatorLease }
    | { kind: "no_work"; reason: "queue_empty" | "capacity_busy" }
  >;

  getLease(
    jobId: string,
    leaseId: string,
  ): Promise<StoredCoordinatorLease | undefined>;

  mutateLease(
    jobId: string,
    leaseId: string,
    mutation: (lease: StoredCoordinatorLease) => void,
  ): Promise<StoredCoordinatorLease>;

  enqueueLease(lease: StoredCoordinatorLease): Promise<void>;

  requestCancellation(input: {
    jobId: string;
    leaseId: string;
    cancellationId: string;
    reasonCode: string;
  }): Promise<StoredCoordinatorLease>;

  listLeases(): Promise<StoredCoordinatorLease[]>;

  revokeConnector(
    connectorId: string,
  ): Promise<StoredCoordinatorConnector | undefined>;
}

export interface CoordinatorUploadTicketIssuer {
  readonly exactUploadHosts: readonly string[];

  issue(input: {
    lease: StoredCoordinatorLease;
    artifact: CoordinatorArtifactDescriptor;
    now: Date;
  }): Promise<CoordinatorAssetTicket>;
}

export interface CoordinatorClock {
  now(): Date;
}

export interface CoordinatorIdSource {
  next(prefix: "session" | "lease" | "ticket" | "correlation"): string;
}

export interface CoordinatorDispatchPort {
  enqueue(input: {
    lease: CoordinatorLeasePayload;
    state?: Extract<CoordinatorLeaseState, "queued">;
  }): Promise<void>;
}

export interface CoordinatorGenerationJobPort {
  progress(input: {
    jobId: string;
    percent: number;
    phase: string;
  }): Promise<void>;
  complete(input: {
    jobId: string;
    artifact: CoordinatorArtifactDescriptor;
  }): Promise<void>;
  fail(input: {
    jobId: string;
    errorCode: string;
    retryable: boolean;
  }): Promise<void>;
  cancelled(input: {
    jobId: string;
  }): Promise<void>;
}

export type CoordinatorTransportResult = {
  status: number;
  headers: Headers;
  body: Uint8Array;
};

export interface CoordinatorTransport {
  dispatch(input: {
    method: string;
    path: string;
    headers: Headers;
    body: Uint8Array;
  }): Promise<CoordinatorTransportResult>;
}
