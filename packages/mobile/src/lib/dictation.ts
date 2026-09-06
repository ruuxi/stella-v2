/**
 * Push-to-talk dictation that streams 16 kHz mono PCM through Stella's
 * authenticated dictation relay and returns the cumulative final text.
 *
 * Mirrors desktop's dictation UX: while recording the leaf recording bar polls
 * this recorder for its waveform/timer, and on stop we wait for the transcript
 * before resolving so the caller can paste it into the composer.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { AudioModule } from "expo-audio";
import { AudioStudioModule } from "@siteed/audio-studio";
import { LegacyEventEmitter, type EventSubscription } from "expo-modules-core";
import { File } from "expo-file-system";
import { Alert, Linking } from "react-native";
import { hasAiConsent, requestAiConsent } from "./ai-consent";
import {
  acquireRecordingAudioSession,
  releaseRecordingAudioSession,
  type RecordingAudioLease,
} from "./mobile-audio-session";
import { stopReadAloudForDictation } from "./read-aloud";
import { DictationStream } from "./dictation-stream";
import { HttpRequestError } from "./http";
import {
  startDictationMeter,
  stopDictationMeter,
  updateDictationMeter,
} from "./dictation-meter";
import {
  resetDictationTranscriptPreview,
  updateDictationTranscriptPreview,
} from "./dictation-transcript-preview";

/** Minimum elapsed time before we bother round-tripping audio to the server. */
const MIN_RECORDING_MS = 300;

export type DictationStatus = "idle" | "recording" | "transcribing";

export type UseDictationOptions = {
  /** Retained for caller compatibility; the relay authenticates the session. */
  anonymous: boolean;
  /** Retained for caller compatibility with the retired batch endpoint. */
  headers?: Record<string, string>;
  /** Optional BCP-47 hint reserved for future language biasing. */
  language?: string;
  /** Fired once a transcript comes back. */
  onTranscript: (text: string) => void;
};

export type UseDictationResult = {
  status: DictationStatus;
  isRecording: boolean;
  isTranscribing: boolean;
  /** Resolves `true` only if recording actually began (consent + mic granted). */
  start: () => Promise<boolean>;
  /** Resolves with the complete committed transcript, or null on no result. */
  stop: () => Promise<string | null>;
  cancel: () => Promise<string | null>;
  toggle: () => Promise<void>;
};

