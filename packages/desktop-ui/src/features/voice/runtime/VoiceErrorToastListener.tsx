import { useEffect } from "react";
import { showToast } from "@/ui/toast";
import { resolveVoiceErrorToast } from "@/features/voice/runtime/voice-error-toast";
import { useT } from "@/shared/i18n";

export function VoiceErrorToastListener() {
  const t = useT();
  useEffect(() => {
    const off = window.electronAPI?.voice?.onSessionError?.((message) => {
      const toast = resolveVoiceErrorToast(message, t);
      if (toast) {
        showToast(toast);
      }
    });
    return () => {
      off?.();
    };
  }, [t]);

  return null;
}
