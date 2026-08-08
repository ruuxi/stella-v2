import type {
  ReadAloudVoiceProvider,
  RealtimeVoicePreferences,
  RealtimeVoiceUnderlyingProvider,
} from "@stella/contracts/local-preferences";

export type VoiceCatalogPickerProps = {
  voiceProvider: RealtimeVoicePreferences["provider"];
  stellaSubProvider: RealtimeVoiceUnderlyingProvider | undefined;
  selectedVoices: RealtimeVoicePreferences["voices"];
  inworldSpeed: number | undefined;
  onSelectVoice: (
    underlyingProvider: RealtimeVoiceUnderlyingProvider,
    voiceId: string,
  ) => void;
  onSelectStellaSubProvider: (
    subProvider: RealtimeVoiceUnderlyingProvider,
  ) => void;
  onSelectInworldSpeed: (speed: number) => void;
  readAloudProvider?: ReadAloudVoiceProvider;
  onSelectReadAloudProvider?: (provider: ReadAloudVoiceProvider) => void;
  disabled?: boolean;
};

export declare function VoiceCatalogPicker(
  props: VoiceCatalogPickerProps,
): import("react").ReactNode;
