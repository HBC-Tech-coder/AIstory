import assert from "node:assert/strict";

import {
  assessSteamReleaseReadiness,
  type SteamReleaseAsset,
  type SteamReleaseReadinessInput,
  type SteamReleaseVideo,
} from "@/lib/steam/releaseReadiness";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

function aiAsset(
  id: string,
  kind: SteamReleaseAsset["kind"],
): SteamReleaseAsset {
  return {
    id,
    kind,
    contentSha256: SHA_A,
    rights: {
      basis: "ai-generated",
      commercialUseAllowed: true,
      evidenceSha256: SHA_B,
      specificArtistImitation: false,
      providerOrOwner: "fixture-provider",
      termsSnapshotSha256: SHA_C,
    },
  };
}

function video(assetId: string): SteamReleaseVideo {
  return {
    assetId,
    status: "publishable",
    releasePolicy: "public",
    contentType: "video/mp4",
    videoCodec: "h264",
    hasAudio: true,
    audioCodec: "aac",
    subtitleLanguages: ["zh-CN"],
  };
}

function readyDemo(): SteamReleaseReadinessInput {
  return {
    track: "demo",
    platform: "windows-x64",
    commercialModel: "free-demo",
    earlyAccess: false,
    offlinePlayable: true,
    requiresRemoteGeneration: false,
    endingCount: 2,
    contentTargets: {
      minimumVideoAssets: 2,
      minimumMusicAssets: 1,
      minimumEndings: 2,
    },
    requiredSubtitleLanguages: ["zh-CN"],
    assets: [
      aiAsset("video-1", "video"),
      aiAsset("video-2", "video"),
      aiAsset("music-1", "music"),
    ],
    videos: [video("video-1"), video("video-2")],
  };
}

const ready = assessSteamReleaseReadiness(readyDemo());
assert.equal(ready.ready, true);
assert.deepEqual(ready.blockers, []);
assert.deepEqual(ready.summary, {
  declaredAssets: 3,
  videoAssets: 2,
  musicAssets: 1,
  endings: 2,
});

const wrongProduct = readyDemo();
wrongProduct.platform = "linux-x64";
wrongProduct.commercialModel = "paid-full";
wrongProduct.earlyAccess = true;
wrongProduct.offlinePlayable = false;
wrongProduct.requiresRemoteGeneration = true;
const wrongProductCodes = new Set(
  assessSteamReleaseReadiness(wrongProduct).blockers.map(({ code }) => code),
);
assert.ok(wrongProductCodes.has("windows-first-platform-required"));
assert.ok(wrongProductCodes.has("commercial-model-mismatch"));
assert.ok(wrongProductCodes.has("early-access-must-be-disabled"));
assert.ok(wrongProductCodes.has("offline-play-required"));
assert.ok(wrongProductCodes.has("remote-generation-not-allowed"));

const unsafeRights = readyDemo();
unsafeRights.assets = [
  {
    ...aiAsset("video-1", "video"),
    rights: {
      ...aiAsset("video-1", "video").rights,
      commercialUseAllowed: false,
      specificArtistImitation: true,
      providerOrOwner: "",
      termsSnapshotSha256: "invalid",
      attributionRequired: true,
      attributionText: "",
    },
  },
  {
    ...aiAsset("video-2", "video"),
    kind: "music",
  },
  {
    id: "music-1",
    kind: "music",
    contentSha256: SHA_A,
    rights: {
      basis: "commercial-free-license",
      commercialUseAllowed: true,
      evidenceSha256: SHA_B,
      specificArtistImitation: false,
      licenseName: "",
      licenseSourceUrl: "http://insecure.example/license",
      termsSnapshotSha256: "invalid",
    },
  },
];
const unsafeRightsCodes = new Set(
  assessSteamReleaseReadiness(unsafeRights).blockers.map(({ code }) => code),
);
assert.ok(unsafeRightsCodes.has("commercial-use-not-confirmed"));
assert.ok(unsafeRightsCodes.has("specific-artist-imitation-risk"));
assert.ok(unsafeRightsCodes.has("missing-ai-provider"));
assert.ok(unsafeRightsCodes.has("missing-ai-terms-snapshot"));
assert.ok(unsafeRightsCodes.has("missing-required-attribution"));
assert.ok(unsafeRightsCodes.has("video-asset-kind-mismatch"));
assert.ok(unsafeRightsCodes.has("missing-license-name"));
assert.ok(unsafeRightsCodes.has("invalid-license-source-url"));
assert.ok(unsafeRightsCodes.has("missing-license-snapshot"));

const invalidMedia = readyDemo();
invalidMedia.videos = [
  {
    ...video("video-1"),
    status: "review_pending",
    releasePolicy: "internal",
    videoCodec: "hevc",
    audioCodec: "pcm",
    subtitleLanguages: [],
  },
];
invalidMedia.endingCount = 0;
const invalidMediaCodes = new Set(
  assessSteamReleaseReadiness(invalidMedia).blockers.map(({ code }) => code),
);
assert.ok(invalidMediaCodes.has("video-not-publishable"));
assert.ok(invalidMediaCodes.has("video-release-policy-not-public"));
assert.ok(invalidMediaCodes.has("unsupported-video-codec"));
assert.ok(invalidMediaCodes.has("unsupported-audio-codec"));
assert.ok(invalidMediaCodes.has("missing-required-subtitle"));
assert.ok(invalidMediaCodes.has("insufficient-video-assets"));
assert.ok(invalidMediaCodes.has("insufficient-endings"));

const readyFull = readyDemo();
readyFull.track = "full";
readyFull.commercialModel = "paid-full";
assert.equal(assessSteamReleaseReadiness(readyFull).ready, true);

process.stdout.write("Steam release readiness tests passed.\n");
