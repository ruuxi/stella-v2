/**
 * Push-to-talk dictation that records audio with expo-audio, ships it to the
 * Stella backend (`/api/mobile/transcribe`), and returns the transcript text.
 *
 * Mirrors desktop's dictation UX: while recording the leaf recording bar polls
 * this recorder for its waveform/timer, and on stop we wait for the transcript
 * before resolving so the caller can paste it into the composer.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AudioModule,
  type AudioRecorder,
  RecordingPresets,
  useAudioRecorder,
} from "expo-audio";
import { File } from "expo-file-system";
import { Alert, Linking, Platform } from "react-native";
import { postJson, postJsonAnonymous } from "./http";
import { hasAiConsent, requestAiConsent } from "./ai-consent";
import {
  acquireRecordingAudioSession,
  releaseRecordingAudioSession,
  type RecordingAudioLease,
} from "./mobile-audio-session";
import { stopReadAloudForDictation } from "./read-aloud";

/** Minimum elapsed time before we bother round-tripping audio to the server. */
const MIN_RECORDING_MS = 300;

export type DictationStatus = "idle" | "recording" | "transcribing";

export type UseDictationOptions = {
  /** When true, the request goes anonymously (mobile-device-id only). */
  anonymous: boolean;
  /** Headers to forward (e.g. X-Stella-Mobile-Device-Id for guests). */
  headers?: Record<string, string>;
  /** Optional BCP-47 hint forwarded to xAI STT. */
  language?: string;
  /** Fired once a transcript comes back. */
  onTranscript: (text: string) => void;
};

export type UseDictationResult = {
  status: DictationStatus;
  isRecording: boolean;
  isTranscribing: boolean;
  recorder: AudioRecorder;
  /** Resolves `true` only if recording actually began (consent + mic granted). */
  start: () => Promise<boolean>;
  /** Resolves with the complete committed transcript, or null on no result. */
  stop: () => Promise<string | null>;
  cancel: () => Promise<string | null>;
  toggle: () => Promise<void>;
};

