import { getLocalLlmCredential } from "@stella/runtime/kernel/storage/llm-credentials";

const TRANSCRIPTIONS_URL = "https://openrouter.ai/api/v1/audio/transcriptions";
const MODEL = "meta/muse-voice-transcribe-1.0";
const SAMPLE_RATE = 16_000;
const PCM_BYTES_PER_SECOND = SAMPLE_RATE * 2;
const SEGMENT_BYTES = 3 * 60 * PCM_BYTES_PER_SECOND;
const MAX_BYTES = 15 * 60 * PCM_BYTES_PER_SECOND + 4096;
const SEGMENT_TIMEOUT_MS = 60_000;
const WAV_HEADER_BYTES = 44;

export const OPENROUTER_PROVIDER = "openrouter";

export const hasOpenRouterDictationKey = (stellaDataDir: string | null | undefined): boolean =>
  Boolean(stellaDataDir && getLocalLlmCredential(stellaDataDir, OPENROUTER_PROVIDER));

const wavHeader = (dataBytes: number): Buffer => {
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(PCM_BYTES_PER_SECOND, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataBytes, 40);
  return header;
};

const describeFailure = (status: number, body: string): string => {
  if (status === 401 || status === 403) return "OpenRouter rejected your API key. Check it in Settings → Models.";
  if (status === 402) return "Your OpenRouter account is out of credit.";
  let message = "";
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    if (typeof parsed.error?.message === "string") message = parsed.error.message;
  } catch {
    message = body.slice(0, 200);
  }
  return `OpenRouter couldn't transcribe that (${status})${message ? `: ${message}` : ""}.`;
};

export const transcribeWithOpenRouter = async (
  stellaDataDir: string | null | undefined,
  wav: ArrayBuffer | Uint8Array,
  signal: AbortSignal,
): Promise<{ text: string }> => {
  const apiKey = stellaDataDir ? getLocalLlmCredential(stellaDataDir, OPENROUTER_PROVIDER) : null;
  if (!apiKey) throw new Error("Add an OpenRouter API key to use dictation.");
  const bytes = Buffer.from(wav instanceof Uint8Array ? wav : new Uint8Array(wav));
  if (bytes.byteLength > MAX_BYTES) throw new Error("That recording is longer than 15 minutes.");
  if (bytes.byteLength <= WAV_HEADER_BYTES || bytes.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error("Dictation audio was empty.");
  }
  const pcm = bytes.subarray(WAV_HEADER_BYTES);
  const parts: string[] = [];
  for (let offset = 0; offset < pcm.byteLength; offset += SEGMENT_BYTES) {
    signal.throwIfAborted();
    const segment = pcm.subarray(offset, offset + SEGMENT_BYTES);
    const response = await fetch(TRANSCRIPTIONS_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "HTTP-Referer": "https://stella.sh",
        "X-OpenRouter-Title": "Stella",
      },
      body: JSON.stringify({
        model: MODEL,
        input_audio: {
          data: Buffer.concat([wavHeader(segment.byteLength), segment]).toString("base64"),
          format: "wav",
        },
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(SEGMENT_TIMEOUT_MS)]),
    });
    const body = await response.text();
    if (!response.ok) throw new Error(describeFailure(response.status, body));
    const parsed = JSON.parse(body) as { text?: unknown };
    if (typeof parsed.text !== "string") throw new Error("OpenRouter's transcription was missing its text.");
    if (parsed.text.trim()) parts.push(parsed.text.trim());
  }
  return { text: parts.join(" ") };
};
