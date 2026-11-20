export const ANONYMOUS_CLAIM_SCHEMA_VERSION =
  "aistory-anonymous-claim-v1" as const;
export const ANONYMOUS_CLAIM_MAX_BYTES = 128 * 1024;
export const ANONYMOUS_CLAIM_MAX_STORIES = 50;
export const ANONYMOUS_CLAIM_MAX_ASSIGNMENTS = 32;
export const ANONYMOUS_CLAIM_MAX_CACHE_REFS = 100;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export type AnonymousClaimStory = {
  recordId: string;
  storyId: string;
  storyVersion: string;
  currentNodeId: string;
  currentBeatId: string;
  visitedNodeIds: string[];
  activeBranchId?: string;
  branchIds: string[];
  selectedChoiceIds: string[];
  checkpointCount: number;
  timelineRevision: string;
  localRevision: number;
  updatedAt: number;
};

export type AnonymousClaimCacheReference = {
  storyId: string;
  storyVersion: string;
  resourceKey: string;
  contentHash: string;
};

export type AnonymousClaimExperimentAssignment = {
  experimentKey: string;
  experimentVersion: string;
  variantKey: string;
};

export type AnonymousClaimManifest = {
  schemaVersion: typeof ANONYMOUS_CLAIM_SCHEMA_VERSION;
  idempotencyKey: string;
  stories: AnonymousClaimStory[];
  cacheReferences: AnonymousClaimCacheReference[];
  experimentAssignments: AnonymousClaimExperimentAssignment[];
};

export type AnonymousClaimSkipReason =
  | "not_published"
  | "version_mismatch"
  | "node_unavailable"
  | "resource_unavailable"
  | "assignment_unavailable"
  | "manifest_invalid";

export type AnonymousClaimResult = {
  status: "claimed" | "replayed" | "not_found" | "conflict" | "empty";
  claimId?: string;
  acceptedStoryRecordIds: string[];
  acceptedAssignmentKeys: string[];
  acceptedAssignments: AnonymousClaimExperimentAssignment[];
  counts: {
    submittedStories: number;
    inheritedStories: number;
    inheritedCheckpoints: number;
    inheritedCacheReferences: number;
    inheritedAssignments: number;
    skipped: number;
  };
  skippedByReason: Partial<Record<AnonymousClaimSkipReason, number>>;
};

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowlist = new Set(allowed);
  if (Object.keys(value).some((key) => !allowlist.has(key))) {
    throw new Error(`${label} contains a forbidden field.`);
  }
}

function safeId(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function sha(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function integer(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < minimum ||
    parsed > maximum
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return parsed;
}

function idList(
  value: unknown,
  label: string,
  maximum: number,
): string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(`${label} is invalid.`);
  }
  const result = value.map((item) => safeId(item, label));
  if (new Set(result).size !== result.length) {
    throw new Error(`${label} contains duplicates.`);
  }
  return result;
}

function validateStory(value: unknown): AnonymousClaimStory {
  const item = record(value, "Story claim");
  exactKeys(
    item,
    [
      "recordId",
      "storyId",
      "storyVersion",
      "currentNodeId",
      "currentBeatId",
      "visitedNodeIds",
      "activeBranchId",
      "branchIds",
      "selectedChoiceIds",
      "checkpointCount",
      "timelineRevision",
      "localRevision",
      "updatedAt",
    ],
    "Story claim",
  );
  return {
    recordId: safeId(item.recordId, "Story record id"),
    storyId: safeId(item.storyId, "Story id"),
    storyVersion: safeId(item.storyVersion, "Story version"),
    currentNodeId: safeId(item.currentNodeId, "Current node id"),
    currentBeatId: safeId(item.currentBeatId, "Current beat id"),
    visitedNodeIds: idList(item.visitedNodeIds, "Visited node ids", 512),
    ...(item.activeBranchId
      ? { activeBranchId: safeId(item.activeBranchId, "Active branch id") }
      : {}),
    branchIds: idList(item.branchIds, "Branch ids", 128),
    selectedChoiceIds: idList(
      item.selectedChoiceIds,
      "Selected choice ids",
      256,
    ),
    checkpointCount: integer(
      item.checkpointCount,
      "Checkpoint count",
      0,
      512,
    ),
    timelineRevision: sha(item.timelineRevision, "Timeline revision"),
    localRevision: integer(item.localRevision, "Local revision", 1, 1_000_000),
    updatedAt: integer(
      item.updatedAt,
      "Story update time",
      0,
      8_640_000_000_000_000,
    ),
  };
}

