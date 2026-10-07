import { uiState } from "@/platform/ui-state";
import {
  acquireSharedMicrophone,
  setSharedMicrophoneKeepWarm,
  type SharedMicrophoneLease,
} from "@/features/voice/services/shared-microphone";
import { DictationStream } from "./dictation-stream";
import { transcribeDictation } from "./dictation-transcriber";
import { PcmRecording } from "./pcm-recording";

type WorkletFrame = { pcm: Int16Array; rms: number };

const TARGET_SAMPLE_RATE = 16_000;
const STREAM_PRE_ROLL_MAX_SAMPLES = 4 * TARGET_SAMPLE_RATE;
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
    worklet.port.onmessage = (event: MessageEvent<WorkletFrame>) => {
      const pcm = event.data?.pcm;
      if (pcm?.length) this.append(pcm);
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
  private recording = new PcmRecording();
  private transcription: AbortController | null = null;
  private stream: DictationStream | null = null;
  private streamOpened: Promise<boolean> = Promise.resolve(false);
  private streamReady = false;
  private streamFailed = false;
  private pending: Int16Array[] = [];
  private pendingSamples = 0;
  private durationLimitTimer: ReturnType<typeof setTimeout> | null = null;
  private cancelled = false;
  /** Peak RMS seen since the last `onLevel` emit, reset every tick. */
  private peakSinceLastEmit = 0;
  private levelEmitTimer: ReturnType<typeof setInterval> | null = null;

  isActive(): boolean {
    return this.state === "listening" || this.state === "transcribing";
  }

  async start(
    callbacks: DictationCallbacks,
    options: { streaming?: boolean } = {},
  ): Promise<void> {
    if (this.isActive()) return;
    this.callbacks = callbacks;
    this.cancelled = false;
    this.recording = new PcmRecording();
    this.resetStream();
    if (options.streaming) this.openStream();
    if (isDictationSuperFastEnabled()) {
      for (const chunk of warmCapture.snapshot()) this.capture(chunk);
    }

    let lease: SharedMicrophoneLease;
    try {
      lease = await acquireSharedMicrophone();
    } catch (err) {
      if (this.cancelled) {
        await this.cleanup();
        this.setState("idle");
        return;
      }
      console.error("[dictation] failed to acquire microphone:", err);
      this.setState("error", (err as Error).message);
      await this.cleanup();
      throw err;
    }
    this.micLease = lease;

    try {
      if (!this.cancelled) await this.setupAudioPipeline(lease.stream);
      if (this.cancelled) {
        await this.cleanup();
        this.setState("idle");
        return;
      }
      this.durationLimitTimer = setTimeout(() => {
        console.warn("[dictation] hit max segment duration, auto-stopping");
        void this.stop();
      }, MAX_DICTATION_DURATION_MS);
      this.startLevelEmitter();
      this.setState("listening");
    } catch (err) {
      console.error("[dictation] failed to start dictation:", err);
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
    this.micLease?.release();
    this.micLease = null;
    if (this.audioContext) {
      await this.audioContext.close().catch(() => undefined);
      this.audioContext = null;
    }

    const recording = this.recording;
    this.recording = new PcmRecording();
    if (this.cancelled || recording.sampleCount === 0) {
      this.stream?.cancel();
      this.resetStream();
      this.setState("idle");
      return;
    }

    this.setState("transcribing");
    const controller = new AbortController();
    this.transcription = controller;
    try {
      const streamed = await this.finishStream();
      const transcript =
        streamed ??
        (await transcribeDictation(recording.toWav(), controller.signal));
      if (this.cancelled || !transcript) {
        this.setState("idle");
        return;
      }
      this.setState("idle");
      this.callbacks.onFinalTranscript?.(transcript);
    } catch (err) {
      if (this.cancelled) {
        this.setState("idle");
        return;
      }
      console.error("[dictation] transcription failed:", err);
      this.setState("error", (err as Error).message);
    } finally {
      if (this.transcription === controller) this.transcription = null;
    }
  }

  /** Stop without transcribing. Used on unmount / error paths. */
  async cancel(): Promise<void> {
    this.cancelled = true;
    this.stream?.cancel();
    if (this.state === "transcribing") {
      this.transcription?.abort();
      this.setState("idle");
      this.callbacks = {};
      return;
    }
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
    worklet.port.onmessage = (event: MessageEvent<WorkletFrame>) => {
      const frame = event.data;
      if (!frame?.pcm?.length) return;
      if (frame.rms > this.peakSinceLastEmit) this.peakSinceLastEmit = frame.rms;
      this.capture(frame.pcm);
      if (this.recording.full && this.state === "listening") {
        console.warn("[dictation] hit max recording length, auto-stopping");
        void this.stop();
      }
    };
    this.workletNode = worklet;
    source.connect(worklet);
  }

  private resetStream(): void {
    this.stream = null;
    this.streamOpened = Promise.resolve(false);
    this.streamReady = false;
    this.streamFailed = false;
    this.pending = [];
    this.pendingSamples = 0;
  }

  private openStream(): void {
    const stream = new DictationStream(
      (text) => {
        if (this.stream === stream) this.callbacks.onPartialTranscript?.(text);
      },
      (error) => {
        if (this.stream !== stream) return;
        console.warn("[dictation] stream failed, will transcribe the recording:", error.message);
        this.abandonStream();
      },
    );
    this.stream = stream;
    this.streamOpened = stream.open().then(
      () => {
        if (this.stream !== stream || this.streamFailed) return false;
        for (const chunk of this.pending) stream.send(chunk);
        this.pending = [];
        this.pendingSamples = 0;
        this.streamReady = true;
        return true;
      },
      (error: unknown) => {
        if (this.stream === stream) {
          console.warn("[dictation] stream did not open, will transcribe the recording:", (error as Error).message);
          this.abandonStream();
        }
        return false;
      },
    );
  }

  private abandonStream(): void {
    this.streamFailed = true;
    this.stream?.cancel();
    this.pending = [];
    this.pendingSamples = 0;
  }

  private capture(pcm: Int16Array): void {
    this.recording.append(pcm);
    if (!this.stream || this.streamFailed) return;
    if (this.streamReady) {
      this.stream.send(pcm);
      return;
    }
    this.pending.push(pcm);
    this.pendingSamples += pcm.length;
    if (this.pendingSamples > STREAM_PRE_ROLL_MAX_SAMPLES) this.abandonStream();
  }

  private async finishStream(): Promise<string | null> {
    const stream = this.stream;
    if (!stream || this.streamFailed) return null;
    try {
      if (!(await this.streamOpened) || this.streamFailed) return null;
      return await stream.finish();
    } catch (error) {
      console.warn("[dictation] stream did not finish, will transcribe the recording:", (error as Error).message);
      return null;
    } finally {
      if (this.stream === stream) this.resetStream();
    }
  }

  private tearDownAudioPipeline(): void {
    if (this.workletNode) {
      try {
        this.workletNode.port.onmessage = null;
        this.workletNode.port.close();
        this.workletNode.disconnect();
      } catch {
        // The node may already be gone with its context.
      }
      this.workletNode = null;
    }
    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect();
      } catch {
        // Already disconnected.
      }
      this.sourceNode = null;
    }
  }

  private async cleanup(): Promise<void> {
    this.stream?.cancel();
    this.resetStream();
    this.tearDownAudioPipeline();
    if (this.audioContext) {
      await this.audioContext.close().catch(() => undefined);
      this.audioContext = null;
    }
    this.micLease?.release();
    this.micLease = null;
    if (this.durationLimitTimer) {
      clearTimeout(this.durationLimitTimer);
      this.durationLimitTimer = null;
    }
    this.stopLevelEmitter();
    this.recording = new PcmRecording();
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
