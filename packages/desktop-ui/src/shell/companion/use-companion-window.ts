/**
 * Per-window plumbing shared by the mark and panel renderers: say hello to
 * main once mounted (main answers with the layout, the latest chat snapshot,
 * and the interaction state) and keep following those two feeds.
 */
import { useEffect, useState } from "react";
import type {
  CompanionActivity,
  CompanionLayout,
} from "@stella/contracts/desktop/companion";

const IDLE_ACTIVITY: CompanionActivity = {
  hovered: false,
  panelActive: false,
  expanded: false,
  recording: false,
  transcribing: false,
};

export function useCompanionWindow(): {
  layout: CompanionLayout | null;
  activity: CompanionActivity;
} {
  const [layout, setLayout] = useState<CompanionLayout | null>(null);
  const [activity, setActivity] = useState<CompanionActivity>(IDLE_ACTIVITY);

  useEffect(() => {
    const api = window.electronAPI?.companion;
    if (!api) return;
    const unsubscribeLayout = api.onLayout(setLayout);
    const unsubscribeActivity = api.onActivity((next) =>
      setActivity((prev) =>
        prev.hovered === next.hovered &&
        prev.panelActive === next.panelActive &&
        prev.expanded === next.expanded &&
        prev.recording === next.recording &&
        prev.transcribing === next.transcribing
          ? prev
          : next,
      ),
    );
    api.hello();
    return () => {
      unsubscribeLayout();
      unsubscribeActivity();
    };
  }, []);

  return { layout, activity };
}

export const useDocumentVisible = (): boolean => {
  const [visible, setVisible] = useState(
    () =>
      typeof document === "undefined" || document.visibilityState !== "hidden",
  );
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
};
