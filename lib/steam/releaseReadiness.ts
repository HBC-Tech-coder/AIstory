import type { SteamReleasePlatform } from "@/lib/steam/contracts";
import type {
  VideoAssetReleasePolicy,
  VideoAssetStatus,
} from "@/lib/video-assets/types";

export const STEAM_WINDOWS_FIRST_RELEASE_MODEL = Object.freeze({
  platform: "windows-x64" as const,
  demoCommercialModel: "free-demo" as const,
  fullCommercialModel: "paid-full" as const,
  earlyAccess: false,
});

export type SteamReleaseTrack = "demo" | "full";
export type SteamCommercialModel = "free-demo" | "paid-full";
export type SteamReleaseAssetKind =
  | "video"
  | "music"
  | "voice"
  | "image"
  | "font";
export type SteamRightsBasis =
  | "ai-generated"
  | "commercial-free-license"
  | "owned-original"
  | "commissioned";

export type SteamRightsEvidence = {
  basis: SteamRightsBasis;
  commercialUseAllowed: boolean;
  evidenceSha256: string;
  specificArtistImitation: boolean;
  providerOrOwner?: string;
  termsSnapshotSha256?: string;
  licenseName?: string;
  licenseSourceUrl?: string;
  attributionRequired?: boolean;
  attributionText?: string;
};

export type SteamReleaseAsset = {
  id: string;
  kind: SteamReleaseAssetKind;
  contentSha256: string;
  rights: SteamRightsEvidence;
};

export type SteamReleaseVideo = {
  assetId: string;
  status: VideoAssetStatus;
  releasePolicy: VideoAssetReleasePolicy;
  contentType: "video/mp4" | "video/webm";
  videoCodec: string;
  hasAudio: boolean;
  audioCodec?: string;
  subtitleLanguages: readonly string[];
};

export type SteamReleaseReadinessInput = {
  track: SteamReleaseTrack;
  platform: SteamReleasePlatform;
  commercialModel: SteamCommercialModel;
  earlyAccess: boolean;
  offlinePlayable: boolean;
  requiresRemoteGeneration: boolean;
  endingCount: number;
  contentTargets: {
    minimumVideoAssets: number;
    minimumMusicAssets: number;
    minimumEndings: number;
  };
  requiredSubtitleLanguages: readonly string[];
  assets: readonly SteamReleaseAsset[];
  videos: readonly SteamReleaseVideo[];
};

export type SteamReleaseReadinessIssueCode =
  | "windows-first-platform-required"
  | "commercial-model-mismatch"
  | "early-access-must-be-disabled"
  | "offline-play-required"
  | "remote-generation-not-allowed"
  | "invalid-content-target"
  | "insufficient-video-assets"
  | "insufficient-music-assets"
  | "insufficient-endings"
  | "duplicate-asset-id"
  | "invalid-content-sha256"
  | "invalid-rights-evidence-sha256"
  | "commercial-use-not-confirmed"
  | "specific-artist-imitation-risk"
  | "missing-ai-provider"
  | "missing-ai-terms-snapshot"
  | "missing-license-name"
  | "invalid-license-source-url"
  | "missing-license-snapshot"
  | "missing-required-attribution"
  | "duplicate-video-asset-id"
  | "video-asset-not-declared"
  | "video-asset-kind-mismatch"
  | "video-not-publishable"
  | "video-release-policy-not-public"
  | "unsupported-video-codec"
  | "unsupported-audio-codec"
  | "missing-required-subtitle";

export type SteamReleaseReadinessIssue = {
  code: SteamReleaseReadinessIssueCode;
  assetId?: string;
  detail?: string;
};

export type SteamReleaseReadinessResult = {
  ready: boolean;
  blockers: SteamReleaseReadinessIssue[];
  summary: {
    declaredAssets: number;
    videoAssets: number;
    musicAssets: number;
    endings: number;
  };
};

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

function isHttpsUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

function normalizeCodec(value: string | undefined): string {
  return value?.trim().toLowerCase() || "";
}

function expectedCommercialModel(
  track: SteamReleaseTrack,
): SteamCommercialModel {
  return track === "demo" ? "free-demo" : "paid-full";
}

