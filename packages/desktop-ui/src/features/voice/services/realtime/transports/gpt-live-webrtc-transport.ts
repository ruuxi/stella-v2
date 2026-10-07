/**
 * WebRTC transport for OpenAI GPT-Live.
 *
 * GPT-Live is not the Realtime API. The differences that shape this file:
 *
 *   - **The session is created by an HTTP POST, not by a data-channel event.**
 *     Stella's backend performs that POST with its org key and stores the
 *     session config (instructions, voice, startup history) against a lease.
 *     The renderer only posts its SDP offer to `VOICE_LIVE_SDP_PATH` under
 *     that lease and receives the SDP answer.
 *   - **Nothing is sent until `session.started` arrives.** There is no
 *     `session.start` to send, and `session.update` rejects the startup-only
 *     fields (instructions, voice, tools), so none of them are sent here.
 *   - **`audio.format` is omitted** — WebRTC negotiates the codec, and audio
 *     never crosses the data channel in either direction.
 *   - **Transcripts are fragments.** `session.input_transcript.delta` and
 *     `session.output_transcript.delta` carry a `delta` plus `start_ms` /
 *     `end_ms`; a fragment is not a turn. The session layer accumulates them.
 *   - **Closing is a conversation.** We send `session.close`, keep receiving
 *     until `session.closed` lands (bounded), and only then tear down the
 *     peer connection and release the microphone.
 *
 * Reasoning and tool use are not this model's job: it delegates them through
 * `session.delegation.created`, which the session layer answers with
 * `session.commentary.append` / `session.thinking.append`.
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
  runConnectWithDeadline,
} from "./webrtc-media-session";

const SESSION_STARTED_TIMEOUT_MS = 10_000;
const SESSION_CLOSED_GRACE_MS = 1_500;
const CONNECT_DEADLINE_MESSAGE =
  "Timed out while connecting to the GPT-Live voice session.";

export const GPT_LIVE_DATA_CHANNEL_LABEL = "oai-events";

export interface GptLiveWebRTCTransportOptions {
  /** Server-reported model id (or the requested model as a fallback). */
  model: string;
  /** Posts the SDP offer under the managed lease and returns the answer. */
  sdpFetch: SdpAnswerFetcher;
}

export class GptLiveWebRTCTransport implements RealtimeTransport {
  readonly provider: RealtimeTransportProvider = "gptlive";
  readonly model: string;

  private readonly media: WebRTCMediaSession;
  private events: RealtimeTransportEvents | null = null;

  private destroyed = false;
  private sessionStarted = false;
  private micEnabled = false;
  private connectAbortController: AbortController | null = null;

  private resolveSessionStarted: (() => void) | null = null;
  private rejectSessionStarted: ((error: Error) => void) | null = null;
  private resolveSessionClosed: (() => void) | null = null;

  constructor(options: GptLiveWebRTCTransportOptions) {
    this.model = options.model;
    this.media = new WebRTCMediaSession({
      dataChannelLabel: GPT_LIVE_DATA_CHANNEL_LABEL,
      sdpFetch: options.sdpFetch,
      logPrefix: "[gpt-live]",
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
    const started = this.prepareSessionStarted();
    void started.catch(() => undefined);

    this.media.attach({
      onChannelOpen: () => {
        // Deliberately silent: GPT-Live speaks first with `session.started`
        // and rejects a client-sent `session.start`.
      },
      onMessage: (event) => this.handleMessage(event),
      onChannelDown: (reason) => {
        this.settleSessionStarted(
          new Error("GPT-Live data channel closed during setup."),
        );
        this.resolveSessionClosed?.();
        this.events?.onClose(reason);
      },
    });

    await this.media.open(signal);
    this.throwIfCanceled(signal);

    await started;
    this.throwIfCanceled(signal);

    // Through the public setter, so the provider-side gate is told about the
    // starting mute state too and not just the local track.
    await this.setMicEnabled(this.micEnabled);
    this.throwIfCanceled(signal);
  }

  send(event: Record<string, unknown>): void {
    if (!this.sessionStarted) {
      console.debug(
        "[gpt-live] Dropped an event sent before session.started:",
        String(event.type ?? "unknown"),
      );
      return;
    }
    this.media.send(event);
  }

  setMicEnabled(enabled: boolean): Promise<void> {
    this.micEnabled = enabled;
    // The provider-side gate matters as much as the local one: a muted
    // session must not accrue input on the server either.
    if (this.sessionStarted) {
      this.media.send({
        type: enabled
          ? "session.input_audio.unmute"
          : "session.input_audio.mute",
      });
    }
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
    // WebRTC has no client-side playback queue. Barge-in is the provider's
    // own interruption policy; remote audio stops as it stops sending frames.
  }

  async disconnect(): Promise<void> {
    const wasStarted = this.sessionStarted;
    this.destroyed = true;
    if (this.connectAbortController?.signal.aborted === false) {
      this.connectAbortController.abort(connectionAbortError());
    }
    this.settleSessionStarted();
    this.events = null;

    if (wasStarted && this.media.isChannelOpen) {
      await this.closeSessionGracefully();
    }

    this.sessionStarted = false;
    await this.media.close();
  }

  // ── internals ────────────────────────────────────────────────────────

  /**
   * `session.close` then keep receiving until `session.closed`. Tearing the
   * peer connection down first would strand the session server-side until the
   * lease lapsed, which is also the window the backend bills.
   */
  private closeSessionGracefully(): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.resolveSessionClosed = null;
        resolve();
      };
      const timer = setTimeout(finish, SESSION_CLOSED_GRACE_MS);
      this.resolveSessionClosed = finish;
      if (!this.media.send({ type: "session.close" })) finish();
    });
  }

  private throwIfCanceled(signal: AbortSignal): void {
    if (!this.destroyed && !signal.aborted) return;
    throw signal.reason instanceof Error
      ? signal.reason
      : connectionAbortError();
  }

  private prepareSessionStarted(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.settleSessionStarted(
          new Error("GPT-Live did not start the voice session in time."),
        );
      }, SESSION_STARTED_TIMEOUT_MS);

      this.resolveSessionStarted = () => {
        clearTimeout(timeout);
        resolve();
      };
      this.rejectSessionStarted = (error) => {
        clearTimeout(timeout);
        reject(error);
      };
    });
  }

  private settleSessionStarted(error?: Error): void {
    const resolve = this.resolveSessionStarted;
    const reject = this.rejectSessionStarted;
    this.resolveSessionStarted = null;
    this.rejectSessionStarted = null;
    if (error) reject?.(error);
    else resolve?.();
  }

  private handleMessage(event: Record<string, unknown>): void {
    const type = typeof event.type === "string" ? event.type : "";

    if (type === "session.started") {
      this.sessionStarted = true;
      this.settleSessionStarted();
    } else if (type === "session.closed") {
      this.sessionStarted = false;
      this.resolveSessionClosed?.();
    } else if (type === "session.error" || type === "error") {
      // A startup failure must surface as a connect rejection rather than a
      // silent session that never speaks.
      if (this.resolveSessionStarted) {
        this.settleSessionStarted(new Error(gptLiveErrorMessage(event)));
      }
    }

    this.events?.onEvent(event);
  }
}

export const gptLiveErrorMessage = (event: Record<string, unknown>): string => {
  const error =
    typeof event.error === "object" && event.error !== null
      ? (event.error as Record<string, unknown>)
      : null;
  const message =
    typeof error?.message === "string" && error.message.trim()
      ? error.message.trim()
      : typeof event.message === "string" && event.message.trim()
        ? event.message.trim()
        : "";
  return message || "The GPT-Live voice session reported an error.";
};
