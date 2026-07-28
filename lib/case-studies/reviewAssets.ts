import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const CASE_ID = "virtual-girlfriend-20260727";
const REVIEW_DIR = path.join(
  process.cwd(),
  "content",
  "case-studies",
  CASE_ID,
  "author-locked-v1.1",
  "doubao-renders",
  "20260728-review",
);
const MANIFEST_PATH = path.join(REVIEW_DIR, "manifest.review.json");
const MAX_REVIEW_NOTE_LENGTH = 500;

export const CASE_REVIEW_DECISIONS = [
  "review_pending",
  "approved_candidate",
  "rejected_for_publication",
] as const;

export type CaseReviewDecision = (typeof CASE_REVIEW_DECISIONS)[number];

type RawReviewItem = {
  id: string;
  file: string;
  label: string;
  bytes: number;
  sha256: string;
  image?: {
    format?: string;
    width?: number;
    height?: number;
    aspectRatio?: string;
  };
  video?: {
    codec?: string;
    width?: number;
    height?: number;
    fps?: number;
    durationSeconds?: number;
  };
  review?: Record<string, unknown>;
};

type RawReviewManifest = {
  schemaVersion: string;
  caseStudyId: string;
  createdAt: string;
  updatedAt?: string;
  publicationStatus: string;
  publicationNote: string;
  source?: Record<string, unknown>;
  items: RawReviewItem[];
};

export type CaseReviewAsset = {
  id: string;
  label: string;
  bytes: number;
  sha256: string;
  modality: "image" | "video";
  width: number;
  height: number;
  aspectRatio: string;
  durationSeconds?: number;
  previewUrl: string;
  review: {
    publicationStatus: CaseReviewDecision;
    sceneQuality: string;
    characterContinuity: string;
    referenceFaceFidelity: string;
    clothingContinuity: string;
    actionFit: string;
    publicSafety: string;
    storyFit: string;
    notes: string;
    reviewedAt?: string;
  };
};

export type CaseReviewSnapshot = {
  schemaVersion: string;
  caseStudyId: string;
  createdAt: string;
  updatedAt?: string;
  publicationStatus: string;
  publicationNote: string;
  counts: Record<CaseReviewDecision, number>;
  items: CaseReviewAsset[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, fallback = "未记录"): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function number(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function decision(value: unknown): CaseReviewDecision {
  return CASE_REVIEW_DECISIONS.includes(value as CaseReviewDecision)
    ? (value as CaseReviewDecision)
    : "review_pending";
}

function safeAssetFilename(value: unknown): string {
  const filename = text(value, "");
  if (
    !filename
    || filename !== path.basename(filename)
    || !/\.(?:png|jpe?g|webp|avif|mp4)$/i.test(filename)
  ) {
    throw new Error("Invalid review asset filename");
  }
  return filename;
}

export function parseCaseReviewManifest(value: unknown): RawReviewManifest {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw new Error("Invalid case review manifest");
  }
  if (value.caseStudyId !== CASE_ID) {
    throw new Error("Unexpected case study id");
  }
  const ids = new Set<string>();
  const items = value.items.map((entry) => {
    if (!isRecord(entry)) throw new Error("Invalid review asset item");
    const id = text(entry.id, "");
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{2,120}$/.test(id) || ids.has(id)) {
      throw new Error("Invalid or duplicate review asset id");
    }
    ids.add(id);
    const file = safeAssetFilename(entry.file);
    if (!isRecord(entry.review)) {
      throw new Error(`Missing review record for ${id}`);
    }
    return {
      id,
      file,
      label: text(entry.label, id),
      bytes: number(entry.bytes),
      sha256: text(entry.sha256, ""),
      image: isRecord(entry.image) ? entry.image : undefined,
      video: isRecord(entry.video) ? entry.video : undefined,
      review: entry.review,
    } satisfies RawReviewItem;
  });
  return {
    schemaVersion: text(value.schemaVersion, "aistory-doubao-render-review-v1"),
    caseStudyId: CASE_ID,
    createdAt: text(value.createdAt, ""),
    updatedAt: text(value.updatedAt, "") || undefined,
    publicationStatus: text(value.publicationStatus, "review_pending"),
    publicationNote: text(value.publicationNote, ""),
    source: isRecord(value.source) ? value.source : undefined,
    items,
  };
}

