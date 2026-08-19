/**
 * Resolves the read-aloud voice family / voice / speed from the user's
 * stored local model preferences.
 *
 * Shared by the auto-read-aloud subscriber (`use-read-aloud.ts`) and the
 * on-demand per-message read-aloud action (`manual-read-aloud.ts`) so both
 * speak with the exact same voice the user picked.
 */
import { resolveReadAloudProvider } from "@stella/contracts/local-preferences";
import type { ReadAloudVoiceFamily } from "./tts-client";

export type ReadAloudVoicePrefs = {
  family: ReadAloudVoiceFamily;
  voice?: string;
  speed?: number;
};

export const resolveReadAloudVoicePrefs =
  async (): Promise<ReadAloudVoicePrefs> => {
    try {
      const prefs =
        await window.electronAPI?.system?.getLocalModelPreferences?.();
      const rt = prefs?.realtimeVoice;
      // Read-aloud is controlled by its own switch. Selecting a realtime
      // voice provider should not silently change read-aloud; unset defaults
      // to Inworld.
      const family: ReadAloudVoiceFamily = resolveReadAloudProvider({
        readAloudProvider: rt?.readAloudProvider,
      });
      const stored = rt?.voices?.[family];
      // Defaults are server-authoritative: forward only an explicit user
      // selection. When the user never picked a voice, leave this undefined
      // so the client omits the field and the backend applies its own
      // default (e.g. Brooke for Inworld). This keeps future default changes
      // backend-deploy-only rather than requiring a client release.
      const voice =
        typeof stored === "string" && stored.trim().length > 0
          ? stored.trim()
          : undefined;
      const speed = family === "inworld" ? rt?.inworldSpeed : undefined;
      return {
        family,
        voice,
        speed:
          typeof speed === "number" && Number.isFinite(speed)
            ? speed
            : undefined,
      };
    } catch {
      return { family: "inworld" };
    }
  };
