/**
 * Voice, read-aloud and dictation, served from the owner's object.
 *
 * - **Live voice:** `voice.session` opens a lease and stores the GPT-Live
 *   session config. The client posts its SDP offer to `VOICE_LIVE_SDP_PATH`
 *   with the lease id in `VOICE_LEASE_HEADER`; the server creates the live
 *   session with its own key and returns only the SDP answer. The client
 *   heartbeats with `voice.lease`. A lease that stops heartbeating is closed
 *   by the server, which attaches a sideband to close the session and charges
 *   the elapsed duration. GPT-Live is billed per second of session duration,
 *   so there is no per-response usage report: the orchestrator's own model
 *   spend is metered through the normal agent path.
 * - **Read-aloud:** desktop streams `audio/mpeg` from `VOICE_TTS_STREAM_PATH`
 *   (or one-shot audio from `VOICE_TTS_PATH`). Mobile's native player needs a
 *   GET URL without headers, so `tts.prepare` returns a random ticket and the
 *   playlist path that carries it.
 * - **Dictation:** `dictation.realtimeConfig` names the relay socket's origin.
 */

export const VOICE_LIVE_SDP_PATH = "/api/voice/live/sdp";
export const VOICE_TTS_PATH = "/api/voice/tts";
export const VOICE_TTS_STREAM_PATH = "/api/voice/tts/stream";
export const VOICE_TTS_STREAM_CANCEL_PATH = "/api/voice/tts/stream/cancel";
export const VOICE_TTS_HLS_PREFIX = "/api/voice/tts/stream/hls/";
/** The lease an SDP offer belongs to. */
export const VOICE_LEASE_HEADER = "x-stella-voice-lease";

/** The managed voice model. Conversation only; reasoning and tools delegate out. */
export const GPT_LIVE_MODEL = "gpt-live-1";

/**
 * GPT-Live accepts `instructions` up to 16,384 tokens. The voice prompt is
 * now a short conversation-and-delegation brief rather than Stella's whole
 * system prompt, so this ceiling is generous at ~3 characters per token and
 * still leaves the model's own budget untouched.
 */
export const VOICE_INSTRUCTIONS_MAX_CHARS = 24_000;
/** GPT-Live accepts at most 128 startup history messages. */
export const VOICE_HISTORY_MAX_MESSAGES = 128;
/** GPT-Live caps startup history at 8,192 combined tokens. */
export const VOICE_HISTORY_MAX_CHARS = 24_000;
/**
 * `session.instructions.append`, `session.thinking.append` and
 * `session.commentary.append` each take at most 500 tokens of content.
 * Callers split longer updates.
 */
export const VOICE_APPEND_MAX_CHARS = 1_500;

export type VoiceHistoryRole = "developer" | "user" | "assistant";

/** One startup history message. GPT-Live takes a single text part per message. */
export type VoiceHistoryMessage = {
  role: VoiceHistoryRole;
  text: string;
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

export const voiceTtsPlaylistPath = (ticket: string): string =>
  `${VOICE_TTS_HLS_PREFIX}${encodeURIComponent(ticket)}/index.m3u8`;

export type VoiceCalls = {
  /**
   * Open a live voice lease (Pro only). Any other open lease of the
   * owner's is closed first.
   */
  "voice.session": {
    args: {
      /** Conversation style and delegation policy, not Stella's system prompt. */
      instructions: string;
      /** Recent text turns, so the call opens knowing where the chat is. */
      history?: VoiceHistoryMessage[];
      voice?: string;
      model?: string;
    };
    result: VoiceSession;
  };
  "voice.lease": {
    args: { leaseId: string; event: VoiceLeaseEvent };
    result: VoiceLease;
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
