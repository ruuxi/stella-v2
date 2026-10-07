/**
 * Push-to-talk dictation. Signed-in users stream 16 kHz mono PCM through
 * Stella's authenticated dictation relay and get live partials; without
 * streaming the whole utterance is recorded locally and transcribed in one
 * authenticated request on stop.
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
import {
  DICTATION_MAX_PCM_BYTES,
  DICTATION_SAMPLE_RATE,
  loadDictationStreamingAvailable,
  transcribeDictationWav,
  wavFromPcm16,
} from "./dictation-transcribe";
import {
  DictationStream,
  loadDictationRealtimeConfig,
} from "./dictation-stream";
import { DictationIngressPacer } from "./dictation-pacer";
import {
  resetDictationTranscriptPreview,
  updateDictationTranscriptPreview,
} from "./dictation-transcript-preview";
import { tapLight, tapMedium } from "./haptics";
import {
  startDictationMeter,
  stopDictationMeter,
  updateDictationMeter,
} from "./dictation-meter";

/** Minimum elapsed time before we bother round-tripping audio to the server. */
const MIN_RECORDING_MS = 300;
/** Under this the route answers an empty transcript anyway. */
const MIN_PCM_BYTES = DICTATION_SAMPLE_RATE / 5;
const PRE_ROLL_MAX_BYTES = 4 * DICTATION_SAMPLE_RATE * 2;

export type DictationStatus = "idle" | "recording" | "transcribing";

export type UseDictationOptions = {
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
  /** Resolves with the transcript, or null on no result. */
  stop: () => Promise<string | null>;
  cancel: () => Promise<string | null>;
  toggle: () => Promise<void>;
};

/** One recording's captured PCM, in native delivery order. */
type DictationCapture = {
  chunks: ArrayBuffer[];
  bytes: number;
  /** Set once the 15-minute ceiling is reached; capture stops there. */
  full: boolean;
  live: DictationLive | null;
};

type DictationLive = {
  stream: DictationStream;
  /** Settles when the provider acknowledged the handshake (or failed). */
  opened: Promise<void>;
  /** Set once connected; owns real-time accounting from then on. */
  pacer: DictationIngressPacer | null;
  preRoll: ArrayBuffer[];
  preRollBytes: number;
};

const discardLive = (live: DictationLive | null): void => {
  if (!live) return;
  live.pacer?.stop();
  live.pacer = null;
  live.preRoll = [];
  live.preRollBytes = 0;
  live.stream.cancel();
};

const forwardLive = (live: DictationLive | null, bytes: ArrayBuffer): void => {
  if (!live) return;
  if (live.pacer) {
    live.pacer.send(bytes);
    return;
  }
  live.preRoll.push(bytes);
  live.preRollBytes += bytes.byteLength;
  while (
    live.preRollBytes > PRE_ROLL_MAX_BYTES &&
    live.preRoll.length > 1
  ) {
    live.preRollBytes -= live.preRoll.shift()!.byteLength;
  }
};

const finishLive = async (live: DictationLive): Promise<string> => {
  await live.opened;
  const stream = live.stream;
  stream.throwIfFailed();
  if (!live.pacer) {
    const buffered = concatPcm(live.preRoll, live.preRollBytes);
    live.preRoll = [];
    live.preRollBytes = 0;
    if (buffered.byteLength > 0) stream.send(buffered);
  }
  return await stream.finish();
};

