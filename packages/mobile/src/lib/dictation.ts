/**
 * Push-to-talk dictation that streams 16 kHz mono PCM through Stella's
 * authenticated dictation relay and returns the cumulative final text.
 *
 * Mirrors desktop's dictation UX: while recording the leaf recording bar polls
 * this recorder for its waveform/timer, and on stop we wait for the transcript
 * before resolving so the caller can paste it into the composer.
 *
 * The microphone starts while the relay is still connecting (that handshake
 * is a couple of seconds through Convex and Meta; the recorder is ~100 ms).
 * Audio captured before the provider acknowledges is held in a short pre-roll
 * and flushed on connect, so recording appears the moment the mic is live and
 * nothing said during the connect is lost.
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
import { DictationIngressPacer } from "./dictation-pacer";
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
/**
 * Audio held while the relay connects. Meta closes a session with more than
 * five seconds queued ahead of real time, so a flush must stay well under
 * that; a connect slower than this is failing anyway.
 */
const PRE_ROLL_MAX_BYTES = 4 * 16_000 * 2;

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

/** One dictation's relay connection plus the audio waiting on it. */
type DictationSession = {
  stream: DictationStream;
  /** Settles when the provider acknowledged the handshake (or failed). */
  opened: Promise<void>;
  /** Set once connected; owns real-time accounting from then on. */
  pacer: DictationIngressPacer | null;
  preRoll: ArrayBuffer[];
  preRollBytes: number;
};

