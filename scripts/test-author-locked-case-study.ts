import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  compileCaseStudyBundle,
  isAuthoredAiContinuationAllowed,
  isAuthoredNodePubliclyAccessible,
  transitionAuthoredStorySession,
  validateCaseStudyAssetManifest,
  validateCaseStudySource,
} from "../lib/case-studies/schema";
import { activateTimelineBranch, ensureTimeline } from "../lib/timeline";

const root = new URL(
  "../content/case-studies/virtual-girlfriend-20260727/",
  import.meta.url,
);
const sourceRaw = JSON.parse(
  await readFile(new URL("virtual-girlfriend.story.json", root), "utf8"),
);
const manifestRaw = JSON.parse(
  await readFile(new URL("asset-manifest.json", root), "utf8"),
);

const fixture = structuredClone(sourceRaw);
fixture.authorLocked = true;
fixture.releaseVersion = "v1.1";
fixture.aiContinuationBoundary = {
  afterNodeId: fixture.interactiveGraph.nodes.at(-2).nodeId,
};
for (const [index, node] of fixture.interactiveGraph.nodes.entries()) {
  node.episodeId = `episode-${Math.floor(index / 4) + 1}`;
  node.sourceParagraphIds = [`source-p-${index + 1}`];
  for (const choice of node.choices ?? []) {
    choice.label = `【选项】${choice.label}`;
  }
}
const firstChoiceNode = fixture.interactiveGraph.nodes.find(
  (node: { choices?: unknown[] }) => node.choices?.length,
);
assert.ok(firstChoiceNode);
const restrictedTargetId = firstChoiceNode.choices[0].targetNodeId;
const restrictedNode = fixture.interactiveGraph.nodes.find(
  (node: { nodeId: string }) => node.nodeId === restrictedTargetId,
);
assert.ok(restrictedNode);
restrictedNode.restricted = true;
restrictedNode.releasePolicy = "restricted";
fixture.releasePolicy = {
  defaultAccess: "public",
  restrictedNodeIds: [restrictedTargetId],
  allowedAudiences: ["internal", "enterprise"],
};

const sourceResult = validateCaseStudySource(
  fixture,
  "virtual-girlfriend-20260727",
);
assert.equal(sourceResult.ok, true, sourceResult.ok ? "" : sourceResult.errors.join("\n"));
if (!sourceResult.ok) throw new Error(sourceResult.errors.join("\n"));
const manifestResult = validateCaseStudyAssetManifest(
  manifestRaw,
  "virtual-girlfriend-20260727",
);
assert.equal(manifestResult.ok, true);
if (!manifestResult.ok) throw new Error(manifestResult.errors.join("\n"));

const authoredLabels = sourceResult.value.interactiveGraph.nodes.flatMap(
  (node) => node.choices?.map((choice) => choice.label) ?? [],
);
const authoredChoiceIds = new Set(
  sourceResult.value.interactiveGraph.nodes.flatMap(
    (node) => node.choices?.map((choice) => choice.choiceId) ?? [],
  ),
);
const assetPaths = Object.fromEntries(
  manifestResult.value.assets
    .filter((asset) => asset.status === "generated")
    .map((asset) => [asset.assetId, `/fixture/${asset.assetId}.png`]),
);
const bundle = compileCaseStudyBundle(
  sourceResult.value,
  manifestResult.value,
  assetPaths,
  "/case-studies/pending.svg",
);
const runtime = bundle.session.authoredStory!;
const compiledLabels = runtime.nodes.flatMap((node) =>
  node.scene.beats.flatMap((beat) =>
    beat.next.type === "choice"
      ? beat.next.choices
          .filter((choice) => authoredChoiceIds.has(choice.id))
          .map((choice) => choice.label)
      : [],
  ),
);
assert.deepEqual(compiledLabels, authoredLabels);
assert.equal(runtime.authorLocked, true);
assert.equal(runtime.version, "author-locked-v1.1");
assert.equal(bundle.session.cacheIdentity?.version, runtime.version);
assert.deepEqual(runtime.releasePolicy?.restrictedNodeIds, [restrictedTargetId]);
assert.equal(isAuthoredNodePubliclyAccessible(runtime, restrictedTargetId), false);
assert.equal(isAuthoredAiContinuationAllowed(runtime), false);

