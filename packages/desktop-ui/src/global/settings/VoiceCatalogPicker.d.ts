import type {
  ReadAloudVoiceProvider,
  RealtimeVoicePreferences,
  RealtimeVoiceUnderlyingProvider,
} from "@stella/contracts/local-preferences";

export type VoiceCatalogPickerProps = {
  voiceProvider: RealtimeVoicePreferences["provider"];
  selectedVoices: RealtimeVoicePreferences["voices"];
  onSelectVoice: (
    underlyingProvider: RealtimeVoiceUnderlyingProvider,
    voiceId: string,
  ) => void;
  readAloudProvider?: ReadAloudVoiceProvider;
  onSelectReadAloudProvider?: (provider: ReadAloudVoiceProvider) => void;
  /** Gemini read-aloud voice; persisted to `realtimeVoice.voices.gemini`. */
  onSelectReadAloudVoice?: (voiceId: string) => void;
  disabled?: boolean;
};

export declare function VoiceCatalogPicker(
  props: VoiceCatalogPickerProps,
): import("react").ReactNode;
