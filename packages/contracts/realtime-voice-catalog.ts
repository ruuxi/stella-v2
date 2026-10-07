/**
 * Voice catalogs for the realtime voice providers Stella supports.
 *
 * Lives in `contracts/` because both:
 *   - the main process (ipc/voice-handlers.ts) needs to validate the
 *     user-selected voice before passing it to the ephemeral-token mint, and
 *   - the renderer (settings UI + provider modules) needs to render the
 *     picker rows.
 *
 * The catalogs are the source-of-truth list of *known* voices, but voice
 * IDs are passed through to the provider as opaque strings — that lets
 * xAI's custom-voice IDs (cloned from a reference clip) work without
 * changes here.
 */

export type { RealtimeVoiceUnderlyingProvider } from "./local-preferences.js";
import type { RealtimeVoiceUnderlyingProvider } from "./local-preferences.js";

export interface RealtimeVoiceCatalogEntry {
  /** Voice id passed to the provider verbatim. */
  id: string;
  /** Short user-visible name. */
  label: string;
  /** One-line tone/description shown under the label. */
  description: string;
}

/**
 * OpenAI Realtime voices (used by the OpenAI BYOK path AND by the
 * Stella-managed path, which mints OpenAI realtime tokens server-side).
 */
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

/**
 * xAI Grok Voice Agent voices. The model also accepts custom voice IDs
 * cloned from a reference clip via xAI's Custom Voices API.
 */
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

/**
 * GPT-Live voices. The Realtime voices above all work on `gpt-live-1`,
 * and GPT-Live adds its own. Custom voice ids authorized on the org also
 * pass through as opaque strings.
 */
export const GPT_LIVE_VOICES: readonly RealtimeVoiceCatalogEntry[] = [
  ...OPENAI_REALTIME_VOICES,
  {
    id: "quartz",
    label: "Quartz",
    description: "Australian, feminine — generated.",
  },
  {
    id: "ripple",
    label: "Ripple",
    description: "Australian, masculine — natural.",
  },
];

/**
 * Gemini TTS prebuilt voices, used by Read aloud only. The backend owns
 * the default and falls back to it for any id not in this list.
 */
export const GEMINI_TTS_VOICES: readonly RealtimeVoiceCatalogEntry[] = [
  { id: "Zephyr", label: "Zephyr", description: "Bright." },
  { id: "Puck", label: "Puck", description: "Upbeat." },
  { id: "Charon", label: "Charon", description: "Informative." },
  { id: "Kore", label: "Kore", description: "Firm." },
  { id: "Fenrir", label: "Fenrir", description: "Excitable." },
  { id: "Leda", label: "Leda", description: "Youthful." },
  { id: "Orus", label: "Orus", description: "Firm." },
  { id: "Aoede", label: "Aoede", description: "Breezy." },
  { id: "Callirrhoe", label: "Callirrhoe", description: "Easy-going." },
  { id: "Autonoe", label: "Autonoe", description: "Bright." },
  { id: "Enceladus", label: "Enceladus", description: "Breathy." },
  { id: "Iapetus", label: "Iapetus", description: "Clear." },
  { id: "Umbriel", label: "Umbriel", description: "Easy-going." },
  { id: "Algieba", label: "Algieba", description: "Smooth." },
  { id: "Despina", label: "Despina", description: "Smooth." },
  { id: "Erinome", label: "Erinome", description: "Clear." },
  { id: "Algenib", label: "Algenib", description: "Gravelly." },
  { id: "Rasalgethi", label: "Rasalgethi", description: "Informative." },
  { id: "Laomedeia", label: "Laomedeia", description: "Upbeat." },
  { id: "Achernar", label: "Achernar", description: "Soft." },
  { id: "Alnilam", label: "Alnilam", description: "Firm." },
  { id: "Schedar", label: "Schedar", description: "Even." },
  { id: "Gacrux", label: "Gacrux", description: "Mature." },
  { id: "Pulcherrima", label: "Pulcherrima", description: "Forward." },
  { id: "Achird", label: "Achird", description: "Friendly." },
  { id: "Zubenelgenubi", label: "Zubenelgenubi", description: "Casual." },
  { id: "Vindemiatrix", label: "Vindemiatrix", description: "Gentle." },
  { id: "Sadachbia", label: "Sadachbia", description: "Lively." },
  { id: "Sadaltager", label: "Sadaltager", description: "Knowledgeable." },
  { id: "Sulafat", label: "Sulafat", description: "Warm." },
];

export const DEFAULT_GEMINI_TTS_MODEL = "gemini-3.8-flash-lite-tts";
export const DEFAULT_GEMINI_TTS_VOICE = "Kore";

export const isGeminiTtsVoice = (voice: string): boolean =>
  GEMINI_TTS_VOICES.some((entry) => entry.id === voice);

/** xAI recommends short-lived browser tokens; Stella's leases are five minutes. */
export const XAI_REALTIME_CLIENT_SECRET_TTL_SECONDS = 5 * 60;

/**
 * xAI's client-secret endpoint accepts expiry configuration only. Realtime
 * session fields (voice, instructions, tools) are sent after the WebSocket
 * opens via `session.update`.
 */
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
export const DEFAULT_OPENAI_REALTIME_VOICE = "marin";
export const DEFAULT_XAI_REALTIME_VOICE = "eve";
/** GPT-Live's documented default. */
export const DEFAULT_GPT_LIVE_VOICE = "marin";

export function getDefaultRealtimeVoice(
  provider: RealtimeVoiceUnderlyingProvider,
): string {
  if (provider === "xai") return DEFAULT_XAI_REALTIME_VOICE;
  if (provider === "openai") return DEFAULT_OPENAI_REALTIME_VOICE;
  return DEFAULT_GPT_LIVE_VOICE;
}

export function getRealtimeVoiceCatalog(
  provider: RealtimeVoiceUnderlyingProvider,
): readonly RealtimeVoiceCatalogEntry[] {
  if (provider === "xai") return XAI_REALTIME_VOICES;
  if (provider === "openai") return OPENAI_REALTIME_VOICES;
  return GPT_LIVE_VOICES;
}

export const isGptLiveVoice = (voice: string): boolean =>
  GPT_LIVE_VOICES.some((entry) => entry.id === voice);
