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

export type RealtimeVoiceProvider = "stella" | "openai" | "xai";

/**
 * Subset of the providers that can actually mint a voice. Stella mode is
 * always GPT-Live: the voice model carries the conversation and delegates
 * reasoning and tools to the orchestrator, so there is no family to choose.
 * The BYOK modes stay pinned to their own Realtime families.
 */
export type RealtimeVoiceUnderlyingProvider = "gptlive" | "openai" | "xai";

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
  gptlive?: string;
  openai?: string;
  xai?: string;
  /** Read-aloud only: Gemini TTS has no realtime counterpart. */
  gemini?: string;
};

export type RealtimeVoicePreferences = {
  provider: RealtimeVoiceProvider;
  model?: string;
  voices?: RealtimeVoiceSelections;
  /**
   * Whether the voice and call controls are shown at all. Voice is off
   * until the user turns it on in Settings, on every platform.
   */
  enabled?: boolean;
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
 * is always GPT-Live.
 */
export const resolveRealtimeUnderlyingProvider = (
  prefs: Pick<RealtimeVoicePreferences, "provider">,
): RealtimeVoiceUnderlyingProvider => {
  if (prefs.provider === "xai") return "xai";
  if (prefs.provider === "openai") return "openai";
  return "gptlive";
};

/** Voice controls stay hidden until the user switches voice on. */
export const isRealtimeVoiceEnabled = (
  prefs: Pick<RealtimeVoicePreferences, "enabled"> | null | undefined,
): boolean => prefs?.enabled === true;

/**
 * Stable identity for the transport/auth route backing a realtime session.
 * The top-level provider distinguishes managed Stella from BYOK even when
 * both ultimately use the same underlying provider.
 */
export const getRealtimeVoiceSessionRouteKey = (
  prefs: Pick<RealtimeVoicePreferences, "provider">,
): string => `${prefs.provider}:${resolveRealtimeUnderlyingProvider(prefs)}`;

export const hasRealtimeVoiceSessionRouteChanged = (
  previous: Pick<RealtimeVoicePreferences, "provider">,
  next: Pick<RealtimeVoicePreferences, "provider">,
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
];

/** Narrow an arbitrary string to a RealtimeVoiceProvider, defaulting to "stella". */
export const coerceRealtimeVoiceProvider = (
  value: string,
): RealtimeVoiceProvider =>
  (REALTIME_VOICE_PROVIDERS as readonly string[]).includes(value)
    ? (value as RealtimeVoiceProvider)
    : "stella";
