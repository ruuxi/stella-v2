import {
  acquireSharedMicrophone,
  type SharedMicrophoneLease,
} from "@/features/voice/services/shared-microphone";
import { uiState } from "@/platform/ui-state";
import type {
  RealtimeTransport,
  RealtimeTransportEvents,
  RealtimeTransportProvider,
  SdpAnswerFetcher,
} from "./types";

const DEFAULT_RTC_CONFIGURATION: RTCConfiguration = {

  iceCandidatePoolSize: 1,
};

const ICE_GATHERING_TIMEOUT_MS = 4000;

const DATA_CHANNEL_READY_TIMEOUT_MS = 10_000;

export interface OpenAIWebRTCTransportOptions {
  provider: RealtimeTransportProvider;

  model: string;

  sdpFetch: SdpAnswerFetcher;

  initialSessionConfig?: Record<string, unknown>;

  iceServers?: RTCIceServer[];

  waitForIceGathering?: boolean;

  acquireMicBeforeOffer?: boolean;
}

const waitForIceGatheringComplete = (pc: RTCPeerConnection): Promise<void> =>
  new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") {
      resolve();
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      pc.removeEventListener("icegatheringstatechange", onStateChange);
      pc.removeEventListener("icecandidate", onCandidate);
      resolve();
    };
    const onStateChange = () => {
      if (pc.iceGatheringState === "complete") finish();
    };
    const onCandidate = (event: RTCPeerConnectionIceEvent) => {

      if (!event.candidate) finish();
    };
    pc.addEventListener("icegatheringstatechange", onStateChange);
    pc.addEventListener("icecandidate", onCandidate);
    setTimeout(finish, ICE_GATHERING_TIMEOUT_MS);
  });

export class OpenAIWebRTCTransport implements RealtimeTransport {
  readonly provider: RealtimeTransportProvider;
  readonly model: string;

  private readonly sdpFetch: SdpAnswerFetcher;
  private readonly initialSessionConfig?: Record<string, unknown>;
  private readonly iceServers?: RTCIceServer[];
  private readonly waitForIceGathering: boolean;
  private readonly acquireMicBeforeOffer: boolean;

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
  private destroyed = false;

  private events: RealtimeTransportEvents | null = null;
  private pendingSessionUpdateEventId: string | null = null;
  private resolveDataChannelReady: (() => void) | null = null;
  private rejectDataChannelReady: ((error: Error) => void) | null = null;

  constructor(options: OpenAIWebRTCTransportOptions) {
    this.provider = options.provider;
    this.model = options.model;
    this.sdpFetch = options.sdpFetch;
    this.initialSessionConfig = options.initialSessionConfig;
    this.iceServers = options.iceServers;
    this.waitForIceGathering = options.waitForIceGathering ?? false;
    this.acquireMicBeforeOffer = options.acquireMicBeforeOffer ?? false;
  }

  async connect(events: RealtimeTransportEvents): Promise<void> {
    this.events = events;
    const dataChannelReady = this.prepareDataChannelReady();

    void dataChannelReady.catch(() => undefined);

    this.pc = new RTCPeerConnection({
      ...DEFAULT_RTC_CONFIGURATION,
      ...(this.iceServers && this.iceServers.length > 0
        ? { iceServers: this.iceServers }
        : {}),
    });

    const transceiver = this.pc.addTransceiver("audio", {
      direction: "sendrecv",
    });
    this.sender = transceiver.sender;

    this.dc = this.pc.createDataChannel("oai-events");
    this.setupDataChannel();

    this.pc.ontrack = (event) => {
      if (this.destroyed) return;
      const stream = event.streams[0];
      if (stream) this.setupAudioPlayback(stream);
    };

    if (this.acquireMicBeforeOffer) {
      this.micEnabled = true;
      await this.preAttachMicrophone();
      if (this.destroyed) return;
    }

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    if (this.destroyed) return;

    if (this.waitForIceGathering) {
      await waitForIceGatheringComplete(this.pc);
      if (this.destroyed) return;
    }

    const sdpToSend = this.pc.localDescription?.sdp ?? offer.sdp ?? "";

    const answerSdp = await this.sdpFetch(sdpToSend);
    if (this.destroyed) return;

    await this.pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
    if (this.destroyed) return;

    await dataChannelReady;
    if (this.destroyed) return;

    await this.syncMicState();
  }

