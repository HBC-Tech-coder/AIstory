import "server-only";

import {
  blockedSteamLaunchCueMaterializationPreflight,
  deriveSteamLaunchCueMaterializationPreflight,
  type SteamLaunchCueMaterializationPreflightResult,
} from "@/lib/steam/launchCueMaterializationPreflight";
import {
  readSteamLaunchCueReview,
} from "@/lib/steam/launchCueReviewServer";

export type SteamLaunchCueMaterializationPreflightTestOptions = {
  cueReviewResult?: unknown;
};

async function readWithOptions(
  options?: SteamLaunchCueMaterializationPreflightTestOptions,
): Promise<SteamLaunchCueMaterializationPreflightResult> {
  try {
    const cueReviewResult =
      options && Object.prototype.hasOwnProperty.call(options, "cueReviewResult")
        ? options.cueReviewResult
        : await readSteamLaunchCueReview();
    return deriveSteamLaunchCueMaterializationPreflight(cueReviewResult);
  } catch {
    return blockedSteamLaunchCueMaterializationPreflight("cue_review_unavailable");
  }
}

export async function readSteamLaunchCueMaterializationPreflight(): Promise<SteamLaunchCueMaterializationPreflightResult> {
  return readWithOptions();
}

/** Test-only fault injection. Production callers always reread the zero-argument P1.11 reader. */
export async function readSteamLaunchCueMaterializationPreflightForTest(
  options: SteamLaunchCueMaterializationPreflightTestOptions,
): Promise<SteamLaunchCueMaterializationPreflightResult> {
  return readWithOptions(options);
}
