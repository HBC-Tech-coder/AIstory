import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  applyCaseReviewDecision,
  parseCaseReviewManifest,
  readCaseReviewSnapshot,
} from "../lib/case-studies/reviewAssets";

const manifestUrl = new URL(
  "../content/case-studies/virtual-girlfriend-20260727/author-locked-v1.1/doubao-renders/20260728-review/manifest.review.json",
  import.meta.url,
);
const raw = JSON.parse(await readFile(manifestUrl, "utf8")) as unknown;
const parsed = parseCaseReviewManifest(raw);
const snapshot = await readCaseReviewSnapshot();

assert.equal(parsed.caseStudyId, "virtual-girlfriend-20260727");
assert.equal(snapshot.caseStudyId, parsed.caseStudyId);
assert.equal(snapshot.items.length, parsed.items.length);
assert.equal(
  Object.values(snapshot.counts).reduce((sum, count) => sum + count, 0),
  snapshot.items.length,
);
assert.equal(
  JSON.stringify(snapshot).includes("source"),
  false,
  "client snapshot must not disclose source prompts or conversation metadata",
);
assert.equal(
  JSON.stringify(snapshot).includes("doubao-renders"),
  false,
  "client snapshot must not disclose local filesystem paths",
);
assert.ok(snapshot.items.every((item) => item.previewUrl.startsWith("/api/")));

const next = applyCaseReviewDecision(
  parsed,
  parsed.items[0]!.id,
  "approved_candidate",
  "本地单元测试，不写回真实清单。",
  "2026-07-28T00:00:00.000Z",
);
assert.equal(
  next.items[0]!.review?.publicationStatus,
  "approved_candidate",
);
assert.equal(parsed.items[0]!.review?.publicationStatus, undefined);
assert.throws(
  () => parseCaseReviewManifest({ ...raw, caseStudyId: "other-case" }),
  /Unexpected case study id/,
);

console.log("case asset review tests passed");

