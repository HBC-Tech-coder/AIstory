import {
  WORLD_MODEL_DEMOS,
  worldModelVideoAssetPath,
} from "./catalog";

export const WORLD_MODEL_DEMO_REWRITES = WORLD_MODEL_DEMOS.map((demo) => ({
  source: worldModelVideoAssetPath(demo.id).replace(".mp4", "\\.mp4"),
  destination: demo.videoUrl,
}));
