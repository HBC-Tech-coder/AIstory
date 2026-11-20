"use client";

import type { StoryRecord } from "@/lib/persistence/types";
import {
  idbReady,
  idbRequest,
  idbTransactionDone,
  STORIES_STORE,
  STORY_CLAIM_RECEIPTS_STORE,
  STORY_CLAIM_STAGING_STORE,
} from "@/lib/persistence/idb";
import {
  ANONYMOUS_STORY_NAMESPACE,
  isStableAccountNamespace,
  setActiveStoryNamespace,
  storyStorageKey,
} from "@/lib/persistence/storyNamespace";
import {
  ANONYMOUS_CLAIM_SCHEMA_VERSION,
  type AnonymousClaimExperimentAssignment,
  type AnonymousClaimManifest,
  type AnonymousClaimResult,
  validateAnonymousClaimManifest,
} from "./anonymousClaim";

const CLAIM_IDEMPOTENCY_KEY = "aistory:anonymous-claim-idempotency:v1";
const EXPERIMENT_ASSIGNMENTS_KEY = "aistory:experiment-assignments:v1";

type LocalExperimentAssignmentStore = {
  anonymous: AnonymousClaimExperimentAssignment[];
  accounts: Record<string, AnonymousClaimExperimentAssignment[]>;
};

export type LocalClaimCommitResult = {
  migratedStories: number;
  migratedAssignments: number;
  missingStories: number;
  replayed: boolean;
};

function unique(values: string[], limit: number): string[] {
  return [...new Set(values)].slice(0, limit);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonical(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function claimIdempotencyKey(): string {
  try {
    const existing = window.sessionStorage.getItem(CLAIM_IDEMPOTENCY_KEY);
    if (
      existing &&
      /^[A-Za-z0-9][A-Za-z0-9:._-]{15,159}$/.test(existing)
    ) {
      return existing;
    }
    const created = `claim:${crypto.randomUUID()}`;
    window.sessionStorage.setItem(CLAIM_IDEMPOTENCY_KEY, created);
    return created;
  } catch {
    return `claim:${crypto.randomUUID()}`;
  }
}

function readAssignments(): LocalExperimentAssignmentStore {
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(EXPERIMENT_ASSIGNMENTS_KEY) || "{}",
    ) as Partial<LocalExperimentAssignmentStore>;
    return {
      anonymous: Array.isArray(parsed.anonymous) ? parsed.anonymous : [],
      accounts:
        parsed.accounts &&
        typeof parsed.accounts === "object" &&
        !Array.isArray(parsed.accounts)
          ? parsed.accounts
          : {},
    };
  } catch {
    return { anonymous: [], accounts: {} };
  }
}

function writeAssignments(store: LocalExperimentAssignmentStore): void {
  window.localStorage.setItem(
    EXPERIMENT_ASSIGNMENTS_KEY,
    JSON.stringify(store),
  );
}

async function listAnonymousStoryRecords(): Promise<StoryRecord[]> {
  const db = await idbReady();
  if (!db) return [];
  const transaction = db.transaction(STORIES_STORE, "readonly");
  const records = await idbRequest<StoryRecord[]>(
    transaction.objectStore(STORIES_STORE).getAll(),
  );
  return records.filter(
    (record) =>
      (record.ownerNamespace || ANONYMOUS_STORY_NAMESPACE) ===
        ANONYMOUS_STORY_NAMESPACE && !record.deletedAt,
  );
}

export async function prepareAnonymousClaimManifest(): Promise<AnonymousClaimManifest> {
  const records = await listAnonymousStoryRecords();
  const stories: AnonymousClaimManifest["stories"] = [];
  for (const record of records) {
    const runtime = record.session?.authoredStory;
    if (!runtime?.caseStudyId || !runtime.version) continue;
    const timeline = record.session.timeline;
    const branchIds = unique(
      timeline?.branches.map((branch) => branch.id) ?? [],
      128,
    );
    const selectedChoiceIds = unique(
      timeline?.decisions.map((decision) => decision.selectedChoiceId) ?? [],
      256,
    );
    const checkpointCount =
      timeline?.decisions.filter((decision) => Boolean(decision.checkpoint))
        .length ?? 0;
    const timelineRevision = await sha256({
      activeBranchId: timeline?.activeBranchId ?? "",
      branchIds,
      selectedChoiceIds,
      checkpointCount,
      currentNodeId: runtime.currentNodeId,
      visitedNodeIds: unique(runtime.visitedNodeIds, 512),
    });
    stories.push({
      recordId: record.id,
      storyId: runtime.caseStudyId,
      storyVersion: runtime.version,
      currentNodeId: runtime.currentNodeId,
      currentBeatId: runtime.currentBeatId,
      visitedNodeIds: unique(runtime.visitedNodeIds, 512),
      ...(timeline?.activeBranchId
        ? { activeBranchId: timeline.activeBranchId }
        : {}),
      branchIds,
      selectedChoiceIds,
      checkpointCount,
      timelineRevision,
      localRevision: Math.max(1, Math.trunc(record.rev || 1)),
      updatedAt: Math.max(0, Math.trunc(record.updatedAt || 0)),
    });
  }
  const assignments = readAssignments().anonymous;
  return validateAnonymousClaimManifest({
    schemaVersion: ANONYMOUS_CLAIM_SCHEMA_VERSION,
    idempotencyKey: claimIdempotencyKey(),
    stories,
    cacheReferences: [],
    experimentAssignments: assignments,
  });
}

