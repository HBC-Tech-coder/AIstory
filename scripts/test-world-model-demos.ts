import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  GET as getWorldModelVideo,
  HEAD as headWorldModelVideo,
} from "@/app/api/video-assets/world-model-demos/[demoId]/content/route";
import type { CaseStudyPublishedBundle } from "@/lib/case-studies/schema";
import {
  isAuthoredAiContinuationAllowed,
  isAuthoredNodePubliclyAccessible,
} from "@/lib/case-studies/schema";
import {
  coerceSceneMedia,
  isControlledSceneMediaUrl,
} from "@/lib/sceneMedia";
import { streamVideoFile } from "@/lib/video-assets/http";
import {
  WORLD_MODEL_DEMOS,
  worldModelVideoAssetPath,
  worldModelVideoDeliveryUrl,
} from "@/lib/world-model-demos/catalog";
import { WORLD_MODEL_DEMO_REWRITES } from "@/lib/world-model-demos/rewrites";
import { resolvePublishedWorldModelVideo } from "@/lib/world-model-demos/server";

const workspace = path.resolve(import.meta.dirname, "..");

assert.equal(WORLD_MODEL_DEMOS.length, 5);
assert.equal(new Set(WORLD_MODEL_DEMOS.map((demo) => demo.id)).size, 5);

const releaseManifestRaw = await readFile(
  path.join(
    workspace,
    "lib",
    "world-model-demos",
    "release-manifest.json",
  ),
  "utf8",
);
assert.doesNotMatch(
  releaseManifestRaw,
  /source|privateCopy|relativePath|localPath|providerTaskId|workflow|prompt|[A-Za-z]:\\/i,
);
const releaseManifest = JSON.parse(releaseManifestRaw) as {
  derivatives: Array<{ id: string }>;
};
assert.deepEqual(
  releaseManifest.derivatives.map(({ id }) => id).sort(),
  WORLD_MODEL_DEMOS.map(({ id }) => id).sort(),
);

for (const demo of WORLD_MODEL_DEMOS) {
  assert.match(demo.id, /^world-model-[a-z0-9-]+$/);
  assert.equal(demo.videoUrl, worldModelVideoDeliveryUrl(demo.id));
  assert.equal(isControlledSceneMediaUrl(demo.videoUrl), true);
  assert.equal(isControlledSceneMediaUrl(demo.posterUrl), true);
  assert.equal(demo.choices.length, 2);

  const storyPath = path.join(
    workspace,
    "public",
    "case-studies",
    demo.id,
    "story.json",
  );
  const raw = await readFile(storyPath, "utf8");
  assert.equal(raw.includes(worldModelVideoAssetPath(demo.id)), false);
  assert.equal(raw.split(demo.videoUrl).length - 1, 2);
  const bundle = JSON.parse(raw) as CaseStudyPublishedBundle;
  assert.equal(bundle.kind, "aistory-authored-case");
  assert.equal(bundle.card.playPath, demo.playPath);
  assert.equal(bundle.session.authoredStory?.caseStudyId, demo.id);
  assert.equal(bundle.session.authoredStory?.authorLocked, true);
  assert.equal(
    isAuthoredAiContinuationAllowed(bundle.session.authoredStory!),
    false,
  );
  assert.equal(bundle.session.history.length, 1);
  const firstScene = bundle.session.history[0]!.scene;
  const media = coerceSceneMedia(firstScene);
  assert.equal(media.kind, "video");
  assert.equal(media.kind === "video" && media.url, demo.videoUrl);
  assert.equal(media.kind === "video" && media.endBehavior, "unlock-interaction");
  assert.equal(media.kind === "video" && media.hasAudio, true);
  assert.equal(firstScene.beats.length, 1);
  const firstBeat = firstScene.beats[0]!;
  assert.equal(firstBeat.narration, demo.followUp);
  assert.equal(firstBeat.next.type, "choice");
  const choices = firstBeat.next.type === "choice" ? firstBeat.next.choices : [];
  assert.equal(choices.length, 2);
  for (const choice of choices) {
    assert.equal(choice.effect.kind, "change-scene");
    assert.ok(
      choice.effect.kind === "change-scene" &&
        choice.effect.authoredTargetNodeId,
    );
    assert.equal(
      isAuthoredNodePubliclyAccessible(
        bundle.session.authoredStory!,
        choice.effect.kind === "change-scene"
          ? choice.effect.authoredTargetNodeId!
          : "",
      ),
      true,
    );
  }
  assert.equal(raw.includes("D:\\AI-story"), false);
  assert.equal(raw.includes("D:\\AIstory"), false);
  assert.equal(raw.includes("providerTaskId"), false);
  assert.equal(raw.includes("workflowJson"), false);
  assert.equal(raw.includes("localPath"), false);

  const publishedVideo = resolvePublishedWorldModelVideo(demo.id);
  assert.ok(publishedVideo);
  const metadata = await stat(publishedVideo!.file);
  assert.equal(metadata.isFile(), true);
  assert.equal(metadata.size, publishedVideo!.bytes);
  assert.equal(
    createHash("sha256")
      .update(await readFile(publishedVideo!.file))
      .digest("hex"),
    publishedVideo!.contentHash,
  );
}

