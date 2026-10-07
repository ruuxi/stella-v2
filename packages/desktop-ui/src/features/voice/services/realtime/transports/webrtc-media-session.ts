/**
 * Shared WebRTC plumbing for every realtime voice transport that speaks over
 * an RTCPeerConnection: peer setup, the SDP exchange, the JSON data channel,
 * shared-microphone acquisition, the input gate used by the echo guard, and
 * the mic/output analysers the overlay visualises.
 *
 * Two protocols sit on top of this:
 *   - `openai-webrtc-transport.ts` (OpenAI Realtime; BYOK only)
 *   - `gpt-live-webrtc-transport.ts` (GPT-Live; Stella-managed)
 *
 * Everything protocol-shaped — which events mean "ready", how the session is
 * configured, how it is closed gracefully — belongs to the transport. This
 * file only knows how to move bytes and audio.
 */

import {
  acquireSharedMicrophone,
  type SharedMicrophoneLease,
} from "@/features/voice/services/shared-microphone";
import { uiState } from "@/platform/ui-state";
import type { SdpAnswerFetcher } from "./types";

const DEFAULT_RTC_CONFIGURATION: RTCConfiguration = {
  iceCandidatePoolSize: 1,
};

/**
 * The physical connection must finish before the managed authority's outer
 * ten-second lease can expire. This also bounds provider SDP requests that do
 * not otherwise have a client-side timeout.
 */
export const CONNECT_DEADLINE_MS = 8_000;

export const connectionAbortError = (): Error => {
  const error = new Error("Realtime voice connection was canceled.");
  error.name = "AbortError";
  return error;
};

export const abortReason = (signal: AbortSignal): Error =>
  signal.reason instanceof Error ? signal.reason : connectionAbortError();

let eventIdCounter = 0;

