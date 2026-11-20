import "server-only";

import {
  deriveSteamLaunchCueReviewPreviewBundle,
} from "@/lib/steam/launchCueReviewPreviewBundle";
import { readSteamLaunchCueMaterializationPreflight } from "@/lib/steam/launchCueMaterializationPreflightServer";
import { readSteamLaunchCueReview } from "@/lib/steam/launchCueReviewServer";
import { readSteamLaunchReviewPacket } from "@/lib/steam/launchReviewPacketServer";
import { readSteamReferencePreparation } from "@/lib/steam/referencePreparationServer";
import {
  blockedSteamWindows4090LabReadiness,
  deriveSteamWindows4090LabReadiness,
  type SteamWindows4090LabControlledEvidence,
  type SteamWindows4090LabReadinessResult,
  type SteamWindows4090LabReadinessSources,
} from "@/lib/steam/windows4090LabReadiness";

export type SteamWindows4090LabReadinessTestOptions = {
  sources?: unknown;
  controlledEvidence?: SteamWindows4090LabControlledEvidence | null | unknown;
};

async function readAuthoritySources(): Promise<SteamWindows4090LabReadinessSources> {
  const [referencePreparation, reviewPacket, cueReview, materializationPreflight] =
    await Promise.all([
      readSteamReferencePreparation(),
      readSteamLaunchReviewPacket(),
      readSteamLaunchCueReview(),
      readSteamLaunchCueMaterializationPreflight(),
    ]);
  const previewBundle = deriveSteamLaunchCueReviewPreviewBundle(
    reviewPacket,
    cueReview,
    materializationPreflight,
  );
  return {
    referencePreparation,
    reviewPacket,
    cueReview,
    materializationPreflight,
    previewBundle,
  };
}

function dataProperty(value: unknown, key: string): { present: boolean; value: unknown } {
  if (!value || typeof value !== "object") return { present: false, value: undefined };
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return { present: false, value: undefined };
  if (!("value" in descriptor)) return { present: true, value: value };
  return { present: true, value: descriptor.value };
}

async function readWithOptions(
  options?: SteamWindows4090LabReadinessTestOptions,
): Promise<SteamWindows4090LabReadinessResult> {
  try {
    const sourceProperty = dataProperty(options, "sources");
    const evidenceProperty = dataProperty(options, "controlledEvidence");
    const sources = sourceProperty.present ? sourceProperty.value : await readAuthoritySources();
    const controlledEvidence = evidenceProperty.present ? evidenceProperty.value : null;
    return deriveSteamWindows4090LabReadiness(sources, controlledEvidence);
  } catch {
    return blockedSteamWindows4090LabReadiness("source_unavailable");
  }
}

/** Production always rereads frozen local authority and supplies no external evidence. */
export async function readSteamWindows4090LabReadiness(): Promise<SteamWindows4090LabReadinessResult> {
  return readWithOptions();
}

/** Test-only fault injection. It never writes, contacts a provider, or probes a GPU. */
export async function readSteamWindows4090LabReadinessForTest(
  options: SteamWindows4090LabReadinessTestOptions,
): Promise<SteamWindows4090LabReadinessResult> {
  return readWithOptions(options);
}

/** Test-only source snapshot; callers must treat the returned authority projection as private. */
export async function readSteamWindows4090LabReadinessSourcesForTest(): Promise<SteamWindows4090LabReadinessSources> {
  return readAuthoritySources();
}
