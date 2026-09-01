import { useEffect } from "react";
import { resolveVoiceErrorToast } from "@/features/voice/runtime/voice-error-toast";
import { presentComposerNotice } from "@/features/chat/composer-notice-store";
import { SIGN_IN_TOAST_ACTION } from "@/shared/lib/auth-cta";
import { useT } from "@/shared/i18n";

/**
 * The realtime voice runtime runs in the hidden overlay window, so it can't
 * surface its own user-visible toast. It forwards actionable session errors
 * (not signed in, provider not connected) to the main process, which routes
 * them to the visible app window. This listener pins that above the
 * composer (voice starts from there) with a working sign-in or settings
 * action, falling back to a toast when no chat surface is mounted.
 */
export function VoiceErrorToastListener() {
  const t = useT();
  useEffect(() => {
    const off = window.electronAPI?.voice?.onSessionError?.((message) => {
      const toast = resolveVoiceErrorToast(message, t);
      if (toast) {
        presentComposerNotice(
          {
            conversationId: null,
            kind:
              toast.action === SIGN_IN_TOAST_ACTION ? "sign-in" : "provider",
            title: toast.title ?? "",
            description: toast.description,
            action: toast.action,
            secondaryAction: toast.secondaryAction,
          },
          toast,
        );
      }
    });
    return () => {
      off?.();
    };
  }, [t]);

  return null;
}
