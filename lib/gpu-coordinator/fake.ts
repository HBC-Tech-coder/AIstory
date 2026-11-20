import { randomUUID } from "node:crypto";

import { CoordinatorProtocolError } from "./protocol";
import type {
  CoordinatorClock,
  CoordinatorIdSource,
  CoordinatorIdempotentResult,
  CoordinatorUploadTicketIssuer,
  GpuCoordinatorRepository,
} from "./ports";
import {
  GPU_COORDINATOR_STREAM_CHUNK_BYTES,
  type CoordinatorArtifactDescriptor,
  type CoordinatorAssetTicket,
  type StoredCoordinatorConnector,
  type StoredCoordinatorLease,
} from "./types";

type IdempotencyEntry = {
  fingerprint: string;
  value: unknown;
};

type PendingIdempotencyEntry = {
  fingerprint: string;
  promise: Promise<unknown>;
};

export class SystemCoordinatorClock implements CoordinatorClock {
  now(): Date {
    return new Date();
  }
}

export class RandomCoordinatorIdSource implements CoordinatorIdSource {
  next(prefix: "session" | "lease" | "ticket" | "correlation"): string {
    return `${prefix}-${randomUUID()}`;
  }
}

export class FakeGpuCoordinatorRepository
  implements GpuCoordinatorRepository
{
  private readonly nonces = new Map<string, number>();
  private readonly idempotency = new Map<string, IdempotencyEntry>();
  private readonly pendingIdempotency = new Map<
    string,
    PendingIdempotencyEntry
  >();
  private readonly connectors = new Map<string, StoredCoordinatorConnector>();
  private readonly leases = new Map<string, StoredCoordinatorLease>();
  private writeQueue = Promise.resolve();

  private async locked<T>(operation: () => Promise<T> | T): Promise<T> {
    const previous = this.writeQueue;
    let release!: () => void;
    this.writeQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async consume(
    keyId: string,
    nonce: string,
    expiresAt: Date,
    now: Date,
  ): Promise<boolean> {
    return this.locked(() => {
      const nowMs = now.getTime();
      for (const [key, expiry] of this.nonces) {
        if (expiry < nowMs) this.nonces.delete(key);
      }
      const key = `${keyId}:${nonce}`;
      if (this.nonces.has(key)) return false;
      this.nonces.set(key, expiresAt.getTime());
      return true;
    });
  }

  async runIdempotent<T>(
    scope: string,
    requestId: string,
    fingerprint: string,
    operation: () => Promise<T> | T,
  ): Promise<CoordinatorIdempotentResult<T>> {
    const key = `${scope}:${requestId}`;
    let resolvePending: ((value: unknown) => void) | undefined;
    let rejectPending: ((reason: unknown) => void) | undefined;
    const state = await this.locked(() => {
      const existing = this.idempotency.get(key);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          throw new CoordinatorProtocolError("idempotency_conflict");
        }
        return {
          kind: "stored" as const,
          result: {
            value: structuredClone(existing.value) as T,
            replayed: true,
          },
        };
      }
      const pending = this.pendingIdempotency.get(key);
      if (pending) {
        if (pending.fingerprint !== fingerprint) {
          throw new CoordinatorProtocolError("idempotency_conflict");
        }
        return {
          kind: "pending" as const,
          promise: pending.promise as Promise<T>,
        };
      }
      const promise = new Promise<unknown>((resolve, reject) => {
        resolvePending = resolve;
        rejectPending = reject;
      });
      void promise.catch(() => undefined);
      this.pendingIdempotency.set(key, { fingerprint, promise });
      return { kind: "owner" as const };
    });

    if (state.kind === "stored") return state.result;
    if (state.kind === "pending") {
      return {
        value: structuredClone(await state.promise),
        replayed: true,
      };
    }

    try {
      const value = await operation();
      const cloned = structuredClone(value);
      await this.locked(() => {
        this.idempotency.set(key, { fingerprint, value: cloned });
        this.pendingIdempotency.delete(key);
      });
      resolvePending?.(structuredClone(cloned));
      return { value: structuredClone(cloned), replayed: false };
    } catch (error) {
      await this.locked(() => {
        this.pendingIdempotency.delete(key);
      });
      rejectPending?.(error);
      throw error;
    }
  }

  async getConnector(
    connectorId: string,
  ): Promise<StoredCoordinatorConnector | undefined> {
    const connector = this.connectors.get(connectorId);
    return connector ? structuredClone(connector) : undefined;
  }

  async saveConnector(
    connector: StoredCoordinatorConnector,
  ): Promise<StoredCoordinatorConnector> {
    return this.locked(() => {
      this.connectors.set(connector.connectorId, structuredClone(connector));
      return structuredClone(connector);
    });
  }

  async mutateConnector(
    connectorId: string,
    mutation: (
      connector: StoredCoordinatorConnector,
    ) => void,
  ): Promise<StoredCoordinatorConnector> {
    return this.locked(() => {
      const connector = this.connectors.get(connectorId);
      if (!connector) throw new CoordinatorProtocolError("bad_request");
      mutation(connector);
      this.connectors.set(connectorId, connector);
      return structuredClone(connector);
    });
  }

  async claimLease(input: {
    connectorId: string;
    now: Date;
    leaseDurationMs: number;
  }): Promise<
    | { kind: "lease"; lease: StoredCoordinatorLease }
    | { kind: "no_work"; reason: "queue_empty" | "capacity_busy" }
  > {
    return this.locked(() => {
      const active = [...this.leases.values()].find(
        (lease) =>
          ["offered", "acknowledged", "running"].includes(lease.state) &&
          Date.parse(lease.expiresAt) > input.now.getTime(),
      );
      if (active) return { kind: "no_work", reason: "capacity_busy" };
      const queued = [...this.leases.values()]
        .filter((lease) => lease.state === "queued")
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
      if (!queued) return { kind: "no_work", reason: "queue_empty" };
      queued.connectorId = input.connectorId;
      queued.state = "offered";
      queued.expiresAt = new Date(
        input.now.getTime() + input.leaseDurationMs,
      ).toISOString();
      queued.updatedAt = input.now.toISOString();
      this.leases.set(queued.jobId, queued);
      return { kind: "lease", lease: structuredClone(queued) };
    });
  }

  async getLease(
    jobId: string,
    leaseId: string,
  ): Promise<StoredCoordinatorLease | undefined> {
    const lease = this.leases.get(jobId);
    return lease?.leaseId === leaseId ? structuredClone(lease) : undefined;
  }

  async mutateLease(
    jobId: string,
    leaseId: string,
    mutation: (lease: StoredCoordinatorLease) => void,
  ): Promise<StoredCoordinatorLease> {
    return this.locked(() => {
      const lease = this.leases.get(jobId);
      if (!lease || lease.leaseId !== leaseId) {
        throw new CoordinatorProtocolError("bad_request");
      }
      mutation(lease);
      this.leases.set(jobId, lease);
      return structuredClone(lease);
    });
  }

  async enqueueLease(lease: StoredCoordinatorLease): Promise<void> {
    await this.locked(() => {
      const existing = this.leases.get(lease.jobId);
      if (existing) {
        if (
          existing.idempotencyKey !== lease.idempotencyKey ||
          existing.workflowSha256 !== lease.workflowSha256
        ) {
          throw new CoordinatorProtocolError("bad_request");
        }
        return;
      }
      this.leases.set(lease.jobId, structuredClone(lease));
    });
  }

  async requestCancellation(input: {
    jobId: string;
    leaseId: string;
    cancellationId: string;
    reasonCode: string;
  }): Promise<StoredCoordinatorLease> {
    return this.mutateLease(input.jobId, input.leaseId, (lease) => {
      lease.cancelRequested = true;
      lease.cancellationId = input.cancellationId;
      lease.cancellationReasonCode = input.reasonCode;
      lease.updatedAt = new Date().toISOString();
    });
  }

  async listLeases(): Promise<StoredCoordinatorLease[]> {
    return [...this.leases.values()].map((lease) => structuredClone(lease));
  }

  async revokeConnector(
    connectorId: string,
  ): Promise<StoredCoordinatorConnector | undefined> {
    return this.locked(() => {
      const connector = this.connectors.get(connectorId);
      if (!connector) return undefined;
      connector.status = "revoked";
      this.connectors.set(connectorId, connector);
      return structuredClone(connector);
    });
  }
}

export class FakeCoordinatorUploadTicketIssuer
  implements CoordinatorUploadTicketIssuer
{
  readonly exactUploadHosts = ["uploads.invalid"] as const;

  constructor(
    private readonly idSource: CoordinatorIdSource,
    private readonly ttlMs = 10 * 60 * 1_000,
  ) {}

  async issue(input: {
    lease: StoredCoordinatorLease;
    artifact: CoordinatorArtifactDescriptor;
    now: Date;
  }): Promise<CoordinatorAssetTicket> {
    const ticketId = this.idSource.next("ticket");
    return {
      ticketId,
      url: `https://uploads.invalid/v1/${encodeURIComponent(
        ticketId,
      )}?fake=1`,
      exactHost: "uploads.invalid",
      method: "PUT",
      mimeType: input.artifact.mimeType,
      bytes: input.artifact.bytes,
      sha256: input.artifact.sha256,
      expiresAt: new Date(input.now.getTime() + this.ttlMs).toISOString(),
      checksumHeader: {
        name: "x-aistory-content-sha256",
        value: input.artifact.sha256,
      },
      chunkBytes: GPU_COORDINATOR_STREAM_CHUNK_BYTES,
    };
  }
}
