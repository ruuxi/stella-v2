import { showToast } from "@/ui/toast";
import {
  OPEN_SETTINGS_TOAST_ACTION,
  SIGN_IN_TOAST_ACTION,
} from "@/shared/lib/auth-cta";

const VOICE_NEEDS_SIGN_IN = /sign[\s-]?in|not signed in|log[\s-]?in/i;
const VOICE_NEEDS_SETUP =
  /connect .* in settings|in settings|api key|not configured|no .* key|add .* key|unauthor|unauthenticated|\b401\b|\b403\b/i;

export const resolveVoiceErrorToast = (
  errorMessage: string | undefined,
  t: (key: string) => string,
): Parameters<typeof showToast>[0] | null => {
  const message = (errorMessage ?? "").trim();
  if (!message) return null;

  if (VOICE_NEEDS_SIGN_IN.test(message)) {
    return {
      title: t("features.voice.signInTitle"),
      description: message,
      variant: "error",
      duration: 8000,
      action: SIGN_IN_TOAST_ACTION,
    };
  }
  if (VOICE_NEEDS_SETUP.test(message)) {
    return {
      title: t("features.voice.needsSetupTitle"),
      description: message,
      variant: "error",
      duration: 8000,
      action: OPEN_SETTINGS_TOAST_ACTION,
    };
  }
  return null;
};
