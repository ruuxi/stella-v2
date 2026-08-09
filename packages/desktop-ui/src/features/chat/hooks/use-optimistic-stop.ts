import { useCallback, useEffect, useState } from "react";

const STOP_CONFIRMATION_TIMEOUT_MS = 5_000;

/**
 * Hides the stop affordance as soon as it is pressed while the runtime catches
 * up. If the run is still active after the timeout, the affordance returns so
 * the user can try again.
 */
export function useOptimisticStop(isStreaming: boolean, onStop?: () => void) {
  const [stopRequested, setStopRequested] = useState(false);

  useEffect(() => {
    if (!isStreaming) {
      setStopRequested(false);
      return;
    }

    if (!stopRequested) return;

    const timeoutId = window.setTimeout(() => {
      setStopRequested(false);
    }, STOP_CONFIRMATION_TIMEOUT_MS);

    return () => window.clearTimeout(timeoutId);
  }, [isStreaming, stopRequested]);

  const requestStop = useCallback(() => {
    setStopRequested(true);
    onStop?.();
  }, [onStop]);

  return {
    showStop: isStreaming && !stopRequested,
    requestStop,
  };
}