function toSnapshot(manifest: RawReviewManifest): CaseReviewSnapshot {
  const counts: Record<CaseReviewDecision, number> = {
    review_pending: 0,
    approved_candidate: 0,
    rejected_for_publication: 0,
  };
  const items = manifest.items.map((item) => {
    const review = item.review ?? {};
    const publicationStatus = decision(review.publicationStatus);
    counts[publicationStatus] += 1;
    const media = item.image ?? item.video ?? {};
    const modality = item.image ? "image" : "video";
    const width = number(media.width);
    const height = number(media.height);
    return {
      id: item.id,
      label: item.label,
      bytes: item.bytes,
      sha256: item.sha256,
      modality,
      width,
      height,
      aspectRatio:
        text(item.image?.aspectRatio, "")
        || (width > 0 && height > 0 ? `${width}:${height}` : "未知"),
      durationSeconds:
        modality === "video" ? number(item.video?.durationSeconds) : undefined,
      previewUrl: `/api/case-studies/review-assets/${encodeURIComponent(item.id)}`,
      review: {
        publicationStatus,
        sceneQuality: text(review.sceneQuality),
        characterContinuity: text(review.characterContinuity),
        referenceFaceFidelity: text(review.referenceFaceFidelity),
        clothingContinuity: text(review.clothingContinuity),
        actionFit: text(review.actionFit),
        publicSafety: text(review.publicSafety),
        storyFit: text(review.storyFit),
        notes: text(review.notes, ""),
        reviewedAt: text(review.reviewedAt, "") || undefined,
      },
    } satisfies CaseReviewAsset;
  });
  return {
    schemaVersion: manifest.schemaVersion,
    caseStudyId: manifest.caseStudyId,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    publicationStatus: manifest.publicationStatus,
    publicationNote: manifest.publicationNote,
    counts,
    items,
  };
}

async function readManifest(): Promise<RawReviewManifest> {
  return parseCaseReviewManifest(
    JSON.parse(await readFile(MANIFEST_PATH, "utf8")) as unknown,
  );
}

export async function readCaseReviewSnapshot(): Promise<CaseReviewSnapshot> {
  return toSnapshot(await readManifest());
}

export function applyCaseReviewDecision(
  manifest: RawReviewManifest,
  itemId: string,
  nextDecision: CaseReviewDecision,
  note: string,
  reviewedAt = new Date().toISOString(),
): RawReviewManifest {
  if (!CASE_REVIEW_DECISIONS.includes(nextDecision)) {
    throw new Error("Invalid review decision");
  }
  const normalizedNote = note.trim().slice(0, MAX_REVIEW_NOTE_LENGTH);
  let found = false;
  const items = manifest.items.map((item) => {
    if (item.id !== itemId) return item;
    found = true;
    return {
      ...item,
      review: {
        ...(item.review ?? {}),
        publicationStatus: nextDecision,
        ...(normalizedNote ? { notes: normalizedNote } : {}),
        reviewedAt,
      },
    };
  });
  if (!found) throw new Error("Review asset not found");
  return { ...manifest, updatedAt: reviewedAt, items };
}

export async function updateCaseReviewDecision(input: {
  itemId: string;
  decision: CaseReviewDecision;
  note: string;
}): Promise<CaseReviewSnapshot> {
  const current = await readManifest();
  const next = applyCaseReviewDecision(
    current,
    input.itemId,
    input.decision,
    input.note,
  );
  const tempPath = `${MANIFEST_PATH}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  await rename(tempPath, MANIFEST_PATH);
  return toSnapshot(next);
}

export async function readCaseReviewAsset(itemId: string): Promise<{
  bytes: Buffer;
  contentType: string;
  sha256: string;
}> {
  const manifest = await readManifest();
  const item = manifest.items.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error("Review asset not found");
  const filename = safeAssetFilename(item.file);
  const assetPath = path.join(REVIEW_DIR, filename);
  const root = `${path.resolve(REVIEW_DIR)}${path.sep}`;
  const resolved = path.resolve(assetPath);
  if (!resolved.startsWith(root)) throw new Error("Review asset path rejected");
  const fileStat = await stat(resolved);
  if (!fileStat.isFile() || fileStat.size !== item.bytes) {
    throw new Error("Review asset size mismatch");
  }
  const bytes = await readFile(resolved);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== item.sha256) throw new Error("Review asset hash mismatch");
  const extension = path.extname(filename).toLowerCase();
  const contentType =
    extension === ".mp4"
      ? "video/mp4"
      : extension === ".png"
        ? "image/png"
        : extension === ".webp"
          ? "image/webp"
          : extension === ".avif"
            ? "image/avif"
            : "image/jpeg";
  return { bytes, contentType, sha256 };
}

