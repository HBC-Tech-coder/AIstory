import "server-only";

import { listStoredGenerationJobs } from "@/lib/generation-jobs/store";
import { listProjectAssets } from "@/lib/project-assets/repository";

import type { ParkReaders } from "./types";

/**
 * The only real (read-only) integration point.
 *
 * It imports exactly the two side-effect-free store readers. It never imports
 * the scheduler/server modules, never initializes the queue, and exposes no
 * generate / cancel / asset-write path.
 */
export function createRealParkReaders(): ParkReaders {
  return {
    jobs: {
      listJobs: () => listStoredGenerationJobs(),
    },
    assets: {
      listAssets: (projectId: number) => listProjectAssets(projectId),
    },
  };
}