const boundaryNodeId =
  typeof runtime.aiContinuationBoundary === "string"
    ? runtime.aiContinuationBoundary
    : runtime.aiContinuationBoundary?.afterNodeId;
assert.ok(boundaryNodeId);
const afterBoundary = structuredClone(runtime);
afterBoundary.visitedNodeIds.push(boundaryNodeId);
afterBoundary.currentNodeId = runtime.nodes.at(-1)!.nodeId;
assert.equal(isAuthoredAiContinuationAllowed(afterBoundary), true);

const choiceBeat = runtime.nodes
  .find((node) => node.nodeId === firstChoiceNode.nodeId)!
  .scene.beats.at(-1)!;
assert.equal(choiceBeat.next.type, "choice");
if (choiceBeat.next.type !== "choice") throw new Error("fixture choice missing");
const restrictedChoice = choiceBeat.next.choices[0]!;
assert.throws(
  () =>
    transitionAuthoredStorySession(
      bundle.session,
      restrictedChoice,
      {
        kind: "choice",
        choiceId: restrictedChoice.id,
        label: restrictedChoice.label,
        nextSceneSeed:
          restrictedChoice.effect.kind === "change-scene"
            ? restrictedChoice.effect.nextSceneSeed
            : "",
      },
      [choiceBeat.id],
    ),
  /未向公开版本发行/,
);

const timeline = ensureTimeline(
  bundle.session,
  bundle.session.history[0]!.scene.id,
  bundle.session.history[0]!.scene.entryBeatId,
  [bundle.session.history[0]!.scene.entryBeatId],
);
const timelineSession = { ...bundle.session, timeline };
const restored = activateTimelineBranch(timelineSession, timeline.activeBranchId);
assert.equal(restored.authoredStory?.authorLocked, true);
assert.deepEqual(
  restored.authoredStory?.nodes[0]?.sourceParagraphIds,
  ["source-p-1"],
);
assert.deepEqual(restored.authoredStory?.releasePolicy, runtime.releasePolicy);

const missingTrace = structuredClone(fixture);
delete missingTrace.interactiveGraph.nodes[0].sourceParagraphIds;
const missingTraceResult = validateCaseStudySource(missingTrace);
assert.equal(missingTraceResult.ok, false);
assert.match(missingTraceResult.errors.join("\n"), /sourceParagraphIds/);

const alteredChoice = structuredClone(fixture);
alteredChoice.interactiveGraph.nodes
  .find((node: { choices?: unknown[] }) => node.choices?.length)
  .choices[0].label = "丢失原稿选项标记";
const alteredChoiceResult = validateCaseStudySource(alteredChoice);
assert.equal(alteredChoiceResult.ok, false);
assert.match(alteredChoiceResult.errors.join("\n"), /完整【选项】/);

const missingBoundary = structuredClone(fixture);
delete missingBoundary.aiContinuationBoundary;
const missingBoundaryResult = validateCaseStudySource(missingBoundary);
assert.equal(missingBoundaryResult.ok, false);
assert.match(missingBoundaryResult.errors.join("\n"), /aiContinuationBoundary/);

const missingPolicy = structuredClone(fixture);
delete missingPolicy.releasePolicy;
const missingPolicyResult = validateCaseStudySource(missingPolicy);
assert.equal(missingPolicyResult.ok, false);
assert.match(missingPolicyResult.errors.join("\n"), /releasePolicy/);

const playerSource = await readFile(
  new URL("../app/[locale]/play/page.tsx", import.meta.url),
  "utf8",
);
assert.match(
  playerSource,
  /requestScene as requestSceneUnsafe/,
  "all /api/scene requests must pass the author-lock wrapper",
);
assert.equal(
  playerSource.match(/requestSceneUnsafe\(/g)?.length,
  1,
  "the unsafe scene client must only be called inside the central wrapper",
);
assert.match(
  playerSource,
  /!choice\.effect\.authoredTargetNodeId/,
  "authored local choices must be excluded from speculative AI prefetch",
);assert.match(
  playerSource,
  /saved\.authoredStory\.version === publishedVersion/,
  "legacy saves must be isolated from a newer author-locked release",
);
assert.ok(
  (playerSource.match(/isAuthoredAiContinuationAllowed/g)?.length ?? 0) >= 6,
  "freeform, vision, rewrite, prefetch, choice and replay paths must share the lock gate",
);
console.log("Author-locked case-study contract tests passed.");
