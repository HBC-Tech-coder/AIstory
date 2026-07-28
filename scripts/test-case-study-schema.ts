import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { applyAuthoredVariableDelta, compileCaseStudyBundle, findAuthoredNode, transitionAuthoredStorySession, validateCaseStudyAssetManifest, validateCaseStudySource } from "../lib/case-studies/schema";
import { activateTimelineBranch, ensureTimeline } from "../lib/timeline";

const root = new URL("../content/case-studies/virtual-girlfriend-20260727/", import.meta.url);
const sourceRaw = JSON.parse(await readFile(new URL("virtual-girlfriend.story.json", root), "utf8"));
const manifestRaw = JSON.parse(await readFile(new URL("asset-manifest.json", root), "utf8"));
const sourceResult = validateCaseStudySource(sourceRaw, "virtual-girlfriend-20260727");
assert.equal(sourceResult.ok, true, sourceResult.ok ? "" : sourceResult.errors.join("\n"));
if (!sourceResult.ok) throw new Error(sourceResult.errors.join("\n"));
const manifestResult = validateCaseStudyAssetManifest(manifestRaw, "virtual-girlfriend-20260727");
assert.equal(manifestResult.ok, true, manifestResult.ok ? "" : manifestResult.errors.join("\n"));
if (!manifestResult.ok) throw new Error(manifestResult.errors.join("\n"));
assert.equal(sourceResult.value.interactiveGraph.nodes.length, 13);
assert.equal(sourceResult.value.interactiveGraph.nodes.reduce((total, node) => total + (node.choices?.length ?? 0), 0), 6);
const generatedAssetPaths = Object.fromEntries(
  manifestResult.value.assets
    .filter((asset) => asset.status === "generated")
    .map((asset) => [asset.assetId, `/generated/${asset.assetId}.png`]),
);
const bundle = compileCaseStudyBundle(sourceResult.value, manifestResult.value, generatedAssetPaths, "/case-studies/pending.svg");
assert.equal(bundle.card.title, "她不在出厂设定里");
const expectedGeneratedAssets = manifestResult.value.assets.filter((asset) => asset.status === "generated").length;
const expectedPendingAssets = manifestResult.value.assets.filter((asset) => asset.status === "pending_generation").length;
const expectedFailedAssets = manifestResult.value.assets.filter((asset) => asset.status === "failed").length;
assert.deepEqual(bundle.assetSummary, {
  generated: expectedGeneratedAssets,
  pending: expectedPendingAssets,
  failed: expectedFailedAssets,
});
const coverAsset = manifestResult.value.assets.find((asset) => asset.kind === "cover");
assert.equal(bundle.card.assetStatus, coverAsset?.status === "generated" ? "ready" : "pending");
assert.equal(bundle.session.authoredStory?.nodes.length, 13);
assert.deepEqual(
  bundle.session.characters[0]?.spriteStates?.map((state) => state.id),
  ["humanized_homewear", "native_android_chassis"],
);
assert.equal(
  manifestResult.value.assets.some(
    (asset) => (asset.formState ?? asset.visualState) === "native_android_chassis",
  ),
  true,
);const sourceLanjian = sourceResult.value.characters.find((character) => character.id === "lanjian");
assert.deepEqual(
  Object.keys(sourceLanjian?.visualForms ?? {}).sort(),
  ["humanized_homewear", "native_android_chassis"],
);
assert.equal(
  sourceResult.value.interactiveGraph.nodes.some(
    (node) => node.characterVisualStates?.lanjian === "native_android_chassis",
  ),
  true,
  "the authored graph must include a traceable native chassis node",
);const nativeNode = bundle.session.authoredStory?.nodes.find(
  (node) => node.characterVisualStates?.lanjian === "native_android_chassis",
);
assert.match(nativeNode?.scene.imageUrl ?? "", /vg-kf-native-reveal/);
const pendingNode = bundle.session.authoredStory?.nodes.find(
  (node) => node.sourceSceneId === "VG-S05",
);
assert.equal(
  pendingNode?.scene.imageUrl,
  "/case-studies/pending.svg",
  "a missing humanized scene must remain pending instead of borrowing an unrelated image",
);
assert.deepEqual(bundle.session.authoredStory?.variables, { intimacy: 10, trust: 15, autonomy: 20 });
const runtime = bundle.session.authoredStory!;
const choiceNode = findAuthoredNode(runtime, "vg_010_wake_offer");
assert.ok(choiceNode);
const choiceBeat = choiceNode.scene.beats.at(-1);
assert.equal(choiceBeat?.next.type, "choice");
if (choiceBeat?.next.type !== "choice") throw new Error("choice node missing choices");
const selected = choiceBeat.next.choices[0]!;
assert.equal(selected.effect.kind, "change-scene");
if (selected.effect.kind !== "change-scene") throw new Error("wrong effect");
assert.equal(selected.effect.authoredTargetNodeId, "vg_020_snooze");
assert.deepEqual(applyAuthoredVariableDelta(runtime, selected.effect.variableDelta).variables, { intimacy: 11, trust: 16, autonomy: 21 });
assert.equal(applyAuthoredVariableDelta(runtime, { autonomy: 999 }).variables.autonomy, 100);
const transitioned = transitionAuthoredStorySession(
  bundle.session,
  selected,
  {
    kind: "choice",
    choiceId: selected.id,
    label: selected.label,
    nextSceneSeed: selected.effect.nextSceneSeed,
  },
  [choiceNode.scene.entryBeatId],
).session;
assert.equal(transitioned.authoredStory?.currentNodeId, "vg_020_snooze");
assert.equal(transitioned.history.length, 2);
assert.deepEqual(transitioned.authoredStory?.variables, { intimacy: 11, trust: 16, autonomy: 21 });
assert.match(transitioned.characters[0]?.currentState?.visualStatePrompt || "", /窗帘|床边/);
const restored = JSON.parse(JSON.stringify(transitioned));
assert.equal(restored.authoredStory.currentNodeId, "vg_020_snooze");
assert.equal(restored.history.length, 2);
assert.deepEqual(restored.authoredStory.variables, { intimacy: 11, trust: 16, autonomy: 21 });

