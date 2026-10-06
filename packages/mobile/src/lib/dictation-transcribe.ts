/**
 * Record-then-transcribe dictation transport.
 *
 * The whole utterance is captured locally as 16 kHz mono PCM16, wrapped in a
 * WAV header here, and posted to the backend's `/api/dictation/transcribe`,
 * which answers `{ text, seconds }`. There are no partial results: the request
 * is a single batch round trip (managed dictation runs the same Muse model
 * through OpenRouter), so the caller shows its "transcribing" state until this
 * resolves.
 */

import { getAuthToken } from "./auth-token";
import { backendOrigin } from "./http";

export const DICTATION_SAMPLE_RATE = 16_000;
const PCM_BYTES_PER_SECOND = DICTATION_SAMPLE_RATE * 2;
/** The route's own ceiling; capture stops here rather than being refused. */
export const DICTATION_MAX_PCM_BYTES = 15 * 60 * PCM_BYTES_PER_SECOND;
const WAV_HEADER_BYTES = 44;
/**
 * Batch transcription is roughly real time in the worst case and the request
 * also carries the upload, so the budget grows with the recording instead of
 * using `http.ts`'s fixed 15 s.
 */
const BASE_TIMEOUT_MS = 30_000;
const TIMEOUT_MS_PER_SECOND = 3_000;

/** A refused transcription, with the route's error code when it sent one. */
export class DictationTranscribeError extends Error {
  readonly code: string | null;
  constructor(message: string, code: string | null) {
    super(message);
    this.name = "DictationTranscribeError";
    this.code = code;
  }
}

/**
 * One 16 kHz mono PCM16 WAV over the captured chunks. Single pass over the
 * audio, which is the only sizeable work dictation does on the JS thread.
 */
export const wavFromPcm16 = (
  chunks: ArrayBuffer[],
  pcmBytes: number,
): Uint8Array => {
  const out = new Uint8Array(WAV_HEADER_BYTES + pcmBytes);
  const view = new DataView(out.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) out[offset + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + pcmBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, DICTATION_SAMPLE_RATE, true);
  view.setUint32(28, PCM_BYTES_PER_SECOND, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, pcmBytes, true);
  let offset = WAV_HEADER_BYTES;
  for (const chunk of chunks) {
    if (offset + chunk.byteLength > out.byteLength) {
      out.set(
        new Uint8Array(chunk, 0, out.byteLength - offset),
        offset,
      );
      break;
    }
    out.set(new Uint8Array(chunk), offset);
    offset += chunk.byteLength;
  }
  return out;
};

const describeFailure = (
  status: number,
  code: string | null,
  message: string,
): string => {
  if (status === 401 || status === 403) {
    if (code === "usage_limit_reached") return message;
    if (status === 401) return "Sign in to Stella to use dictation.";
  }
  if (status === 503 || code === "dictation_unavailable") {
    return message || "Dictation isn't set up on this Stella.";
  }
  if (status === 413) {
    return message || "That recording is longer than 15 minutes.";
  }
  return message || "Stella couldn't transcribe that recording. Try again.";
};

/** POST the WAV and return the transcript, or throw a described failure. */
export const transcribeDictationWav = async (
  wav: Uint8Array,
): Promise<string> => {
  const seconds = Math.max(
    1,
    (wav.byteLength - WAV_HEADER_BYTES) / PCM_BYTES_PER_SECOND,
  );
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(
    () => {
      timedOut = true;
      controller.abort();
    },
    BASE_TIMEOUT_MS + seconds * TIMEOUT_MS_PER_SECOND,
  );
  let response: Response;
  try {
    response = await fetch(`${backendOrigin()}/api/dictation/transcribe`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await getAuthToken()}`,
        "Content-Type": "audio/wav",
      },
      // React Native's networking accepts a buffer and uploads it as binary;
      // its fetch types only describe the web's text/Blob bodies.
      body: wav.buffer as BodyInit,
      signal: controller.signal,
    });
  } catch (error) {
    if (timedOut) {
      throw new DictationTranscribeError(
        "Transcribing that recording took too long. Try again.",
        null,
      );
    }
    throw new DictationTranscribeError(
      error instanceof Error && error.message
        ? error.message
        : "Stella couldn't reach dictation. Try again.",
      null,
    );
  } finally {
    clearTimeout(timer);
  }

  const body = await response.text();
  let parsed: { text?: unknown; error?: unknown; code?: unknown } = {};
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    /* A proxy interstitial, handled as a generic failure below. */
  }
  if (!response.ok) {
    const code = typeof parsed.code === "string" ? parsed.code : null;
    const message = typeof parsed.error === "string" ? parsed.error.trim() : "";
    throw new DictationTranscribeError(
      describeFailure(response.status, code, message),
      code,
    );
  }
  if (typeof parsed.text !== "string") {
    throw new DictationTranscribeError(
      "Stella couldn't transcribe that recording. Try again.",
      null,
    );
  }
  return parsed.text.trim();
};
