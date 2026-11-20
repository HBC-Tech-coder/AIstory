import type { SharedStoryVisibility } from "./clientProjection";

/**
 * Owner-lookup outcome for a save. `unknown` means the owner list could not be
 * verified (network/server/parse failure), so publishing MUST abort: silently
 * omitting visibility would let the server default an existing hidden work to
 * public.
 */
export type PublishLookup =
  | { status: "login" }
  | { status: "unknown" }
  | { status: "missing" }
  | {
      status: "found";
      item: { visibility: SharedStoryVisibility; revision: number };
    };

export type PublishSubmission =
  | { type: "abort"; reason: "login" | "unknown" }
  | {
      type: "submit";
      visibility: SharedStoryVisibility;
      /** New work always sends an explicit visibility; updates omit it when unchanged. */
      includeVisibility: boolean;
      expectedRevision?: number;
    };

/**
 * Pure decision for what (if anything) the panel should POST.
 *
 * - login / unknown owner lookup → abort before any POST.
 * - brand-new work → always explicit selected visibility (including hidden).
 * - existing work, untouched select → omit visibility, preserving the saved
 *   value (in particular, a hidden work stays hidden even though the select
 *   defaults to public).
 * - existing work, select explicitly changed → send the new visibility with the
 *   known revision.
 */
export function resolvePublishSubmission(
  lookup: PublishLookup,
  selectedVisibility: SharedStoryVisibility,
  visibilityTouched: boolean,
): PublishSubmission {
  if (lookup.status === "login") {
    return { type: "abort", reason: "login" };
  }
  if (lookup.status === "unknown") {
    return { type: "abort", reason: "unknown" };
  }

  if (lookup.status === "found") {
    return {
      type: "submit",
      visibility: visibilityTouched ? selectedVisibility : lookup.item.visibility,
      includeVisibility: visibilityTouched,
      expectedRevision: lookup.item.revision,
    };
  }

  return {
    type: "submit",
    visibility: selectedVisibility,
    includeVisibility: true,
  };
}
