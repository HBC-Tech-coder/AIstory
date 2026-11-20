import "server-only";

import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { validateVideoBytes } from "@/lib/video-assets/validation";

import { CoordinatorProtocolError } from "./protocol";
import type {
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

type StoredIdempotency = {
  key: string;
  fingerprint: string;
  value: unknown;
};

type StoredNonce = {
  key: string;
  expiresAt: string;
};

type StoredUploadTicket = {
  ticket: CoordinatorAssetTicket;
  jobId: string;
  leaseId: string;
  direction?: "upload" | "download";
  sourceJobId?: string;
  consumed: boolean;
  storageFile?: string;
};

type LabCoordinatorStore = {
  schemaVersion: 1;
  connectors: StoredCoordinatorConnector[];
  leases: StoredCoordinatorLease[];
  idempotency: StoredIdempotency[];
  nonces: StoredNonce[];
  tickets: StoredUploadTicket[];
};

type PendingIdempotency = {
  fingerprint: string;
  promise: Promise<unknown>;
};

const SAFE_TICKET_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/;

function emptyStore(): LabCoordinatorStore {
  return {
    schemaVersion: 1,
    connectors: [],
    leases: [],
    idempotency: [],
    nonces: [],
    tickets: [],
  };
}

export class LanLabCoordinatorRepository
  implements GpuCoordinatorRepository, CoordinatorUploadTicketIssuer
{
  private mutationQueue = Promise.resolve();
  private readonly pendingIdempotency = new Map<string, PendingIdempotency>();

  constructor(
    readonly rootDir: string,
    readonly exactUploadHosts: readonly string[],
    private readonly publicOrigin: string,
    private readonly maxVideoBytes: number,
    private readonly ticketTtlMs = 10 * 60 * 1_000,
  ) {}

  private targetFile(): string {
    return path.join(
      /* turbopackIgnore: true */ this.rootDir,
      "coordinator.json",
    );
  }

  private backupFile(): string {
    return path.join(
      /* turbopackIgnore: true */ this.rootDir,
      "coordinator.previous.json",
    );
  }

  mediaDir(): string {
    return path.join(/* turbopackIgnore: true */ this.rootDir, "media");
  }

  private async parseFile(file: string): Promise<LabCoordinatorStore> {
    const parsed = JSON.parse(
      await readFile(/* turbopackIgnore: true */ file, "utf8"),
    ) as LabCoordinatorStore;
    if (
      parsed.schemaVersion !== 1 ||
      !Array.isArray(parsed.connectors) ||
      !Array.isArray(parsed.leases) ||
      !Array.isArray(parsed.idempotency) ||
      !Array.isArray(parsed.nonces) ||
      !Array.isArray(parsed.tickets)
    ) {
      throw new Error("Unsupported LAN LAB coordinator store schema.");
    }
    return parsed;
  }

  private async readStore(): Promise<LabCoordinatorStore> {
    let firstError: unknown;
    for (const file of [this.targetFile(), this.backupFile()]) {
      try {
        return await this.parseFile(file);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (
      firstError &&
      typeof firstError === "object" &&
      "code" in firstError &&
      firstError.code === "ENOENT"
    ) {
      return emptyStore();
    }
    throw firstError;
  }

  private async writeStore(store: LabCoordinatorStore): Promise<void> {
    await mkdir(/* turbopackIgnore: true */ this.rootDir, {
      recursive: true,
    });
    const target = this.targetFile();
    const backup = this.backupFile();
    const temp = path.join(
      /* turbopackIgnore: true */ this.rootDir,
      `.coordinator-${process.pid}-${Date.now()}-${Math.random()
        .toString(16)
        .slice(2)}.tmp`,
    );
    let movedPrimary = false;
    try {
      await writeFile(
        /* turbopackIgnore: true */ temp,
        JSON.stringify(store, null, 2),
        {
          encoding: "utf8",
          flag: "wx",
        },
      );
      await unlink(/* turbopackIgnore: true */ backup).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        },
      );
      await rename(
        /* turbopackIgnore: true */ target,
        /* turbopackIgnore: true */ backup,
      )
        .then(() => {
          movedPrimary = true;
        })
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      await rename(
        /* turbopackIgnore: true */ temp,
        /* turbopackIgnore: true */ target,
      );
    } catch (error) {
      await unlink(/* turbopackIgnore: true */ temp).catch(() => undefined);
      if (movedPrimary) {
        await rename(
          /* turbopackIgnore: true */ backup,
          /* turbopackIgnore: true */ target,
        ).catch(() => undefined);
      }
      throw error;
    }
  }

  private async mutate<T>(
    operation: (store: LabCoordinatorStore) => Promise<T> | T,
  ): Promise<T> {
    let release: (() => void) | undefined;
    const previous = this.mutationQueue;
    this.mutationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const store = await this.readStore();
      const result = await operation(store);
      await this.writeStore(store);
      return result;
    } finally {
      release?.();
    }
  }

  async consume(
    keyId: string,
    nonce: string,
    expiresAt: Date,
    now: Date,
  ): Promise<boolean> {
    return this.mutate((store) => {
      store.nonces = store.nonces.filter(
        (item) => Date.parse(item.expiresAt) >= now.getTime(),
      );
      const key = `${keyId}:${nonce}`;
      if (store.nonces.some((item) => item.key === key)) return false;
      store.nonces.push({ key, expiresAt: expiresAt.toISOString() });
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
    const existing = (await this.readStore()).idempotency.find(
      (item) => item.key === key,
    );
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new CoordinatorProtocolError("idempotency_conflict");
      }
      return {
        value: structuredClone(existing.value) as T,
        replayed: true,
      };
    }
    const pending = this.pendingIdempotency.get(key);
    if (pending) {
      if (pending.fingerprint !== fingerprint) {
        throw new CoordinatorProtocolError("idempotency_conflict");
      }
      return {
        value: structuredClone(await pending.promise) as T,
        replayed: true,
      };
    }
    let resolvePending!: (value: unknown) => void;
    let rejectPending!: (reason: unknown) => void;
    const promise = new Promise<unknown>((resolve, reject) => {
      resolvePending = resolve;
      rejectPending = reject;
    });
    void promise.catch(() => undefined);
    this.pendingIdempotency.set(key, { fingerprint, promise });
    try {
      const value = await operation();
      const result = await this.mutate((store) => {
        const replay = store.idempotency.find((item) => item.key === key);
        if (replay) {
          if (replay.fingerprint !== fingerprint) {
            throw new CoordinatorProtocolError("idempotency_conflict");
          }
          return {
            value: structuredClone(replay.value) as T,
            replayed: true,
          };
        }
        store.idempotency.push({
          key,
          fingerprint,
          value: structuredClone(value),
        });
        return { value: structuredClone(value), replayed: false };
      });
      resolvePending(structuredClone(result.value));
      return result;
    } catch (error) {
      rejectPending(error);
      throw error;
    } finally {
      this.pendingIdempotency.delete(key);
    }
  }

  async getConnector(
    connectorId: string,
  ): Promise<StoredCoordinatorConnector | undefined> {
    const value = (await this.readStore()).connectors.find(
      (item) => item.connectorId === connectorId,
    );
    return value ? structuredClone(value) : undefined;
  }

  async saveConnector(
    connector: StoredCoordinatorConnector,
  ): Promise<StoredCoordinatorConnector> {
    return this.mutate((store) => {
      const index = store.connectors.findIndex(
        (item) => item.connectorId === connector.connectorId,
      );
      if (index >= 0) store.connectors[index] = structuredClone(connector);
      else store.connectors.push(structuredClone(connector));
      return structuredClone(connector);
    });
  }

  async mutateConnector(
    connectorId: string,
    mutation: (connector: StoredCoordinatorConnector) => void,
  ): Promise<StoredCoordinatorConnector> {
    return this.mutate((store) => {
      const connector = store.connectors.find(
        (item) => item.connectorId === connectorId,
      );
      if (!connector) throw new CoordinatorProtocolError("bad_request");
      mutation(connector);
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
    return this.mutate((store) => {
      const active = store.leases.find(
        (lease) =>
          ["offered", "acknowledged", "running"].includes(lease.state) &&
          Date.parse(lease.expiresAt) > input.now.getTime(),
      );
      if (active) return { kind: "no_work", reason: "capacity_busy" };
      const queued = store.leases
        .filter((lease) => lease.state === "queued")
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
      if (!queued) return { kind: "no_work", reason: "queue_empty" };
      queued.connectorId = input.connectorId;
      queued.state = "offered";
      queued.expiresAt = new Date(
        input.now.getTime() + input.leaseDurationMs,
      ).toISOString();
      queued.updatedAt = input.now.toISOString();
      return { kind: "lease", lease: structuredClone(queued) };
    });
  }

  async getLease(
    jobId: string,
    leaseId: string,
  ): Promise<StoredCoordinatorLease | undefined> {
    const value = (await this.readStore()).leases.find(
      (item) => item.jobId === jobId && item.leaseId === leaseId,
    );
    return value ? structuredClone(value) : undefined;
  }

  async mutateLease(
    jobId: string,
    leaseId: string,
    mutation: (lease: StoredCoordinatorLease) => void,
  ): Promise<StoredCoordinatorLease> {
    return this.mutate((store) => {
      const lease = store.leases.find(
        (item) => item.jobId === jobId && item.leaseId === leaseId,
      );
      if (!lease) throw new CoordinatorProtocolError("bad_request");
      mutation(lease);
      return structuredClone(lease);
    });
  }

  async enqueueLease(lease: StoredCoordinatorLease): Promise<void> {
    await this.mutate((store) => {
      const existing = store.leases.find((item) => item.jobId === lease.jobId);
      if (existing) {
        if (
          existing.idempotencyKey !== lease.idempotencyKey ||
          existing.workflowSha256 !== lease.workflowSha256
        ) {
          throw new CoordinatorProtocolError("idempotency_conflict");
        }
        return;
      }
      store.leases.push(structuredClone(lease));
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
    return (await this.readStore()).leases.map((item) => structuredClone(item));
  }

  async revokeConnector(
    connectorId: string,
  ): Promise<StoredCoordinatorConnector | undefined> {
    const current = await this.getConnector(connectorId);
    if (!current) return undefined;
    return this.mutateConnector(connectorId, (connector) => {
      connector.status = "revoked";
    });
  }

  async issue(input: {
    lease: StoredCoordinatorLease;
    artifact: CoordinatorArtifactDescriptor;
    now: Date;
  }): Promise<CoordinatorAssetTicket> {
    if (
      !["video/mp4", "video/webm"].includes(input.artifact.mimeType) ||
      input.artifact.bytes > this.maxVideoBytes
    ) {
      throw new CoordinatorProtocolError("ticket_invalid");
    }
    const ticketId = `ticket-${createHash("sha256")
      .update(
        `${input.lease.jobId}:${input.lease.leaseId}:${input.artifact.sha256}`,
      )
      .digest("hex")
      .slice(0, 40)}`;
    const exactHost = this.exactUploadHosts[0]!;
    const ticket: CoordinatorAssetTicket = {
      ticketId,
      url: `${this.publicOrigin}/api/gpu-coordinator/v1/artifacts/${encodeURIComponent(
        ticketId,
      )}`,
      exactHost,
      method: "PUT",
      mimeType: input.artifact.mimeType,
      bytes: input.artifact.bytes,
      sha256: input.artifact.sha256,
      expiresAt: new Date(input.now.getTime() + this.ticketTtlMs).toISOString(),
      checksumHeader: {
        name: "x-aistory-content-sha256",
        value: input.artifact.sha256,
      },
      chunkBytes: GPU_COORDINATOR_STREAM_CHUNK_BYTES,
    };
    await this.mutate((store) => {
      const existing = store.tickets.find(
        (item) => item.ticket.ticketId === ticketId,
      );
      if (existing) return;
      store.tickets.push({
        ticket,
        jobId: input.lease.jobId,
        leaseId: input.lease.leaseId,
        direction: "upload",
        consumed: false,
      });
    });
    return ticket;
  }

  async issueInput(input: {
    sourceJobId: string;
    targetLease: StoredCoordinatorLease;
    now: Date;
  }): Promise<CoordinatorAssetTicket> {
    const source = (await this.readStore()).tickets.find(
      (item) =>
        item.jobId === input.sourceJobId &&
        item.ticket.method === "PUT" &&
        item.consumed &&
        item.storageFile,
    );
    if (!source?.storageFile || input.sourceJobId === input.targetLease.jobId) {
      throw new CoordinatorProtocolError("ticket_invalid");
    }
    const mediaDir = path.resolve(/* turbopackIgnore: true */ this.mediaDir());
    const resolved = path.resolve(
      /* turbopackIgnore: true */ mediaDir,
      source.storageFile,
    );
    if (!resolved.startsWith(`${mediaDir}${path.sep}`)) {
      throw new CoordinatorProtocolError("ticket_invalid");
    }
    const bytes = await readFile(/* turbopackIgnore: true */ resolved);
    if (
      bytes.byteLength !== source.ticket.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== source.ticket.sha256
    ) {
      throw new CoordinatorProtocolError("ticket_invalid");
    }
    const ticketId = `input-${createHash("sha256")
      .update(
        `${input.sourceJobId}:${input.targetLease.jobId}:${input.targetLease.leaseId}:${source.ticket.sha256}`,
      )
      .digest("hex")
      .slice(0, 40)}`;
    const exactHost = this.exactUploadHosts[0]!;
    const ticket: CoordinatorAssetTicket = {
      ticketId,
      url: `${this.publicOrigin}/api/gpu-coordinator/v1/artifacts/${encodeURIComponent(
        ticketId,
      )}`,
      exactHost,
      method: "GET",
      mimeType: source.ticket.mimeType,
      bytes: source.ticket.bytes,
      sha256: source.ticket.sha256,
      expiresAt: new Date(input.now.getTime() + this.ticketTtlMs).toISOString(),
      checksumHeader: {
        name: "x-aistory-content-sha256",
        value: source.ticket.sha256,
      },
      chunkBytes: GPU_COORDINATOR_STREAM_CHUNK_BYTES,
    };
    await this.mutate((store) => {
      if (store.tickets.some((item) => item.ticket.ticketId === ticketId)) {
        return;
      }
      store.tickets.push({
        ticket,
        jobId: input.targetLease.jobId,
        leaseId: input.targetLease.leaseId,
        direction: "download",
        sourceJobId: input.sourceJobId,
        consumed: false,
        storageFile: source.storageFile,
      });
    });
    return ticket;
  }

  async consumeInput(input: {
    ticketId: string;
    now: Date;
  }): Promise<{
    bytes: Uint8Array;
    contentType: "video/mp4" | "video/webm";
    sha256: string;
  }> {
    const record = (await this.readStore()).tickets.find(
      (item) => item.ticket.ticketId === input.ticketId,
    );
    if (
      !record?.storageFile ||
      record.ticket.method !== "GET" ||
      record.direction !== "download" ||
      record.consumed ||
      Date.parse(record.ticket.expiresAt) <= input.now.getTime() ||
      !["video/mp4", "video/webm"].includes(record.ticket.mimeType)
    ) {
      throw new CoordinatorProtocolError("ticket_invalid");
    }
    const mediaDir = path.resolve(/* turbopackIgnore: true */ this.mediaDir());
    const resolved = path.resolve(
      /* turbopackIgnore: true */ mediaDir,
      record.storageFile,
    );
    if (!resolved.startsWith(`${mediaDir}${path.sep}`)) {
      throw new CoordinatorProtocolError("ticket_invalid");
    }
    const bytes = await readFile(/* turbopackIgnore: true */ resolved);
    if (
      bytes.byteLength !== record.ticket.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== record.ticket.sha256
    ) {
      throw new CoordinatorProtocolError("ticket_invalid");
    }
    await this.mutate((store) => {
      const stored = store.tickets.find(
        (item) => item.ticket.ticketId === input.ticketId,
      );
      if (!stored || stored.consumed || stored.ticket.method !== "GET") {
        throw new CoordinatorProtocolError("ticket_invalid");
      }
      stored.consumed = true;
    });
    return {
      bytes,
      contentType: record.ticket.mimeType as "video/mp4" | "video/webm",
      sha256: record.ticket.sha256,
    };
  }

  async acceptUpload(input: {
    ticketId: string;
    bytes: Uint8Array;
    declaredType: string;
    now: Date;
  }): Promise<{ sha256: string; bytes: number; contentType: "video/mp4" | "video/webm" }> {
    if (!SAFE_TICKET_ID.test(input.ticketId)) {
      throw new CoordinatorProtocolError("ticket_invalid");
    }
    const ticketRecord = (await this.readStore()).tickets.find(
      (item) => item.ticket.ticketId === input.ticketId,
    );
    if (
      !ticketRecord ||
      ticketRecord.ticket.method !== "PUT" ||
      ticketRecord.consumed ||
      Date.parse(ticketRecord.ticket.expiresAt) <= input.now.getTime() ||
      input.bytes.byteLength !== ticketRecord.ticket.bytes
    ) {
      throw new CoordinatorProtocolError("ticket_invalid");
    }
    const checked = validateVideoBytes(
      input.bytes,
      input.declaredType,
      this.maxVideoBytes,
    );
    if (
      checked.contentHash !== ticketRecord.ticket.sha256 ||
      checked.contentType !== ticketRecord.ticket.mimeType
    ) {
      throw new CoordinatorProtocolError("ticket_invalid");
    }
    const mediaDir = this.mediaDir();
    await mkdir(/* turbopackIgnore: true */ mediaDir, { recursive: true });
    const extension = checked.contentType === "video/mp4" ? "mp4" : "webm";
    const storageFile = `${checked.contentHash}.${extension}`;
    const target = path.join(
      /* turbopackIgnore: true */ mediaDir,
      storageFile,
    );
    const temp = path.join(
      /* turbopackIgnore: true */ mediaDir,
      `.${storageFile}.${process.pid}-${Date.now()}.tmp`,
    );
    try {
      await writeFile(/* turbopackIgnore: true */ temp, input.bytes, {
        flag: "wx",
      });
      await rename(
        /* turbopackIgnore: true */ temp,
        /* turbopackIgnore: true */ target,
      ).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code === "EEXIST" || error.code === "EPERM") {
          await unlink(/* turbopackIgnore: true */ temp).catch(
            () => undefined,
          );
          return;
        }
        throw error;
      });
    } catch (error) {
      await unlink(/* turbopackIgnore: true */ temp).catch(() => undefined);
      throw error;
    }
    await this.mutate((store) => {
      const stored = store.tickets.find(
        (item) => item.ticket.ticketId === input.ticketId,
      );
      if (!stored || stored.consumed) {
        throw new CoordinatorProtocolError("ticket_invalid");
      }
      stored.consumed = true;
      stored.storageFile = storageFile;
    });
    return {
      sha256: checked.contentHash,
      bytes: input.bytes.byteLength,
      contentType: checked.contentType,
    };
  }

  async readAcceptedArtifact(input: {
    jobId: string;
    sha256: string;
    bytes: number;
    mimeType: string;
  }): Promise<Uint8Array> {
    const record = (await this.readStore()).tickets.find(
      (item) =>
        item.jobId === input.jobId &&
        item.consumed &&
        item.ticket.sha256 === input.sha256 &&
        item.ticket.bytes === input.bytes &&
        item.ticket.mimeType === input.mimeType &&
        item.storageFile,
    );
    if (!record?.storageFile) {
      throw new CoordinatorProtocolError("ticket_invalid");
    }
    const mediaDir = this.mediaDir();
    const resolved = path.resolve(
      /* turbopackIgnore: true */ mediaDir,
      record.storageFile,
    );
    const root = path.resolve(/* turbopackIgnore: true */ mediaDir);
    if (!resolved.startsWith(`${root}${path.sep}`)) {
      throw new CoordinatorProtocolError("ticket_invalid");
    }
    const bytes = await readFile(/* turbopackIgnore: true */ resolved);
    if (
      bytes.byteLength !== input.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== input.sha256
    ) {
      throw new CoordinatorProtocolError("ticket_invalid");
    }
    return bytes;
  }
}
