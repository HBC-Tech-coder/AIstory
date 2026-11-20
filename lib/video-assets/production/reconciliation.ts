import "server-only";

import { VideoAssetUnavailableError } from "../errors";
import type {
  VideoObjectReconciliationTransport,
  VideoObjectStorageTransport,
} from "../objectStorage";
import type { VideoAssetRepository } from "../repository";

const MIN_RECONCILIATION_GRACE_MS = 60 * 60 * 1000;
const MAX_RECONCILIATION_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

type ReconciliationRepository = Pick<
  VideoAssetRepository,
  "hasObjectReference"
>;

type ReconciliationTransport = Pick<
  VideoObjectStorageTransport,
  "headObject" | "deleteObjectIfMatch"
> & VideoObjectReconciliationTransport;

export type VideoObjectReconciliationResult = {
  examined: number;
  deleted: number;
  referenced: number;
  recent: number;
  missing: number;
  nextContinuationToken?: string;
};

function contentHashFromObjectKey(objectKey: string): string {
  const match = /\/([a-f0-9]{64})\.(?:mp4|webm)$/.exec(objectKey);
  if (!match) throw new VideoAssetUnavailableError();
  return match[1]!;
}

/**
 * Bounded operator-only primitive. No route calls this automatically. A real
 * deployment must first quiesce and drain uploads across every instance, wait
 * a full grace period, then run one approved project at a time. Callers never
 * choose an arbitrary bucket prefix.
 */
export async function reconcileUnreferencedProjectVideoObjects(input: {
  repository: ReconciliationRepository;
  transport: ReconciliationTransport;
  projectId: number;
  graceMs: number;
  quiescedAt: Date;
  now?: Date;
  continuationToken?: string;
  maxKeys?: number;
}): Promise<VideoObjectReconciliationResult> {
  if (
    !Number.isSafeInteger(input.projectId)
    || input.projectId <= 0
    || !Number.isSafeInteger(input.graceMs)
    || input.graceMs < MIN_RECONCILIATION_GRACE_MS
    || input.graceMs > MAX_RECONCILIATION_GRACE_MS
  ) {
    throw new VideoAssetUnavailableError();
  }
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  const quiescedAtMs = input.quiescedAt.getTime();
  if (
    !Number.isFinite(nowMs)
    || !Number.isFinite(quiescedAtMs)
    || quiescedAtMs > nowMs - input.graceMs
  ) {
    throw new VideoAssetUnavailableError();
  }
  try {
    const page = await input.transport.listProjectObjects({
      projectId: input.projectId,
      ...(input.continuationToken !== undefined
        ? { continuationToken: input.continuationToken }
        : {}),
      ...(input.maxKeys !== undefined ? { maxKeys: input.maxKeys } : {}),
    });
    const result: VideoObjectReconciliationResult = {
      examined: page.objects.length,
      deleted: 0,
      referenced: 0,
      recent: 0,
      missing: 0,
      ...(page.nextContinuationToken
        ? { nextContinuationToken: page.nextContinuationToken }
        : {}),
    };
    const cutoff = nowMs - input.graceMs;
    for (const entry of page.objects) {
      const modifiedMs = Date.parse(entry.lastModified);
      if (!Number.isFinite(modifiedMs)) throw new Error("Invalid timestamp.");
      if (modifiedMs > cutoff || modifiedMs > quiescedAtMs) {
        result.recent += 1;
        continue;
      }
      if (await input.repository.hasObjectReference(entry.objectKey)) {
        result.referenced += 1;
        continue;
      }
      const metadata = await input.transport.headObject({
        objectKey: entry.objectKey,
      });
      if (!metadata) {
        result.missing += 1;
        continue;
      }
      const contentHash = contentHashFromObjectKey(entry.objectKey);
      if (
        metadata.bytes !== entry.bytes
        || metadata.contentHash !== contentHash
        || !metadata.etag
        || entry.etag !== metadata.etag
      ) {
        throw new Error("Object changed during reconciliation.");
      }
      // Recheck immediately before the conditional delete. The caller has
      // already proven a drained, grace-aged quiescence window, so no creator
      // can still be between object PUT and metadata commit.
      if (await input.repository.hasObjectReference(entry.objectKey)) {
        result.referenced += 1;
        continue;
      }
      const cleanup = await input.transport.deleteObjectIfMatch({
        objectKey: entry.objectKey,
        contentHash,
        etag: metadata.etag,
      });
      if (!cleanup.deleted) {
        throw new Error("Object cleanup was not confirmed.");
      }
      result.deleted += 1;
    }
    return result;
  } catch {
    throw new VideoAssetUnavailableError();
  }
}
