import "server-only";

import path from "node:path";

import publicReleaseManifest from "./release-manifest.json";
import {
  getWorldModelDemo,
  worldModelVideoAssetPath,
  worldModelVideoDeliveryUrl,
} from "./catalog";

type WorldModelImportManifest = {
  schemaVersion: number;
  derivatives: Array<{
    id: string;
    publicVideo: {
      url: string;
      bytes: number;
      sha256: string;
    };
  }>;
};

export type PublishedWorldModelVideo = {
  id: string;
  file: string;
  contentType: "video/mp4";
  bytes: number;
  contentHash: string;
};

const manifest = publicReleaseManifest as WorldModelImportManifest;

export function resolvePublishedWorldModelVideo(
  demoId: string,
): PublishedWorldModelVideo | null {
  const demo = getWorldModelDemo(demoId);
  if (!demo || demo.videoUrl !== worldModelVideoDeliveryUrl(demo.id)) {
    return null;
  }

  const derivative = manifest.derivatives.find((entry) => entry.id === demo.id);
  const expectedAssetPath = worldModelVideoAssetPath(demo.id);
  if (
    manifest.schemaVersion !== 1 ||
    !derivative ||
    derivative.publicVideo.url !== expectedAssetPath ||
    !Number.isSafeInteger(derivative.publicVideo.bytes) ||
    derivative.publicVideo.bytes <= 0 ||
    !/^[a-f0-9]{64}$/.test(derivative.publicVideo.sha256)
  ) {
    return null;
  }

  const publicRoot = path.resolve(process.cwd(), "public");
  const file = path.resolve(
    publicRoot,
    expectedAssetPath.replace(/^\/+/, ""),
  );
  const relative = path.relative(publicRoot, file);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }

  return {
    id: demo.id,
    file,
    contentType: "video/mp4",
    bytes: derivative.publicVideo.bytes,
    contentHash: derivative.publicVideo.sha256,
  };
}