export function useDictation(options: UseDictationOptions): UseDictationResult {
  const [status, setStatus] = useState<DictationStatus>("idle");
  const cancelledRef = useRef(false);
  const startedAtRef = useRef(0);
  const mountedRef = useRef(true);
  const statusRef = useRef<DictationStatus>("idle");
  const operationInFlightRef = useRef(false);
  const recordingLeaseRef = useRef<RecordingAudioLease | null>(null);
  const sessionRef = useRef<DictationSession | null>(null);
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

  /** Drop the session: stop pacing, close the socket, forget buffered audio. */
  const discardSession = useCallback((session: DictationSession | null) => {
    if (!session) return;
    if (sessionRef.current === session) sessionRef.current = null;
    session.pacer?.stop();
    session.pacer = null;
    session.preRoll = [];
    session.preRollBytes = 0;
    session.stream.cancel();
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
    let session: DictationSession | null = null;
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
        () => {
          // Opening errors settle `opened`; finishing errors belong to
          // finish(). Only a live recording needs this unsolicited terminal
          // path. Stop rather than cancel: finalize() keeps the cumulative
          // transcript the provider already sent and explains the failure.
          if (
            sessionRef.current?.stream !== stream ||
            statusRef.current !== "recording"
          ) return;
          void stopRecordingRef.current?.();
        },
        () => {
          if (
            mountedRef.current &&
            sessionRef.current?.stream === stream &&
            statusRef.current === "recording"
          ) void stopRecordingRef.current?.();
        },
      );
      const current: DictationSession = {
        stream,
        opened: Promise.resolve(),
        pacer: null,
        preRoll: [],
        preRollBytes: 0,
      };
      session = current;
      // Own the connection while opening too, so failed startup and unmount
      // can close it before a microphone is ever started.
      sessionRef.current = current;
      current.opened = stream.open().then(
        () => {
          if (sessionRef.current !== current) return;
          // The provider's real-time clock is running from here on. Audio
          // captured meanwhile goes first; the pacer counts it as sent, so
          // it pads nothing until the wall clock catches up.
          const pacer = new DictationIngressPacer(stream);
          current.pacer = pacer;
          const buffered = concatPcm(current.preRoll, current.preRollBytes);
          current.preRoll = [];
          current.preRollBytes = 0;
          if (buffered.byteLength > 0) pacer.send(buffered);
          pacer.start();
          // A very short allowance may complete before the mic is live. Let
          // the same normal stop path own cleanup and composer delivery.
          if (stream.isComplete && statusRef.current === "recording") {
            void stopRecordingRef.current?.();
          }
        },
        () => {
          // Failure while recording: stop and let finalize() report it with
          // whatever was recognized. Before that, start() reads the failure.
          if (
            sessionRef.current === current &&
            statusRef.current === "recording"
          ) void stopRecordingRef.current?.();
        },
      );

      phase = "recorder";
      const emitter = new LegacyEventEmitter(AudioStudioModule);
      audioSubscriptionRef.current = emitter.addListener<{
        encoded?: string;
        pcmFloat32?: Float32Array | number[];
        buffer?: Float32Array;
      }>("AudioData", (event) => {
        if (!mountedRef.current || sessionRef.current !== current) return;
        const audio = event.encoded ?? event.pcmFloat32 ?? event.buffer;
        if (!audio) return;
        const bytes = audioEventToPcm16(audio);
        if (bytes.byteLength === 0) return;
        updateDictationMeter(pcm16PeakLevel(bytes));
        if (current.pacer) {
          current.pacer.send(bytes);
          return;
        }
        current.preRoll.push(bytes);
        current.preRollBytes += bytes.byteLength;
        while (
          current.preRollBytes > PRE_ROLL_MAX_BYTES &&
          current.preRoll.length > 1
        ) {
          current.preRollBytes -= current.preRoll.shift()!.byteLength;
        }
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
        discardSession(current);
        audioSubscriptionRef.current?.remove();
        audioSubscriptionRef.current = null;
        await releaseAudioMode();
        operationInFlightRef.current = false;
        return false;
      }
      phase = "relay";
      // The relay may already have refused while the recorder was starting.
      stream.throwIfFailed();
      cancelledRef.current = false;
      startedAtRef.current = Date.now();
      startDictationMeter(startedAtRef.current);
      safeSetStatus("recording");
      operationInFlightRef.current = false;
      if (stream.isComplete) void stopRecordingRef.current?.();
      return true;
    } catch (error) {
      console.warn(`[dictation] start failed during ${phase}`, error);
      await AudioStudioModule.stopRecording().catch(() => undefined);
      discardSession(session);
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
  }, [discardSession, releaseAudioMode, safeSetStatus]);

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
      // The recorder's final buffers can still arrive until the subscription
      // is gone; keep the session current so the listener forwards them.
      await releaseAudioMode();
      audioSubscriptionRef.current?.remove();
      audioSubscriptionRef.current = null;
      const session = sessionRef.current;
      sessionRef.current = null;
      session?.pacer?.stop();
      stopDictationMeter();
      resetDictationTranscriptPreview();

      const stream = session?.stream ?? null;
      if (
        !commit ||
        (durationMs < MIN_RECORDING_MS &&
          !stream?.isComplete &&
          !stream?.failure)
      ) {
        discardSession(session);
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
        discardSession(session);
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
        let text = "";
        let failure: Error | null = null;
        if (session && stream) {
          try {
            // Stopping before the relay connected: wait for the handshake,
            // then the pre-roll (the whole utterance) goes out ahead of
            // endStream. The recorder's final flush already went through the
            // listener into the same buffer or pacer.
            await session.opened;
            if (!session.pacer && !stream.failure) {
              const buffered = concatPcm(session.preRoll, session.preRollBytes);
              session.preRoll = [];
              session.preRollBytes = 0;
              if (buffered.byteLength > 0) stream.send(buffered);
            }
            text = await stream.finish();
          } catch (error) {
            failure =
              stream.failure ??
              (error instanceof Error
                ? error
                : new Error("Could not transcribe that audio. Try again."));
          }
        }
        if (failure) {
          // Partials are cumulative, so whatever the provider recognized
          // before it dropped the session is still worth pasting rather than
          // making the user repeat everything they said.
          text = stream?.partialTranscript.trim() ?? "";
          console.warn("[dictation] transcription failed", failure);
          if (mountedRef.current) {
            Alert.alert(
              "Voice input",
              text
                ? `Dictation stopped early. ${failure.message}`
                : failure.message,
            );
          }
        }
        if (text && !cancelledRef.current && mountedRef.current) {
          options.onTranscript(text);
          return text;
        }
        return null;
      } finally {
        discardSession(session);
        try {
          file?.delete();
        } catch {
          /* ignore */
        }
        safeSetStatus("idle");
        operationInFlightRef.current = false;
      }
    },
    [discardSession, releaseAudioMode, safeSetStatus, options],
  );

  const stop = useCallback(() => finalize(true), [finalize]);
  const cancel = useCallback(() => finalize(false), [finalize]);
  stopRecordingRef.current = stop;

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
      discardSession(sessionRef.current);
      audioSubscriptionRef.current?.remove();
      audioSubscriptionRef.current = null;
      stopDictationMeter();
      resetDictationTranscriptPreview();
      void AudioStudioModule.stopRecording().catch(() => undefined);
      void releaseAudioMode();
    };
  }, [discardSession, releaseAudioMode]);

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
