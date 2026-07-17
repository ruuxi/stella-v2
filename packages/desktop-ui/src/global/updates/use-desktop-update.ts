import { useCallback, useEffect, useState } from "react";
import type { DesktopUpdateSnapshot } from "@stella/contracts/desktop/update";
import { STELLA_V2_UPDATE_CHANNEL } from "@stella/contracts/desktop/update";

const disabledSnapshot: DesktopUpdateSnapshot = {
  status: "disabled",
  channel: STELLA_V2_UPDATE_CHANNEL,
  currentVersion: "0.0.0",
  availableVersion: null,
  downloadedVersion: null,
  releaseName: null,
  releaseDate: null,
  progress: null,
  checkedAt: null,
  error: null,
};

export const useDesktopUpdate = () => {
  const [snapshot, setSnapshot] =
    useState<DesktopUpdateSnapshot>(disabledSnapshot);

  const refresh = useCallback(async () => {
    const updates = window.electronAPI?.updates;
    if (!updates) {
      setSnapshot(disabledSnapshot);
      return disabledSnapshot;
    }
    const next = await updates.getState();
    setSnapshot(next);
    return next;
  }, []);

  useEffect(() => {
    const updates = window.electronAPI?.updates;
    if (!updates) return;
    let active = true;
    const unsubscribe = updates.onStateChanged((next) => {
      if (active) setSnapshot(next);
    });
    void refresh().catch(() => undefined);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [refresh]);

  return { snapshot, refresh };
};
