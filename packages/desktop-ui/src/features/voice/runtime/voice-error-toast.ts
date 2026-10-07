import type { ToastOptions } from "@/ui/toast";
import {
  OPEN_SETTINGS_TOAST_ACTION,
  SIGN_IN_TOAST_ACTION,
} from "@/shared/lib/auth-cta";

/**
 * Realtime voice retries transient connection blips silently, so we only want
 * to interrupt the user with a toast when the failure is something *they* must
 * act on — they aren't signed in, they don't have Pro, they're out of usage,
 * or the chosen provider isn't connected. These are the typed errors the voice
 * backend raises ("Realtime voice is part of Stella Pro.", "Voice sessions are
 * not configured yet.") plus the BYOK setup messages from voice-handlers.
 * Anything else stays silent and rides the existing auto-retry.
 *
 * The message itself is always shown verbatim as the toast description; only
 * the title and the call-to-action are chosen here.
 */
const VOICE_NEEDS_SIGN_IN = /sign[\s-]?in|not signed in|log[\s-]?in/i;
const VOICE_NEEDS_SETUP =
  /connect .* in settings|in settings|api key|not configured|no .* key|add .* key|unauthor|unauthenticated|stella pro|\bpro\b plan|upgrade|usage limit|limit reached|out of|quota|\b401\b|\b403\b|\b402\b|\b429\b/i;

export const resolveVoiceErrorToast = (
  errorMessage: string | undefined,
  t: (key: string) => string,
): ToastOptions | null => {
  const message = (errorMessage ?? "").trim();
  if (!message) return null;
  // Sign-in takes precedence: a 401 reads as "needs setup" too, but the
  // actionable fix for an unauthenticated user is signing in, not Settings.
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