function validateCacheReference(
  value: unknown,
): AnonymousClaimCacheReference {
  const item = record(value, "Cache reference");
  exactKeys(
    item,
    ["storyId", "storyVersion", "resourceKey", "contentHash"],
    "Cache reference",
  );
  const resourceKey = String(item.resourceKey || "");
  if (
    resourceKey.length < 1 ||
    resourceKey.length > 240 ||
    !resourceKey.startsWith("/") ||
    resourceKey.includes("..") ||
    resourceKey.includes("\\") ||
    /[\u0000-\u001f<>]/.test(resourceKey)
  ) {
    throw new Error("Cache resource key is invalid.");
  }
  return {
    storyId: safeId(item.storyId, "Cache story id"),
    storyVersion: safeId(item.storyVersion, "Cache story version"),
    resourceKey,
    contentHash: sha(item.contentHash, "Cache content hash"),
  };
}

function validateAssignment(
  value: unknown,
): AnonymousClaimExperimentAssignment {
  const item = record(value, "Experiment assignment");
  exactKeys(
    item,
    ["experimentKey", "experimentVersion", "variantKey"],
    "Experiment assignment",
  );
  return {
    experimentKey: safeId(item.experimentKey, "Experiment key"),
    experimentVersion: safeId(
      item.experimentVersion,
      "Experiment version",
    ),
    variantKey: safeId(item.variantKey, "Experiment variant"),
  };
}

export function validateAnonymousClaimManifest(
  value: unknown,
): AnonymousClaimManifest {
  const serialized = JSON.stringify(value);
  if (!serialized || new TextEncoder().encode(serialized).byteLength > ANONYMOUS_CLAIM_MAX_BYTES) {
    throw new Error("Anonymous claim manifest exceeds the size limit.");
  }
  const source = record(value, "Anonymous claim manifest");
  exactKeys(
    source,
    [
      "schemaVersion",
      "idempotencyKey",
      "stories",
      "cacheReferences",
      "experimentAssignments",
    ],
    "Anonymous claim manifest",
  );
  if (source.schemaVersion !== ANONYMOUS_CLAIM_SCHEMA_VERSION) {
    throw new Error("Anonymous claim schema version is unsupported.");
  }
  const idempotencyKey = safeId(source.idempotencyKey, "Idempotency key");
  if (idempotencyKey.length < 16) {
    throw new Error("Idempotency key is invalid.");
  }
  if (
    !Array.isArray(source.stories) ||
    source.stories.length > ANONYMOUS_CLAIM_MAX_STORIES ||
    !Array.isArray(source.cacheReferences) ||
    source.cacheReferences.length > ANONYMOUS_CLAIM_MAX_CACHE_REFS ||
    !Array.isArray(source.experimentAssignments) ||
    source.experimentAssignments.length > ANONYMOUS_CLAIM_MAX_ASSIGNMENTS
  ) {
    throw new Error("Anonymous claim collection is invalid.");
  }
  const stories = source.stories.map(validateStory);
  const cacheReferences = source.cacheReferences.map(validateCacheReference);
  const experimentAssignments =
    source.experimentAssignments.map(validateAssignment);
  if (
    new Set(stories.map((story) => story.recordId)).size !== stories.length ||
    new Set(
      experimentAssignments.map(
        (assignment) =>
          `${assignment.experimentKey}:${assignment.experimentVersion}`,
      ),
    ).size !== experimentAssignments.length
  ) {
    throw new Error("Anonymous claim manifest contains duplicates.");
  }
  return {
    schemaVersion: ANONYMOUS_CLAIM_SCHEMA_VERSION,
    idempotencyKey,
    stories,
    cacheReferences,
    experimentAssignments,
  };
}

export function emptyAnonymousClaimResult(
  status: AnonymousClaimResult["status"],
): AnonymousClaimResult {
  return {
    status,
    acceptedStoryRecordIds: [],
    acceptedAssignmentKeys: [],
    acceptedAssignments: [],
    counts: {
      submittedStories: 0,
      inheritedStories: 0,
      inheritedCheckpoints: 0,
      inheritedCacheReferences: 0,
      inheritedAssignments: 0,
      skipped: 0,
    },
    skippedByReason: {},
  };
}
