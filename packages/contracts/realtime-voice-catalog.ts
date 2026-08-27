export type { RealtimeVoiceUnderlyingProvider } from "./local-preferences.js";
import type { RealtimeVoiceUnderlyingProvider } from "./local-preferences.js";

export interface RealtimeVoiceCatalogEntry {

  id: string;

  label: string;

  description: string;
}

export const OPENAI_REALTIME_VOICES: readonly RealtimeVoiceCatalogEntry[] = [
  {
    id: "marin",
    label: "Marin",
    description: "Warm, natural — the default Realtime voice.",
  },
  { id: "alloy", label: "Alloy", description: "Balanced and neutral." },
  { id: "ash", label: "Ash", description: "Soft, breathy." },
  { id: "ballad", label: "Ballad", description: "Calm and measured." },
  { id: "coral", label: "Coral", description: "Bright and friendly." },
  { id: "echo", label: "Echo", description: "Crisp and clear." },
  { id: "sage", label: "Sage", description: "Thoughtful and steady." },
  { id: "shimmer", label: "Shimmer", description: "Upbeat and energetic." },
  { id: "verse", label: "Verse", description: "Smooth and lyrical." },
];

export const XAI_REALTIME_VOICES: readonly RealtimeVoiceCatalogEntry[] = [
  { id: "eve", label: "Eve", description: "Energetic and upbeat (default)." },
  { id: "ara", label: "Ara", description: "Warm and friendly." },
  {
    id: "rex",
    label: "Rex",
    description: "Confident and articulate — good for business.",
  },
  { id: "sal", label: "Sal", description: "Smooth and balanced." },
  {
    id: "leo",
    label: "Leo",
    description: "Authoritative — good for instructional content.",
  },
];

export const INWORLD_REALTIME_VOICES: readonly RealtimeVoiceCatalogEntry[] = [
  { id: "Brooke", label: "Brooke", description: "English female (default)." },
  { id: "Evelyn", label: "Evelyn", description: "English female, warm." },
  { id: "Clive", label: "Clive", description: "English male, middle-aged." },
  { id: "Ashley", label: "Ashley", description: "English female, middle-aged." },
  { id: "Blake", label: "Blake", description: "English male, middle-aged." },
  { id: "Eleanor", label: "Eleanor", description: "English female, middle-aged." },
  { id: "Hades", label: "Hades", description: "English male, middle-aged, deeper tone." },
  { id: "Hana", label: "Hana", description: "English female, young." },
  { id: "Jason", label: "Jason", description: "English male, middle-aged." },
  { id: "Luna", label: "Luna", description: "English female, middle-aged. Steerable." },
  { id: "Mark", label: "Mark", description: "English male, middle-aged." },
  { id: "Olivia", label: "Olivia", description: "English female, middle-aged." },
  { id: "Reed", label: "Reed", description: "English male, middle-aged." },
  { id: "Sarah", label: "Sarah", description: "English female, middle-aged. Steerable." },
  { id: "Sophie", label: "Sophie", description: "English female, middle-aged." },
  { id: "Theodore", label: "Theodore", description: "English male, older." },
];

export const DEFAULT_INWORLD_REALTIME_MODEL = "xai/grok-4.3-latest";

export const DEFAULT_INWORLD_REALTIME_TTS_MODEL = "inworld-tts-2-flash";

export const XAI_REALTIME_CLIENT_SECRET_TTL_SECONDS = 5 * 60;

export const buildXaiRealtimeClientSecretRequest = (
  expiresAfterSeconds = XAI_REALTIME_CLIENT_SECRET_TTL_SECONDS,
): { expires_after: { seconds: number } } => ({
  expires_after: {
    seconds: Math.max(
      60,
      Math.floor(
        Number.isFinite(expiresAfterSeconds)
          ? expiresAfterSeconds
          : XAI_REALTIME_CLIENT_SECRET_TTL_SECONDS,
      ),
    ),
  },
});

export const DEFAULT_INWORLD_REALTIME_SPEED = 1.15;

export const DEFAULT_OPENAI_REALTIME_VOICE = "marin";
export const DEFAULT_XAI_REALTIME_VOICE = "eve";
export const DEFAULT_INWORLD_REALTIME_VOICE = "Brooke";

export function getDefaultRealtimeVoice(
  provider: RealtimeVoiceUnderlyingProvider,
): string {
  if (provider === "xai") return DEFAULT_XAI_REALTIME_VOICE;
  if (provider === "inworld") return DEFAULT_INWORLD_REALTIME_VOICE;
  return DEFAULT_OPENAI_REALTIME_VOICE;
}

export function getRealtimeVoiceCatalog(
  provider: RealtimeVoiceUnderlyingProvider,
): readonly RealtimeVoiceCatalogEntry[] {
  if (provider === "xai") return XAI_REALTIME_VOICES;
  if (provider === "inworld") return INWORLD_REALTIME_VOICES;
  return OPENAI_REALTIME_VOICES;
}
