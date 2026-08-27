/**
 * Stella-backend TTS client for the read-aloud surface.
 *
 * Two modes, both keeping the provider API keys server-side:
 *   - `openReadAloudStream` — progressive Inworld synthesis proxied back as a
 *     chunked `audio/mpeg` stream so playback can begin early.
 *   - `fetchReadAloudAudio` — one-shot synthesis (mp3 for OpenAI, wav for
 *     Inworld), the graceful fallback when streaming is unavailable.
 */
import { createServiceRequest } from "@/platform/http/service-request";

export type ReadAloudVoiceFamily = "openai" | "inworld";

export type ReadAloudRequest = {
  /** Stable for one read invocation, including stream-to-buffered fallback. */
  operationId: string;
  text: string;
  voice?: string;
  voiceProvider: ReadAloudVoiceFamily;
  speed?: number;
  signal?: AbortSignal;
};

export type ReadAloudResponse = {
  audio: ArrayBuffer;
  /** MIME type the backend reported (`audio/mpeg`, `audio/wav`, …). */
  contentType: string;
};

const TTS_PATH = "/api/voice/tts";
const TTS_STREAM_PATH = "/api/voice/tts/stream";

export const createReadAloudOperationId = (): string => crypto.randomUUID();

/**
 * Open a progressive Inworld TTS stream. Resolves with the raw streaming
 * `Response` (an `audio/mpeg` body) so the player can feed it into Media
 * Source Extensions. Throws on a non-OK response so the caller can fall back
 * to one-shot synthesis.
 */
export async function openReadAloudStream(
  req: Omit<ReadAloudRequest, "voiceProvider">,
): Promise<Response> {
  const { endpoint, headers } = await createServiceRequest(TTS_STREAM_PATH, {
    "Content-Type": "application/json",
  });
  const body: Record<string, unknown> = {
    text: req.text,
    operationId: req.operationId,
  };
  if (req.voice) body.voice = req.voice;
  if (typeof req.speed === "number" && Number.isFinite(req.speed)) {
    body.speed = req.speed;
  }
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: req.signal,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Read-aloud stream failed (${response.status})${detail ? `: ${detail}` : ""}`,
    );
  }
  return response;
}

export async function fetchReadAloudAudio(
  req: ReadAloudRequest,
): Promise<ReadAloudResponse> {
  const { endpoint, headers } = await createServiceRequest(TTS_PATH, {
    "Content-Type": "application/json",
  });
  const body: Record<string, unknown> = {
    text: req.text,
    voiceProvider: req.voiceProvider,
    operationId: req.operationId,
  };
  if (req.voice) body.voice = req.voice;
  if (typeof req.speed === "number" && Number.isFinite(req.speed)) {
    body.speed = req.speed;
  }
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: req.signal,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Read-aloud TTS failed (${response.status})${detail ? `: ${detail}` : ""}`,
    );
  }
  const contentType =
    response.headers.get("content-type")?.split(";")[0]?.trim() ?? "audio/mpeg";
  const audio = await response.arrayBuffer();
  return { audio, contentType };
}