export function useDictation(options: UseDictationOptions): UseDictationResult {
  const [status, setStatus] = useState<DictationStatus>("idle");
  const cancelledRef = useRef(false);
  const startedAtRef = useRef(0);
  const mountedRef = useRef(true);
  const statusRef = useRef<DictationStatus>("idle");
  const operationInFlightRef = useRef(false);
  const recordingLeaseRef = useRef<RecordingAudioLease | null>(null);
  const captureRef = useRef<DictationCapture | null>(null);
  const audioSubscriptionRef = useRef<EventSubscription | null>(null);
  const stopRecordingRef = useRef<(() => Promise<string | null>) | null>(null);

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

  /** Forget captured audio so a cancelled or stale recording cannot be sent. */
  const discardCapture = useCallback((capture: DictationCapture | null) => {
    if (!capture) return;
    if (captureRef.current === capture) captureRef.current = null;
    capture.chunks = [];
    capture.bytes = 0;
    discardLive(capture.live);
  }, []);

  const openLive = useCallback((): DictationLive => {
    const isCurrent = () =>
      mountedRef.current &&
      captureRef.current?.live === live &&
      statusRef.current === "recording";
    const stream = new DictationStream(
      (text) => {
        updateDictationTranscriptPreview(text);
      },
      () => {
        if (isCurrent()) void stopRecordingRef.current?.();
      },
      () => {
        if (isCurrent()) void stopRecordingRef.current?.();
      },
    );
    const live: DictationLive = {
      stream,
      opened: Promise.resolve(),
      pacer: null,
      preRoll: [],
      preRollBytes: 0,
    };
    live.opened = stream.open().then(
      () => {
        if (captureRef.current?.live !== live) return;
        const pacer = new DictationIngressPacer(stream);
        live.pacer = pacer;
        const buffered = concatPcm(live.preRoll, live.preRollBytes);
        live.preRoll = [];
        live.preRollBytes = 0;
        if (buffered.byteLength > 0) pacer.send(buffered);
        pacer.start();
        if (stream.isComplete && isCurrent()) {
          void stopRecordingRef.current?.();
        }
      },
      () => {
        if (isCurrent()) void stopRecordingRef.current?.();
      },
    );
    return live;
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
    let capture: DictationCapture | null = null;
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

      const streaming = options.anonymous
        ? false
        : await loadDictationStreamingAvailable().catch(() => false);
      if (!mountedRef.current) {
        await releaseAudioMode();
        operationInFlightRef.current = false;
        return false;
      }

      phase = "recorder";
      resetDictationTranscriptPreview();
      const current: DictationCapture = {
        chunks: [],
        bytes: 0,
        full: false,
        live: streaming ? openLive() : null,
      };
      capture = current;
      captureRef.current = current;
      const emitter = new LegacyEventEmitter(AudioStudioModule);
      audioSubscriptionRef.current = emitter.addListener<{
        encoded?: string;
        pcmFloat32?: Float32Array | number[];
        buffer?: Float32Array;
      }>("AudioData", (event) => {
        if (!mountedRef.current || captureRef.current !== current) return;
        const audio = event.encoded ?? event.pcmFloat32 ?? event.buffer;
        if (!audio) return;
        const bytes = audioEventToPcm16(audio);
        if (bytes.byteLength === 0) return;
        updateDictationMeter(pcm16PeakLevel(bytes));
        if (current.full) return;
        if (current.live) {
          current.bytes += bytes.byteLength;
          forwardLive(current.live, bytes);
        } else {
          current.chunks.push(bytes);
          current.bytes += bytes.byteLength;
        }
        if (current.bytes < DICTATION_MAX_PCM_BYTES) return;
        // The route refuses more than fifteen minutes. Stop here and keep what
        // was said rather than losing the whole recording to a 413.
        current.full = true;
        if (statusRef.current === "recording") void stopRecordingRef.current?.();
      });
      await AudioStudioModule.startRecording({
        sampleRate: DICTATION_SAMPLE_RATE,
        channels: 1,
        encoding: "pcm_16bit",
        interval: 80,
        keepAwake: true,
        output: { primary: { enabled: false } },
      });

      if (!mountedRef.current) {
        await AudioStudioModule.stopRecording().catch(() => undefined);
        discardCapture(current);
        audioSubscriptionRef.current?.remove();
        audioSubscriptionRef.current = null;
        await releaseAudioMode();
        operationInFlightRef.current = false;
        return false;
      }
      phase = "relay";
      current.live?.stream.throwIfFailed();
      cancelledRef.current = false;
      startedAtRef.current = Date.now();
      startDictationMeter(startedAtRef.current);
      // The mic is live — speak now. This is the cue that matters: the user
      // has to know the recorder is listening before they start talking, and
      // it fires here rather than on the button press so it never promises a
      // recording that consent or a denied mic then refuses.
      tapMedium();
      safeSetStatus("recording");
      operationInFlightRef.current = false;
      if (current.live?.stream.isComplete) void stopRecordingRef.current?.();
      return true;
    } catch (error) {
      console.warn(`[dictation] start failed during ${phase}`, error);
      await AudioStudioModule.stopRecording().catch(() => undefined);
      discardCapture(capture);
      audioSubscriptionRef.current?.remove();
      audioSubscriptionRef.current = null;
      stopDictationMeter();
      resetDictationTranscriptPreview();
      await releaseAudioMode();
      operationInFlightRef.current = false;
      if (mountedRef.current) {
        Alert.alert(
          "Voice input",
          phase === "relay" && error instanceof Error && error.message
            ? error.message
            : "Couldn't start recording. Try again in a moment.",
        );
      }
      return false;
    }
  }, [discardCapture, openLive, options.anonymous, releaseAudioMode, safeSetStatus]);

  const finalize = useCallback(
    async (commit: boolean): Promise<string | null> => {
      if (statusRef.current !== "recording" || operationInFlightRef.current) {
        return null;
      }
      operationInFlightRef.current = true;
      const durationMs = Date.now() - startedAtRef.current;
      cancelledRef.current = !commit;
      // Recording ended. Lighter than the start: this one closes the gesture
      // rather than opening it. `finalize` is the single exit for both stop
      // and cancel, so every way out of recording is covered once.
      tapLight();
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
      // The recorder's final buffers can still arrive until the subscription
      // is gone; keep the capture current so the listener appends them.
      await releaseAudioMode();
      audioSubscriptionRef.current?.remove();
      audioSubscriptionRef.current = null;
      const capture = captureRef.current;
      captureRef.current = null;
      stopDictationMeter();
      resetDictationTranscriptPreview();
      const live = capture?.live ?? null;
      live?.pacer?.stop();
      // The recorder is configured without file output, but delete anything it
      // produced anyway: the audio we send is the PCM we captured.
      if (uri) {
        try {
          new File(uri).delete();
        } catch {
          /* ignore */
        }
      }

      const pcmBytes = capture?.bytes ?? 0;
      const tooShort = live
        ? durationMs < MIN_RECORDING_MS &&
          !live.stream.isComplete &&
          !live.stream.failure
        : pcmBytes < MIN_PCM_BYTES ||
          (durationMs < MIN_RECORDING_MS && !capture?.full);
      if (!commit || !mountedRef.current || tooShort) {
        discardCapture(capture);
        safeSetStatus("idle");
        operationInFlightRef.current = false;
        return null;
      }

      try {
        let text: string;
        if (live) {
          try {
            text = await finishLive(live);
          } catch (error) {
            const failure =
              live.stream.failure ??
              (error instanceof Error
                ? error
                : new Error("Could not transcribe that audio. Try again."));
            // Partials are cumulative, so whatever the provider recognized
            // before it dropped the session is still worth pasting rather than
            // making the user repeat everything they said.
            text = live.stream.partialTranscript.trim();
            console.warn("[dictation] transcription failed", failure);
            if (mountedRef.current && !cancelledRef.current) {
              Alert.alert(
                "Voice input",
                text
                  ? `Dictation stopped early. ${failure.message}`
                  : failure.message,
              );
            }
          }
        } else {
          const wav = wavFromPcm16(capture!.chunks, pcmBytes);
          discardCapture(capture);
          text = await transcribeDictationWav(wav);
        }
        if (text && !cancelledRef.current && mountedRef.current) {
          options.onTranscript(text);
          return text;
        }
        return null;
      } catch (error) {
        console.warn("[dictation] transcription failed", error);
        if (mountedRef.current && !cancelledRef.current) {
          Alert.alert(
            "Voice input",
            error instanceof Error && error.message
              ? error.message
              : "Stella couldn't transcribe that recording. Try again.",
          );
        }
        return null;
      } finally {
        discardCapture(capture);
        safeSetStatus("idle");
        operationInFlightRef.current = false;
      }
    },
    [discardCapture, releaseAudioMode, safeSetStatus, options],
  );

  const stop = useCallback(() => finalize(true), [finalize]);
  const cancel = useCallback(() => finalize(false), [finalize]);
  stopRecordingRef.current = stop;

  useEffect(() => {
    if (options.anonymous) return;
    void loadDictationStreamingAvailable()
      .then((available) => (available ? loadDictationRealtimeConfig() : null))
      .catch(() => undefined);
  }, [options.anonymous]);

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
      discardCapture(captureRef.current);
      audioSubscriptionRef.current?.remove();
      audioSubscriptionRef.current = null;
      stopDictationMeter();
      resetDictationTranscriptPreview();
      void AudioStudioModule.stopRecording().catch(() => undefined);
      void releaseAudioMode();
    };
  }, [discardCapture, releaseAudioMode]);

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

