import {
  floatToInt16Pcm,
  resampleLinear,
} from "@/features/voice/services/audio-encoding";

const DEFAULT_TARGET_RATE = 24000;
const DEFAULT_BUFFER_SIZE = 4096;

export interface MicCaptureOptions {

  targetSampleRate?: number;

  bufferSize?: number;

  onChunk: (base64Pcm: string) => void;
}

export class MicCapture {
  private readonly targetRate: number;
  private readonly bufferSize: number;
  private readonly onChunk: (base64Pcm: string) => void;

  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private gateGain: GainNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private muted = false;
  private streaming = false;

  constructor(options: MicCaptureOptions) {
    this.targetRate = options.targetSampleRate ?? DEFAULT_TARGET_RATE;
    this.bufferSize = options.bufferSize ?? DEFAULT_BUFFER_SIZE;
    this.onChunk = options.onChunk;
  }

  attach(stream: MediaStream): void {
    this.teardownNodes();

    if (!this.audioContext) {
      this.audioContext = new AudioContext();
    }
    const ctx = this.audioContext;

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 256;

    this.gateGain = ctx.createGain();
    this.gateGain.gain.value = this.muted ? 0 : 1;

    this.source = ctx.createMediaStreamSource(stream);
    this.processor = ctx.createScriptProcessor(this.bufferSize, 1, 1);

    this.source.connect(this.analyser);
    this.source.connect(this.gateGain);
    this.gateGain.connect(this.processor);

    this.processor.connect(ctx.destination);

    const sourceRate = ctx.sampleRate;
    const targetRate = this.targetRate;

    this.processor.onaudioprocess = (event) => {
      if (!this.streaming) return;
      const input = event.inputBuffer.getChannelData(0);
      const downsampled =
        sourceRate === targetRate
          ? input
          : resampleLinear(input, sourceRate, targetRate);
      const pcm16 = floatToInt16Pcm(downsampled);
      this.onChunk(toBase64(pcm16));
    };
  }

  start(): void {
    this.streaming = true;
  }

  stop(): void {
    this.streaming = false;
  }

  setSoftMute(muted: boolean): void {
    this.muted = muted;
    if (!this.gateGain || !this.audioContext) return;
    const target = muted ? 0 : 1;
    const now = this.audioContext.currentTime;
    this.gateGain.gain.cancelScheduledValues(now);
    this.gateGain.gain.setTargetAtTime(target, now, 0.015);
  }

  getAnalyser(): AnalyserNode | null {
    return this.analyser;
  }

  detach(): void {
    this.streaming = false;
    this.teardownNodes();
  }

  async dispose(): Promise<void> {
    this.streaming = false;
    this.teardownNodes();
    if (this.audioContext) {
      try {
        await this.audioContext.close();
      } catch {

      }
      this.audioContext = null;
    }
  }

  private teardownNodes(): void {
    if (this.processor) {
      this.processor.onaudioprocess = null;
      try {
        this.processor.disconnect();
      } catch {

      }
      this.processor = null;
    }
    if (this.source) {
      try {
        this.source.disconnect();
      } catch {

      }
      this.source = null;
    }
    if (this.gateGain) {
      try {
        this.gateGain.disconnect();
      } catch {

      }
      this.gateGain = null;
    }
    this.analyser = null;
  }
}

function toBase64(pcm16: Int16Array): string {

  const bytes = new Uint8Array(
    pcm16.buffer,
    pcm16.byteOffset,
    pcm16.byteLength,
  );
  let binary = "";

  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + CHUNK) as unknown as number[],
    );
  }
  return btoa(binary);
}