  send(event: Record<string, unknown>): void {
    if (this.dc?.readyState === "open") {
      this.dc.send(JSON.stringify(event));
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

  interruptPlayback(): void {

  }

  async disconnect(): Promise<void> {
    this.destroyed = true;
    this.events = null;
    this.settleDataChannelReady();

    if (this.dc) {
      try {
        this.dc.close();
      } catch {

      }
      this.dc = null;
    }
    if (this.pc) {
      try {
        this.pc.close();
      } catch {

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

      }
      this.outputMonitorSource = null;
    }
    this.outputAnalyser = null;
    this.remoteStream = null;

    if (this.audioContext) {
      try {
        await this.audioContext.close();
      } catch {

      }
      this.audioContext = null;
      this.analyser = null;
      this.inputGateNode = null;
      this.inputDestination = null;
      this.processedInputTrack = null;
    }
  }

  private setupDataChannel(): void {
    if (!this.dc) return;
    this.dc.onopen = () => {
      if (this.destroyed) return;
      if (this.initialSessionConfig) {
        this.pendingSessionUpdateEventId = `voice_session_update_${Date.now()}_${Math.random()
          .toString(36)
          .slice(2, 10)}`;
        this.send({
          type: "session.update",
          event_id: this.pendingSessionUpdateEventId,
          session: this.initialSessionConfig,
        });
      } else {
        this.settleDataChannelReady();
      }
    };
    this.dc.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data) as Record<string, unknown>;
        this.handleDataChannelHandshakeEvent(parsed);
        this.events?.onEvent(parsed);
      } catch (err) {
        console.debug(
          "[openai-webrtc] Failed to parse data channel message:",
          (err as Error).message,
        );
      }
    };
    this.dc.onclose = () => {
      if (this.destroyed) return;
      this.settleDataChannelReady(
        new Error("Realtime voice data channel closed during setup."),
      );
      this.events?.onClose("Data channel closed");
    };
    this.dc.onerror = () => {
      this.settleDataChannelReady(
        new Error("Realtime voice data channel failed during setup."),
      );
    };
  }

  private prepareDataChannelReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.settleDataChannelReady(
          new Error("Timed out while configuring the realtime voice session."),
        );
      }, DATA_CHANNEL_READY_TIMEOUT_MS);

      this.resolveDataChannelReady = () => {
        clearTimeout(timeout);
        resolve();
      };
      this.rejectDataChannelReady = (error) => {
        clearTimeout(timeout);
        reject(error);
      };
    });
  }

  private settleDataChannelReady(error?: Error): void {
    const resolve = this.resolveDataChannelReady;
    const reject = this.rejectDataChannelReady;
    this.resolveDataChannelReady = null;
    this.rejectDataChannelReady = null;
    this.pendingSessionUpdateEventId = null;
    if (error) reject?.(error);
    else resolve?.();
  }

  private handleDataChannelHandshakeEvent(
    event: Record<string, unknown>,
  ): void {
    if (!this.resolveDataChannelReady || !this.pendingSessionUpdateEventId) {
      return;
    }
    if (event.type === "session.updated") {
      this.settleDataChannelReady();
      return;
    }
    if (event.type !== "error") return;

    const error =
      typeof event.error === "object" && event.error !== null
        ? (event.error as Record<string, unknown>)
        : null;
    const rejectedEventId =
      typeof error?.event_id === "string" ? error.event_id : null;
    if (
      rejectedEventId &&
      rejectedEventId !== this.pendingSessionUpdateEventId
    ) {
      return;
    }
    const message =
      typeof error?.message === "string" && error.message.trim()
        ? error.message.trim()
        : "The realtime provider rejected the voice session configuration.";
    this.settleDataChannelReady(new Error(message));
  }

  private setupAudioPlayback(stream: MediaStream): void {
    if (this.destroyed) return;
    if (this.audioElement) return;

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
          "[openai-webrtc] setSinkId failed, using default output:",
          (err as Error).message,
        );
      });
    }

    this.audioElement.play().catch((err) => {
      console.debug(
        "[openai-webrtc] Audio playback failed:",
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
        "[openai-webrtc] Audio pipeline setup failed:",
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
        if (this.destroyed) return;
        if (this.micEnabled) {
          await this.resumeMicrophoneCapture();
          if (!this.micEnabled || this.destroyed) {
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
          "[openai-webrtc] Failed to detach microphone track:",
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

  private async preAttachMicrophone(): Promise<void> {
    if (this.destroyed || !this.sender) return;
    const lease = await acquireSharedMicrophone();
    if (this.destroyed) {
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

  private async resumeMicrophoneCapture(): Promise<void> {
    if (!this.micEnabled || this.destroyed) return;
    if (!this.sender) return;

    if (this.inputTrack && this.inputTrack.readyState === "live") {
      this.inputTrack.enabled = true;
      return;
    }

    const lease = await acquireSharedMicrophone();
    if (!this.micEnabled || this.destroyed) {
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
