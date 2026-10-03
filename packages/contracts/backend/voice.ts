/**
 * Voice, read-aloud and dictation, served from the owner's object.
 *
 * - **Realtime voice:** `voice.session` opens a lease on a server-created
 *   OpenAI call. The client posts its SDP offer to `VOICE_OPENAI_SDP_PATH`
 *   with the lease id in `VOICE_LEASE_HEADER`, heartbeats with `voice.lease`
 *   and reports each response's usage with `voice.usage`. A lease that stops
 *   heartbeating is closed by the server, which hangs the call up and charges
 *   what is left.
 * - **Read-aloud:** desktop streams `audio/mpeg` from `VOICE_TTS_STREAM_PATH`
 *   (or one-shot audio from `VOICE_TTS_PATH`). Mobile's native player needs a
 *   GET URL without headers, so `tts.prepare` returns a signed ticket and the
 *   playlist path that carries it.
 * - **Dictation:** `dictation.realtimeConfig` names the relay socket's origin.
 */

export const VOICE_OPENAI_SDP_PATH = "/api/voice/openai/sdp";
export const VOICE_INWORLD_SDP_PATH = "/api/voice/inworld/sdp";
export const VOICE_TTS_PATH = "/api/voice/tts";
export const VOICE_TTS_STREAM_PATH = "/api/voice/tts/stream";
export const VOICE_TTS_STREAM_CANCEL_PATH = "/api/voice/tts/stream/cancel";
export const VOICE_TTS_HLS_PREFIX = "/api/voice/tts/stream/hls/";
/** The lease an SDP offer belongs to. */
export const VOICE_LEASE_HEADER = "x-stella-voice-lease";

export const voiceTtsPlaylistPath = (ticket: string): string =>
  `${VOICE_TTS_HLS_PREFIX}${encodeURIComponent(ticket)}/index.m3u8`;

export type VoiceToolSchema = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type VoiceSession = {
  leaseId: string;
  model: string;
  voice: string;
  /** The lease closes unless a heartbeat renews it before this. */
  leaseExpiresAt: number;
};

export type VoiceLeaseEvent = "heartbeat" | "ended" | "expired" | "lost";

export type VoiceLease = {
  /** `closed`: the server ended the session; stop the transport. */
  directive: "continue" | "closed";
  /** The renewed deadline; null once closed. */
  leaseExpiresAt: number | null;
  reason: string | null;
};

export type VoiceCalls = {
  /**
   * Open a realtime voice lease (Pro only). Any other open lease of the
   * owner's is closed first.
   */
  "voice.session": {
    args: {
      instructions: string;
      tools?: VoiceToolSchema[];
      voice?: string;
      model?: string;
      voiceProvider?: "openai" | "xai" | "inworld";
      turnDetection?: "semantic_vad" | "server_vad";
      turnEagerness?: "low" | "medium" | "high";
    };
    result: VoiceSession;
  };
  "voice.lease": {
    args: { leaseId: string; event: VoiceLeaseEvent };
    result: VoiceLease;
  };
  /**
   * One provider `response.done` usage object, priced at the lease's model.
   * Idempotent on `responseId`.
   */
  "voice.usage": {
    args: { leaseId: string; responseId: string; usage: Record<string, unknown> };
    result: { recorded: boolean; costMicroCents: number };
  };
  /** Start a mobile read-aloud synthesis; play `playlistPath` on the backend origin. */
  "tts.prepare": {
    args: { text: string; voice?: string };
    result: { ticket: string; playlistPath: string; expiresAt: number };
  };
  "dictation.realtimeConfig": {
    args: Record<string, never>;
    result: { relayOrigin: string; modelId: string };
  };
};