for (const unpublishedId of [
  "world-model-unpublished",
  "..",
  "../world-model-anime-sunset",
  "world-model-anime-sunset/../../private",
  "virtual-girlfriend-20260727",
]) {
  assert.equal(resolvePublishedWorldModelVideo(unpublishedId), null);
  const response = await getWorldModelVideo(
    new Request(`https://aistory.invalid/video/${encodeURIComponent(unpublishedId)}`),
    { params: Promise.resolve({ demoId: unpublishedId }) },
  );
  assert.equal(response.status, 404);
  assert.doesNotMatch(await response.text(), /public|private|content|path|file/i);
}

assert.equal(WORLD_MODEL_DEMO_REWRITES.length, WORLD_MODEL_DEMOS.length);
for (const demo of WORLD_MODEL_DEMOS) {
  assert.deepEqual(
    WORLD_MODEL_DEMO_REWRITES.find(
      (rewrite) => rewrite.destination === demo.videoUrl,
    ),
    {
      source: worldModelVideoAssetPath(demo.id).replace(".mp4", "\\.mp4"),
      destination: demo.videoUrl,
    },
  );
}
const nextConfigSource = await readFile(
  path.join(workspace, "next.config.ts"),
  "utf8",
);
assert.match(
  nextConfigSource,
  /beforeFiles:\s*WORLD_MODEL_DEMO_REWRITES/,
);
assert.match(nextConfigSource, /afterFiles:\s*\[\]/);
assert.match(nextConfigSource, /fallback:\s*\[\]/);

