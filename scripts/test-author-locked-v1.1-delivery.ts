import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import {
  compileCaseStudyBundle,
  findAuthoredNode,
  isAuthoredAiContinuationAllowed,
  transitionAuthoredStorySession,
  validateCaseStudyAssetManifest,
  validateCaseStudySource,
} from "../lib/case-studies/schema";
import {
  forkTimelineAtDecision,
  recordTimelineDecision,
} from "../lib/timeline";

type TraceParagraph = {
  paragraphId: string;
  documentIndex: number;
  text: string;
  nodeId: string;
};

type TraceBracketToken = {
  paragraphId: string;
  text: string;
  verbatim: string;
  classification: string;
  nodeId: string;
};

type Traceability = {
  schemaVersion: number;
  caseStudyId: string;
  releaseVersion: string;
  coverage: {
    coveredParagraphs: number;
    missingParagraphs: string[];
    duplicateParagraphs: string[];
    bracketTokens: number;
    trueChoiceTokens: number;
  };
  paragraphs: TraceParagraph[];
  bracketTokens: TraceBracketToken[];
};

const root = new URL(
  "../content/case-studies/virtual-girlfriend-20260727/author-locked-v1.1/",
  import.meta.url,
);
const [sourceRaw, manifestRaw, traceRaw] = await Promise.all([
  readFile(
    new URL("virtual-girlfriend.author-locked.v1.1.story.json", root),
    "utf8",
  ).then(JSON.parse),
  readFile(new URL("asset-manifest.v1.1.json", root), "utf8").then(JSON.parse),
  readFile(new URL("source-traceability.v1.1.json", root), "utf8").then(
    JSON.parse,
  ),
]);

const sourceResult = validateCaseStudySource(
  sourceRaw,
  "virtual-girlfriend-20260727",
);
assert.equal(sourceResult.ok, true, sourceResult.ok ? "" : sourceResult.errors.join("\n"));
if (!sourceResult.ok) throw new Error(sourceResult.errors.join("\n"));
const source = sourceResult.value;
assert.equal(source.authorLocked, true);
assert.equal(source.releaseVersion, "v1.1");
assert.deepEqual(source.aiContinuationBoundary, {
  afterNodeId: "vg11_ep1_reflection",
});

const manifestResult = validateCaseStudyAssetManifest(
  manifestRaw,
  "virtual-girlfriend-20260727",
);
assert.equal(manifestResult.ok, true, manifestResult.ok ? "" : manifestResult.errors.join("\n"));
if (!manifestResult.ok) throw new Error(manifestResult.errors.join("\n"));
assert.equal(manifestResult.value.releaseVersion, "v1.1");

const trace = traceRaw as Traceability;
assert.equal(trace.caseStudyId, "virtual-girlfriend-20260727");
assert.equal(trace.releaseVersion, "v1.1");
assert.equal(trace.coverage.coveredParagraphs, 180);
assert.deepEqual(trace.coverage.missingParagraphs, []);
assert.deepEqual(trace.coverage.duplicateParagraphs, []);
assert.equal(trace.paragraphs.length, 180);

const nodeParagraphIds = source.interactiveGraph.nodes.flatMap(
  (node) => node.sourceParagraphIds ?? [],
);
const traceParagraphIds = trace.paragraphs.map(
  (paragraph) => paragraph.paragraphId,
);
assert.equal(nodeParagraphIds.length, 180);
assert.equal(new Set(nodeParagraphIds).size, 180);
assert.equal(new Set(traceParagraphIds).size, 180);
assert.deepEqual(
  [...nodeParagraphIds].sort(),
  [...traceParagraphIds].sort(),
  "source graph and traceability matrix must cover the same 180 paragraphs",
);
for (const paragraph of trace.paragraphs) {
  const node = source.interactiveGraph.nodes.find(
    (candidate) => candidate.nodeId === paragraph.nodeId,
  );
  assert.ok(node, `${paragraph.paragraphId} references an unknown node`);
  assert.ok(
    node.sourceParagraphIds?.includes(paragraph.paragraphId),
    `${paragraph.paragraphId} is missing from its authored node`,
  );
}

const authoredChoices = source.interactiveGraph.nodes.flatMap((node) =>
  (node.choices ?? []).map((choice) => ({
    nodeId: node.nodeId,
    id: choice.choiceId,
    label: choice.label,
  })),
);
const tracedChoices = trace.bracketTokens.filter(
  (token) => token.classification === "choice",
);
assert.equal(authoredChoices.length, 13);
assert.equal(tracedChoices.length, 13);
assert.equal(trace.coverage.trueChoiceTokens, 13);
const traceChoiceKeys = new Set(
  tracedChoices.map((token) => `${token.nodeId}\u0000${token.text}`),
);
for (const choice of authoredChoices) {
  assert.match(choice.label, /^【选项】\S/);
  assert.ok(
    traceChoiceKeys.has(
      `${choice.nodeId}\u0000${choice.label.slice("【选项】".length)}`,
    ),
    `${choice.id} does not match the original traceability token`,
  );
}
const openingChoices = authoredChoices
  .filter((choice) => choice.nodeId === "vg11_wake_choice")
  .map((choice) => choice.label);
