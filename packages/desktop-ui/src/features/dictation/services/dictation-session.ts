/**
 * DictationSession captures downsampled 16 kHz mono PCM and streams it through
 * Stella's authenticated dictation relay while the user speaks. Provider
 * credentials stay outside the renderer.
 */

import { uiState } from "@/platform/ui-state";
import {
  acquireSharedMicrophone,
  setSharedMicrophoneKeepWarm,
  type SharedMicrophoneLease,
} from "@/features/voice/services/shared-microphone";
import {
  floatToInt16Pcm,
  resampleLinear,
} from "@/features/voice/services/audio-encoding";
import { DictationStream } from "./dictation-stream";

const TARGET_SAMPLE_RATE = 16_000;
const PCM_WORKLET_NAME = "stella-dictation-pcm-capture";
const PCM_WORKLET_FILE = "dictation-pcm-worklet.js";
const DICTATION_SUPER_FAST_KEY = "stella-dictation-super-fast";
/** Hard cap on a single dictation recording before we auto-stop and
 * transcribe. Stella keeps the existing 15-minute product limit. */
const MAX_DICTATION_DURATION_MS = 15 * 60 * 1000;

/** How often we emit a level tick to consumers (≈ 12 Hz). The waveform UI
 *  appends one bar per tick, so this also controls the bar density of the
 *  scrolling visualization. */
const LEVEL_EMIT_INTERVAL_MS = 80;

/** RMS values during normal speech sit around 0.05–0.15. Multiplying by
 *  this constant maps that range onto a perceptually pleasing 0–1 scale
 *  for the waveform without immediately clipping at the top. */
const LEVEL_GAIN = 6;
const SUPER_FAST_PRE_ROLL_MS = 450;

export const resolveDictationPcmWorkletUrl = (rendererHref: string): string =>
  new URL(PCM_WORKLET_FILE, rendererHref).href;

export type DictationSessionState =
  | "idle"
  | "listening"
  | "transcribing"
  | "error";

type DictationCallbacks = {
  onFinalTranscript?: (text: string) => void;
  onPartialTranscript?: (text: string) => void;
  onStateChange?: (state: DictationSessionState, error?: string) => void;
  /** Periodic 0..1 input-level tick used by the recording UI to render a
   *  scrolling waveform. Fires at ~12 Hz while listening; the value is the
   *  peak RMS observed since the previous tick. */
  onLevel?: (level: number) => void;
};

export function isDictationSuperFastEnabled(): boolean {
  return uiState.getItem(DICTATION_SUPER_FAST_KEY) === "true";
}

export function setDictationSuperFastPreference(enabled: boolean): void {
  uiState.setItem(DICTATION_SUPER_FAST_KEY, enabled ? "true" : "false");
}

class DictationWarmCapture {
  private micLease: SharedMicrophoneLease | null = null;
  private audioContext: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private chunks: Int16Array[] = [];
  private totalSamples = 0;
  private startPromise: Promise<void> | null = null;

  async start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInner().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async stop(): Promise<void> {
    this.tearDownAudioPipeline();
    if (this.audioContext) {
      await this.audioContext.close().catch(() => undefined);
      this.audioContext = null;
    }
    this.micLease?.release();
    this.micLease = null;
    this.chunks = [];
    this.totalSamples = 0;
  }

  snapshot(): Int16Array[] {
    return this.chunks.map((chunk) => chunk.slice());
  }

  private async startInner(): Promise<void> {
    if (this.audioContext && this.micLease) return;
    this.micLease = await acquireSharedMicrophone();
    const ctx = new AudioContext();
    this.audioContext = ctx;
    await ctx.audioWorklet.addModule(
      resolveDictationPcmWorkletUrl(window.location.href),
    );

    const source = ctx.createMediaStreamSource(this.micLease.stream);
    this.sourceNode = source;
    const worklet = new AudioWorkletNode(ctx, PCM_WORKLET_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: "explicit",
      channelInterpretation: "speakers",
    });
    const sourceRate = ctx.sampleRate;
    worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
      const samples = event.data;
      if (!samples?.length) return;
      const resampled =
        sourceRate === TARGET_SAMPLE_RATE
          ? samples
          : resampleLinear(samples, sourceRate, TARGET_SAMPLE_RATE);
      this.append(floatToInt16Pcm(resampled));
    };
    this.workletNode = worklet;
    source.connect(worklet);
  }

  private append(chunk: Int16Array): void {
    this.chunks.push(chunk);
    this.totalSamples += chunk.length;
    const maxSamples = Math.round(
      (SUPER_FAST_PRE_ROLL_MS / 1000) * TARGET_SAMPLE_RATE,
    );
    while (this.totalSamples > maxSamples && this.chunks.length > 0) {
      const first = this.chunks[0]!;
      if (this.totalSamples - first.length >= maxSamples) {
        this.chunks.shift();
        this.totalSamples -= first.length;
        continue;
      }
      const trim = this.totalSamples - maxSamples;
      this.chunks[0] = first.slice(trim);
      this.totalSamples -= trim;
      break;
    }
  }

  private tearDownAudioPipeline(): void {
    if (this.workletNode) {
      this.workletNode.port.onmessage = null;
      this.workletNode.port.close();
      this.workletNode.disconnect();
      this.workletNode = null;
    }
    this.sourceNode?.disconnect();
    this.sourceNode = null;
  }
}

