import { useCallback, useEffect, useState } from "react";

const STOP_CONFIRMATION_TIMEOUT_MS = 5_000;

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