const dualStateSource = structuredClone(sourceResult.value);
const lanjian = dualStateSource.characters.find((character) => character.id === "lanjian")!;
lanjian.visualStates = [
  { id: "humanized_homewear", label: "居家拟人态", description: "成年居家拟人外观", assetId: "humanized" },
  { id: "native_android_chassis", label: "原生机体态", description: "完整公开安全机械外壳", assetId: "native" },
];
dualStateSource.interactiveGraph.nodes[0]!.characterVisualStates = { lanjian: "humanized_homewear" };
dualStateSource.interactiveGraph.nodes[2]!.characterVisualStates = { lanjian: "native_android_chassis" };
const dualBundle = compileCaseStudyBundle(
  dualStateSource,
  manifestResult.value,
  { humanized: "/humanized.png", native: "/native.png" },
  "/pending.svg",
);
assert.equal(dualBundle.session.characters[0]?.characterId, "lanjian");
assert.deepEqual(
  dualBundle.session.characters[0]?.spriteStates?.map((state) => state.id),
  ["humanized_homewear", "native_android_chassis"],
);
const voiceBefore = structuredClone(dualBundle.session.characters[0]?.voice);
const dualChoiceNode = findAuthoredNode(dualBundle.session.authoredStory!, "vg_010_wake_offer")!;
const dualChoiceBeat = dualChoiceNode.scene.beats.at(-1)!;
if (dualChoiceBeat.next.type !== "choice") throw new Error("dual choice missing");
const dualChoice = dualChoiceBeat.next.choices[0]!;
const dualTransition = transitionAuthoredStorySession(
  dualBundle.session,
  dualChoice,
  { kind: "choice", choiceId: dualChoice.id, label: dualChoice.label, nextSceneSeed: "fixture" },
  [dualChoiceNode.scene.entryBeatId],
).session;
assert.equal(dualTransition.authoredStory?.currentVisualStates?.lanjian, "native_android_chassis");
assert.equal(dualTransition.characters[0]?.currentState?.spriteStateId, "native_android_chassis");
assert.deepEqual(dualTransition.characters[0]?.voice, voiceBefore);
assert.equal(dualTransition.characters[0]?.characterId, "lanjian");
const dualTimeline = ensureTimeline(
  dualTransition,
  dualTransition.history.at(-1)!.scene.id,
  dualTransition.history.at(-1)!.scene.entryBeatId,
  [dualTransition.history.at(-1)!.scene.entryBeatId],
);
const timelineSession = { ...dualTransition, timeline: dualTimeline };
const mutatedAfterCheckpoint = structuredClone(timelineSession);
mutatedAfterCheckpoint.authoredStory!.currentVisualStates = { lanjian: "humanized_homewear" };
mutatedAfterCheckpoint.characters[0]!.currentState!.spriteStateId = "humanized_homewear";
const restoredTimelineSession = activateTimelineBranch(
  mutatedAfterCheckpoint,
  dualTimeline.activeBranchId,
);
assert.equal(
  restoredTimelineSession.authoredStory?.currentVisualStates?.lanjian,
  "native_android_chassis",
  "timeline restore must preserve authored visual state",
);
assert.equal(
  restoredTimelineSession.characters[0]?.currentState?.spriteStateId,
  "native_android_chassis",
  "timeline restore must preserve character sprite state",
);
assert.deepEqual(restoredTimelineSession.characters[0]?.voice, voiceBefore);
const badGraph = structuredClone(sourceRaw);
badGraph.interactiveGraph.nodes[1].choices[0].targetNodeId = "missing";
const badGraphResult = validateCaseStudySource(badGraph);
assert.equal(badGraphResult.ok, false);
assert.match(badGraphResult.errors.join("\n"), /targetNodeId/);
const badManifest = structuredClone(manifestRaw);
badManifest.assets[0].status = "generated";
badManifest.assets[0].localPath = null;
const badManifestResult = validateCaseStudyAssetManifest(badManifest);
assert.equal(badManifestResult.ok, false);
assert.match(badManifestResult.errors.join("\n"), /localPath/);
console.log("Virtual Girlfriend case-study schema tests passed.");