export function useDictation(options: UseDictationOptions): UseDictationResult {
  const recorder = useAudioRecorder(
    { ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true },
    undefined,
  );
  const [status, setStatus] = useState<DictationStatus>("idle");
  const cancelledRef = useRef(false);
  const startedAtRef = useRef(0);
  const mountedRef = useRef(true);
  const statusRef = useRef<DictationStatus>("idle");
  const operationInFlightRef = useRef(false);
  const recordingLeaseRef = useRef<RecordingAudioLease | null>(null);

  const safeSetStatus = useCallback((next: DictationStatus) => {
    statusRef.current = next;
    if (mountedRef.current) setStatus(next);
  }, []);

  const releaseAudioMode = useCallback(async () => {
    const lease = recordingLeaseRef.current;
    if (lease === null) return;
    recordingLeaseRef.current = null;
    try {
      await releaseRecordingAudioSession(lease);
    } catch {
      // best-effort; the OS will reset on app suspension regardless.
    }
  }, []);

  const start = useCallback(async (): Promise<boolean> => {
    if (statusRef.current !== "idle" || operationInFlightRef.current) {
      return false;
    }
    // Terminal TTS stop before any permission/consent work so a late chunk
    // cannot restart playback after the user has already asked to speak.
    stopReadAloudForDictation();
    operationInFlightRef.current = true;
    // Apple 5.1.1(i): voice audio is sent to a third-party AI transcription
    // service (xAI). Don't even start the recorder until the
    // user has explicitly agreed to the data-sharing disclosure.
    if (!hasAiConsent()) {
      requestAiConsent();
      operationInFlightRef.current = false;
      return false;
    }
    try {
      const perm = await AudioModule.requestRecordingPermissionsAsync();
      if (!perm.granted) {
        // If the user previously denied the system prompt, iOS will not
        // show it again — the only way back is the system Settings app.
        // Give them a one-tap path there so they can re-enable the mic
        // without hunting through Settings manually.
        const canAskAgain =
          (perm as { canAskAgain?: boolean }).canAskAgain !== false;
        Alert.alert(
          "Microphone access needed",
          canAskAgain
            ? "Stella needs access to your microphone to record voice messages. You can allow it the next time iOS asks."
            : "Stella needs access to your microphone to record voice messages. Turn it on in Settings → Stella → Microphone.",
          canAskAgain
            ? [{ text: "OK", style: "default" }]
            : [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Open Settings",
                  style: "default",
                  onPress: () => {
                    void Linking.openSettings();
                  },
                },
              ],
        );
        operationInFlightRef.current = false;
        return false;
      }
      if (!mountedRef.current) {
        operationInFlightRef.current = false;
        return false;
      }

      const lease = await acquireRecordingAudioSession();
      if (lease === null) {
        operationInFlightRef.current = false;
        return false;
      }
      recordingLeaseRef.current = lease;
      if (!mountedRef.current) {
        await releaseAudioMode();
        operationInFlightRef.current = false;
        return false;
      }

      await recorder.prepareToRecordAsync({
        ...RecordingPresets.HIGH_QUALITY,
        isMeteringEnabled: true,
      });
      recorder.record();

      cancelledRef.current = false;
      startedAtRef.current = Date.now();
      safeSetStatus("recording");
      operationInFlightRef.current = false;
      return true;
    } catch (error) {
      console.warn("[dictation] start failed", error);
      await releaseAudioMode();
      operationInFlightRef.current = false;
      Alert.alert(
        "Voice input",
        "Couldn't start recording. Try again in a moment.",
      );
      return false;
    }
  }, [recorder, releaseAudioMode, safeSetStatus]);

  const finalize = useCallback(
    async (commit: boolean): Promise<string | null> => {
      if (
        statusRef.current !== "recording" ||
        operationInFlightRef.current
      ) {
        return null;
      }
      operationInFlightRef.current = true;
      const durationMs = Date.now() - startedAtRef.current;
      cancelledRef.current = !commit;
      safeSetStatus(commit ? "transcribing" : "idle");

      let uri: string | null = null;
      try {
        await recorder.stop();
        uri = recorder.uri;
      } catch (error) {
        console.warn("[dictation] stop failed", error);
      }
      await releaseAudioMode();

      if (!commit || !uri || durationMs < MIN_RECORDING_MS) {
        safeSetStatus("idle");
        // Cleanup the empty/cancelled clip best-effort.
        if (uri) {
          try {
            new File(uri).delete();
          } catch {
            /* ignore */
          }
        }
        operationInFlightRef.current = false;
        return null;
      }

      if (!mountedRef.current) {
        try {
          new File(uri).delete();
        } catch {
          /* ignore */
        }
        operationInFlightRef.current = false;
        return null;
      }

      let file: File | null = null;
      try {
        file = new File(uri);
        const audio = await file.base64();
        const format = inferAudioFormat(uri);

        const path = "/api/mobile/transcribe";
        const body: Record<string, unknown> = { audio, format };
        if (options.language) body.language = options.language;

        // Audio uploads can be large; allow more than the default 15s.
        const response = options.anonymous
          ? await postJsonAnonymous(path, body, {
              headers: options.headers,
              timeoutMs: 60_000,
            })
          : await postJson(path, body, {
              headers: options.headers,
              timeoutMs: 60_000,
            });

        const text =
          response && typeof response === "object" &&
          typeof (response as { text?: unknown }).text === "string"
            ? ((response as { text: string }).text).trim()
            : "";
        if (text && !cancelledRef.current) {
          options.onTranscript(text);
          return text;
        }
        return null;
      } catch (error) {
        console.warn("[dictation] transcription failed", error);
        Alert.alert(
          "Voice input",
          error instanceof Error
            ? error.message
            : "Could not transcribe that audio. Try again.",
        );
        return null;
      } finally {
        try {
          file?.delete();
        } catch {
          /* ignore */
        }
        safeSetStatus("idle");
        operationInFlightRef.current = false;
      }
    },
    [recorder, releaseAudioMode, safeSetStatus, options],
  );

  const stop = useCallback(() => finalize(true), [finalize]);
  const cancel = useCallback(() => finalize(false), [finalize]);

  const toggle = useCallback(async () => {
    if (status === "idle") {
      await start();
    } else if (status === "recording") {
      await stop();
    }
  }, [status, start, stop]);

  // On unmount, release the audio session so the mic light goes away.
  // `useAudioRecorder` disposes the native shared object on unmount — never
  // read `recorder.*` or `recorderState.*` in this cleanup (that throws
  // NativeSharedObjectNotFoundException on Fast Refresh).
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      statusRef.current = "idle";
      void releaseAudioMode();
    };
  }, [releaseAudioMode]);

  return {
    status,
    isRecording: status === "recording",
    isTranscribing: status === "transcribing",
    recorder,
    start,
    stop,
    cancel,
    toggle,
  };
}

/**
 * Best-effort container inference from a file URI. The HIGH_QUALITY preset
 * emits `.m4a` on iOS / Android; web records `audio/webm`. We just need the
 * format string OpenRouter expects in `input_audio.format`.
 */
function inferAudioFormat(uri: string): string {
  const lower = uri.toLowerCase();
  if (lower.endsWith(".m4a") || lower.endsWith(".mp4")) return "m4a";
  if (lower.endsWith(".wav")) return "wav";
  if (lower.endsWith(".mp3")) return "mp3";
  if (lower.endsWith(".flac")) return "flac";
  if (lower.endsWith(".ogg")) return "ogg";
  if (lower.endsWith(".webm")) return "webm";
  if (lower.endsWith(".aac")) return "aac";
  if (lower.endsWith(".3gp")) return "m4a"; // LOW_QUALITY Android container, fallback
  return Platform.OS === "web" ? "webm" : "m4a";
}
