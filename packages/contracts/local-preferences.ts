export type RealtimeVoiceProvider = "stella" | "openai" | "xai" | "inworld";

export type AssistantWorkingMode = "direct" | "orchestrated";

export const DEFAULT_ASSISTANT_WORKING_MODE: AssistantWorkingMode =
  "orchestrated";

export const coerceAssistantWorkingMode = (
  value: unknown,
): AssistantWorkingMode =>
  value === "direct" ? "direct" : DEFAULT_ASSISTANT_WORKING_MODE;

export type RealtimeVoiceUnderlyingProvider = "openai" | "xai" | "inworld";

export type ReadAloudVoiceProvider = "openai" | "inworld";

export type RealtimeVoiceSelections = {
  openai?: string;
  xai?: string;
  inworld?: string;
};

export type RealtimeVoicePreferences = {
  provider: RealtimeVoiceProvider;
  model?: string;
  voices?: RealtimeVoiceSelections;

  stellaSubProvider?: RealtimeVoiceUnderlyingProvider;

  inworldSpeed?: number;

  readAloudProvider?: ReadAloudVoiceProvider;
};

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

export const getRealtimeVoiceSessionRouteKey = (
  prefs: Pick<RealtimeVoicePreferences, "provider" | "stellaSubProvider">,
): string => `${prefs.provider}:${resolveRealtimeUnderlyingProvider(prefs)}`;

export const hasRealtimeVoiceSessionRouteChanged = (
  previous: Pick<RealtimeVoicePreferences, "provider" | "stellaSubProvider">,
  next: Pick<RealtimeVoicePreferences, "provider" | "stellaSubProvider">,
): boolean =>
  getRealtimeVoiceSessionRouteKey(previous) !==
  getRealtimeVoiceSessionRouteKey(next);

export const resolveReadAloudProvider = (
  prefs: Pick<RealtimeVoicePreferences, "readAloudProvider">,
): ReadAloudVoiceProvider =>
  prefs.readAloudProvider === "openai" ? "openai" : "inworld";

const REALTIME_VOICE_PROVIDERS: readonly RealtimeVoiceProvider[] = [
  "stella",
  "openai",
  "xai",
  "inworld",
];

export const coerceRealtimeVoiceProvider = (
  value: string,
): RealtimeVoiceProvider =>
  (REALTIME_VOICE_PROVIDERS as readonly string[]).includes(value)
    ? (value as RealtimeVoiceProvider)
    : "stella";
