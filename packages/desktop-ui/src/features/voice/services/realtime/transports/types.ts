/**
 * RealtimeTransport — abstraction over the wire protocol used to talk to a
 * realtime voice provider.
 *
 * Three implementations exist:
 *   - GptLiveWebRTCTransport: the Stella-managed path. GPT-Live over WebRTC,
 *     where the voice model carries the conversation and delegates reasoning
 *     and tools to Stella's text orchestrator.
 *   - OpenAIWebRTCTransport: the user's BYOK OpenAI Realtime key. WebRTC
 *     handles mic capture and speaker playback via the audio track.
 *   - XaiWebSocketTransport: WebSocket + hand-rolled mic capture
 *     (AudioWorklet → 24kHz PCM16 → input_audio_buffer.append) +
 *     hand-rolled playback queue (response.output_audio.delta → scheduled
 *     AudioContext buffer playback).
 *
 * The session class (`voice-session.ts`) only sees this interface — it never
 * touches RTCPeerConnection or WebSocket directly. That keeps protocol quirks
 * (event names, readiness handshake, graceful close, playback flush) pinned to
 * one file per protocol. The WebRTC peer/mic/analyser plumbing the two WebRTC
 * transports share lives in `webrtc-media-session.ts`.
 */

export type RealtimeTransportProvider = "gptlive" | "openai" | "xai";

/**
 * Provider-specific SDP answer fetcher used by the WebRTC transports.
 * Takes the local SDP offer plus the transport-owned cancellation signal and
 * returns the remote SDP answer. The provider module is responsible for
 * choosing the endpoint, auth scheme, and any proxy (Stella's backend SDP
 * proxy, which keeps the org key server-side).
 */
export type SdpAnswerFetcher = (
  sdpOffer: string,
  signal: AbortSignal,
) => Promise<string>;

export interface RealtimeTransportEvents {
  /** Raw JSON event from the provider, in that provider's own shape. */
  onEvent: (event: Record<string, unknown>) => void;
  /** Connection terminated for any reason — session moves to error state. */
  onClose: (reason: string) => void;
}

export interface RealtimeTransport {
  /** Provider identity, for telemetry and routing. */
  readonly provider: RealtimeTransportProvider;
  /** Model id the server reported (or the requested model as a fallback). */
  readonly model: string;

  /** Open the connection. Mic is attached but starts in muted state. */
  connect(events: RealtimeTransportEvents): Promise<void>;

  /** Send a JSON event over the underlying channel. */
  send(event: Record<string, unknown>): void;

  /**
   * Toggle whether the microphone is captured & streamed to the server.
   * Connection stays alive when muted.
   */
  setMicEnabled(enabled: boolean): Promise<void>;

  /**
   * Soft mute applied by the echo guard while assistant audio is playing.
   * Implementations should ramp gain rather than hard-cut.
   */
  applySoftInputMute(muted: boolean): void;

  /** AnalyserNode for mic level visualisation. Null until mic is acquired. */
  getMicAnalyser(): AnalyserNode | null;

  /** AnalyserNode for assistant-output level visualisation. */
  getOutputAnalyser(): AnalyserNode | null;

  /**
   * Stop any currently-playing assistant audio.
   * - WebRTC: nothing to flush locally; the provider stops sending frames.
   * - WS: flushes the local PCM playback queue.
   */
  interruptPlayback(): void;

  /**
   * Shut everything down. Idempotent. GPT-Live closes the session
   * conversationally first (`session.close` → `session.closed`).
   */
  disconnect(): Promise<void>;
}