const warmCapture = new DictationWarmCapture();

export async function setDictationSuperFastModeEnabled(
  enabled: boolean,
): Promise<void> {
  setDictationSuperFastPreference(enabled);
  await setSharedMicrophoneKeepWarm(enabled);
  if (enabled) {
    await warmCapture.start();
  } else {
    await warmCapture.stop();
  }
}

export async function ensureDictationSuperFastWarm(): Promise<void> {
  if (!isDictationSuperFastEnabled()) return;
  await setDictationSuperFastModeEnabled(true);
}

export class DictationSession {
  private state: DictationSessionState = "idle";
  private micLease: SharedMicrophoneLease | null = null;
  private audioContext: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private callbacks: DictationCallbacks = {};
  private pcmChunks: Int16Array[] = [];
  private totalSamples = 0;
  private dictationStream: DictationStream | null = null;
  private durationLimitTimer: ReturnType<typeof setTimeout> | null = null;
  private cancelled = false;
  /** Peak RMS seen since the last `onLevel` emit, reset every tick. */
  private peakSinceLastEmit = 0;
  private levelEmitTimer: ReturnType<typeof setInterval> | null = null;

  isActive(): boolean {
    return this.state === "listening" || this.state === "transcribing";
  }

  async start(callbacks: DictationCallbacks): Promise<void> {
    if (this.isActive()) return;
    this.callbacks = callbacks;
    this.cancelled = false;
    this.pcmChunks = isDictationSuperFastEnabled()
      ? warmCapture.snapshot()
      : [];
    this.totalSamples = this.pcmChunks.reduce(
      (sum, chunk) => sum + chunk.length,
      0,
    );

    this.dictationStream = new DictationStream((text) =>
      this.callbacks.onPartialTranscript?.(text),
    );
    try {
      await this.dictationStream.open();
      for (const chunk of this.pcmChunks) this.dictationStream.send(chunk);
      this.pcmChunks = [];
    } catch (error) {
      this.dictationStream = null;
      this.setState("error", (error as Error).message);
      throw error;
    }

    let lease: SharedMicrophoneLease;
    try {
      lease = await acquireSharedMicrophone();
    } catch (err) {
      console.error("[dictation] failed to acquire microphone:", err);
      this.setState("error", (err as Error).message);
      await this.cleanup();
      throw err;
    }
    this.micLease = lease;

    try {
      await this.setupAudioPipeline(lease.stream);
      this.durationLimitTimer = setTimeout(() => {
        console.warn("[dictation] hit max segment duration, auto-stopping");
        void this.stop();
      }, MAX_DICTATION_DURATION_MS);
      this.startLevelEmitter();
      this.setState("listening");
      console.log("[dictation] listening (capturing PCM)");
    } catch (err) {
      console.error("[dictation] failed to start audio pipeline:", err);
      this.setState("error", (err as Error).message);
      await this.cleanup();
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this.state === "idle") return;
    if (this.state === "transcribing") return;

    if (this.durationLimitTimer) {
      clearTimeout(this.durationLimitTimer);
      this.durationLimitTimer = null;
    }
    this.stopLevelEmitter();

    this.tearDownAudioPipeline();
    if (this.micLease) {
      try {
        this.micLease.release();
      } catch {
        // ignore
      }
      this.micLease = null;
    }
    if (this.audioContext) {
      try {
        await this.audioContext.close();
      } catch {
        // ignore
      }
      this.audioContext = null;
    }

    if (this.cancelled) {
      this.dictationStream?.cancel();
      this.dictationStream = null;
      this.pcmChunks = [];
      this.totalSamples = 0;
      this.setState("idle");
      return;
    }

    const totalSamples = this.totalSamples;
    if (totalSamples === 0) {
      console.log("[dictation] no audio captured, skipping upload");
      this.setState("idle");
      return;
    }

    this.setState("transcribing");
    const durationMs = Math.round((totalSamples / TARGET_SAMPLE_RATE) * 1000);
    console.log(
      `[dictation] uploading ${totalSamples} samples (${durationMs}ms)`,
    );

    try {
      this.pcmChunks = [];
      const stream = this.dictationStream;
      if (!stream) throw new Error("Dictation stream is unavailable.");
      const transcript = await stream.finish();
      this.dictationStream = null;
      if (this.cancelled) {
        this.setState("idle");
        return;
      }
      if (!transcript) {
        this.setState("idle");
        return;
      }
      this.setState("idle");
      this.callbacks.onFinalTranscript?.(transcript);
    } catch (err) {
      console.error("[dictation] transcription failed:", err);
      if (this.cancelled) this.setState("idle");
      else this.setState("error", (err as Error).message);
    }
  }