async function commitStoryRecords(
  userId: string,
  result: AnonymousClaimResult,
): Promise<{
  migratedStories: number;
  missingStories: number;
  replayed: boolean;
}> {
  if (!result.claimId || !result.acceptedStoryRecordIds.length) {
    return { migratedStories: 0, missingStories: 0, replayed: false };
  }
  const db = await idbReady();
  if (!db) {
    return {
      migratedStories: 0,
      missingStories: result.acceptedStoryRecordIds.length,
      replayed: false,
    };
  }
  const transaction = db.transaction(
    [STORIES_STORE, STORY_CLAIM_STAGING_STORE, STORY_CLAIM_RECEIPTS_STORE],
    "readwrite",
  );
  const stories = transaction.objectStore(STORIES_STORE);
  const staging = transaction.objectStore(STORY_CLAIM_STAGING_STORE);
  const receipts = transaction.objectStore(STORY_CLAIM_RECEIPTS_STORE);
  const existingReceipt = await idbRequest<{
    claimId: string;
    userId: string;
    migratedStories: number;
    missingStories: number;
  } | undefined>(receipts.get(result.claimId));
  if (existingReceipt) {
    if (existingReceipt.userId !== userId) {
      transaction.abort();
      throw new Error("Local claim receipt belongs to another account.");
    }
    await idbTransactionDone(transaction);
    return {
      migratedStories: existingReceipt.migratedStories,
      missingStories: existingReceipt.missingStories,
      replayed: true,
    };
  }
  let migratedStories = 0;
  let missingStories = 0;
  const stagedKeys: string[] = [];
  const sourceKeys: string[] = [];
  for (const recordId of result.acceptedStoryRecordIds) {
    const sourceKey = storyStorageKey(ANONYMOUS_STORY_NAMESPACE, recordId);
    const targetKey = storyStorageKey(userId, recordId);
    const source = await idbRequest<StoryRecord | undefined>(
      stories.get(sourceKey),
    );
    const existingTarget = await idbRequest<StoryRecord | undefined>(
      stories.get(targetKey),
    );
    if (!source) {
      if (existingTarget?.ownerNamespace === userId) migratedStories += 1;
      else missingStories += 1;
      continue;
    }
    if (
      !source.session?.authoredStory ||
      source.ownerNamespace !== ANONYMOUS_STORY_NAMESPACE
    ) {
      missingStories += 1;
      continue;
    }
    const stageKey = `${result.claimId}:${recordId}`;
    const target: StoryRecord = {
      ...structuredClone(source),
      storageKey: targetKey,
      ownerNamespace: userId,
    };
    staging.put({
      key: stageKey,
      claimId: result.claimId,
      userId,
      sourceStorageKey: sourceKey,
      targetStorageKey: targetKey,
      record: target,
    });
    stories.put(target);
    stagedKeys.push(stageKey);
    sourceKeys.push(sourceKey);
    migratedStories += 1;
  }
  receipts.put({
    claimId: result.claimId,
    userId,
    status: "committed",
    migratedStories,
    missingStories,
    committedAt: Date.now(),
  });
  for (const sourceKey of sourceKeys) stories.delete(sourceKey);
  for (const stageKey of stagedKeys) staging.delete(stageKey);
  await idbTransactionDone(transaction);
  return { migratedStories, missingStories, replayed: false };
}

function commitAssignments(
  userId: string,
  acceptedAssignments: AnonymousClaimExperimentAssignment[],
): number {
  if (!acceptedAssignments.length) return 0;
  const store = readAssignments();
  const accepted = new Map(
    acceptedAssignments.map((assignment) => [
      `${assignment.experimentKey}:${assignment.experimentVersion}`,
      assignment,
    ]),
  );
  const inherited = [...accepted.values()];
  const existing = Array.isArray(store.accounts[userId])
    ? store.accounts[userId]!
    : [];
  const byKey = new Map(
    [...existing, ...inherited].map((assignment) => [
      `${assignment.experimentKey}:${assignment.experimentVersion}`,
      assignment,
    ]),
  );
  store.accounts[userId] = [...byKey.values()];
  store.anonymous = store.anonymous.filter(
    (assignment) =>
      !accepted.has(
        `${assignment.experimentKey}:${assignment.experimentVersion}`,
      ),
  );
  writeAssignments(store);
  return inherited.length;
}

export async function applyAnonymousClaimResult(
  userId: string,
  result?: AnonymousClaimResult,
): Promise<LocalClaimCommitResult> {
  if (!isStableAccountNamespace(userId)) {
    return {
      migratedStories: 0,
      migratedAssignments: 0,
      missingStories: 0,
      replayed: false,
    };
  }
  setActiveStoryNamespace(userId);
  if (!result || !["claimed", "replayed"].includes(result.status)) {
    return {
      migratedStories: 0,
      migratedAssignments: 0,
      missingStories: 0,
      replayed: false,
    };
  }
  const stories = await commitStoryRecords(userId, result);
  return {
    ...stories,
    migratedAssignments: commitAssignments(
      userId,
      result.acceptedAssignments,
    ),
  };
}

export function resetClaimClientStateOnLogout(): void {
  setActiveStoryNamespace();
  try {
    window.sessionStorage.removeItem(CLAIM_IDEMPOTENCY_KEY);
  } catch {
    // No credentials or other storage keys are inspected or changed.
  }
}