/** Client event id used to match a provider ack back to our outgoing event. */
export const createClientEventId = (prefix: string): string => {
  eventIdCounter += 1;
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${eventIdCounter}_${random}`;
};

export type WebRTCMediaSessionHandlers = {
  /** The data channel is open; the protocol handshake may begin. */
  onChannelOpen: () => void;
  /** One parsed JSON event from the provider. */
  onMessage: (event: Record<string, unknown>) => void;
  /** The channel closed or errored; the transport decides what that means. */
  onChannelDown: (reason: string, kind: "close" | "error") => void;
};

export type WebRTCMediaSessionOptions = {
  /** Data channel label. Both protocols use `oai-events`. */
  dataChannelLabel: string;
  sdpFetch: SdpAnswerFetcher;
  /** Console tag so logs say which protocol produced them. */
  logPrefix: string;
};

/**
 * Owns the peer connection and the audio pipeline for one call.
 *
 * `open()` creates the data channel BEFORE generating the SDP offer, which
 * both protocols require, and resolves once the remote description is
 * applied. The caller then waits for whatever its protocol considers ready
 * before unmuting the microphone.
 */
export class WebRTCMediaSession {
  private readonly options: WebRTCMediaSessionOptions;
  private handlers: WebRTCMediaSessionHandlers | null = null;

  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private sender: RTCRtpSender | null = null;
  private audioElement: HTMLAudioElement | null = null;
  private remoteStream: MediaStream | null = null;

  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private inputGateNode: GainNode | null = null;
  private inputDestination: MediaStreamAudioDestinationNode | null = null;
  private processedInputTrack: MediaStreamTrack | null = null;
  private inputSourceNode: MediaStreamAudioSourceNode | null = null;
  private outputAnalyser: AnalyserNode | null = null;
  private outputMonitorSource: MediaStreamAudioSourceNode | null = null;

  private micLease: SharedMicrophoneLease | null = null;
  private localStream: MediaStream | null = null;
  private inputTrack: MediaStreamTrack | null = null;
  private micEnabled = false;
  private micSyncPromise: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(options: WebRTCMediaSessionOptions) {
    this.options = options;
  }

  attach(handlers: WebRTCMediaSessionHandlers): void {
    this.handlers = handlers;
  }

  detach(): void {
    this.handlers = null;
  }

  get isChannelOpen(): boolean {
    return this.dc?.readyState === "open";
  }

  async open(signal: AbortSignal): Promise<void> {
    this.throwIfCanceled(signal);

    const pc = new RTCPeerConnection(DEFAULT_RTC_CONFIGURATION);
    this.pc = pc;

    const transceiver = pc.addTransceiver("audio", { direction: "sendrecv" });
    this.sender = transceiver.sender;

    this.dc = pc.createDataChannel(this.options.dataChannelLabel);
    this.setupDataChannel();

    pc.ontrack = (event) => {
      if (this.closed) return;
      const stream = event.streams[0];
      if (stream) this.setupAudioPlayback(stream);
    };

    const offer = await pc.createOffer();
    this.throwIfCanceled(signal);
    await pc.setLocalDescription(offer);
    this.throwIfCanceled(signal);

    const sdpToSend = pc.localDescription?.sdp ?? offer.sdp ?? "";
    const answerSdp = await this.options.sdpFetch(sdpToSend, signal);
    this.throwIfCanceled(signal);

    await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
    this.throwIfCanceled(signal);
  }

  send(event: Record<string, unknown>): boolean {
    if (this.dc?.readyState !== "open") return false;
    try {
      this.dc.send(JSON.stringify(event));
      return true;
    } catch (err) {
      console.debug(
        `${this.options.logPrefix} Failed to send event:`,
        (err as Error).message,
      );
      return false;
    }
  }

  setMicEnabled(enabled: boolean): Promise<void> {
    this.micEnabled = enabled;
    return this.syncMicState();
  }

  applySoftInputMute(muted: boolean): void {
    if (!this.inputGateNode || !this.audioContext) return;
    const target = muted ? 0 : 1;
    const now = this.audioContext.currentTime;
    this.inputGateNode.gain.cancelScheduledValues(now);
    this.inputGateNode.gain.setTargetAtTime(target, now, 0.015);
  }

  getMicAnalyser(): AnalyserNode | null {
    return this.analyser;
  }

  getOutputAnalyser(): AnalyserNode | null {
    return this.outputAnalyser;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.handlers = null;

    if (this.dc) {
      try {
        this.dc.close();
      } catch {
        // Already closed.
      }
      this.dc = null;
    }
    if (this.pc) {
      try {
        this.pc.close();
      } catch {
        // Already closed.
      }
      this.pc = null;
    }

    this.releaseMicrophoneCapture();
    this.sender = null;

    if (this.audioElement) {
      this.audioElement.pause();
      this.audioElement.srcObject = null;
      this.audioElement = null;
    }

    if (this.outputMonitorSource) {
      try {
        this.outputMonitorSource.disconnect();
      } catch {
        // Already disconnected.
      }
      this.outputMonitorSource = null;
    }
    this.outputAnalyser = null;
    this.remoteStream = null;

    if (this.audioContext) {
      try {
        await this.audioContext.close();
      } catch {
        // Already closed.
      }
      this.audioContext = null;
      this.analyser = null;
      this.inputGateNode = null;
      this.inputDestination = null;
      this.processedInputTrack = null;
    }
  }

  private throwIfCanceled(signal: AbortSignal): void {
    if (!this.closed && !signal.aborted) return;
    throw abortReason(signal);
  }

  private setupDataChannel(): void {
    if (!this.dc) return;
    this.dc.onopen = () => {
      if (this.closed) return;
      this.handlers?.onChannelOpen();
    };
    this.dc.onmessage = (event) => {
      if (this.closed) return;
      try {
        const parsed = JSON.parse(event.data) as Record<string, unknown>;
        this.handlers?.onMessage(parsed);
      } catch (err) {
        console.debug(
          `${this.options.logPrefix} Failed to parse data channel message:`,
          (err as Error).message,
        );
      }
    };
    this.dc.onclose = () => {
      if (this.closed) return;
      this.handlers?.onChannelDown("Data channel closed", "close");
    };
    this.dc.onerror = () => {
      if (this.closed) return;
      this.handlers?.onChannelDown("Data channel failed", "error");
    };
  }

  private setupAudioPlayback(stream: MediaStream): void {
    if (this.closed || this.audioElement) return;

    this.audioElement = new Audio();
    this.audioElement.srcObject = stream;
    this.audioElement.autoplay = true;

    const preferredSpeakerId = uiState.getItem("stella-preferred-speaker-id");
    if (
      preferredSpeakerId &&
      typeof this.audioElement.setSinkId === "function"
    ) {
      this.audioElement.setSinkId(preferredSpeakerId).catch((err) => {
        console.debug(
          `${this.options.logPrefix} setSinkId failed, using default output:`,
          (err as Error).message,
        );
      });
    }

    this.audioElement.play().catch((err) => {
      console.debug(
        `${this.options.logPrefix} Audio playback failed:`,
        (err as Error).message,
      );
    });

    this.remoteStream = stream;
    this.attachOutputMonitor(stream);
  }

  private setupLocalAudioPipeline(stream: MediaStream): void {
    try {
      if (!this.audioContext) {
        const ctx = new AudioContext();
        this.audioContext = ctx;
        this.analyser = ctx.createAnalyser();
        this.analyser.fftSize = 256;
        this.inputGateNode = ctx.createGain();
        this.inputGateNode.gain.value = 1;
        this.inputDestination = ctx.createMediaStreamDestination();
        this.inputGateNode.connect(this.inputDestination);
        this.processedInputTrack =
          this.inputDestination.stream.getAudioTracks()[0] ?? null;

        if (this.remoteStream) {
          this.attachOutputMonitor(this.remoteStream);
        }
      }
      this.attachLocalInputStream(stream);
    } catch (err) {
      console.debug(
        `${this.options.logPrefix} Audio pipeline setup failed:`,
        (err as Error).message,
      );
    }
  }

  private attachLocalInputStream(stream: MediaStream): void {
    if (!this.audioContext || !this.analyser || !this.inputGateNode) return;
    if (this.inputSourceNode) {
      try {
        this.inputSourceNode.disconnect();
      } catch {
        // Already disconnected.
      }
      this.inputSourceNode = null;
    }
    const source = this.audioContext.createMediaStreamSource(stream);
    source.connect(this.analyser);
    source.connect(this.inputGateNode);
    this.inputSourceNode = source;
  }

  private attachOutputMonitor(stream: MediaStream): void {
    if (!this.audioContext) return;
    if (this.outputMonitorSource) {
      try {
        this.outputMonitorSource.disconnect();
      } catch {
        // Already disconnected.
      }
      this.outputMonitorSource = null;
    }
    this.outputAnalyser = this.audioContext.createAnalyser();
    this.outputAnalyser.fftSize = 256;
    const source = this.audioContext.createMediaStreamSource(stream);
    source.connect(this.outputAnalyser);
    this.outputMonitorSource = source;
  }

  private syncMicState(): Promise<void> {
    this.micSyncPromise = this.micSyncPromise
      .catch(() => undefined)
      .then(async () => {
        if (this.closed) return;
        if (this.micEnabled) {
          await this.resumeMicrophoneCapture();
          if (!this.micEnabled || this.closed) {
            await this.suspendMicrophoneCapture();
          }
          return;
        }
        await this.suspendMicrophoneCapture();
      });
    return this.micSyncPromise;
  }

  private async suspendMicrophoneCapture(): Promise<void> {
    if (!this.inputTrack && !this.localStream && !this.micLease) {
      this.applySoftInputMute(false);
      return;
    }
    if (this.sender) {
      try {
        await this.sender.replaceTrack(null);
      } catch (err) {
        console.debug(
          `${this.options.logPrefix} Failed to detach microphone track:`,
          (err as Error).message,
        );
      }
    }
    if (this.inputTrack && this.inputTrack.readyState === "live") {
      this.inputTrack.enabled = false;
    }
    this.applySoftInputMute(false);
    this.releaseMicrophoneCapture();
  }

  private async resumeMicrophoneCapture(): Promise<void> {
    if (!this.micEnabled || this.closed) return;
    if (!this.sender) return;

    if (this.inputTrack && this.inputTrack.readyState === "live") {
      this.inputTrack.enabled = true;
      return;
    }

    const lease = await acquireSharedMicrophone();
    if (!this.micEnabled || this.closed) {
      lease.release();
      return;
    }
    this.micLease = lease;
    this.localStream = lease.stream;
    this.inputTrack = this.localStream.getTracks()[0] ?? null;
    if (!this.inputTrack) {
      this.micLease.release();
      this.micLease = null;
      this.localStream = null;
      throw new Error("No microphone track available");
    }

    this.setupLocalAudioPipeline(this.localStream);
    this.inputTrack.enabled = true;

    try {
      await this.sender.replaceTrack(
        this.processedInputTrack ?? this.inputTrack,
      );
    } catch (err) {
      this.releaseMicrophoneCapture();
      throw err;
    }
  }

  private releaseMicrophoneCapture(): void {
    if (this.inputSourceNode) {
      try {
        this.inputSourceNode.disconnect();
      } catch {
        // Already disconnected.
      }
      this.inputSourceNode = null;
    }
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => track.stop());
      this.localStream = null;
    }
    if (this.micLease) {
      this.micLease.release();
      this.micLease = null;
    }
    this.inputTrack = null;
  }
}

/**
 * Runs one connect attempt under a hard deadline and a cancellable signal.
 * `isDestroyed` lets an intentional disconnect end an in-progress connect
 * without surfacing a new error, which both transports rely on.
 */
export const runConnectWithDeadline = async (args: {
  deadlineMessage: string;
  isDestroyed: () => boolean;
  setController: (controller: AbortController | null) => void;
  getController: () => AbortController | null;
  attempt: (signal: AbortSignal) => Promise<void>;
  onDeadline: () => Promise<void>;
}): Promise<void> => {
  const controller = new AbortController();
  const deadlineError = new Error(args.deadlineMessage);
  let deadlineReached = false;
  let rejectOnAbort: ((error: Error) => void) | null = null;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = reject;
  });
  const onAbort = () => rejectOnAbort?.(abortReason(controller.signal));

  args.setController(controller);
  controller.signal.addEventListener("abort", onAbort, { once: true });
  const deadlineTimer = setTimeout(() => {
    if (args.getController() !== controller || controller.signal.aborted) {
      return;
    }
    deadlineReached = true;
    controller.abort(deadlineError);
  }, CONNECT_DEADLINE_MS);

  try {
    await Promise.race([args.attempt(controller.signal), aborted]);
  } catch (error) {
    if (deadlineReached) {
      await args.onDeadline();
      throw deadlineError;
    }
    if (args.isDestroyed() && controller.signal.aborted) {
      return;
    }
    throw error;
  } finally {
    controller.signal.removeEventListener("abort", onAbort);
    clearTimeout(deadlineTimer);
    if (args.getController() === controller) args.setController(null);
  }
};
