import "server-only";

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { getFeaturedTemplate } from "@/lib/featuredStories";
import {
  type AnonymousClaimCacheReference,
  type AnonymousClaimExperimentAssignment,
  type AnonymousClaimManifest,
  type AnonymousClaimSkipReason,
  type AnonymousClaimStory,
  validateAnonymousClaimManifest,
} from "./anonymousClaim";
import { readAnonymousSubject } from "./anonymousSubject";

export type ServerAnonymousClaim = {
  anonymousSubjectHash: string;
  idempotencyKey: string;
  requestFingerprint: string;
  manifestVersion: string;
  reason: "same_browser_phone_login";
  submittedStories: number;
  stories: AnonymousClaimStory[];
  cacheReferences: AnonymousClaimCacheReference[];
  experimentAssignments: AnonymousClaimExperimentAssignment[];
  skippedByReason: Partial<Record<AnonymousClaimSkipReason, number>>;
};

type PublicStoryRuntime = {
  session?: {
    id?: string;
    authoredStory?: {
      caseStudyId?: string;
      version?: string;
      nodes?: Array<{
        nodeId?: string;
        restricted?: boolean;
        releasePolicy?: string;
        scene?: {
          beats?: Array<{ id?: string }>;
        };
      }>;
    };
  };
};

type ClaimResolverOptions = {
  resolveStory?: (
    story: AnonymousClaimStory,
  ) => Promise<boolean | AnonymousClaimSkipReason>;
  resolveCacheReference?: (
    reference: AnonymousClaimCacheReference,
  ) => Promise<boolean>;
  resolveAssignment?: (
    assignment: AnonymousClaimExperimentAssignment,
  ) => Promise<boolean>;
};

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

function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function addSkip(
  result: Partial<Record<AnonymousClaimSkipReason, number>>,
  reason: AnonymousClaimSkipReason,
): void {
  result[reason] = (result[reason] || 0) + 1;
}

async function publicStoryRuntime(
  storyId: string,
): Promise<PublicStoryRuntime | undefined> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(storyId)) {
    return undefined;
  }
  const featured = getFeaturedTemplate(storyId);
  if (!featured || featured.active === false) return undefined;
  try {
    const file = path.join(
      process.cwd(),
      "public",
      "case-studies",
      storyId,
      "story.json",
    );
    return JSON.parse(await readFile(file, "utf8")) as PublicStoryRuntime;
  } catch {
    return undefined;
  }
}

async function resolvePublishedStory(
  story: AnonymousClaimStory,
): Promise<true | AnonymousClaimSkipReason> {
  const published = await publicStoryRuntime(story.storyId);
  const runtime = published?.session?.authoredStory;
  if (!runtime || runtime.caseStudyId !== story.storyId) {
    return "not_published";
  }
  if (runtime.version !== story.storyVersion) {
    return "version_mismatch";
  }
  if (
    published?.session?.id !== story.recordId ||
    !Array.isArray(runtime.nodes)
  ) {
    return "manifest_invalid";
  }
  const nodes = new Map(runtime.nodes.map((node) => [node.nodeId, node]));
  for (const nodeId of [
    story.currentNodeId,
    ...story.visitedNodeIds,
  ]) {
    const node = nodes.get(nodeId);
    if (
      !node ||
      node.restricted === true
    ) {
      return node ? "not_published" : "node_unavailable";
    }
    if (node.releasePolicy && node.releasePolicy !== "public") {
      return "not_published";
    }
  }
  const current = nodes.get(story.currentNodeId);
  return current?.scene?.beats?.some(
    (beat) => beat.id === story.currentBeatId,
  )
    ? true
    : "node_unavailable";
}

async function resolvePublicCacheReference(
  reference: AnonymousClaimCacheReference,
): Promise<boolean> {
  const published = await publicStoryRuntime(reference.storyId);
  if (
    published?.session?.authoredStory?.version !== reference.storyVersion ||
    !reference.resourceKey.startsWith(
      `/case-studies/${reference.storyId}/`,
    )
  ) {
    return false;
  }
  const relative = reference.resourceKey.slice(1);
  const root = path.resolve(process.cwd(), "public");
  const file = path.resolve(root, relative);
  if (!file.startsWith(`${root}${path.sep}`)) return false;
  try {
    const bytes = await readFile(file);
    return (
      createHash("sha256").update(bytes).digest("hex") ===
      reference.contentHash
    );
  } catch {
    return false;
  }
}

function configuredAssignments(): Array<{
  experimentKey: string;
  experimentVersion: string;
  variants: string[];
  active: boolean;
}> {
  try {
    const value = JSON.parse(
      process.env.AISTORY_PUBLIC_EXPERIMENT_ASSIGNMENTS_JSON || "[]",
    ) as unknown;
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const item = entry as Record<string, unknown>;
      if (
        typeof item.experimentKey !== "string" ||
        typeof item.experimentVersion !== "string" ||
        !Array.isArray(item.variants)
      ) {
        return [];
      }
      return [{
        experimentKey: item.experimentKey,
        experimentVersion: item.experimentVersion,
        variants: item.variants.filter(
          (variant): variant is string => typeof variant === "string",
        ),
        active: item.active === true,
      }];
    });
  } catch {
    return [];
  }
}

async function resolveExperimentAssignment(
  assignment: AnonymousClaimExperimentAssignment,
): Promise<boolean> {
  return configuredAssignments().some(
    (candidate) =>
      candidate.active &&
      candidate.experimentKey === assignment.experimentKey &&
      candidate.experimentVersion === assignment.experimentVersion &&
      candidate.variants.includes(assignment.variantKey),
  );
}

export async function prepareServerAnonymousClaim(
  request: Request,
  value: unknown,
  options: ClaimResolverOptions = {},
): Promise<ServerAnonymousClaim | undefined> {
  if (value === undefined || value === null) return undefined;
  const manifest: AnonymousClaimManifest =
    validateAnonymousClaimManifest(value);
  const subject = readAnonymousSubject(request);
  if (!subject) return undefined;
  const skippedByReason: ServerAnonymousClaim["skippedByReason"] = {};
  const stories: AnonymousClaimStory[] = [];
  for (const story of manifest.stories) {
    const resolution =
      await (options.resolveStory ?? resolvePublishedStory)(story);
    if (resolution === true) {
      stories.push(story);
    } else {
      addSkip(
        skippedByReason,
        typeof resolution === "string" ? resolution : "not_published",
      );
    }
  }
  const cacheReferences: AnonymousClaimCacheReference[] = [];
  for (const reference of manifest.cacheReferences) {
    if (
      await (
        options.resolveCacheReference ?? resolvePublicCacheReference
      )(reference)
    ) {
      cacheReferences.push(reference);
    } else {
      addSkip(skippedByReason, "resource_unavailable");
    }
  }
  const experimentAssignments: AnonymousClaimExperimentAssignment[] = [];
  for (const assignment of manifest.experimentAssignments) {
    if (
      await (
        options.resolveAssignment ?? resolveExperimentAssignment
      )(assignment)
    ) {
      experimentAssignments.push(assignment);
    } else {
      addSkip(skippedByReason, "assignment_unavailable");
    }
  }
  const semantic = {
    anonymousSubjectHash: subject.subjectHash,
    manifest,
  };
  return {
    anonymousSubjectHash: subject.subjectHash,
    idempotencyKey: manifest.idempotencyKey,
    requestFingerprint: fingerprint(semantic),
    manifestVersion: manifest.schemaVersion,
    reason: "same_browser_phone_login",
    submittedStories: manifest.stories.length,
    stories,
    cacheReferences,
    experimentAssignments,
    skippedByReason,
  };
}
