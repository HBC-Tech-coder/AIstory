export type LinkUiState = "unavailable" | "unlinked" | "linked" | "confirm";

/** The capability may be false until the phone proof is refreshed. */
export function shouldOfferLinkPhoneProof(accountLinked: boolean | null | undefined, state: LinkUiState): boolean {
  return accountLinked !== true && state !== "linked" && state !== "confirm";
}
