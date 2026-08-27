import { useEffect } from "react";
import { DICTATION_TOGGLE_EVENT } from "@/features/dictation/hooks/use-dictation";

export function useDictationToggleBridge(): void {
  useEffect(() => {
    return window.electronAPI?.dictation?.onToggle((payload) => {
      window.dispatchEvent(
        new CustomEvent(DICTATION_TOGGLE_EVENT, {
          detail: payload,
        }),
      );
    });
  }, []);
}
