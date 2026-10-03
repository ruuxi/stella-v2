/**
 * Stella-backend TTS client for the read-aloud surface.
 *
 * Two modes, both keeping the provider API keys server-side:
 *   - `openReadAloudStream` — progressive Gemini synthesis proxied back as a
 *     chunked `audio/mpeg` stream so playback can begin early.
 *   - `fetchReadAloudAudio` — one-shot synthesis (mp3 for OpenAI, wav for
 *     Gemini), the graceful fallback when streaming is unavailable.
 */
import type { ReadAloudVoiceProvider } from "@stella/contracts/local-preferences";
import {
  VOICE_TTS_PATH,
  VOICE_TTS_STREAM_PATH,
} from "@stella/contracts/backend/voice";
import { voiceBackendFetch } from "../voice-backend";

export type ReadAloudVoiceFamily = ReadAloudVoiceProvider;

export type ReadAloudRequest = {
  text: string;
  voice?: string;
  voiceProvider: ReadAloudVoiceFamily;
  signal?: AbortSignal;
};

export type ReadAloudResponse = {
  audio: ArrayBuffer;
  /** MIME type the backend reported (`audio/mpeg`, `audio/wav`, …). */
  contentType: string;
};

/**
 * Open a progressive Gemini TTS stream. Resolves with the raw streaming
 * `Response` (an `audio/mpeg` body) so the player can feed it into Media
 * Source Extensions. Throws on a non-OK response so the caller can fall back
 * to one-shot synthesis.
 */
export async function openReadAloudStream(
  req: Omit<ReadAloudRequest, "voiceProvider">,
): Promise<Response> {
  return await voiceBackendFetch(VOICE_TTS_STREAM_PATH, {
    body: JSON.stringify({ text: req.text, ...(req.voice ? { voice: req.voice } : {}) }),
    contentType: "application/json",
    signal: req.signal,
  });
}

export async function fetchReadAloudAudio(
  req: ReadAloudRequest,
): Promise<ReadAloudResponse> {
  const response = await voiceBackendFetch(VOICE_TTS_PATH, {
    body: JSON.stringify({
      text: req.text,
      voiceProvider: req.voiceProvider,
      ...(req.voice ? { voice: req.voice } : {}),
    }),
    contentType: "application/json",
    signal: req.signal,
  });
  const contentType =
    response.headers.get("content-type")?.split(";")[0]?.trim() ?? "audio/mpeg";
  const audio = await response.arrayBuffer();
  return { audio, contentType };
}
