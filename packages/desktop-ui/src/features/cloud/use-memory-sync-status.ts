import { useEffect, useState } from "react";
import type { MemorySyncStatus } from "@stella/contracts/desktop/memory-sync";

/**
 * This computer's memory sync as Electron main reports it (the sync runs
 * there, never here). Null outside the desktop app or before main answers.
 */
export function useMemorySyncStatus(): MemorySyncStatus | null {
  const [status, setStatus] = useState<MemorySyncStatus | null>(null);
  useEffect(() => {
    const api = window.electronAPI?.memorySync;
    if (!api) return;
    let live = true;
    const stop = api.onStatus((next) => {
      if (live) setStatus(next);
    });
    void api
      .getStatus()
      .then((current) => {
        // A pushed status that arrived first is newer than this answer.
        if (live) setStatus((pushed) => pushed ?? current);
      })
      .catch(() => undefined);
    return () => {
      live = false;
      stop();
    };
  }, []);
  return status;
}

/** Ask main for a pass now; resolves once it ends. No-op outside desktop. */
export const requestMemorySync = (): Promise<void> =>
  (window.electronAPI?.memorySync?.syncNow() ?? Promise.resolve())
    .then(() => undefined)
    .catch(() => undefined);
