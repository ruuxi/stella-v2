/**
 * Cross-process types for the local model preferences surface.
 *
 * The renderer (`electron.d.ts`, `preload.ts`, model picker UI) and the
 * kernel (`runtime/kernel/preferences/local-preferences.ts`) both need to
 * agree on the shape of voice preferences without each side inlining its
 * own copy of the literal.
 *
 * Pure types + pure-function resolvers only — no fs/path imports here,
 * since this module is reachable from preload + renderer bundles.
 */

export type RealtimeVoiceProvider = "stella" | "openai" | "xai" | "inworld";

/**
 * Subset of the providers that can actually mint a voice — Stella mode
 * routes through one of these under the hood (`stellaSubProvider`).
 */
export type RealtimeVoiceUnderlyingProvider = "openai" | "xai" | "inworld";

/**
 * TTS families used by the Read-aloud feature. Gemini is Stella's default
 * read-aloud voice; OpenAI reuses the user's OpenAI voice selection.
 */
export type ReadAloudVoiceProvider = "gemini" | "openai";

/**
 * Per-underlying-provider voice id selection. Stored per provider (rather
 * than as a single flat field) so that switching between providers
 * preserves each one's choice — e.g. picking "rex" under xAI doesn't get
 * silently rewritten to "marin" when the user flips back to OpenAI.
 */
export type RealtimeVoiceSelections = {
  openai?: string;
  xai?: string;
  inworld?: string;
  /** Read-aloud only: Gemini TTS has no realtime counterpart. */
  gemini?: string;
};

export type RealtimeVoicePreferences = {
  provider: RealtimeVoiceProvider;
  model?: string;
  voices?: RealtimeVoiceSelections;
  /**
   * Active voice family when `provider === "stella"`. Lets the user pick
   * an OpenAI, xAI, or Inworld voice while still routing through Stella's
   * managed backend (no BYOK). Ignored for BYOK modes — those are pinned
   * to their own family.
   */
  stellaSubProvider?: RealtimeVoiceUnderlyingProvider;
  /**
   * Inworld TTS playback speed multiplier. Inworld accepts ~0.5–2.0 on
   * `audio.output.speed`. Only applies to Inworld voices.
   */
  inworldSpeed?: number;
  /**
   * Voice family used for the "Read aloud" feature (TTS of finalized
   * assistant replies). Independent from the realtime voice agent above.
   * Defaults to "gemini" when unset.
   */
  readAloudProvider?: ReadAloudVoiceProvider;
};

/**
 * Resolve which underlying voice family the session should use. For
 * BYOK modes (openai/xai/inworld) this is pinned. For Stella mode it
 * follows `stellaSubProvider`, defaulting to "openai".
 */
export const resolveRealtimeUnderlyingProvider = (
  prefs: Pick<RealtimeVoicePreferences, "provider" | "stellaSubProvider">,
): RealtimeVoiceUnderlyingProvider => {
  if (prefs.provider === "xai") return "xai";
  if (prefs.provider === "openai") return "openai";
  if (prefs.provider === "inworld") return "inworld";
  if (prefs.stellaSubProvider === "xai") return "xai";
  if (prefs.stellaSubProvider === "inworld") return "inworld";
  return "openai";
};

/**
 * Stable identity for the transport/auth route backing a realtime session.
 * The top-level provider distinguishes managed Stella from BYOK even when
 * both ultimately use the same underlying provider.
 */
export const getRealtimeVoiceSessionRouteKey = (
  prefs: Pick<RealtimeVoicePreferences, "provider" | "stellaSubProvider">,
): string => `${prefs.provider}:${resolveRealtimeUnderlyingProvider(prefs)}`;

export const hasRealtimeVoiceSessionRouteChanged = (
  previous: Pick<RealtimeVoicePreferences, "provider" | "stellaSubProvider">,
  next: Pick<RealtimeVoicePreferences, "provider" | "stellaSubProvider">,
): boolean =>
  getRealtimeVoiceSessionRouteKey(previous) !==
  getRealtimeVoiceSessionRouteKey(next);

/**
 * Resolve the TTS family used by the Read-aloud feature. Independent
 * from the realtime voice agent's provider; defaults to Gemini.
 */
export const resolveReadAloudProvider = (
  prefs: Pick<RealtimeVoicePreferences, "readAloudProvider">,
): ReadAloudVoiceProvider =>
  prefs.readAloudProvider === "openai" ? "openai" : "gemini";

const REALTIME_VOICE_PROVIDERS: readonly RealtimeVoiceProvider[] = [
  "stella",
  "openai",
  "xai",
  "inworld",
];

/** Narrow an arbitrary string to a RealtimeVoiceProvider, defaulting to "stella". */
export const coerceRealtimeVoiceProvider = (
  value: string,
): RealtimeVoiceProvider =>
  (REALTIME_VOICE_PROVIDERS as readonly string[]).includes(value)
    ? (value as RealtimeVoiceProvider)
    : "stella";
