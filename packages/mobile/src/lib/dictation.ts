/**
 * Push-to-talk dictation that records audio with expo-audio, ships it to the
 * Stella backend (`/api/mobile/transcribe`), and returns the transcript text.
 *
 * Mirrors desktop's dictation UX: while recording we surface a level buffer
 * (for the waveform) plus elapsed ms, and on stop we wait for the transcript
 * before resolving so the caller can paste it into the composer.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from "expo-audio";
import { File } from "expo-file-system";
import { Alert, Linking, Platform } from "react-native";
import { postJson, postJsonAnonymous } from "./http";
import { hasAiConsent, requestAiConsent } from "./ai-consent";

const LEVEL_BUFFER_LENGTH = 64;
/** Update tick for the waveform/timer. ~12 Hz feels right and matches desktop. */
const RECORDER_TICK_MS = 80;
/** Minimum elapsed time before we bother round-tripping audio to the server. */
const MIN_RECORDING_MS = 300;

/** Map expo-audio metering (dBFS, -160…0) to a 0…1 visual amplitude. */
const normalizeMetering = (db: number | undefined): number => {
  if (db === undefined || !isFinite(db)) return 0;
  // -50 dBFS is roughly the noise floor we care about; 0 dBFS is peak.
  const clamped = Math.max(-50, Math.min(0, db));
  return (clamped + 50) / 50;
};

export type DictationStatus = "idle" | "recording" | "transcribing";

export type UseDictationOptions = {
  /** When true, the request goes anonymously (mobile-device-id only). */
  anonymous: boolean;
  /** Headers to forward (e.g. X-Stella-Mobile-Device-Id for guests). */
  headers?: Record<string, string>;
  /** Optional BCP-47 hint forwarded to Voxtral. */
  language?: string;
  /** Fired once a transcript comes back. */
  onTranscript: (text: string) => void;
};

export type UseDictationResult = {
  status: DictationStatus;
  isRecording: boolean;
  isTranscribing: boolean;
  levels: number[];
  elapsedMs: number;
  /** Resolves `true` only if recording actually began (consent + mic granted). */
  start: () => Promise<boolean>;
  stop: () => Promise<void>;
  cancel: () => Promise<void>;
  toggle: () => Promise<void>;
};

export function useDictation(options: UseDictationOptions): UseDictationResult {
  const recorder = useAudioRecorder(
    { ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true },
    undefined,
  );
  const [status, setStatus] = useState<DictationStatus>("idle");
  // expo-audio's `useAudioRecorderState` only sets up its polling interval
  // once on `[recorder.id]`, so changing the interval after status flips to
  // "recording" is silently ignored — that's why the waveform never moved.
  // Poll at a steady high rate; while idle `getStatus()` returns the static
  // idle snapshot, which is cheap, and the cleanup `clearInterval` covers
  // unmount before the native shared object is disposed.
  const recorderState = useAudioRecorderState(recorder, RECORDER_TICK_MS);

  const [levels, setLevels] = useState<number[]>([]);
  const [elapsedMs, setElapsedMs] = useState(0);
  const cancelledRef = useRef(false);
  const startedAtRef = useRef(0);
  const mountedRef = useRef(true);

  const safeSetStatus = useCallback((next: DictationStatus) => {
    if (mountedRef.current) setStatus(next);
  }, []);

  const safeResetVisuals = useCallback(() => {
    if (!mountedRef.current) return;
    setLevels([]);
    setElapsedMs(0);
  }, []);

  // Drive the visual buffer off the recorder's polling state so the waveform
  // ticks even when no other re-render is happening.
  useEffect(() => {
    if (!mountedRef.current || status !== "recording" || !recorderState.isRecording) {
      return;
    }
    setElapsedMs(Date.now() - startedAtRef.current);
    const amp = normalizeMetering(recorderState.metering);
    setLevels((prev) => {
      const next = prev.length >= LEVEL_BUFFER_LENGTH
        ? prev.slice(prev.length - LEVEL_BUFFER_LENGTH + 1)
        : prev.slice();
      next.push(amp);
      return next;
    });
  }, [
    status,
    recorderState.isRecording,
    recorderState.metering,
    recorderState.durationMillis,
  ]);

  const releaseAudioMode = useCallback(async () => {
    try {
      await setAudioModeAsync({ allowsRecording: false });
    } catch {
      // best-effort; the OS will reset on app suspension regardless.
    }
  }, []);

  const start = useCallback(async (): Promise<boolean> => {
    if (status !== "idle") return false;
    // Apple 5.1.1(i): voice audio is sent to a third-party AI transcription
    // service (Mistral Voxtral). Don't even start the recorder until the
    // user has explicitly agreed to the data-sharing disclosure.
    if (!hasAiConsent()) {
      requestAiConsent();
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
        return false;
      }

      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
      });

      await recorder.prepareToRecordAsync({
        ...RecordingPresets.HIGH_QUALITY,
        isMeteringEnabled: true,
      });
      recorder.record();

      cancelledRef.current = false;
      startedAtRef.current = Date.now();
      setLevels([]);
      setElapsedMs(0);
      safeSetStatus("recording");
      return true;
    } catch (error) {
      console.warn("[dictation] start failed", error);
      await releaseAudioMode();
      Alert.alert(
        "Voice input",
        "Couldn't start recording. Try again in a moment.",
      );
      return false;
    }
  }, [recorder, releaseAudioMode, safeSetStatus, status]);

  const finalize = useCallback(
    async (commit: boolean) => {
      if (status !== "recording") return;
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
        safeResetVisuals();
        // Cleanup the empty/cancelled clip best-effort.
        if (uri) {
          try {
            new File(uri).delete();
          } catch {
            /* ignore */
          }
        }
        return;
      }

      if (!mountedRef.current) return;

      try {
        const file = new File(uri);
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

        try {
          file.delete();
        } catch {
          /* ignore */
        }

        const text =
          response && typeof response === "object" &&
          typeof (response as { text?: unknown }).text === "string"
            ? ((response as { text: string }).text).trim()
            : "";
        if (text && !cancelledRef.current) {
          options.onTranscript(text);
        }
      } catch (error) {
        console.warn("[dictation] transcription failed", error);
        Alert.alert(
          "Voice input",
          error instanceof Error
            ? error.message
            : "Could not transcribe that audio. Try again.",
        );
      } finally {
        safeSetStatus("idle");
        safeResetVisuals();
      }
    },
    [recorder, releaseAudioMode, safeResetVisuals, safeSetStatus, status, options],
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
      void releaseAudioMode();
    };
  }, [releaseAudioMode]);

  return {
    status,
    isRecording: status === "recording",
    isTranscribing: status === "transcribing",
    levels,
    elapsedMs,
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