const concatPcm = (chunks: ArrayBuffer[], totalBytes: number): ArrayBuffer => {
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(new Uint8Array(chunk), offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
};

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

/** Samples per RMS window: 8 ms at 16 kHz, close to desktop's worklet frame. */
const LEVEL_FRAME_SAMPLES = 128;
/** RMS during normal speech sits around 0.05–0.15; desktop's `LEVEL_GAIN`. */
const LEVEL_GAIN = 6;

/**
 * Peak RMS across short windows of the chunk, on desktop's 0..1 scale. The
 * native recorder hands over ~100 ms at a time; one RMS over all of it
 * averages the syllables away and reads as a flat, sluggish waveform.
 */
const pcm16PeakLevel = (bytes: ArrayBuffer): number => {
  const samples = new Int16Array(bytes);
  let peak = 0;
  for (let start = 0; start < samples.length; start += LEVEL_FRAME_SAMPLES) {
    const end = Math.min(samples.length, start + LEVEL_FRAME_SAMPLES);
    let sum = 0;
    for (let i = start; i < end; i += 1) {
      const sample = samples[i]! / 0x8000;
      sum += sample * sample;
    }
    const rms = Math.sqrt(sum / Math.max(1, end - start));
    if (rms > peak) peak = rms;
  }
  return Math.min(1, peak * LEVEL_GAIN);
};