assert.deepEqual(openingChoices, [
  "【选项】我想再睡会",
  "【选项】拉我起床",
]);

const restrictedNodeIds = new Set(
  source.releasePolicy?.restrictedNodeIds ?? [],
);
const publicSourceNodes = source.interactiveGraph.nodes.filter(
  (node) =>
    node.releasePolicy === "public" &&
    node.restricted !== true &&
    !restrictedNodeIds.has(node.nodeId),
);
assert.equal(publicSourceNodes.length, 7);
const publicAssetPaths = Object.fromEntries(
  manifestResult.value.assets
    .filter(
      (asset) =>
        asset.status === "generated" &&
        (asset.releasePolicy === undefined ||
          asset.releasePolicy === "public"),
    )
    .map((asset) => [asset.assetId, `/fixture/${asset.assetId}.png`]),
);
const bundle = compileCaseStudyBundle(
  source,
  manifestResult.value,
  publicAssetPaths,
  "/case-studies/pending.svg",
);
const runtime = bundle.session.authoredStory!;
assert.equal(runtime.version, "author-locked-v1.1");
assert.equal(bundle.session.cacheIdentity?.version, "author-locked-v1.1");
assert.deepEqual(
  runtime.nodes.map((node) => node.nodeId),
  publicSourceNodes.map((node) => node.nodeId),
);
assert.ok(runtime.nodes.every((node) => node.releasePolicy === "public"));
assert.ok(
  runtime.nodes.every((node) => !restrictedNodeIds.has(node.nodeId)),
);
assert.deepEqual(bundle.assetSummary, {
  generated: 8,
  pending: 0,
  failed: 0,
  restricted: 5,
});
assert.equal(isAuthoredAiContinuationAllowed(runtime), false);
const afterBoundary = structuredClone(runtime);
afterBoundary.visitedNodeIds.push("vg11_ep1_reflection");
afterBoundary.currentNodeId = "vg11_ep1_reflection";
assert.equal(isAuthoredAiContinuationAllowed(afterBoundary), true);

const startNode = findAuthoredNode(runtime, "vg11_wake_choice");
assert.ok(startNode);
const choiceBeat = startNode.scene.beats.at(-1)!;
assert.equal(choiceBeat.next.type, "choice");
if (choiceBeat.next.type !== "choice") throw new Error("opening choices missing");
const selectedChoice = choiceBeat.next.choices[0]!;
const visited = startNode.scene.beats.map((beat) => beat.id);
const withDecision = recordTimelineDecision(
  bundle.session,
  startNode.scene,
  choiceBeat,
  selectedChoice,
  visited,
);
const decision = withDecision.timeline!.decisions[0]!;
const forked = forkTimelineAtDecision(
  withDecision,
  decision.id,
  selectedChoice.id,
);
const exit = {
  kind: "choice" as const,
  choiceId: selectedChoice.id,
  label: selectedChoice.label,
  nextSceneSeed:
    selectedChoice.effect.kind === "change-scene"
      ? selectedChoice.effect.nextSceneSeed
      : "",
};
const transitioned = transitionAuthoredStorySession(
  forked.session,
  selectedChoice,
  exit,
  visited,
).session;
assert.equal(transitioned.authoredStory?.currentNodeId, "vg11_wake_sleep");
assert.equal(transitioned.timeline?.branches.length, 2);
assert.equal(transitioned.history.length, 2);

const playerSource = await readFile(
  new URL("../app/[locale]/play/page.tsx", import.meta.url),
  "utf8",
);
assert.equal(playerSource.match(/requestSceneUnsafe\(/g)?.length, 1);
assert.match(playerSource, /!choice\.effect\.authoredTargetNodeId/);
assert.match(
  playerSource,
  /saved\.authoredStory\.version === publishedVersion/,
);

const publicBundleRaw = JSON.parse(
  await readFile(
    new URL(
      "../public/case-studies/virtual-girlfriend-20260727/story.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
assert.equal(
  publicBundleRaw.session.authoredStory.version,
  "author-locked-v1.1",
);
assert.ok(
  publicBundleRaw.session.authoredStory.nodes.every(
    (node: { releasePolicy?: string; restricted?: boolean }) =>
      node.releasePolicy === "public" && node.restricted !== true,
  ),
);
assert.ok(
  publicBundleRaw.session.authoredStory.nodes.every(
    (node: { nodeId: string }) => !restrictedNodeIds.has(node.nodeId),
  ),
);
const publicAssetFiles = await readdir(
  new URL(
    "../public/case-studies/virtual-girlfriend-20260727/assets/",
    import.meta.url,
  ),
);
for (const asset of manifestResult.value.assets.filter(
  (candidate) =>
    candidate.releasePolicy !== undefined &&
    candidate.releasePolicy !== "public",
)) {
  assert.equal(
    publicAssetFiles.some((file) => file.startsWith(`${asset.assetId}.`)),
    false,
    `${asset.assetId} must not enter public assets`,
  );
}
console.log("Author-locked v1.1 delivery tests passed.");
