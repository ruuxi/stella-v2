export const LOCAL_CACHE_RETRY_BASE_MS = 300;
export const LOCAL_CACHE_RETRY_MAX_MS = 4_800;
export const LOCAL_CACHE_RETRY_MAX_ATTEMPTS = 5;

/**
 * Delay before the next rebuildable-cache read. `attempt` is the number of
 * retries already scheduled for the current conversation/window. Returning
 * null is the hard stop that prevents a broken Electron IPC bridge from
 * polling forever in the background.
 */
export const localCacheRetryDelayMs = (attempt: number): number | null => {
  const normalizedAttempt = Math.max(0, Math.floor(attempt));
  if (normalizedAttempt >= LOCAL_CACHE_RETRY_MAX_ATTEMPTS) return null;
  return Math.min(
    LOCAL_CACHE_RETRY_MAX_MS,
    LOCAL_CACHE_RETRY_BASE_MS * 2 ** normalizedAttempt,
  );
};