const fixtureRoot = await mkdtemp(
  path.join(os.tmpdir(), "aistory-world-model-range-"),
);
try {
  const fixtureFile = path.join(fixtureRoot, "synthetic.mp4");
  const fixture = Uint8Array.from({ length: 24 }, (_, index) => index);
  const fixtureHash = createHash("sha256").update(fixture).digest("hex");
  await writeFile(fixtureFile, fixture);

  const full = await streamVideoFile(
    new Request("https://aistory.invalid/video"),
    fixtureFile,
    "video/mp4",
    "private, no-store",
    fixtureHash,
    fixture.length,
  );
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("content-type"), "video/mp4");
  assert.equal(full.headers.get("content-length"), "24");
  assert.equal(full.headers.get("accept-ranges"), "bytes");
  assert.deepEqual(new Uint8Array(await full.arrayBuffer()), fixture);

  const partialRanges = [
    { value: "Bytes=0-0", contentRange: "bytes 0-0/24", body: fixture.slice(0, 1) },
    { value: "bytes=4-11", contentRange: "bytes 4-11/24", body: fixture.slice(4, 12) },
    { value: "bytes=20-", contentRange: "bytes 20-23/24", body: fixture.slice(20) },
    { value: "bytes=20-99", contentRange: "bytes 20-23/24", body: fixture.slice(20) },
    { value: "bytes=-4", contentRange: "bytes 20-23/24", body: fixture.slice(-4) },
  ];
  for (const expected of partialRanges) {
    const response = await streamVideoFile(
      new Request("https://aistory.invalid/video", {
        headers: { Range: expected.value },
      }),
      fixtureFile,
      "video/mp4",
      "private, no-store",
      fixtureHash,
      fixture.length,
    );
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-range"), expected.contentRange);
    assert.equal(
      response.headers.get("content-length"),
      String(expected.body.length),
    );
    assert.deepEqual(
      new Uint8Array(await response.arrayBuffer()),
      expected.body,
    );
  }

  for (const invalidRange of [
    "",
    "   ",
    "bytes=24-",
    "bytes=12-4",
    "bytes=0-1,4-5",
    "bytes=invalid",
    "items=0-1",
    "bytes=-0",
  ]) {
    const response = await streamVideoFile(
      new Request("https://aistory.invalid/video", {
        headers: { Range: invalidRange },
      }),
      fixtureFile,
      "video/mp4",
      "private, no-store",
      fixtureHash,
      fixture.length,
    );
    assert.equal(response.status, 416, invalidRange);
    assert.equal(response.headers.get("content-range"), "bytes */24");
    assert.equal(response.headers.get("content-length"), "0");
    assert.equal(response.headers.get("accept-ranges"), "bytes");
    assert.equal((await response.arrayBuffer()).byteLength, 0);
  }

  const head = await streamVideoFile(
    new Request("https://aistory.invalid/video", {
      method: "HEAD",
      headers: { Range: "bytes=invalid" },
    }),
    fixtureFile,
    "video/mp4",
    "private, no-store",
    fixtureHash,
    fixture.length,
  );
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), "24");
  assert.equal(head.body, null);

  await assert.rejects(
    () =>
      streamVideoFile(
        new Request("https://aistory.invalid/video", { method: "HEAD" }),
        fixtureFile,
        "video/mp4",
        "private, no-store",
        fixtureHash,
        fixture.length + 1,
      ),
    /VIDEO_FILE_METADATA_MISMATCH/,
  );
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}

const liveDemo = WORLD_MODEL_DEMOS[0]!;
const livePublishedVideo = resolvePublishedWorldModelVideo(liveDemo.id)!;
const liveHead = await headWorldModelVideo(
  new Request(`https://aistory.invalid${liveDemo.videoUrl}`, {
    method: "HEAD",
    headers: { Range: "bytes=invalid" },
  }),
  { params: Promise.resolve({ demoId: liveDemo.id }) },
);
assert.equal(liveHead.status, 200);
assert.equal(liveHead.headers.get("content-length"), String(livePublishedVideo.bytes));
assert.equal(liveHead.body, null);

const liveRange = await getWorldModelVideo(
  new Request(`https://aistory.invalid${liveDemo.videoUrl}`, {
    headers: { Range: "bytes=0-1023" },
  }),
  { params: Promise.resolve({ demoId: liveDemo.id }) },
);
assert.equal(liveRange.status, 206);
assert.equal(
  liveRange.headers.get("content-range"),
  `bytes 0-1023/${livePublishedVideo.bytes}`,
);
assert.equal((await liveRange.arrayBuffer()).byteLength, 1024);

const liveInvalidRange = await getWorldModelVideo(
  new Request(`https://aistory.invalid${liveDemo.videoUrl}`, {
    headers: { Range: `bytes=${livePublishedVideo.bytes}-` },
  }),
  { params: Promise.resolve({ demoId: liveDemo.id }) },
);
assert.equal(liveInvalidRange.status, 416);
assert.equal(
  liveInvalidRange.headers.get("content-range"),
  `bytes */${livePublishedVideo.bytes}`,
);
assert.equal(liveInvalidRange.headers.get("content-length"), "0");

console.log("world model demo catalog and authored bundles passed");