export function assessSteamReleaseReadiness(
  input: SteamReleaseReadinessInput,
): SteamReleaseReadinessResult {
  const blockers: SteamReleaseReadinessIssue[] = [];
  const add = (
    code: SteamReleaseReadinessIssueCode,
    assetId?: string,
    detail?: string,
  ) => blockers.push({ code, assetId, detail });

  if (input.platform !== STEAM_WINDOWS_FIRST_RELEASE_MODEL.platform) {
    add("windows-first-platform-required");
  }
  if (input.commercialModel !== expectedCommercialModel(input.track)) {
    add("commercial-model-mismatch");
  }
  if (input.earlyAccess) add("early-access-must-be-disabled");
  if (!input.offlinePlayable) add("offline-play-required");
  if (input.requiresRemoteGeneration) add("remote-generation-not-allowed");

  const targets = input.contentTargets;
  if (
    !Number.isSafeInteger(targets.minimumVideoAssets) ||
    targets.minimumVideoAssets < 1 ||
    !Number.isSafeInteger(targets.minimumMusicAssets) ||
    targets.minimumMusicAssets < 0 ||
    !Number.isSafeInteger(targets.minimumEndings) ||
    targets.minimumEndings < 1
  ) {
    add("invalid-content-target");
  }

  const assetById = new Map<string, SteamReleaseAsset>();
  for (const asset of input.assets) {
    const assetId = asset.id.trim();
    if (!assetId || assetById.has(assetId)) {
      add("duplicate-asset-id", assetId || undefined);
      continue;
    }
    assetById.set(assetId, asset);
    if (!SHA256_PATTERN.test(asset.contentSha256)) {
      add("invalid-content-sha256", assetId);
    }
    if (!SHA256_PATTERN.test(asset.rights.evidenceSha256)) {
      add("invalid-rights-evidence-sha256", assetId);
    }
    if (!asset.rights.commercialUseAllowed) {
      add("commercial-use-not-confirmed", assetId);
    }
    if (asset.rights.specificArtistImitation) {
      add("specific-artist-imitation-risk", assetId);
    }
    if (asset.rights.attributionRequired && !asset.rights.attributionText?.trim()) {
      add("missing-required-attribution", assetId);
    }
    if (asset.rights.basis === "ai-generated") {
      if (!asset.rights.providerOrOwner?.trim()) {
        add("missing-ai-provider", assetId);
      }
      if (!SHA256_PATTERN.test(asset.rights.termsSnapshotSha256 || "")) {
        add("missing-ai-terms-snapshot", assetId);
      }
    }
    if (asset.rights.basis === "commercial-free-license") {
      if (!asset.rights.licenseName?.trim()) {
        add("missing-license-name", assetId);
      }
      if (!isHttpsUrl(asset.rights.licenseSourceUrl)) {
        add("invalid-license-source-url", assetId);
      }
      if (!SHA256_PATTERN.test(asset.rights.termsSnapshotSha256 || "")) {
        add("missing-license-snapshot", assetId);
      }
    }
  }

  const videoIds = new Set<string>();
  const requiredSubtitleLanguages = new Set(
    input.requiredSubtitleLanguages.map((value) => value.trim()).filter(Boolean),
  );
  for (const video of input.videos) {
    const assetId = video.assetId.trim();
    if (!assetId || videoIds.has(assetId)) {
      add("duplicate-video-asset-id", assetId || undefined);
      continue;
    }
    videoIds.add(assetId);
    const asset = assetById.get(assetId);
    if (!asset) {
      add("video-asset-not-declared", assetId);
    } else if (asset.kind !== "video") {
      add("video-asset-kind-mismatch", assetId);
    }
    if (video.status !== "publishable") {
      add("video-not-publishable", assetId);
    }
    if (video.releasePolicy !== "public") {
      add("video-release-policy-not-public", assetId);
    }

    const videoCodec = normalizeCodec(video.videoCodec);
    const videoCodecReady =
      (video.contentType === "video/mp4" &&
        ["h264", "avc", "avc1"].includes(videoCodec)) ||
      (video.contentType === "video/webm" &&
        ["vp9", "vp09"].includes(videoCodec));
    if (!videoCodecReady) add("unsupported-video-codec", assetId);

    if (video.hasAudio) {
      const audioCodec = normalizeCodec(video.audioCodec);
      const audioCodecReady =
        (video.contentType === "video/mp4" &&
          ["aac", "mp4a"].includes(audioCodec)) ||
        (video.contentType === "video/webm" && audioCodec === "opus");
      if (!audioCodecReady) add("unsupported-audio-codec", assetId);
    }

    const subtitleLanguages = new Set(
      video.subtitleLanguages.map((value) => value.trim()).filter(Boolean),
    );
    for (const language of requiredSubtitleLanguages) {
      if (!subtitleLanguages.has(language)) {
        add("missing-required-subtitle", assetId, language);
      }
    }
  }

  const musicAssets = input.assets.filter((asset) => asset.kind === "music");
  if (input.videos.length < targets.minimumVideoAssets) {
    add("insufficient-video-assets");
  }
  if (musicAssets.length < targets.minimumMusicAssets) {
    add("insufficient-music-assets");
  }
  if (input.endingCount < targets.minimumEndings) {
    add("insufficient-endings");
  }

  return {
    ready: blockers.length === 0,
    blockers,
    summary: {
      declaredAssets: input.assets.length,
      videoAssets: input.videos.length,
      musicAssets: musicAssets.length,
      endings: input.endingCount,
    },
  };
}
