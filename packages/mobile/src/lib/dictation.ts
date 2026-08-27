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

const MIN_RECORDING_MS = 300;

export type DictationStatus = "idle" | "recording" | "transcribing";

export type UseDictationOptions = {

  anonymous: boolean;

  headers?: Record<string, string>;

  language?: string;

  onTranscript: (text: string) => void;
};

export type UseDictationResult = {
  status: DictationStatus;
  isRecording: boolean;
  isTranscribing: boolean;
  recorder: AudioRecorder;

  start: () => Promise<boolean>;

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

    }
  }, []);

  const start = useCallback(async (): Promise<boolean> => {
    if (statusRef.current !== "idle" || operationInFlightRef.current) {
      return false;
    }

    stopReadAloudForDictation();
    operationInFlightRef.current = true;

    if (!hasAiConsent()) {
      requestAiConsent();
      operationInFlightRef.current = false;
      return false;
    }
    try {
      const perm = await AudioModule.requestRecordingPermissionsAsync();
      if (!perm.granted) {

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

        if (uri) {
          try {
            new File(uri).delete();
          } catch {

          }
        }
        operationInFlightRef.current = false;
        return null;
      }

      if (!mountedRef.current) {
        try {
          new File(uri).delete();
        } catch {

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

function inferAudioFormat(uri: string): string {
  const lower = uri.toLowerCase();
  if (lower.endsWith(".m4a") || lower.endsWith(".mp4")) return "m4a";
  if (lower.endsWith(".wav")) return "wav";
  if (lower.endsWith(".mp3")) return "mp3";
  if (lower.endsWith(".flac")) return "flac";
  if (lower.endsWith(".ogg")) return "ogg";
  if (lower.endsWith(".webm")) return "webm";
  if (lower.endsWith(".aac")) return "aac";
  if (lower.endsWith(".3gp")) return "m4a";
  return Platform.OS === "web" ? "webm" : "m4a";
}
