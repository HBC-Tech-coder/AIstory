/**
 * Classification for shared-story failures.
 *
 * The backend signals "sharing is intentionally disabled in this environment"
 * with exactly HTTP 503 plus a JSON body `{ "code": "disabled" }`. Any other
 * failure - a JSON parse error, a malformed payload, or a 503 with any other
 * body - must stay a generic "unavailable" so callers keep their normal
 * retry/abort behavior. This module never performs a request.
 */

export const SHARED_STORY_DISABLED_MESSAGE = "当前环境尚未开放作品分享";

/** True only for a record whose `code` is exactly the string "disabled". */
export function isSharingDisabledPayload(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return false;
  }
  return (payload as { code?: unknown }).code === "disabled";
}

/** Disabled requires both the 503 status and the exact payload code. */
export function isSharingDisabledFailure(
  status: number,
  payload: unknown,
): boolean {
  return status === 503 && isSharingDisabledPayload(payload);
}

/**
 * Read a failed response body (only 503 bodies are inspected) and classify it.
 * Parse errors surface as `null` and are never treated as disabled.
 */
export async function readSharingDisabled(response: Response): Promise<boolean> {
  if (response.status !== 503) return false;
  const payload: unknown = await response.json().catch(() => null);
  return isSharingDisabledPayload(payload);
}
