import { rpcErrorStatus } from "@stella/contracts/backend/protocol";
import { RpcError } from "../owner-store/errors.js";
import { verifyCaller } from "../owner-store/routes.js";
import { ownerGeneration, voiceInternal } from "../voice/routes.js";

export const DICTATION_TRANSCRIBE_PATH = "/api/dictation/transcribe";

const DEFAULT_MODEL = "meta/muse-voice-transcribe-1.0";
const TRANSCRIPTIONS_URL = "https://openrouter.ai/api/v1/audio/transcriptions";
const SAMPLE_RATE = 16_000;
const PCM_BYTES_PER_SECOND = SAMPLE_RATE * 2;
const MAX_SECONDS = 15 * 60;
const MAX_PCM_BYTES = MAX_SECONDS * PCM_BYTES_PER_SECOND;
const MAX_BODY_BYTES = MAX_PCM_BYTES + 4096;
const SEGMENT_BYTES = 3 * 60 * PCM_BYTES_PER_SECOND;
const SEGMENT_TIMEOUT_MS = 60_000;

type DictationEnv = Cloudflare.Env & { OPENROUTER_API_KEY?: string; STELLA_DICTATION_MODEL?: string };

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

const fail = (status: number, error: string, code?: string): Response =>
  json({ error, ...(code ? { code } : {}) }, status);

const apiKey = (env: DictationEnv): string | undefined => env.OPENROUTER_API_KEY?.trim() || undefined;

const readBounded = async (request: Request, maxBytes: number): Promise<Uint8Array | null> => {
  if (Number(request.headers.get("content-length") ?? "0") > maxBytes) return null;
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
};

const ascii = (bytes: Uint8Array, offset: number, length: number): string =>
  String.fromCharCode(...bytes.subarray(offset, offset + length));

const readPcm16Wav = (bytes: Uint8Array): Uint8Array | string => {
  if (bytes.byteLength < 12 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") {
    return "Dictation audio must be a WAV file.";
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let formatOk = false;
  while (offset + 8 <= bytes.byteLength) {
    const id = ascii(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      if (size < 16 || body + 16 > bytes.byteLength) return "Dictation audio has a broken format chunk.";
      formatOk =
        view.getUint16(body, true) === 1 &&
        view.getUint16(body + 2, true) === 1 &&
        view.getUint32(body + 4, true) === SAMPLE_RATE &&
        view.getUint16(body + 14, true) === 16;
      if (!formatOk) return "Dictation audio must be 16 kHz mono 16-bit PCM.";
    } else if (id === "data") {
      if (!formatOk) return "Dictation audio is missing its format.";
      const end = Math.min(bytes.byteLength, body + size);
      return bytes.subarray(body, end - ((end - body) % 2));
    }
    offset = body + size + (size % 2);
  }
  return "Dictation audio has no data.";
};

const wavFromPcm = (pcm: Uint8Array): Uint8Array => {
  const out = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(out.buffer);
  const write = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) out[offset + i] = text.charCodeAt(i);
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, PCM_BYTES_PER_SECOND, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  out.set(pcm, 44);
  return out;
};

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};

const transcribeSegment = async (
  key: string,
  model: string,
  pcm: Uint8Array,
  signal: AbortSignal,
): Promise<{ text: string; costUsd: number | undefined }> => {
  const response = await fetch(TRANSCRIPTIONS_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      "HTTP-Referer": "https://stella.sh",
      "X-OpenRouter-Title": "Stella",
    },
    body: JSON.stringify({ model, input_audio: { data: toBase64(wavFromPcm(pcm)), format: "wav" } }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(SEGMENT_TIMEOUT_MS)]),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Transcription failed (${response.status}): ${text.slice(0, 300)}`);
  const body = JSON.parse(text) as { text?: unknown; usage?: { cost?: unknown } };
  if (typeof body.text !== "string") throw new Error("Transcription response was missing text.");
  const cost = body.usage?.cost;
  return { text: body.text.trim(), costUsd: typeof cost === "number" && cost >= 0 ? cost : undefined };
};

export const handleDictationTranscribeRoute = async (
  request: Request,
  env: DictationEnv,
): Promise<Response | null> => {
  if (new URL(request.url).pathname !== DICTATION_TRANSCRIBE_PATH) return null;
  if (request.method === "GET") return json({ available: Boolean(apiKey(env)) });
  if (request.method !== "POST") return fail(405, "Method not allowed.");

  const header = request.headers.get("authorization") ?? "";
  const verified = await verifyCaller(env, header.startsWith("Bearer ") ? header.slice(7).trim() : "");
  if (!verified.ok) return fail(rpcErrorStatus(verified.error.code), verified.error.message);
  const key = apiKey(env);
  if (!key) return fail(503, "Dictation isn't set up on this Stella.", "dictation_unavailable");

  const bytes = await readBounded(request, MAX_BODY_BYTES);
  if (!bytes) return fail(413, "That recording is longer than 15 minutes.");
  const pcm = readPcm16Wav(bytes);
  if (typeof pcm === "string") return fail(400, pcm);
  if (pcm.byteLength > MAX_PCM_BYTES) return fail(413, "That recording is longer than 15 minutes.");
  if (pcm.byteLength < PCM_BYTES_PER_SECOND / 10) return json({ text: "", seconds: 0 });

  const ownerId = verified.caller.ownerId;
  const generation = await ownerGeneration(env, ownerId);
  const call = <T>(name: string, args: unknown) => voiceInternal<T>(env, ownerId, generation, name, args);
  const sessionId = `muse_${crypto.randomUUID()}`;
  try {
    await call("dictation.reserveClip", { sessionId, audioBytes: pcm.byteLength });
  } catch (error) {
    if (error instanceof RpcError && (error.code === "FORBIDDEN" || error.code === "RATE_LIMITED")) {
      return fail(error.code === "RATE_LIMITED" ? 429 : 403, error.message, "usage_limit_reached");
    }
    throw error;
  }

  const model = env.STELLA_DICTATION_MODEL?.trim() || DEFAULT_MODEL;
  const parts: string[] = [];
  try {
    for (let offset = 0, segment = 0; offset < pcm.byteLength; offset += SEGMENT_BYTES, segment += 1) {
      const slice = pcm.subarray(offset, offset + SEGMENT_BYTES);
      const result = await transcribeSegment(key, model, slice, request.signal);
      await call("dictation.settleSegment", {
        sessionId,
        segment,
        audioBytes: slice.byteLength,
        ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
      });
      if (result.text) parts.push(result.text);
    }
  } catch (error) {
    console.error(JSON.stringify({ event: "dictation_transcribe_failed", message: (error as Error).message.slice(0, 300) }));
    return fail(502, "Stella couldn't transcribe that recording. Try again.");
  } finally {
    await call("dictation.releaseClip", { sessionId }).catch(() => undefined);
  }
  return json({ text: parts.join(" "), seconds: pcm.byteLength / PCM_BYTES_PER_SECOND });
};
