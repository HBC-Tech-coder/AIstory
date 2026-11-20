type RetryInit = RequestInit & {
  retries?: number;
  retryDelayMs?: number;
  /** Called immediately before each real fetch attempt. Callers must keep it idempotent. */
  onRequestStart?: () => void;
  /**
   * Per-attempt hard deadline. A timed-out attempt counts as a retryable
   * failure (it consumes retry budget like a 5xx). Unset → no client-side
   * timeout, preserving the historical behavior.
   */
  timeoutMs?: number;
};

export async function fetchWithRetry(
  url: string,
  init: RetryInit,
): Promise<Response> {
  const {
    retries = 2,
    retryDelayMs = 1500,
    timeoutMs,
    onRequestStart,
    ...fetchInit
  } = init;
  if (!fetchInit.redirect) fetchInit.redirect = "manual";
  // Caller-supplied signal (e.g. a hedge loser being cancelled) must abort
  // immediately and permanently — it is NOT retryable, unlike our own
  // per-attempt timeout below.
  const externalSignal = fetchInit.signal ?? undefined;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (externalSignal?.aborted) throw abortError(externalSignal);
    const attemptSignal = timeoutMs
      ? externalSignal
        ? AbortSignal.any([externalSignal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs)
      : externalSignal;
    try {
      onRequestStart?.();
      const res = await fetch(url, { ...fetchInit, signal: attemptSignal });
      if (res.ok) return res;
      // 429 is often a transient provider quota/rate-window response. Respect
      // Retry-After when present, otherwise fall back to the normal backoff.
      if (res.status === 429 && attempt < retries) {
        await sleep(retryAfterMs(res.headers.get("retry-after")) ?? retryDelayMs * (attempt + 1));
        continue;
      }
      // Don't retry other 4xx responses; client errors won't fix themselves.
      if (res.status >= 400 && res.status < 500) return res;
      // 5xx: retry if we have budget left
      if (attempt < retries) {
        await sleep(retryDelayMs * (attempt + 1));
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
      if (externalSignal?.aborted) throw err;
      const isAbort = err instanceof DOMException && err.name === "AbortError";
      if (isAbort) throw err;
      // TimeoutError (from AbortSignal.timeout) falls through as retryable.
      if (attempt < retries) {
        await sleep(retryDelayMs * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("This operation was aborted", "AbortError");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}