  /** Stop without uploading. Used on unmount / error paths. */
  async cancel(): Promise<void> {
    this.cancelled = true;
    this.dictationStream?.cancel();
    await this.stop();
  }

  private async setupAudioPipeline(stream: MediaStream): Promise<void> {
    const ctx = new AudioContext();
    this.audioContext = ctx;

    await ctx.audioWorklet.addModule(
      resolveDictationPcmWorkletUrl(window.location.href),
    );

    const source = ctx.createMediaStreamSource(stream);
    this.sourceNode = source;

    const worklet = new AudioWorkletNode(ctx, PCM_WORKLET_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: "explicit",
      channelInterpretation: "speakers",
    });
    const sourceRate = ctx.sampleRate;
    worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
      const samples = event.data;
      if (!samples || samples.length === 0) return;

      // Cheap RMS over the raw chunk for the level meter — feeds the
      // scrolling waveform UI without allocating anything.
      let sumSq = 0;
      for (let i = 0; i < samples.length; i += 1) {
        const s = samples[i]!;
        sumSq += s * s;
      }
      const rms = Math.sqrt(sumSq / samples.length);
      if (rms > this.peakSinceLastEmit) this.peakSinceLastEmit = rms;

      const resampled =
        sourceRate === TARGET_SAMPLE_RATE
          ? samples
          : resampleLinear(samples, sourceRate, TARGET_SAMPLE_RATE);
      const pcm = floatToInt16Pcm(resampled);
      this.totalSamples += pcm.length;
      this.dictationStream?.send(pcm);
    };
    this.workletNode = worklet;

    source.connect(worklet);
  }

  private tearDownAudioPipeline(): void {
    if (this.workletNode) {
      try {
        this.workletNode.port.onmessage = null;
        this.workletNode.port.close();
      } catch {
        // ignore
      }
      try {
        this.workletNode.disconnect();
      } catch {
        // ignore
      }
      this.workletNode = null;
    }
    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect();
      } catch {
        // ignore
      }
      this.sourceNode = null;
    }
  }

  private async cleanup(): Promise<void> {
    this.tearDownAudioPipeline();
    if (this.audioContext) {
      try {
        await this.audioContext.close();
      } catch {
        // ignore
      }
      this.audioContext = null;
    }
    if (this.micLease) {
      try {
        this.micLease.release();
      } catch {
        // ignore
      }
      this.micLease = null;
    }
    if (this.durationLimitTimer) {
      clearTimeout(this.durationLimitTimer);
      this.durationLimitTimer = null;
    }
    this.stopLevelEmitter();
    this.dictationStream?.cancel();
    this.dictationStream = null;
  }

  private startLevelEmitter(): void {
    this.stopLevelEmitter();
    this.peakSinceLastEmit = 0;
    this.levelEmitTimer = setInterval(() => {
      const level = Math.min(1, this.peakSinceLastEmit * LEVEL_GAIN);
      this.peakSinceLastEmit = 0;
      this.callbacks.onLevel?.(level);
    }, LEVEL_EMIT_INTERVAL_MS);
  }

  private stopLevelEmitter(): void {
    if (this.levelEmitTimer) {
      clearInterval(this.levelEmitTimer);
      this.levelEmitTimer = null;
    }
    this.peakSinceLastEmit = 0;
  }

  private setState(state: DictationSessionState, error?: string): void {
    this.state = state;
    this.callbacks.onStateChange?.(state, error);
  }
}