export function useDictation(options: UseDictationOptions): UseDictationResult {
  const [status, setStatus] = useState<DictationStatus>("idle");
  const cancelledRef = useRef(false);
  const startedAtRef = useRef(0);
  const mountedRef = useRef(true);
  const statusRef = useRef<DictationStatus>("idle");
  const operationInFlightRef = useRef(false);
  const recordingLeaseRef = useRef<RecordingAudioLease | null>(null);
  const dictationStreamRef = useRef<DictationStream | null>(null);
  const audioSubscriptionRef = useRef<EventSubscription | null>(null);
  const cancelRecordingRef = useRef<(() => Promise<string | null>) | null>(
    null,
  );

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
    // transcription service. Don't even start the recorder until the user has
    // explicitly agreed to the data-sharing disclosure.
    if (!hasAiConsent()) {
      requestAiConsent();
      operationInFlightRef.current = false;
      return false;
    }
    let phase: "permission" | "audio-session" | "relay" | "recorder" =
      "permission";
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

      phase = "audio-session";
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

      resetDictationTranscriptPreview();
      phase = "relay";
      const stream = new DictationStream(
        updateDictationTranscriptPreview,
        (error) => {
          // Opening errors belong to start's catch; finishing errors belong to
          // finish(). Only a live recording needs this unsolicited terminal path.
          if (statusRef.current !== "recording") return;
          void cancelRecordingRef.current?.().finally(() => {
            if (mountedRef.current) Alert.alert("Voice input", error.message);
          });
        },
      );
      // Own the connection while opening too, so failed startup and unmount
      // can close it before a microphone is ever started.
      dictationStreamRef.current = stream;
      await stream.open();
      if (!mountedRef.current) {
        stream.cancel();
        await releaseAudioMode();
        operationInFlightRef.current = false;
        return false;
      }
      phase = "recorder";
      const emitter = new LegacyEventEmitter(AudioStudioModule);
      audioSubscriptionRef.current = emitter.addListener<{
        encoded?: string;
        pcmFloat32?: Float32Array | number[];
        buffer?: Float32Array;
      }>("AudioData", (event) => {
        const audio = event.encoded ?? event.pcmFloat32 ?? event.buffer;
        if (!audio) return;
        const bytes = audioEventToPcm16(audio);
        if (bytes.byteLength === 0) return;
        updateDictationMeter(pcm16Level(bytes));
        dictationStreamRef.current?.send(bytes);
      });
      await AudioStudioModule.startRecording({
        sampleRate: 16_000,
        channels: 1,
        encoding: "pcm_16bit",
        interval: 80,
        keepAwake: true,
        output: { primary: { enabled: false } },
      });

      if (!mountedRef.current) {
        await AudioStudioModule.stopRecording().catch(() => undefined);
        stream.cancel();
        audioSubscriptionRef.current?.remove();
        audioSubscriptionRef.current = null;
        await releaseAudioMode();
        operationInFlightRef.current = false;
        return false;
      }
      phase = "relay";
      stream.throwIfFailed();
      cancelledRef.current = false;
      startedAtRef.current = Date.now();
      startDictationMeter(startedAtRef.current);
      safeSetStatus("recording");
      operationInFlightRef.current = false;
      return true;
    } catch (error) {
      console.warn(`[dictation] start failed during ${phase}`, error);
      await AudioStudioModule.stopRecording().catch(() => undefined);
      dictationStreamRef.current?.cancel();
      dictationStreamRef.current = null;
      audioSubscriptionRef.current?.remove();
      audioSubscriptionRef.current = null;
      stopDictationMeter();
      resetDictationTranscriptPreview();
      await releaseAudioMode();
      operationInFlightRef.current = false;
      if (mountedRef.current) {
        Alert.alert(
          "Voice input",
          error instanceof HttpRequestError ||
            (phase === "relay" && error instanceof Error)
            ? error.message
            : "Couldn't start recording. Try again in a moment.",
        );
      }
      return false;
    }
  }, [releaseAudioMode, safeSetStatus]);

  const finalize = useCallback(
    async (commit: boolean): Promise<string | null> => {
      if (statusRef.current !== "recording" || operationInFlightRef.current) {
        return null;
      }
      operationInFlightRef.current = true;
      const durationMs = Date.now() - startedAtRef.current;
      cancelledRef.current = !commit;
      safeSetStatus(commit ? "transcribing" : "idle");

      let uri: string | null = null;
      try {
        const recording = (await AudioStudioModule.stopRecording()) as {
          fileUri?: string;
        };
        uri = recording.fileUri ?? null;
      } catch (error) {
        console.warn("[dictation] stop failed", error);
      }
      await releaseAudioMode();
      audioSubscriptionRef.current?.remove();
      audioSubscriptionRef.current = null;
      stopDictationMeter();
      resetDictationTranscriptPreview();

      if (!commit || durationMs < MIN_RECORDING_MS) {
        dictationStreamRef.current?.cancel();
        dictationStreamRef.current = null;
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

      let file: File | null = null;
      try {
        if (uri) file = new File(uri);
        const text = (await dictationStreamRef.current?.finish()) ?? "";
        dictationStreamRef.current = null;
        if (text && !cancelledRef.current && mountedRef.current) {
          options.onTranscript(text);
          return text;
        }
        return null;
      } catch (error) {
        console.warn("[dictation] transcription failed", error);
        if (mountedRef.current) {
          Alert.alert(
            "Voice input",
            error instanceof Error
              ? error.message
              : "Could not transcribe that audio. Try again.",
          );
        }
        return null;
      } finally {
        dictationStreamRef.current?.cancel();
        dictationStreamRef.current = null;
        try {
          file?.delete();
        } catch {
          /* ignore */
        }
        safeSetStatus("idle");
        operationInFlightRef.current = false;
      }
    },
    [releaseAudioMode, safeSetStatus, options],
  );

  const stop = useCallback(() => finalize(true), [finalize]);
  const cancel = useCallback(() => finalize(false), [finalize]);
  cancelRecordingRef.current = cancel;

  const toggle = useCallback(async () => {
    if (status === "idle") {
      await start();
    } else if (status === "recording") {
      await stop();
    }
  }, [status, start, stop]);

  // On unmount, stop native capture and release the audio session so the mic
  // light cannot remain on after navigating away or during Fast Refresh.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      statusRef.current = "idle";
      dictationStreamRef.current?.cancel();
      dictationStreamRef.current = null;
      audioSubscriptionRef.current?.remove();
      audioSubscriptionRef.current = null;
      stopDictationMeter();
      resetDictationTranscriptPreview();
      void AudioStudioModule.stopRecording().catch(() => undefined);
      void releaseAudioMode();
    };
  }, [releaseAudioMode]);

  return {
    status,
    isRecording: status === "recording",
    isTranscribing: status === "transcribing",
    start,
    stop,
    cancel,
    toggle,
  };
}

const audioEventToPcm16 = (
  data: string | Float32Array | Int16Array | number[],
): ArrayBuffer => {
  if (typeof data === "string") {
    const binary = globalThis.atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }
  if (data instanceof Int16Array) {
    return new Int16Array(data).buffer;
  }
  const pcm = new Int16Array(data.length);
  for (let i = 0; i < data.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, data[i] ?? 0));
    pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return pcm.buffer;
};

const pcm16Level = (bytes: ArrayBuffer): number => {
  const samples = new Int16Array(bytes);
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i]! / 0x8000;
    sum += sample * sample;
  }
  return Math.min(1, Math.sqrt(sum / Math.max(1, samples.length)) * 6);
};
