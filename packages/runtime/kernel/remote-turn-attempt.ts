const REMOTE_TURN_RUN_ID_PREFIX = "local:auto:remote:";

/**
 * Stable worker-run identity for one exact desktop remote-turn lease attempt.
 * The host can derive it before the worker RPC is sent, which makes the
 * pre-registration cancellation window retryable without falling back to a
 * conversation-wide cancellation.
 */
export const remoteTurnWorkerRunId = (attemptId: string): string => {
  const normalized = attemptId.trim();
  if (!normalized) {
    throw new Error("A remote-turn attempt requires attemptId.");
  }
  return `${REMOTE_TURN_RUN_ID_PREFIX}${normalized}`;
};
