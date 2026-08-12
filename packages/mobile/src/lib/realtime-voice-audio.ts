/**
 * Realtime voice is an assistant surface, not a phone call. Keep full-duplex
 * recording for interruption/echo cancellation while routing playback through
 * the main speaker with exclusive audio focus.
 */
export const REALTIME_VOICE_AUDIO_MODE = {
  allowsRecording: true,
  playsInSilentMode: true,
  interruptionMode: "doNotMix",
  shouldRouteThroughEarpiece: false,
} as const;
