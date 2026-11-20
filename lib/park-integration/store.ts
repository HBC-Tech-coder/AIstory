import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

import { ParkError } from "./errors";
import { isPlainObject } from "./contract";
import type {
  ParkEventState,
  ParkRequestState,
  ParkRedactedJobStatus,
} from "./types";

export const PARK_STATE_FILENAME = "park-integration-state.json";
export const PARK_LOCK_FILENAME = "park-integration.lock";
export const PARK_STORE_SCHEMA_VERSION = 1 as const;

export type PersistedRequest = {
  key: string;
  principal: string;
  localInstance: string;
  remoteInstance: string;
  project: string;
  group: string;
  capability: "group.publishResult";
  version: 1;
  requestId: string;
  digest: string;
  state: ParkRequestState;
  assetRef: string;
  /** Pinned actual identity of the asset that was authorized at request time. */
  assetId: string;
  projectId: number;
  jobId: string;
  contentHash: string;
  title: string;
  groupMessageRef?: string;
  errorCode?: "transport_unknown" | "authorization_revoked";
  createdAt: string;
  updatedAt: string;
  sendAttempts: number;
};

export type PersistedInboundRequest = {
  key: string;
  principal: string;
  localInstance: string;
  remoteInstance: string;
  project: string;
  group: string;
  capability: "job.status";
  version: 1;
  requestId: string;
  digest: string;
  /** Pinned actual identity of the mapped job. */
  jobId: string;
  projectId: number;
  /** Pinned actual identity of the mapped asset, when one was disclosed. */
  assetId?: string;
  contentHash?: string;
  result: ParkRedactedJobStatus;
  createdAt: string;
  updatedAt: string;
};

export type PersistedEvent = {
  key: string;
  principal: string;
  remoteInstance: string;
  project: string;
  group: string;
  eventId: string;
  identityDigest: string;
  requestKey?: string;
  state: ParkEventState;
  createdAt: string;
  updatedAt: string;
};

export type ParkStoreState = {
  schemaVersion: typeof PARK_STORE_SCHEMA_VERSION;
  requests: Record<string, PersistedRequest>;
  inbound: Record<string, PersistedInboundRequest>;
  events: Record<string, PersistedEvent>;
};

export function emptyParkStoreState(): ParkStoreState {
  return {
    schemaVersion: PARK_STORE_SCHEMA_VERSION,
    requests: {},
    inbound: {},
    events: {},
  };
}

export function parkStatePath(storeDir: string): string {
  return path.join(storeDir, PARK_STATE_FILENAME);
}

export function parkLockPath(storeDir: string): string {
  return path.join(storeDir, PARK_LOCK_FILENAME);
}

function assertStateShape(value: unknown): asserts value is ParkStoreState {
  if (
    !isPlainObject(value) ||
    value.schemaVersion !== PARK_STORE_SCHEMA_VERSION ||
    !isPlainObject(value.requests) ||
    !isPlainObject(value.inbound) ||
    !isPlainObject(value.events)
  ) {
    throw new ParkError("store_corrupt");
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch {
    // Directory fsync is not supported on every platform (notably Windows).
    // Without it, durability of the directory entry across an abrupt power
    // loss is not guaranteed; only the process-restart path is covered.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Durable, single-file store for adapter state.
 *
 * Guarantees:
 *  - every mutation is serialized by a cross-process exclusive lock file
 *  - a pre-existing lock is never stolen (fail closed, even if stale)
 *  - writes go to a fresh temp file, fsync, then atomic rename
 *  - process-restart behavior relies on state already persisted; an abrupt
 *    power loss is not covered on platforms without directory fsync
 *  - there is no previous/backup fallback, so stale state can never
 *    resurrect a pending or completed send
 */
export class ParkDurableStore {
  private tail: Promise<void> = Promise.resolve();
  private lockNonce: string | undefined;

  constructor(readonly directory: string) {}

  async init(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
  }

  stateFile(): string {
    return parkStatePath(this.directory);
  }

  async readState(): Promise<ParkStoreState> {
    let text: string;
    try {
      text = await readFile(this.stateFile(), "utf8");
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return emptyParkStoreState();
      }
      throw new ParkError("store_unavailable");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ParkError("store_corrupt");
    }
    assertStateShape(parsed);
    return parsed;
  }

  async writeState(state: ParkStoreState): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const target = this.stateFile();
    const temp = path.join(
      this.directory,
      `.park-state-${process.pid}-${Date.now()}-${randomUUID()}.tmp`,
    );
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(state, null, 2), "utf8");
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(temp).catch(() => undefined);
      throw new ParkError("store_unavailable");
    }
    await handle.close().catch(() => undefined);
    try {
      await rename(temp, target);
    } catch {
      await unlink(temp).catch(() => undefined);
      throw new ParkError("store_unavailable");
    }
    await syncDirectory(this.directory);
  }

  private async acquireLock(): Promise<void> {
    const lockPath = parkLockPath(this.directory);
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "EEXIST"
      ) {
        // Fail closed: never inspect, age out, or steal a lock.
        throw new ParkError("lock_busy");
      }
      throw new ParkError("store_unavailable");
    }
    const nonce = randomUUID();
    try {
      await handle.writeFile(
        JSON.stringify({
          pid: process.pid,
          createdAt: new Date().toISOString(),
          nonce,
        }),
        "utf8",
      );
      await handle.sync();
    } catch {
      await handle.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
      throw new ParkError("store_unavailable");
    }
    await handle.close().catch(() => undefined);
    this.lockNonce = nonce;
  }

  private async releaseLock(): Promise<void> {
    const lockPath = parkLockPath(this.directory);
    const nonce = this.lockNonce;
    this.lockNonce = undefined;
    let text: string | undefined;
    try {
      text = await readFile(lockPath, "utf8");
    } catch {
      return;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (
        !isPlainObject(parsed) ||
        typeof parsed.nonce !== "string" ||
        parsed.nonce !== nonce
      ) {
        // Someone else's lock: leave it untouched.
        return;
      }
    } catch {
      return;
    }
    await unlink(lockPath).catch(() => undefined);
  }

  /**
   * Run one read-modify-write (or a whole dispatch sequence) while holding
   * both the in-process queue and the cross-process lock.
   */
  async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release: () => void = () => undefined;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    try {
      await this.acquireLock();
      try {
        return await operation();
      } finally {
        await this.releaseLock();
      }
    } finally {
      release();
    }
  }

  /**
   * A process restart invalidates any in-flight send. Persist every
   * `sending` record as `unknown`; it must never be re-sent automatically.
   */
  async recoverSending(): Promise<void> {
    await this.withLock(async () => {
      const state = await this.readState();
      const now = new Date().toISOString();
      let changed = false;
      for (const request of Object.values(state.requests)) {
        if (request.state === "sending") {
          request.state = "unknown";
          request.updatedAt = now;
          request.errorCode = "transport_unknown";
          changed = true;
        }
      }
      if (changed) await this.writeState(state);
    });
  }
}
