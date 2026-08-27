import { uiState } from "@/platform/ui-state";

const SCHEDULE_FUDGE_SEC = 0.02;

export interface PcmPlayerOptions {

  inputSampleRate: number;

  onSpeakingStart?: () => void;

  onSpeakingEnd?: () => void;
}

export class PcmPlayer {
  private readonly inputRate: number;
  private readonly onSpeakingStart?: () => void;
  private readonly onSpeakingEnd?: () => void;

  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private destination: MediaStreamAudioDestinationNode | null = null;
  private sink: HTMLAudioElement | null = null;
  private scheduledEndSec = 0;
  private isSpeaking = false;
  private speakingEndTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingNodes = new Set<AudioBufferSourceNode>();

  constructor(options: PcmPlayerOptions) {
    this.inputRate = options.inputSampleRate;
    this.onSpeakingStart = options.onSpeakingStart;
    this.onSpeakingEnd = options.onSpeakingEnd;
  }

  private ensureContext(): AudioContext {
    if (this.audioContext) return this.audioContext;

    const ctx = new AudioContext({ sampleRate: this.inputRate });
    this.audioContext = ctx;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.destination = ctx.createMediaStreamDestination();
    this.analyser.connect(this.destination);

    const sink = new Audio();
    sink.autoplay = true;
    sink.srcObject = this.destination.stream;
    const preferredSpeakerId = uiState.getItem(
      "stella-preferred-speaker-id",
    );
    if (preferredSpeakerId && typeof sink.setSinkId === "function") {
      sink.setSinkId(preferredSpeakerId).catch((err) => {
        console.debug(
          "[pcm-player] setSinkId failed, using default output:",
          (err as Error).message,
        );
      });
    }
    sink.play().catch((err) => {
      console.debug(
        "[pcm-player] Audio playback failed:",
        (err as Error).message,
      );
    });
    this.sink = sink;

    return ctx;
  }

  pushBase64Pcm16(base64: string): void {
    const bytes = base64ToBytes(base64);
    if (bytes.byteLength === 0) return;

    const ctx = this.ensureContext();
    if (!this.analyser) return;

    const sampleCount = bytes.byteLength / 2;
    const audioBuffer = ctx.createBuffer(1, sampleCount, this.inputRate);
    const channel = audioBuffer.getChannelData(0);
    const view = new DataView(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    );
    for (let i = 0; i < sampleCount; i += 1) {
      const sample = view.getInt16(i * 2, true);
      channel[i] = sample / 0x8000;
    }

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.analyser);

    const now = ctx.currentTime;
    const startAt = Math.max(
      now + SCHEDULE_FUDGE_SEC,
      this.scheduledEndSec,
    );
    source.start(startAt);
    this.scheduledEndSec = startAt + audioBuffer.duration;

    this.pendingNodes.add(source);
    source.onended = () => {
      this.pendingNodes.delete(source);
    };

    this.markSpeaking();
  }

  flush(): void {
    for (const node of this.pendingNodes) {
      try {
        node.stop();
        node.disconnect();
      } catch {

      }
    }
    this.pendingNodes.clear();
    this.scheduledEndSec = this.audioContext?.currentTime ?? 0;
    if (this.speakingEndTimer) {
      clearTimeout(this.speakingEndTimer);
      this.speakingEndTimer = null;
    }
    if (this.isSpeaking) {
      this.isSpeaking = false;
      this.onSpeakingEnd?.();
    }
  }

  getAnalyser(): AnalyserNode | null {
    return this.analyser;
  }

  async dispose(): Promise<void> {
    this.flush();
    if (this.speakingEndTimer) {
      clearTimeout(this.speakingEndTimer);
      this.speakingEndTimer = null;
    }
    if (this.sink) {
      this.sink.pause();
      this.sink.srcObject = null;
      this.sink = null;
    }
    if (this.destination) {
      try {
        this.destination.disconnect();
      } catch {

      }
      this.destination = null;
    }
    this.analyser = null;
    if (this.audioContext) {
      try {
        await this.audioContext.close();
      } catch {

      }
      this.audioContext = null;
    }
  }

  private markSpeaking(): void {
    if (!this.isSpeaking) {
      this.isSpeaking = true;
      this.onSpeakingStart?.();
    }
    if (this.speakingEndTimer) {
      clearTimeout(this.speakingEndTimer);
    }
    const ctx = this.audioContext;
    if (!ctx) return;
    const tailRemaining = Math.max(
      0,
      this.scheduledEndSec - ctx.currentTime,
    );

    this.speakingEndTimer = setTimeout(
      () => {
        this.speakingEndTimer = null;
        if (!this.isSpeaking) return;
        this.isSpeaking = false;
        this.onSpeakingEnd?.();
      },
      Math.max(40, tailRemaining * 1000 + 50),
    );
  }
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
