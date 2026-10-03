/**
 * Lyria 3 music clips through the Gemini REST API. A port of the Convex
 * `media_lyria.ts`, without the SDK: one `generateContent` request answers
 * with the clip inline.
 */

const LYRIA_MODEL = "lyria-3-pro-preview";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const TIMEOUT_MS = 90_000;
const VOCALIZATION = "VOCALIZATION";

type WeightedPrompt = { text: string; weight: number };

export type MusicRequest = {
  weightedPrompts: WeightedPrompt[];
  config: {
    bpm: number;
    density: number;
    brightness: number;
    guidance: number;
    temperature: number;
    vocalization: boolean;
  };
  promptLabel: string | null;
};

export type GeneratedMusic = {
  bytes: Uint8Array;
  mimeType: string;
  promptLabel: string | null;
  textParts: string[];
};

const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

/** The music fields of a provider input, clamped, or null when incomplete. */
export const parseMusicRequest = (value: unknown): MusicRequest | null => {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const raw =
    record.musicGenerationConfig && typeof record.musicGenerationConfig === "object"
      ? (record.musicGenerationConfig as Record<string, unknown>)
      : null;
  if (!Array.isArray(record.weightedPrompts) || !raw) return null;
  const weightedPrompts = record.weightedPrompts
    .map((entry): WeightedPrompt | null => {
      if (!entry || typeof entry !== "object") return null;
      const prompt = entry as Record<string, unknown>;
      const text = typeof prompt.text === "string" ? prompt.text.trim() : "";
      const weight = finite(prompt.weight);
      return text && weight !== null && weight !== 0 ? { text, weight: clamp(weight, -100, 100) } : null;
    })
    .filter((entry): entry is WeightedPrompt => entry !== null);
  const bpm = finite(raw.bpm);
  const density = finite(raw.density);
  const brightness = finite(raw.brightness);
  const guidance = finite(raw.guidance);
  const temperature = finite(raw.temperature);
  if (
    weightedPrompts.length === 0 ||
    bpm === null ||
    density === null ||
    brightness === null ||
    guidance === null ||
    temperature === null
  ) {
    return null;
  }
  const label = typeof record.promptLabel === "string" ? record.promptLabel.trim() : "";
  return {
    weightedPrompts,
    config: {
      bpm: clamp(bpm, 55, 145),
      density: clamp(density, 0.05, 0.9),
      brightness: clamp(brightness, 0.1, 0.8),
      guidance: clamp(guidance, 2, 5),
      temperature: clamp(temperature, 0.6, 1.4),
      vocalization:
        raw.musicGenerationMode === VOCALIZATION ||
        raw.music_generation_mode === VOCALIZATION ||
        record.musicGenerationMode === VOCALIZATION,
    },
    promptLabel: label || null,
  };
};

const musicPrompt = ({ weightedPrompts, config, promptLabel }: MusicRequest): string =>
  [
    "Generate a polished 30-second music clip.",
    promptLabel ? `Title or concept: ${promptLabel}.` : null,
    "Blend these weighted influences into one coherent piece:",
    weightedPrompts.map((prompt, index) => `${index + 1}. (${prompt.weight}) ${prompt.text}`).join("\n"),
    "Target musical characteristics:",
    `- Tempo: about ${config.bpm} BPM`,
    `- Density: ${config.density}`,
    `- Brightness: ${config.brightness}`,
    `- Prompt adherence: ${config.guidance}`,
    `- Creative variance: ${config.temperature}`,
    `- Vocal mode: ${
      config.vocalization
        ? "Include tasteful vocalizations or sung elements if they fit the composition."
        : "Instrumental only. Do not include vocals or lyrics."
    }`,
    "Return high-quality stereo audio.",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");

const base64ToBytes = (value: string): Uint8Array => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

type GeminiPart = { text?: string; inlineData?: { data?: string; mimeType?: string } };

export const generateMusic = async (apiKey: string, request: MusicRequest): Promise<GeneratedMusic> => {
  const response = await fetch(`${GEMINI_BASE}/models/${LYRIA_MODEL}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: musicPrompt(request) }] }],
      generationConfig: { responseModalities: ["AUDIO", "TEXT"] },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Lyria returned ${response.status}: ${text.slice(0, 300)}`);
  const body = JSON.parse(text) as {
    candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
    promptFeedback?: { blockReason?: string; blockReasonMessage?: string };
  };
  const parts = body.candidates?.flatMap((candidate) => candidate.content?.parts ?? []) ?? [];
  const audio = parts.find((part) => part.inlineData?.data && part.inlineData.mimeType);
  if (!audio?.inlineData?.data || !audio.inlineData.mimeType) {
    throw new Error(
      body.promptFeedback?.blockReasonMessage ??
        body.promptFeedback?.blockReason ??
        "No audio was returned by Lyria 3.",
    );
  }
  return {
    bytes: base64ToBytes(audio.inlineData.data),
    mimeType: audio.inlineData.mimeType,
    promptLabel: request.promptLabel,
    textParts: parts
      .map((part) => part.text?.trim() ?? "")
      .filter((part) => part.length > 0)
      .slice(0, 16)
      .map((part) => part.slice(0, 2_048)),
  };
};
