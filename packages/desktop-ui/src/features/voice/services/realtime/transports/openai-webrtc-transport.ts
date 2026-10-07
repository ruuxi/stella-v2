/**
 * WebRTC transport for the OpenAI Realtime API (BYOK only).
 *
 * The Stella-managed path no longer runs here — it is GPT-Live, which is a
 * different protocol (`gpt-live-webrtc-transport.ts`). This transport remains
 * for a user's own OpenAI key: it POSTs the SDP offer with a Bearer token and
 * applies session config with `session.update` once the data channel opens,
 * waiting for `session.updated` before exposing the connection.
 *
 * All of the peer-connection, microphone, playback and analyser plumbing is
 * shared with the GPT-Live transport via `webrtc-media-session.ts`.
 */

import type {
  RealtimeTransport,
  RealtimeTransportEvents,
  RealtimeTransportProvider,
  SdpAnswerFetcher,
} from "./types";
import {
  WebRTCMediaSession,
  connectionAbortError,
  createClientEventId,
  runConnectWithDeadline,
} from "./webrtc-media-session";

const SESSION_READY_TIMEOUT_MS = 10_000;
const CONNECT_DEADLINE_MESSAGE =
  "Timed out while connecting to the realtime voice provider.";

export interface OpenAIWebRTCTransportOptions {
  /** Server-reported model id (or the requested model as a fallback). */
  model: string;
  /** Provider-specific SDP exchange (endpoint + auth). */
  sdpFetch: SdpAnswerFetcher;
  /** Session config applied with `session.update` once the channel opens. */
  initialSessionConfig?: Record<string, unknown>;
}

export class OpenAIWebRTCTransport implements RealtimeTransport {
  readonly provider: RealtimeTransportProvider = "openai";
  readonly model: string;

  private readonly media: WebRTCMediaSession;
  private readonly initialSessionConfig?: Record<string, unknown>;
  private events: RealtimeTransportEvents | null = null;

  private destroyed = false;
  private micEnabled = false;
  private connectAbortController: AbortController | null = null;
  private pendingSessionUpdateEventId: string | null = null;
  private resolveSessionReady: (() => void) | null = null;
  private rejectSessionReady: ((error: Error) => void) | null = null;

  constructor(options: OpenAIWebRTCTransportOptions) {
    this.model = options.model;
    this.initialSessionConfig = options.initialSessionConfig;
    this.media = new WebRTCMediaSession({
      dataChannelLabel: "oai-events",
      sdpFetch: options.sdpFetch,
      logPrefix: "[openai-webrtc]",
    });
  }

  async connect(events: RealtimeTransportEvents): Promise<void> {
    if (this.destroyed) {
      throw new Error("Cannot connect a disconnected realtime transport.");
    }
    if (this.connectAbortController) {
      throw new Error("Realtime voice transport is already connecting.");
    }

    await runConnectWithDeadline({
      deadlineMessage: CONNECT_DEADLINE_MESSAGE,
      isDestroyed: () => this.destroyed,
      setController: (controller) => {
        this.connectAbortController = controller;
      },
      getController: () => this.connectAbortController,
      attempt: (signal) => this.connectWithSignal(events, signal),
      onDeadline: () => this.disconnect(),
    });
  }

  private async connectWithSignal(
    events: RealtimeTransportEvents,
    signal: AbortSignal,
  ): Promise<void> {
    this.events = events;
    const ready = this.prepareSessionReady();
    void ready.catch(() => undefined);

    this.media.attach({
      onChannelOpen: () => {
        if (!this.initialSessionConfig) {
          this.settleSessionReady();
          return;
        }
        this.pendingSessionUpdateEventId =
          createClientEventId("voice_session_update");
        this.media.send({
          type: "session.update",
          event_id: this.pendingSessionUpdateEventId,
          session: this.initialSessionConfig,
        });
      },
      onMessage: (event) => {
        this.handleHandshakeEvent(event);
        this.events?.onEvent(event);
      },
      onChannelDown: (reason) => {
        this.settleSessionReady(
          new Error("Realtime voice data channel closed during setup."),
        );
        this.events?.onClose(reason);
      },
    });

    await this.media.open(signal);
    this.throwIfCanceled(signal);

    await ready;
    this.throwIfCanceled(signal);

    await this.media.setMicEnabled(this.micEnabled);
    this.throwIfCanceled(signal);
  }

  send(event: Record<string, unknown>): void {
    this.media.send(event);
  }

  setMicEnabled(enabled: boolean): Promise<void> {
    this.micEnabled = enabled;
    return this.media.setMicEnabled(enabled);
  }

  applySoftInputMute(muted: boolean): void {
    this.media.applySoftInputMute(muted);
  }

  getMicAnalyser(): AnalyserNode | null {
    return this.media.getMicAnalyser();
  }

  getOutputAnalyser(): AnalyserNode | null {
    return this.media.getOutputAnalyser();
  }

  interruptPlayback(): void {
    // WebRTC has no client-side queue to flush; remote playback stops as the
    // model stops sending audio frames.
  }

  async disconnect(): Promise<void> {
    this.destroyed = true;
    if (this.connectAbortController?.signal.aborted === false) {
      this.connectAbortController.abort(connectionAbortError());
    }
    this.events = null;
    this.settleSessionReady();
    await this.media.close();
  }

  // ── internals ────────────────────────────────────────────────────────

  private throwIfCanceled(signal: AbortSignal): void {
    if (!this.destroyed && !signal.aborted) return;
    throw signal.reason instanceof Error
      ? signal.reason
      : connectionAbortError();
  }

  private prepareSessionReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.settleSessionReady(
          new Error("Timed out while configuring the realtime voice session."),
        );
      }, SESSION_READY_TIMEOUT_MS);

      this.resolveSessionReady = () => {
        clearTimeout(timeout);
        resolve();
      };
      this.rejectSessionReady = (error) => {
        clearTimeout(timeout);
        reject(error);
      };
    });
  }

  private settleSessionReady(error?: Error): void {
    const resolve = this.resolveSessionReady;
    const reject = this.rejectSessionReady;
    this.resolveSessionReady = null;
    this.rejectSessionReady = null;
    this.pendingSessionUpdateEventId = null;
    if (error) reject?.(error);
    else resolve?.();
  }

  private handleHandshakeEvent(event: Record<string, unknown>): void {
    if (!this.resolveSessionReady || !this.pendingSessionUpdateEventId) return;
    if (event.type === "session.updated") {
      this.settleSessionReady();
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
    this.settleSessionReady(new Error(message));
  }
}
